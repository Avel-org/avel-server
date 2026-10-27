import { generateIdentity } from "../../lib/identity";
import type { IdGenerator } from "../../lib/ids";
import { DEV_BOOKING_SHA } from "../../lib/templates";
import type {
	agentIdentityVersion,
	agentTemplate,
	playbook,
	rosterPreset,
} from "../schema";

/**
 * The dev seed: the catalog the command center runs on, and nothing else
 * (J, 2026-10-27). The agent templates with one identity each, the two
 * roster presets and the template-booking playbook. No users, clients,
 * engagements, connections, missions, intakes, dispatches, exports, skills
 * or activity: real work makes those. Pure: the same ids give the same
 * rows, byte for byte.
 */

/** When every seeded row was made. A fixed time, never "now". */
export const SEED_EPOCH = "2026-09-07T09:00:00.000Z";
const seededAt = new Date(SEED_EPOCH);

/**
 * The nth seed id: xxxxxxxx-5eed-4000-8000-<n, 12 digits>. The first group is
 * a multiplicative hash of n, so the 8-character short ids a UI shows differ
 * row to row. "5eed" still marks a seeded row, the version nibble is 4 and the
 * variant is 8, so every id is a valid v4 uuid. The last group keeps them unique.
 */
export function seedId(n: number): string {
	const head = (Math.imul(n, 0x9e3779b1) >>> 0).toString(16).padStart(8, "0");
	return `${head}-5eed-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The ids the seed hands out: seedId(1) onwards. */
export function seedIds(): IdGenerator {
	let n = 0;
	return {
		next: () => {
			n += 1;
			return seedId(n);
		},
	};
}

/** The first id seedIds() hands out: the operator's template. Its presence means "already seeded". */
export const SEED_MARKER_ID = seedId(1);

/** The template-booking commit the playbook's template is read at: the dev fixture's head. */
export const BOOKING_TEMPLATE_SHA = DEV_BOOKING_SHA;

type Row<T extends { $inferInsert: unknown }> = T["$inferInsert"];

export interface SeedRows {
	agentTemplate: Row<typeof agentTemplate>[];
	agentIdentityVersion: Row<typeof agentIdentityVersion>[];
	rosterPreset: Row<typeof rosterPreset>[];
	playbook: Row<typeof playbook>[];
}

type AgentSpec = {
	name: string;
	title: string;
	kind: "horizontal" | "feature";
	roles: Row<typeof agentTemplate>["roles"];
	waves: Row<typeof agentTemplate>["waveDefaults"];
	writablePaths: string[];
	description: string;
};

/**
 * The operator and the fifteen builder agents, roles per ROSTER-V2's name
 * register (J, 2026-10-13). Canon, Grim, Trace and Uno are left out. Paths
 * are the horizontal mount table's, as globs; Atlas, which owns one feature
 * at a time, gets that feature's paths on its roster entry. Gat writes the
 * permission policy and Zane only findings (J, 2026-10-13).
 */
const AGENTS = {
	operator: {
		name: "Axis",
		title: "Operator",
		kind: "horizontal",
		roles: ["foundations"],
		waves: ["A"],
		writablePaths: ["**"],
		description:
			"The person who runs the mission. Sets up the shared groundwork before any agent starts, approves plans and finished work, and makes every call an agent is not allowed to make.",
	},
	atlas: {
		name: "Atlas",
		title: "Full-stack lead",
		kind: "feature",
		roles: [
			"schema",
			"contract",
			"domain",
			"api-surface",
			"integration",
			"realtime",
			"auth",
			"state",
			"interface",
		],
		waves: ["B"],
		writablePaths: ["src/features/**", "src/app/**"],
		description:
			"Builds one whole feature from start to finish: the data it keeps, the rules it follows, the screens people use and everything connecting them. Works only inside that feature and never writes the tests that check it.",
	},
	nemi: {
		name: "Nemi",
		title: "Frontend tester",
		kind: "horizontal",
		roles: ["frontend-tests"],
		waves: ["C"],
		writablePaths: ["tests/frontend/**"],
		description:
			"Writes tests that use the app the way a person would, in a browser, each tied to something the plan promised. Can read all of the code but can never change it.",
	},
	fenn: {
		name: "Fenn",
		title: "Expected-results author",
		kind: "horizontal",
		roles: ["fixture"],
		waves: ["A"],
		writablePaths: ["fixtures/golden/**"],
		description:
			"Writes down what the finished work should produce, working only from the plan and never looking at the code or its output. The real output is compared against these results. Changes them only when the plan changes.",
	},
	zane: {
		name: "Zane",
		title: "Security and compliance reviewer",
		kind: "horizontal",
		roles: ["security-review", "compliance-review"],
		waves: ["D"],
		writablePaths: [
			"findings/security-review/**",
			"findings/compliance-review/**",
		],
		description:
			"Reviews the finished work for security holes and for the legal and industry rules the client must follow, using the builders' list of permissions as a map. Writes findings and never fixes them.",
	},
	leonora: {
		name: "Leonora",
		title: "Database and contract engineer",
		kind: "horizontal",
		roles: ["schema", "contract"],
		waves: ["A"],
		writablePaths: ["db/**", "migrations/**", "contract/**"],
		description:
			"Designs how the app stores its data and writes the agreement that sets how the front and back of the app talk to each other. Every builder works from it. Does not build features or write tests.",
	},
	fantem: {
		name: "Fantem",
		title: "Design-system engineer",
		kind: "horizontal",
		roles: ["design-system"],
		waves: ["A"],
		writablePaths: ["tokens/**", "styles/**", "primitives/**"],
		description:
			"Builds the shared look of the app: colours, type, spacing and the basic buttons and fields every screen is made from, so every feature looks the same. Never builds a feature or writes tests.",
	},
	kel: {
		name: "Kel",
		title: "Business-logic engineer",
		kind: "horizontal",
		roles: ["domain"],
		waves: ["B"],
		writablePaths: ["services/**", "domain/**"],
		description:
			"Writes the business rules: what the app may do, in what order and within which limits. Works from the agreed data design and never writes the tests that check it.",
	},
	dunn: {
		name: "Dunn",
		title: "API engineer",
		kind: "horizontal",
		roles: ["api-surface", "integration", "realtime"],
		waves: ["B"],
		writablePaths: ["routes/**", "api/**", "integrations/**"],
		description:
			"Builds the ways into the app: the addresses other software calls, the links to outside services and the live updates. Works from the agreed design and never writes the tests that check it.",
	},
	gat: {
		name: "Gat",
		title: "Security engineer",
		kind: "horizontal",
		roles: ["auth"],
		waves: ["B"],
		writablePaths: ["auth/**", "middleware/**", "permissions/policy.json"],
		description:
			"Builds sign-in and decides who may see and change what. Writes every permission down so a reviewer can try to break it. Never writes the tests that check it.",
	},
	ghost: {
		name: "Ghost",
		title: "App-data engineer",
		kind: "horizontal",
		roles: ["state"],
		waves: ["B"],
		writablePaths: ["lib/**", "stores/**", "hooks/**", "types/**"],
		description:
			"Handles how the screens fetch, hold and refresh the app's data, so people always see what is current. Does not build the screens and never writes the tests that check its work.",
	},
	leon: {
		name: "Leon",
		title: "Frontend engineer",
		kind: "horizontal",
		roles: ["interface"],
		waves: ["B"],
		writablePaths: ["components/**", "app/**"],
		description:
			"Builds the screens, pages and charts people actually use, from the shared building blocks. Never changes the shared look and never writes the tests that check the screens.",
	},
	iyo: {
		name: "Iyo",
		title: "Backend tester",
		kind: "horizontal",
		roles: ["backend-tests"],
		waves: ["C"],
		writablePaths: ["tests/backend/**"],
		description:
			"Writes tests for the behind-the-scenes parts of the app, each tied to something the plan promised. Can read all of the code but can never change it.",
	},
	raze: {
		name: "Raze",
		title: "Edge-case tester",
		kind: "horizontal",
		roles: ["property-tests"],
		waves: ["C"],
		writablePaths: ["tests/property/**"],
		description:
			"Writes tests that throw thousands of generated cases at the rules that must always hold, hunting for the unusual case nobody thought of. Can read the code but never change it.",
	},
	brennan: {
		name: "Brennan",
		title: "Spec reviewer",
		kind: "horizontal",
		roles: ["spec-judgment"],
		waves: ["D"],
		writablePaths: ["findings/spec-judgment/**"],
		description:
			"Checks the finished work against the plan and asks whether it does what was really meant, including when the code and its tests agree but are both wrong. Writes findings and never fixes anything.",
	},
	kodie: {
		name: "Kodie",
		title: "Concurrency reviewer",
		kind: "horizontal",
		roles: ["concurrency"],
		waves: ["D"],
		writablePaths: ["findings/concurrency/**"],
		description:
			"Called in when many people can act at the same moment. Looks for what breaks when two things happen at once, using load and timing test results. Writes findings and never fixes them.",
	},
} satisfies Record<string, AgentSpec>;

type AgentSlug = keyof typeof AGENTS;

/** An Atlas territory's paths, the template's globs narrowed to one feature. */
function featurePaths(territory: string): string[] {
	return [`src/features/${territory}/**`, `src/app/${territory}/**`];
}

export function buildSeed(ids: IdGenerator): SeedRows {
	const rows: SeedRows = {
		agentTemplate: [],
		agentIdentityVersion: [],
		rosterPreset: [],
		playbook: [],
	};

	// Agent templates: the operator and the fifteen builder agents of
	// ROSTER-V2's name register, in AGENTS order. The first is SEED_MARKER_ID.
	const templateIds = new Map<AgentSlug, string>();
	for (const slug of Object.keys(AGENTS) as AgentSlug[]) {
		const a = AGENTS[slug];
		const id = ids.next();
		rows.agentTemplate.push({
			id,
			slug,
			name: a.name,
			title: a.title,
			kind: a.kind,
			roles: a.roles,
			engagementId: null,
			waveDefaults: a.waves,
			description: a.description,
			writablePaths: a.writablePaths,
			version: 1,
			createdAt: seededAt,
			updatedAt: seededAt,
		});
		templateIds.set(slug, id);
	}
	const tid = (slug: AgentSlug) => {
		const id = templateIds.get(slug);
		if (id === undefined) throw new Error(`seed: no template ${slug}`);
		return id;
	};

	// Canon, the project briefer (BE Main, 2026-10-19). Not a dispatch agent,
	// so it sits on no roster and has no waves; opening a Canon session
	// freezes this template's current identity version.
	const canonRoles = ["intake", "strategy"] as const;
	const canonTemplateId = ids.next();
	rows.agentTemplate.push({
		id: canonTemplateId,
		slug: "canon",
		name: "Canon",
		title: "Project briefer",
		kind: "horizontal",
		roles: [...canonRoles],
		engagementId: null,
		waveDefaults: [],
		description:
			"Briefs a project from the operator's documents: drafts the intake, asks what it cannot decide, and proposes what the client's memory should keep. Writes no files and is never dispatched.",
		writablePaths: [],
		version: 1,
		createdAt: seededAt,
		updatedAt: seededAt,
	});

	// Identities, generated as the regenerate route would: version 1 for
	// every model agent and Canon. The operator's human role gets none. No
	// skills are seeded, so none is attached.
	const addVersion = (
		templateId: string,
		input: Parameters<typeof generateIdentity>[0],
	) => {
		const generated = generateIdentity(input);
		if ("refused" in generated) {
			throw new Error(`seed: identity for ${input.slug}: ${generated.refused}`);
		}
		rows.agentIdentityVersion.push({
			id: ids.next(),
			agentTemplateId: templateId,
			number: 1,
			identityMd: generated.identityMd,
			depthMd: generated.depthMd,
			sha256: generated.sha256,
			identityTokens: generated.identityTokens,
			depthTokens: generated.depthTokens,
			inputs: generated.inputs,
			generatedBy: null,
			createdAt: seededAt,
		});
	};
	for (const slug of Object.keys(AGENTS) as AgentSlug[]) {
		if (slug === "operator") continue;
		const a = AGENTS[slug];
		addVersion(tid(slug), {
			slug,
			name: a.name,
			kind: a.kind,
			roles: a.roles,
			writablePaths: a.writablePaths,
			roleSkills: [],
		});
	}
	addVersion(canonTemplateId, {
		slug: "canon",
		name: "Canon",
		kind: "horizontal",
		roles: [...canonRoles],
		writablePaths: [],
		roleSkills: [],
	});

	// The template-booking presets. A preset uses one cut, never both: Atlas
	// and Leonora both hold schema and contract. The vertical default has one
	// Atlas per booking feature (TEMPLATE-BOOKING.md) and none of the six
	// layer builders.
	const atlasFor = (territory: string, estimate: number) => ({
		agent_template_id: tid("atlas"),
		waves: ["B" as const],
		territory,
		writable_paths: featurePaths(territory),
		estimated_tokens: estimate,
	});
	const presetAgent = (slug: AgentSlug, estimate?: number) => ({
		agent_template_id: tid(slug),
		waves: AGENTS[slug].waves,
		...(estimate === undefined ? {} : { estimated_tokens: estimate }),
	});
	const vertical = ids.next();
	rows.rosterPreset.push(
		{
			id: vertical,
			name: "Full build · vertical",
			description:
				"The operator and the shared agents, one Atlas per feature, then tests and review.",
			cut: "vertical",
			agents: [
				presetAgent("operator"),
				presetAgent("fantem", 40_000),
				presetAgent("fenn", 30_000),
				atlasFor("accounts", 120_000),
				atlasFor("scheduling", 200_000),
				atlasFor("notifications", 90_000),
				presetAgent("iyo", 60_000),
				presetAgent("nemi", 60_000),
				presetAgent("raze", 40_000),
				presetAgent("brennan", 30_000),
				presetAgent("zane", 40_000),
				presetAgent("kodie", 30_000),
			],
			version: 1,
			createdAt: seededAt,
			updatedAt: seededAt,
		},
		{
			id: ids.next(),
			name: "Full build · horizontal",
			description:
				"The operator and one agent per layer across every feature, then tests and review.",
			cut: "horizontal",
			agents: [
				presetAgent("operator"),
				presetAgent("leonora", 60_000),
				presetAgent("fantem", 40_000),
				presetAgent("fenn", 30_000),
				presetAgent("kel", 90_000),
				presetAgent("dunn", 90_000),
				presetAgent("gat", 50_000),
				presetAgent("ghost", 60_000),
				presetAgent("leon", 120_000),
				presetAgent("iyo", 60_000),
				presetAgent("nemi", 60_000),
				presetAgent("raze", 40_000),
				presetAgent("brennan", 30_000),
				presetAgent("zane", 40_000),
				presetAgent("kodie", 30_000),
			],
			version: 1,
			createdAt: seededAt,
			updatedAt: seededAt,
		},
	);

	// The template-booking playbook, with the vertical preset as its default.
	// A template's playbook is keyed by the template's slug (DECISIONS-V2,
	// 2026-10-12).
	rows.playbook.push({
		id: ids.next(),
		missionType: "template-booking",
		name: "Booking template",
		wavesApplicable: ["A", "B", "C", "D", "E"],
		gates: [
			// No phase1-close until something produces its evidence (J, 2026-10-21).
			{ gate: "qa", policy: "mandatory" },
			{ gate: "security", policy: "warn" },
			{ gate: "acceptance", policy: "mandatory" },
		],
		deliverable: "pr",
		requiredFields: ["brief", "repo_url"],
		defaultPresetId: vertical,
		version: 1,
		createdAt: seededAt,
		updatedAt: seededAt,
	});

	return rows;
}
