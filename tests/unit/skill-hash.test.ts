import { describe, expect, it } from "vitest";
import {
	type HashedSkillFields,
	skillContentSha256,
} from "../../src/lib/skill-hash";

const base: HashedSkillFields = {
	description: "Use when a list pages.",
	contentMd: "# Keyset\n",
	avelEnhancementMd: null,
	grants: null,
	ioShape: null,
	type: "knowledge",
	layer: "stack",
};

describe("skillContentSha256", () => {
	it("is a stable 64-hex digest", () => {
		const hash = skillContentSha256(base);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(skillContentSha256({ ...base })).toBe(hash);
	});

	it("pins the v1 encoding", () => {
		// Changing the encoding changes every stored hash. Bump SKILL_HASH_VERSION
		// and update this value in the same change. Cross-checked with Python:
		// sha256(json.dumps([version, ...fields], separators=(",", ":"))).
		expect(skillContentSha256(base)).toBe(
			"f7f4823f285451375afe8a1e2fb6ca93ddb3cea0a8b24ba7f06deb39cd64486f",
		);
	});

	it("changes with every hashed field", () => {
		const hash = skillContentSha256(base);
		const variants: HashedSkillFields[] = [
			{ ...base, description: "Other." },
			{ ...base, contentMd: "# Other\n" },
			{ ...base, avelEnhancementMd: "## Notes\n" },
			{ ...base, layer: "domain" },
			{
				...base,
				type: "capability",
				grants: ["read:source"],
				ioShape: { reads: "large", returns: "small" },
			},
		];
		const hashes = variants.map(skillContentSha256);
		for (const h of hashes) expect(h).not.toBe(hash);
		expect(new Set(hashes).size).toBe(hashes.length);
	});

	it("tells grants order and ioShape direction apart", () => {
		const cap: HashedSkillFields = {
			...base,
			type: "capability",
			grants: ["a", "b"],
			ioShape: { reads: "large", returns: "small" },
		};
		const hash = skillContentSha256(cap);
		expect(skillContentSha256({ ...cap, grants: ["b", "a"] })).not.toBe(hash);
		expect(
			skillContentSha256({
				...cap,
				ioShape: { reads: "small", returns: "large" },
			}),
		).not.toBe(hash);
	});

	it("does not depend on ioShape key order", () => {
		const cap: HashedSkillFields = {
			...base,
			type: "capability",
			grants: ["a"],
			ioShape: { reads: "large", returns: "small" },
		};
		const reordered = {
			...cap,
			ioShape: {
				returns: "small",
				reads: "large",
			} as HashedSkillFields["ioShape"],
		};
		expect(skillContentSha256(reordered)).toBe(skillContentSha256(cap));
	});

	it("does not move when an unhashed difference is added", () => {
		const withExtra = { ...base, name: "Ignored", slug: "ignored" };
		expect(skillContentSha256(withExtra)).toBe(skillContentSha256(base));
	});
});
