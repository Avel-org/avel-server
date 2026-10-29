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
	CANON_BOUNDS,
	CANON_INSTRUCTIONS,
	CANON_INSTRUCTIONS_VERSION,
	CANON_MODE_INSTRUCTIONS,
	CANON_NAMING,
	type CanonPromptInput,
} from "../../../src/runner/canon";

const SHA = "a".repeat(64);

const input = (over: Partial<CanonPromptInput> = {}): CanonPromptInput => ({
	mode: "draft",
	scope: "client",
	titled: true,
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
			`# Canon\nYou brief projects.\n\n${CANON_INSTRUCTIONS}\n\n${CANON_BOUNDS}`,
		);
		expect(prompt.instructionsVersion).toBe(CANON_INSTRUCTIONS_VERSION);
		expect(CANON_INSTRUCTIONS_VERSION).toBe(4);
		expect(prompt).toMatchObject({ mode: "draft", scope: "client" });
		expect(prompt.splitVersion).toBe(KNOWLEDGE_SPLIT_VERSION);
	});

	it("tells each mode and scope its own section, and asks for a title only while there is none", () => {
		const system = (over: Partial<CanonPromptInput>) =>
			buildCanonPrompt(input(over)).prompt.system;
		expect(system({ mode: "ask", scope: "open" })).toContain(
			CANON_MODE_INSTRUCTIONS.ask.open,
		);
		expect(system({ mode: "ask", scope: "open" })).not.toContain(
			CANON_INSTRUCTIONS,
		);
		expect(system({ mode: "ask", scope: "client" })).toContain(
			CANON_MODE_INSTRUCTIONS.ask.client,
		);
		expect(system({ mode: "fetch", scope: "open" })).toContain(
			CANON_MODE_INSTRUCTIONS.fetch.open,
		);
		expect(system({ mode: "fetch", scope: "client" })).toContain(
			CANON_MODE_INSTRUCTIONS.fetch.client,
		);
		for (const over of [
			{ mode: "ask", scope: "open" },
			{ mode: "fetch", scope: "client" },
			{ mode: "draft", scope: "client" },
		] as const) {
			expect(system(over)).toContain(CANON_BOUNDS);
		}
		expect(system({ titled: false })).toContain(CANON_NAMING);
		expect(system({ titled: true })).not.toContain(CANON_NAMING);
		// The mode and scope are in the hash: the same words in another mode
		// are another prompt.
		const a = buildCanonPrompt(input({ mode: "ask", scope: "open" })).sha256;
		const b = buildCanonPrompt(input({ mode: "ask", scope: "client" })).sha256;
		expect(a).not.toBe(b);
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
			"sources list",
			"citing the passage behind it",
			"never choose the cut",
			"draft_playbook",
			"draft_preset",
			"waits for the operator's approval",
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
