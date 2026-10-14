import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type AttachedSkill,
	dispatchSkillSet,
	skillsSha256,
} from "../../src/runner/skills";

const hex = (c: string) => c.repeat(64);
const sha = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

const skill = (
	slug: string,
	over: Partial<AttachedSkill> = {},
): AttachedSkill => ({
	id: `00000000-0000-4000-8000-${slug.padStart(12, "0").slice(-12)}`,
	slug,
	contentSha256: hex("a"),
	layer: "stack",
	status: "approved",
	recommendedFor: ["domain"],
	...over,
});

describe("skillsSha256", () => {
	it("hashes the canonical JSON of [{slug, contentSha256}] sorted by slug", () => {
		expect(
			skillsSha256([
				{ slug: "zod", contentSha256: hex("b") },
				{ slug: "drizzle", contentSha256: hex("a") },
			]),
		).toBe(
			sha(
				`[{"contentSha256":"${hex("a")}","slug":"drizzle"},{"contentSha256":"${hex("b")}","slug":"zod"}]`,
			),
		);
	});

	it("hashes no skills as [], never null", () => {
		expect(skillsSha256([])).toBe(sha("[]"));
	});

	it("ignores input order and extra fields, and sorts by code unit", () => {
		const a = skill("Zeta");
		const b = skill("alpha", { contentSha256: hex("c") });
		expect(skillsSha256([a, b])).toBe(skillsSha256([b, a]));
		expect(skillsSha256([a, b])).toBe(
			sha(
				`[{"contentSha256":"${hex("a")}","slug":"Zeta"},{"contentSha256":"${hex("c")}","slug":"alpha"}]`,
			),
		);
	});

	it("changes with any skill's content or slug", () => {
		const base = skillsSha256([skill("next")]);
		expect(skillsSha256([skill("next", { contentSha256: hex("e") })])).not.toBe(
			base,
		);
		expect(skillsSha256([skill("nextjs")])).not.toBe(base);
	});
});

describe("dispatchSkillSet", () => {
	it("keeps approved stack and domain skills recommended for one of the roles", () => {
		const kept = dispatchSkillSet(
			["domain", "api-surface"],
			[
				skill("stack-ok"),
				skill("domain-ok", {
					layer: "domain",
					recommendedFor: ["api-surface"],
				}),
				skill("draft", { status: "draft" }),
				skill("retired", { status: "retired" }),
				skill("other-role", { recommendedFor: ["security-review"] }),
			],
		);
		expect(kept.map((s) => s.slug)).toEqual(["domain-ok", "stack-ok"]);
	});

	it("leaves the role layer out, so a role skill never moves the hash", () => {
		const stack = [skill("drizzle")];
		const role = skill("property-tests", { layer: "role" });
		const changed = { ...role, contentSha256: hex("f") };
		const hashOf = (attached: AttachedSkill[]) =>
			skillsSha256(dispatchSkillSet(["domain"], attached));
		expect(dispatchSkillSet(["domain"], [...stack, role])).toEqual(stack);
		expect(hashOf([...stack, role])).toBe(hashOf(stack));
		expect(hashOf([...stack, changed])).toBe(hashOf(stack));
	});
});
