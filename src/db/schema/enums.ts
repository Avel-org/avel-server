import { pgEnum } from "drizzle-orm/pg-core";

/** The closed role vocabulary from docs/ROLES.md: 35 roles, in catalog order. */
export const roles = [
	// Foundation
	"foundations",
	"schema",
	"contract",
	"design-system",
	"fixture",
	// Build
	"domain",
	"api-surface",
	"integration",
	"realtime",
	"auth",
	"state",
	"interface",
	// Verify
	"backend-tests",
	"frontend-tests",
	"property-tests",
	"accessibility",
	"performance",
	// Review
	"spec-check",
	"spec-judgment",
	"security-review",
	"compliance-review",
	"adversarial",
	"reconciliation",
	"concurrency",
	// Operate
	"deploy",
	"recovery",
	"observability",
	"incident-response",
	// Firm
	"intake",
	"strategy",
	"research",
	"client-ops",
	// Platform
	"knowledge",
	"render",
	"ship-decision",
] as const;
export type Role = (typeof roles)[number];
export const role = pgEnum("role", roles);

export const waves = ["A", "B", "C", "D", "E"] as const;
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
