import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessStep } from "./harness";

/**
 * Turns an Agent SDK session's messages into run-trace steps (J,
 * 2026-10-20): the agent's text in chunks, reasoning summaries, each tool
 * call and its result. Pure and stateful per session: feed it every
 * message in order, then flush at the end. Only the top-level agent's
 * messages count; a subagent's (parent_tool_use_id set) are left out.
 */

/** A text or reasoning step is cut once this much has gathered. */
export const SDK_TEXT_STEP_CHARS = 400;
/** What a step keeps of a tool's input or result. */
export const SDK_DETAIL_CHARS = 2_000;

/** AVEL's tools reach the SDK as mcp__<server>__<name>; the trace shows the name. */
function toolName(sdkName: string): string {
	const m = /^mcp__[^_]+__(.+)$/.exec(sdkName);
	return m?.[1] ?? sdkName;
}

function clip(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return (text ?? "").slice(0, SDK_DETAIL_CHARS);
}

/** A tool_result block's content, as text. */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) =>
				c && typeof c === "object" && "text" in c
					? String((c as { text: unknown }).text)
					: "",
			)
			.join("");
	}
	return "";
}

export class SdkStepTrace {
	private text = "";
	private reasoning = "";
	private readonly tools = new Map<string, string>();

	/** The steps this message completes, in order. */
	onMessage(m: SDKMessage): HarnessStep[] {
		const out: HarnessStep[] = [];
		if ("parent_tool_use_id" in m && m.parent_tool_use_id !== null) return out;
		if (m.type === "stream_event") {
			const e = m.event as {
				type?: string;
				delta?: { type?: string; text?: string; thinking?: string };
			};
			if (e.type === "content_block_delta" && e.delta) {
				if (e.delta.type === "text_delta" && e.delta.text) {
					this.text += e.delta.text;
					if (this.text.length >= SDK_TEXT_STEP_CHARS)
						out.push(...this.flushText());
				} else if (e.delta.type === "thinking_delta" && e.delta.thinking) {
					this.reasoning += e.delta.thinking;
					if (this.reasoning.length >= SDK_TEXT_STEP_CHARS) {
						out.push(...this.flushReasoning());
					}
				}
			} else if (e.type === "content_block_stop") {
				out.push(...this.flush());
			}
		} else if (m.type === "assistant") {
			for (const block of m.message.content as Array<{
				type: string;
				id?: string;
				name?: string;
				input?: unknown;
			}>) {
				if (block.type !== "tool_use" || !block.id || !block.name) continue;
				out.push(...this.flush());
				const tool = toolName(block.name);
				this.tools.set(block.id, tool);
				out.push({
					kind: "tool_call",
					label: `Calling ${tool}`,
					detail: {
						tool,
						toolUseId: block.id,
						input: clip(block.input ?? null),
					},
				});
			}
		} else if (m.type === "user") {
			const content = m.message.content;
			if (!Array.isArray(content)) return out;
			for (const block of content as Array<{
				type: string;
				tool_use_id?: string;
				is_error?: boolean;
				content?: unknown;
			}>) {
				if (block.type !== "tool_result" || !block.tool_use_id) continue;
				const tool = this.tools.get(block.tool_use_id) ?? "tool";
				const isError = block.is_error === true;
				out.push({
					kind: "tool_result",
					label: `${tool} ${isError ? "refused" : "answered"}`,
					detail: {
						tool,
						toolUseId: block.tool_use_id,
						isError,
						text: clip(resultText(block.content)),
					},
				});
			}
		}
		return out;
	}

	/** Whatever text and reasoning are still gathering. */
	flush(): HarnessStep[] {
		return [...this.flushReasoning(), ...this.flushText()];
	}

	/** The step for a session that failed. */
	error(message: string): HarnessStep {
		return {
			kind: "error",
			label: "The session failed",
			detail: { message: message.slice(0, SDK_DETAIL_CHARS) },
		};
	}

	private flushText(): HarnessStep[] {
		if (this.text === "") return [];
		const text = this.text;
		this.text = "";
		return [{ kind: "text", label: "Writing", detail: { text } }];
	}

	private flushReasoning(): HarnessStep[] {
		if (this.reasoning === "") return [];
		const text = this.reasoning;
		this.reasoning = "";
		return [{ kind: "reasoning_summary", label: "Thinking", detail: { text } }];
	}
}
