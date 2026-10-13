import type { Role } from "../contract/agent-template";
import {
	ROLE_RUNNER,
	ROLE_SIDE,
	ROLE_TEAM,
	type Runner,
	SIDES,
	type Side,
	type Team,
} from "../contract/role-labels";

/**
 * What each role is, for the identity generator (module 5). Server code only
 * (J, 2026-10-13): never in the contract, never in a table. Runtime, family
 * and side are the contract's ROLE_RUNNER, ROLE_TEAM and ROLE_SIDE; this file
 * holds the definition text and the merge rules.
 *
 * Every field and guidance line traces to a sentence in docs/ROLES.md or
 * docs/ROSTER-V2.md. produces, consumes and measuredBy are the catalog
 * table cells verbatim, and tests/unit/roles.test.ts compares them with the
 * doc. Guidance is written to the agent, so only model roles carry any.
 */
export interface RoleDefinition {
	/** The catalog's Produces cell. */
	readonly produces: string;
	/** The catalog's Consumes cell, split on its commas. */
	readonly consumes: readonly string[];
	/** The family's Checked by line; null where the doc states none. */
	readonly checkedBy: string | null;
	/** The catalog's Measured by cell. */
	readonly measuredBy: string;
	/** Imperative lines in the agent's voice. Empty for code and human roles. */
	readonly guidance: readonly string[];
}

// Lines every model role carries.
const EVERY_MODEL_ROLE = [
	// ROLES.md, The catalog: "Each read is recorded by hash."
	"You record the SHA-256 of every artifact you read.",
	// ROLES.md, The runtime test.
	"You never guess at what a tool could have measured. The tool runs first; you interpret its output.",
	// ROSTER-V2.md, What is fixed; ROLES.md, Improving roles.
	"You never edit your own instructions.",
] as const;

// Lines every role on a mission roster carries (author, tester, judge, fixture).
const ON_A_MISSION = [
	...EVERY_MODEL_ROLE,
	// ROSTER-V2.md, What is fixed: agents exchange declared artifacts.
	"You hand off through declared artifacts, never direct messages.",
] as const;

// ROLES.md, Foundation and Build Owns lines; ROSTER-V2.md, What is fixed:
// nothing that writes source writes the tests that grade it.
const WRITES_SOURCE =
	"You write source. You never write tests: `*.spec.ts`, `*.test.ts` and `tests/**` are outside your mount.";

// ROLES.md, What each family may do through the API.
const PROPOSES_NOTHING = "You propose nothing.";
const RAISES_BLOCKERS =
	"You raise a problem through the `blockers` field of your CompletionReport.";

const FOUNDATION = [
	...ON_A_MISSION,
	WRITES_SOURCE,
	// ROLES.md, Foundation: Checked by.
	"Every consumer records the SHA-256 of what it read. A mismatch against what you wrote is a finding.",
	"Downstream blockers that turn out to be provisioning gaps count against your family.",
	PROPOSES_NOTHING,
] as const;

const BUILD = [
	...ON_A_MISSION,
	WRITES_SOURCE,
	// ROLES.md, Build: Checked by.
	"The verify and review families check your output, then the gate.",
	PROPOSES_NOTHING,
	RAISES_BLOCKERS,
] as const;

const VERIFY = [
	...ON_A_MISSION,
	// ROLES.md, Verify: Owns.
	"You write tests and test files only. You never write source.",
	"Every test you write declares the acceptance criterion it covers.",
	// ROLES.md, Verify: Checked by, for model roles.
	"You are checked by the mutation score of the tests you write.",
	PROPOSES_NOTHING,
	RAISES_BLOCKERS,
] as const;

// ROLES.md, Review: Owns `findings/<role>/` only.
function review(role: Role): readonly string[] {
	return [
		...ON_A_MISSION,
		`You write findings to \`findings/${role}/\` only. You never write source or tests.`,
		// ROLES.md, What each family may do through the API.
		"You record a defect as an `open` Finding on your own mission, never as a proposal.",
		// ROSTER-V2.md, What is fixed: the ship decision is a function.
		"You hold no authority. Your findings are input to the gate, never the gate.",
		// ROLES.md, Review: Checked by, for model roles.
		"You are checked by whether your findings are confirmed real.",
		PROPOSES_NOTHING,
	];
}

const FIRM = [
	...EVERY_MODEL_ROLE,
	// ROLES.md, Firm heading; ROSTER-V2.md, Merging roles into agents.
	"You work between missions. You never sit on a mission roster.",
	// ROLES.md, What each family may do through the API.
	"You never read connections, repo policies or credentials.",
	"You never edit a Client or an Engagement.",
] as const;

// ROLES.md, Foundation: Checked by.
const FOUNDATION_CHECK =
	"Every consumer records the SHA-256 of what it read; a mismatch against what was written is a finding. Downstream blockers that turn out to be provisioning gaps count against this family.";
const BUILD_CHECK = "The verify and review families, then the gate.";
const VERIFY_MODEL_CHECK = "The mutation score of the tests they produce.";
const VERIFY_CODE_CHECK = "The tool's configuration is itself golden-tested.";
const REVIEW_MODEL_CHECK =
	"The true-positive rate over time: whether findings were confirmed real.";
const REVIEW_CODE_CHECK = "Determinism.";
const OPERATE_CHECK =
	"Rollback drills that actually execute, and post-mortems.";

export const ROLE_DEFINITIONS = {
	foundations: {
		produces: "Composition root, shared package, provisioned directories",
		consumes: ["Client repository", "extracted conventions"],
		checkedBy: FOUNDATION_CHECK,
		measuredBy: "Downstream blockers that were provisioning gaps",
		// human: covered by the operator's RosterEntry, never by an agent.
		guidance: [],
	},
	schema: {
		produces: "Migrations",
		consumes: ["Brief", "conventions"],
		checkedBy: FOUNDATION_CHECK,
		measuredBy: "Migrations needing a follow-up fix",
		guidance: FOUNDATION,
	},
	contract: {
		produces: "The API contract artifact",
		consumes: ["Brief", "schema"],
		checkedBy: FOUNDATION_CHECK,
		measuredBy: "Consumer hash mismatches",
		guidance: FOUNDATION,
	},
	"design-system": {
		produces: "Tokens, primitives",
		consumes: ["Brief", "brand tokens"],
		checkedBy: FOUNDATION_CHECK,
		measuredBy: "Hardcoded values found in components",
		guidance: FOUNDATION,
	},
	fixture: {
		produces: "The golden fixture",
		consumes: ["The render specification only"],
		checkedBy: FOUNDATION_CHECK,
		measuredBy:
			"Fixture updates later found to have hidden a regression — target zero",
		// ROLES.md, Foundation: the fixture paragraphs and The rule that removes
		// the judgment call. ROSTER-V2.md, The horizontal instantiation: Fenn
		// cannot share a mount.
		guidance: [
			...ON_A_MISSION,
			"You write `fixtures/golden/` only. You read the render specification only, never render source or render output.",
			"You update the fixture only in response to a specification change, never in response to a render change.",
			"You never regenerate the fixture from render output.",
			"You are never grouped with another role.",
			PROPOSES_NOTHING,
		],
	},
	domain: {
		produces: "Services, business rules",
		consumes: ["Contract", "schema"],
		checkedBy: BUILD_CHECK,
		measuredBy: "First-pass gate rate",
		guidance: BUILD,
	},
	"api-surface": {
		produces: "Route handlers, DTOs",
		consumes: ["Contract", "domain signatures"],
		checkedBy: BUILD_CHECK,
		measuredBy: "First-pass gate rate",
		guidance: BUILD,
	},
	integration: {
		produces: "External connectors, webhook handlers",
		consumes: ["Contract", "third-party API specifications"],
		checkedBy: BUILD_CHECK,
		measuredBy: "Failed deliveries to third parties",
		guidance: BUILD,
	},
	realtime: {
		produces: "WebSocket and SSE handlers",
		consumes: ["Contract"],
		checkedBy: BUILD_CHECK,
		measuredBy: "Ordering and reconnection defects",
		guidance: BUILD,
	},
	auth: {
		produces: "Guards, authorization logic",
		consumes: ["Contract", "schema", "permission policy"],
		checkedBy: BUILD_CHECK,
		measuredBy: "Undefined cells in the permission matrix",
		// ROSTER-V2.md, Roles preserved in both cuts (implementer to attacker)
		// and The implementer-to-attacker edge becomes an artifact.
		guidance: [
			...BUILD,
			"You document the security surface you build. A separate agent uses it as the attack map.",
			"Your permission policy is machine-readable: the expected value for every role, resource and state cell.",
		],
	},
	state: {
		produces: "Frontend state, data fetching",
		consumes: ["Contract"],
		checkedBy: BUILD_CHECK,
		measuredBy: "Stale-data defects",
		guidance: BUILD,
	},
	interface: {
		produces: "Components, screens, charts",
		consumes: ["State types", "design-system primitives"],
		checkedBy: BUILD_CHECK,
		measuredBy: "First-pass gate rate",
		guidance: BUILD,
	},
	"backend-tests": {
		produces: "Backend test suites",
		consumes: ["Contract", "acceptance criteria"],
		checkedBy: VERIFY_MODEL_CHECK,
		measuredBy: "Mutation score of the tests it wrote",
		guidance: VERIFY,
	},
	"frontend-tests": {
		produces: "Browser and component tests",
		consumes: ["Acceptance criteria", "interface"],
		checkedBy: VERIFY_MODEL_CHECK,
		measuredBy: "Mutation score of the tests it wrote",
		guidance: VERIFY,
	},
	"property-tests": {
		produces: "Property-based test suites",
		consumes: ["Contract", "invariants from the spec"],
		checkedBy: VERIFY_MODEL_CHECK,
		measuredBy: "Defects found that example-based tests missed",
		// ROLES.md, Verify: property testing requires stating invariants.
		// ROSTER-V2.md, The adversary now has mechanical inputs.
		guidance: [
			...VERIFY,
			"You state invariants from the spec and generate cases from them, rather than imagining a dozen.",
		],
	},
	accessibility: {
		produces: "Accessibility scan results",
		consumes: ["The built interface"],
		checkedBy: VERIFY_CODE_CHECK,
		measuredBy: "Violations caught before delivery",
		guidance: [],
	},
	performance: {
		produces: "Performance budget measurements",
		consumes: ["The built interface", "the budget"],
		checkedBy: VERIFY_CODE_CHECK,
		measuredBy: "Regressions caught before delivery",
		guidance: [],
	},
	"spec-check": {
		produces: "Criteria without a covering test",
		consumes: ["Acceptance criteria", "test criterion tags"],
		checkedBy: REVIEW_CODE_CHECK,
		measuredBy: "Uncovered criteria caught",
		guidance: [],
	},
	"spec-judgment": {
		produces: "Findings on whether the implementation meets the intent",
		consumes: ["Brief", "implementation", "`spec-check` output"],
		checkedBy: REVIEW_MODEL_CHECK,
		measuredBy: "Findings confirmed real",
		// ROLES.md, Review: spec-judgment paragraphs.
		guidance: [
			...review("spec-judgment"),
			"You judge only what `spec-check` flagged.",
			"You judge the implementation against the brief. Code and a test that agree with each other can both be wrong.",
		],
	},
	"security-review": {
		produces: "Security findings",
		consumes: [
			"Security surface document",
			"static analysis output",
			"permission policy",
		],
		checkedBy: REVIEW_MODEL_CHECK,
		measuredBy: "Findings confirmed real",
		// ROLES.md, Review: model roles that lean on tools.
		guidance: [
			...review("security-review"),
			"Static analysis and dependency scanning run first. You interpret what they found and reason about what they cannot see.",
		],
	},
	"compliance-review": {
		produces: "Regulatory findings",
		consumes: ["The domain's compliance rules"],
		checkedBy: REVIEW_MODEL_CHECK,
		measuredBy: "Findings confirmed real",
		guidance: review("compliance-review"),
	},
	adversarial: {
		produces: "Crashes and failures under malformed input",
		consumes: ["Running endpoints"],
		checkedBy: REVIEW_CODE_CHECK,
		measuredBy: "Defects nothing else caught",
		guidance: [],
	},
	reconciliation: {
		produces: "Data-integrity findings after migration",
		consumes: ["Source and target data"],
		checkedBy: REVIEW_CODE_CHECK,
		measuredBy: "Discrepancies caught",
		guidance: [],
	},
	concurrency: {
		produces: "Race and ordering findings",
		consumes: ["Load-test and race-detection output"],
		checkedBy: REVIEW_MODEL_CHECK,
		measuredBy: "Defects confirmed under load",
		// ROLES.md, Review: model roles that lean on tools.
		guidance: [
			...review("concurrency"),
			"Load tests and race detection run first. You interpret what they found and reason about what they cannot see.",
		],
	},
	deploy: {
		produces: "A deployment",
		consumes: ["The shipped package"],
		checkedBy: OPERATE_CHECK,
		measuredBy: "Failed deploys",
		guidance: [],
	},
	recovery: {
		produces: "A rollback",
		consumes: ["Deployment configuration"],
		checkedBy: OPERATE_CHECK,
		measuredBy: "Rollback success, time to recover",
		guidance: [],
	},
	observability: {
		produces: "Logs, metrics, alerts",
		consumes: ["The running system"],
		checkedBy: OPERATE_CHECK,
		measuredBy: "Incidents detected before a user reported them",
		guidance: [],
	},
	"incident-response": {
		produces: "Incident reports, post-mortems",
		consumes: ["Observability signals"],
		checkedBy: OPERATE_CHECK,
		measuredBy: "Repeat incidents",
		// ROLES.md, Operate heading and What each family may do through the API.
		// ROSTER-V2.md, Merging roles into agents: a judge.
		guidance: [
			...ON_A_MISSION,
			"You work after the ship decision, on the delivered mission.",
			"You write incident reports and post-mortems. You never write source.",
			"You may propose a follow-up. Nothing happens until the operator approves it.",
		],
	},
	intake: {
		produces: "The brief, open questions",
		consumes: ["Raw client input"],
		// ROLES.md, Firm: Checked by names intake only.
		checkedBy:
			"Checked mechanically before the operator sees it: every requirement maps to an acceptance criterion. At approval the check runs again, and every entry in `open_questions` must be explicitly acknowledged.",
		measuredBy: "Requirements changed after approval",
		guidance: [
			...FIRM,
			"Every requirement you write maps to an acceptance criterion. That is checked mechanically before the operator sees it.",
			"You list what you cannot resolve in `open_questions`. Each entry must be acknowledged at approval.",
			"You may write Intake drafts and propose questions.",
		],
	},
	strategy: {
		produces: "Scope and approach recommendations",
		consumes: ["Brief", "engagement history"],
		checkedBy: null,
		measuredBy: "Engagements needing rescope",
		// ROLES.md, Where the original agents went (Canon): reads, proposes,
		// never acts. What each family may do through the API.
		guidance: [
			...FIRM,
			"You read and propose. You never act.",
			"You may propose chat suggestions and next missions.",
		],
	},
	research: {
		produces: "Domain and technical research",
		consumes: ["A question from intake or strategy"],
		checkedBy: null,
		measuredBy: "Not yet measured — unbuilt",
		guidance: [...FIRM, PROPOSES_NOTHING],
	},
	"client-ops": {
		produces: "Client communication, status",
		consumes: ["Engagement state"],
		checkedBy: null,
		measuredBy: "Not yet measured — unbuilt",
		// ROLES.md, What each family may do through the API.
		guidance: [
			...FIRM,
			"You never send. You may propose a client message; the operator sends it.",
		],
	},
	// Platform: Checked by is an open question in ROLES.md (deferred to module 4).
	knowledge: {
		produces: "The knowledge authority",
		consumes: ["Findings", "mission records"],
		checkedBy: null,
		measuredBy: "Registry entries later retired as no longer true",
		guidance: [],
	},
	render: {
		produces: "The deterministic package",
		consumes: ["Mission", "roster", "playbook"],
		checkedBy: null,
		measuredBy: "Preview-versus-delivery hash mismatches — target zero",
		guidance: [],
	},
	"ship-decision": {
		produces: "Pass or block",
		consumes: ["Typed findings"],
		checkedBy: null,
		measuredBy:
			"Passes later found to have shipped a defect; blocks later found unwarranted",
		guidance: [],
	},
} as const satisfies Record<Role, RoleDefinition>;

export function roleRuntime(role: Role): Runner {
	return ROLE_RUNNER[role];
}

export function roleFamily(role: Role): Team {
	return ROLE_TEAM[role];
}

export function roleSide(role: Role): Side | null {
	return ROLE_SIDE[role];
}

/** The distinct sides a set of roles spans, in SIDES order. */
export function sidesOf(roles: readonly Role[]): Side[] {
	const present = new Set(roles.map(roleSide));
	return SIDES.filter((s) => present.has(s));
}

export type MergeResult = { ok: true } | { ok: false; sides: Side[] };

/**
 * ROSTER-V2.md, Merging roles into agents: roles merge freely within a side
 * and never across one, and the fixture merges with nothing. Roles with no
 * side (Firm, code, human) do not conflict here; whether they can carry an
 * identity is identitySupported's question.
 */
export function mergeAllowed(roles: readonly Role[]): MergeResult {
	const sides = sidesOf(roles);
	const distinct = new Set(roles);
	if (sides.length > 1) return { ok: false, sides };
	if (distinct.has("fixture") && distinct.size > 1) return { ok: false, sides };
	return { ok: true };
}

/**
 * Only model roles are covered by agents (ROLES.md, The runtime test), so an
 * identity is generated only when every role is a model role. foundations is
 * the operator and gets none. No roles, nothing to generate from.
 */
export function identitySupported(roles: readonly Role[]): boolean {
	return roles.length > 0 && roles.every((r) => roleRuntime(r) === "model");
}
