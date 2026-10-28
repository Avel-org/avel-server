import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	errorEnvelope,
	exportListEnvelope,
	exportSchema,
	preconditionDetails,
	repoPolicySchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	client,
	completionReport,
	connection,
	dispatch,
	engagement,
	exportTable,
	mission,
	playbook,
	rosterPreset,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { gitBlobSha } from "../../src/lib/export";
import { ApiError } from "../../src/middleware/errors";
import { worktreeRooms } from "../../src/rooms/provider";
import { snapshotDispatch } from "../../src/rooms/snapshot";
import type { RoomSourceResolver } from "../../src/rooms/sources";
import { prBranch } from "../../src/routes/export-support";
import {
	DISPATCH_PLAN,
	dispatchValues,
	insertDispatchRow,
	reportValues,
} from "../db/dispatch-fixtures";
import { makeRepo, removeDir, tempDir, writeFiles } from "../unit/git-fixtures";
import { fixtureRepos, recordingWriter } from "../unit/repo-fixtures";
import { gateRunOf, jobDeps } from "./gate-job-fixtures";
import {
	activeClientMission,
	activeMission,
	CLIENT_REPO,
	type Mission,
	runnerIds,
} from "./runner-fixtures";
import { type ApiHarness, clock, withApi } from "./support";

// Modules 10 and 11, slice 1 (J, 2026-10-22): previews for every target,
// delivery by zip, rendered inside the request from the gate run's
// integration commit.

vi.setConfig({ testTimeout: 60_000 });

const base = tempDir("exports");
afterAll(async () => {
	removeDir(base);
	await closeDb();
});

let n = 0;

function repo() {
	const dir = path.join(base, `repo-${++n}`);
	const [pinned] = makeRepo(dir, {
		"src/a.ts": "export const a = 1;\n",
		"README.md": "# salon\n",
	}) as [string];
	const rooms = worktreeRooms(path.join(base, `rooms-${n}`));
	const roomSources: RoomSourceResolver = {
		resolve: async () => ({ ok: true, repoPath: dir, commit: pinned }),
	};
	return { dir, pinned, rooms, roomSources };
}

type Repo = ReturnType<typeof repo>;

/** Checks the gate can run: file_exists on src/** for each requirement. */
const RUNNABLE_PLAN = {
	...DISPATCH_PLAN,
	checks: [
		{ id: "CK1", requirementId: "R1", kind: "file_exists", path: "src/**" },
		{ id: "CK2", requirementId: "R2", kind: "file_exists", path: "src/**" },
	],
};

async function closedDispatch(
	h: ApiHarness,
	m: Mission,
	r: Repo,
	files: Record<string, string>,
) {
	const id = await insertDispatchRow(
		h.tx,
		m.ids,
		dispatchValues(m.agent, m.ids, "complete"),
	);
	const room = await r.rooms.open({
		dispatchId: id,
		repoPath: r.dir,
		commit: r.pinned,
		writableGlobs: ["**"],
	});
	writeFiles(room.root, files);
	const resultCommitSha = await snapshotDispatch(
		room,
		r.pinned,
		id,
		clock.now().toISOString(),
	);
	await h.tx
		.insert(completionReport)
		.values(
			reportValues(
				m.ids,
				{ id, missionId: m.missionId, rosterEntryId: m.agent.entryId },
				{ status: "complete", resultCommitSha },
			),
		);
	return id;
}

/** A playbook with acceptance mandatory, so the brief's checks count and a run can be verified. */
async function acceptancePlaybook(h: ApiHarness, m: Mission, tx: Tx) {
	const type = `export-${h.ns}`;
	const presetId = m.ids.next();
	await tx.insert(rosterPreset).values({
		id: presetId,
		name: `Preset ${h.ns}`,
		description: null,
		cut: "vertical",
		agents: [],
		version: 1,
		...stamp(clock),
	});
	await tx.insert(playbook).values({
		id: m.ids.next(),
		missionType: type,
		name: "Export test",
		wavesApplicable: ["A"],
		gates: [{ gate: "acceptance", policy: "mandatory" }],
		deliverable: "pr",
		requiredFields: [],
		defaultPresetId: presetId,
		version: 1,
		...stamp(clock),
	});
	await tx.update(mission).set({ type }).where(eq(mission.id, m.missionId));
}

/**
 * An active internal mission pinned to the repo, with a runnable brief and
 * the acceptance playbook, and `files` written by one complete dispatch.
 * `brief` DISPATCH_PLAN leaves the test checks unrun, so the run is a pass.
 */
async function prepared(
	h: ApiHarness,
	r: Repo,
	files: Record<string, string>,
	brief: unknown = RUNNABLE_PLAN,
) {
	await h.signIn();
	jobDeps(h, r.roomSources);
	const m = await activeMission(h.tx, runnerIds(h.ns));
	await h.tx
		.update(mission)
		.set({ templateVersion: r.pinned, brief: brief as never })
		.where(eq(mission.id, m.missionId));
	await acceptancePlaybook(h, m, h.tx);
	await closedDispatch(h, m, r, files);
	return m;
}

const gate = (h: ApiHarness, missionId: string) => gateRunOf(h, missionId);

const post = (h: ApiHarness, url: string, body: unknown, key = randomUUID()) =>
	h.call(url, { method: "POST", body, headers: { "idempotency-key": key } });

async function created(res: Response, status = 201) {
	expect(res.status, await res.clone().text()).toBe(status);
	return successEnvelope(exportSchema).parse(await res.json()).data;
}

async function refused(res: Response, status = 422) {
	expect(res.status, await res.clone().text()).toBe(status);
	return errorEnvelope.parse(await res.json()).error;
}

const reasonOf = (e: { details?: unknown }) =>
	preconditionDetails.parse(e.details).reason;

const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!process.env.DATABASE_URL)("/api exports", () => {
	it("previews a zip, delivers it from the preview, and serves the same bytes", async () => {
		const r = repo();
		await withApi(
			async (h) => {
				const m = await prepared(h, r, {
					"src/b.ts": "export const b = 2;\n",
					"src/a.ts": "export const a = 10;\n",
				});
				const run = await gate(h, m.missionId);
				expect(run.result).toBe("verified");

				const key = randomUUID();
				const body = { missionId: m.missionId, target: "zip" };
				const preview = await created(
					await post(h, "/api/exports/preview", body, key),
				);
				expect(preview.status).toBe("previewed");
				expect(preview.dryRun).toBe(true);
				expect(preview.gateRun).toEqual({
					id: run.id,
					result: "verified",
					commitSha: run.commitSha,
					baseSha: r.pinned,
					receiptSha256: run.receiptSha256,
				});
				expect(preview.package?.files.map((f) => [f.path, f.change])).toEqual([
					[".avel/receipt.json", "create"],
					["src/a.ts", "overwrite"],
					["src/b.ts", "create"],
				]);
				const b = preview.package?.files.find((f) => f.path === "src/b.ts");
				expect(b?.blobSha).toBe(
					gitBlobSha(new TextEncoder().encode("export const b = 2;\n")),
				);
				expect(preview.package?.deletes).toEqual([]);
				expect(preview.violations).toEqual([]);
				expect(preview.blocked).toBeNull();
				expect(preview.blastRadius).toBeNull();
				expect(preview.zip).toBeNull();

				// The same key and body replay; the same key with another body is 409.
				const again = await post(h, "/api/exports/preview", body, key);
				expect(again.headers.get("idempotency-replayed")).toBe("true");
				expect((await created(again, 200)).id).toBe(preview.id);
				const other = await refused(
					await post(h, "/api/exports", { ...body, gateRunId: run.id }, key),
					409,
				);
				expect(other.code).toBe("IDEMPOTENCY_REPLAY");

				const done = await created(
					await post(h, "/api/exports", {
						...body,
						gateRunId: run.id,
						previewExportId: preview.id,
					}),
				);
				expect(done.status).toBe("done");
				expect(done.dryRun).toBe(false);
				expect(done.previewExportId).toBe(preview.id);
				// Rendered again, it hashes the same as its preview.
				expect(done.package?.sha256).toBe(preview.package?.sha256);
				expect(done.blocked).toBeNull();
				expect(done.zip?.bytes).toBeGreaterThan(0);

				const zip = await h.call(`/api/exports/${done.id}/zip`);
				expect(zip.status, await zip.clone().text()).toBe(200);
				expect(zip.headers.get("content-type")).toBe("application/zip");
				expect(zip.headers.get("content-disposition")).toMatch(
					/^attachment; filename="avel-.*\.zip"$/,
				);
				const bytes = new Uint8Array(await zip.arrayBuffer());
				expect(sha256(bytes)).toBe(done.zip?.sha256);
				expect(bytes.byteLength).toBe(done.zip?.bytes);

				// Work that closes after the export does not change its bytes:
				// the zip renders from the dispatches the export recorded.
				await closedDispatch(h, m, r, { "src/c.ts": "export const c = 3;\n" });
				const later = await h.call(`/api/exports/${done.id}/zip`);
				expect(later.status, await later.clone().text()).toBe(200);
				expect(sha256(new Uint8Array(await later.arrayBuffer()))).toBe(
					done.zip?.sha256,
				);

				const list = exportListEnvelope.parse(
					await (await h.call(`/api/missions/${m.missionId}/exports`)).json(),
				);
				expect(list.meta.total).toBe(2);
				expect(list.data.map((e) => e.id)).toEqual([done.id, preview.id]);
				const got = await h.call(`/api/exports/${preview.id}`);
				expect(
					successEnvelope(exportSchema).parse(await got.json()).data,
				).toEqual(preview);
				// A preview has no zip to download.
				expect((await h.call(`/api/exports/${preview.id}/zip`)).status).toBe(
					404,
				);
			},
			{ roomSources: r.roomSources },
		);
	});

	it("refuses a zip whose bytes no longer hash to the recorded sha256", async () => {
		const r = repo();
		await withApi(
			async (h) => {
				const m = await prepared(h, r, { "src/b.ts": "export const b = 2;\n" });
				const run = await gate(h, m.missionId);
				const done = await created(
					await post(h, "/api/exports", {
						missionId: m.missionId,
						target: "zip",
						gateRunId: run.id,
					}),
				);
				await h.tx
					.update(exportTable)
					.set({ snapshotSha256: "0".repeat(64) })
					.where(eq(exportTable.id, done.id));
				const e = await refused(await h.call(`/api/exports/${done.id}/zip`));
				expect(e.code).toBe("DETERMINISM_VIOLATION");
			},
			{ roomSources: r.roomSources },
		);
	});

	it("ships each complete dispatch's frozen brief, and refuses one that no longer matches its hash", async () => {
		const r = repo();
		await withApi(
			async (h) => {
				const m = await prepared(h, r, { "src/b.ts": "export const b = 2;\n" });
				const briefMd = "# Brief\n\n## Scope\n\nR1, R2\n";
				const [d] = await h.tx
					.update(dispatch)
					.set({ briefMd, briefSha256: sha256(Buffer.from(briefMd, "utf8")) })
					.where(eq(dispatch.missionId, m.missionId))
					.returning({ id: dispatch.id });
				const path = `.avel/dispatches/${d?.id}.md`;
				const run = await gate(h, m.missionId);
				const body = { missionId: m.missionId, target: "zip" };
				const preview = await created(
					await post(h, "/api/exports/preview", body),
				);
				expect(preview.package?.files.map((f) => [f.path, f.change])).toEqual([
					[path, "create"],
					[".avel/receipt.json", "create"],
					["src/b.ts", "create"],
				]);
				expect(
					preview.package?.files.find((f) => f.path === path)?.blobSha,
				).toBe(gitBlobSha(new TextEncoder().encode(briefMd)));
				const done = await created(
					await post(h, "/api/exports", {
						...body,
						gateRunId: run.id,
						previewExportId: preview.id,
					}),
				);
				expect(done.package?.sha256).toBe(preview.package?.sha256);

				// The text moves while its frozen hash stays: the package would
				// not carry what the agent was told.
				await h.tx
					.update(dispatch)
					.set({ briefMd: `${briefMd}edited\n` })
					.where(eq(dispatch.missionId, m.missionId));
				const e = await refused(await h.call(`/api/exports/${done.id}/zip`));
				expect(e.code).toBe("DETERMINISM_VIOLATION");
				const again = await refused(
					await post(h, "/api/exports/preview", body),
				);
				expect(again.code).toBe("DETERMINISM_VIOLATION");

				// A deleted mission hides its exports, as it hides its dispatches.
				await h.tx
					.update(mission)
					.set({ deletedAt: clock.now() })
					.where(eq(mission.id, m.missionId));
				for (const url of [
					`/api/exports/${done.id}`,
					`/api/exports/${done.id}/zip`,
					`/api/dispatches/${d?.id}`,
					`/api/missions/${m.missionId}/exports`,
				]) {
					const hidden = await refused(await h.call(url), 404);
					expect(hidden.code, url).toBe("NOT_FOUND");
				}
			},
			{ roomSources: r.roomSources },
		);
	});

	it("previews work the gate did not verify, and refuses to deliver it", async () => {
		const r = repo();
		await withApi(
			async (h) => {
				// DISPATCH_PLAN's test checks have no runner: the run is a pass.
				const m = await prepared(
					h,
					r,
					{ "src/b.ts": "export const b = 2;\n" },
					DISPATCH_PLAN,
				);
				const run = await gate(h, m.missionId);
				expect(run.result).toBe("pass");
				const preview = await created(
					await post(h, "/api/exports/preview", {
						missionId: m.missionId,
						target: "zip",
					}),
				);
				expect(preview.blocked?.reason).toBe("gate_pass_not_verified");
				const e = await refused(
					await post(h, "/api/exports", {
						missionId: m.missionId,
						target: "zip",
						gateRunId: run.id,
						previewExportId: preview.id,
					}),
				);
				expect([e.code, reasonOf(e)]).toEqual([
					"PRECONDITION_FAILED",
					"gate_pass_not_verified",
				]);
				const [count] = await h.tx
					.select({ id: exportTable.id })
					.from(exportTable)
					.where(eq(exportTable.missionId, m.missionId));
				// A refusal writes no export: only the preview is there.
				expect(count?.id).toBe(preview.id);
			},
			{ roomSources: r.roomSources },
		);
	});

	it("records a path outside the roster's writable paths as a violation, and never delivers it", async () => {
		const r = repo();
		await withApi(
			async (h) => {
				const m = await prepared(h, r, {
					"src/b.ts": "export const b = 2;\n",
					"docs/notes.md": "outside src\n",
				});
				const run = await gate(h, m.missionId);
				const preview = await created(
					await post(h, "/api/exports/preview", {
						missionId: m.missionId,
						target: "zip",
					}),
				);
				expect(preview.violations.map((v) => [v.code, v.path])).toEqual([
					["PATH_OUTSIDE_ALLOWED", "docs/notes.md"],
				]);
				expect(preview.blocked?.code).toBe("BLAST_RADIUS_VIOLATION");
				const e = await refused(
					await post(h, "/api/exports", {
						missionId: m.missionId,
						target: "zip",
						gateRunId: run.id,
					}),
				);
				expect(e.code).toBe("BLAST_RADIUS_VIOLATION");
			},
			{ roomSources: r.roomSources },
		);
	});

	it("refuses a preview whose package hash the delivery does not reproduce", async () => {
		const r = repo();
		await withApi(
			async (h) => {
				const m = await prepared(h, r, { "src/b.ts": "export const b = 2;\n" });
				const run = await gate(h, m.missionId);
				const preview = await created(
					await post(h, "/api/exports/preview", {
						missionId: m.missionId,
						target: "zip",
					}),
				);
				await h.tx
					.update(exportTable)
					.set({ packageSha256: "f".repeat(64) })
					.where(eq(exportTable.id, preview.id));
				const e = await refused(
					await post(h, "/api/exports", {
						missionId: m.missionId,
						target: "zip",
						gateRunId: run.id,
						previewExportId: preview.id,
					}),
				);
				expect(e.code).toBe("DETERMINISM_VIOLATION");
			},
			{ roomSources: r.roomSources },
		);
	});

	it("refuses an export with no gate run, of an older run, or of a moved commit", async () => {
		const r = repo();
		await withApi(
			async (h) => {
				const m = await prepared(h, r, { "src/b.ts": "export const b = 2;\n" });
				const zip = { missionId: m.missionId, target: "zip" };

				const none = await refused(await post(h, "/api/exports/preview", zip));
				expect(reasonOf(none)).toBe("gate_not_run");

				// A zip takes no connection or ref.
				const shape = await refused(
					await post(h, "/api/exports/preview", {
						...zip,
						connectionId: randomUUID(),
					}),
					400,
				);
				expect(shape.code).toBe("VALIDATION_FAILED");

				const first = await gate(h, m.missionId);
				const second = await gate(h, m.missionId);
				const old = await refused(
					await post(h, "/api/exports", { ...zip, gateRunId: first.id }),
				);
				expect(reasonOf(old)).toBe("gate_run_not_latest");

				// Another dispatch closed since the gate: its commit no longer rebuilds.
				await closedDispatch(h, m, r, { "src/c.ts": "export const c = 3;\n" });
				const moved = await refused(
					await post(h, "/api/exports", { ...zip, gateRunId: second.id }),
				);
				expect(reasonOf(moved)).toBe("integration_commit_moved");
			},
			{ roomSources: r.roomSources },
		);
	});

	it("previews a GitHub target against its branch tip, and refuses one for an internal mission", async () => {
		const r = repo();
		const aBlob = gitBlobSha(new TextEncoder().encode("export const a = 1;\n"));
		const repos = fixtureRepos({}, ["MERIDIAN_GITHUB_TOKEN"], {
			"meridian-co/app": {
				branch: "main",
				defaultBranch: "main",
				commitSha: "d".repeat(40),
				entries: new Map([
					["src", { sha: "e".repeat(40), mode: "040000" }],
					["src/a.ts", { sha: aBlob, mode: "100644" }],
					["LICENSE", { sha: "1".repeat(40), mode: "100644" }],
				]),
			},
			"meridian-co/missing": new ApiError("REPO_NOT_FOUND", "no such repo"),
		});
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				await h.signIn();
				jobDeps(h, r.roomSources);
				const m = await activeClientMission(h, runnerIds(h.ns), {
					repoUrl: CLIENT_REPO,
					commit: r.pinned,
				});
				await h.tx
					.update(mission)
					.set({ brief: RUNNABLE_PLAN as never })
					.where(eq(mission.id, m.missionId));
				await acceptancePlaybook(h, m, h.tx);
				await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
				const run = await gate(h, m.missionId);

				const connectionId = m.ids.next();
				await h.tx.insert(connection).values({
					id: connectionId,
					service: "github",
					label: "Meridian",
					scopeType: "owner",
					scopeValue: "meridian-co",
					credentialRef: "MERIDIAN_GITHUB_TOKEN",
					status: "active",
					engagementId: m.engagementId,
					...stamp(clock),
				});
				const preview = await created(
					await post(h, "/api/exports/preview", {
						missionId: m.missionId,
						target: "github_pr",
						connectionId,
					}),
				);
				expect(
					repos.treeRequests.map((t) => [t.owner, t.repo, t.branch]),
				).toEqual([["meridian-co", "app", undefined]]);
				expect(preview.connectionId).toBe(connectionId);
				expect(preview.baseRef).toBe("main");
				expect(preview.baseCommitSha).toBe("d".repeat(40));
				expect(preview.gateRun?.id).toBe(run.id);
				const radius = preview.blastRadius;
				expect(radius?.target).toEqual({
					owner: "meridian-co",
					repo: "app",
					branch: "main",
				});
				expect(radius?.create.map((f) => f.path)).toEqual([
					".avel/receipt.json",
					"src/b.ts",
				]);
				expect(radius?.preserveSummary.fileCount).toBe(2);
				expect(preview.violations).toEqual([]);
				expect(preview.blocked).toBeNull();

				// Delivered from the preview: a pull request against the tip it read.
				const key = randomUUID();
				const body = {
					missionId: m.missionId,
					target: "github_pr",
					gateRunId: run.id,
					connectionId,
					previewExportId: preview.id,
				};
				const pr = await created(await post(h, "/api/exports", body, key));
				expect(pr).toMatchObject({
					status: "pr-open",
					targetKind: "github_pr",
					connectionId,
					previewExportId: preview.id,
					baseRef: "main",
					baseCommitSha: "d".repeat(40),
					failure: null,
					pullRequest: {
						number: 42,
						url: "https://github.com/meridian-co/app/pull/42",
						branch: prBranch({
							id: pr.id,
							missionId: m.missionId,
							sprintN: pr.sprintN,
							packageSha256: preview.package?.sha256 ?? null,
						}),
						commitSha: "9".repeat(40),
						state: "open",
					},
				});
				expect(pr.package?.sha256).toBe(preview.package?.sha256);
				expect(writer.opened).toHaveLength(1);
				const sent = writer.opened[0];
				expect(sent).toMatchObject({
					owner: "meridian-co",
					repo: "app",
					credentialRef: "MERIDIAN_GITHUB_TOKEN",
					base: { branch: "main", commitSha: "d".repeat(40) },
					head: pr.pullRequest?.branch,
					deletes: [],
				});
				expect(sent?.files.map((f) => f.path)).toEqual(
					pr.package?.files.map((f) => f.path),
				);
				for (const f of sent?.files ?? []) {
					expect(gitBlobSha(f.bytes), f.path).toBe(f.blobSha);
				}
				expect(sent?.body).toContain(run.id);
				expect(sent?.body).toContain(preview.package?.sha256);
				const log = await h.logRows(pr.id);
				expect(
					log.map((l) => [
						l.action,
						(l.payload as { status?: string; to?: string }).status ??
							(l.payload as { to?: string }).to,
					]),
				).toEqual([
					["export.created", "delivering"],
					["export.status_changed", "pr-open"],
				]);
				// A resend with the same key never writes to GitHub again.
				const again = await post(h, "/api/exports", body, key);
				expect(again.status).toBe(200);
				expect(again.headers.get("idempotency-replayed")).toBe("true");
				expect((await created(again, 200)).id).toBe(pr.id);
				expect(writer.opened).toHaveLength(1);

				const internal = await activeMission(h.tx, m.ids);
				await h.tx
					.update(mission)
					.set({ templateVersion: r.pinned, brief: RUNNABLE_PLAN as never })
					.where(eq(mission.id, internal.missionId));
				await closedDispatch(h, internal, r, { "src/b.ts": "b\n" });
				await gate(h, internal.missionId);
				const noRepo = await refused(
					await post(h, "/api/exports/preview", {
						missionId: internal.missionId,
						target: "github_pr",
						connectionId,
					}),
				);
				expect(reasonOf(noRepo)).toBe("export_target_repo_missing");

				// A deleted client hides its missions' exports, as it hides their dispatches.
				const [eng] = await h.tx
					.select({ clientId: engagement.clientId })
					.from(engagement)
					.where(eq(engagement.id, m.engagementId as string));
				await h.tx
					.update(client)
					.set({ deletedAt: clock.now() })
					.where(eq(client.id, eng?.clientId as string));
				for (const url of [
					`/api/exports/${preview.id}`,
					`/api/missions/${m.missionId}/exports`,
				]) {
					const hidden = await refused(await h.call(url), 404);
					expect(hidden.code, url).toBe("NOT_FOUND");
				}
			},
			{ roomSources: r.roomSources, repos, repoWriter: writer },
		);
	});

	it("refuses a PR from a preview whose branch has moved, and writes nothing", async () => {
		const r = repo();
		const g = githubTree();
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const preview = await created(
					await post(h, "/api/exports/preview", {
						missionId: s.missionId,
						target: "github_pr",
						connectionId: s.connectionId,
					}),
				);
				g.tree.commitSha = "e".repeat(40);
				const stale = await refused(
					await post(h, "/api/exports", {
						missionId: s.missionId,
						target: "github_pr",
						gateRunId: s.runId,
						connectionId: s.connectionId,
						previewExportId: preview.id,
					}),
					409,
				);
				expect(stale.code).toBe("PREVIEW_STALE");
				expect(writer.opened).toEqual([]);
				const list = await h.call(`/api/missions/${s.missionId}/exports`);
				const rows = (await list.json()) as {
					data: Array<{ dryRun: boolean; targetKind: string }>;
				};
				// The preview, and githubReady's zip: no pull request export.
				expect(
					rows.data.filter((x) => x.targetKind === "github_pr" && !x.dryRun),
				).toEqual([]);
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("records a GitHub failure on the export, answers 502 naming it, and a resend does not write again", async () => {
		const r = repo();
		const g = githubTree();
		const writer = recordingWriter({
			fail: new ApiError(
				"GITHUB_REJECTED",
				"GitHub refused creating the branch on meridian-co/app: a branch of that name may already exist",
			),
		});
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const key = randomUUID();
				const body = {
					missionId: s.missionId,
					target: "github_pr",
					gateRunId: s.runId,
					connectionId: s.connectionId,
				};
				const e = await refused(await post(h, "/api/exports", body, key), 502);
				expect(e.code).toBe("GITHUB_REJECTED");
				const exportId = (e.details as { exportId: string }).exportId;
				const got = await created(
					await h.call(`/api/exports/${exportId}`),
					200,
				);
				expect(got).toMatchObject({
					status: "failed",
					pullRequest: null,
					failure: { code: "GITHUB_REJECTED", message: e.message },
				});
				const again = await post(h, "/api/exports", body, key);
				expect(again.status).toBe(200);
				expect((await created(again, 200)).status).toBe("failed");
				expect(writer.opened).toHaveLength(1);
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("refreshes a PR from GitHub: merged is done, closed is closed, open stays, and a delivering export whose PR exists is pr-open", async () => {
		const r = repo();
		const g = githubTree();
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const pr = await created(
					await post(h, "/api/exports", {
						missionId: s.missionId,
						target: "github_pr",
						gateRunId: s.runId,
						connectionId: s.connectionId,
					}),
				);
				const refresh = (id: string) =>
					h.call(`/api/exports/${id}/refresh`, { method: "POST" });
				const found = (state: "open" | "merged" | "closed") => ({
					number: 42,
					url: "https://github.com/meridian-co/app/pull/42",
					branch: pr.pullRequest?.branch as string,
					commitSha: "a".repeat(40),
					state,
				});

				writer.script.found = found("open");
				expect((await created(await refresh(pr.id), 200)).status).toBe(
					"pr-open",
				);
				expect(writer.finds).toEqual([
					{ owner: "meridian-co", repo: "app", head: pr.pullRequest?.branch },
				]);
				writer.script.found = found("merged");
				const done = await created(await refresh(pr.id), 200);
				expect(done).toMatchObject({
					status: "done",
					pullRequest: { state: "merged", commitSha: "9".repeat(40) },
				});
				const notOpen = await refused(await refresh(pr.id));
				expect(reasonOf(notOpen)).toBe("export_not_pr_open");

				// The server died between opening the PR and recording it.
				await h.tx
					.update(exportTable)
					.set({
						status: "delivering",
						statusChangedAt: sql`${exportTable.statusChangedAt} + interval '1 millisecond'`,
						prNumber: null,
						prUrl: null,
						prHeadRef: null,
						prCommitSha: null,
						prStatus: null,
					})
					.where(eq(exportTable.id, pr.id));
				writer.script.found = null;
				expect((await created(await refresh(pr.id), 200)).status).toBe(
					"delivering",
				);
				writer.script.found = found("open");
				const adopted = await created(await refresh(pr.id), 200);
				expect(adopted).toMatchObject({
					status: "pr-open",
					pullRequest: { number: 42, commitSha: "a".repeat(40), state: "open" },
				});
				writer.script.found = found("closed");
				expect((await created(await refresh(pr.id), 200)).status).toBe(
					"closed",
				);

				const zip = await refused(await refresh(s.previewOrZipId));
				expect(reasonOf(zip)).toBe("export_not_pr_open");
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("recovers a delivering export whose PR was merged or closed meanwhile, through pr-open", async () => {
		const r = repo();
		const g = githubTree();
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const pr = await created(
					await post(h, "/api/exports", {
						missionId: s.missionId,
						target: "github_pr",
						gateRunId: s.runId,
						connectionId: s.connectionId,
					}),
				);
				const branch = pr.pullRequest?.branch as string;
				// The server died after GitHub opened the PR and before pr-open.
				const crash = () =>
					h.tx
						.update(exportTable)
						.set({
							status: "delivering",
							statusChangedAt: sql`${exportTable.statusChangedAt} + interval '1 millisecond'`,
							prNumber: null,
							prUrl: null,
							prHeadRef: null,
							prCommitSha: null,
							prStatus: null,
						})
						.where(eq(exportTable.id, pr.id));
				const refresh = () =>
					h.call(`/api/exports/${pr.id}/refresh`, { method: "POST" });
				const found = (state: "merged" | "closed") => ({
					number: 42,
					url: "https://github.com/meridian-co/app/pull/42",
					branch,
					commitSha: "a".repeat(40),
					state,
				});

				await crash();
				writer.script.found = found("merged");
				const done = await created(await refresh(), 200);
				expect(done).toMatchObject({
					status: "done",
					pullRequest: { number: 42, state: "merged" },
				});
				const moves = (await h.logRows(pr.id))
					.filter((l) => l.action === "export.status_changed")
					.map((l) => (l.payload as { from: string; to: string }).to);
				expect(moves.slice(-2)).toEqual(["pr-open", "done"]);
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("never overwrites a status another request recorded while GitHub was being written", async () => {
		const r = repo();
		const g = githubTree();
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				// While the first request is still writing, a refresh finds the
				// PR already merged and records done.
				writer.script.during = async (req) => {
					writer.script.during = undefined;
					writer.script.found = {
						number: 42,
						url: "https://github.com/meridian-co/app/pull/42",
						branch: req.head,
						commitSha: "a".repeat(40),
						state: "merged",
					};
					const [row] = await h.tx
						.select({ id: exportTable.id })
						.from(exportTable)
						.where(eq(exportTable.status, "delivering"));
					const res = await h.call(`/api/exports/${row?.id}/refresh`, {
						method: "POST",
					});
					expect((await created(res, 200)).status).toBe("done");
				};
				const pr = await created(
					await post(h, "/api/exports", {
						missionId: s.missionId,
						target: "github_pr",
						gateRunId: s.runId,
						connectionId: s.connectionId,
					}),
				);
				expect(pr.status).toBe("done");
				const moves = (await h.logRows(pr.id))
					.filter((l) => l.action === "export.status_changed")
					.map((l) => (l.payload as { to: string }).to);
				expect(moves).toEqual(["pr-open", "done"]);
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("links the PR when GitHub stopped answering after opening it, and leaves the export delivering when it cannot tell", async () => {
		const r = repo();
		const g = githubTree();
		const timeout = new ApiError(
			"EXTERNAL_GITHUB",
			"GitHub did not answer while opening the pull request on meridian-co/app",
		);
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const body = {
					missionId: s.missionId,
					target: "github_pr",
					gateRunId: s.runId,
					connectionId: s.connectionId,
				};
				// GitHub opened it, then the answer was lost.
				writer.script.during = async (req) => {
					writer.script.found = {
						number: 7,
						url: "https://github.com/meridian-co/app/pull/7",
						branch: req.head,
						commitSha: "b".repeat(40),
						state: "open",
					};
				};
				writer.script.fail = timeout;
				const linked = await created(await post(h, "/api/exports", body));
				expect(linked).toMatchObject({
					status: "pr-open",
					failure: null,
					pullRequest: { number: 7, commitSha: "b".repeat(40) },
				});

				// No answer from the lookup either: it stays delivering, for refresh.
				writer.script.during = undefined;
				writer.script.found = null;
				writer.script.findFails = timeout;
				const e = await refused(await post(h, "/api/exports", body), 502);
				expect(e.code).toBe("EXTERNAL_GITHUB");
				const id = (e.details as { exportId: string }).exportId;
				const got = await created(await h.call(`/api/exports/${id}`), 200);
				expect(got).toMatchObject({ status: "delivering", failure: null });
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("fails a delivering export refresh finds no PR for once it is past the delivery window, and leaves a younger one", async () => {
		const r = repo();
		const g = githubTree();
		const timeout = new ApiError(
			"EXTERNAL_GITHUB",
			"GitHub's rate limit refused writing a file on meridian-co/app; try again later",
		);
		const writer = recordingWriter({ fail: timeout, findFails: timeout });
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const e = await refused(
					await post(h, "/api/exports", {
						missionId: s.missionId,
						target: "github_pr",
						gateRunId: s.runId,
						connectionId: s.connectionId,
					}),
					502,
				);
				const id = (e.details as { exportId: string }).exportId;
				writer.script.findFails = undefined;
				const refresh = () =>
					h.call(`/api/exports/${id}/refresh`, { method: "POST" });
				// Inside the window a delivery may still be writing: left alone.
				expect((await created(await refresh(), 200)).status).toBe("delivering");
				await h.tx
					.update(exportTable)
					.set({
						statusChangedAt: sql`${exportTable.statusChangedAt} - interval '11 minutes'`,
						createdAt: sql`${exportTable.createdAt} - interval '11 minutes'`,
					})
					.where(eq(exportTable.id, id));
				const failed = await created(await refresh(), 200);
				expect(failed).toMatchObject({
					status: "failed",
					pullRequest: null,
					failure: { code: "EXTERNAL_GITHUB" },
				});
				expect(failed.failure?.message).toMatch(/no pull request/i);
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("gives each export its own branch, so the same package can be delivered again", async () => {
		const r = repo();
		const g = githubTree();
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const body = {
					missionId: s.missionId,
					target: "github_pr",
					gateRunId: s.runId,
					connectionId: s.connectionId,
				};
				const first = await created(await post(h, "/api/exports", body));
				const second = await created(await post(h, "/api/exports", body));
				expect(first.package?.sha256).toBe(second.package?.sha256);
				expect(first.pullRequest?.branch).not.toBe(second.pullRequest?.branch);
				expect(second.status).toBe("pr-open");
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("refuses a PR into a repository with no commit on its branch", async () => {
		const r = repo();
		const g = githubTree();
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				g.tree.commitSha = null;
				g.tree.entries = new Map();
				const e = await refused(
					await post(h, "/api/exports", {
						missionId: s.missionId,
						target: "github_pr",
						gateRunId: s.runId,
						connectionId: s.connectionId,
					}),
				);
				expect(e.code).toBe("EMPTY_REPOSITORY");
				expect(writer.opened).toEqual([]);
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("pushes from a preview to a branch that is not the default, and records the new tip", async () => {
		const r = repo();
		const g = githubTree();
		g.tree.branch = "release";
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const push = {
					missionId: s.missionId,
					target: "github_push",
					connectionId: s.connectionId,
					ref: "release",
				};
				// No preview: a push is refused before anything is written.
				const bare = await refused(
					await post(h, "/api/exports", { ...push, gateRunId: s.runId }),
				);
				expect(bare.code).toBe("PREVIEW_REQUIRED");
				expect(writer.pushed).toEqual([]);

				const preview = await created(
					await post(h, "/api/exports/preview", push),
				);
				expect(preview.blocked).toBeNull();
				const done = await created(
					await post(h, "/api/exports", {
						...push,
						gateRunId: s.runId,
						previewExportId: preview.id,
					}),
				);
				expect(done).toMatchObject({
					status: "done",
					targetKind: "github_push",
					baseRef: "release",
					pullRequest: null,
					push: { branch: "release", commitSha: "8".repeat(40) },
					failure: null,
				});
				expect(writer.opened).toEqual([]);
				expect(writer.pushed).toHaveLength(1);
				expect(writer.pushed[0]).toMatchObject({
					owner: "meridian-co",
					repo: "app",
					base: { branch: "release", commitSha: "d".repeat(40) },
				});
				const log = await h.logRows(done.id);
				expect(
					log.map((l) => [
						l.action,
						(l.payload as { status?: string; to?: string }).status ??
							(l.payload as { to?: string }).to,
					]),
				).toEqual([
					["export.created", "delivering"],
					["export.status_changed", "done"],
				]);
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("refuses a push to the default branch until its RepoPolicy allows it, with a confirmation", async () => {
		const r = repo();
		const g = githubTree();
		const writer = recordingWriter();
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const push = {
					missionId: s.missionId,
					target: "github_push",
					connectionId: s.connectionId,
				};
				const first = await created(
					await post(h, "/api/exports/preview", push),
				);
				expect(first.blocked?.reason).toBe("direct_push_not_allowed");
				const refusedPush = await refused(
					await post(h, "/api/exports", {
						...push,
						gateRunId: s.runId,
						previewExportId: first.id,
					}),
				);
				expect(reasonOf(refusedPush)).toBe("direct_push_not_allowed");
				expect(writer.pushed).toEqual([]);

				const put = (body: unknown) =>
					h.call("/api/repo-policies", { method: "PUT", body });
				const unconfirmed = await refused(
					await put({
						repoUrl: "https://github.com/Meridian-Co/App",
						allowDirectPushToDefault: true,
					}),
				);
				expect(reasonOf(unconfirmed)).toBe("direct_push_unconfirmed");
				const set = await put({
					repoUrl: "https://github.com/Meridian-Co/App",
					allowDirectPushToDefault: true,
					confirmDirectPush: true,
				});
				expect(set.status, await set.clone().text()).toBe(200);
				const policy = successEnvelope(repoPolicySchema).parse(
					await set.json(),
				).data;
				expect(policy).toMatchObject({
					repoUrl: "https://github.com/meridian-co/app",
					allowDirectPushToDefault: true,
					label: null,
					defaultTarget: null,
				});
				const listed = (await (await h.call("/api/repo-policies")).json()) as {
					data: Array<{ id: string }>;
					meta: { total: number };
				};
				expect(listed.data.map((p) => p.id)).toEqual([policy.id]);
				expect(listed.meta.total).toBe(1);
				const [row] = await h.logRows(policy.id);
				expect(row).toMatchObject({
					action: "repo_policy.set",
					entityType: "repo_policy",
					payload: { allowDirectPushToDefault: true, was: null },
				});

				// Only turning it on needs the confirmation; a set that leaves it on does not.
				const renamed = await put({
					repoUrl: "https://github.com/meridian-co/app",
					label: "Meridian app",
					allowDirectPushToDefault: true,
				});
				expect(renamed.status, await renamed.clone().text()).toBe(200);
				expect(
					successEnvelope(repoPolicySchema).parse(await renamed.json()).data,
				).toMatchObject({
					id: policy.id,
					label: "Meridian app",
					allowDirectPushToDefault: true,
				});

				const second = await created(
					await post(h, "/api/exports/preview", push),
				);
				expect(second.blocked).toBeNull();
				const done = await created(
					await post(h, "/api/exports", {
						...push,
						gateRunId: s.runId,
						previewExportId: second.id,
					}),
				);
				expect(done.push).toEqual({
					branch: "main",
					commitSha: "8".repeat(40),
				});

				// Turning it off needs no confirmation, and the next push refuses again.
				const off = await put({
					repoUrl: "https://github.com/meridian-co/app",
					allowDirectPushToDefault: false,
				});
				expect(off.status).toBe(200);
				const third = await created(
					await post(h, "/api/exports/preview", push),
				);
				expect(third.blocked?.reason).toBe("direct_push_not_allowed");
				// Off to on again needs the confirmation again.
				const reopened = await refused(
					await put({
						repoUrl: "https://github.com/meridian-co/app",
						allowDirectPushToDefault: true,
					}),
				);
				expect(reasonOf(reopened)).toBe("direct_push_unconfirmed");
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("fails a push GitHub refuses, and says why", async () => {
		const r = repo();
		const g = githubTree();
		g.tree.branch = "release";
		const writer = recordingWriter({
			pushFails: new ApiError(
				"GITHUB_REJECTED",
				"GitHub refused moving release on meridian-co/app: it moved since its tip was read. Preview again.",
			),
		});
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const push = {
					missionId: s.missionId,
					target: "github_push",
					connectionId: s.connectionId,
					ref: "release",
				};
				const preview = await created(
					await post(h, "/api/exports/preview", push),
				);
				const failed = await refused(
					await post(h, "/api/exports", {
						...push,
						gateRunId: s.runId,
						previewExportId: preview.id,
					}),
					502,
				);
				expect(failed.code).toBe("GITHUB_REJECTED");
				const id = (failed.details as { exportId: string }).exportId;
				const row = await created(await h.call(`/api/exports/${id}`), 200);
				expect(row).toMatchObject({
					status: "failed",
					push: null,
					failure: { code: "GITHUB_REJECTED" },
				});
			},
			{ roomSources: r.roomSources, repos: g.repos, repoWriter: writer },
		);
	});

	it("moves a PR export to done or closed from GitHub's signed webhook, as the system", async () => {
		const r = repo();
		const g = githubTree();
		const writer = recordingWriter();
		const secret = "whsec-test";
		await withApi(
			async (h) => {
				const s = await githubReady(h, r);
				const open = async () =>
					created(
						await post(h, "/api/exports", {
							missionId: s.missionId,
							target: "github_pr",
							gateRunId: s.runId,
							connectionId: s.connectionId,
						}),
					);
				const merged = await open();
				const closed = await open();
				const deliver = (
					pr: { number: number; branch: string },
					over: { merged?: boolean; repo?: string; signature?: string },
				) => {
					const body = JSON.stringify({
						action: "closed",
						pull_request: {
							number: pr.number,
							html_url: `https://github.com/meridian-co/app/pull/${pr.number}`,
							merged: over.merged ?? false,
							head: { ref: pr.branch, sha: "9".repeat(40) },
						},
						repository: { full_name: over.repo ?? "Meridian-Co/App" },
					});
					return h.call("/api/webhooks/github", {
						method: "POST",
						body: JSON.parse(body),
						headers: {
							// No session: GitHub has none. The signature is the credential.
							cookie: "",
							"x-github-event": "pull_request",
							"x-hub-signature-256":
								over.signature ??
								`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
						},
					});
				};
				const prOf = (e: typeof merged) => ({
					number: e.pullRequest?.number ?? 0,
					branch: e.pullRequest?.branch ?? "",
				});

				const unsigned = await deliver(prOf(merged), {
					merged: true,
					signature: "sha256=00",
				});
				expect(unsigned.status).toBe(401);
				// Another repository's PR with the same number and branch moves nothing.
				const elsewhere = await deliver(prOf(merged), {
					merged: true,
					repo: "someone/else",
				});
				expect(elsewhere.status).toBe(204);
				const still = await created(
					await h.call(`/api/exports/${merged.id}`),
					200,
				);
				expect(still.status).toBe("pr-open");

				expect((await deliver(prOf(merged), { merged: true })).status).toBe(
					204,
				);
				expect((await deliver(prOf(closed), { merged: false })).status).toBe(
					204,
				);
				const done = await created(
					await h.call(`/api/exports/${merged.id}`),
					200,
				);
				expect(done).toMatchObject({
					status: "done",
					pullRequest: { state: "merged" },
				});
				const shut = await created(
					await h.call(`/api/exports/${closed.id}`),
					200,
				);
				expect(shut).toMatchObject({
					status: "closed",
					pullRequest: { state: "closed" },
				});
				// Created, delivering to pr-open (the operator), then pr-open to done.
				const moved = (await h.logRows(merged.id)).at(-1);
				expect(moved).toMatchObject({
					action: "export.status_changed",
					actorKind: "system",
					actorUserId: null,
					payload: { from: "pr-open", to: "done" },
				});
				// A replayed delivery changes nothing.
				expect((await deliver(prOf(merged), { merged: true })).status).toBe(
					204,
				);
				expect(await h.logRows(merged.id)).toHaveLength(3);
			},
			{
				roomSources: r.roomSources,
				repos: g.repos,
				repoWriter: writer,
				githubWebhookSecret: secret,
			},
		);
	});

	it("has no webhook route when no secret is configured", async () => {
		await withApi(async (h) => {
			const res = await h.call("/api/webhooks/github", {
				method: "POST",
				body: {},
				headers: { cookie: "", "x-github-event": "ping" },
			});
			expect(res.status).toBe(404);
		});
	});
});

/** meridian-co/app's main branch, which a test may move. */
function githubTree() {
	const aBlob = gitBlobSha(new TextEncoder().encode("export const a = 1;\n"));
	const tree = {
		branch: "main",
		defaultBranch: "main",
		commitSha: "d".repeat(40) as string | null,
		entries: new Map([
			["src", { sha: "e".repeat(40), mode: "040000" }],
			["src/a.ts", { sha: aBlob, mode: "100644" }],
		]),
	};
	const base = fixtureRepos({}, ["MERIDIAN_GITHUB_TOKEN"], {});
	return {
		tree,
		repos: {
			...base,
			tree: async () => ({ ...tree, entries: new Map(tree.entries) }),
		},
	};
}

/** A client mission on meridian-co/app with a gate run, a connection, and a zip export to refuse refreshes on. */
async function githubReady(h: ApiHarness, r: Repo) {
	await h.signIn();
	jobDeps(h, r.roomSources);
	const m = await activeClientMission(h, runnerIds(h.ns), {
		repoUrl: CLIENT_REPO,
		commit: r.pinned,
	});
	await h.tx
		.update(mission)
		.set({ brief: RUNNABLE_PLAN as never })
		.where(eq(mission.id, m.missionId));
	await acceptancePlaybook(h, m, h.tx);
	await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
	const run = await gate(h, m.missionId);
	const connectionId = m.ids.next();
	await h.tx.insert(connection).values({
		id: connectionId,
		service: "github",
		label: "Meridian",
		scopeType: "owner",
		scopeValue: "meridian-co",
		credentialRef: "MERIDIAN_GITHUB_TOKEN",
		status: "active",
		engagementId: m.engagementId,
		...stamp(clock),
	});
	const zip = await created(
		await post(h, "/api/exports", {
			missionId: m.missionId,
			target: "zip",
			gateRunId: run.id,
		}),
	);
	return {
		missionId: m.missionId,
		runId: run.id,
		connectionId,
		previewOrZipId: zip.id,
	};
}
