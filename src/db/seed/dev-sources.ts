import path from "node:path";
import { DEV_BOOKING_SHA, DEV_GATE_READY_SHA } from "../../lib/templates";
import { git, gitOk } from "../../rooms/git";
import { dispatchRef } from "../../rooms/snapshot";
import { cloneDir } from "../../rooms/sources";
import { buildSeed, SEED_EPOCH, seedIds } from "./data";
import { buildDevTemplateBooking } from "./dev-template";

export type DevSource = { path: string; head: string; want: string };

/**
 * The clones the dev seed's missions open rooms on, under `dir`
 * (AVEL_SOURCES_DIR): the template-booking fixture at templates/, and, for
 * each seeded client intake's repository, the same fixture at
 * repos/<owner>/<repo>, since each client's repository started from the
 * template at its pin. Each clone's head is returned beside the commit it
 * must be at; a directory already there is left alone, never overwritten.
 * Each seeded dispatch that reports DEV_GATE_READY_SHA gets its dispatch ref
 * on that commit in every clone, where the gate looks for its work.
 */
export async function buildDevSources(dir: string): Promise<DevSource[]> {
	const targets = new Map<string, string>([
		[path.join(dir, "templates", "template-booking"), DEV_BOOKING_SHA],
	]);
	// The repositories are the same at any run time; only running
	// dispatches are timed from it.
	const rows = buildSeed(seedIds(), new Date(SEED_EPOCH));
	for (const i of rows.intake) {
		if (!i.repoUrl || !i.repoCommitSha) continue;
		const clone = cloneDir(dir, {
			kind: "repo",
			repoUrl: i.repoUrl,
			commit: i.repoCommitSha,
		});
		if (!clone) throw new Error(`${i.repoUrl} has no safe local clone name`);
		const want = targets.get(clone);
		if (want !== undefined && want !== i.repoCommitSha) {
			throw new Error(`${clone} is read at two commits`);
		}
		targets.set(clone, i.repoCommitSha);
	}
	const gateReady = rows.completionReport
		.filter((r) => r.resultCommitSha === DEV_GATE_READY_SHA)
		.map((r) => r.dispatchId)
		.sort();
	const out: DevSource[] = [];
	for (const [clone, want] of [...targets].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		if (want !== DEV_BOOKING_SHA) {
			throw new Error(
				`${clone} is read at ${want}, which no dev fixture builds`,
			);
		}
		const head = await buildDevTemplateBooking(clone);
		const holds = await gitOk(
			["cat-file", "-e", `${DEV_GATE_READY_SHA}^{commit}`],
			{
				cwd: clone,
			},
		);
		for (const id of holds ? gateReady : []) {
			await git(["update-ref", dispatchRef(id), DEV_GATE_READY_SHA], {
				cwd: clone,
			});
		}
		out.push({ path: clone, head, want });
	}
	return out;
}
