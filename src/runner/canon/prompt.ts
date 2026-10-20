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

/** Bump with any change to CANON_INSTRUCTIONS. */
export const CANON_INSTRUCTIONS_VERSION = 1;

/**
 * What Canon is told on every turn, after its identity (DECISIONS-V2,
 * Decided 2026-10-19: Canon is the briefer). [hypothesis]: the wording has
 * not met a real model yet.
 */
export const CANON_INSTRUCTIONS = `You are briefing one project for the operator. The project's documents are given to you as search results, and its kept memory and the conversation follow them.

Draft the brief with the draft_brief tool, in the intake's shape: a summary, requirements with ids R1, R2 and so on, and acceptance criteria with ids AC1, AC2 and so on, each citing the requirement it shows done. Write no modules and no checks: the plan comes later, from the operator. The tool returns what the intake check found; fix what it reports and draft again.

When you cannot decide something from the documents, ask the operator with the ask_operator tool instead of guessing. Give two to four options, say why you are asking, and name the passages that raised the question.

Cite every claim you make about the project from the documents. A claim with no passage behind it is a guess; ask instead.

Propose a memory with propose_memory only for a lasting fact about this client that the operator should keep. Recommend a roster with recommend_roster only when the operator asks for one.

You never choose the cut: it is derived from the repository. You never approve anything, start anything, or act outside your tools. The operator decides.`;

export type CanonPromptInput = {
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
	const prompt: CanonPrompt = {
		instructionsVersion: CANON_INSTRUCTIONS_VERSION,
		splitVersion: KNOWLEDGE_SPLIT_VERSION,
		system: `${input.identityMd.trimEnd()}\n\n${CANON_INSTRUCTIONS}`,
		knowledge: toSearchResultBlocks(chunks),
		memory: [...input.memory],
		transcript: [...input.messages]
			.sort((a, b) => a.seq - b.seq)
			.map((m) => ({ role: m.role, contentMd: m.contentMd })),
	};
	return { prompt, chunks, sha256: sha256Hex(canonicalJson(prompt)) };
}
