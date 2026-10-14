import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	completionReport as reportWire,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	agentTemplate,
	completionReport,
	dispatch,
	mission,
} from "../../src/db/schema";
import type { Tx } from "../../src/db/tx";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import { FakeHarness } from "../../src/runner/harness";
import {
	dispatchValues,
	insertDispatchRow,
	reportValues,
	sha,
} from "../db/dispatch-fixtures";
import { refusal as dbRefusal } from "../db/fixtures";
import { makeRepo, removeDir, tempDir, writeFiles } from "../unit/git-fixtures";
import { bearer, dispatchWithToken, seedIds } from "./agent-fixtures";
import {
	activeMission,
	expectReportsMatchDispatches,
	lifeOf,
	type Mission,
	reportsOf,
	row,
	started,
} from "./runner-fixtures";
import { type ApiHarness, clock, withApi } from "./support";

// The agent's own report, against real worktree rooms from a temp template
// clone. Files are written into the room directly, standing in for the
// agent's file tools.

const created = successEnvelope(reportWire);
const REPORT = "/api/agent/report";

const base = tempDir("agent-report");
afterAll(() => removeDir(base));
const sources = path.join(base, "sources");
const [commit] = makeRepo(path.join(sources, "templates", "template-booking"), {
	"src/a.ts": "export const a = 1;\n",
	"docs/spec.md": "# Spec\n",
}) as [string];

let n = 0;
const roomsRoot = () => {
	n += 1;
	return path.join(base, `rooms-${n}`);
};

const sha256 = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

const complete = {
	status: "complete",
	artifactsRead: [{ path: "docs/spec.md", sha256: sha256("# Spec\n") }],
	blockers: [],
	rereads: 2,
} as const;

const blocker = {
	description: "No test database credentials",
	workaround: "Ran against the fixture only",
	provisioningGap: true,
};

async function failure(res: Response, status: number) {
	expect(res.status).toBe(status);
	return errorEnvelope.parse(await res.json()).error;
}

/** A mission whose template is the temp clone, at its real commit. */
async function realMission(tx: Tx, ns: string): Promise<Mission> {
	const m = await activeMission(tx, seedIds(ns));
	await tx
		.update(mission)
		.set({ templateVersion: commit })
		.where(eq(mission.id, m.missionId));
	return m;
}

type Run = { id: string; token: string; root: string };

/** A dispatch started through the route, with a real room. */
async function running(
	h: ApiHarness,
	harness: FakeHarness,
	m: Mission,
	root: string,
): Promise<Run> {
	const run = await started(h, harness, m);
	return { ...run, root: path.join(root, run.id) };
}

const report = (h: ApiHarness, run: Run, body: unknown) =>
	h.call(REPORT, { method: "POST", body, headers: bearer(run.token) });

function setup(
	fn: (
		h: ApiHarness,
		x: {
			harness: FakeHarness;
			m: Mission;
			run: Run;
			root: string;
		},
	) => Promise<void>,
) {
	return async () => {
		const harness = new FakeHarness();
		const root = roomsRoot();
		await withApi(
			async (h) => {
				await h.signIn();
				const m = await realMission(h.tx, h.ns);
				const run = await running(h, harness, m, root);
				await fn(h, { harness, m, run, root });
			},
			{
				harness,
				rooms: worktreeRooms(root),
				roomSources: localSources(sources),
			},
		);
	};
}

describe.skipIf(!process.env.DATABASE_URL)("POST /api/agent/report", () => {
	afterAll(closeDb);

	it(
		"files a complete report from the room and the dispatch, closes the dispatch, kills the token and stops the session",
		setup(async (h, { harness, m, run }) => {
			// What the runner counted: the report takes it, whatever is sent.
			await h.tx
				.update(dispatch)
				.set({ tokensIn: 1600, tokensUsed: 1600, softCeilingCrossed: true })
				.where(eq(dispatch.id, run.id));
			writeFiles(run.root, {
				"src/a.ts": "export const a = 2;\n",
				"src/b.test.ts": "test\n",
				"src/README": "no extension\n",
			});
			const res = await report(h, run, complete);
			expect(res.status).toBe(201);
			const wire = created.parse(await res.json()).data;
			const d = await row(h.tx, run.id);
			expect(wire).toEqual({
				id: expect.any(String),
				dispatchId: run.id,
				missionId: m.missionId,
				rosterEntryId: m.agent.entryId,
				status: "complete",
				haltReason: null,
				softCeilingCrossed: true,
				actualTokens: 1600,
				agentVersionSha256: m.agent.versionSha,
				agentVersionRef: `${m.agent.slug}@v2`,
				skillsSha256: d.skillsSha256,
				versionSource: "recorded",
				model: "fake-harness",
				artifactsRead: complete.artifactsRead,
				artifactsWritten: [
					{ path: "src/README", sha256: sha256("no extension\n") },
					{ path: "src/a.ts", sha256: sha256("export const a = 2;\n") },
					{ path: "src/b.test.ts", sha256: sha256("test\n") },
				],
				filesTouched: 3,
				fileTypesTouched: ["ts"],
				rereads: 2,
				blockers: [],
				edgeMismatches: [],
				filedBy: "agent",
				createdAt: clock.now().toISOString(),
			});
			expect(d).toMatchObject({
				status: "complete",
				haltReason: null,
				closedAt: clock.now(),
			});

			const life = await lifeOf(h.tx, run.id);
			expect(
				life.map((a) => [a.action, a.actorKind, a.actorRosterEntryId]),
			).toEqual([
				["dispatch.started", "operator", null],
				["completion_report.filed", "agent", m.agent.entryId],
				["dispatch.closed", "agent", m.agent.entryId],
			]);
			expect(life.slice(1).map((a) => a.payload)).toEqual([
				{ dispatchId: run.id, status: "complete", filedBy: "agent" },
				{ status: "complete", reportId: wire.id },
			]);
			for (const a of life.slice(1)) {
				expect(a.requestId).toBe(res.headers.get("x-request-id"));
			}

			expect(harness.stopped).toEqual([run.id]);
			// The room is kept, with the work in it.
			expect(readFileSync(path.join(run.root, "src", "a.ts"), "utf8")).toBe(
				"export const a = 2;\n",
			);
			const dead = await failure(
				await h.call("/api/agent/dispatch", { headers: bearer(run.token) }),
				401,
			);
			expect(dead.code).toBe("DISPATCH_CLOSED");
			// A retry after the close gets 401, and nothing is filed twice.
			const again = await failure(await report(h, run, complete), 401);
			expect(again.code).toBe("DISPATCH_CLOSED");
			expect(await reportsOf(h.tx, run.id)).toHaveLength(1);
			await expectReportsMatchDispatches(h.tx, [m.missionId]);
		}),
	);

	it(
		"files a blocked report with its blockers",
		setup(async (h, { m, run }) => {
			const res = await report(h, run, {
				status: "blocked",
				artifactsRead: [],
				blockers: [blocker],
				rereads: 0,
			});
			expect(res.status).toBe(201);
			const wire = created.parse(await res.json()).data;
			expect(wire).toMatchObject({
				status: "blocked",
				blockers: [blocker],
				artifactsWritten: [],
				filesTouched: 0,
				fileTypesTouched: [],
			});
			const [stored] = await reportsOf(h.tx, run.id);
			expect(stored?.blockers).toEqual([
				{
					description: blocker.description,
					workaround: blocker.workaround,
					provisioning_gap: true,
				},
			]);
			expect((await row(h.tx, run.id)).status).toBe("blocked");
			await expectReportsMatchDispatches(h.tx, [m.missionId]);
		}),
	);

	it(
		"answers 400 for a body that does not fit, and writes nothing",
		setup(async (h, { run }) => {
			const bodies: Array<[string, unknown]> = [
				["blocked without blockers", { ...complete, status: "blocked" }],
				["complete with blockers", { ...complete, blockers: [blocker] }],
				["a server field", { ...complete, actualTokens: 1 }],
				["filedBy", { ...complete, filedBy: "system" }],
				["artifactsWritten", { ...complete, artifactsWritten: [] }],
				["a halted status", { ...complete, status: "halted" }],
				[
					"the room root as a read path",
					{
						...complete,
						artifactsRead: [{ path: ".", sha256: sha("1") }],
					},
				],
				["negative rereads", { ...complete, rereads: -1 }],
				[
					"an uppercase sha",
					{
						...complete,
						artifactsRead: [{ path: "docs/spec.md", sha256: "A".repeat(64) }],
					},
				],
				[
					"a path leaving the room",
					{
						...complete,
						artifactsRead: [{ path: "../secret", sha256: sha("1") }],
					},
				],
				[
					"a .git path",
					{
						...complete,
						artifactsRead: [{ path: ".git/HEAD", sha256: sha("1") }],
					},
				],
				[
					"the same path twice once normalized",
					{
						...complete,
						artifactsRead: [
							{ path: "docs/spec.md", sha256: sha("1") },
							{ path: "docs\\spec.md", sha256: sha("2") },
						],
					},
				],
			];
			for (const [name, body] of bodies) {
				const error = await failure(await report(h, run, body), 400);
				expect(error.code, name).toBe("VALIDATION_FAILED");
			}
			const dup = await failure(await report(h, run, bodies[11]?.[1]), 400);
			expect(dup.details).toMatchObject({
				body: [{ path: ["artifactsRead", 1, "path"] }],
			});
			expect((await row(h.tx, run.id)).status).toBe("running");
			expect(await reportsOf(h.tx, run.id)).toEqual([]);
		}),
	);

	it(
		"stores read paths normalized",
		setup(async (h, { run }) => {
			const res = await report(h, run, {
				...complete,
				artifactsRead: [{ path: "./docs\\spec.md", sha256: sha("1") }],
			});
			expect(res.status).toBe(201);
			expect(created.parse(await res.json()).data.artifactsRead).toEqual([
				{ path: "docs/spec.md", sha256: sha("1") },
			]);
		}),
	);

	it(
		"refuses writes outside the mount (422), leaving the dispatch running and reportable",
		setup(async (h, { harness, run }) => {
			writeFiles(run.root, {
				"docs/spec.md": "# Changed\n",
				"src/ok.ts": "ok\n",
			});
			const error = await failure(await report(h, run, complete), 422);
			expect(error.code).toBe("PRECONDITION_FAILED");
			expect(error.details).toEqual({
				reason: "writes_outside_mount",
				dispatchId: run.id,
				issues: [
					{
						path: ["files", 0],
						message: "docs/spec.md (modified) is outside the writable paths",
					},
				],
			});
			expect((await row(h.tx, run.id)).status).toBe("running");
			expect(await reportsOf(h.tx, run.id)).toEqual([]);
			expect(harness.stopped).toEqual([]);
			expect(
				(await h.call("/api/agent/dispatch", { headers: bearer(run.token) }))
					.status,
			).toBe(200);

			// The agent puts the file back and reports again.
			writeFiles(run.root, { "docs/spec.md": "# Spec\n" });
			const res = await report(h, run, complete);
			expect(res.status).toBe(201);
			expect(
				created
					.parse(await res.json())
					.data.artifactsWritten.map((a) => a.path),
			).toEqual(["src/ok.ts"]);
		}),
	);

	it(
		"records an edge mismatch against the latest producer on the mission, and none for a match or no producer",
		setup(async (h, { m, run }) => {
			const ids = m.ids;
			const producer = async (
				written: Array<{ path: string; sha256: string }>,
				at: string,
				missionAgent = m.agent,
			) => {
				const id = await insertDispatchRow(
					h.tx,
					ids,
					dispatchValues(missionAgent, ids, "complete"),
				);
				const values = reportValues(ids, {
					id,
					missionId: missionAgent.missionId,
					rosterEntryId: missionAgent.entryId,
				});
				await h.tx.insert(completionReport).values({
					...values,
					artifactsWritten: written,
					createdAt: new Date(at),
					updatedAt: new Date(at),
				});
				return id;
			};
			await producer(
				[{ path: "fixtures/a.json", sha256: sha("3") }],
				"2026-10-01T00:00:00.000Z",
			);
			const latest = await producer(
				[
					{ path: "fixtures/a.json", sha256: sha("4") },
					{ path: "fixtures/same.json", sha256: sha("5") },
				],
				"2026-10-02T00:00:00.000Z",
			);
			// A deleted report and another mission's report never count.
			const gone = await producer(
				[{ path: "fixtures/same.json", sha256: sha("9") }],
				"2026-10-03T00:00:00.000Z",
			);
			await h.tx
				.update(completionReport)
				.set({ deletedAt: clock.now() })
				.where(eq(completionReport.dispatchId, gone));
			const other = await activeMission(h.tx, ids);
			await producer(
				[{ path: "fixtures/none.json", sha256: sha("6") }],
				"2026-10-04T00:00:00.000Z",
				other.agent,
			);

			const res = await report(h, run, {
				...complete,
				artifactsRead: [
					{ path: "fixtures/a.json", sha256: sha("3") },
					{ path: "fixtures/same.json", sha256: sha("5") },
					{ path: "fixtures/none.json", sha256: sha("7") },
				],
			});
			expect(res.status).toBe(201);
			expect(created.parse(await res.json()).data.edgeMismatches).toEqual([
				{
					path: "fixtures/a.json",
					readSha256: sha("3"),
					writtenSha256: sha("4"),
					producerDispatchId: latest,
				},
			]);
		}),
	);

	it("refuses room_unavailable for a running dispatch with no room, leaving it running", async () => {
		await withApi(async (h) => {
			const m = await activeMission(h.tx, seedIds(h.ns));
			const run = await dispatchWithToken(h.tx, m.ids, m.agent, "running");
			const error = await failure(
				await h.call(REPORT, {
					method: "POST",
					body: complete,
					headers: bearer(run.token),
				}),
				422,
			);
			expect(error.details).toEqual({
				reason: "room_unavailable",
				dispatchId: run.id,
				missionId: m.missionId,
			});
			expect((await row(h.tx, run.id)).status).toBe("running");
		});
	});

	it("refuses a family with no completion_report act (403), writing nothing", async () => {
		await withApi(async (h) => {
			const m = await activeMission(h.tx, seedIds(h.ns));
			// An Operate-family role only: that row is empty.
			await h.tx
				.update(agentTemplate)
				.set({ roles: ["incident-response"] })
				.where(eq(agentTemplate.id, m.agent.templateId));
			const run = await dispatchWithToken(h.tx, m.ids, m.agent, "running");
			const error = await failure(
				await h.call(REPORT, {
					method: "POST",
					body: complete,
					headers: bearer(run.token),
				}),
				403,
			);
			expect(error.code).toBe("AGENT_NOT_PERMITTED");
			expect(await reportsOf(h.tx, run.id)).toEqual([]);
		});
	});

	it("answers an operator session 403 FORBIDDEN", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const error = await failure(
				await h.call(REPORT, { method: "POST", body: complete }),
				403,
			);
			expect(error.code).toBe("FORBIDDEN");
		});
	});

	it("keeps one report per dispatch in the database (unique dispatch_id)", async () => {
		await withApi(async (h) => {
			const m = await activeMission(h.tx, seedIds(h.ns));
			const id = await insertDispatchRow(
				h.tx,
				m.ids,
				dispatchValues(m.agent, m.ids, "complete"),
			);
			const d = { id, missionId: m.missionId, rosterEntryId: m.agent.entryId };
			await h.tx.insert(completionReport).values(reportValues(m.ids, d));
			const err = await dbRefusal(h.tx, () =>
				h.tx.insert(completionReport).values(reportValues(m.ids, d)),
			);
			expect(err.constraint_name).toBe("completion_report_dispatch_id_uq");
			expect(
				await h.tx
					.select()
					.from(completionReport)
					.where(eq(completionReport.dispatchId, id)),
			).toHaveLength(1);
		});
	});

	it(
		"counts a deleted file as touched, never as written",
		setup(async (h, { run }) => {
			unlinkSync(path.join(run.root, "src", "a.ts"));
			const res = await report(h, run, complete);
			expect(res.status).toBe(201);
			const wire = created.parse(await res.json()).data;
			expect(wire.filesTouched).toBe(1);
			expect(wire.fileTypesTouched).toEqual(["ts"]);
			expect(wire.artifactsWritten).toEqual([]);
			expect(existsSync(run.root)).toBe(true);
		}),
	);
});
