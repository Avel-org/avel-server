import { describe, expect, it } from "vitest";
import {
	KNOWLEDGE_SPLIT_VERSION,
	splitKnowledge,
	toSearchResultBlocks,
} from "../../../src/lib/canon";
import { canonicalJson } from "../../../src/lib/canonical";
import { sha256Hex } from "../../../src/lib/tokens";
import {
	buildCanonPrompt,
	CANON_INSTRUCTIONS,
	CANON_INSTRUCTIONS_VERSION,
	type CanonPromptInput,
} from "../../../src/runner/canon";

const SHA = "a".repeat(64);

const input = (over: Partial<CanonPromptInput> = {}): CanonPromptInput => ({
	identityMd: "# Canon\nYou brief projects.\n",
	files: [
		{
			fileId: "f1",
			sha256: SHA,
			name: "brief.md",
			contentMd: "# Booking\nClients book a slot.\n## Rules\nOne per hour.",
		},
	],
	memory: ["Meridian prefers Stripe.", "Meridian's salons open at 9."],
	messages: [
		{ seq: 2, role: "canon", contentMd: "Reading it." },
		{ seq: 1, role: "operator", contentMd: "Here is the salon brief." },
		{ seq: 3, role: "operator", contentMd: "Draft it, please." },
	],
	...over,
});

describe("buildCanonPrompt", () => {
	it("is Canon's identity, then the versioned instructions", () => {
		const { prompt } = buildCanonPrompt(input());
		expect(prompt.system).toBe(
			`# Canon\nYou brief projects.\n\n${CANON_INSTRUCTIONS}`,
		);
		expect(prompt.instructionsVersion).toBe(CANON_INSTRUCTIONS_VERSION);
		expect(CANON_INSTRUCTIONS_VERSION).toBe(1);
		expect(prompt.splitVersion).toBe(KNOWLEDGE_SPLIT_VERSION);
	});

	it("tells Canon to draft the intake shape, ask instead of guessing, cite, and leave the cut alone", () => {
		for (const phrase of [
			"draft_brief",
			"summary",
			"requirements",
			"acceptance criteria",
			"no modules",
			"ask_operator",
			"instead of guessing",
			"Cite",
			"never choose the cut",
		]) {
			expect(CANON_INSTRUCTIONS, phrase).toContain(phrase);
		}
	});

	it("puts the files in as search results, split by heading", () => {
		const files = input().files;
		const { prompt, chunks } = buildCanonPrompt(input());
		expect(chunks).toEqual(splitKnowledge(files));
		expect(prompt.knowledge).toEqual(
			toSearchResultBlocks(splitKnowledge(files)),
		);
		expect(prompt.knowledge.map((b) => b.title)).toEqual([
			"brief.md > Booking",
			"brief.md > Booking > Rules",
		]);
		expect(buildCanonPrompt(input({ files: [] })).prompt.knowledge).toEqual([]);
	});

	it("keeps the memory as given and the conversation in seq order", () => {
		const { prompt } = buildCanonPrompt(input());
		expect(prompt.memory).toEqual(input().memory);
		expect(prompt.transcript).toEqual([
			{ role: "operator", contentMd: "Here is the salon brief." },
			{ role: "canon", contentMd: "Reading it." },
			{ role: "operator", contentMd: "Draft it, please." },
		]);
	});

	it("hashes the whole prompt, so any change to it changes the hash", () => {
		const base = buildCanonPrompt(input());
		expect(base.sha256).toBe(sha256Hex(canonicalJson(base.prompt)));
		expect(buildCanonPrompt(input()).sha256).toBe(base.sha256);
		const f = input().files[0] as CanonPromptInput["files"][number];
		for (const over of [
			{ identityMd: "# Canon v2\n" },
			{ files: [{ ...f, contentMd: `${f.contentMd}!` }] },
			{ memory: ["Meridian prefers Square."] },
			{ messages: [{ seq: 1, role: "operator" as const, contentMd: "Hi." }] },
		]) {
			expect(
				buildCanonPrompt(input(over)).sha256,
				JSON.stringify(over),
			).not.toBe(base.sha256);
		}
	});
});
