import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Brief, briefSchema } from "../../src/contract/intake";
import { lsTreeBlobs, matchReads, readMatches } from "../../src/rooms/read-set";
import {
	type BriefInput,
	briefSha256,
	READ_LIST_CAP,
	readSetSha256,
	renderBrief,
} from "../../src/runner/brief";

const PLAN: Brief = briefSchema.parse({
	summary: "Booking for a clinic",
	requirements: [
		{ id: "R1", text: "Patients book a slot" },
		{ id: "R2", text: "Staff cancel a slot" },
		{ id: "R3", text: "Reminders go out" },
	],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "A booked slot is held" },
		{ id: "AC2", requirementId: "R2", text: "A cancelled slot frees up" },
		{ id: "AC3", requirementId: "R1", text: "A full day refuses" },
		{ id: "AC4", requirementId: "R3", text: "A reminder is sent" },
	],
	modules: [
		{
			id: "M1",
			name: "Slots",
			requirementIds: ["R1", "R2"],
			reads: ["src/slots", "docs/missing.md"],
		},
		{ id: "M2", name: "Reminders", requirementIds: ["R3"] },
	],
	checks: [
		{
			id: "CK1",
			requirementId: "R1",
			kind: "test",
			command: "pnpm test slots",
		},
		{
			id: "CK2",
			requirementId: "R2",
			kind: "file_exists",
			path: "src/slots/cancel.ts",
			note: "The cancel handler.",
		},
		{ id: "CK3", requirementId: "R3", kind: "command", command: "pnpm remind" },
		{ id: "CK4", requirementId: "R1", kind: "typecheck", command: "pnpm tsc" },
	],
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const input = (over: Partial<BriefInput> = {}): BriefInput => ({
	plan: PLAN,
	ref: { moduleId: "M1", requirementIds: ["R1", "R2"] },
	commit: "c".repeat(40),
	reads: [
		{
			read: "src/slots",
			files: [
				{ path: "src/slots/book.ts", blobSha: SHA_A },
				{ path: "src/slots/cancel.ts", blobSha: SHA_B },
			],
		},
		{ read: "docs/missing.md", files: [] },
	],
	sourceMd: "# The ask\n\nBook slots.",
	skills: [
		{ slug: "drizzle", name: "Drizzle", description: "Schema work.\nMore." },
	],
	...over,
});

/** The section's lines between its heading and the next ## heading. */
function section(md: string, heading: string): string {
	const after = md.split(`\n## ${heading}\n`)[1];
	if (after === undefined) throw new Error(`no ${heading}`);
	return after.split("\n## ")[0] as string;
}

describe("renderBrief", () => {
	it("renders the four parts in order, deterministically", () => {
		const md = renderBrief(input());
		expect(md).toBe(renderBrief(input()));
		expect(md.startsWith("# M1: Slots\n\nBooking for a clinic\n")).toBe(true);
		const at = ["## Scope", "## Read", "## Method", "## Done when"].map((h) =>
			md.indexOf(`\n${h}\n`),
		);
		expect(at.every((i) => i > 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		expect(md.endsWith("\n")).toBe(true);
		expect(md.endsWith("\n\n")).toBe(false);
	});

	it("scopes to the ref's requirements, with their criteria in plan order", () => {
		const scope = section(renderBrief(input()), "Scope");
		expect(scope).toContain(
			"### R1\n\nPatients book a slot\n\n- AC1: A booked slot is held\n- AC3: A full day refuses\n",
		);
		expect(scope).toContain(
			"### R2\n\nStaff cancel a slot\n\n- AC2: A cancelled slot frees up\n",
		);
		expect(scope).not.toContain("R3");
		expect(scope).not.toContain("AC4");
		// The ref's order, not the plan's.
		const reversed = section(
			renderBrief(
				input({ ref: { moduleId: "M1", requirementIds: ["R2", "R1"] } }),
			),
			"Scope",
		);
		expect(reversed.indexOf("### R2")).toBeLessThan(reversed.indexOf("### R1"));
	});

	it("lists only the checks of the ref's requirements, in plan order", () => {
		const done = section(renderBrief(input()), "Done when");
		expect(done.match(/^- .*$/gm)).toEqual([
			"- CK1 (R1, test): `pnpm test slots` passes.",
			"- CK2 (R2, file_exists): `src/slots/cancel.ts` exists. The cancel handler.",
			"- CK4 (R1, typecheck): `pnpm tsc` passes.",
		]);
	});

	it("reads each path at the commit with its blob sha, and says when one matches nothing", () => {
		const read = section(renderBrief(input()), "Read");
		expect(read).toContain(`Repository paths at commit \`${"c".repeat(40)}\`.`);
		expect(read.match(/^ *- .*$/gm)).toEqual([
			"- `src/slots`: 2 files",
			`  - \`src/slots/book.ts\` ${SHA_A}`,
			`  - \`src/slots/cancel.ts\` ${SHA_B}`,
			"- `docs/missing.md`: matches nothing at this commit",
		]);
		expect(read).toContain(`Read set sha256: ${readSetSha256(input().reads)}`);
	});

	it("carries the client source whole, under a fence its backticks cannot close", () => {
		const sourceMd = "# Ask\n\n```ts\nconst a = 1;\n```\n\nEnd.";
		const read = section(renderBrief(input({ sourceMd })), "Read");
		const sha = createHash("sha256").update(sourceMd, "utf8").digest("hex");
		expect(read).toContain(
			`sha256: ${sha}\n\n\`\`\`\`markdown\n${sourceMd}\n\`\`\`\`\n`,
		);
		expect(section(renderBrief(input({ sourceMd: null })), "Read")).toContain(
			"The mission has no client source.",
		);
	});

	it("lists each skill by slug with the first line of its description", () => {
		expect(section(renderBrief(input()), "Method")).toContain(
			"- `drizzle`, Drizzle: Schema work.\n",
		);
		expect(section(renderBrief(input({ skills: [] })), "Method")).toContain(
			"No stack or domain skills apply.",
		);
	});

	it("says so when the module reads nothing, with no read set hash", () => {
		const read = section(renderBrief(input({ reads: [] })), "Read");
		expect(read).toContain("The module names no repository paths.");
		expect(read).not.toContain("Read set sha256");
	});

	it("lists at most READ_LIST_CAP files, and the read set hash still covers the rest", () => {
		const many = (n: number, sha: string) =>
			Array.from({ length: n }, (_, i) => ({
				path: `src/f${String(i).padStart(4, "0")}.ts`,
				blobSha: sha,
			}));
		const reads = [
			{ read: "src", files: many(READ_LIST_CAP - 1, SHA_A) },
			{ read: "lib", files: many(3, SHA_A) },
		];
		const md = renderBrief(input({ reads }));
		expect(md.match(/^ {2}- `/gm)).toHaveLength(READ_LIST_CAP);
		expect(md).toContain("  - and 2 more, not listed\n");
		// An unlisted file's blob changes the hash.
		const changed = structuredClone(reads);
		(changed[1]?.files[2] as { blobSha: string }).blobSha = SHA_B;
		expect(briefSha256(renderBrief(input({ reads: changed })))).not.toBe(
			briefSha256(md),
		);
	});

	it("hashes the text: any change to an input changes briefSha256", () => {
		const base = briefSha256(renderBrief(input()));
		expect(base).toBe(
			createHash("sha256").update(renderBrief(input()), "utf8").digest("hex"),
		);
		const variants: Array<Partial<BriefInput>> = [
			{ commit: "d".repeat(40) },
			{ sourceMd: "# Another ask" },
			{ skills: [] },
			{
				reads: [
					{
						read: "src/slots",
						files: [{ path: "src/slots/book.ts", blobSha: SHA_B }],
					},
				],
			},
		];
		for (const v of variants) {
			expect(briefSha256(renderBrief(input(v)))).not.toBe(base);
		}
	});

	it("throws on a module or requirement the plan does not hold", () => {
		expect(() =>
			renderBrief(input({ ref: { moduleId: "M9", requirementIds: ["R1"] } })),
		).toThrow(/no module M9/);
		expect(() =>
			renderBrief(input({ ref: { moduleId: "M1", requirementIds: ["R7"] } })),
		).toThrow(/no requirement R7/);
	});
});

describe("read matching", () => {
	it("matches a directory's contents, a glob, and never a sibling with the same prefix", () => {
		expect(readMatches("src/db/a.ts", "src/db")).toBe(true);
		expect(readMatches("src/db/a.ts", "src/db/")).toBe(true);
		expect(readMatches("src/dbx/a.ts", "src/db")).toBe(false);
		expect(readMatches("src/db/a.ts", "src/*/a.ts")).toBe(true);
		expect(readMatches("README.md", "README.md")).toBe(true);
		expect(readMatches("README.md.bak", "README.md")).toBe(false);
	});

	it("keeps the reads' order and each read's files", () => {
		const files = [
			{ path: "a/x.ts", blobSha: SHA_A },
			{ path: "b/y.ts", blobSha: SHA_B },
		];
		expect(matchReads(files, ["b", "a", "c"])).toEqual([
			{ read: "b", files: [files[1]] },
			{ read: "a", files: [files[0]] },
			{ read: "c", files: [] },
		]);
	});
});

describe("lsTreeBlobs", () => {
	it("keeps blobs sorted by path, and drops symlinks and submodules", () => {
		const listing = [
			`100644 blob ${SHA_B}	src/z.ts`,
			`100755 blob ${SHA_A}	bin/run`,
			`120000 blob ${SHA_A}	src/link`,
			`160000 commit ${SHA_B}	vendor/lib`,
			`100644 blob ${SHA_A}	src/with space.ts`,
			"",
		].join(" ");
		expect(lsTreeBlobs(listing)).toEqual([
			{ path: "bin/run", blobSha: SHA_A },
			{ path: "src/with space.ts", blobSha: SHA_A },
			{ path: "src/z.ts", blobSha: SHA_B },
		]);
	});
});
