import { describe, expect, it } from "vitest";
import { canonicalJson, requestSha256 } from "../../src/lib/canonical";
import { sha256Hex } from "../../src/lib/tokens";

describe("canonicalJson", () => {
	it("sorts keys at every depth, arrays in place", () => {
		expect(
			canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }, 3], c: null } }),
		).toBe('{"a":{"c":null,"d":[{"y":2,"z":1},3]},"b":1}');
	});

	it("sorts by code unit, not by locale", () => {
		// localeCompare would put "a" before "B" and "é" before "z".
		expect(canonicalJson({ a: 1, B: 2, z: 3, é: 4, _: 5 })).toBe(
			'{"B":2,"_":5,"a":1,"z":3,"é":4}',
		);
	});

	it("keeps array order, which is meaning", () => {
		expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
	});

	it("drops undefined members and honours toJSON, as JSON.stringify does", () => {
		const at = new Date("2026-10-13T00:00:00.000Z");
		expect(canonicalJson({ b: undefined, a: at })).toBe(
			'{"a":"2026-10-13T00:00:00.000Z"}',
		);
	});

	it("keeps a __proto__ key as data", () => {
		const body = JSON.parse('{"__proto__":{"x":1},"a":2}');
		expect(canonicalJson(body)).toBe('{"__proto__":{"x":1},"a":2}');
	});

	it("serializes scalars, and no body as null", () => {
		expect(canonicalJson("x")).toBe('"x"');
		expect(canonicalJson(1.5)).toBe("1.5");
		expect(canonicalJson(undefined)).toBe("null");
	});
});

describe("requestSha256", () => {
	it("is the same for bodies differing only in key order", () => {
		const a = requestSha256({ rule: "r", severity: "high" });
		expect(a).toBe(requestSha256({ severity: "high", rule: "r" }));
		expect(a).toBe(sha256Hex('{"rule":"r","severity":"high"}'));
		expect(a).not.toBe(requestSha256({ rule: "r", severity: "low" }));
	});
});
