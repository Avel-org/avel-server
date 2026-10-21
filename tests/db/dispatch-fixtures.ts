import type { DispatchStatus } from "../../src/contract/shared/status";
import type { NewDispatch } from "../../src/db/dispatch";
import {
	agentIdentityVersion,
	agentTemplate,
	type completionReport,
	dispatch,
	rosterEntry,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import type { IdGenerator } from "../../src/lib/ids";
import { PRICE_VERSION } from "../../src/lib/prices";
import { clock } from "./fixtures";

export const sha = (c: string) => c.repeat(64);

/**
 * The plan dispatchValues' briefRef points into: module M6 lists R1 and R2,
 * and each has a check outside the agent, so start's requirement_unchecked
 * passes.
 */
export const DISPATCH_PLAN = {
	summary: "Accounts",
	requirements: [
		{ id: "R1", text: "Sign up" },
		{ id: "R2", text: "Sign in" },
	],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "Signing up works" },
		{ id: "AC2", requirementId: "R2", text: "Signing in works" },
	],
	modules: [
		{ id: "M6", name: "Accounts", requirementIds: ["R1", "R2"], reads: [] },
	],
	checks: [
		{ id: "CK1", requirementId: "R1", kind: "test", command: "pnpm test R1" },
		{ id: "CK2", requirementId: "R2", kind: "test", command: "pnpm test R2" },
	],
};

export type SeededAgent = {
	missionId: string;
	templateId: string;
	entryId: string;
	versionId: string;
	versionSha: string;
	slug: string;
};

/**
 * A template with identity versions 1 and 2, on the mission's roster.
 * version is the second, so its display ref is `<slug>@v2`.
 */
export async function seedAgent(
	tx: Tx,
	ids: IdGenerator,
	missionId: string,
	name = "Kel",
): Promise<SeededAgent> {
	const templateId = ids.next();
	// The whole id: its last block alone repeats in every caller, and slugs are
	// unique, so concurrent tests waited on each other's uncommitted rows.
	const slug = `${name.toLowerCase()}-${templateId.replaceAll("-", "")}`;
	await tx.insert(agentTemplate).values({
		id: templateId,
		slug,
		name,
		title: "Backend builder",
		kind: "horizontal",
		roles: ["domain", "api-surface"],
		waveDefaults: ["B"],
		writablePaths: ["src/**"],
		version: 1,
		...stamp(clock),
	});
	let versionId = "";
	for (const [number, c] of [
		[1, "c"],
		[2, "d"],
	] as const) {
		versionId = ids.next();
		await tx.insert(agentIdentityVersion).values({
			id: versionId,
			agentTemplateId: templateId,
			number,
			identityMd: `# ${slug} v${number}\n`,
			depthMd: "",
			sha256: sha(c),
			identityTokens: 1,
			depthTokens: 0,
			inputs: {
				generatorVersion: "identity-v1",
				slug,
				name,
				kind: "horizontal",
				roles: ["domain", "api-surface"],
				writablePaths: ["src/**"],
				definitionsSha256: sha("e"),
				skills: [],
			},
			generatedBy: null,
			createdAt: clock.now(),
		});
	}
	const entryId = ids.next();
	await tx.insert(rosterEntry).values({
		id: entryId,
		missionId,
		agentTemplateId: templateId,
		active: true,
		waves: ["B"],
		territory: "accounts",
		grain: "default",
		absorbedBoundaries: [],
		...stamp(clock),
	});
	return {
		missionId,
		templateId,
		entryId,
		versionId,
		versionSha: sha("d"),
		slug,
	};
}

const ENDED: readonly DispatchStatus[] = [
	"complete",
	"blocked",
	"failed",
	"halted",
];

/** A dispatch in `status` that satisfies every CHECK. */
export function dispatchValues(
	agent: SeededAgent,
	ids: IdGenerator,
	status: DispatchStatus,
	over: Partial<NewDispatch> = {},
): NewDispatch {
	const started = status !== "queued";
	return {
		rosterEntryId: agent.entryId,
		missionId: agent.missionId,
		briefRef: { moduleId: "M6", requirementIds: ["R1", "R2"] },
		status,
		haltReason: status === "halted" ? "token_hard_ceiling" : null,
		estimatedTokens: 1000,
		tokenSoftCeiling: 1500,
		tokenHardCeiling: 3000,
		tokensUsed: started ? 100 : 0,
		tokensIn: started ? 40 : 0,
		tokensOut: started ? 30 : 0,
		cacheReadTokens: started ? 20 : 0,
		cacheWriteTokens: started ? 10 : 0,
		softCeilingCrossed: false,
		spendUsd: "0",
		wallClockMinutes: 60,
		agentIdentityVersionId: started ? agent.versionId : null,
		agentVersionSha256: started ? agent.versionSha : null,
		skillsSha256: started ? sha("b") : null,
		model: started ? "fake-harness" : null,
		priceVersion: started ? PRICE_VERSION : null,
		tokenSha256: null,
		idempotencyKey: `start-${ids.next()}`,
		requestSha256: sha("5"),
		startedAt: started ? clock.now() : null,
		closedAt: ENDED.includes(status) ? clock.now() : null,
		...over,
	};
}

export async function insertDispatchRow(
	tx: Tx,
	ids: IdGenerator,
	values: NewDispatch,
): Promise<string> {
	const id = ids.next();
	await tx.insert(dispatch).values({ id, ...values, ...stamp(clock) });
	return id;
}

/** A complete report for a dispatch, with every required column. */
export function reportValues(
	ids: IdGenerator,
	d: { id: string; missionId: string; rosterEntryId: string },
	over: Partial<typeof completionReport.$inferInsert> = {},
): typeof completionReport.$inferInsert {
	return {
		id: ids.next(),
		dispatchId: d.id,
		missionId: d.missionId,
		rosterEntryId: d.rosterEntryId,
		status: "complete",
		haltReason: null,
		softCeilingCrossed: false,
		actualTokens: 100,
		agentVersionSha256: sha("d"),
		skillsSha256: sha("b"),
		versionSource: "recorded",
		model: "fake-harness",
		artifactsRead: [{ path: "src/contract/dispatch.ts", sha256: sha("1") }],
		artifactsWritten: [{ path: "src/db/dispatch.ts", sha256: sha("2") }],
		filesTouched: 2,
		fileTypesTouched: ["ts"],
		rereads: 1,
		blockers: [
			{
				description: "No price table",
				workaround: "Priced at zero",
				provisioning_gap: true,
			},
		],
		edgeMismatches: [
			{
				path: "src/contract/dispatch.ts",
				read_sha256: sha("1"),
				written_sha256: sha("3"),
				producer_dispatch_id: d.id,
			},
		],
		filedBy: "agent",
		...stamp(clock),
		...over,
	};
}
