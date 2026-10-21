import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ORPHAN_GRACE_MS, sweepOrphanBlobs } from "../../src/db/blob-sweep";
import { file } from "../../src/db/schema";
import { withClientScope } from "../../src/db/tx";
import { memoryBlobs, sha256Of } from "../../src/gateways/blob";
import type { Clock } from "../../src/lib/clock";
import { DEFAULT_UPLOAD_MAX_BYTES } from "../../src/routes/files";
import { seedTenants } from "../db/app-role";
import { BASE_URL, captureLogger } from "../unit/support";
import { type ApiHarness, closeApi, withApi } from "./support";

// The orphan sweep (src/db/blob-sweep.ts) against the app's own role, so
// row-level security decides what each key's check can see. The race with an
// upload in flight is in tests/api/file-upload-purge-race.test.ts.

const text = (s: string) => new TextEncoder().encode(s);
const T0 = new Date("2026-10-05T12:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** A clock the test moves. */
function movingClock(at: Date): Clock & { set(d: Date): void } {
	let now = at;
	return { now: () => new Date(now.getTime()), set: (d) => (now = d) };
}

async function upload(
	h: ApiHarness,
	cookie: string,
	intakeId: string,
	name: string,
	body: string,
) {
	const res = await h.app.request(
		`/api/intakes/${intakeId}/files?name=${name}`,
		{
			method: "POST",
			headers: { cookie, origin: BASE_URL, "content-type": "text/plain" },
			body,
		},
	);
	expect(res.status, await res.clone().text()).toBe(201);
	return ((await res.json()) as { data: { id: string } }).data.id;
}

describe.skipIf(!process.env.DATABASE_URL)("the orphan blob sweep", () => {
	afterAll(closeApi);

	it("removes old bytes no row names, under each key's client scope, and keeps the rest", async () => {
		const blobClock = movingClock(T0);
		const blobs = memoryBlobs(blobClock);
		await withApi(
			async (h) => {
				const cookie = await h.signIn();
				const { a, b } = await seedTenants(h.tx, ["Meridian", "Halcyon"]);
				const key = (prefix: string, body: string) =>
					`${prefix}/${sha256Of(text(body))}`;

				// Named by a live row, and by a removed (soft-deleted) one.
				await upload(h, cookie, a.intakeId, "live.md", "# Live\n");
				const removedId = await upload(
					h,
					cookie,
					a.intakeId,
					"gone.md",
					"# Gone\n",
				);
				await withClientScope(h.tx, a.scope, (t) =>
					t
						.update(file)
						.set({ deletedAt: minutes(1) })
						.where(eq(file.id, removedId)),
				);
				// Orphans: one per client, one general, and one whose client
				// does not exist.
				const strayClient = "00000000-0000-4000-8000-00000000dead";
				for (const [prefix, body] of [
					[`clients/${a.clientId}`, "# Orphan A\n"],
					[`clients/${b.clientId}`, "# Orphan B\n"],
					["general", "# Orphan general\n"],
					[`clients/${strayClient}`, "# Stray\n"],
				] as const) {
					await blobs.put(prefix as `clients/${string}`, text(body));
				}
				// Written inside the grace: kept however orphaned.
				blobClock.set(minutes(90));
				await blobs.put(`clients/${a.clientId}`, text("# Young\n"));

				const { logger, lines } = captureLogger();
				const result = await sweepOrphanBlobs({
					db: () => h.tx,
					clock: {
						now: () => new Date(minutes(60).getTime() + ORPHAN_GRACE_MS),
					},
					blobs,
					logger,
				});

				const removed = [
					key(`clients/${a.clientId}`, "# Orphan A\n"),
					key(`clients/${b.clientId}`, "# Orphan B\n"),
					key("general", "# Orphan general\n"),
				].sort();
				expect(result).toEqual({ removed, kept: 3, temps: 0 });
				expect(blobs.keys()).toEqual(
					[
						key(`clients/${a.clientId}`, "# Live\n"),
						key(`clients/${a.clientId}`, "# Gone\n"),
						key(`clients/${a.clientId}`, "# Young\n"),
						key(`clients/${strayClient}`, "# Stray\n"),
					].sort(),
				);
				expect(
					lines
						.filter((l) => l.msg === "orphan blob removed")
						.map((l) => l.key),
				).toEqual(removed);
				expect(
					lines.find(
						(l) => l.msg === "orphan sweep: no client for this key; kept",
					)?.key,
				).toBe(key(`clients/${strayClient}`, "# Stray\n"));
			},
			{ asApp: true, drive: { blobs, maxBytes: DEFAULT_UPLOAD_MAX_BYTES } },
		);
	});

	it("takes nothing written at the grace's edge, and removes it just past", async () => {
		const blobs = memoryBlobs({ now: () => T0 });
		await blobs.put("general", text("# Edge\n"));
		const sweepAt = async (ms: number) => {
			let removed = -1;
			await withApi(async (h) => {
				const result = await sweepOrphanBlobs({
					db: () => h.tx,
					clock: { now: () => new Date(T0.getTime() + ms) },
					blobs,
					logger: captureLogger().logger,
				});
				removed = result.removed.length;
			});
			return removed;
		};
		expect(await sweepAt(ORPHAN_GRACE_MS)).toBe(0);
		expect(blobs.keys()).toHaveLength(1);
		expect(await sweepAt(ORPHAN_GRACE_MS + 1)).toBe(1);
		expect(blobs.keys()).toEqual([]);
	});
});
