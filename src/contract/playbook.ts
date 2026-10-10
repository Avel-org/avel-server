import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { wave } from "./agent-template";
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
});
