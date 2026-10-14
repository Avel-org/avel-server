import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	type ActivityEntry,
	activityAction,
	activityActorKind,
	activityEntityType,
	activityListEnvelope,
	errorEnvelope,
} from "../../src/contract";
import {
	activityAction as activityActionEnum,
	activityEntityType as activityEntityTypeEnum,
	activityLog,
	actorKind as actorKindEnum,
	agentTemplate,
	client,
	engagement,
	mission,
	rosterEntry,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { randomIds } from "../../src/lib/ids";
import { clock, closeApi, prefixedIds, statements, withApi } from "./support";

const url = process.env.DATABASE_URL;
const at = (minutes: number) =>
	new Date(clock.now().getTime() + minutes * 60_000);

type Seeded = {
	/** Row ids by name. Every row is newer than the operator's sign-in row. */
	row: Record<"a" | "b" | "c" | "d" | "e" | "f", string>;
	/** Every seeded row id, newest first. */
	newestFirst: string[];
	clientId: string;
	e1: string;
	e2: string;
	m1: string;
	m2: string;
	exportId: string;
	rosterEntryId: string;
	template: string;
	operatorId: string;
	/** The signed-in operator's GitHub login, which labels their rows. */
	operatorLogin: string;
	/** The seed's own id block, so a test can tell its rows from any other. */
	prefix: string;
};

/**
 * Six rows across two engagements and two missions, every actor kind, and
 * two rows (c, d) at the same instant so the id tiebreak shows. Newest
 * first they are f, e, d, c, b, a.
 */
async function seed(
	tx: Tx,
	operatorId: string,
	operatorLogin: string,
): Promise<Seeded> {
	const prefix = randomIds.next().slice(0, 8);
	const ids = prefixedIds(prefix);
	const clientId = ids.next();
	await tx.insert(client).values({
		id: clientId,
		name: "Meridian",
		status: "active",
		...stamp(clock),
	});
	const [e1, e2] = [ids.next(), ids.next()];
	for (const id of [e1, e2]) {
		await tx.insert(engagement).values({
			id,
			clientId,
			name: `Engagement ${id}`,
			status: "active",
			startedAt: clock.now(),
			...stamp(clock),
		});
	}
	const [m1, m2] = [ids.next(), ids.next()];
	for (const [id, engagementId] of [
		[m1, e1],
		[m2, e2],
	] as const) {
		await tx.insert(mission).values({
			id,
			origin: "client",
			engagementId,
			type: "full-build",
			brief: {},
			sprintN: 1,
			status: "active",
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/meridian-co/app",
			...stamp(clock),
		});
	}
	const template = ids.next();
	await tx.insert(agentTemplate).values({
		id: template,
		slug: "backend",
		name: "Backend",
		kind: "feature",
		roles: ["domain"],
		waveDefaults: ["A"],
		writablePaths: ["src/**"],
		version: 1,
		...stamp(clock),
	});
	const rosterEntryId = ids.next();
	await tx.insert(rosterEntry).values({
		id: rosterEntryId,
		missionId: m1,
		agentTemplateId: template,
		active: true,
		waves: ["A"],
		grain: "default",
		absorbedBoundaries: [],
		territory: "booking",
		...stamp(clock),
	});
	const exportId = ids.next();

	const operator = { actorKind: "operator" as const, actorUserId: operatorId };
	const system = { actorKind: "system" as const };
	const agent = {
		actorKind: "agent" as const,
		actorRosterEntryId: rosterEntryId,
	};
	const rows = {
		a: {
			at: at(1),
			...operator,
			action: "client.created" as const,
			entityType: "client" as const,
			entityId: clientId,
		},
		b: {
			at: at(2),
			...system,
			action: "engagement.created" as const,
			entityType: "engagement" as const,
			entityId: e1,
			engagementId: e1,
		},
		c: {
			at: at(3),
			...system,
			action: "mission.created" as const,
			entityType: "mission" as const,
			entityId: m1,
			missionId: m1,
			engagementId: e1,
		},
		d: {
			at: at(3),
			...agent,
			action: "export.created" as const,
			entityType: "export" as const,
			entityId: exportId,
			missionId: m1,
			engagementId: e1,
		},
		e: {
			at: at(4),
			...system,
			action: "mission.created" as const,
			entityType: "mission" as const,
			entityId: m2,
			missionId: m2,
			engagementId: e2,
		},
		f: {
			at: at(5),
			...operator,
			action: "mission.status_changed" as const,
			entityType: "mission" as const,
			entityId: m1,
			missionId: m1,
			engagementId: e1,
		},
	};
	const row = {} as Seeded["row"];
	for (const [name, values] of Object.entries(rows)) {
		const id = ids.next();
		row[name as keyof typeof rows] = id;
		await tx.insert(activityLog).values({
			id,
			requestId: `req-${name}`,
			payload: { name },
			...values,
		});
	}
	return {
		row,
		newestFirst: [row.f, row.e, row.d, row.c, row.b, row.a],
		clientId,
		e1,
		e2,
		m1,
		m2,
		exportId,
		rosterEntryId,
		template,
		operatorId,
		operatorLogin,
		prefix,
	};
}

type Call = (path: string) => Promise<Response>;

async function withActivity(
	fn: (call: Call, s: Seeded, tx: Tx) => Promise<void>,
) {
	await withApi(async (api) => {
		await api.signIn();
		const s = await seed(api.tx, await api.operatorId(), api.operator.login);
		await fn((path) => api.call(path), s, api.tx);
	});
}

async function listOf(call: Call, query: string) {
	const res = await call(`/api/activity?${query}`);
	expect(res.status, await res.clone().text()).toBe(200);
	return activityListEnvelope.parse(await res.json());
}

/** The seeded rows a list returned, in its order. Rows from outside the seed are dropped. */
function seededIds(data: ActivityEntry[], s: Seeded): string[] {
	return data.map((r) => r.id).filter((id) => id.startsWith(s.prefix));
}

/** Walks every page with `limit`, returning the ids in order and each page's total. */
async function walk(call: Call, query: string, limit: number) {
	const ids: string[] = [];
	const totals: number[] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 50; i++) {
		const page = await listOf(
			call,
			`${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
		);
		ids.push(...page.data.map((r) => r.id));
		totals.push(page.meta.total);
		cursor = page.meta.nextCursor;
		if (!cursor) return { ids, totals };
	}
	throw new Error("pagination never ended");
}

describe("activity contract vocabulary", () => {
	it("matches the pgEnums exactly", () => {
		expect(activityActorKind.options).toEqual(actorKindEnum.enumValues);
		expect(activityAction.options).toEqual(activityActionEnum.enumValues);
		expect(activityEntityType.options).toEqual(
			activityEntityTypeEnum.enumValues,
		);
	});
});

describe.skipIf(!url)("/api/activity", () => {
	afterAll(closeApi);

	it("refuses a request without a session with 401", async () => {
		await withApi(async (api) => {
			const res = await api.app.request("/api/activity");
			expect(res.status).toBe(401);
			expect(errorEnvelope.parse(await res.json()).error.code).toBe(
				"UNAUTHENTICATED",
			);
		});
	});

	it("answers each row as its columns in camelCase", async () => {
		await withActivity(async (call, s) => {
			const { data } = await listOf(call, `missionId=${s.m1}`);
			expect(data).toEqual([
				{
					id: s.row.f,
					at: at(5).toISOString(),
					actorKind: "operator",
					actorUserId: s.operatorId,
					actorRosterEntryId: null,
					action: "mission.status_changed",
					entityType: "mission",
					entityId: s.m1,
					missionId: s.m1,
					engagementId: s.e1,
					requestId: "req-f",
					payload: { name: "f" },
					actor: {
						kind: "operator",
						userId: s.operatorId,
						rosterEntryId: null,
						display: s.operatorLogin,
						agent: null,
					},
				},
				{
					id: s.row.d,
					at: at(3).toISOString(),
					actorKind: "agent",
					actorUserId: null,
					actorRosterEntryId: s.rosterEntryId,
					action: "export.created",
					entityType: "export",
					entityId: s.exportId,
					missionId: s.m1,
					engagementId: s.e1,
					requestId: "req-d",
					payload: { name: "d" },
					actor: {
						kind: "agent",
						userId: null,
						rosterEntryId: s.rosterEntryId,
						display: "Backend · booking",
						agent: {
							templateId: s.template,
							slug: "backend",
							name: "Backend",
							territory: "booking",
						},
					},
				},
				{
					id: s.row.c,
					at: at(3).toISOString(),
					actorKind: "system",
					actorUserId: null,
					actorRosterEntryId: null,
					action: "mission.created",
					entityType: "mission",
					entityId: s.m1,
					missionId: s.m1,
					engagementId: s.e1,
					requestId: "req-c",
					payload: { name: "c" },
					actor: {
						kind: "system",
						userId: null,
						rosterEntryId: null,
						display: "AVEL runner",
						agent: null,
					},
				},
			]);
		});
	});

	it("labels an agent with no territory by its template name alone", async () => {
		await withActivity(async (call, s, tx) => {
			await tx
				.update(rosterEntry)
				.set({ territory: null })
				.where(eq(rosterEntry.id, s.rosterEntryId));
			const { data } = await listOf(call, "actorKind=agent");
			expect(data.find((r) => r.id === s.row.d)?.actor).toEqual({
				kind: "agent",
				userId: null,
				rosterEntryId: s.rosterEntryId,
				display: "Backend",
				agent: {
					templateId: s.template,
					slug: "backend",
					name: "Backend",
					territory: null,
				},
			});
		});
	});

	it("labels every row of a page in one query", async () => {
		await withApi(
			async (api) => {
				await api.signIn();
				const s = await seed(
					api.tx,
					await api.operatorId(),
					api.operator.login,
				);
				const from = statements.length;
				const { data } = await listOf(
					(path) => api.call(path),
					`engagementId=${s.e1}`,
				);
				expect(data.map((r) => r.actor.kind)).toEqual([
					"operator",
					"agent",
					"system",
					"system",
				]);
				const activityQueries = statements
					.slice(from)
					.filter((q) => /from "activity_log"/.test(q));
				// The page and its count: never one lookup per row.
				expect(activityQueries).toHaveLength(2);
				expect(
					statements.slice(from).filter((q) => /from "agent_template"/.test(q)),
				).toEqual([]);
			},
			{ countStatements: true },
		);
	});

	it("lists newest first, breaking a tie in `at` on id descending", async () => {
		await withActivity(async (call, s) => {
			const { data, meta } = await listOf(call, "limit=100");
			expect(seededIds(data, s)).toEqual(s.newestFirst);
			const times = data.map((r) => r.at);
			expect(times).toEqual([...times].sort().reverse());
			// The operator's sign-in row is in the same transaction and older.
			expect(data.some((r) => r.action === "auth.signed_in")).toBe(true);
			expect(meta.total).toBe(data.length);
		});
	});

	it("pages through every row once, with the same total on every page", async () => {
		await withActivity(async (call, s) => {
			const { ids, totals } = await walk(call, `engagementId=${s.e1}`, 1);
			expect(ids).toEqual([s.row.f, s.row.d, s.row.c, s.row.b]);
			expect(totals).toEqual([4, 4, 4, 4]);
		});
	});

	it("narrows by each filter, and meta.total follows", async () => {
		await withActivity(async (call, s) => {
			const all = await listOf(call, "limit=100");
			const cases: Array<{
				query: string;
				expected: string[];
				keeps: (r: ActivityEntry) => boolean;
			}> = [
				{
					query: `missionId=${s.m1}`,
					expected: [s.row.f, s.row.d, s.row.c],
					keeps: (r) => r.missionId === s.m1,
				},
				{
					query: `engagementId=${s.e2}`,
					expected: [s.row.e],
					keeps: (r) => r.engagementId === s.e2,
				},
				{
					query: "entityType=mission",
					expected: [s.row.f, s.row.e, s.row.c],
					keeps: (r) => r.entityType === "mission",
				},
				{
					query: `entityId=${s.m1}`,
					expected: [s.row.f, s.row.c],
					keeps: (r) => r.entityId === s.m1,
				},
				{
					query: "actorKind=agent",
					expected: [s.row.d],
					keeps: (r) => r.actorKind === "agent",
				},
				{
					query: "actorKind=operator",
					expected: [s.row.f, s.row.a],
					keeps: (r) => r.actorKind === "operator",
				},
				{
					query: `missionId=${s.m1}&actorKind=system`,
					expected: [s.row.c],
					keeps: (r) => r.missionId === s.m1 && r.actorKind === "system",
				},
			];
			for (const c of cases) {
				const { data, meta } = await listOf(call, `${c.query}&limit=100`);
				expect(seededIds(data, s), c.query).toEqual(c.expected);
				expect(data.every(c.keeps), c.query).toBe(true);
				expect(meta.total, c.query).toBe(data.length);
				expect(meta.total, c.query).toBeLessThan(all.meta.total);
			}
		});
	});

	it("narrows to one client's rows, through its engagements and missions", async () => {
		await withActivity(async (call, s, tx) => {
			const otherClient = randomIds.next();
			await tx.insert(client).values({
				id: otherClient,
				name: "Elsewhere",
				status: "active",
				...stamp(clock),
			});
			await tx.insert(activityLog).values({
				id: randomIds.next(),
				at: at(6),
				actorKind: "system",
				action: "client.created",
				entityType: "client",
				entityId: otherClient,
				requestId: "req-other",
				payload: {},
			});
			const { data, meta } = await listOf(
				call,
				`clientId=${s.clientId}&limit=100`,
			);
			expect(data.map((r) => r.id)).toEqual(s.newestFirst);
			expect(meta.total).toBe(s.newestFirst.length);
			const other = await listOf(call, `clientId=${otherClient}`);
			expect(other.meta.total).toBe(1);
		});
	});

	it("takes several entity ids, repeated or indexed, at most 100", async () => {
		await withActivity(async (call, s) => {
			const expected = [s.row.f, s.row.d, s.row.c];
			for (const query of [
				`entityId=${s.m1}&entityId=${s.exportId}`,
				`entityId[0]=${s.m1}&entityId[1]=${s.exportId}`,
			]) {
				const { data, meta } = await listOf(call, query);
				expect(
					data.map((r) => r.id),
					query,
				).toEqual(expected);
				expect(meta.total, query).toBe(3);
			}
			const many = (n: number) =>
				Array.from({ length: n }, () => `entityId=${s.m1}`).join("&");
			expect((await call(`/api/activity?${many(100)}`)).status).toBe(200);
			expect((await call(`/api/activity?${many(101)}`)).status).toBe(400);
		});
	});

	it("reads a cursor as a position, so other filters resume after it", async () => {
		await withActivity(async (call, s) => {
			// Two rows of e1 (f, d), so the cursor sits at d: at(3), d's id.
			const first = await listOf(call, `engagementId=${s.e1}&limit=2`);
			expect(first.data.map((r) => r.id)).toEqual([s.row.f, s.row.d]);
			const cursor = first.meta.nextCursor;
			expect(cursor).not.toBeNull();

			// c shares d's instant with a smaller id, so it comes after d.
			const sameInstant = await listOf(
				call,
				`entityId=${s.m1}&cursor=${cursor}`,
			);
			expect(sameInstant.data.map((r) => r.id)).toEqual([s.row.c]);
			expect(sameInstant.meta.total).toBe(2);

			// m2's only row (e) is newer than the position, so nothing follows.
			const none = await listOf(call, `missionId=${s.m2}&cursor=${cursor}`);
			expect(none.data).toEqual([]);
			expect(none.meta).toEqual({ nextCursor: null, total: 1 });
		});
	});

	it("refuses a forged cursor and values outside the closed lists with 400", async () => {
		await withActivity(async (call) => {
			for (const query of [
				"cursor=%%%",
				`cursor=${Buffer.from('["not a date","x"]').toString("base64url")}`,
				"actorKind=robot",
				"entityType=gate_decision",
				"missionId=not-a-uuid",
				"engagementId=not-a-uuid",
				"entityId=not-a-uuid",
			]) {
				const res = await call(`/api/activity?${query}`);
				expect(res.status, query).toBe(400);
				expect(errorEnvelope.parse(await res.json()).error.code, query).toBe(
					"VALIDATION_FAILED",
				);
			}
		});
	});
});
