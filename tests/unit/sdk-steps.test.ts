import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
	SDK_DETAIL_CHARS,
	SDK_TEXT_STEP_CHARS,
	SdkStepTrace,
} from "../../src/runner/sdk-steps";

// The Agent SDK's messages as a dispatch's run-trace steps. Scripted
// messages, shaped as the SDK sends them; no model runs.

const delta = (d: Record<string, unknown>, parent: string | null = null) =>
	({
		type: "stream_event",
		parent_tool_use_id: parent,
		event: { type: "content_block_delta", delta: d },
	}) as unknown as SDKMessage;
const stop = {
	type: "stream_event",
	parent_tool_use_id: null,
	event: { type: "content_block_stop" },
} as unknown as SDKMessage;
const assistant = (content: unknown[], parent: string | null = null) =>
	({
		type: "assistant",
		parent_tool_use_id: parent,
		message: { content },
	}) as unknown as SDKMessage;
const user = (content: unknown[]) =>
	({
		type: "user",
		parent_tool_use_id: null,
		message: { content },
	}) as unknown as SDKMessage;

describe("SdkStepTrace", () => {
	it("gathers text and reasoning until a block ends, then a tool call and its result", () => {
		const t = new SdkStepTrace();
		const steps = [
			delta({ type: "thinking_delta", thinking: "Read the brief " }),
			delta({ type: "thinking_delta", thinking: "first." }),
			delta({ type: "text_delta", text: "Reading " }),
			delta({ type: "text_delta", text: "the room." }),
			stop,
			assistant([
				{ type: "text", text: "ignored: already streamed" },
				{
					type: "tool_use",
					id: "tu_1",
					name: "mcp__avel__room_read",
					input: { path: "src/a.ts" },
				},
			]),
			user([
				{
					type: "tool_result",
					tool_use_id: "tu_1",
					content: [{ type: "text", text: "export const a = 1;" }],
				},
			]),
			user([
				{
					type: "tool_result",
					tool_use_id: "tu_2",
					is_error: true,
					content: "no",
				},
			]),
		].flatMap((m) => t.onMessage(m));
		expect(steps).toEqual([
			{
				kind: "reasoning_summary",
				label: "Thinking",
				detail: { text: "Read the brief first." },
			},
			{ kind: "text", label: "Writing", detail: { text: "Reading the room." } },
			{
				kind: "tool_call",
				label: "Calling room_read",
				detail: {
					tool: "room_read",
					toolUseId: "tu_1",
					input: '{"path":"src/a.ts"}',
				},
			},
			{
				kind: "tool_result",
				label: "room_read answered",
				detail: {
					tool: "room_read",
					toolUseId: "tu_1",
					isError: false,
					text: "export const a = 1;",
				},
			},
			// A result whose call the trace never saw still lands, named "tool".
			{
				kind: "tool_result",
				label: "tool refused",
				detail: { tool: "tool", toolUseId: "tu_2", isError: true, text: "no" },
			},
		]);
	});

	it("cuts long text into chunks, clips big inputs, and flushes what is left", () => {
		const t = new SdkStepTrace();
		const out = t.onMessage(
			delta({ type: "text_delta", text: "x".repeat(SDK_TEXT_STEP_CHARS) }),
		);
		expect(out).toHaveLength(1);
		t.onMessage(delta({ type: "text_delta", text: "tail" }));
		const call = t.onMessage(
			assistant([
				{
					type: "tool_use",
					id: "tu_9",
					name: "mcp__avel__room_write",
					input: { content: "y".repeat(5000) },
				},
			]),
		);
		// The tail is written before the call, and the call's input is clipped.
		expect(call.map((s) => s.kind)).toEqual(["text", "tool_call"]);
		expect(call[0]?.detail).toEqual({ text: "tail" });
		expect(String(call[1]?.detail.input)).toHaveLength(SDK_DETAIL_CHARS);
		t.onMessage(delta({ type: "text_delta", text: "end" }));
		expect(t.flush()).toEqual([
			{ kind: "text", label: "Writing", detail: { text: "end" } },
		]);
		expect(t.flush()).toEqual([]);
	});

	it("leaves out a subagent's messages", () => {
		const t = new SdkStepTrace();
		expect(
			t.onMessage(delta({ type: "text_delta", text: "sub" }, "tu_parent")),
		).toEqual([]);
		expect(
			t.onMessage(
				assistant(
					[{ type: "tool_use", id: "x", name: "Bash", input: {} }],
					"tu_parent",
				),
			),
		).toEqual([]);
		expect(t.flush()).toEqual([]);
	});
});
