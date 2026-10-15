import { describe, expect, it } from "vitest";
import {
	FAKE_HARNESS_MODEL,
	FakeHarness,
	type HarnessSession,
} from "../../src/runner/harness";

const split = (tokensIn: number) => ({
	tokensIn,
	tokensOut: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
});

const session = (dispatchId: string): HarnessSession => ({
	dispatchId,
	token: `avl_dsp_${dispatchId}`,
	model: FAKE_HARNESS_MODEL,
	roomRoot: `rooms/${dispatchId}`,
	writableGlobs: [],
	identityMd: "# Kel",
	briefMd: null,
	skills: [],
});

describe("FakeHarness", () => {
	it("runs fake-harness unless told another model", () => {
		expect(new FakeHarness().model).toBe("fake-harness");
		expect(new FakeHarness({ model: "unpriced" }).model).toBe("unpriced");
	});

	it("plays a script's steps in order, then its outcome, then nothing", async () => {
		const h = new FakeHarness();
		h.script("d1", { steps: [split(1), split(2)], outcome: "fail" });
		expect(await h.start(session("d1"))).toBe(true);
		expect(await h.next("d1")).toEqual({ kind: "usage", split: split(1) });
		expect(await h.next("d1")).toEqual({ kind: "usage", split: split(2) });
		expect(await h.next("d1")).toEqual({ kind: "fail" });
		expect(await h.next("d1")).toBeNull();
	});

	for (const outcome of ["complete", "blocked"] as const) {
		it(`reports ${outcome} as its outcome`, async () => {
			const h = new FakeHarness();
			h.script("d1", { steps: [], outcome });
			await h.start(session("d1"));
			expect(await h.next("d1")).toEqual({ kind: outcome });
		});
	}

	it("runs an unscripted session until it is stopped", async () => {
		const h = new FakeHarness();
		await h.start(session("d1"));
		expect(await h.has("d1")).toBe(true);
		expect(await h.next("d1")).toBeNull();
		expect(h.tokenFor("d1")).toBe("avl_dsp_d1");
		expect(h.roomFor("d1")).toBe("rooms/d1");
		await h.stop("d1");
		expect(await h.has("d1")).toBe(false);
		expect(h.stopped).toEqual(["d1"]);
		expect(h.tokenFor("d1")).toBeUndefined();
	});

	it("refuses every start while not accepting", async () => {
		const h = new FakeHarness();
		h.accepting = false;
		expect(await h.start(session("d1"))).toBe(false);
		expect(await h.has("d1")).toBe(false);
	});

	it("forgets every session on restart", async () => {
		const h = new FakeHarness();
		await h.start(session("d1"));
		h.restart();
		expect(await h.has("d1")).toBe(false);
		expect(await h.next("d1")).toBeNull();
	});
});
