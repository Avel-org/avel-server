import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	errorEnvelope,
	exportListEnvelope,
	exportSchema,
	gateRun as gateRunSchema,
	preconditionDetails,
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
import {
	DISPATCH_PLAN,
	dispatchValues,
	insertDispatchRow,
	reportValues,
} from "../db/dispatch-fixtures";
import { makeRepo, removeDir, tempDir, writeFiles } from "../unit/git-fixtures";
import { fixtureRepos } from "../unit/repo-fixtures";
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
	const m = await activeMission(h.tx, runnerIds(h.ns));
	await h.tx
		.update(mission)
		.set({ templateVersion: r.pinned, brief: brief as never })
		.where(eq(mission.id, m.missionId));
	await acceptancePlaybook(h, m, h.tx);
	await closedDispatch(h, m, r, files);
	return m;
}

async function gate(h: ApiHarness, missionId: string) {
	const res = await h.call(`/api/missions/${missionId}/gate`, {
		method: "POST",
		body: {},
	});
	expect(res.status, await res.clone().text()).toBe(201);
	return successEnvelope(gateRunSchema).parse(await res.json()).data;
}

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
				expect(preview.package.files.map((f) => [f.path, f.change])).toEqual([
					[".avel/receipt.json", "create"],
					["src/a.ts", "overwrite"],
					["src/b.ts", "create"],
				]);
				const b = preview.package.files.find((f) => f.path === "src/b.ts");
				expect(b?.blobSha).toBe(
					gitBlobSha(new TextEncoder().encode("export const b = 2;\n")),
				);
				expect(preview.package.deletes).toEqual([]);
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
				expect(done.package.sha256).toBe(preview.package.sha256);
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
				expect(preview.package.files.map((f) => [f.path, f.change])).toEqual([
					[path, "create"],
					[".avel/receipt.json", "create"],
					["src/b.ts", "create"],
				]);
				expect(
					preview.package.files.find((f) => f.path === path)?.blobSha,
				).toBe(gitBlobSha(new TextEncoder().encode(briefMd)));
				const done = await created(
					await post(h, "/api/exports", {
						...body,
						gateRunId: run.id,
						previewExportId: preview.id,
					}),
				);
				expect(done.package.sha256).toBe(preview.package.sha256);

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

	it("refuses an export with no gate run, of an older run, of a moved commit, or to GitHub", async () => {
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

				const github = await refused(
					await post(h, "/api/exports", {
						missionId: m.missionId,
						target: "github_pr",
						gateRunId: second.id,
						connectionId: randomUUID(),
					}),
				);
				expect(reasonOf(github)).toBe("export_target_not_built");

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
				commitSha: "d".repeat(40),
				entries: new Map([
					["src", { sha: "e".repeat(40), mode: "040000" }],
					["src/a.ts", { sha: aBlob, mode: "100644" }],
					["LICENSE", { sha: "1".repeat(40), mode: "100644" }],
				]),
			},
			"meridian-co/missing": new ApiError("REPO_NOT_FOUND", "no such repo"),
		});
		await withApi(
			async (h) => {
				await h.signIn();
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
				expect(preview.gateRun.id).toBe(run.id);
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

				// A GitHub delivery is not built yet.
				const e = await refused(
					await post(h, "/api/exports", {
						missionId: m.missionId,
						target: "github_pr",
						gateRunId: run.id,
						connectionId,
						previewExportId: preview.id,
					}),
				);
				expect(reasonOf(e)).toBe("export_target_not_built");

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
			{ roomSources: r.roomSources, repos },
		);
	});
});
