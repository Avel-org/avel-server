import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildDevSources } from "../../src/db/seed/dev-sources";
import { DEV_BOOKING_SHA } from "../../src/lib/templates";
import { localSources } from "../../src/rooms/sources";
import { gitIn, removeDir, tempDir } from "./git-fixtures";

// `pnpm dev:sources` into a temp AVEL_SOURCES_DIR: the seed's one clone, the
// template-booking fixture, at the commit its playbook's missions pin.

describe("the dev seed's sources", () => {
	const base = tempDir("dev-sources");
	const sources = path.join(base, "sources");

	afterAll(() => removeDir(base));

	it("builds only the template clone, at the fixture's head, and leaves it alone on a second run", async () => {
		const built = await buildDevSources(sources);
		expect(built).toEqual([
			{
				path: path.join(sources, "templates", "template-booking"),
				head: DEV_BOOKING_SHA,
				want: DEV_BOOKING_SHA,
			},
		]);
		expect(gitIn(built[0]?.path ?? "", "rev-parse", "HEAD")).toBe(
			DEV_BOOKING_SHA,
		);
		expect(await buildDevSources(sources)).toEqual(built);
		const resolved = await localSources(sources).resolve({
			kind: "template",
			slug: "template-booking",
			commit: DEV_BOOKING_SHA,
		});
		expect(resolved).toMatchObject({ ok: true, commit: DEV_BOOKING_SHA });
	}, 60_000);
});
