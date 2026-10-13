import { describe, expect, it } from "vitest";
import {
	agentKind,
	agentTemplateListQuery,
	agentTemplateSchema,
	ROLES,
	role,
	skillLayer,
	skillListItem,
	skillListQuery,
	skillSchema,
	skillSourceKind,
	skillSourceListQuery,
	skillSourceSchema,
	skillStatus,
	skillType,
	WAVES,
	wave,
} from "../../src/contract";
import {
	agentKind as agentKindEnum,
	type agentTemplate,
	role as roleEnum,
	type skill,
	skillLayer as skillLayerEnum,
	type skillSource,
	skillSourceKind as skillSourceKindEnum,
	skillStatus as skillStatusEnum,
	skillType as skillTypeEnum,
	wave as waveEnum,
} from "../../src/db/schema";
import { buildSeed, seedIds } from "../../src/db/seed/data";

// The module 4 catalog shapes, published before their handlers. Each
// schema must accept a row as the table holds it and refuse a bad one.

type Select<T extends { $inferSelect: unknown }> = T["$inferSelect"];

const T0 = new Date("2026-09-07T09:00:00.000Z");

function templateWire(row: Select<typeof agentTemplate>) {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		kind: row.kind,
		roles: row.roles,
		engagementId: row.engagementId,
		waveDefaults: row.waveDefaults,
		description: row.description,
		identityMd: row.identityMd,
		depthMd: row.depthMd,
		writablePaths: row.writablePaths,
		version: row.version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

// The seed has no skill sources or skills yet, so these rows follow the
// seed's conventions: 5eed ids, the seed epoch, fictional names.
const sourceRow: Select<typeof skillSource> = {
	id: "5eed0000-0000-4000-8000-0000000000f1",
	name: "AVEL internal",
	kind: "internal",
	url: null,
	license: null,
	deletedAt: null,
	createdAt: T0,
	updatedAt: T0,
};

function sourceWire(row: Select<typeof skillSource>, skillCount: number) {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		url: row.url,
		license: row.license,
		skillCount,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

const knowledgeRow: Select<typeof skill> = {
	id: "5eed0000-0000-4000-8000-0000000000f2",
	slug: "drizzle-keyset",
	name: "Drizzle keyset pagination",
	description: "How lists page by (created_at desc, id desc).",
	contentMd: "# Keyset\n",
	avelEnhancementMd: null,
	layer: "stack",
	type: "knowledge",
	grants: null,
	ioShape: null,
	recommendedFor: ["api-surface", "schema"],
	sourceId: sourceRow.id,
	contentSha256: "a".repeat(64),
	status: "approved",
	reviewedBy: null,
	reviewedAt: T0,
	version: 1,
	deletedAt: null,
	createdAt: T0,
	updatedAt: T0,
};

const capabilityRow: Select<typeof skill> = {
	...knowledgeRow,
	id: "5eed0000-0000-4000-8000-0000000000f3",
	slug: "repo-search",
	name: "Repo search",
	type: "capability",
	grants: ["read:source"],
	ioShape: { reads: "large", returns: "small" },
	status: "draft",
	reviewedAt: null,
};

function skillWire(row: Select<typeof skill>) {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		contentMd: row.contentMd,
		avelEnhancementMd: row.avelEnhancementMd,
		layer: row.layer,
		type: row.type,
		grants: row.grants,
		ioShape: row.ioShape,
		recommendedFor: row.recommendedFor,
		source: { id: sourceRow.id, name: sourceRow.name, kind: sourceRow.kind },
		contentSha256: row.contentSha256,
		status: row.status,
		reviewedBy: row.reviewedBy,
		reviewedAt: row.reviewedAt?.toISOString() ?? null,
		version: row.version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

describe("catalog vocabularies", () => {
	it("match the database enums, values and order", () => {
		expect(role.options).toEqual(roleEnum.enumValues);
		expect(wave.options).toEqual(waveEnum.enumValues);
		expect(agentKind.options).toEqual(agentKindEnum.enumValues);
		expect(skillLayer.options).toEqual(skillLayerEnum.enumValues);
		expect(skillType.options).toEqual(skillTypeEnum.enumValues);
		expect(skillStatus.options).toEqual(skillStatusEnum.enumValues);
		expect(skillSourceKind.options).toEqual(skillSourceKindEnum.enumValues);
	});

	// role and wave pgEnums are built from these arrays, so the equality above
	// cannot catch an edit. Pinning them here makes any edit a deliberate,
	// reviewed change. A removal or reorder needs a hand-written migration:
	// drizzle-kit's generated one casts the enum-array columns through text.
	it("pins the 35 roles, in catalog order", () => {
		expect(ROLES).toEqual([
			"foundations",
			"schema",
			"contract",
			"design-system",
			"fixture",
			"domain",
			"api-surface",
			"integration",
			"realtime",
			"auth",
			"state",
			"interface",
			"backend-tests",
			"frontend-tests",
			"property-tests",
			"accessibility",
			"performance",
			"spec-check",
			"spec-judgment",
			"security-review",
			"compliance-review",
			"adversarial",
			"reconciliation",
			"concurrency",
			"deploy",
			"recovery",
			"observability",
			"incident-response",
			"intake",
			"strategy",
			"research",
			"client-ops",
			"knowledge",
			"render",
			"ship-decision",
		]);
		expect(role.options).toHaveLength(35);
	});

	it("pins the waves, in order", () => {
		expect(WAVES).toEqual(["A", "B", "C", "D", "E"]);
	});
});

describe("agentTemplateSchema", () => {
	const seeded = buildSeed(seedIds()).agentTemplate;

	it("parses every seeded template", () => {
		expect(seeded).toHaveLength(5);
		for (const row of seeded) {
			const wire = templateWire({ deletedAt: null, ...row } as Select<
				typeof agentTemplate
			>);
			expect(agentTemplateSchema.parse(wire)).toEqual(wire);
		}
	});

	it("gives every seeded template a plain description", () => {
		for (const row of seeded) {
			expect(row.description?.length).toBeGreaterThan(0);
			expect(row.description).not.toMatch(/[*_`#—]/);
		}
	});

	it("refuses an empty or over-long description, and takes null", () => {
		const [first] = seeded;
		if (!first) throw new Error("seed has no templates");
		const wire = templateWire({ deletedAt: null, ...first } as Select<
			typeof agentTemplate
		>);
		const parses = (description: string | null) =>
			agentTemplateSchema.safeParse({ ...wire, description }).success;
		expect(parses(null)).toBe(true);
		expect(parses("a".repeat(280))).toBe(true);
		expect(parses("a".repeat(281))).toBe(false);
		expect(parses("")).toBe(false);
	});

	it("refuses a role outside the vocabulary", () => {
		const [first] = seeded;
		if (!first) throw new Error("seed has no templates");
		const wire = templateWire({ deletedAt: null, ...first } as Select<
			typeof agentTemplate
		>);
		expect(
			agentTemplateSchema.safeParse({ ...wire, roles: ["tester"] }).success,
		).toBe(false);
		expect(
			agentTemplateSchema.safeParse({ ...wire, waveDefaults: ["F"] }).success,
		).toBe(false);
		expect(
			agentTemplateSchema.safeParse({ ...wire, createdAt: first.createdAt })
				.success,
		).toBe(false);
	});
});

describe("skillSourceSchema", () => {
	it("parses a source row", () => {
		const wire = sourceWire(sourceRow, 2);
		expect(skillSourceSchema.parse(wire)).toEqual(wire);
	});

	it("refuses an unknown kind and a negative count", () => {
		expect(
			skillSourceSchema.safeParse({ ...sourceWire(sourceRow, 0), kind: "paid" })
				.success,
		).toBe(false);
		expect(skillSourceSchema.safeParse(sourceWire(sourceRow, -1)).success).toBe(
			false,
		);
	});
});

describe("skillSchema", () => {
	it("parses a knowledge skill and a capability", () => {
		for (const row of [knowledgeRow, capabilityRow]) {
			const wire = skillWire(row);
			expect(skillSchema.parse(wire)).toEqual(wire);
		}
	});

	it("lists a skill without its text", () => {
		const { contentMd, avelEnhancementMd, ...item } = skillWire(capabilityRow);
		expect(contentMd).toBeTypeOf("string");
		expect(avelEnhancementMd).toBeNull();
		expect(skillListItem.parse(item)).toEqual(item);
	});

	it("refuses what the capability CHECK refuses", () => {
		// A knowledge skill with grants, and a capability without them.
		expect(
			skillSchema.safeParse({
				...skillWire(knowledgeRow),
				grants: ["read:source"],
			}).success,
		).toBe(false);
		expect(
			skillSchema.safeParse({ ...skillWire(capabilityRow), ioShape: null })
				.success,
		).toBe(false);
	});

	it("refuses an unknown status", () => {
		expect(
			skillSchema.safeParse({ ...skillWire(knowledgeRow), status: "live" })
				.success,
		).toBe(false);
	});
});

describe("catalog list queries", () => {
	it("takes a filter repeated, indexed or once", () => {
		expect(agentTemplateListQuery.parse({ role: "schema" }).role).toEqual([
			"schema",
		]);
		expect(
			skillListQuery.parse({ status: ["draft", "approved"] }).status,
		).toEqual(["draft", "approved"]);
		expect(skillSourceListQuery.parse({}).limit).toBe(50);
	});

	it("refuses an unknown filter value", () => {
		expect(skillListQuery.safeParse({ layer: "ops" }).success).toBe(false);
		expect(agentTemplateListQuery.safeParse({ wave: "Z" }).success).toBe(false);
		expect(
			skillSourceListQuery.safeParse({ kind: ["internal", "paid"] }).success,
		).toBe(false);
	});
});
