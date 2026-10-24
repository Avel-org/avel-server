import { describe, expect, it } from "vitest";
import {
	COMPLETION_STATUSES,
	completionReport,
	DISPATCH_STATUSES,
	dispatch,
	HALT_REASONS,
	PRECONDITION_REASONS,
} from "../../src/contract";
import {
	completionStatus as completionStatusEnum,
	haltReason as haltReasonEnum,
} from "../../src/db/schema";

const sha = (c: string) => c.repeat(64);
const at = "2026-10-13T12:00:00.000Z";

const queued = {
	id: "00000000-0000-4000-8000-000000000001",
	missionId: "00000000-0000-4000-8000-000000000002",
	rosterEntryId: "00000000-0000-4000-8000-000000000003",
	agent: {
		templateId: "00000000-0000-4000-8000-000000000004",
		slug: "kel",
		name: "Kel",
		title: "Schema",
	},
	territory: null,
	briefRef: { moduleId: "M1", requirementIds: ["R1"] },
	status: "queued",
	haltReason: null,
	estimatedTokens: 1000,
	tokenSoftCeiling: 1500,
	tokenHardCeiling: 3000,
	softCeilingCrossed: false,
	tokensUsed: 0,
	tokensIn: 0,
	tokensOut: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	spendUsd: 0,
	wallClockMinutes: 60,
	agentVersionSha256: null,
	agentVersionRef: null,
	skillsSha256: null,
	briefSha256: null,
	startCommitSha: null,
	startDispatchIds: null,
	model: null,
	harnessVersion: null,
	reportId: null,
	startedAt: null,
	closedAt: null,
	createdAt: at,
	updatedAt: at,
};

const report = {
	id: "00000000-0000-4000-8000-000000000005",
	dispatchId: queued.id,
	missionId: queued.missionId,
	rosterEntryId: queued.rosterEntryId,
	status: "halted",
	haltReason: "operator",
	softCeilingCrossed: true,
	actualTokens: 2000,
	agentVersionSha256: sha("a"),
	agentVersionRef: "kel@v2",
	skillsSha256: sha("b"),
	versionSource: "recorded",
	model: "claude-sonnet-5-5",
	artifactsRead: [{ path: "docs/schema.md", sha256: sha("c") }],
	artifactsWritten: [],
	filesTouched: 0,
	fileTypesTouched: [],
	rereads: 0,
	blockers: [],
	edgeMismatches: [
		{
			path: "docs/schema.md",
			readSha256: sha("c"),
			writtenSha256: sha("d"),
			producerDispatchId: "00000000-0000-4000-8000-000000000006",
		},
	],
	filedBy: "system",
	createdAt: at,
};

describe("dispatch vocabulary", () => {
	it("ends a dispatch only in a status a report can record", () => {
		expect(
			DISPATCH_STATUSES.filter((s) => s !== "queued" && s !== "running"),
		).toEqual([...COMPLETION_STATUSES]);
	});

	it("builds the report pgEnums from the contract arrays", () => {
		expect(haltReasonEnum.enumValues).toEqual([...HALT_REASONS]);
		expect(completionStatusEnum.enumValues).toEqual([...COMPLETION_STATUSES]);
	});

	it("lets an operator stop be told apart from a ceiling", () => {
		expect(HALT_REASONS).toContain("operator");
	});

	it("lists every precondition reason once", () => {
		expect(new Set(PRECONDITION_REASONS).size).toBe(
			PRECONDITION_REASONS.length,
		);
	});
});

describe("dispatch wire", () => {
	it("takes a queued dispatch", () => {
		expect(dispatch.parse(queued)).toEqual(queued);
	});

	it("never carries the token or its hash, even when a row has them", () => {
		const out = dispatch.parse({
			...queued,
			token: "secret",
			tokenSha256: sha("e"),
			idempotencyKey: "k",
		});
		expect(Object.keys(out)).not.toContain("token");
		expect(Object.keys(out)).not.toContain("tokenSha256");
		expect(Object.keys(out)).not.toContain("idempotencyKey");
	});

	it("refuses an unknown status or halt reason", () => {
		expect(dispatch.safeParse({ ...queued, status: "paused" }).success).toBe(
			false,
		);
		expect(
			dispatch.safeParse({ ...queued, status: "halted", haltReason: "tired" })
				.success,
		).toBe(false);
	});

	it("refuses a frozen version hash that is not lowercase hex SHA-256", () => {
		expect(
			dispatch.safeParse({ ...queued, agentVersionSha256: sha("A") }).success,
		).toBe(false);
		expect(
			dispatch.safeParse({ ...queued, briefSha256: sha("A") }).success,
		).toBe(false);
	});

	it("takes a started dispatch with its brief hash and harness", () => {
		const started = {
			...queued,
			briefSha256: sha("c"),
			harnessVersion: "claude-agent-sdk@1.0.0",
		};
		expect(dispatch.parse(started)).toEqual(started);
	});
});

describe("completion report wire", () => {
	it("takes a runner-filed halted report with an edge mismatch", () => {
		expect(completionReport.parse(report)).toEqual(report);
	});

	it("is filed by the agent or the runner, never the operator", () => {
		expect(
			completionReport.safeParse({ ...report, filedBy: "operator" }).success,
		).toBe(false);
	});

	it("refuses a queued or running status", () => {
		for (const status of ["queued", "running"]) {
			expect(completionReport.safeParse({ ...report, status }).success).toBe(
				false,
			);
		}
	});
});
