import { and, asc, eq, type SQL } from "drizzle-orm";
import { FIRM_ROLES, type Role } from "../contract";
import type { PreconditionDetails } from "../contract/shared/errors";
import { agentTemplate, mission, rosterEntry } from "../db/schema";
import { live } from "../db/schema/columns";
import type { Executor } from "../db/tx";
import { ApiError } from "../middleware/errors";

/**
 * Firm roles never sit on a mission roster (ROSTER-V2.md, Merging roles
 * into agents). Adding a Firm template to a roster is refused in roster.ts.
 * A template edit, mission start and dispatch create and start refuse it
 * again here, because a rostered template's roles can change after it was
 * added, and an edit can race a roster add.
 */

/** The Firm roles among `roles`, in their order. */
export function firmRolesIn(roles: readonly Role[]): Role[] {
	return roles.filter((r) => (FIRM_ROLES as readonly Role[]).includes(r));
}

/** Live roster entries on live missions matching `where`, with their template's roles, in roster order. */
export async function rosteredTemplates(db: Executor, where: SQL | undefined) {
	return db
		.select({
			id: rosterEntry.id,
			missionId: rosterEntry.missionId,
			roles: agentTemplate.roles,
		})
		.from(rosterEntry)
		.innerJoin(agentTemplate, eq(agentTemplate.id, rosterEntry.agentTemplateId))
		.innerJoin(
			mission,
			and(eq(mission.id, rosterEntry.missionId), live(mission)),
		)
		.where(and(live(rosterEntry), where))
		.orderBy(asc(rosterEntry.createdAt), asc(rosterEntry.id));
}

/** 422 template_not_rosterable, naming the Firm roles and where they sit. */
export function notRosterable(
	roles: readonly Role[],
	at: Omit<PreconditionDetails, "reason">,
): ApiError<"PRECONDITION_FAILED"> {
	return new ApiError(
		"PRECONDITION_FAILED",
		`Firm roles (${roles.join(", ")}) never sit on a mission roster`,
		{ details: { reason: "template_not_rosterable", ...at } },
	);
}
