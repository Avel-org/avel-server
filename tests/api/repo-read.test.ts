import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	type BriefInput,
	clientSchema,
	connectionSchema,
	engagementSchema,
	errorEnvelope,
	intakeSchema,
	missionDetail,
	preconditionDetails,
	successEnvelope,
} from "../../src/contract";
import { activityLog, connection } from "../../src/db/schema";
import { lowConfidenceIssues } from "../../src/lib/repo-read/conventions";
import { readRepo } from "../../src/lib/repo-read/index";
import { ApiError } from "../../src/middleware/errors";
import { fixture, fixtureRepos } from "../unit/repo-fixtures";
import { type ApiHarness, clock, closeApi, withApi } from "./support";

const url = process.env.DATABASE_URL;
const one = successEnvelope(intakeSchema);

const BRIEF: BriefInput = {
	summary: "Online booking",
	requirements: [{ id: "R1", text: "A customer books a slot" }],
	acceptanceCriteria: [{ id: "AC1", requirementId: "R1", text: "It shows" }],
};
const REPO = "https://github.com/meridian-co/app";

type H = ApiHarness & {
	engagementId: string;
	connectionId: string;
	intakeId: string;
	repos: ReturnType<typeof fixtureRepos>;
	post: (path: string, body?: unknown) => Promise<Response>;
	newConnection: (over?: Record<string, unknown>) => Promise<string>;
};

/**
 * Signed in, with an engagement, an owner-scoped connection whose credential
 * resolves, and a draft intake that passes the check. meridian-co/app serves
 * `served`; other repositories answer as the map says.
 */
async function withRead(
	served: Parameters<typeof fixtureRepos>[0],
	fn: (h: H) => Promise<void>,
) {
	const repos = fixtureRepos(served);
	await withApi(
		async (api) => {
			await api.signIn();
			const post = (path: string, body?: unknown) =>
				api.call(path, { method: "POST", body });
			const c = await post("/api/clients", { name: "Meridian" });
			const clientId = successEnvelope(clientSchema).parse(await c.json()).data
				.id;
			const e = await post("/api/engagements", {
				clientId,
				name: "App build",
			});
			const engagementId = successEnvelope(engagementSchema).parse(
				await e.json(),
			).data.id;
			const newConnection = async (over: Record<string, unknown> = {}) => {
				const res = await post("/api/connections", {
					engagementId,
					label: "Meridian",
					scopeType: "owner",
					scopeValue: "meridian-co",
					credentialRef: "MERIDIAN_GITHUB_TOKEN",
					...over,
				});
				expect(res.status, await res.clone().text()).toBe(201);
				return successEnvelope(connectionSchema).parse(await res.json()).data
					.id;
			};
			const connectionId = await newConnection();
			const i = await post("/api/intakes", {
				engagementId,
				sourceMd: "Call notes",
				proposedBrief: BRIEF,
			});
			const intakeId = one.parse(await i.json()).data.id;
			await fn({
				...api,
				engagementId,
				connectionId,
				intakeId,
				repos,
				post,
				newConnection,
			});
		},
		{ repos },
	);
}

async function read(h: H, over: Record<string, unknown> = {}) {
	return h.post(`/api/intakes/${h.intakeId}/read-repo`, {
		connectionId: h.connectionId,
		repoUrl: REPO,
		...over,
	});
}

async function refusal(res: Response, status: number) {
	expect(res.status, await res.clone().text()).toBe(status);
	return errorEnvelope.parse(await res.json()).error;
}

describe.skipIf(!url)("POST /api/intakes/:id/read-repo", () => {
	afterAll(closeApi);

	it("refuses without a session with 401", async () => {
		await withApi(async (api) => {
			const res = await api.app.request(
				"/api/intakes/00000000-0000-4000-8000-000000000001/read-repo",
				{ method: "POST" },
			);
			expect(res.status).toBe(401);
		});
	});

	it("reads one commit and writes the cut, conventions and boundaries with their evidence", async () => {
		const snapshot = fixture("nest-feature");
		await withRead({ "meridian-co/app": snapshot }, async (h) => {
			const res = await read(h, {
				repoUrl: "https://github.com/Meridian-Co/App.git",
			});
			const intake = (
				await (async () => {
					expect(res.status, await res.clone().text()).toBe(200);
					return one.parse(await res.json());
				})()
			).data;
			const expected = readRepo(snapshot);
			expect(intake).toMatchObject({
				status: "draft",
				derivedCut: "vertical",
				derivedCutEvidence: expected.cutEvidence,
				derivedConventions: expected.conventions,
				derivedBoundaries: expected.boundaries,
				repoUrl: REPO,
				repoCommitSha: snapshot.commitSha,
				repoReadAt: clock.now().toISOString(),
			});
			expect(h.repos.requests).toEqual([
				{
					owner: "meridian-co",
					repo: "app",
					ref: undefined,
					credentialRef: "MERIDIAN_GITHUB_TOKEN",
				},
			]);
			const rows = await h.tx
				.select()
				.from(activityLog)
				.where(eq(activityLog.entityId, h.intakeId));
			expect(rows.at(-1)).toMatchObject({
				action: "intake.repo_read",
				entityType: "intake",
				engagementId: h.engagementId,
				payload: {
					connectionId: h.connectionId,
					repoUrl: REPO,
					ref: null,
					commitSha: snapshot.commitSha,
					cut: "vertical",
					confidence: "high",
				},
			});
		});
	});

	it("re-reads a proposed intake without changing its status, replacing what it derived", async () => {
		await withRead(
			{ "meridian-co/app": fixture("nest-feature") },
			async (h) => {
				await read(h);
				await h.post(`/api/intakes/${h.intakeId}/propose`);
				h.repos.snapshot = async (req) => {
					h.repos.requests.push(req);
					return fixture("express-layer");
				};
				const res = await read(h, { ref: "release" });
				const intake = one.parse(await res.json()).data;
				expect(intake.status).toBe("proposed");
				expect(intake.derivedCut).toBe("horizontal");
				expect(intake.repoCommitSha).toBe(fixture("express-layer").commitSha);
				expect(h.repos.requests.at(-1)?.ref).toBe("release");
			},
		);
	});

	it("refuses an intake past proposed with 409, before GitHub is asked", async () => {
		await withRead(
			{ "meridian-co/app": fixture("nest-feature") },
			async (h) => {
				await h.post(`/api/intakes/${h.intakeId}/reject`, { reason: "No" });
				await refusal(await read(h), 409);
				expect(h.repos.requests).toEqual([]);
			},
		);
	});

	it("refuses a connection it cannot use, before GitHub is asked", async () => {
		await withRead(
			{ "meridian-co/app": fixture("nest-feature") },
			async (h) => {
				const reasonOf = async (res: Response) => {
					const e = await refusal(res, 422);
					return e.code === "PRECONDITION_FAILED"
						? preconditionDetails.parse(e.details)
						: { code: e.code, details: e.details };
				};

				const missing = "00000000-0000-4000-8000-00000000ffff";
				expect(
					await reasonOf(await read(h, { connectionId: missing })),
				).toEqual({
					reason: "connection_not_found",
					connectionId: missing,
				});

				// Another engagement's connection is not this intake's.
				const c = await h.post("/api/clients", { name: "Other" });
				const otherClient = successEnvelope(clientSchema).parse(await c.json())
					.data.id;
				const e = await h.post("/api/engagements", {
					clientId: otherClient,
					name: "Other",
				});
				const otherEngagement = successEnvelope(engagementSchema).parse(
					await e.json(),
				).data.id;
				const foreign = await h.newConnection({
					engagementId: otherEngagement,
				});
				expect(
					await reasonOf(await read(h, { connectionId: foreign })),
				).toMatchObject({ reason: "connection_not_found" });

				const revoked = await h.newConnection();
				await h.tx
					.update(connection)
					.set({ status: "revoked", revokedAt: clock.now() })
					.where(eq(connection.id, revoked));
				expect(
					await reasonOf(await read(h, { connectionId: revoked })),
				).toEqual({
					code: "CONNECTION_REVOKED",
					details: { connectionId: revoked },
				});

				const expired = await h.newConnection();
				await h.tx
					.update(connection)
					.set({ status: "expired" })
					.where(eq(connection.id, expired));
				expect(
					await reasonOf(await read(h, { connectionId: expired })),
				).toEqual({
					reason: "connection_expired",
					connectionId: expired,
				});
				const lapsed = await h.newConnection({
					expiresAt: clock.now().toISOString(),
				});
				expect(
					await reasonOf(await read(h, { connectionId: lapsed })),
				).toMatchObject({ reason: "connection_expired" });

				for (const over of [
					{ scopeType: "owner", scopeValue: "other-co" },
					{ scopeType: "repo", scopeValue: "meridian-co/other" },
				]) {
					const narrow = await h.newConnection(over);
					expect(
						await reasonOf(await read(h, { connectionId: narrow })),
					).toEqual({
						reason: "connection_scope_mismatch",
						connectionId: narrow,
					});
				}
				const exact = await h.newConnection({
					scopeType: "repo",
					scopeValue: "Meridian-Co/App",
				});

				const unset = await h.newConnection({ credentialRef: "UNSET_TOKEN" });
				expect(await reasonOf(await read(h, { connectionId: unset }))).toEqual({
					reason: "connection_credential_missing",
					connectionId: unset,
				});

				expect(h.repos.requests).toEqual([]);
				// A repo scope that names this repository, in any case, may read it.
				expect((await read(h, { connectionId: exact })).status).toBe(200);
			},
		);
	});

	it("refuses a URL that is not a GitHub repository with 400", async () => {
		await withRead({}, async (h) => {
			for (const repoUrl of [
				"https://gitlab.com/meridian-co/app",
				"http://github.com/meridian-co/app",
				"https://github.com/meridian-co",
				"https://github.com/meridian-co/app/tree/main",
			]) {
				expect((await read(h, { repoUrl })).status, repoUrl).toBe(400);
			}
		});
	});

	it("passes GitHub's failures through and leaves the intake unread", async () => {
		await withRead(
			{
				"meridian-co/empty": new ApiError("EMPTY_REPOSITORY", "no commits"),
				"meridian-co/huge": new ApiError("TREE_TOO_LARGE", "too large"),
			},
			async (h) => {
				for (const [repo, status, code] of [
					["app", 404, "REPO_NOT_FOUND"],
					["empty", 422, "EMPTY_REPOSITORY"],
					["huge", 502, "TREE_TOO_LARGE"],
				] as const) {
					const e = await refusal(
						await read(h, {
							repoUrl: `https://github.com/meridian-co/${repo}`,
						}),
						status,
					);
					expect(e.code).toBe(code);
				}
				const intake = one.parse(
					await (await h.call(`/api/intakes/${h.intakeId}`)).json(),
				).data;
				expect(intake).toMatchObject({
					derivedCut: null,
					repoUrl: null,
					repoCommitSha: null,
					repoReadAt: null,
				});
			},
		);
	});
});

describe.skipIf(!url)("approving a read intake", () => {
	afterAll(closeApi);

	const approve = (h: H, repoUrl = REPO) =>
		h.post(`/api/intakes/${h.intakeId}/approve`, {
			missionType: "full-build",
			repoUrl,
			spendCeilingUsd: 40,
		});

	it("builds the Mission on the repository that was read", async () => {
		await withRead(
			{ "meridian-co/app": fixture("nest-feature") },
			async (h) => {
				await read(h);
				await h.post(`/api/intakes/${h.intakeId}/propose`);
				const res = await approve(h, "https://github.com/MERIDIAN-CO/app/");
				expect(res.status, await res.clone().text()).toBe(200);
				const missionId = one.parse(await res.json()).data.missionId;
				const mission = successEnvelope(missionDetail).parse(
					await (await h.call(`/api/missions/${missionId}`)).json(),
				).data;
				expect(mission).toMatchObject({
					repoUrl: REPO,
					cut: "vertical",
					cutSource: "derived",
				});
			},
		);
	});

	it("refuses a repository other than the one read with 422 intake_repo_mismatch", async () => {
		await withRead(
			{ "meridian-co/app": fixture("nest-feature") },
			async (h) => {
				await read(h);
				await h.post(`/api/intakes/${h.intakeId}/propose`);
				const e = await refusal(
					await approve(h, "https://github.com/meridian-co/other"),
					422,
				);
				expect(preconditionDetails.parse(e.details)).toEqual({
					reason: "intake_repo_mismatch",
					engagementId: h.engagementId,
				});
			},
		);
	});

	it("refuses low-confidence conventions, saying exactly what disagreed", async () => {
		const snapshot = fixture("competing-tests");
		await withRead({ "meridian-co/app": snapshot }, async (h) => {
			await read(h);
			await h.post(`/api/intakes/${h.intakeId}/propose`);
			const e = await refusal(await approve(h), 422);
			const details = preconditionDetails.parse(e.details);
			expect(details).toEqual({
				reason: "intake_conventions_low_confidence",
				engagementId: h.engagementId,
				issues: lowConfidenceIssues(readRepo(snapshot).conventions),
			});
			expect(details.issues?.map((i) => i.message)).toEqual([
				"testing: naming: 6 .spec (60%), 4 .test (40%)",
				"formatting: tools: prettier (.prettierrc), biome (biome.json)",
			]);
			// The repository is checked before the conventions.
			const mismatch = await refusal(
				await approve(h, "https://github.com/meridian-co/other"),
				422,
			);
			expect(preconditionDetails.parse(mismatch.details).reason).toBe(
				"intake_repo_mismatch",
			);
		});
	});

	it("refuses a read that derived no cut with 422 intake_cut_not_derived", async () => {
		await withRead({ "meridian-co/app": fixture("mixed-cut") }, async (h) => {
			const res = await read(h);
			expect(one.parse(await res.json()).data.derivedCut).toBeNull();
			await h.post(`/api/intakes/${h.intakeId}/propose`);
			const e = await refusal(await approve(h), 422);
			expect(preconditionDetails.parse(e.details).reason).toBe(
				"intake_cut_not_derived",
			);
		});
	});
});
