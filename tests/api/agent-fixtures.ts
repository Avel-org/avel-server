import { eq } from "drizzle-orm";
import type { DispatchStatus, Role } from "../../src/contract";
import type { NewDispatch } from "../../src/db/dispatch";
import { agentTemplate } from "../../src/db/schema";
import type { Tx } from "../../src/db/tx";
import type { IdGenerator } from "../../src/lib/ids";
import {
	DISPATCH_TOKEN_PREFIX,
	mintToken,
	sha256Hex,
} from "../../src/lib/tokens";
import {
	dispatchValues,
	insertDispatchRow,
	type SeededAgent,
	seedAgent,
} from "../db/dispatch-fixtures";
import { seedMission } from "../db/fixtures";

// Agents with dispatches and tokens, for the API tests of agent access.
// Rows come from 56's tests/db fixtures. Not collected as a test file.

/** Seed ids under the call's namespace, in a block the app's ids never use. */
export function seedIds(ns: string): IdGenerator {
	let n = 0;
	return {
		next: () => {
			n += 1;
			return `${ns}-0000-4000-9000-${n.toString(16).padStart(12, "0")}`;
		},
	};
}

export type Seeded = Awaited<ReturnType<typeof seedMission>> & {
	agent: SeededAgent;
};

/** A mission and one agent on its roster with `roles`. */
export async function seedRosteredAgent(
	tx: Tx,
	ids: IdGenerator,
	roles: Role[],
): Promise<Seeded> {
	const parents = await seedMission(tx, ids);
	const agent = await seedAgent(tx, ids, parents.missionId);
	await tx
		.update(agentTemplate)
		.set({ roles })
		.where(eq(agentTemplate.id, agent.templateId));
	return { ...parents, agent };
}

/** A dispatch of `agent` in `status`, with a fresh token; returns the token in the clear. */
export async function dispatchWithToken(
	tx: Tx,
	ids: IdGenerator,
	agent: SeededAgent,
	status: DispatchStatus,
	over: Partial<NewDispatch> = {},
): Promise<{ id: string; token: string }> {
	const token = mintToken(DISPATCH_TOKEN_PREFIX, ids);
	const id = await insertDispatchRow(
		tx,
		ids,
		dispatchValues(agent, ids, status, {
			tokenSha256: sha256Hex(token),
			...over,
		}),
	);
	return { id, token };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
