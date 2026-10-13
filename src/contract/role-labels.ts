import type { AgentKind, Role } from "./agent-template";

/**
 * Display words for roles, teams, sides and kinds (J, 2026-10-13). Labels
 * only: what a role does lives in server code (src/lib/roles.ts) and is
 * never in the contract. Every map is keyed on its full union, so a new
 * role fails the build until it has a label, a team, a runner and a side.
 */

/** The role families of docs/ROLES.md, in catalog order. */
export const TEAMS = [
	"foundation",
	"build",
	"verify",
	"review",
	"operate",
	"firm",
	"platform",
] as const;

export type Team = (typeof TEAMS)[number];

/** Who runs a role (docs/ROLES.md, The runtime test). */
export const RUNNERS = ["model", "code", "human"] as const;

export type Runner = (typeof RUNNERS)[number];

/**
 * What a role produces relative to everything else (ROSTER-V2.md, Merging
 * roles into agents). Roles merge within a side, never across one.
 */
export const SIDES = ["author", "tester", "judge", "fixture"] as const;

export type Side = (typeof SIDES)[number];

export const ROLE_LABELS = {
	foundations: "Project setup",
	schema: "Database",
	contract: "API contract",
	"design-system": "Design system",
	fixture: "Expected results",
	domain: "Business logic",
	"api-surface": "API endpoints",
	integration: "Integrations",
	realtime: "Live updates",
	auth: "Sign-in and permissions",
	state: "App data",
	interface: "Screens and components",
	"backend-tests": "Backend tests",
	"frontend-tests": "Frontend tests",
	"property-tests": "Edge-case tests",
	accessibility: "Accessibility checks",
	performance: "Performance checks",
	"spec-check": "Spec check",
	"spec-judgment": "Spec review",
	"security-review": "Security review",
	"compliance-review": "Compliance review",
	adversarial: "Attack testing",
	reconciliation: "Reconciliation",
	concurrency: "Concurrency review",
	deploy: "Deployment",
	recovery: "Recovery",
	observability: "Monitoring",
	"incident-response": "Incident response",
	intake: "Client intake",
	strategy: "Strategy",
	research: "Research",
	"client-ops": "Client operations",
	knowledge: "Knowledge base",
	render: "Delivery documents",
	"ship-decision": "Ship decision",
} as const satisfies Record<Role, string>;

/** Each role's family in docs/ROLES.md. */
export const ROLE_TEAM = {
	foundations: "foundation",
	schema: "foundation",
	contract: "foundation",
	"design-system": "foundation",
	fixture: "foundation",
	domain: "build",
	"api-surface": "build",
	integration: "build",
	realtime: "build",
	auth: "build",
	state: "build",
	interface: "build",
	"backend-tests": "verify",
	"frontend-tests": "verify",
	"property-tests": "verify",
	accessibility: "verify",
	performance: "verify",
	"spec-check": "review",
	"spec-judgment": "review",
	"security-review": "review",
	"compliance-review": "review",
	adversarial: "review",
	reconciliation: "review",
	concurrency: "review",
	deploy: "operate",
	recovery: "operate",
	observability: "operate",
	"incident-response": "operate",
	intake: "firm",
	strategy: "firm",
	research: "firm",
	"client-ops": "firm",
	knowledge: "platform",
	render: "platform",
	"ship-decision": "platform",
} as const satisfies Record<Role, Team>;

export const TEAM_LABELS = {
	foundation: {
		label: "Setup",
		meaning: "Lays the groundwork every feature builds on",
	},
	build: { label: "Build", meaning: "Writes the product's code" },
	verify: { label: "Test", meaning: "Writes tests; never touches the code" },
	review: {
		label: "Review",
		meaning: "Checks the work and reports problems; never fixes them",
	},
	operate: {
		label: "After launch",
		meaning: "Handles incidents once it ships",
	},
	firm: {
		label: "Front office",
		meaning: "Works with clients between missions",
	},
	platform: { label: "Automated", meaning: "Code, not an agent" },
} as const satisfies Record<Team, { label: string; meaning: string }>;

/** Each role's runtime column in docs/ROLES.md. Only model roles go on agents. */
export const ROLE_RUNNER = {
	foundations: "human",
	schema: "model",
	contract: "model",
	"design-system": "model",
	fixture: "model",
	domain: "model",
	"api-surface": "model",
	integration: "model",
	realtime: "model",
	auth: "model",
	state: "model",
	interface: "model",
	"backend-tests": "model",
	"frontend-tests": "model",
	"property-tests": "model",
	accessibility: "code",
	performance: "code",
	"spec-check": "code",
	"spec-judgment": "model",
	"security-review": "model",
	"compliance-review": "model",
	adversarial: "code",
	reconciliation: "code",
	concurrency: "model",
	deploy: "code",
	recovery: "code",
	observability: "code",
	"incident-response": "model",
	intake: "model",
	strategy: "model",
	research: "model",
	"client-ops": "model",
	knowledge: "code",
	render: "code",
	"ship-decision": "code",
} as const satisfies Record<Role, Runner>;

/** A code role shows as Automated, whatever its team. */
export const RUNNER_LABELS = {
	model: "Agent",
	code: "Automated",
	human: "Operator",
} as const satisfies Record<Runner, string>;

/**
 * Each role's side (ROSTER-V2.md): Foundation and Build author, Verify tests,
 * Review and incident-response judge, fixture stands alone. Null where no
 * side applies: code roles, which never sit on an agent, and the Firm roles,
 * which never sit on a mission roster.
 */
export const ROLE_SIDE = {
	foundations: "author",
	schema: "author",
	contract: "author",
	"design-system": "author",
	fixture: "fixture",
	domain: "author",
	"api-surface": "author",
	integration: "author",
	realtime: "author",
	auth: "author",
	state: "author",
	interface: "author",
	"backend-tests": "tester",
	"frontend-tests": "tester",
	"property-tests": "tester",
	accessibility: null,
	performance: null,
	"spec-check": null,
	"spec-judgment": "judge",
	"security-review": "judge",
	"compliance-review": "judge",
	adversarial: null,
	reconciliation: null,
	concurrency: "judge",
	deploy: null,
	recovery: null,
	observability: null,
	"incident-response": "judge",
	intake: null,
	strategy: null,
	research: null,
	"client-ops": null,
	knowledge: null,
	render: null,
	"ship-decision": null,
} as const satisfies Record<Role, Side | null>;

export const SIDE_LABELS = {
	author: "Writes code",
	tester: "Writes tests",
	judge: "Reviews",
	fixture: "Independent check",
} as const satisfies Record<Side, string>;

export const KIND_LABELS = {
	horizontal: "Owns a layer",
	feature: "Owns one feature",
} as const satisfies Record<AgentKind, string>;
