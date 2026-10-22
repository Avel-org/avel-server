import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { runSeed } from "../../src/db/seed";
import { SEED_OPERATOR_ID } from "../../src/db/seed/data";
import { buildDevSources } from "../../src/db/seed/dev-sources";
import { fixedClock } from "../../src/lib/clock";
import { sequentialIds } from "../../src/lib/ids";
import { DEV_BOOKING_SHA } from "../../src/lib/templates";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { FakeHarness } from "../../src/runner/harness";
import { missionRoomSource } from "../../src/runner/room-source";
import {
	inStep,
	lockMission,
	type RunnerDeps,
	startDispatch,
} from "../../src/runner/runner";
import { gitIn, removeDir, tempDir } from "../unit/git-fixtures";

// The dev seed on a throwaway _dev database, and `pnpm dev:sources` into a
// temp AVEL_SOURCES_DIR: every seeded mission's rooms resolve to a clone
// that holds the commit, and the seeded queued dispatch starts on one.

const url = process.env.DATABASE_URL;
const BUDGET_MS = 120_000;
const name = `avel_seed_src_${process.pid}_dev`;
const seedClock = fixedClock("2026-10-13T12:00:00.000Z");

function withDatabase(base: string, db: string) {
	const u = new URL(base);
	u.pathname = `/${db}`;
	return u.toString();
}

describe.skipIf(!url)("the dev seed's sources", () => {
	const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;
	const base = tempDir("seed-sources");
	const sources = path.join(base, "sources");
	let conn: ReturnType<typeof postgres> | undefined;

	afterAll(async () => {
		await conn?.end();
		await admin?.unsafe(`drop database if exists ${name} with (force)`);
		await admin?.end();
		removeDir(base);
	}, BUDGET_MS);

	async function seeded() {
		if (conn) return drizzle(conn, { schema });
		if (!url || !admin) throw new Error("unreachable: suite is skipped");
		await admin.unsafe(`drop database if exists ${name} with (force)`);
		await admin.unsafe(`create database ${name}`);
		const dbUrl = withDatabase(url, name);
		conn = postgres(dbUrl, { max: 1, onnotice: () => {} });
		await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
		expect((await runSeed(dbUrl, seedClock)).status).toBe("seeded");
		return drizzle(conn, { schema });
	}

	it(
		"builds a clone for the template and each client repository, at the commit read",
		async () => {
			const db = await seeded();
			const built = await buildDevSources(sources);
			for (const s of built) {
				expect(s.head, s.path).toBe(s.want);
				expect(gitIn(s.path, "rev-parse", "HEAD"), s.path).toBe(s.want);
			}
			const intakes = await db
				.select({
					repoUrl: schema.intake.repoUrl,
					commit: schema.intake.repoCommitSha,
				})
				.from(schema.intake);
			expect(intakes.length).toBeGreaterThan(0);
			// One clone per repository an intake read, plus the template.
			const repos = [...new Set(intakes.map((i) => i.repoUrl))].sort();
			expect(built.map((s) => path.relative(sources, s.path)).sort()).toEqual(
				[
					path.join("templates", "template-booking"),
					...repos.map((r) =>
						path.join(
							"repos",
							...new URL(r ?? "").pathname.split("/").slice(1),
						),
					),
				].sort(),
			);
			for (const i of intakes) expect(i.commit).toBe(DEV_BOOKING_SHA);
			// A second run leaves every clone where it was.
			expect(await buildDevSources(sources)).toEqual(built);
		},
		BUDGET_MS,
	);

	it(
		"resolves every live seeded client mission to its intake's repository, and every pinned internal one to its template",
		async () => {
			const db = await seeded();
			await buildDevSources(sources);
			const resolver = localSources(sources);
			const missions = await db
				.select({
					id: schema.mission.id,
					origin: schema.mission.origin,
					repoUrl: schema.mission.repoUrl,
					templateVersion: schema.mission.templateVersion,
				})
				.from(schema.mission)
				.where(isNull(schema.mission.deletedAt));
			const clients = missions.filter((m) => m.origin === "client");
			expect(clients.length).toBe(10);
			for (const m of missions) {
				if (m.origin === "internal" && m.templateVersion === null) continue;
				const found = await missionRoomSource(db, m.id);
				expect(found, m.id).not.toHaveProperty("issue");
				if (!("source" in found)) continue;
				if (m.origin === "client") {
					const [read] = await db
						.select({ commit: schema.intake.repoCommitSha })
						.from(schema.intake)
						.where(
							and(
								eq(schema.intake.missionId, m.id),
								eq(schema.intake.status, "approved"),
							),
						);
					expect(found.source, m.id).toEqual({
						kind: "repo",
						repoUrl: m.repoUrl,
						commit: read?.commit,
					});
				} else {
					expect(found.source.kind, m.id).toBe("template");
				}
				const resolved = await resolver.resolve(found.source);
				expect(resolved, m.id).toMatchObject({
					ok: true,
					commit: found.source.commit,
				});
			}
		},
		BUDGET_MS,
	);

	it(
		"starts the seeded queued dispatch in a room on its client's clone",
		async () => {
			const db = await seeded();
			await buildDevSources(sources);
			const [queued] = await db
				.select({
					id: schema.dispatch.id,
					missionId: schema.dispatch.missionId,
				})
				.from(schema.dispatch)
				.where(eq(schema.dispatch.status, "queued"));
			if (!queued) throw new Error("the seed has no queued dispatch");
			const harness = new FakeHarness();
			const rooms = worktreeRooms(path.join(base, "rooms"));
			const deps: RunnerDeps = {
				db: () => db,
				clock: seedClock,
				ids: sequentialIds(),
				harness,
				prices: DEFAULT_PRICE_BOOK,
				rooms,
				roomSources: localSources(sources),
			};
			await inStep(deps, async (step) => {
				const m = await lockMission(step.tx, queued.missionId);
				if (!m) throw new Error("no mission");
				await startDispatch(step, deps, m, queued.id, {
					actor: { actorKind: "operator", actorUserId: SEED_OPERATOR_ID },
					requestId: "seed-sources-test",
				});
			});
			const [d] = await db
				.select({ status: schema.dispatch.status })
				.from(schema.dispatch)
				.where(eq(schema.dispatch.id, queued.id));
			expect(d?.status).toBe("running");
			const room = await rooms.get(queued.id);
			expect(room?.repoPath).toBe(
				path.join(sources, "repos", "halvorsen-pike", "billing"),
			);
			expect(room?.commit).toBe(DEV_BOOKING_SHA);
			expect(gitIn(room?.root ?? "", "rev-parse", "HEAD")).toBe(
				DEV_BOOKING_SHA,
			);
			await harness.stop(queued.id);
		},
		BUDGET_MS,
	);
});
