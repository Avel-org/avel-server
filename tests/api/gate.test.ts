import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	errorEnvelope,
	type Gate,
	gateJob as gateJobSchema,
	gateRunListEnvelope,
	gateRun as gateRunSchema,
	missionDetail,
	missionListEnvelope,
	preconditionDetails,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	client,
	completionReport,
	engagement,
	finding,
	gateJob,
	mission,
	playbook,
	rosterPreset,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import type {
	CheckRunner,
	CheckRunRequest,
	CheckRunResult,
} from "../../src/gateways/check-runner";
import { worktreeRooms } from "../../src/rooms/provider";
import { snapshotDispatch } from "../../src/rooms/snapshot";
import type { RoomSource, RoomSourceResolver } from "../../src/rooms/sources";
import { GATE_JOB_LIMIT_MS, sweepGateJobs } from "../../src/runner/gate-job";
import {
	DISPATCH_PLAN,
	dispatchValues,
	insertDispatchRow,
	reportValues,
	type SeededAgent,
	seedAgent,
} from "../db/dispatch-fixtures";
import { makeRepo, removeDir, tempDir, writeFiles } from "../unit/git-fixtures";
import { drain, jobDeps, postGate, runGate } from "./gate-job-fixtures";
import {
	activeClientMission,
	activeMission,
	CLIENT_REPO,
	type Mission,
	runnerIds,
	TEMPLATE_COMMIT,
} from "./runner-fixtures";
import { type ApiHarness, clock, withApi } from "./support";

// POST /api/missions/:id/gate and its reads (module 9, decided 2026-10-19):
// the mission's complete dispatches integrated onto its pinned commit,
// judged by decide(), recorded with its receipt in the activity log.

vi.setConfig({ testTimeout: 60_000 });

const base = tempDir("gate");
afterAll(async () => {
	removeDir(base);
	await closeDb();
});

const FILES = {
	"src/a.ts": "export const a = 1;\n",
	"package.json": '{ "name": "salon", "scripts": { "test": "vitest run" } }\n',
};

let n = 0;

/**
 * A repository at its pinned commit, and a source resolver that finds it
 * for any source and records each source it was asked for.
 */
function repo(files: Record<string, string> = FILES) {
	const dir = path.join(base, `repo-${++n}`);
	const [pinned] = makeRepo(dir, files) as [string];
	const rooms = worktreeRooms(path.join(base, `rooms-${n}`));
	const asked: RoomSource[] = [];
	const roomSources: RoomSourceResolver = {
		resolve: async (source) => {
			asked.push(source);
			return { ok: true, repoPath: dir, commit: pinned };
		},
	};
	return { dir, pinned, rooms, roomSources, asked };
}

type Repo = ReturnType<typeof repo>;

async function pinTo(tx: Tx, m: Mission, sha: string) {
	await tx
		.update(mission)
		.set({ templateVersion: sha })
		.where(eq(mission.id, m.missionId));
}

/** A dispatch that closed with `status`, its room's bytes committed when it has files. */
async function closedDispatch(
	h: ApiHarness,
	m: Mission,
	r: Repo,
	files: Record<string, string> | null,
	status: "complete" | "blocked" = "complete",
	/** Another roster entry's agent, and paths the room deletes. */
	opts: { agent?: SeededAgent; remove?: string[] } = {},
) {
	const agent = opts.agent ?? m.agent;
	const id = await insertDispatchRow(
		h.tx,
		m.ids,
		dispatchValues(agent, m.ids, "complete"),
	);
	let resultCommitSha: string | null = null;
	if (files) {
		const room = await r.rooms.open({
			dispatchId: id,
			repoPath: r.dir,
			commit: r.pinned,
			writableGlobs: ["**"],
		});
		writeFiles(room.root, files);
		for (const p of opts.remove ?? []) rmSync(path.join(room.root, p));
		resultCommitSha = await snapshotDispatch(
			room,
			r.pinned,
			id,
			clock.now().toISOString(),
		);
	}
	await h.tx
		.insert(completionReport)
		.values(
			reportValues(
				m.ids,
				{ id, missionId: m.missionId, rosterEntryId: agent.entryId },
				{ status, resultCommitSha },
			),
		);
	return id;
}

/** A playbook for a type of the call's own, made the mission's type, with `brief`. */
async function playbookFor(
	h: ApiHarness,
	m: Mission,
	gates: { gate: Gate; policy: "mandatory" | "warn" }[],
	brief: unknown,
) {
	const type = `gate-${h.ns}`;
	const presetId = m.ids.next();
	await h.tx.insert(rosterPreset).values({
		id: presetId,
		name: `Preset ${h.ns}`,
		description: null,
		cut: "vertical",
		agents: [],
		version: 1,
		...stamp(clock),
	});
	await h.tx.insert(playbook).values({
		id: m.ids.next(),
		missionType: type,
		name: "Gate test",
		wavesApplicable: ["A"],
		gates,
		deliverable: "pr",
		requiredFields: [],
		defaultPresetId: presetId,
		version: 1,
		...stamp(clock),
	});
	await h.tx
		.update(mission)
		.set({ type, brief: brief as never })
		.where(eq(mission.id, m.missionId));
}

const QA_AND_ACCEPTANCE = [
	{ gate: "qa", policy: "mandatory" },
	{ gate: "acceptance", policy: "mandatory" },
] as const;

/** DISPATCH_PLAN with file_exists checks: R1 on a path only the work adds, R2 on one only the base had. */
const FILE_CHECKS_PLAN = {
	...DISPATCH_PLAN,
	checks: [
		{ id: "CK1", requirementId: "R1", kind: "file_exists", path: "src/b.ts" },
		{ id: "CK2", requirementId: "R2", kind: "file_exists", path: "src/a.ts" },
	],
};

/**
 * DISPATCH_PLAN with checks the gate can run: a file_exists on src/** for
 * each requirement, which every dispatch here satisfies by writing under
 * src/. DISPATCH_PLAN's own test checks have no runner, so a run on it
 * lists them as not checked and is never verified.
 */
const RUNNABLE_PLAN = {
	...DISPATCH_PLAN,
	checks: [
		{ id: "CK1", requirementId: "R1", kind: "file_exists", path: "src/**" },
		{ id: "CK2", requirementId: "R2", kind: "file_exists", path: "src/**" },
	],
};

const run = runGate;

async function refusal(res: Response) {
	expect(res.status, await res.clone().text()).toBe(422);
	return preconditionDetails.parse(
		errorEnvelope.parse(await res.json()).error.details,
	);
}

async function gated(
	r: Repo,
	fn: (h: ApiHarness, m: Mission) => Promise<void>,
	checkRunner?: CheckRunner,
) {
	return withApi(
		async (h) => {
			await h.signIn();
			const m = await activeMission(h.tx, runnerIds(h.ns));
			await pinTo(h.tx, m, r.pinned);
			await h.tx
				.update(mission)
				.set({ brief: RUNNABLE_PLAN as never })
				.where(eq(mission.id, m.missionId));
			jobDeps(h, r.roomSources, checkRunner ?? null);
			await fn(h, m);
		},
		{ roomSources: r.roomSources, checkRunner },
	);
}

/** A check runner that answers by command, and records what it was asked. */
function scriptedRunner(
	answer: (command: string) => CheckRunResult | Error,
): CheckRunner & { requests: CheckRunRequest[] } {
	const requests: CheckRunRequest[] = [];
	return {
		id: "scripted@1",
		requests,
		run: async (req) => {
			requests.push(req);
			const results = req.checks.map((c) => answer(c.command));
			const broke = results.find((x) => x instanceof Error);
			if (broke) throw broke;
			return results as CheckRunResult[];
		},
	};
}

const PASS: CheckRunResult = { outcome: "pass", exitCode: 0, output: "ok" };

describe.skipIf(!process.env.DATABASE_URL)("/api gate", () => {
	it("judges the integration commit of the complete dispatches, records the run, and serves it back", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			// A playbook that makes acceptance mandatory, so the plan's checks count.
			const type = `gate-${h.ns}`;
			const presetId = m.ids.next();
			await h.tx.insert(rosterPreset).values({
				id: presetId,
				name: `Preset ${h.ns}`,
				description: null,
				cut: "vertical",
				agents: [],
				version: 1,
				...stamp(clock),
			});
			await h.tx.insert(playbook).values({
				id: m.ids.next(),
				missionType: type,
				name: "Gate test",
				wavesApplicable: ["A"],
				gates: [{ gate: "acceptance", policy: "mandatory" }],
				deliverable: "pr",
				requiredFields: [],
				defaultPresetId: presetId,
				version: 1,
				...stamp(clock),
			});
			await h.tx
				.update(mission)
				.set({ type })
				.where(eq(mission.id, m.missionId));
			await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
			await closedDispatch(h, m, r, { "src/c.ts": "export const c = 3;\n" });

			const res = await run(h, m.missionId);
			expect(res.status, await res.clone().text()).toBe(200);
			const posted = successEnvelope(gateRunSchema).parse(
				await res.json(),
			).data;
			expect(posted.baseSha).toBe(r.pinned);
			// An internal mission is judged on its template at the pin: at the
			// POST's precondition check, and twice by the job.
			expect(r.asked).toEqual(
				Array(3).fill({
					kind: "template",
					slug: "template-booking",
					commit: r.pinned,
				}),
			);
			expect(posted.commitSha).toMatch(/^[0-9a-f]{40}$/);
			expect(posted.commitSha).not.toBe(r.pinned);
			expect(posted.receiptSha256).toBe(
				createHash("sha256").update(posted.receipt, "utf8").digest("hex"),
			);
			// Every check ran and passed, so the run is verified.
			expect(posted.reasons.filter((x) => x.degraded)).toEqual([]);
			expect(posted.result).toBe("verified");
			expect([posted.decideVersion, posted.receiptVersion]).toEqual([4, 5]);
			const receipt = JSON.parse(posted.receipt);
			expect(receipt.result).toBe("verified");
			expect(receipt.decision.notChecked).toEqual([]);

			const list = gateRunListEnvelope.parse(
				await (await h.call(`/api/missions/${m.missionId}/gate-runs`)).json(),
			);
			expect(list.meta.total).toBe(1);
			expect(list.data[0]?.id).toBe(posted.id);
			expect(list.data[0]?.actor.kind).toBe("operator");
			expect(list.data[0]?.result).toBe("verified");
			const read = successEnvelope(gateRunSchema).parse(
				await (
					await h.call(`/api/missions/${m.missionId}/gate-runs/${posted.id}`)
				).json(),
			).data;
			expect(read).toEqual(posted);

			const [logged] = await h.tx
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.missionId, m.missionId),
						eq(activityLog.action, "mission.gate_run"),
					),
				);
			expect(logged?.id).toBe(posted.id);

			// A run stored before decide() version 3 has a verdict and an
			// assurance, and its gates carry verdicts: its result is read from
			// the stored reasons. The log is append-only, so the old run is a
			// second row beside it.
			if (!logged) throw new Error("no gate run row");
			const v2 = JSON.parse(posted.receipt);
			delete v2.result;
			delete v2.decision.result;
			v2.verdict = "pass";
			v2.assurance = "verified";
			v2.decision.verdict = "pass";
			v2.decision.assurance = "verified";
			const verdictOf: Record<string, string> = {
				verified: "pass",
				pass: "warn",
				fail: "block",
			};
			v2.decision.gates = v2.decision.gates.map(
				({ result, ...g }: { result: string }) => ({
					...g,
					verdict: verdictOf[result],
				}),
			);
			const { result: _dropped, ...oldPayload } = logged.payload as Record<
				string,
				unknown
			>;
			const oldId = m.ids.next();
			await h.tx.insert(activityLog).values({
				...logged,
				id: oldId,
				payload: {
					...oldPayload,
					verdict: "pass",
					assurance: "verified",
					decideVersion: 2,
					receiptVersion: 2,
					receipt: JSON.stringify(v2),
				},
			});
			const old = successEnvelope(gateRunSchema).parse(
				await (
					await h.call(`/api/missions/${m.missionId}/gate-runs/${oldId}`)
				).json(),
			).data;
			expect([old.decideVersion, old.result]).toEqual([2, "verified"]);
			expect(old.gates.map((g) => g.result)).toEqual(
				posted.gates.map((g) => g.result),
			);
			const oldList = gateRunListEnvelope.parse(
				await (await h.call(`/api/missions/${m.missionId}/gate-runs`)).json(),
			);
			expect(oldList.data.find((x) => x.id === oldId)?.result).toBe("verified");
		});
	});

	it("judges a client mission on its intake's read commit, never its template pin", async () => {
		const r = repo();
		await withApi(
			async (h) => {
				await h.signIn();
				jobDeps(h, r.roomSources);
				const m = await activeClientMission(h, runnerIds(h.ns), {
					repoUrl: CLIENT_REPO,
					commit: r.pinned,
				});
				// The pin only records which template version the code came from.
				await h.tx
					.update(mission)
					.set({
						templateRef: "template-booking",
						templateVersion: TEMPLATE_COMMIT,
					})
					.where(eq(mission.id, m.missionId));
				expect(TEMPLATE_COMMIT).not.toBe(r.pinned);
				await h.tx
					.update(mission)
					.set({ brief: RUNNABLE_PLAN as never })
					.where(eq(mission.id, m.missionId));
				await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
				const res = await run(h, m.missionId);
				expect(res.status, await res.clone().text()).toBe(200);
				const posted = successEnvelope(gateRunSchema).parse(
					await res.json(),
				).data;
				expect(posted.baseSha).toBe(r.pinned);
				expect(r.asked).toEqual(
					Array(3).fill({
						kind: "repo",
						repoUrl: CLIENT_REPO,
						commit: r.pinned,
					}),
				);

				// A deleted client hides its missions' gate runs, as it hides their dispatches.
				const [eng] = await h.tx
					.select({ clientId: engagement.clientId })
					.from(engagement)
					.where(eq(engagement.id, m.engagementId as string));
				await h.tx
					.update(client)
					.set({ deletedAt: clock.now() })
					.where(eq(client.id, eng?.clientId as string));
				for (const url of [
					`/api/missions/${m.missionId}/gate-runs`,
					`/api/missions/${m.missionId}/gate-runs/${posted.id}`,
				]) {
					expect((await h.call(url)).status, url).toBe(404);
				}
			},
			{ roomSources: r.roomSources },
		);
	});

	it("runs without the tools for every check, and lists what it could not check", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
			// rollback has no producer, and the plan's test checks no runner.
			await playbookFor(
				h,
				m,
				[...QA_AND_ACCEPTANCE, { gate: "rollback", policy: "warn" }],
				DISPATCH_PLAN,
			);
			const res = await run(h, m.missionId);
			expect(res.status, await res.clone().text()).toBe(200);
			const posted = successEnvelope(gateRunSchema).parse(
				await res.json(),
			).data;
			// It ran and recorded what passed...
			expect(posted.gates.map((g) => [g.gate, g.result])).toEqual([
				["qa", "verified"],
				["rollback", "pass"],
				["acceptance", "pass"],
			]);
			// ...and names each thing it could not check, so it is not verified
			// and cannot ship (J, 2026-10-21).
			expect(posted.result).toBe("pass");
			const receipt = JSON.parse(posted.receipt);
			expect(
				receipt.decision.notChecked.map(
					(n: { findingId: string; source: string | null }) =>
						`${n.findingId}:${n.source}`,
				),
			).toEqual([
				"not_run:rollback:null",
				"check:CK1:0:runner",
				"check:CK2:1:runner",
			]);
			const rollback = posted.reasons.find(
				(x) => x.findingId === "not_run:rollback",
			);
			expect(rollback?.message).toBe(
				"Not checked: nothing reported on the rollback gate at this commit",
			);
		});
	});

	it("runs the brief's test checks on an installed runner: all passing verifies, one failing fails, a broken runner verifies nothing", async () => {
		const cases = [
			{ name: "pass", answer: () => PASS, result: "verified", ck2: "pass" },
			{
				name: "fail",
				answer: (c: string) =>
					c === "pnpm test R2"
						? { outcome: "fail" as const, exitCode: 1, output: "1 failed" }
						: PASS,
				result: "fail",
				ck2: "fail",
			},
			{
				name: "broken",
				answer: () => new Error("docker is not running"),
				result: "fail",
				ck2: "error",
			},
		];
		for (const c of cases) {
			const r = repo();
			const runner = scriptedRunner(c.answer);
			await gated(
				r,
				async (h, m) => {
					await closedDispatch(h, m, r, {
						"src/b.ts": "export const b = 2;\n",
					});
					await playbookFor(h, m, [...QA_AND_ACCEPTANCE], DISPATCH_PLAN);
					const res = await run(h, m.missionId);
					expect(res.status, await res.clone().text()).toBe(200);
					const posted = successEnvelope(gateRunSchema).parse(
						await res.json(),
					).data;
					expect(posted.result, c.name).toBe(c.result);
					// The runner ran the brief's commands on the integration commit.
					expect(runner.requests.map((q) => q.commitSha)).toEqual([
						posted.commitSha,
					]);
					expect(runner.requests[0]?.checks.map((k) => k.command)).toEqual([
						"pnpm test R1",
						"pnpm test R2",
					]);
					const receipt = JSON.parse(posted.receipt);
					expect(receipt.runner).toBe("scripted@1");
					expect(receipt.config.availableSources).toContain("runner");
					// A check the runner could not finish is not checked.
					expect(
						receipt.decision.notChecked.map(
							(n: { findingId: string }) => n.findingId,
						),
					).toEqual(c.name === "broken" ? ["check:CK1:0", "check:CK2:1"] : []);
					const ck2 = receipt.findings.find(
						(f: { id: string }) => f.id === "check:CK2:1",
					);
					expect(ck2.outcome, c.name).toBe(c.ck2);
					expect(ck2.subject).toBe(
						c.ck2 === "fail"
							? "CK2 (R2): test pnpm test R2 exited 1"
							: c.ck2 === "error"
								? "CK2 (R2): test pnpm test R2 did not finish"
								: "CK2 (R2): test pnpm test R2",
					);
					// Its output stays out of the receipt.
					expect(posted.receipt).not.toContain("1 failed");
				},
				runner,
			);
		}
	});

	it("fails security on a secret the work committed, and keeps the secret out of the receipt", async () => {
		const r = repo();
		// Built at run time, so this file holds no literal a push-protection scanner reads as a key.
		const key = `gh${"p_"}${"a1".repeat(18)}`;
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, {
				"src/b.ts": `export const b = 2;\nconst token = "${key}";\n`,
				".env": "PORT=3000\n",
			});
			await playbookFor(
				h,
				m,
				[...QA_AND_ACCEPTANCE, { gate: "security", policy: "mandatory" }],
				RUNNABLE_PLAN,
			);
			const res = await run(h, m.missionId);
			expect(res.status, await res.clone().text()).toBe(200);
			const posted = successEnvelope(gateRunSchema).parse(
				await res.json(),
			).data;
			expect(posted.result).toBe("fail");
			const security = posted.gates.find((g) => g.gate === "security");
			expect(security?.result).toBe("fail");
			expect(
				security?.reasons
					.filter((x) => x.effect === "block")
					.map((x) => x.subject),
			).toEqual([
				".env: an environment file is committed",
				"src/b.ts:2: matches github-token",
			]);
			expect(posted.receipt).not.toContain(key);
		});
	});

	it("leaves a secret the client's base already had to the client, and lists a file too large to scan", async () => {
		const key = `AKI${"A"}${"Q".repeat(16)}`;
		const r = repo({ ...FILES, "src/config.ts": `const k = "${key}";\n` });
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, {
				// The work edits another line of the file that holds the client's key.
				"src/config.ts": `const k = "${key}";\nexport const port = 4000;\n`,
				// Over the scan limit: sized first, never read whole, listed.
				"src/big.txt": "x".repeat(2 * 1024 * 1024),
			});
			await playbookFor(
				h,
				m,
				[...QA_AND_ACCEPTANCE, { gate: "security", policy: "mandatory" }],
				RUNNABLE_PLAN,
			);
			const res = await run(h, m.missionId);
			expect(res.status, await res.clone().text()).toBe(200);
			const posted = successEnvelope(gateRunSchema).parse(
				await res.json(),
			).data;
			const security = posted.gates.find((g) => g.gate === "security");
			expect(security?.reasons.map((x) => [x.findingId, x.effect])).toEqual([
				["check:secret:src/big.txt:too-large", "block"],
				["check:dependency", "pass"],
			]);
		});
	});

	it("verifies security on clean work, and lists a new dependency as not checked", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, {
				"src/b.ts": "export const b = 2;\n",
				"package.json":
					'{ "name": "salon", "scripts": { "test": "vitest run" }, "dependencies": { "zod": "^4.0.0" } }\n',
			});
			await playbookFor(
				h,
				m,
				[...QA_AND_ACCEPTANCE, { gate: "security", policy: "warn" }],
				RUNNABLE_PLAN,
			);
			const res = await run(h, m.missionId);
			const posted = successEnvelope(gateRunSchema).parse(
				await res.json(),
			).data;
			// No secret, but nothing here can ask the registry whether zod exists.
			expect(posted.gates.map((g) => [g.gate, g.result])).toEqual([
				["qa", "verified"],
				["security", "pass"],
				["acceptance", "verified"],
			]);
			expect(
				JSON.parse(posted.receipt).decision.notChecked.map(
					(n: { findingId: string; source: string | null }) =>
						`${n.findingId}:${n.source}`,
				),
			).toEqual(["check:dependency:package.json#dependencies.zod:registry"]);
			expect(posted.result).toBe("pass");
		});
	});

	it("blocks, with no override, when a builder wrote a test file", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, {
				"src/b.ts": "export const b = 2;\n",
				"tests/b.test.ts": "it('passes', () => {});\n",
			});
			const res = await run(h, m.missionId);
			const posted = successEnvelope(gateRunSchema).parse(
				await res.json(),
			).data;
			expect(posted.result).toBe("fail");
			const violation = posted.reasons.find(
				(x) => x.rule === "checkpoint_violation",
			);
			expect(violation?.subject).toContain("tests/b.test.ts");
			expect(violation?.overridable).toBe(false);

			const overridden = successEnvelope(gateRunSchema).parse(
				await (
					await run(h, m.missionId, {
						overrides: [
							{
								findingId: violation?.findingId,
								commitSha: posted.commitSha,
								rationale: "I wrote it",
							},
						],
					})
				).json(),
			).data;
			expect(overridden.result).toBe("fail");
			expect(overridden.ignoredOverrides[0]?.why).toBe("not_overridable");
		});
	});

	it("replays a run by its idempotency key, and refuses the key with another body", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
			const key = "00000000-0000-4000-8000-0000000000aa";
			const first = await run(h, m.missionId, {}, key);
			expect(first.status).toBe(200);
			const firstRun = successEnvelope(gateRunSchema).parse(
				await first.json(),
			).data;
			// The replay answers the job, which names the run it made.
			const again = await postGate(h, m.missionId, {}, key);
			expect(again.status).toBe(200);
			expect(again.headers.get("idempotency-replayed")).toBe("true");
			const replayed = successEnvelope(gateJobSchema).parse(
				await again.json(),
			).data;
			expect([replayed.status, replayed.gateRunId]).toEqual([
				"done",
				firstRun.id,
			]);
			const other = await postGate(
				h,
				m.missionId,
				{
					overrides: [
						{ findingId: "x", commitSha: r.pinned, rationale: "different" },
					],
				},
				key,
			);
			expect(other.status).toBe(409);
		});
	});

	it("refuses with each precondition, naming what to fix", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			expect((await refusal(await run(h, m.missionId))).reason).toBe(
				"nothing_to_judge",
			);

			const a = await closedDispatch(h, m, r, { "src/x.ts": "1\n" });
			const b = await closedDispatch(h, m, r, { "src/x.ts": "2\n" });
			const conflict = await refusal(await run(h, m.missionId));
			expect(conflict.reason).toBe("integration_conflict");
			expect(conflict.issues).toEqual([
				{
					path: ["integration", "src/x.ts"],
					message: [a, b].sort().join(", "),
				},
			]);

			const bare = await closedDispatch(h, m, r, null);
			const missing = await refusal(await run(h, m.missionId));
			expect(missing.reason).toBe("dispatch_commit_missing");
			expect(missing.issues).toEqual([
				{ path: ["dispatches", bare], message: "no result commit" },
			]);

			const live = await insertDispatchRow(
				h.tx,
				m.ids,
				dispatchValues(m.agent, m.ids, "running"),
			);
			const running = await refusal(await run(h, m.missionId));
			expect(running.reason).toBe("dispatches_running");
			expect(running.issues).toEqual([
				{ path: ["dispatches", live], message: "running" },
			]);

			await h.tx
				.update(mission)
				.set({ status: "draft" })
				.where(eq(mission.id, m.missionId));
			expect((await refusal(await run(h, m.missionId))).reason).toBe(
				"mission_not_active",
			);
		});
	});

	it("checks file_exists against the integration commit, never the base", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await playbookFor(h, m, [...QA_AND_ACCEPTANCE], FILE_CHECKS_PLAN);
			await closedDispatch(
				h,
				m,
				r,
				{ "src/b.ts": "export const b = 2;\n" },
				"complete",
				{ remove: ["src/a.ts"] },
			);
			const posted = successEnvelope(gateRunSchema).parse(
				await (await run(h, m.missionId)).json(),
			).data;
			const of = (id: string) => posted.reasons.find((x) => x.findingId === id);
			// src/b.ts exists only at head; src/a.ts only at the base.
			expect([of("check:CK1:0")?.rule, of("check:CK2:1")?.rule]).toEqual([
				"passed",
				"mandatory_failed",
			]);
			expect(of("check:CK2:1")?.subject).toContain("does not exist");
			expect(posted.result).toBe("fail");
		});
	});

	it("gathers every producer's findings into the run", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await playbookFor(h, m, [...QA_AND_ACCEPTANCE], FILE_CHECKS_PLAN);
			// A judge on the roster: complete, with one open finding.
			const judge = await seedAgent(h.tx, m.ids, m.missionId, "Vera");
			await h.tx
				.update(agentTemplate)
				.set({ roles: ["security-review"] })
				.where(eq(agentTemplate.id, judge.templateId));
			const author = await closedDispatch(h, m, r, {
				"src/b.ts": "export const b = 2;\n",
				// A package.json that does not parse is protected as a whole file.
				"package.json": "{ not json",
			});
			const judged = await closedDispatch(h, m, r, {}, "complete", {
				agent: judge,
			});
			const open = m.ids.next();
			await h.tx.insert(finding).values({
				id: open,
				missionId: m.missionId,
				clientId: m.clientId,
				rule: "no secrets in source",
				subject: "src/b.ts",
				severity: "high",
				class: "security",
				status: "open",
				caughtBy: "judge",
				reportedByDispatchId: judged,
				idempotencyKey: `finding-${open}`,
				requestSha256: "f".repeat(64),
				...stamp(clock),
			});

			const res = await run(h, m.missionId);
			expect(res.status, await res.clone().text()).toBe(200);
			const posted = successEnvelope(gateRunSchema).parse(
				await res.json(),
			).data;
			const rules = Object.fromEntries(
				posted.reasons.map((x) => [x.findingId, x.rule]),
			);
			expect(rules).toMatchObject({
				// spec-check, on the brief
				"spec-check:R1": "passed",
				"spec-check:R2": "passed",
				// the brief's file_exists checks
				"check:CK1:0": "passed",
				// protected paths, with an unparseable package.json protected whole
				"checkpoint:protected:package.json": "checkpoint_violation",
				// the test-file checkpoint, once per dispatch
				[`checkpoint:test-glob:${author}:src/b.ts`]: "passed",
				[`checkpoint:test-glob:${author}:package.json`]: "passed",
				[`checkpoint:test-glob:${judged}`]: "passed",
				// judge coverage: complete with one open finding is a fail
				[`judge-coverage:${judge.entryId}`]: "mandatory_failed",
				// the open finding itself blocks
				[open]: "judge_open",
			});
			expect(posted.result).toBe("fail");
		});
	});

	it("refuses nothing_to_judge when the complete dispatches changed nothing", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			// A complete dispatch whose room was left as it was pinned: one
			// integration step with no ops, so a tree equal to the base's.
			await closedDispatch(h, m, r, {});
			const refused = await refusal(await run(h, m.missionId));
			expect(refused.reason).toBe("nothing_to_judge");
		});
	});

	it("answers 404 for an unknown mission or run", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			const missing = "00000000-0000-4000-8000-00000000ffff";
			expect((await run(h, missing)).status).toBe(404);
			expect(
				(await h.call(`/api/missions/${m.missionId}/gate-runs/${missing}`))
					.status,
			).toBe(404);
		});
	});
});

// Background gate runs (2026-10-23): the POST queues a job, the tick runs it.
describe.skipIf(!process.env.DATABASE_URL)("/api gate jobs", () => {
	const jobOf = async (res: Response, status: number) => {
		expect(res.status, await res.clone().text()).toBe(status);
		return successEnvelope(gateJobSchema).parse(await res.json()).data;
	};
	const getJob = async (h: ApiHarness, id: string) =>
		jobOf(await h.call(`/api/gate-jobs/${id}`), 200);
	const detailOf = async (h: ApiHarness, id: string) =>
		successEnvelope(missionDetail).parse(
			await (await h.call(`/api/missions/${id}`)).json(),
		).data;
	const listed = async (h: ApiHarness, id: string) =>
		missionListEnvelope
			.parse(
				await (await h.call("/api/missions?origin=internal&limit=100")).json(),
			)
			.data.find((x) => x.id === id);

	it("queues a job, runs it in the background, and shows it on the mission while it is active", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
			const queued = await jobOf(await postGate(h, m.missionId), 202);
			expect(queued).toMatchObject({
				missionId: m.missionId,
				status: "queued",
				gateRunId: null,
				failure: null,
				progress: null,
				ahead: 0,
				startedAt: null,
				finishedAt: null,
			});
			const logged = (await h.logRows(m.missionId)).filter(
				(x) => x.action === "mission.gate_queued",
			);
			expect(logged.map((x) => x.payload)).toEqual([{ jobId: queued.id }]);
			expect((await detailOf(h, m.missionId)).activeGateJob?.id).toBe(
				queued.id,
			);
			expect((await listed(h, m.missionId))?.gateRunning).toBe(true);

			// A second POST while it is queued answers the same job.
			const again = await postGate(h, m.missionId);
			expect(again.headers.get("gate-job-existing")).toBe("true");
			expect((await jobOf(again, 200)).id).toBe(queued.id);

			await drain(h);
			const done = await getJob(h, queued.id);
			expect(done).toMatchObject({
				status: "done",
				failure: null,
				ahead: null,
				// No runner is installed, so it ran no checks.
				progress: { checksTotal: 0, checksDone: 0, currentCheckId: null },
			});
			expect(done.startedAt).not.toBeNull();
			expect(done.finishedAt).not.toBeNull();
			const runRes = await h.call(
				`/api/missions/${m.missionId}/gate-runs/${done.gateRunId}`,
			);
			expect(runRes.status).toBe(200);
			const [runRow] = (await h.logRows(m.missionId)).filter(
				(x) => x.action === "mission.gate_run",
			);
			expect(runRow?.id).toBe(done.gateRunId);
			expect((runRow?.payload as { jobId: string }).jobId).toBe(queued.id);
			expect(runRow?.actorUserId).toBe(await h.operatorId());

			expect((await detailOf(h, m.missionId)).activeGateJob).toBeNull();
			expect((await listed(h, m.missionId))?.gateRunning).toBe(false);
		});
	});

	it("reports progress check by check, naming the brief's check", async () => {
		const r = repo();
		const seen: unknown[] = [];
		let harness: ApiHarness | undefined;
		let jobId = "";
		const runner: CheckRunner = {
			id: "progress@1",
			run: async (req) => {
				for (const [i] of req.checks.entries()) {
					await req.onProgress?.(i, i);
					seen.push((await getJob(harness as ApiHarness, jobId)).progress);
				}
				await req.onProgress?.(req.checks.length, null);
				return req.checks.map(() => PASS);
			},
		};
		await gated(
			r,
			async (h, m) => {
				harness = h;
				await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
				await playbookFor(h, m, [...QA_AND_ACCEPTANCE], DISPATCH_PLAN);
				jobId = (await jobOf(await postGate(h, m.missionId), 202)).id;
				await drain(h);
				expect(seen).toEqual([
					{ checksTotal: 2, checksDone: 0, currentCheckId: "CK1" },
					{ checksTotal: 2, checksDone: 1, currentCheckId: "CK2" },
				]);
				const done = await getJob(h, jobId);
				expect([done.status, done.progress]).toEqual([
					"done",
					{ checksTotal: 2, checksDone: 2, currentCheckId: null },
				]);
			},
			runner,
		);
	});

	it("fails integration_moved when a dispatch closes while the checks run, and writes no run", async () => {
		const r = repo();
		let closeOne: (() => Promise<unknown>) | undefined;
		const runner: CheckRunner = {
			id: "moving@1",
			run: async (req) => {
				await closeOne?.();
				return req.checks.map(() => PASS);
			},
		};
		await gated(
			r,
			async (h, m) => {
				await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
				await playbookFor(h, m, [...QA_AND_ACCEPTANCE], DISPATCH_PLAN);
				closeOne = () =>
					closedDispatch(h, m, r, { "src/c.ts": "export const c = 3;\n" });
				const queued = await jobOf(await postGate(h, m.missionId), 202);
				await drain(h);
				const failed = await getJob(h, queued.id);
				expect([
					failed.status,
					failed.failure?.code,
					failed.failure?.reason,
				]).toEqual(["failed", "integration_moved", null]);
				expect(failed.gateRunId).toBeNull();
				const rows = await h.logRows(m.missionId);
				expect(rows.filter((x) => x.action === "mission.gate_run")).toEqual([]);
				expect(
					rows
						.filter((x) => x.action === "mission.gate_failed")
						.map((x) => [x.actorKind, x.payload]),
				).toEqual([
					[
						"system",
						{
							jobId: queued.id,
							failure: { code: "integration_moved", reason: null },
						},
					],
				]);
				// Once it has failed, the mission can be gated again.
				closeOne = undefined;
				await jobOf(await postGate(h, m.missionId), 202);
			},
			runner,
		);
	});

	it("fails precondition_failed, naming the reason, when a precondition stops holding before the job runs", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
			const queued = await jobOf(await postGate(h, m.missionId), 202);
			await h.tx
				.update(mission)
				.set({ status: "draft" })
				.where(eq(mission.id, m.missionId));
			await drain(h);
			const failed = await getJob(h, queued.id);
			expect([
				failed.status,
				failed.failure?.code,
				failed.failure?.reason,
			]).toEqual(["failed", "precondition_failed", "mission_not_active"]);
		});
	});

	it("fails a job a stopped server left running as interrupted, and one past its limit as timed_out", async () => {
		const r = repo();
		let now = clock.now().getTime();
		const tickClock = { now: () => new Date(now) };
		const runner: CheckRunner = {
			id: "slow@1",
			run: async (req) => {
				now += GATE_JOB_LIMIT_MS + 1;
				return req.checks.map(() => PASS);
			},
		};
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
			await playbookFor(h, m, [...QA_AND_ACCEPTANCE], DISPATCH_PLAN);
			const deps = jobDeps(h, r.roomSources, runner, tickClock);

			const left = await jobOf(await postGate(h, m.missionId), 202);
			await h.tx
				.update(gateJob)
				.set({ status: "running", startedAt: tickClock.now() })
				.where(eq(gateJob.id, left.id));
			expect(await sweepGateJobs(deps)).toEqual([left.id]);
			expect((await getJob(h, left.id)).failure?.code).toBe("interrupted");

			const slow = await jobOf(await postGate(h, m.missionId), 202);
			await drain(h);
			const timed = await getJob(h, slow.id);
			expect([timed.status, timed.failure?.code, timed.gateRunId]).toEqual([
				"failed",
				"timed_out",
				null,
			]);
		});
	});

	it("fails internal when the runner breaks its contract", async () => {
		const r = repo();
		const runner: CheckRunner = { id: "short@1", run: async () => [] };
		await gated(
			r,
			async (h, m) => {
				await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
				await playbookFor(h, m, [...QA_AND_ACCEPTANCE], DISPATCH_PLAN);
				const queued = await jobOf(await postGate(h, m.missionId), 202);
				await drain(h);
				const failed = await getJob(h, queued.id);
				expect([failed.status, failed.failure?.code]).toEqual([
					"failed",
					"internal",
				]);
				expect(failed.failure?.message).toMatch(/answered 0 results for 2/);
			},
			runner,
		);
	});

	it("counts the jobs ahead, and hides a job whose mission is hidden", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
			const second = await activeMission(h.tx, m.ids);
			await pinTo(h.tx, second, r.pinned);
			await h.tx
				.update(mission)
				.set({ brief: RUNNABLE_PLAN as never })
				.where(eq(mission.id, second.missionId));
			await closedDispatch(h, second, r, {
				"src/c.ts": "export const c = 3;\n",
			});

			const first = await jobOf(await postGate(h, m.missionId), 202);
			const behind = await jobOf(await postGate(h, second.missionId), 202);
			expect([first.ahead, behind.ahead]).toEqual([0, 1]);

			await h.tx
				.update(mission)
				.set({ deletedAt: clock.now() })
				.where(eq(mission.id, second.missionId));
			expect((await h.call(`/api/gate-jobs/${behind.id}`)).status).toBe(404);
			expect(
				(await h.call(`/api/missions/${second.missionId}/gate-runs`)).status,
			).toBe(404);
			expect(
				(await h.call("/api/gate-jobs/00000000-0000-4000-8000-00000000dead"))
					.status,
			).toBe(404);
		});
	});
});
