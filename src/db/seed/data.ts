import type { Brief } from "../../contract/intake";
import { fixedClock } from "../../lib/clock";
import type { IdGenerator } from "../../lib/ids";
import { skillContentSha256 } from "../../lib/skill-hash";
import type {
	activityLog,
	agentTemplate,
	client,
	connection,
	engagement,
	exportTable,
	mission,
	playbook,
	roleSkills,
	rosterEntry,
	rosterPreset,
	skill,
	skillSource,
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

/** The template-booking commit the seeded missions were built from. Made up; it only has to be 40 hex. */
export const BOOKING_TEMPLATE_SHA = "b00c1e9b00c1e9b00c1e9b00c1e9b00c1e9b00c1";

type Row<T extends { $inferInsert: unknown }> = T["$inferInsert"];

export interface SeedRows {
	client: Row<typeof client>[];
	engagement: Row<typeof engagement>[];
	connection: Row<typeof connection>[];
	agentTemplate: Row<typeof agentTemplate>[];
	rosterPreset: Row<typeof rosterPreset>[];
	playbook: Row<typeof playbook>[];
	mission: Row<typeof mission>[];
	rosterEntry: Row<typeof rosterEntry>[];
	export: Row<typeof exportTable>[];
	activityLog: Row<typeof activityLog>[];
	skillSource: Row<typeof skillSource>[];
	skill: Row<typeof skill>[];
	roleSkills: Row<typeof roleSkills>[];
}

type MissionStatus = Row<typeof mission>["status"];
type ExportStatus = Row<typeof exportTable>["status"];

export function buildSeed(ids: IdGenerator): SeedRows {
	const rows: SeedRows = {
		client: [],
		engagement: [],
		connection: [],
		agentTemplate: [],
		rosterPreset: [],
		playbook: [],
		mission: [],
		rosterEntry: [],
		export: [],
		activityLog: [],
		skillSource: [],
		skill: [],
		roleSkills: [],
	};

	const log = (
		when: Date,
		action: Row<typeof activityLog>["action"],
		entityType: Row<typeof activityLog>["entityType"],
		entityId: string,
		payload: Record<string, unknown>,
		scope: { missionId?: string | null; engagementId?: string | null } = {},
	) => {
		rows.activityLog.push({
			id: ids.next(),
			at: when,
			actorKind: "system",
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

	// Agent templates: the operator plus four agents.
	const addTemplate = (
		slug: string,
		name: string,
		kind: "horizontal" | "feature",
		roles: Row<typeof agentTemplate>["roles"],
		waves: Row<typeof agentTemplate>["waveDefaults"],
		writablePaths: string[],
	) => {
		const id = ids.next();
		rows.agentTemplate.push({
			id,
			slug,
			name,
			kind,
			roles,
			engagementId: null,
			waveDefaults: waves,
			identityMd: `# ${name}\n`,
			depthMd: "",
			writablePaths,
			version: 1,
			createdAt: at(0),
			updatedAt: at(0),
		});
		return id;
	};
	const operator = addTemplate(
		"operator",
		"Operator",
		"horizontal",
		["foundations"],
		["A"],
		["**"],
	);
	const atlas = addTemplate(
		"atlas",
		"Atlas",
		"horizontal",
		["schema", "contract"],
		["A"],
		["src/db/**", "src/contract/**"],
	);
	const nemi = addTemplate(
		"nemi",
		"Nemi",
		"feature",
		["domain", "api-surface"],
		["B"],
		["src/routes/**", "src/services/**"],
	);
	const fenn = addTemplate(
		"fenn",
		"Fenn",
		"horizontal",
		["backend-tests", "frontend-tests"],
		["C"],
		["tests/**"],
	);
	const zane = addTemplate(
		"zane",
		"Zane",
		"horizontal",
		["spec-judgment", "security-review"],
		["D"],
		["reviews/**"],
	);

	// The template-booking playbook and its default preset. A template's
	// playbook is keyed by the template's slug (DECISIONS-V2, 2026-10-12).
	const preset = ids.next();
	rows.rosterPreset.push({
		id: preset,
		name: "Full build · vertical",
		description: "Foundations, one feature builder, tests and review.",
		cut: "vertical",
		agents: [
			{ agent_template_id: atlas, waves: ["A"], estimated_tokens: 80_000 },
			{ agent_template_id: nemi, waves: ["B"], estimated_tokens: 150_000 },
			{ agent_template_id: fenn, waves: ["C"], estimated_tokens: 90_000 },
			{ agent_template_id: zane, waves: ["D"], estimated_tokens: 40_000 },
		],
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
		/** Status changes after draft, as [status, day]. */
		path: [MissionStatus, number][];
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
		for (const [to, day] of m.path) {
			log(
				at(day, 3),
				"mission.status_changed",
				"mission",
				id,
				{ from, to },
				scope,
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
		// A plan half written: R3 is in no module yet, so the check fails.
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
				{ id: "M1", name: "Delivery", requirementIds: ["R1"] },
				{ id: "M2", name: "Preferences", requirementIds: ["R2"] },
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

	// Roster entries, some inactive.
	const addEntries = (
		missionId: string,
		day: number,
		entries: [
			string,
			Row<typeof rosterEntry>["waves"],
			boolean,
			number | null,
		][],
	) => {
		for (const [templateId, waves, active, estimate] of entries) {
			rows.rosterEntry.push({
				id: ids.next(),
				missionId,
				agentTemplateId: templateId,
				active,
				waves,
				customizedMd: null,
				writablePaths: null,
				territory: null,
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
		[atlas, ["A"], true, 80_000],
		[nemi, ["B"], true, 150_000],
		[fenn, ["C"], true, 90_000],
		[zane, ["D"], true, 40_000],
	]);
	addEntries(portal2, 10, [
		[atlas, ["A"], true, 60_000],
		[nemi, ["B"], true, 160_000],
		[fenn, ["C"], true, 90_000],
		[zane, ["D"], false, null],
	]);
	addEntries(booking2, 13, [
		[atlas, ["A"], true, 70_000],
		[nemi, ["B"], true, 140_000],
		[fenn, ["C"], false, null],
		[zane, ["D"], true, 40_000],
	]);
	addEntries(internal2, 16, [
		[operator, ["A"], true, null],
		[atlas, ["A"], true, 50_000],
		[nemi, ["B"], true, 120_000],
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
		log(
			at(x.endDay, 5),
			"export.status_changed",
			"export",
			id,
			{ to: x.status },
			scope,
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
	// both types and every status. The seed invents no users, so no skill
	// names a reviewer, approved ones included. No role_skills or
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
	// role_skills rows, so Atlas (schema, contract) shows tool rows on the
	// access route. The draft runner is attached too and shows nothing:
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

	return rows;
}
