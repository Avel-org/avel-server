import type { CanonMode } from "../../contract";
import {
	KNOWLEDGE_SPLIT_VERSION,
	type KnowledgeChunk,
	type KnowledgeFile,
	type SearchResultBlock,
	splitKnowledge,
	toSearchResultBlocks,
} from "../../lib/canon";
import { canonicalJson } from "../../lib/canonical";
import { sha256Hex } from "../../lib/tokens";

/**
 * Bump with any change to the instructions below. 2 (2026-10-20): one
 * section per mode and scope, and naming an untitled session. 3
 * (2026-10-21): sources on every requirement and criterion, and a reply
 * that cites each requirement, after the first live turn returned none.
 * 4 (2026-10-28): playbook and preset proposals, only when asked.
 */
export const CANON_INSTRUCTIONS_VERSION = 4;

/**
 * What Canon is told on a draft turn, after its identity (DECISIONS-V2,
 * Decided 2026-10-19: Canon is the briefer). [hypothesis]: the wording has
 * not met a real model yet. Unchanged in version 2; it became draft mode's.
 * Version 3 adds the sources and the cited reply.
 */
export const CANON_INSTRUCTIONS = `You are briefing one project for the operator. The project's documents are given to you as search results, and its kept memory and the conversation follow them.

Draft the brief with the draft_brief tool, in the intake's shape: a summary, requirements with ids R1, R2 and so on, and acceptance criteria with ids AC1, AC2 and so on, each citing the requirement it shows done. Give every requirement and criterion a sources list: the source of each search result it stands on, copied exactly. Write no modules and no checks: the plan comes later, from the operator. The tool returns what the intake check found; fix what it reports and draft again.

When the draft saves, reply to the operator with each requirement on its own line, citing the passage behind it from the documents.

When you cannot decide something from the documents, ask the operator with the ask_operator tool instead of guessing. Give two to four options, say why you are asking, and name the passages that raised the question.

Cite every claim you make about the project from the documents. A claim with no passage behind it is a guess; ask instead.

Propose a memory with propose_memory only for a lasting fact about this client that the operator should keep. Recommend a roster with recommend_roster only when the operator asks for one.

Propose a playbook with draft_playbook, or a preset with draft_preset, only when the operator asks for one. Take the gates and their policies, the waves, the deliverable, the required fields and the agents from the documents, and ask where they are silent. A proposal waits for the operator's approval: never say it is live.

You never choose the cut: it is derived from the repository. You never approve anything, start anything, or act outside your tools. The operator decides.`;

/** Every turn, whatever its mode. */
export const CANON_BOUNDS = `You read and you draft; the operator decides. You never approve anything, start anything, or act outside your tools.`;

/** Ask and fetch, by scope (J, 2026-10-20). [hypothesis], as above. */
export const CANON_MODE_INSTRUCTIONS = {
	ask: {
		open: `This conversation belongs to no client, and you read no client's data in it. Answer from general knowledge and from how AVEL works. When the operator wants live data, say that fetch mode reads it.`,
		client: `This conversation is about one client. Answer from what you are given: the client's kept memory, its documents when there are any, and the conversation. When the operator wants live data, say that fetch mode reads it.`,
	},
	fetch: {
		open: `Answer from the command center's own data, which you read with the fetch tool: clients, engagements, intakes, missions, dispatches, spend, activity, gate runs and findings, across every client. Read before you answer, and say what you read. When a question needs data the tool cannot read, say so; never guess a number.`,
		client: `Answer from the command center's own data for this one client, which you read with the fetch tool: its engagements, intakes, missions, dispatches, spend, activity, gate runs and findings. You cannot read any other client. Read before you answer, and say what you read. When a question needs data the tool cannot read, say so; never guess a number.`,
	},
} as const;

/** Added while the session has no title. */
export const CANON_NAMING = `This conversation has no title yet. After your first answer, name it with name_session: a few plain words saying what it is about.`;

export type CanonPromptInput = {
	/** The mode the turn runs in: its operator message's. */
	mode: CanonMode;
	scope: "open" | "client";
	/** Whether the session has a title; Canon names it when it has none. */
	titled: boolean;
	/** Canon's identity, from its frozen identity version. */
	identityMd: string;
	/** The intake's live files, in a stable order. */
	files: readonly KnowledgeFile[];
	/** The client's kept memory, in a stable order. */
	memory: readonly string[];
	/** The session's messages; ordered here by seq. */
	messages: ReadonlyArray<{
		seq: number;
		role: "operator" | "canon";
		contentMd: string;
	}>;
};

/** Everything a model is given for one turn. Model-agnostic: each model renders it. */
export type CanonPrompt = {
	instructionsVersion: number;
	mode: CanonMode;
	scope: "open" | "client";
	splitVersion: string;
	system: string;
	knowledge: SearchResultBlock[];
	memory: string[];
	transcript: Array<{ role: "operator" | "canon"; contentMd: string }>;
};

/**
 * One turn's prompt, the chunks its knowledge was made from (citations are
 * checked against them), and its hash: the SHA-256 of its canonical JSON.
 * Pure.
 */
export function buildCanonPrompt(input: CanonPromptInput): {
	prompt: CanonPrompt;
	chunks: KnowledgeChunk[];
	sha256: string;
} {
	const chunks = splitKnowledge(input.files);
	const section =
		input.mode === "draft"
			? CANON_INSTRUCTIONS
			: CANON_MODE_INSTRUCTIONS[input.mode][input.scope];
	const system = [
		input.identityMd.trimEnd(),
		section,
		CANON_BOUNDS,
		...(input.titled ? [] : [CANON_NAMING]),
	].join("\n\n");
	const prompt: CanonPrompt = {
		instructionsVersion: CANON_INSTRUCTIONS_VERSION,
		mode: input.mode,
		scope: input.scope,
		splitVersion: KNOWLEDGE_SPLIT_VERSION,
		system,
		knowledge: toSearchResultBlocks(chunks),
		memory: [...input.memory],
		transcript: [...input.messages]
			.sort((a, b) => a.seq - b.seq)
			.map((m) => ({ role: m.role, contentMd: m.contentMd })),
	};
	return { prompt, chunks, sha256: sha256Hex(canonicalJson(prompt)) };
}
