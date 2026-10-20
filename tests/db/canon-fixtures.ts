import { randomUUID } from "node:crypto";
import type { ClientId } from "../../src/db/client-id";
import {
	agentIdentityVersion,
	agentTemplate,
	type canonQuestion,
	canonSession,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { type Tx, withClientScope } from "../../src/db/tx";
import { PRICE_VERSION } from "../../src/lib/prices";
import { clock } from "./fixtures";

export type Tenant = {
	clientId: string;
	engagementId: string;
	intakeId: string;
	scope: ClientId;
};

/**
 * Canon's identity: a template and one identity version. Unscoped tables.
 * The slug is random unless given; session open looks for exactly "canon".
 */
export async function seedCanonIdentity(tx: Tx, slug?: string) {
	const templateId = randomUUID();
	slug ??= `canon-${templateId.slice(0, 8)}`;
	await tx.insert(agentTemplate).values({
		id: templateId,
		slug,
		name: "Canon",
		title: "Project briefer",
		kind: "horizontal",
		roles: ["domain"],
		waveDefaults: ["A"],
		writablePaths: [],
		version: 1,
		...stamp(clock),
	});
	const versionId = randomUUID();
	await tx.insert(agentIdentityVersion).values({
		id: versionId,
		agentTemplateId: templateId,
		number: 1,
		identityMd: "# Canon\n",
		depthMd: "",
		sha256: "c".repeat(64),
		identityTokens: 1,
		depthTokens: 0,
		inputs: {
			generatorVersion: "identity-v1",
			slug,
			name: "Canon",
			kind: "horizontal",
			roles: ["domain"],
			writablePaths: [],
			definitionsSha256: "e".repeat(64),
			skills: [],
		},
		generatedBy: null,
		createdAt: clock.now(),
	});
	return versionId;
}

/** An open session's values for one tenant. Override any column. */
export function sessionValues(
	t: Tenant,
	openedBy: string,
	identityVersionId: string,
	over: Partial<typeof canonSession.$inferInsert> = {},
): typeof canonSession.$inferInsert {
	return {
		id: randomUUID(),
		intakeId: t.intakeId,
		engagementId: t.engagementId,
		clientId: t.clientId,
		status: "open",
		haltReason: null,
		agentIdentityVersionId: identityVersionId,
		model: "claude-sonnet-5-5",
		priceVersion: PRICE_VERSION,
		harnessVersion: "canon-v0",
		estimatedTokens: 1000,
		tokenSoftCeiling: 1500,
		tokenHardCeiling: 3000,
		tokensUsed: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		spendUsd: "0",
		openedBy,
		openedAt: clock.now(),
		closedAt: null,
		...stamp(clock),
		...over,
	};
}

/** An open question's values on the session's intake. Override any column. */
export function questionValues(
	t: Tenant,
	sessionId: string,
	over: Partial<typeof canonQuestion.$inferInsert> = {},
): typeof canonQuestion.$inferInsert {
	return {
		id: randomUUID(),
		intakeId: t.intakeId,
		canonSessionId: sessionId,
		clientId: t.clientId,
		header: "Auth",
		question: "Which sign-in?",
		options: [
			{ label: "GitHub", description: "OAuth" },
			{ label: "Email", description: "Magic link" },
		],
		multiSelect: false,
		reason: "The brief names both.",
		sourceChunkIds: [],
		status: "open",
		answer: null,
		effectMd: null,
		decidedBy: null,
		decidedAt: null,
		...stamp(clock),
		...over,
	};
}

/** An open session for the tenant, written under its scope. */
export async function seedSession(
	tx: Tx,
	t: Tenant,
	openedBy: string,
	identityVersionId: string,
) {
	const values = sessionValues(t, openedBy, identityVersionId);
	await withClientScope(tx, t.scope, (s) =>
		s.insert(canonSession).values(values),
	);
	return values.id;
}
