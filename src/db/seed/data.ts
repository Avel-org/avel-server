import { createHash } from "node:crypto";
import type { Brief } from "../../contract/intake";
import { fixedClock } from "../../lib/clock";
import { generateIdentity, type IdentitySkill } from "../../lib/identity";
import type { IdGenerator } from "../../lib/ids";
import { PRICE_VERSION } from "../../lib/prices";
import { skillContentSha256 } from "../../lib/skill-hash";
import { DEV_BOOKING_SHA } from "../../lib/templates";
import { skillsSha256 } from "../../runner/skills";
import type {
	activityLog,
	agentIdentityVersion,
	agentTemplate,
	client,
	completionReport,
	connection,
	dispatch,
	engagement,
	exportTable,
	mission,
	playbook,
	roleSkills,
	rosterEntry,
	rosterPreset,
	skill,
	skillSource,
	user,
} from "../schema";

/**
 * The dev seed's rows. Pure: the same ids and the same epoch give the same
 * rows, byte for byte. Every name is fictional; there is no client data here.
 */

/** Day 0 of the seed. Every time is a fixed offset from it, never "now". */
export const SEED_EPOCH = "2026-09-07T09:00:00.000Z";
const epoch = fixedClock(SEED_EPOCH).now().getTime();
const HOUR = 3_600_000;

/** A time `d` days and `h` hours after the epoch. */
function at(d: number, h = 0) {
	return new Date(epoch + d * 24 * HOUR + h * HOUR);
}

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

/**
 * The seed operator: one user every seeded operator act names, so seeded
 * activity reads as the operator's, as the product writes it. It has no
 * account and no session, so nothing can sign in as it, and GitHub id 0,
 * which no GitHub account has, so it can never match the allowlist. On
 * avel_dev, J's real sign-in creates its own user row beside it. Its id is
 * fixed rather than drawn, so every seed id drawn below stays where it was.
 */
export const SEED_OPERATOR_ID = seedId(900_000);
export const SEED_OPERATOR_GITHUB_ID = "0";

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

/** The first id seedIds() hands out: the first client. Its presence means "already seeded". */
export const SEED_MARKER_ID = seedId(1);

export const SEED_REQUEST_ID = "seed";

/** The template-booking commit the seeded missions were built from: the dev fixture's head. */
export const BOOKING_TEMPLATE_SHA = DEV_BOOKING_SHA;

type Row<T extends { $inferInsert: unknown }> = T["$inferInsert"];

export interface SeedRows {
	/** One row: the seed operator. */
	user: Row<typeof user>[];
	client: Row<typeof client>[];
	engagement: Row<typeof engagement>[];
	connection: Row<typeof connection>[];
	agentTemplate: Row<typeof agentTemplate>[];
	agentIdentityVersion: Row<typeof agentIdentityVersion>[];
	rosterPreset: Row<typeof rosterPreset>[];
	playbook: Row<typeof playbook>[];
	mission: Row<typeof mission>[];
	rosterEntry: Row<typeof rosterEntry>[];
	export: Row<typeof exportTable>[];
	activityLog: Row<typeof activityLog>[];
	skillSource: Row<typeof skillSource>[];
	skill: Row<typeof skill>[];
	roleSkills: Row<typeof roleSkills>[];
	dispatch: Row<typeof dispatch>[];
	completionReport: Row<typeof completionReport>[];
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

/**
 * Two templates edited after their first identity, so the catalog shows both
 * later states. Kel's paths grew and Kel was regenerated: v2, current. Raze's
 * path was renamed and nobody regenerated: v1, stale on writablePaths.
 */
const TEMPLATE_EDITS: Partial<
	Record<
		AgentSlug,
		{ day: number; before: { writablePaths: string[] }; regenerated: boolean }
	>
> = {
	kel: {
		day: 8,
		before: { writablePaths: ["services/**"] },
		regenerated: true,
	},
	raze: {
		day: 9,
		before: { writablePaths: ["tests/properties/**"] },
		regenerated: false,
	},
};

/** An Atlas territory's paths, the template's globs narrowed to one feature. */
function featurePaths(territory: string): string[] {
	return [`src/features/${territory}/**`, `src/app/${territory}/**`];
}

type MissionStatus = Row<typeof mission>["status"];
type ExportStatus = Row<typeof exportTable>["status"];

/**
 * `runAt` is when the seed runs. Only running dispatches are timed from
 * it, so a run's wall clock reads as minutes in, not days; every other
 * time is a fixed offset from SEED_EPOCH.
 */
export function buildSeed(ids: IdGenerator, runAt: Date): SeedRows {
	const rows: SeedRows = {
		user: [
			{
				id: SEED_OPERATOR_ID,
				name: "Seed operator",
				email: "seed-operator@example.com",
				emailVerified: false,
				image: null,
				githubId: SEED_OPERATOR_GITHUB_ID,
				githubLogin: "seed-operator",
				createdAt: at(0),
				updatedAt: at(0),
			},
		],
		client: [],
		engagement: [],
		connection: [],
		agentTemplate: [],
		agentIdentityVersion: [],
		rosterPreset: [],
		playbook: [],
		mission: [],
		rosterEntry: [],
		export: [],
		activityLog: [],
		skillSource: [],
		skill: [],
		roleSkills: [],
		dispatch: [],
		completionReport: [],
	};

	const log = (
		when: Date,
		action: Row<typeof activityLog>["action"],
		entityType: Row<typeof activityLog>["entityType"],
		entityId: string,
		payload: Record<string, unknown>,
		scope: { missionId?: string | null; engagementId?: string | null } = {},
		/**
		 * Who wrote it: the seed operator by default, as the product's
		 * operator routes would; the runner for its own acts; or an agent's
		 * own write, by its roster entry.
		 */
		actor: "operator" | "runner" | { agent: string } = "operator",
	) => {
		rows.activityLog.push({
			id: ids.next(),
			at: when,
			actorKind:
				actor === "operator"
					? "operator"
					: actor === "runner"
						? "system"
						: "agent",
			actorUserId: actor === "operator" ? SEED_OPERATOR_ID : null,
			actorRosterEntryId: typeof actor === "object" ? actor.agent : null,
			action,
			entityType,
			entityId,
			missionId: scope.missionId ?? null,
			engagementId: scope.engagementId ?? null,
			requestId: SEED_REQUEST_ID,
			payload: { seed: true, ...payload },
		});
	};

	// Clients. The first id is SEED_MARKER_ID.
	const addClient = (
		name: string,
		status: "active" | "closed",
		day: number,
		closedDay?: number,
	) => {
		const id = ids.next();
		rows.client.push({
			id,
			name,
			status,
			primaryContact: null,
			notesMd: null,
			createdAt: at(day),
			updatedAt: at(closedDay ?? day),
		});
		log(at(day), "client.created", "client", id, { name });
		return id;
	};
	const halvorsen = addClient("Halvorsen & Pike", "active", 0);
	const brightwater = addClient("Brightwater Clinics", "active", 0);
	const larchmont = addClient("Larchmont Freight", "closed", 0, 20);

	// Engagements. One closed, which revokes its connection.
	const addEngagement = (
		clientId: string,
		name: string,
		day: number,
		closedDay?: number,
	) => {
		const id = ids.next();
		rows.engagement.push({
			id,
			clientId,
			name,
			scopeMd: null,
			status: closedDay === undefined ? "active" : "closed",
			startedAt: at(day),
			closedAt: closedDay === undefined ? null : at(closedDay),
			createdAt: at(day),
			updatedAt: at(closedDay ?? day),
		});
		log(
			at(day, 1),
			"engagement.created",
			"engagement",
			id,
			{ name },
			{ engagementId: id },
		);
		return id;
	};
	const portal = addEngagement(halvorsen, "Client portal", 0);
	const billing = addEngagement(halvorsen, "Billing rebuild", 3);
	const booking = addEngagement(brightwater, "Booking app", 1);
	const routes = addEngagement(larchmont, "Route planner", 0, 20);
	log(
		at(20),
		"engagement.closed",
		"engagement",
		routes,
		{},
		{ engagementId: routes },
	);

	// Connections. The token is never stored; credential_ref names an env var.
	const addConnection = (
		engagementId: string | null,
		label: string,
		scopeType: "owner" | "repo",
		scopeValue: string,
		revokedDay?: number,
	) => {
		const id = ids.next();
		rows.connection.push({
			id,
			service: "github",
			label,
			scopeType,
			scopeValue,
			credentialRef: "GITHUB_TOKEN",
			status: revokedDay === undefined ? "active" : "revoked",
			engagementId,
			expiresAt: null,
			lastRotatedAt: null,
			revokedAt: revokedDay === undefined ? null : at(revokedDay),
			createdAt: at(0),
			updatedAt: at(revokedDay ?? 0),
		});
		return id;
	};
	const portalRepo = addConnection(
		portal,
		"Halvorsen portal",
		"repo",
		"halvorsen-pike/portal",
	);
	addConnection(billing, "Halvorsen billing", "repo", "halvorsen-pike/billing");
	const bookingRepo = addConnection(
		booking,
		"Brightwater booking",
		"repo",
		"brightwater-clinics/booking",
	);
	const routesRepo = addConnection(
		routes,
		"Larchmont routes",
		"repo",
		"larchmont-freight/routes",
		20,
	);
	addConnection(null, "AVEL internal", "owner", "avel-org");
	log(
		at(20, 1),
		"connection.revoked",
		"connection",
		routesRepo,
		{ reason: "engagement closed" },
		{ engagementId: routes },
	);

	// Agent templates: the operator and the fifteen builder agents of
	// ROSTER-V2's name register. These five keep the ids the seed first gave
	// them; the other eleven are added last, so no later seed id moves.
	const templateIds = new Map<AgentSlug, string>();
	const addTemplate = (slug: AgentSlug) => {
		const a = AGENTS[slug];
		const id = ids.next();
		const edit = TEMPLATE_EDITS[slug];
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
			version: edit ? 2 : 1,
			createdAt: at(0),
			updatedAt: at(edit?.day ?? 0),
		});
		templateIds.set(slug, id);
		return id;
	};
	const operator = addTemplate("operator");
	const atlas = addTemplate("atlas");
	const nemi = addTemplate("nemi");
	const fenn = addTemplate("fenn");
	const zane = addTemplate("zane");

	// The template-booking playbook and its default preset. A template's
	// playbook is keyed by the template's slug (DECISIONS-V2, 2026-10-12).
	// The preset's agents are filled in once every template has an id.
	const preset = ids.next();
	const verticalAgents: Row<typeof rosterPreset>["agents"] = [];
	rows.rosterPreset.push({
		id: preset,
		name: "Full build · vertical",
		description:
			"The operator and the shared agents, one Atlas per feature, then tests and review.",
		cut: "vertical",
		agents: verticalAgents,
		version: 1,
		createdAt: at(0),
		updatedAt: at(0),
	});
	rows.playbook.push({
		id: ids.next(),
		missionType: "template-booking",
		name: "Booking template",
		wavesApplicable: ["A", "B", "C", "D", "E"],
		gates: [
			{ gate: "phase1-close", policy: "mandatory" },
			{ gate: "qa", policy: "mandatory" },
			{ gate: "security", policy: "warn" },
			{ gate: "acceptance", policy: "mandatory" },
		],
		deliverable: "pr",
		requiredFields: ["brief", "repo_url"],
		defaultPresetId: preset,
		version: 1,
		createdAt: at(0),
		updatedAt: at(0),
	});

	// Missions: every status, both origins. Internal missions have no engagement.
	const addMission = (m: {
		engagementId: string | null;
		repo: string;
		sprint: number;
		summary: string;
		created: number;
		/** Status changes after draft, as [status, day], and "runner" when the runner made it. */
		path: [MissionStatus, number, "runner"?][];
		deletedDay?: number;
		spendCeilingUsd?: string;
		/** A shaped brief. Without one the mission stores only its summary. */
		brief?: Brief;
		type?: string;
	}) => {
		const id = ids.next();
		const last = m.path.at(-1);
		const status: MissionStatus = last ? last[0] : "draft";
		const touched = m.deletedDay ?? (last ? last[1] : m.created);
		rows.mission.push({
			id,
			engagementId: m.engagementId,
			origin: m.engagementId === null ? "internal" : "client",
			// Built from template-booking unless a type is given; a templated
			// mission's type is its template_ref.
			type: m.type ?? "template-booking",
			templateRef: m.type === undefined ? "template-booking" : null,
			templateVersion: m.type === undefined ? BOOKING_TEMPLATE_SHA : null,
			brief: m.brief ?? { summary: m.summary },
			sprintN: m.sprint,
			status,
			cut: "vertical",
			cutSource: "derived",
			cutRationale: null,
			repoUrl: `https://github.com/${m.repo}`,
			spendCeilingUsd: m.spendCeilingUsd ?? null,
			deletedAt: m.deletedDay === undefined ? null : at(m.deletedDay),
			createdAt: at(m.created),
			updatedAt: at(touched),
		});
		const scope = { missionId: id, engagementId: m.engagementId };
		log(
			at(m.created, 2),
			"mission.created",
			"mission",
			id,
			{ sprint: m.sprint },
			scope,
		);
		let from: MissionStatus = "draft";
		for (const [to, day, by] of m.path) {
			log(
				at(day, 3),
				"mission.status_changed",
				"mission",
				id,
				{ from, to },
				scope,
				by ?? "operator",
			);
			from = to;
		}
		return id;
	};
	const portal1 = addMission({
		engagementId: portal,
		repo: "halvorsen-pike/portal",
		sprint: 1,
		summary: "Sign-in and account pages.",
		created: 1,
		path: [
			["active", 2],
			["shipped", 9],
		],
	});
	const portal2 = addMission({
		engagementId: portal,
		repo: "halvorsen-pike/portal",
		sprint: 2,
		summary: "Document upload and sharing.",
		created: 10,
		path: [["active", 11]],
	});
	addMission({
		engagementId: portal,
		repo: "halvorsen-pike/portal",
		sprint: 3,
		summary: "Notifications.",
		created: 24,
		path: [],
		// A plan half written: R3 is in no module yet and has no check, so the
		// check fails twice over.
		brief: {
			summary: "Notifications.",
			requirements: [
				{ id: "R1", text: "A user gets an email when a document is shared" },
				{ id: "R2", text: "A user can turn each notification off" },
				{ id: "R3", text: "Notifications are batched into a daily digest" },
			],
			acceptanceCriteria: [
				{ id: "AC1", requirementId: "R1", text: "Sharing sends one email" },
				{ id: "AC2", requirementId: "R2", text: "A muted kind sends nothing" },
				{ id: "AC3", requirementId: "R3", text: "One digest a day, at most" },
			],
			modules: [
				{
					id: "M1",
					name: "Delivery",
					requirementIds: ["R1"],
					reads: ["src/notifications/**", "src/documents/share.ts"],
				},
				{
					id: "M2",
					name: "Preferences",
					requirementIds: ["R2"],
					reads: ["src/settings/**"],
				},
			],
			checks: [
				{
					id: "CK1",
					requirementId: "R1",
					kind: "test",
					command: "pnpm vitest run tests/notifications/share-email.test.ts",
				},
				{
					id: "CK2",
					requirementId: "R2",
					kind: "test",
					command: "pnpm vitest run tests/settings/mute.test.ts",
				},
			],
		},
	});
	addMission({
		engagementId: billing,
		repo: "halvorsen-pike/billing",
		sprint: 1,
		summary: "Invoice generation.",
		created: 5,
		path: [
			["active", 6],
			["halted", 15],
		],
		spendCeilingUsd: "250.00",
	});
	const booking1 = addMission({
		engagementId: booking,
		repo: "brightwater-clinics/booking",
		sprint: 1,
		summary: "Appointment booking.",
		created: 2,
		path: [
			["active", 3],
			["shipped", 12],
		],
	});
	const booking2 = addMission({
		engagementId: booking,
		repo: "brightwater-clinics/booking",
		sprint: 2,
		summary: "Reminders and rescheduling.",
		created: 13,
		path: [["active", 14]],
	});
	const routes1 = addMission({
		engagementId: routes,
		repo: "larchmont-freight/routes",
		sprint: 1,
		summary: "Route import.",
		created: 1,
		path: [
			["active", 2],
			["shipped", 10],
			["archived", 21],
		],
	});
	addMission({
		engagementId: routes,
		repo: "larchmont-freight/routes",
		sprint: 2,
		summary: "Driver assignment.",
		created: 11,
		path: [
			["active", 12],
			["shipped", 18],
		],
	});
	const internal1 = addMission({
		engagementId: null,
		repo: "avel-org/template-booking",
		sprint: 1,
		summary: "Booking template build.",
		created: 0,
		path: [
			["active", 1],
			["shipped", 6],
		],
	});
	const internal2 = addMission({
		engagementId: null,
		repo: "avel-org/template-booking",
		sprint: 2,
		summary: "Template: payments.",
		created: 16,
		path: [["active", 17]],
	});
	addMission({
		engagementId: null,
		repo: "avel-org/template-crm",
		sprint: 1,
		summary: "CRM template.",
		created: 26,
		path: [],
	});
	addMission({
		engagementId: null,
		repo: "avel-org/template-crm",
		sprint: 1,
		summary: "CRM template spike.",
		created: 19,
		path: [
			["active", 19],
			["halted", 20],
		],
	});
	// Soft-deleted: no list may show it.
	addMission({
		engagementId: portal,
		repo: "halvorsen-pike/portal",
		sprint: 3,
		summary: "Duplicate of sprint 3.",
		created: 22,
		path: [],
		deletedDay: 23,
	});

	// Roster entries, some inactive. Every mission here is a vertical cut, so
	// Atlas carries a territory and that feature's paths (ROSTER-V2, Naming).
	const addEntries = (
		missionId: string,
		day: number,
		entries: [
			string,
			Row<typeof rosterEntry>["waves"],
			boolean,
			number | null,
			territory?: string,
		][],
	) => {
		for (const [templateId, waves, active, estimate, territory] of entries) {
			rows.rosterEntry.push({
				id: ids.next(),
				missionId,
				agentTemplateId: templateId,
				active,
				waves,
				customizedMd: null,
				writablePaths: territory === undefined ? null : featurePaths(territory),
				territory: territory ?? null,
				estimatedTokens: estimate,
				tokenSoftCeiling: estimate === null ? null : Math.round(estimate * 1.5),
				tokenHardCeiling: estimate === null ? null : estimate * 3,
				grain: "default",
				absorbedBoundaries: [],
				createdAt: at(day),
				updatedAt: at(day),
			});
		}
	};
	addEntries(portal1, 1, [
		[atlas, ["B"], true, 80_000, "accounts"],
		[nemi, ["C"], true, 150_000],
		[fenn, ["A"], true, 90_000],
		[zane, ["D"], true, 40_000],
	]);
	addEntries(portal2, 10, [
		[atlas, ["B"], true, 60_000, "documents"],
		[nemi, ["C"], true, 160_000],
		[fenn, ["A"], true, 90_000],
		[zane, ["D"], false, null],
	]);
	addEntries(booking2, 13, [
		[atlas, ["B"], true, 70_000, "scheduling"],
		[nemi, ["C"], true, 140_000],
		[fenn, ["A"], false, null],
		[zane, ["D"], true, 40_000],
	]);
	addEntries(internal2, 16, [
		[operator, ["A"], true, null],
		[atlas, ["B"], true, 50_000, "payments"],
		[nemi, ["C"], true, 120_000],
	]);

	// Exports: previewed, pr-open, done, failed and closed.
	const addExport = (x: {
		missionId: string;
		sprint: number;
		target: Row<typeof exportTable>["targetKind"];
		connectionId: string | null;
		status: ExportStatus;
		day: number;
		endDay: number;
		dryRun?: boolean;
		previewOf?: string;
		prStatus?: string;
		rendered?: string;
	}) => {
		const id = ids.next();
		rows.export.push({
			id,
			missionId: x.missionId,
			sprintN: x.sprint,
			idempotencyKey: `seed-${id}`,
			targetKind: x.target,
			connectionId: x.connectionId,
			status: x.status,
			// The same moment as its export.status_changed activity row below.
			statusChangedAt: at(x.endDay, 5),
			prStatus: x.prStatus ?? null,
			dryRun: x.dryRun ?? false,
			previewExportId: x.previewOf ?? null,
			baseRef: x.target === "zip" ? null : "main",
			baseCommitSha: x.target === "zip" ? null : "0".repeat(40),
			packageSha256: x.rendered === undefined ? null : x.rendered.repeat(64),
			packageHashVersion: x.rendered === undefined ? null : 1,
			createdAt: at(x.day),
			updatedAt: at(x.endDay, 5),
		});
		const scope = { missionId: x.missionId, engagementId: null };
		log(
			at(x.day, 4),
			"export.created",
			"export",
			id,
			{ target: x.target },
			scope,
		);
		// The export engine moves an export's status, not a person, so these
		// rows are the system's ("AVEL runner" until an export engine exists).
		log(
			at(x.endDay, 5),
			"export.status_changed",
			"export",
			id,
			{ to: x.status },
			scope,
			"runner",
		);
		return id;
	};
	const portal1Preview = addExport({
		missionId: portal1,
		sprint: 1,
		target: "github_pr",
		connectionId: portalRepo,
		status: "previewed",
		day: 8,
		endDay: 8,
		dryRun: true,
		rendered: "a",
	});
	addExport({
		missionId: portal1,
		sprint: 1,
		target: "github_pr",
		connectionId: portalRepo,
		status: "done",
		day: 8,
		endDay: 9,
		previewOf: portal1Preview,
		prStatus: "merged",
		rendered: "a",
	});
	addExport({
		missionId: portal2,
		sprint: 2,
		target: "github_pr",
		connectionId: portalRepo,
		status: "previewed",
		day: 24,
		endDay: 24,
		dryRun: true,
		rendered: "b",
	});
	addExport({
		missionId: booking1,
		sprint: 1,
		target: "github_pr",
		connectionId: bookingRepo,
		status: "pr-open",
		day: 12,
		endDay: 12,
		prStatus: "open",
		rendered: "c",
	});
	addExport({
		missionId: booking2,
		sprint: 2,
		target: "github_pr",
		connectionId: bookingRepo,
		status: "failed",
		day: 25,
		endDay: 25,
	});
	addExport({
		missionId: routes1,
		sprint: 1,
		target: "github_pr",
		connectionId: routesRepo,
		status: "closed",
		day: 9,
		endDay: 10,
		prStatus: "closed",
		rendered: "d",
	});
	addExport({
		missionId: internal1,
		sprint: 1,
		target: "zip",
		connectionId: null,
		status: "done",
		day: 6,
		endDay: 6,
		rendered: "e",
	});

	// Added last, so every earlier seed id stays where it was. A playbook
	// declaring no waves, and a draft of its type: coherence blocks it with
	// wave null (fails closed).
	rows.playbook.push({
		id: ids.next(),
		missionType: "discovery",
		name: "Discovery (no waves declared)",
		wavesApplicable: [],
		gates: [],
		deliverable: "recommendation",
		requiredFields: ["brief"],
		defaultPresetId: preset,
		version: 1,
		createdAt: at(0),
		updatedAt: at(0),
	});
	addMission({
		engagementId: null,
		repo: "avel-org/discovery",
		sprint: 1,
		summary: "Discovery: what a firm needs first.",
		created: 27,
		path: [],
		type: "discovery",
	});

	// Added last, so every earlier seed id stays where it was. The skill
	// catalog: one source of each kind, and skills across the three layers,
	// both types and every status. No skill names a reviewer, approved ones
	// included: the seed operator reviews nothing. No role_skills or
	// mission_skills rows.
	const addSource = (
		name: string,
		kind: Row<typeof skillSource>["kind"],
		url: string | null,
		license: string | null,
	) => {
		const id = ids.next();
		rows.skillSource.push({
			id,
			name,
			kind,
			url,
			license,
			deletedAt: null,
			createdAt: at(1),
			updatedAt: at(1),
		});
		return id;
	};
	const house = addSource("AVEL house skills", "internal", null, null);
	const quillstone = addSource(
		"Quillstone Tools",
		"vendor",
		"https://quillstone.example/skills",
		"Proprietary",
	);
	const commons = addSource(
		"Open Ledger Commons",
		"community",
		"https://commons.example/skills",
		"MIT",
	);

	const addSkill = (s: {
		slug: string;
		name: string;
		description: string;
		contentMd: string;
		avelEnhancementMd?: string;
		layer: Row<typeof skill>["layer"];
		capability?: {
			grants: string[];
			ioShape: { reads: "large" | "small"; returns: "large" | "small" };
		};
		recommendedFor: Row<typeof skill>["recommendedFor"];
		sourceId: string;
		status: Row<typeof skill>["status"];
		day: number;
		endDay?: number;
	}) => {
		// The same fields and hash as POST /api/skills writes.
		const hashed = {
			description: s.description,
			contentMd: s.contentMd,
			avelEnhancementMd: s.avelEnhancementMd ?? null,
			grants: s.capability?.grants ?? null,
			ioShape: s.capability?.ioShape ?? null,
			type: s.capability ? ("capability" as const) : ("knowledge" as const),
			layer: s.layer,
		};
		const id = ids.next();
		rows.skill.push({
			id,
			slug: s.slug,
			name: s.name,
			...hashed,
			recommendedFor: s.recommendedFor,
			sourceId: s.sourceId,
			contentSha256: skillContentSha256(hashed),
			status: s.status,
			reviewedBy: null,
			reviewedAt: null,
			version: 1,
			deletedAt: null,
			createdAt: at(s.day),
			updatedAt: at(s.endDay ?? s.day),
		});
		return id;
	};
	const contractFirst = addSkill({
		slug: "contract-first-api",
		name: "Contract-first API",
		description: "Write the route's shapes before its handler.",
		contentMd:
			"# Contract-first API\n\nDefine the request and response shapes, then build the handler against them.",
		avelEnhancementMd:
			"Every shape lives in the contract package. A handler never returns an off-contract body.",
		layer: "role",
		recommendedFor: ["api-surface", "contract"],
		sourceId: house,
		status: "approved",
		day: 2,
	});
	const migrationRunner = addSkill({
		slug: "schema-migration-runner",
		name: "Schema migration runner",
		description: "Generate and apply one forward-only migration.",
		contentMd:
			"# Schema migration runner\n\nGenerate the migration, read it, then apply it to a scratch database first.",
		layer: "role",
		capability: {
			grants: ["db:migrate"],
			ioShape: { reads: "small", returns: "small" },
		},
		recommendedFor: ["schema"],
		sourceId: house,
		status: "draft",
		day: 3,
	});
	addSkill({
		slug: "postgres-index-review",
		name: "Postgres index review",
		description: "Check every list query has an index that serves it.",
		contentMd:
			"# Postgres index review\n\nRun EXPLAIN on each list query and add the index its filter and order need.",
		layer: "stack",
		recommendedFor: ["schema", "performance"],
		sourceId: quillstone,
		status: "approved",
		day: 3,
	});
	addSkill({
		slug: "browser-flow-recorder",
		name: "Browser flow recorder",
		description: "Record a user flow and replay it as a test.",
		contentMd:
			"# Browser flow recorder\n\nRecord the flow once, then replay it on every change and compare.",
		layer: "stack",
		capability: {
			grants: ["browser:read", "fs:write-tests"],
			ioShape: { reads: "large", returns: "small" },
		},
		recommendedFor: ["frontend-tests", "accessibility"],
		sourceId: quillstone,
		status: "approved",
		day: 4,
	});
	addSkill({
		slug: "booking-holds",
		name: "Booking holds",
		description: "Hold a slot while payment completes, then release it.",
		contentMd:
			"# Booking holds\n\nA hold expires on its own. Payment converts it, and nothing else does.",
		layer: "domain",
		recommendedFor: ["domain"],
		sourceId: commons,
		status: "retired",
		day: 4,
		endDay: 20,
	});
	addSkill({
		slug: "invoice-rounding",
		name: "Invoice rounding",
		description: "Round once, at the invoice total, never per line.",
		contentMd:
			"# Invoice rounding\n\nKeep line amounts exact. Round the total once, half to even.",
		layer: "domain",
		recommendedFor: ["domain", "backend-tests"],
		sourceId: commons,
		status: "draft",
		day: 5,
	});

	// Added last, so every earlier seed id stays where it was. An approved
	// role-layer capability with a read grant and a write grant, and
	// role_skills rows, so the agents holding schema (Atlas, Leonora) show
	// tool rows on the access route. The draft runner is attached too and shows nothing:
	// only approved skills are delivered.
	const inspector = addSkill({
		slug: "schema-inspector",
		name: "Schema inspector",
		description: "Read the live schema, then apply one migration.",
		contentMd:
			"# Schema inspector\n\nRead the tables before changing them. Apply one forward-only migration.",
		layer: "role",
		capability: {
			grants: ["db:read", "db:migrate"],
			ioShape: { reads: "small", returns: "small" },
		},
		recommendedFor: ["schema"],
		sourceId: house,
		status: "approved",
		day: 6,
	});
	rows.roleSkills.push(
		{ role: "schema", skillId: inspector },
		{ role: "schema", skillId: migrationRunner },
		{ role: "contract", skillId: contractFirst },
	);

	// Added last, so every earlier seed id stays where it was: the other
	// eleven agents of the corrected roster.
	for (const slug of Object.keys(AGENTS) as AgentSlug[]) {
		if (!templateIds.has(slug)) addTemplate(slug);
	}
	const tid = (slug: AgentSlug) => {
		const id = templateIds.get(slug);
		if (id === undefined) throw new Error(`seed: no template ${slug}`);
		return id;
	};

	// A preset uses one cut, never both: Atlas and Leonora both hold schema
	// and contract. The vertical default has one Atlas per booking feature
	// (TEMPLATE-BOOKING.md) and none of the six layer builders.
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
	verticalAgents.push(
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
	);
	rows.rosterPreset.push({
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
		createdAt: at(0),
		updatedAt: at(0),
	});

	// Booking sprint 2's builder moved to wave B, so the operator staffs
	// wave A and the mission is not blocked (no_agents_in_first_wave).
	addEntries(booking2, 13, [[operator, ["A"], true, null]]);

	// Identities, generated as the regenerate route would: version 1 for each
	// of the fifteen model agents, Kel's version 2 after its path edit, and
	// Raze left stale. The operator's human role gets none.
	const attachedSkills = (roles: readonly string[]): IdentitySkill[] => {
		const skillIds = new Set(
			rows.roleSkills
				.filter((r) => roles.includes(r.role))
				.map((r) => r.skillId),
		);
		return rows.skill
			.filter((s) => skillIds.has(s.id))
			.map((s) => ({
				id: s.id,
				slug: s.slug,
				name: s.name,
				description: s.description,
				contentMd: s.contentMd,
				avelEnhancementMd: s.avelEnhancementMd ?? null,
				contentSha256: s.contentSha256,
				status: s.status ?? "draft",
			}));
	};
	const addVersion = (
		slug: AgentSlug,
		number: number,
		writablePaths: string[],
		when: Date,
	) => {
		const a = AGENTS[slug];
		const generated = generateIdentity({
			slug,
			name: a.name,
			kind: a.kind,
			roles: a.roles,
			writablePaths,
			roleSkills: attachedSkills(a.roles),
		});
		if ("refused" in generated) {
			throw new Error(`seed: identity for ${slug}: ${generated.refused}`);
		}
		const id = ids.next();
		rows.agentIdentityVersion.push({
			id,
			agentTemplateId: tid(slug),
			number,
			identityMd: generated.identityMd,
			depthMd: generated.depthMd,
			sha256: generated.sha256,
			identityTokens: generated.identityTokens,
			depthTokens: generated.depthTokens,
			inputs: generated.inputs,
			generatedBy: null,
			createdAt: when,
		});
		log(
			when,
			"agent_template.identity_regenerated",
			"agent_template",
			tid(slug),
			{
				number,
				sha256: generated.sha256,
			},
		);
	};
	for (const slug of Object.keys(AGENTS) as AgentSlug[]) {
		if (slug === "operator") continue;
		const edit = TEMPLATE_EDITS[slug];
		addVersion(
			slug,
			1,
			edit?.before.writablePaths ?? AGENTS[slug].writablePaths,
			at(1),
		);
		if (edit?.regenerated) {
			addVersion(slug, 2, AGENTS[slug].writablePaths, at(edit.day, 1));
		}
	}

	// The edits themselves, as the PATCH logs them: sorted changed keys and
	// the version they produced, as the seed operator, who made them.
	for (const slug of Object.keys(AGENTS) as AgentSlug[]) {
		const edit = TEMPLATE_EDITS[slug];
		if (!edit) continue;
		log(at(edit.day), "agent_template.updated", "agent_template", tid(slug), {
			fields: ["writablePaths"],
			version: 2,
		});
	}

	// Added last, so every earlier seed id stays where it was. Module 6's
	// preview: one active client mission with a dispatch in every state, and
	// one halted by its spend ceiling. Dispatches are created and started by
	// the operator, so those rows are the seed operator's. Agent-filed
	// reports log as the agent; runner-filed ones, and every runner act,
	// log as system.
	const fakeSha = (label: string) =>
		createHash("sha256").update(`seed:${label}`, "utf8").digest("hex");
	const currentVersion = (slug: AgentSlug) => {
		const versions = rows.agentIdentityVersion.filter(
			(v) => v.agentTemplateId === tid(slug),
		);
		const latest = versions.reduce<(typeof versions)[number] | undefined>(
			(a, v) => (a === undefined || v.number > a.number ? v : a),
			undefined,
		);
		if (latest === undefined) throw new Error(`seed: no identity for ${slug}`);
		return latest;
	};
	// These missions attach no skills, so every started dispatch carries
	// the hash start freezes for an empty set (src/runner/skills.ts).
	const SEED_SKILLS_SHA256 = skillsSha256([]);

	const billing2 = addMission({
		engagementId: billing,
		repo: "halvorsen-pike/billing",
		sprint: 2,
		summary: "Payment plans.",
		created: 28,
		path: [["active", 29]],
		spendCeilingUsd: "40.00",
		brief: {
			summary: "Payment plans.",
			requirements: [
				{ id: "R1", text: "A customer can split an invoice into instalments" },
				{ id: "R2", text: "Each instalment has its own due date" },
				{
					id: "R3",
					text: "A customer is reminded before an instalment is due",
				},
			],
			acceptanceCriteria: [
				{
					id: "AC1",
					requirementId: "R1",
					text: "A plan's instalments sum to the invoice",
				},
				{
					id: "AC2",
					requirementId: "R2",
					text: "Every instalment shows its due date",
				},
				{
					id: "AC3",
					requirementId: "R3",
					text: "A reminder goes out three days before",
				},
			],
			modules: [
				{
					id: "M1",
					name: "Plans",
					requirementIds: ["R1", "R2"],
					reads: ["src/invoices/**", "prisma/schema.prisma"],
				},
				{
					id: "M2",
					name: "Reminders",
					requirementIds: ["R3"],
					reads: ["src/jobs/**", "src/email/templates/**"],
				},
			],
			checks: [
				{
					id: "CK1",
					requirementId: "R1",
					kind: "test",
					command: "pnpm vitest run tests/invoices/instalments.test.ts",
					note: "Instalments sum to the invoice total",
				},
				{
					id: "CK2",
					requirementId: "R1",
					kind: "typecheck",
					command: "pnpm tsc --noEmit",
				},
				{
					id: "CK3",
					requirementId: "R2",
					kind: "file_exists",
					path: "src/invoices/instalment-due-date.ts",
				},
				{
					id: "CK4",
					requirementId: "R2",
					kind: "test",
					command: "pnpm vitest run tests/invoices/due-dates.test.ts",
				},
				{
					id: "CK5",
					requirementId: "R3",
					kind: "command",
					command: "pnpm tsx scripts/reminders-dry-run.ts --days 3",
					note: "Lists the reminders due in three days without sending",
				},
			],
		},
	});
	const booking3 = addMission({
		engagementId: booking,
		repo: "brightwater-clinics/booking",
		sprint: 3,
		summary: "Waitlist.",
		created: 28,
		path: [
			["active", 29],
			["halted", 30, "runner"],
		],
		spendCeilingUsd: "15.00",
		brief: {
			summary: "Waitlist.",
			requirements: [
				{ id: "R1", text: "A patient can join the waitlist for a full day" },
			],
			acceptanceCriteria: [
				{
					id: "AC1",
					requirementId: "R1",
					text: "A freed slot is offered to the first patient waiting",
				},
			],
			modules: [
				{
					id: "M1",
					name: "Waitlist",
					requirementIds: ["R1"],
					reads: ["src/appointments/**"],
				},
			],
			checks: [
				{
					id: "CK1",
					requirementId: "R1",
					kind: "test",
					command: "pnpm vitest run tests/appointments/waitlist.test.ts",
				},
			],
		},
	});

	// Start runs readiness, which needs an estimate on every active entry it
	// could dispatch (DATA-CONTRACTS-V2, Mission, estimate_missing). The
	// operator's foundations entry is skipped, since a person is never
	// dispatched; its figure here is a planning number only.
	const entryIds = (missionId: string) =>
		rows.rosterEntry.filter((e) => e.missionId === missionId);
	addEntries(billing2, 28, [
		[operator, ["A"], true, 10_000],
		[tid("fenn"), ["A"], true, 30_000],
		[tid("fantem"), ["A"], true, 40_000],
		[atlas, ["B"], true, 120_000, "plans"],
		[atlas, ["B"], true, 90_000, "reminders"],
		[atlas, ["B"], true, 80_000, "statements"],
		[tid("iyo"), ["C"], true, 60_000],
		[nemi, ["C"], true, 60_000],
		[zane, ["D"], true, 40_000],
	]);
	addEntries(booking3, 28, [
		[operator, ["A"], true, 10_000],
		[tid("fenn"), ["A"], true, 30_000],
		[atlas, ["B"], true, 100_000, "waitlist"],
	]);
	const entryFor = (missionId: string, slug: AgentSlug, territory?: string) => {
		const e = entryIds(missionId).find(
			(r) =>
				r.agentTemplateId === tid(slug) &&
				(territory === undefined || r.territory === territory),
		);
		if (e === undefined) throw new Error(`seed: no entry ${slug} ${territory}`);
		return e;
	};

	type Split = [number, number, number, number];
	type ReportSpec = {
		filedBy: "agent" | "system";
		read?: { path: string; sha256: string }[];
		written?: { path: string; sha256: string }[];
		filesTouched?: number;
		fileTypesTouched?: string[];
		rereads?: number;
		blockers?: Row<typeof completionReport>["blockers"];
		edgeMismatches?: Row<typeof completionReport>["edgeMismatches"];
	};
	const addDispatch = (d: {
		missionId: string;
		engagementId: string;
		slug: AgentSlug;
		territory?: string;
		briefRef: { moduleId: string; requirementIds: string[] } | null;
		status: Row<typeof dispatch>["status"];
		haltReason?: Row<typeof dispatch>["haltReason"];
		/** [tokens_in, tokens_out, cache_read, cache_write]. */
		split?: Split;
		/**
		 * Seed only: fake-harness prices every token at 0, so these are set
		 * directly to plausible numbers. Real spend comes from the runner.
		 */
		spendUsd?: string;
		wallClockMinutes: number;
		day: number;
		created: number;
		started?: number;
		softCrossedAt?: number;
		ended?: number;
		/**
		 * Running only: minutes before runAt, in place of day and hours, so
		 * the run reads as in progress whenever the seed runs.
		 */
		minutesAgo?: { created: number; started: number; softCrossedAt?: number };
		report?: ReportSpec;
	}) => {
		const ago = d.minutesAgo;
		if ((ago !== undefined) !== (d.status === "running")) {
			throw new Error(`seed: minutesAgo is for running dispatches (${d.slug})`);
		}
		const time = (h: number, minutes: number | undefined) =>
			ago === undefined || minutes === undefined
				? at(d.day, h)
				: new Date(runAt.getTime() - minutes * 60_000);
		const entry = entryFor(d.missionId, d.slug, d.territory);
		const estimate = entry.estimatedTokens ?? 0;
		const soft = entry.tokenSoftCeiling ?? 0;
		const hard = entry.tokenHardCeiling ?? 0;
		const [tin, tout, cr, cw] = d.split ?? [0, 0, 0, 0];
		const used = tin + tout + cr + cw;
		const started = d.started !== undefined;
		const version = started ? currentVersion(d.slug) : undefined;
		const id = ids.next();
		const createdAt = time(d.created, ago?.created);
		const startedAt =
			d.started === undefined ? null : time(d.started, ago?.started);
		const softAt =
			d.softCrossedAt === undefined
				? null
				: time(d.softCrossedAt, ago?.softCrossedAt);
		const lastAt =
			d.ended !== undefined
				? at(d.day, d.ended)
				: (softAt ?? startedAt ?? createdAt);
		const row: Row<typeof dispatch> = {
			id,
			rosterEntryId: entry.id,
			missionId: d.missionId,
			briefRef: d.briefRef,
			status: d.status,
			haltReason: d.haltReason ?? null,
			estimatedTokens: estimate,
			tokenSoftCeiling: soft,
			tokenHardCeiling: hard,
			tokensUsed: used,
			tokensIn: tin,
			tokensOut: tout,
			cacheReadTokens: cr,
			cacheWriteTokens: cw,
			softCeilingCrossed: d.softCrossedAt !== undefined,
			spendUsd: d.spendUsd ?? "0",
			wallClockMinutes: d.wallClockMinutes,
			agentIdentityVersionId: version?.id ?? null,
			agentVersionSha256: version?.sha256 ?? null,
			skillsSha256: started ? SEED_SKILLS_SHA256 : null,
			model: started ? "fake-harness" : null,
			priceVersion: started ? PRICE_VERSION : null,
			// Only a running dispatch has a live token. A fixed hex, never a
			// hash of any real token.
			tokenSha256: d.status === "running" ? fakeSha(`token:${id}`) : null,
			idempotencyKey: `seed-${id}`,
			requestSha256: fakeSha(`request:${id}`),
			startedAt,
			closedAt: d.ended === undefined ? null : at(d.day, d.ended),
			createdAt,
			updatedAt: lastAt,
		};
		rows.dispatch.push(row);

		const scope = { missionId: d.missionId, engagementId: d.engagementId };
		log(
			createdAt,
			"dispatch.created",
			"dispatch",
			id,
			{ rosterEntryId: entry.id, estimatedTokens: estimate },
			scope,
		);
		if (startedAt !== null) {
			log(
				startedAt,
				"dispatch.started",
				"dispatch",
				id,
				{
					agentVersionSha256: version?.sha256,
					model: "fake-harness",
					priceVersion: PRICE_VERSION,
				},
				scope,
			);
		}
		if (softAt !== null) {
			log(
				softAt,
				"dispatch.soft_ceiling_crossed",
				"dispatch",
				id,
				{ tokenSoftCeiling: soft },
				scope,
				"runner",
			);
		}
		if (d.ended === undefined) return row;
		const endAt = at(d.day, d.ended);
		if (d.status === "halted") {
			log(
				endAt,
				"dispatch.halted",
				"dispatch",
				id,
				{ reason: d.haltReason },
				scope,
				// An operator halt is the operator's; every other halt the runner's.
				d.haltReason === "operator" ? "operator" : "runner",
			);
		}
		const r = d.report;
		if (r === undefined || version === undefined) {
			throw new Error(`seed: a closed dispatch needs a report (${d.slug})`);
		}
		const reportId = ids.next();
		rows.completionReport.push({
			id: reportId,
			rosterEntryId: entry.id,
			missionId: d.missionId,
			dispatchId: id,
			status: d.status as Row<typeof completionReport>["status"],
			haltReason: d.haltReason ?? null,
			softCeilingCrossed: row.softCeilingCrossed,
			actualTokens: used,
			agentVersionSha256: version.sha256,
			skillsSha256: SEED_SKILLS_SHA256,
			versionSource: "recorded",
			model: "fake-harness",
			artifactsRead: r.read ?? [],
			artifactsWritten: r.written ?? [],
			filesTouched: r.filesTouched ?? 0,
			fileTypesTouched: r.fileTypesTouched ?? [],
			rereads: r.rereads ?? 0,
			blockers: r.blockers ?? [],
			edgeMismatches: r.edgeMismatches ?? [],
			filedBy: r.filedBy,
			deletedAt: null,
			createdAt: endAt,
			updatedAt: endAt,
		});
		const filer =
			r.filedBy === "agent" ? { agent: entry.id } : ("runner" as const);
		log(
			endAt,
			"completion_report.filed",
			"completion_report",
			reportId,
			{ dispatchId: id, status: d.status, filedBy: r.filedBy },
			scope,
			filer,
		);
		log(
			endAt,
			"dispatch.closed",
			"dispatch",
			id,
			{ status: d.status, reportId },
			scope,
			filer,
		);
		return row;
	};

	// Payment plans, about 90% of its $40 ceiling spent ($35.60). Wave A
	// first, then B, then C; Zane's review waits in the queue.
	const brief = fakeSha("artifact:plan/brief.json");
	const plansFixture = fakeSha("artifact:fixtures/golden/payment-plans.json");
	const billingScope = { missionId: billing2, engagementId: billing };
	const fennRun = addDispatch({
		...billingScope,
		slug: "fenn",
		briefRef: { moduleId: "M1", requirementIds: ["R1", "R2"] },
		status: "complete",
		split: [9_000, 4_400, 14_000, 1_000],
		spendUsd: "2.10",
		wallClockMinutes: 240,
		day: 30,
		created: 0,
		started: 1,
		ended: 3,
		report: {
			filedBy: "agent",
			read: [{ path: "plan/brief.json", sha256: brief }],
			written: [
				{ path: "fixtures/golden/payment-plans.json", sha256: plansFixture },
				{
					path: "fixtures/golden/instalment-dates.json",
					sha256: fakeSha("artifact:fixtures/golden/instalment-dates.json"),
				},
			],
			filesTouched: 2,
			fileTypesTouched: ["json"],
			rereads: 1,
		},
	});
	addDispatch({
		...billingScope,
		slug: "fantem",
		briefRef: null,
		status: "halted",
		haltReason: "wall_clock",
		split: [16_000, 6_300, 28_000, 2_000],
		spendUsd: "3.40",
		wallClockMinutes: 120,
		day: 30,
		created: 0,
		started: 1,
		ended: 3,
		report: { filedBy: "system" },
	});
	addDispatch({
		...billingScope,
		slug: "atlas",
		territory: "plans",
		briefRef: { moduleId: "M1", requirementIds: ["R1", "R2"] },
		status: "halted",
		haltReason: "token_hard_ceiling",
		split: [98_000, 41_200, 210_000, 12_000],
		spendUsd: "9.80",
		wallClockMinutes: 360,
		day: 30,
		created: 4,
		started: 5,
		softCrossedAt: 7,
		ended: 9,
		report: { filedBy: "system" },
	});
	addDispatch({
		...billingScope,
		slug: "atlas",
		territory: "statements",
		briefRef: { moduleId: "M1", requirementIds: ["R2"] },
		status: "halted",
		haltReason: "operator",
		split: [10_000, 4_000, 16_000, 1_000],
		spendUsd: "2.40",
		wallClockMinutes: 240,
		day: 30,
		created: 4,
		started: 5,
		ended: 6,
		report: { filedBy: "system" },
	});
	addDispatch({
		...billingScope,
		slug: "atlas",
		territory: "reminders",
		briefRef: { moduleId: "M2", requirementIds: ["R3"] },
		status: "running",
		split: [40_000, 17_500, 80_000, 4_000],
		spendUsd: "8.20",
		wallClockMinutes: 480,
		day: 30,
		created: 4,
		started: 5,
		softCrossedAt: 10,
		// The run that is still going: started 25 minutes before the seed ran.
		minutesAgo: { created: 30, started: 25, softCrossedAt: 10 },
	});
	// Iyo read the payment-plans fixture at a hash Fenn never wrote: the one
	// edge mismatch, recorded on the consumer's report.
	const plansAsRead = fakeSha(
		"artifact:fixtures/golden/payment-plans.json@stale",
	);
	addDispatch({
		...billingScope,
		slug: "iyo",
		briefRef: { moduleId: "M1", requirementIds: ["R1", "R2"] },
		status: "blocked",
		split: [15_000, 7_800, 24_000, 1_000],
		spendUsd: "4.10",
		wallClockMinutes: 240,
		day: 31,
		created: 0,
		started: 1,
		ended: 3,
		report: {
			filedBy: "agent",
			read: [
				{ path: "plan/brief.json", sha256: brief },
				{ path: "fixtures/golden/payment-plans.json", sha256: plansAsRead },
			],
			written: [
				{
					path: "tests/backend/payment-plans.test.ts",
					sha256: fakeSha("artifact:tests/backend/payment-plans.test.ts"),
				},
			],
			filesTouched: 1,
			fileTypesTouched: ["ts"],
			rereads: 3,
			blockers: [
				{
					description:
						"No test database credentials were provided for the billing service.",
					workaround: "Ran the tests against the local fixture database only.",
					provisioning_gap: true,
				},
				{
					description:
						"The payment-plans fixture does not match the one the expected-results author wrote.",
					workaround:
						"Tested against the fixture as read and stopped for the operator.",
					provisioning_gap: false,
				},
			],
			edgeMismatches: [
				{
					path: "fixtures/golden/payment-plans.json",
					read_sha256: plansAsRead,
					written_sha256: plansFixture,
					producer_dispatch_id: fennRun.id,
				},
			],
		},
	});
	addDispatch({
		...billingScope,
		slug: "nemi",
		briefRef: { moduleId: "M1", requirementIds: ["R1"] },
		status: "failed",
		split: [22_000, 9_000, 38_000, 2_000],
		spendUsd: "5.60",
		wallClockMinutes: 240,
		day: 31,
		created: 0,
		started: 1,
		ended: 2,
		report: { filedBy: "system" },
	});
	addDispatch({
		...billingScope,
		slug: "zane",
		briefRef: null,
		status: "queued",
		wallClockMinutes: 240,
		day: 31,
		created: 4,
	});

	// Waitlist: Atlas's run took the mission's spend to its $15 ceiling, so
	// the runner halted the dispatch and the mission together (the mission's
	// status_changed row above is system, at the same moment).
	addDispatch({
		missionId: booking3,
		engagementId: booking,
		slug: "atlas",
		territory: "waitlist",
		briefRef: { moduleId: "M1", requirementIds: ["R1"] },
		status: "halted",
		haltReason: "spend_ceiling",
		split: [50_000, 22_000, 85_000, 5_000],
		spendUsd: "15.00",
		wallClockMinutes: 360,
		day: 30,
		created: 0,
		started: 1,
		softCrossedAt: 2,
		ended: 3,
		report: { filedBy: "system" },
	});

	return rows;
}
