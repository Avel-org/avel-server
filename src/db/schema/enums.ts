import { pgEnum } from "drizzle-orm/pg-core";
import { ROLES, WAVES } from "../../contract/agent-template";

/**
 * The closed role vocabulary (docs/ROLES.md) and the waves A to E, built from
 * the contract arrays so the database and avel-web cannot drift.
 */
export const roles = ROLES;
export type Role = (typeof roles)[number];
export const role = pgEnum("role", roles);

export const waves = WAVES;
export type Wave = (typeof waves)[number];
export const wave = pgEnum("wave", waves);

export const cut = pgEnum("cut", ["horizontal", "vertical"]);

/** Closed gate vocabulary, DATA-CONTRACTS-V2.md Playbook. */
export const gates = [
	"phase1-close",
	"alignment",
	"qa",
	"security",
	"rollback",
	"acceptance",
] as const;
export type Gate = (typeof gates)[number];
export const gate = pgEnum("gate", gates);

/** Export.target_kind and RepoPolicy.default_target share one vocabulary. */
export const exportTargetKind = pgEnum("export_target_kind", [
	"zip",
	"github_pr",
	"github_push",
]);
