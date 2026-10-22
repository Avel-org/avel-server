import { and, asc, eq } from "drizzle-orm";
import { intake, mission } from "../db/schema";
import { live } from "../db/schema/columns";
import type { Executor } from "../db/tx";
import type { RoomSource, SourceIssue } from "../rooms/sources";

/**
 * What a mission's rooms are made from (decided 2026-10-21, J; replaces
 * the 2026-10-13 rule that any template pin wins). The mission's origin
 * decides. An internal mission works in the template repo: its template
 * at template_version. An internal mission with no template pin has no
 * source, an issue. A client mission always works in the client's
 * repository: the repository its one approved intake read, at the commit
 * read, even when it pins a template; that pin only records which template
 * version the client's code came from. None, or more than one, approved
 * intake is an issue: the runner never guesses.
 */
export async function missionRoomSource(
	db: Executor,
	missionId: string,
): Promise<{ source: RoomSource } | { issue: SourceIssue }> {
	const [m] = await db
		.select({
			origin: mission.origin,
			templateRef: mission.templateRef,
			templateVersion: mission.templateVersion,
		})
		.from(mission)
		.where(eq(mission.id, missionId));
	if (m?.origin === "internal") {
		if (m.templateRef && m.templateVersion) {
			return {
				source: {
					kind: "template",
					slug: m.templateRef,
					commit: m.templateVersion,
				},
			};
		}
		return {
			issue: {
				path: ["source", "template"],
				message: "The internal mission pins no template",
			},
		};
	}
	const approved = await db
		.select({ repoUrl: intake.repoUrl, commit: intake.repoCommitSha })
		.from(intake)
		.where(
			and(
				eq(intake.missionId, missionId),
				eq(intake.status, "approved"),
				live(intake),
			),
		)
		.orderBy(asc(intake.createdAt), asc(intake.id));
	if (approved.length !== 1) {
		return {
			issue: {
				path: ["intake"],
				message:
					approved.length === 0
						? "no approved intake"
						: `${approved.length} approved intakes`,
			},
		};
	}
	const [read] = approved as [(typeof approved)[number]];
	if (read.repoUrl === null || read.commit === null) {
		return {
			issue: {
				path: ["source", "repo"],
				message: "The approved intake has no repository read",
			},
		};
	}
	return {
		source: { kind: "repo", repoUrl: read.repoUrl, commit: read.commit },
	};
}

/**
 * The client source a mission's brief carries (step 9): its one approved
 * intake's sourceMd. Null when it has none, or more than one, as with
 * missionRoomSource.
 */
export async function missionSourceMd(
	db: Executor,
	missionId: string,
): Promise<string | null> {
	const approved = await db
		.select({ sourceMd: intake.sourceMd })
		.from(intake)
		.where(
			and(
				eq(intake.missionId, missionId),
				eq(intake.status, "approved"),
				live(intake),
			),
		)
		.limit(2);
	return approved.length === 1 ? (approved[0]?.sourceMd ?? null) : null;
}
