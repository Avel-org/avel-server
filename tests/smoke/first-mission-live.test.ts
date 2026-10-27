import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	agentTemplateSchema,
	clientSchema,
	connectionSchema,
	dispatch as dispatchWire,
	engagementSchema,
	gateRun as gateRunSchema,
	intakeSchema,
	missionPlanSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import type { ClientId } from "../../src/db/client-id";
import { agentTemplate, canonSession } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { buildSeed, seedIds as seedRowIds } from "../../src/db/seed/data";
import { buildDevTemplateBooking } from "../../src/db/seed/dev-template";
import { memoryBlobs } from "../../src/gateways/blob";
import { dockerAgentRooms } from "../../src/gateways/docker-agent-rooms";
import { dockerCheckRunner } from "../../src/gateways/docker-check-runner";
import { randomIds } from "../../src/lib/ids";
import { DEV_BOOKING_SHA } from "../../src/lib/templates";
import { git } from "../../src/rooms/git";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import { DEFAULT_UPLOAD_MAX_BYTES } from "../../src/routes/files";
import { AgentSdkHarness } from "../../src/runner/agent-sdk-harness";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { runCanonTurn } from "../../src/runner/canon";
import { AgentSdkCanonModel } from "../../src/runner/canon/sdk-model";
import { applyUsage, tick, writeDispatchStep } from "../../src/runner/runner";
import { seedIds } from "../api/agent-fixtures";
import { jobDeps, runGate } from "../api/gate-job-fixtures";
import { reportsOf, row, runnerDeps } from "../api/runner-fixtures";
import { type ApiHarness, clock, withApi } from "../api/support";
import { removeDir, tempDir } from "../unit/git-fixtures";
import { fixtureRepos, snapshotOfCommit } from "../unit/repo-fixtures";
import { BASE_URL, captureLogger } from "../unit/support";

// Checklist item 6: one Canon turn and one dispatch on the real Claude
// Agent SDK, then the gate on the result, over the same API path as
// tests/api/first-mission.test.ts. Spends real money, so it only runs with
// AVEL_LIVE_SMOKE=1 and a key. Run it with --disableConsoleIntercept, or vitest
// hides the cost lines of a passing run. Everything lives in a rolled-back
// transaction on DATABASE_URL. It is a client mission that started from
// the template, as in first-mission.test.ts: the client's clone of
// meridian-co/app is at the template-booking dev fixture's commit, the
// intake reads that commit, and the room opens on it from the client's
// clone (decided 2026-10-21, J). The mission's ceiling is $20; the SDK
// backstops are $1 for Canon and $2 for the dispatch.
//
// With AVEL_CHECK_IMAGE (an image pinned by digest), the gate and the
// agent's run_checks both run on local Docker, and the brief carries a test
// check. The client's clone then has one commit on top of the template: an
// empty package-lock.json, so the runner can install, and a fixed test of
// AC1 on Node's own runner. The agent may write only under
// src/features/scheduling, so it cannot edit that test. Before the
// dispatch, the check is run on the base, where it must fail.

const live =
	process.env.AVEL_LIVE_SMOKE === "1" && !!process.env.ANTHROPIC_API_KEY;

const MODEL = "claude-sonnet-5-5";
const REPO = "https://github.com/meridian-co/app";
const SLOTS = "src/features/scheduling/slots.ts";
const SLOTS_TEST = "tests/unit/slots.test.ts";
const CHECK_IMAGE = process.env.AVEL_CHECK_IMAGE || undefined;
// Set, the dispatch's agent runs in an agent room, as the server runs it.
const AGENT_IMAGE = process.env.AVEL_AGENT_IMAGE || undefined;

/** The client's own commit on the template: what makes CK2 runnable. */
const CLIENT_FILES: Record<string, string> = {
	"package-lock.json": `${JSON.stringify(
		{
			name: "template-booking",
			lockfileVersion: 3,
			requires: true,
			packages: { "": { name: "template-booking" } },
		},
		null,
		"\t",
	)}\n`,
	[SLOTS_TEST]: [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { openSlots } from "../../src/features/scheduling/slots.ts";',
		"",
		'test("AC1: openSlots(8, 3) is 5 and openSlots(8, 9) is 0", () => {',
		"\tassert.equal(openSlots(8, 3), 5);",
		"\tassert.equal(openSlots(8, 9), 0);",
		"});",
		"",
	].join("\n"),
};

// AVEL_LIVE_SLOW_CHECK_S makes CK2 wait that long first, so the agent's
// run_checks call stays open for minutes: does the SDK hold it?
const SLOW_S = Number(process.env.AVEL_LIVE_SLOW_CHECK_S || 0);

const TEST_CHECK = {
	id: "CK2",
	requirementId: "R1",
	kind: "test" as const,
	command: `${SLOW_S > 0 ? `sleep ${SLOW_S} && ` : ""}node --test ${SLOTS_TEST}`,
	note: `The client's test of AC1, ${SLOTS_TEST}, passes. Import with the .ts extension: Node runs the TypeScript directly.`,
};

const NOTES = `# Meridian booking: call notes

## Opening hours
The shop opens at nine and closes at five. Each slot is one hour.

## Booking
A customer picks an open slot and leaves a name and a phone number. No account.

## Cancellation
A customer can cancel up to two hours before the slot, from a link in the confirmation.
`;

const BRIEF = {
	summary: "Online booking for a small shop",
	requirements: [
		{
			id: "R1",
			text: `Add ${SLOTS} exporting openSlots(total: number, taken: number): number, which returns how many slots are left and never less than zero`,
		},
	],
	acceptanceCriteria: [
		{
			id: "AC1",
			requirementId: "R1",
			text: "openSlots(8, 3) returns 5, and openSlots(8, 9) returns 0",
		},
	],
};

const PLAN = {
	...BRIEF,
	modules: [
		{
			id: "M1",
			name: "Scheduling",
			requirementIds: ["R1"],
			reads: ["src/features/scheduling/**"],
		},
	],
	checks: [
		{
			id: "CK1",
			requirementId: "R1",
			kind: "file_exists" as const,
			path: SLOTS,
			note: "The slot module exists",
		},
		...(CHECK_IMAGE ? [TEST_CHECK] : []),
	],
};

const booking = buildSeed(seedRowIds()).playbook.find(
	(p) => p.missionType === "template-booking",
);

let idem = 0;
const key = (h: ApiHarness) =>
	`${h.ns}-0000-4000-b000-${(++idem).toString(16).padStart(12, "0")}`;

async function ok<T>(
	res: Response,
	status: number,
	schema: { parse: (x: unknown) => { data: T } },
): Promise<T> {
	expect(res.status, await res.clone().text()).toBe(status);
	return schema.parse(await res.json()).data;
}

const day = () => new Date().toISOString().slice(0, 10);

describe.skipIf(!live || !process.env.DATABASE_URL)(
	"live: the first mission on the Claude Agent SDK",
	// The preflight, the agent's run_checks and the gate each wait SLOW_S.
	{ timeout: 600_000 + 4 * SLOW_S * 1000 },
	() => {
		const base = tempDir("first-mission-live");
		afterAll(async () => {
			await closeDb();
			// The CLI child can still hold the folder for a moment on Windows.
			try {
				removeDir(base);
			} catch (err) {
				console.log("left behind", base, String(err));
			}
		});

		it("runs a Canon turn, a dispatch and the gate, and prices them", async () => {
			const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
			const sources = path.join(base, "sources");
			expect(
				await buildDevTemplateBooking(
					path.join(sources, "templates", "template-booking"),
				),
			).toBe(DEV_BOOKING_SHA);
			const clientClone = path.join(sources, "repos", "meridian-co", "app");
			expect(await buildDevTemplateBooking(clientClone)).toBe(DEV_BOOKING_SHA);
			for (const [p, text] of Object.entries(CLIENT_FILES)) {
				const file = path.join(clientClone, ...p.split("/"));
				await mkdir(path.dirname(file), { recursive: true });
				await writeFile(file, text);
			}
			await git(["add", "-A"], { cwd: clientClone });
			await git(
				["-c", "commit.gpgsign=false", "commit", "-q", "-m", "Meridian's test"],
				{
					cwd: clientClone,
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "Meridian",
						GIT_AUTHOR_EMAIL: "dev@meridian.invalid",
						GIT_AUTHOR_DATE: "2026-10-22T00:00:00Z",
						GIT_COMMITTER_NAME: "Meridian",
						GIT_COMMITTER_EMAIL: "dev@meridian.invalid",
						GIT_COMMITTER_DATE: "2026-10-22T00:00:00Z",
					},
				},
			);
			const clientSha = (
				await git(["rev-parse", "HEAD"], { cwd: clientClone })
			).trim();
			const checkRunner = CHECK_IMAGE
				? dockerCheckRunner({ image: CHECK_IMAGE, ids: randomIds })
				: null;
			if (checkRunner) {
				// The check fails on the base, before any work: it checks something.
				const [before] = await checkRunner.run({
					source: clientClone,
					commitSha: clientSha,
					checks: [TEST_CHECK],
					shouldStop: () => false,
				});
				console.log(
					"PREFLIGHT",
					before?.outcome,
					before?.exitCode,
					before?.output.slice(-600),
				);
				expect(before?.outcome).toBe("fail");
			}
			const rooms = worktreeRooms(path.join(base, "rooms"));
			const roomSources = localSources(sources);
			const blobs = memoryBlobs();
			const { logger, lines } = captureLogger();
			const harness = new AgentSdkHarness({
				model: MODEL,
				apiKey,
				configDir: path.join(base, "runner-config"),
				ids: randomIds,
				logger,
				clock,
				checkRunner,
				agentRooms: AGENT_IMAGE
					? dockerAgentRooms({ image: AGENT_IMAGE })
					: null,
				maxBudgetUsd: 2,
				maxTurns: 30,
				hostEnv: process.env,
			});
			const canonModel = new AgentSdkCanonModel({
				apiKey,
				configDir: path.join(base, "canon-config"),
				logger,
				maxBudgetUsd: 1,
				maxTurns: 30,
				hostEnv: process.env,
			});

			await withApi(
				async (h) => {
					const cookie = await h.signIn();
					jobDeps(h, roomSources, checkRunner);
					const post = (p: string, body: unknown = {}, headers = {}) =>
						h.call(p, { method: "POST", body, headers });
					const summary: string[] = [];

					const clientId = (
						await ok(
							await post("/api/clients", { name: "Meridian" }),
							201,
							successEnvelope(clientSchema),
						)
					).id;
					const engagementId = (
						await ok(
							await post("/api/engagements", { clientId, name: "Booking" }),
							201,
							successEnvelope(engagementSchema),
						)
					).id;
					const intake = successEnvelope(intakeSchema);

					// 1. One Canon turn, live, on its own draft intake with the notes
					// in the Drive. Canon's template and identity come from the seed's
					// definition, through the regenerate route.
					// Canon has no writable paths, which the create route refuses, so its
					// template is inserted as the seed inserts it.
					const rowIds = seedIds(h.ns);
					const canonTemplateId = rowIds.next();
					await h.tx.insert(agentTemplate).values({
						id: canonTemplateId,
						slug: "canon",
						name: "Canon",
						title: "Project briefer",
						kind: "horizontal",
						roles: ["intake", "strategy"],
						waveDefaults: [],
						writablePaths: [],
						version: 1,
						...stamp(clock),
					});
					const canonRegen = await post(
						`/api/agent-templates/${canonTemplateId}/identity/regenerate`,
					);
					expect(canonRegen.status, await canonRegen.clone().text()).toBe(201);
					const canonIntakeId = (
						await ok(
							await post("/api/intakes", {
								engagementId,
								sourceMd: "Call notes attached.",
							}),
							201,
							intake,
						)
					).id;
					const upload = await h.app.request(
						`/api/intakes/${canonIntakeId}/files?name=${encodeURIComponent("meridian-call.md")}`,
						{
							method: "POST",
							headers: {
								cookie,
								origin: BASE_URL,
								"content-type": "text/markdown",
							},
							body: new TextEncoder().encode(NOTES),
						},
					);
					expect(upload.status, await upload.clone().text()).toBe(201);
					const fileId = ((await upload.json()) as { data: { id: string } })
						.data.id;
					const opened = await post(
						`/api/intakes/${canonIntakeId}/canon-sessions`,
					);
					expect(opened.status, await opened.clone().text()).toBe(201);
					const sessionId = ((await opened.json()) as { data: { id: string } })
						.data.id;
					const asked = await post(
						`/api/canon-sessions/${sessionId}/messages`,
						{
							contentMd:
								"Draft the brief from the attached call notes, and cite the notes for every requirement.",
						},
					);
					expect(asked.status, await asked.clone().text()).toBe(202);
					// This session's turn only. canonTick would run every open
					// session the database holds, on the real model.
					const turns = [
						await runCanonTurn(
							{
								db: () => h.tx,
								clock,
								ids: randomIds,
								prices: DEFAULT_PRICE_BOOK,
								blobs,
								model: canonModel,
								logger,
							},
							{ kind: "client", clientId: clientId as ClientId },
							sessionId,
						),
					];
					const messages = (
						(await (
							await h.call(`/api/canon-sessions/${sessionId}/messages`)
						).json()) as {
							data: Array<{
								role: string;
								contentMd: string;
								citations: Array<{
									fileId: string;
									chunkId: string;
									quote: string;
								}>;
							}>;
						}
					).data;
					const reply = messages.find((m) => m.role === "canon");
					const citations = reply?.citations ?? [];
					const resolved = citations.filter(
						(c) => c.fileId === fileId && NOTES.includes(c.quote),
					);
					// The brief's own sources (instructions v3): every requirement and
					// criterion should stand on a passage of the uploaded notes.
					const drafted = (
						(await (await h.call(`/api/intakes/${canonIntakeId}`)).json()) as {
							data: {
								proposedBrief: {
									requirements: Array<{
										id: string;
										sources?: Array<{ chunkId: string }>;
									}>;
									acceptanceCriteria: Array<{
										id: string;
										sources?: Array<{ chunkId: string }>;
									}>;
								} | null;
							};
						}
					).data.proposedBrief;
					const notesSha = createHash("sha256").update(NOTES).digest("hex");
					const items = [
						...(drafted?.requirements ?? []),
						...(drafted?.acceptanceCriteria ?? []),
					];
					const unsourced = items
						.filter((i) => (i.sources ?? []).length === 0)
						.map((i) => i.id);
					const foreign = items.flatMap((i) =>
						(i.sources ?? [])
							.map((c) => c.chunkId)
							.filter((c) => !c.startsWith(`${notesSha}:`)),
					);
					const [cs] = await h.tx
						.select()
						.from(canonSession)
						.where(eq(canonSession.id, sessionId));
					console.log(
						"CANON",
						JSON.stringify(
							{
								outcomes: turns.map((t) => t.outcome),
								reply: reply?.contentMd.slice(0, 600),
								citations: citations.length,
								resolved: resolved.length,
								briefItems: items.length,
								unsourced,
								foreign,
							},
							null,
							2,
						),
					);
					summary.push(
						`${day()} · first-mission-live · item-6 · canon · ${cs?.model} · ${cs?.tokensIn} · ${cs?.tokensOut} · ${cs?.spendUsd} · ${turns.map((t) => t.outcome).join(",")}; ${resolved.length}/${citations.length} citations resolve to the Drive file`,
					);
					// A failed turn's reason is only in the log; print it.
					for (const l of lines.filter((l) => Number(l.level) >= 50))
						console.log("CANON ERROR", l.msg, l.err);
					expect(turns.map((t) => t.outcome)).toEqual(["replied"]);
					// Every citation that came back names the uploaded file and quotes it.
					// With none at all that holds vacuously, so require one: on
					// 2026-10-21 the reply cited the notes in prose and returned none.
					expect(citations.length, "no citations came back").toBeGreaterThan(0);
					expect(resolved).toEqual(citations);
					expect(items.length, "no brief was drafted").toBeGreaterThan(0);
					expect(unsourced, "brief items with no source").toEqual([]);
					expect(foreign, "sources outside the notes").toEqual([]);

					// 2. The mission, as in tests/api/first-mission.test.ts.
					const intakeId = (
						await ok(
							await post("/api/intakes", {
								engagementId,
								sourceMd: NOTES,
								proposedBrief: BRIEF,
							}),
							201,
							intake,
						)
					).id;
					const connectionId = (
						await ok(
							await post("/api/connections", {
								engagementId,
								label: "Meridian",
								scopeType: "owner",
								scopeValue: "meridian-co",
								credentialRef: "MERIDIAN_GITHUB_TOKEN",
							}),
							201,
							successEnvelope(connectionSchema),
						)
					).id;
					const read = await ok(
						await post(`/api/intakes/${intakeId}/read-repo`, {
							connectionId,
							repoUrl: REPO,
						}),
						200,
						intake,
					);
					expect(read.repoCommitSha).toBe(clientSha);
					await ok(await post(`/api/intakes/${intakeId}/propose`), 200, intake);
					const approved = await ok(
						await post(`/api/intakes/${intakeId}/approve`, {
							missionType: "template-booking",
							repoUrl: REPO,
							spendCeilingUsd: 20,
						}),
						200,
						intake,
					);
					const missionId = approved.missionId as string;
					const plan = await ok(
						await h.call(`/api/missions/${missionId}/plan`, {
							method: "PUT",
							body: {
								brief: PLAN,
								templateRef: "template-booking",
								templateVersion: DEV_BOOKING_SHA,
							},
						}),
						200,
						successEnvelope(missionPlanSchema),
					);
					expect(plan.check).toEqual({ passed: true, issues: [] });

					const templateId = (
						await ok(
							await post("/api/agent-templates", {
								slug: `atlas-${h.ns}`,
								name: "Atlas",
								title: "Scheduling builder",
								kind: "feature",
								roles: ["domain", "api-surface"],
								waveDefaults: ["A"],
								writablePaths: ["src/features/scheduling/**"],
							}),
							201,
							successEnvelope(agentTemplateSchema),
						)
					).id;
					const regen = await post(
						`/api/agent-templates/${templateId}/identity/regenerate`,
					);
					expect(regen.status, await regen.clone().text()).toBe(201);
					const presetRes = await post("/api/presets", {
						name: `Booking ${h.ns}`,
						cut: "vertical",
						agents: [
							{
								agentTemplateId: templateId,
								waves: ["A"],
								territory: "scheduling",
								writablePaths: null,
								estimatedTokens: 150_000,
							},
						],
					});
					expect(presetRes.status, await presetRes.clone().text()).toBe(201);
					const presetId = (
						(await presetRes.json()) as { data: { id: string } }
					).data.id;
					const book = await post("/api/playbooks", {
						missionType: "template-booking",
						name: booking?.name,
						wavesApplicable: booking?.wavesApplicable,
						gates: booking?.gates,
						deliverable: booking?.deliverable,
						requiredFields: booking?.requiredFields,
						defaultPresetId: presetId,
					});
					expect(book.status, await book.clone().text()).toBe(201);
					const applied = await post(
						`/api/missions/${missionId}/roster/apply-preset`,
						{ presetId },
					);
					expect(applied.status, await applied.clone().text()).toBe(200);
					const entries = (
						(await (
							await h.call(`/api/missions/${missionId}/roster`)
						).json()) as { data: Array<{ id: string }> }
					).data;
					const started = await post(`/api/missions/${missionId}/start`);
					expect(started.status, await started.clone().text()).toBe(200);

					// 3. One dispatch on the real harness. The ceilings are the 9e
					// smoke's: the cached system prompt alone is ~4k tokens, and 9e's
					// complete run used 13k in. The SDK's $2 backstop sits under them.
					const deps = runnerDeps(h, harness, DEFAULT_PRICE_BOOK, clock, {
						rooms,
						roomSources,
					});
					harness.bindAgentApi(async (req) => h.app.fetch(req));
					harness.bindUsageSink((id, split) => applyUsage(deps, id, split));
					harness.bindStepSink((id, step) => writeDispatchStep(deps, id, step));
					const one = successEnvelope(dispatchWire);
					const queued = await ok(
						await post(
							`/api/missions/${missionId}/dispatches`,
							{
								rosterEntryId: entries[0]?.id,
								briefRef: { moduleId: "M1", requirementIds: ["R1"] },
								estimatedTokens: 150_000,
								tokenSoftCeiling: 300_000,
								tokenHardCeiling: 600_000,
							},
							{ "idempotency-key": key(h) },
						),
						201,
						one,
					);
					const t0 = Date.now();
					const running = await ok(
						await post(`/api/dispatches/${queued.id}/start`),
						200,
						one,
					);
					expect(running.status).toBe("running");
					const room = await rooms.get(queued.id);
					expect(room?.repoPath).toBe(clientClone);
					expect(room?.commit).toBe(read.repoCommitSha);
					await harness.settled(queued.id);
					await tick(deps);
					const d = await row(h.tx, queued.id);
					const [report] = await reportsOf(h.tx, queued.id);
					console.log(
						"DISPATCH",
						JSON.stringify(
							{
								seconds: Math.round((Date.now() - t0) / 1000),
								status: d.status,
								model: d.model,
								harnessVersion: d.harnessVersion,
								priceVersion: d.priceVersion,
								tokensIn: d.tokensIn,
								tokensOut: d.tokensOut,
								cacheReadTokens: d.cacheReadTokens,
								cacheWriteTokens: d.cacheWriteTokens,
								spendUsd: d.spendUsd,
								report: report && {
									status: report.status,
									filedBy: report.filedBy,
									artifactsWritten: report.artifactsWritten,
									blockers: report.blockers,
								},
							},
							null,
							2,
						),
					);
					// Whether the agent used run_checks, and what came back.
					const steps = (
						(await (
							await h.call(`/api/dispatches/${queued.id}/steps`)
						).json()) as {
							data: Array<{
								kind: string;
								detail: { tool?: string; isError?: boolean; text?: string };
							}>;
						}
					).data;
					const checkSteps = steps.filter(
						(s) =>
							(s.kind === "tool_call" || s.kind === "tool_result") &&
							s.detail.tool === "run_checks",
					);
					// The whole tool sequence, so no run_checks call reads apart
					// from no steps at all.
					console.log(
						"TOOLS",
						steps.length,
						JSON.stringify(
							steps
								.filter((s) => s.kind === "tool_call")
								.map((s) => s.detail.tool),
						),
					);
					console.log(
						"RUN_CHECKS",
						JSON.stringify(
							checkSteps.map((s) => ({
								kind: s.kind,
								isError: s.detail.isError,
								text: s.detail.text?.slice(0, 800),
							})),
							null,
							2,
						),
					);
					summary.push(
						`${day()} · first-mission-live · item-6 · atlas · ${d.model} · ${d.tokensIn} · ${d.tokensOut} · ${d.spendUsd} · ${d.status}; report by ${report?.filedBy ?? "none"}, cache read ${d.cacheReadTokens}, cache write ${d.cacheWriteTokens}`,
					);

					// 4. The gate on the result: queued, then run by the gate tick.
					const gateRes = await runGate(h, missionId);
					const gateText = await gateRes.clone().text();
					console.log("GATE", gateRes.status, gateText.slice(0, 4000));
					console.log(`SUMMARY\n${summary.join("\n")}`);
					console.log(
						"LOG",
						JSON.stringify(
							lines.map(({ msg, level, err, subtype, total_cost_usd }) => ({
								level,
								msg,
								err,
								subtype,
								total_cost_usd,
							})),
							null,
							1,
						),
					);
					expect(d.status).toBe("complete");
					const where = lines
						.filter((l) => l.msg === "agent session started")
						.map((l) => (l as { process?: string }).process);
					console.log("PROCESS", JSON.stringify(where));
					expect(where).toEqual([AGENT_IMAGE ? "container" : "host"]);
					// The server binds the step sink (src/runner/wiring.ts); an empty
					// trace here means this test did not.
					expect(steps.length, "no steps were written").toBeGreaterThan(0);
					const run = await ok(gateRes, 200, successEnvelope(gateRunSchema));
					console.log(
						"RESULT",
						run.result,
						JSON.stringify(run.gates.map((g) => [g.gate, g.result])),
						run.receiptSha256,
						run.commitSha,
					);
					expect(run.baseSha).toBe(read.repoCommitSha);
					expect(run.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
					expect(
						run.reasons.find((r) => r.source === "file_exists"),
					).toMatchObject({ effect: "pass" });
					if (checkRunner) {
						const receipt = JSON.parse(run.receipt);
						const ck2 = receipt.findings.find(
							(f: { id: string }) => f.id === "check:CK2:1",
						);
						console.log("CK2", ck2?.outcome, ck2?.subject, receipt.runner);
						expect(ck2?.outcome).toBe("pass");
					}
				},
				{
					harness,
					rooms,
					roomSources,
					repos: fixtureRepos({
						"meridian-co/app": snapshotOfCommit(clientClone, clientSha),
					}),
					checkRunner: checkRunner ?? undefined,
					drive: { blobs, maxBytes: DEFAULT_UPLOAD_MAX_BYTES },
				},
			);
		});
	},
);
