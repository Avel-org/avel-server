import { createHash } from "node:crypto";
import type { IdGenerator } from "../lib/ids";
import {
	editTool,
	listTool,
	normalizeRoomPath,
	readBytesTool,
	ToolError,
	type ToolRoom,
	writeTool,
} from "../rooms/tools";
import type { SessionSkill } from "./harness";

/**
 * The tools a real agent gets (step 9d; docs/STEP-9-PLAN.md, The harness):
 * the room's four file tools, skill_read, report and finding. Nothing else
 * reaches the host. Each handler returns the text the model sees and never
 * throws for a refusal: a refused call is the agent's to correct.
 *
 * report and finding go through the server's own /api/agent/* routes, in
 * process, with the dispatch's token. The token lives in this closure and
 * in no tool input or output, so the agent never sees it. What the agent
 * read is recorded here, by the read tool, and sent with the report: the
 * agent does not hash files or keep its own list.
 */

/** Calls the server in process: the app's fetch. */
export type AgentApi = (request: Request) => Promise<Response>;

export type ToolResult = { text: string; isError?: true };

export type AgentToolContext = {
	dispatchId: string;
	token: string;
	room: ToolRoom;
	skills: readonly SessionSkill[];
	api: AgentApi;
	ids: IdGenerator;
	/**
	 * Runs before the report is filed: hands the runner the usage it has
	 * not counted yet, because filing closes the dispatch and nothing is
	 * counted on a closed one.
	 */
	beforeReport: () => Promise<void>;
	/** Called once a report is filed, with its status. */
	onReported: (status: "complete" | "blocked") => void;
};

export type Blocker = {
	description: string;
	workaround: string;
	provisioningGap: boolean;
};

const BASE = "http://avel.internal";

const ok = (text: string): ToolResult => ({ text });
const refused = (text: string): ToolResult => ({ text, isError: true });

function refusal(err: unknown): ToolResult {
	if (err instanceof ToolError)
		return refused(`${err.refusal}: ${err.message}`);
	throw err;
}

/** The answer's error message, for the agent. */
async function apiError(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as {
			error?: { code?: string; message?: string; details?: unknown };
		};
		const e = body.error ?? {};
		const details = e.details ? ` ${JSON.stringify(e.details)}` : "";
		return `${res.status} ${e.code ?? ""}: ${e.message ?? ""}${details}`.trim();
	} catch {
		return `${res.status}`;
	}
}

export function agentTools(ctx: AgentToolContext) {
	/** Every path read, in first-read order, at the sha of its latest read. */
	const reads = new Map<string, string>();
	let rereads = 0;
	let reported = false;

	const call = (
		path: string,
		init: { method: string; body: unknown; key?: string },
	) =>
		ctx.api(
			new Request(`${BASE}${path}`, {
				method: init.method,
				headers: {
					authorization: `Bearer ${ctx.token}`,
					"content-type": "application/json",
					...(init.key ? { "idempotency-key": init.key } : {}),
				},
				body: JSON.stringify(init.body),
			}),
		);

	return {
		/** What the report will say was read. */
		artifactsRead: () => [...reads].map(([path, sha256]) => ({ path, sha256 })),
		rereads: () => rereads,

		async roomRead(input: { path: string }): Promise<ToolResult> {
			try {
				const bytes = await readBytesTool(ctx.room, input.path);
				const path = normalizeRoomPath(input.path);
				if (reads.has(path)) rereads += 1;
				reads.set(path, createHash("sha256").update(bytes).digest("hex"));
				return ok(bytes.toString("utf8"));
			} catch (err) {
				return refusal(err);
			}
		},

		async roomList(input: { path?: string }): Promise<ToolResult> {
			try {
				const entries = await listTool(ctx.room, input.path ?? "");
				return ok(
					entries
						.map((e) => (e.kind === "directory" ? `${e.name}/` : e.name))
						.join("\n") || "(empty)",
				);
			} catch (err) {
				return refusal(err);
			}
		},

		async roomWrite(input: {
			path: string;
			content: string;
		}): Promise<ToolResult> {
			try {
				await writeTool(ctx.room, input.path, input.content);
				return ok(`Wrote ${normalizeRoomPath(input.path)}`);
			} catch (err) {
				return refusal(err);
			}
		},

		async roomEdit(input: {
			path: string;
			oldText: string;
			newText: string;
		}): Promise<ToolResult> {
			try {
				await editTool(ctx.room, input.path, input.oldText, input.newText);
				return ok(`Edited ${normalizeRoomPath(input.path)}`);
			} catch (err) {
				return refusal(err);
			}
		},

		async skillRead(input: { slug: string }): Promise<ToolResult> {
			const s = ctx.skills.find((x) => x.slug === input.slug);
			if (!s) {
				const known = ctx.skills.map((x) => x.slug).join(", ") || "none";
				return refused(`No skill ${input.slug} in your brief. Yours: ${known}`);
			}
			return ok(s.contentMd);
		},

		async report(input: {
			status: "complete" | "blocked";
			blockers: Blocker[];
		}): Promise<ToolResult> {
			if (reported) return refused("Your report is already filed. Stop now.");
			await ctx.beforeReport();
			const res = await call("/api/agent/report", {
				method: "POST",
				body: {
					status: input.status,
					artifactsRead: [...reads].map(([path, sha256]) => ({ path, sha256 })),
					blockers: input.blockers,
					rereads,
				},
			});
			if (res.status !== 201) return refused(await apiError(res));
			reported = true;
			ctx.onReported(input.status);
			return ok("Report filed. Your work on this dispatch is over. Stop now.");
		},

		async finding(input: {
			rule: string;
			subject: string;
			severity: "critical" | "high" | "medium" | "low";
			class: string;
		}): Promise<ToolResult> {
			const res = await call("/api/agent/findings", {
				method: "POST",
				body: input,
				key: ctx.ids.next(),
			});
			if (res.status !== 201 && res.status !== 200) {
				return refused(await apiError(res));
			}
			return ok("Finding recorded.");
		},
	};
}

export type AgentTools = ReturnType<typeof agentTools>;
