import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { WAVES, wave } from "./agent-template";
import { templateRef } from "./mission-plan";
import { successEnvelope } from "./shared/envelope";
import { pageEnvelope, pageQuery } from "./shared/pagination";
import { searchQuery } from "./shared/query";

const c = initContract();

const iso = z.string().datetime();

/** The closed gate vocabulary (DATA-CONTRACTS-V2, Playbook). The gate pgEnum is built from it. */
export const GATES = [
	"phase1-close",
	"alignment",
	"qa",
	"security",
	"rollback",
	"acceptance",
] as const;

export const gate = z.enum(GATES);

export type Gate = z.infer<typeof gate>;

/** There is no skippable. */
export const gatePolicy = z.enum(["mandatory", "warn"]);

export type GatePolicy = z.infer<typeof gatePolicy>;

/** What a mission type ships. The deliverable pgEnum is built from it. */
export const DELIVERABLES = ["pr", "report", "recommendation"] as const;

export const deliverable = z.enum(DELIVERABLES);

export type Deliverable = z.infer<typeof deliverable>;

export const playbookGateSchema = z.object({ gate, policy: gatePolicy });

export type PlaybookGate = z.infer<typeof playbookGateSchema>;

/**
 * The process for one mission type. It names a default preset and never lists
 * agents. Soft-deleted playbooks are never on the wire.
 */
export const playbookSchema = z.object({
	id: z.string().uuid(),
	/** Joins mission.type. Unique among live playbooks. */
	missionType: z.string(),
	name: z.string(),
	wavesApplicable: z.array(wave),
	gates: z.array(playbookGateSchema),
	deliverable,
	requiredFields: z.array(z.string()),
	defaultPresetId: z.string().uuid(),
	version: z.number().int().positive(),
	createdAt: iso,
	updatedAt: iso,
});

export type Playbook = z.infer<typeof playbookSchema>;

export const playbookListQuery = pageQuery.extend({
	/** Case-insensitive substring of the name. */
	q: searchQuery.optional(),
});

export type PlaybookListQuery = z.infer<typeof playbookListQuery>;

/** Waves A to E, at least one, each once, in WAVES order. Out of order is refused, never sorted. */
const wavesApplicableInput = z
	.array(wave)
	.min(1)
	.superRefine((waves, ctx) => {
		waves.forEach((w, i) => {
			const prev = waves[i - 1];
			if (prev === undefined) return;
			if (w === prev)
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [i],
					message: `Wave ${w} is listed twice`,
				});
			else if (WAVES.indexOf(w) < WAVES.indexOf(prev))
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [i],
					message: `Wave ${w} comes before ${prev}: list waves in order A to E`,
				});
		});
	});

/** Each gate of the closed vocabulary at most once. */
const gatesInput = z
	.array(playbookGateSchema.strict())
	.superRefine((gates, ctx) => {
		const seen = new Set<Gate>();
		gates.forEach((g, i) => {
			if (seen.has(g.gate))
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [i, "gate"],
					message: `The ${g.gate} gate is listed twice`,
				});
			seen.add(g.gate);
		});
	});

/** Field names a mission of this type must fill. Their vocabulary is [unspecified]. */
const requiredFieldsInput = z
	.array(z.string().trim().min(1).max(200))
	.superRefine((fields, ctx) => {
		const seen = new Set<string>();
		fields.forEach((f, i) => {
			if (seen.has(f))
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [i],
					message: `${f} is listed twice`,
				});
			seen.add(f);
		});
	});

/** Everything an operator sets on a playbook. missionType is set once, at create. */
const playbookFields = {
	name: z.string().trim().min(1).max(200),
	wavesApplicable: wavesApplicableInput,
	gates: gatesInput,
	deliverable,
	requiredFields: requiredFieldsInput,
	defaultPresetId: z.string().uuid(),
};

/**
 * version 1. A live playbook for the same mission type is 409 CONFLICT. The
 * default preset must be live (422 preset_not_found) and staff the earliest
 * wave (422 preset_misses_first_wave).
 */
export const createPlaybookBody = z
	.object({
		/** The same slug rule as Mission.template_ref. Immutable after create. */
		missionType: templateRef,
		...playbookFields,
	})
	.strict();

/** A full replace. missionType is not a field: it cannot change. */
export const updatePlaybookBody = z.object(playbookFields).strict();

export type CreatePlaybookBody = z.infer<typeof createPlaybookBody>;
export type UpdatePlaybookBody = z.infer<typeof updatePlaybookBody>;

const byMissionType = z.object({ missionType: z.string().min(1).max(200) });

export const playbookContract = c.router({
	list: {
		method: "GET",
		path: "/api/playbooks",
		query: playbookListQuery,
		responses: { 200: pageEnvelope(playbookSchema) },
		summary: "Playbooks, newest first",
	},
	getForType: {
		method: "GET",
		path: "/api/playbooks/by-type/:missionType",
		pathParams: byMissionType,
		responses: { 200: successEnvelope(playbookSchema) },
		summary:
			"The live playbook for a mission type. A type with none is 404 NOT_FOUND",
	},
	create: {
		method: "POST",
		path: "/api/playbooks",
		body: createPlaybookBody,
		responses: { 201: successEnvelope(playbookSchema) },
	},
	update: {
		method: "PUT",
		path: "/api/playbooks/by-type/:missionType",
		pathParams: byMissionType,
		body: updatePlaybookBody,
		responses: { 200: successEnvelope(playbookSchema) },
		summary:
			"Replaces the live playbook and bumps its version. Refused (422 playbook_in_use) while a live mission of this type is active or halted",
	},
	versions: {
		method: "GET",
		path: "/api/playbooks/by-type/:missionType/versions",
		pathParams: byMissionType,
		// Unpaginated: one row per write to one playbook.
		responses: { 200: successEnvelope(z.array(playbookSchema)) },
		summary:
			"Every version of the live playbook as it was written, newest first, read from its activity",
	},
});
