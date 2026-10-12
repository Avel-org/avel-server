import { describe, expect, it } from "vitest";
import {
	type AccessInput,
	type AccessSkill,
	accessFor,
	accessOverride,
	agentAccess,
	checkAccessOverrides,
	grantMode,
} from "../../src/contract";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const capability = (
	n: number,
	slug: string,
	grants: string[],
	over: Partial<AccessSkill> = {},
): AccessSkill => ({
	id: id(n),
	slug,
	type: "capability",
	layer: "role",
	status: "approved",
	recommendedFor: ["schema"],
	grants,
	...over,
});

const migrate = capability(1, "migrate", ["db:migrate"]);
const browser = capability(2, "browser", ["browser:read", "fs:write-tests"], {
	layer: "stack",
	recommendedFor: ["frontend-tests"],
});
const knowledge: AccessSkill = {
	id: id(3),
	slug: "contract-first",
	type: "knowledge",
	layer: "role",
	status: "approved",
	recommendedFor: ["schema"],
	grants: null,
};

const base: AccessInput = {
	roles: ["schema", "frontend-tests"],
	writablePaths: ["src/db/"],
	skills: [browser, migrate, knowledge],
	missionSkillIds: [browser.id],
};

const grants = (input: AccessInput) =>
	accessFor(input)
		.rows.filter((r) => r.kind === "grant")
		.map((r) =>
			r.kind === "grant" ? `${r.skillSlug}/${r.grant}=${r.mode}` : "",
		);

describe("grantMode", () => {
	it("reads only on the verb read", () => {
		expect(grantMode("browser:read")).toBe("read");
		expect(grantMode("db:migrate")).toBe("write_held");
		expect(grantMode("db:read-write")).toBe("write_held");
		expect(grantMode("read")).toBe("write_held");
		expect(grantMode("fs:")).toBe("write_held");
	});
});

describe("accessFor", () => {
	it("orders repository, tools by slug, then delivery, and says not enforced", () => {
		const access = accessFor(base);
		expect(agentAccess.parse(access)).toEqual(access);
		expect(access.enforced).toBe(false);
		expect(access.rows[0]).toEqual({
			kind: "repository",
			mode: "write_held",
			scope: ["src/db/"],
		});
		expect(access.rows.at(-1)).toEqual({
			kind: "delivery",
			mode: "send_after_approval",
		});
		expect(grants(base)).toEqual([
			"browser/browser:read=read",
			"browser/fs:write-tests=write_held",
			"migrate/db:migrate=write_held",
		]);
		const browserRead = access.rows[1];
		expect(browserRead).toMatchObject({
			system: "browser",
			skillId: browser.id,
		});
	});

	it("reads the repository when the agent may write nowhere", () => {
		expect(accessFor({ ...base, writablePaths: [] }).rows[0]).toEqual({
			kind: "repository",
			mode: "read",
			scope: [],
		});
	});

	it("takes a stack or domain skill only when it is attached to the mission", () => {
		expect(grants({ ...base, missionSkillIds: [] })).toEqual([
			"migrate/db:migrate=write_held",
		]);
	});

	it("takes only approved skills recommended for one of the agent's roles", () => {
		expect(grants({ ...base, roles: ["frontend-tests"] })).toEqual([
			"browser/browser:read=read",
			"browser/fs:write-tests=write_held",
		]);
		const draft = { ...migrate, status: "draft" as const };
		const retired = { ...migrate, id: id(9), status: "retired" as const };
		expect(grants({ ...base, skills: [draft, retired] })).toEqual([]);
	});

	it("makes no row for a knowledge skill", () => {
		expect(grants({ ...base, skills: [knowledge] })).toEqual([]);
	});

	it("makes one row for a grant listed twice", () => {
		const twice = capability(4, "twice", ["db:read", "db:read"]);
		expect(grants({ ...base, skills: [twice] })).toEqual([
			"twice/db:read=read",
		]);
	});

	it("sorts by code unit, not locale", () => {
		const upper = capability(5, "Zeta", ["a:b"]);
		const lower = capability(6, "alpha", ["a:b"]);
		expect(grants({ ...base, skills: [lower, upper] })).toEqual([
			"Zeta/a:b=write_held",
			"alpha/a:b=write_held",
		]);
	});

	it("applies an override that narrows", () => {
		const input = {
			...base,
			overrides: [
				{ skillId: migrate.id, grant: "db:migrate", mode: "none" as const },
				{ skillId: browser.id, grant: "fs:write-tests", mode: "read" as const },
			],
		};
		expect(grants(input)).toEqual([
			"browser/browser:read=read",
			"browser/fs:write-tests=read",
			"migrate/db:migrate=none",
		]);
		const row = accessFor(input).rows.find(
			(r) => r.kind === "grant" && r.grant === "db:migrate",
		);
		expect(row).toMatchObject({ derivedMode: "write_held", mode: "none" });
	});

	it("never lets an override raise a mode", () => {
		const raised = accessOverride.safeParse({
			skillId: browser.id,
			grant: "browser:read",
			mode: "write_held",
		});
		expect(raised.success).toBe(false);
	});

	it("ignores an override that names no row", () => {
		const input = {
			...base,
			overrides: [
				{ skillId: id(99), grant: "db:migrate", mode: "none" as const },
			],
		};
		expect(grants(input)).toEqual(grants(base));
	});
});

describe("checkAccessOverrides", () => {
	const rows = accessFor(base).rows;

	it("passes overrides that narrow or keep a row the agent has", () => {
		expect(
			checkAccessOverrides(rows, [
				{ skillId: migrate.id, grant: "db:migrate", mode: "read" },
				{ skillId: browser.id, grant: "browser:read", mode: "read" },
				{ skillId: browser.id, grant: "fs:write-tests", mode: "none" },
			]),
		).toEqual([]);
	});

	it("refuses an override that names no tool row", () => {
		expect(
			checkAccessOverrides(rows, [
				{ skillId: migrate.id, grant: "db:drop", mode: "none" },
			]),
		).toEqual([{ path: [0], message: expect.stringContaining("no tool row") }]);
	});

	it("refuses a row named twice", () => {
		const o = {
			skillId: migrate.id,
			grant: "db:migrate",
			mode: "none" as const,
		};
		expect(checkAccessOverrides(rows, [o, { ...o, mode: "read" }])).toEqual([
			{ path: [1], message: expect.stringContaining("twice") },
		]);
	});

	it("refuses raising a read grant", () => {
		const derivedRead = accessFor({
			...base,
			skills: [capability(7, "reader", ["db:read"])],
		}).rows;
		const raise = { skillId: id(7), grant: "db:read", mode: "read" as const };
		expect(checkAccessOverrides(derivedRead, [raise])).toEqual([]);
		// The only raise left for a read row is through a mode the schema
		// refuses, so check the guard directly with an unchecked value.
		const forced = { ...raise, mode: "write_held" } as unknown as typeof raise;
		expect(checkAccessOverrides(derivedRead, [forced])).toEqual([
			{ path: [0, "mode"], message: expect.stringContaining("only narrows") },
		]);
	});
});
