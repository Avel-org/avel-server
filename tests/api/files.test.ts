import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { file, intakeFiles } from "../../src/db/schema";
import { withClientScope } from "../../src/db/tx";
import {
	type BlobStore,
	localDiskBlobs,
	memoryBlobs,
	sha256Of,
} from "../../src/gateways/blob";
import { sequentialIds } from "../../src/lib/ids";
import { MAX_BODY_BYTES } from "../../src/middleware/body-limit";
import { DEFAULT_UPLOAD_MAX_BYTES, detectMime } from "../../src/routes/files";
import { seedTenants } from "../db/app-role";
import { BASE_URL } from "../unit/support";
import { type ApiHarness, closeApi, withApi } from "./support";

const text = (s: string) => new TextEncoder().encode(s);
const BRIEF = text("# Brief\n\nSign-in with GitHub.\n");
const PAGE = text(
	"<!DOCTYPE html>\n<html><body><script>alert(1)</script></body></html>\n",
);

describe("detectMime", () => {
	it("reads the type from the bytes; the name only chooses Markdown over plain text", () => {
		expect(detectMime(BRIEF, "brief.md")).toBe("text/markdown");
		expect(detectMime(BRIEF, "brief.MARKDOWN")).toBe("text/markdown");
		expect(detectMime(BRIEF, "brief.txt")).toBe("text/plain");
		expect(detectMime(text(""), "empty.md")).toBe("text/markdown");
		// HTML is HTML whatever it is called, leading whitespace and BOM included.
		expect(detectMime(PAGE, "brief.md")).toBe("text/html");
		expect(
			detectMime(
				text(`${String.fromCharCode(0xfeff)}  
<html lang=en>`),
				"a.txt",
			),
		).toBe("text/html");
		expect(detectMime(text("<p>hi</p>"), "a.md")).toBe("text/html");
		expect(detectMime(text("<!-- note -->"), "a.md")).toBe("text/html");
		// A tag that only starts like one on the list is not HTML.
		expect(detectMime(text("<abbr>x</abbr>"), "a.md")).toBe("text/markdown");
	});

	it("refuses binary, invalid UTF-8, control characters, SVG and XML", () => {
		for (const [why, bytes] of [
			["png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
			["nul", text("# a\u0000b")],
			["escape", text("# a\u001bb")],
			["invalid utf-8", new Uint8Array([0x23, 0x20, 0xc3, 0x28])],
			["svg", text("<svg xmlns='http://www.w3.org/2000/svg'/>")],
			["xml", text("<?xml version='1.0'?><svg/>")],
		] as const) {
			expect(detectMime(bytes, "a.md"), why).toBeNull();
		}
	});
});

describe("localDiskBlobs", () => {
	const roots: string[] = [];
	afterAll(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true });
	});
	async function store(): Promise<{ root: string; blobs: BlobStore }> {
		const root = await mkdtemp(path.join(tmpdir(), "avel-blobs-"));
		roots.push(root);
		return { root, blobs: localDiskBlobs(root, sequentialIds()) };
	}
	const A = "00000000-0000-4000-8000-00000000000a";
	const B = "00000000-0000-4000-8000-00000000000b";

	it("stores under the owner's prefix and the hash, once, and reads it back", async () => {
		const { root, blobs } = await store();
		const first = await blobs.put(`clients/${A}`, BRIEF);
		expect(first).toEqual({
			sha256: sha256Of(BRIEF),
			key: `clients/${A}/${sha256Of(BRIEF)}`,
		});
		expect(await blobs.put(`clients/${A}`, BRIEF)).toEqual(first);
		expect(
			new Uint8Array(
				await readFile(path.join(root, "clients", A, first.sha256)),
			),
		).toEqual(BRIEF);
		expect(await blobs.get(first.key)).toEqual(BRIEF);
	});

	it("keeps two clients' identical bytes apart, so removing one leaves the other", async () => {
		const { blobs } = await store();
		const a = await blobs.put(`clients/${A}`, BRIEF);
		const b = await blobs.put(`clients/${B}`, BRIEF);
		expect(a.key).not.toBe(b.key);
		await blobs.remove(a.key);
		expect(await blobs.get(a.key)).toBeNull();
		expect(await blobs.get(b.key)).toEqual(BRIEF);
		await blobs.remove(a.key);
	});

	it("refuses a key or prefix that could name a path outside the store", async () => {
		const { blobs } = await store();
		const hex = "a".repeat(64);
		for (const key of [
			`../${hex}`,
			`clients/../../${hex}`,
			`clients/${A}/../${hex}`,
			`general/${hex.toUpperCase()}`,
			`exports/${hex}`,
			`general/${hex}/x`,
		]) {
			await expect(blobs.get(key), key).rejects.toThrow(/Not a blob key/);
			await expect(blobs.remove(key), key).rejects.toThrow(/Not a blob key/);
		}
		await expect(blobs.put("clients/.." as "general", BRIEF)).rejects.toThrow(
			/Not a blob prefix/,
		);
	});

	it("refuses bytes that no longer match their hash", async () => {
		const { root, blobs } = await store();
		const { key, sha256 } = await blobs.put("general", BRIEF);
		await writeFile(path.join(root, "general", sha256), text("tampered"));
		await expect(blobs.get(key)).rejects.toThrow(/does not match its hash/);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("the Drive's byte routes", () => {
	afterAll(closeApi);

	type Seeded = Awaited<ReturnType<typeof seedTenants>>;

	/** Signs in, seeds two clients, and returns raw-body helpers. */
	async function setUp(h: ApiHarness) {
		const cookie = await h.signIn();
		const seeded = await seedTenants(h.tx, ["Meridian", "Halcyon"]);
		const headers = { cookie, origin: BASE_URL };
		const upload = (
			intakeId: string,
			name: string,
			bytes: Uint8Array | ReadableStream<Uint8Array>,
			extra: Record<string, string> = {},
		) =>
			h.app.request(
				`/api/intakes/${intakeId}/files?name=${encodeURIComponent(name)}`,
				{
					method: "POST",
					headers: { ...headers, "content-type": "text/plain", ...extra },
					body: bytes,
					// A stream body needs half duplex.
					...(bytes instanceof ReadableStream ? { duplex: "half" } : {}),
				} as RequestInit,
			);
		const download = (intakeId: string, fileId: string, extra = {}) =>
			h.app.request(`/api/intakes/${intakeId}/files/${fileId}/content`, {
				headers: { ...headers, ...extra },
			});
		const purge = (intakeId: string, fileId: string, extra = {}) =>
			h.app.request(`/api/intakes/${intakeId}/files/${fileId}`, {
				method: "DELETE",
				headers: { ...headers, ...extra },
			});
		return { ...seeded, cookie, upload, download, purge };
	}

	async function uploaded(res: Response) {
		expect(res.status, await res.clone().text()).toBe(201);
		const body = (await res.json()) as {
			success: true;
			data: { id: string; [k: string]: unknown };
		};
		return body.data;
	}

	async function fileRows(h: ApiHarness, s: Seeded["a"], fileId: string) {
		return withClientScope(h.tx, s.scope, (t) =>
			t.select().from(file).where(eq(file.id, fileId)),
		);
	}

	it("runs as avel_app when asked, so row-level security is in play", async () => {
		await withApi(
			async (h) => {
				const [row] = await h.tx.execute<{ user: string }>(
					sql`select current_user as "user"`,
				);
				expect(row?.user).toBe("avel_app");
			},
			{ asApp: true },
		);
		await withApi(async (h) => {
			const [row] = await h.tx.execute<{ user: string }>(
				sql`select current_user as "user"`,
			);
			expect(row?.user).not.toBe("avel_app");
		});
	});

	it("uploads under the intake's client: the row, the link, the bytes and the log", async () => {
		const blobs = memoryBlobs();
		await withApi(
			async (h) => {
				const { a, upload } = await setUp(h);
				const data = await uploaded(
					await upload(a.intakeId, "brief.md", BRIEF),
				);
				const sha256 = sha256Of(BRIEF);
				expect(data).toMatchObject({
					intakeId: a.intakeId,
					scope: "engagement",
					clientId: a.clientId,
					engagementId: a.engagementId,
					name: "brief.md",
					mime: "text/markdown",
					bytes: BRIEF.byteLength,
					sha256,
					purgedAt: null,
				});
				expect(data).not.toHaveProperty("storageKey");
				expect(blobs.keys()).toEqual([`clients/${a.clientId}/${sha256}`]);
				const [row] = await fileRows(h, a, data.id);
				expect(row?.storageKey).toBe(`clients/${a.clientId}/${sha256}`);
				const links = await withClientScope(h.tx, a.scope, (t) =>
					t.select().from(intakeFiles).where(eq(intakeFiles.fileId, data.id)),
				);
				expect(links).toEqual([{ intakeId: a.intakeId, fileId: data.id }]);
				const logs = await h.logRows(data.id);
				expect(logs).toHaveLength(1);
				expect(logs[0]).toMatchObject({
					actorKind: "operator",
					action: "file.uploaded",
					entityType: "file",
					engagementId: a.engagementId,
					payload: {
						fileId: data.id,
						intakeId: a.intakeId,
						name: "brief.md",
						mime: "text/markdown",
						bytes: BRIEF.byteLength,
						sha256,
					},
				});
			},
			{ asApp: true, drive: { blobs, maxBytes: DEFAULT_UPLOAD_MAX_BYTES } },
		);
	});

	it("serves a file only as an attachment, with nosniff", async () => {
		await withApi(
			async (h) => {
				const { a, upload, download } = await setUp(h);
				const data = await uploaded(
					await upload(a.intakeId, "Brief — v2.md", BRIEF),
				);
				const res = await download(a.intakeId, data.id);
				expect(res.status).toBe(200);
				expect(new Uint8Array(await res.arrayBuffer())).toEqual(BRIEF);
				expect(res.headers.get("content-type")).toBe(
					"text/markdown; charset=utf-8",
				);
				expect(res.headers.get("content-disposition")).toBe(
					`attachment; filename="Brief _ v2.md"; filename*=UTF-8''Brief%20%E2%80%94%20v2.md`,
				);
				expect(res.headers.get("x-content-type-options")).toBe("nosniff");
				expect(res.headers.get("content-security-policy")).toBe(
					"default-src 'none'; sandbox",
				);
			},
			{ asApp: true },
		);
	});

	it("never serves HTML inline: an attachment, and never as text/html", async () => {
		await withApi(
			async (h) => {
				const { a, upload, download } = await setUp(h);
				// Named .md, but the bytes are HTML, so it is HTML.
				for (const name of ["page.html", "notes.md"]) {
					const data = await uploaded(await upload(a.intakeId, name, PAGE));
					expect(data.mime).toBe("text/html");
					const res = await download(a.intakeId, data.id);
					expect(res.status).toBe(200);
					expect(res.headers.get("content-type")).toBe(
						"application/octet-stream",
					);
					expect(res.headers.get("content-disposition")).toMatch(
						/^attachment;/,
					);
					expect(res.headers.get("x-content-type-options")).toBe("nosniff");
					expect(res.headers.get("content-security-policy")).toContain(
						"sandbox",
					);
				}
			},
			{ asApp: true },
		);
	});

	it("refuses an upload over the cap, declared or streamed, and writes nothing", async () => {
		const blobs = memoryBlobs();
		await withApi(
			async (h) => {
				const { a, upload } = await setUp(h);
				const over = text("x".repeat(17));
				const streamed = new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(over.slice(0, 9));
						c.enqueue(over.slice(9));
						c.close();
					},
				});
				for (const res of [
					await upload(a.intakeId, "big.md", over, {
						"content-length": String(over.byteLength),
					}),
					await upload(a.intakeId, "big.md", streamed),
				]) {
					expect(res.status).toBe(400);
					const body = (await res.json()) as { error: { code: string } };
					expect(body.error.code).toBe("VALIDATION_FAILED");
				}
				const rows = await withClientScope(h.tx, a.scope, (t) =>
					t.select().from(file),
				);
				expect(rows).toEqual([]);
				expect(blobs.keys()).toEqual([]);
				// At the cap is fine.
				await uploaded(await upload(a.intakeId, "max.md", over.slice(0, 16)));
			},
			{ asApp: true, drive: { blobs, maxBytes: 16 } },
		);
	});

	it("takes an upload over the app's body cap, which leaves uploads to the Drive's", async () => {
		const blobs = memoryBlobs();
		await withApi(
			async (h) => {
				const { a, upload } = await setUp(h);
				const big = text("x".repeat(MAX_BODY_BYTES + 1));
				const data = await uploaded(await upload(a.intakeId, "big.md", big));
				expect(data.bytes).toBe(big.byteLength);
			},
			{ asApp: true, drive: { blobs, maxBytes: DEFAULT_UPLOAD_MAX_BYTES } },
		);
	});

	it("refuses bytes that are not text, and a bad name", async () => {
		await withApi(
			async (h) => {
				const { a, upload } = await setUp(h);
				for (const [name, bytes] of [
					["logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])],
					["logo.svg", text("<svg xmlns='http://www.w3.org/2000/svg'/>")],
					["", BRIEF],
					["../brief.md", BRIEF],
					["a\\b.md", BRIEF],
					["a\nb.md", BRIEF],
					["x".repeat(256), BRIEF],
				] as const) {
					const res = await upload(a.intakeId, name, bytes);
					expect(res.status, name).toBe(400);
				}
			},
			{ asApp: true },
		);
	});

	it("never reaches one client's file through another client's intake", async () => {
		await withApi(
			async (h) => {
				const { a, b, upload, download, purge } = await setUp(h);
				const fileA = await uploaded(await upload(a.intakeId, "a.md", BRIEF));
				const unknown = "00000000-0000-4000-8000-0000000000ff";
				for (const res of [
					await download(b.intakeId, fileA.id),
					await purge(b.intakeId, fileA.id),
					await download(unknown, fileA.id),
					await download(a.intakeId, unknown),
					await download("not-a-uuid", fileA.id),
					await download(a.intakeId, "not-a-uuid"),
				]) {
					expect(res.status).toBe(404);
					const body = (await res.json()) as { error: { code: string } };
					expect(body.error.code).toBe("NOT_FOUND");
				}
				const [row] = await fileRows(h, a, fileA.id);
				expect(row?.purgedAt).toBeNull();
				expect((await download(a.intakeId, fileA.id)).status).toBe(200);
			},
			{ asApp: true },
		);
	});

	it("reaches a file only through its own intake, even within one client", async () => {
		await withApi(
			async (h) => {
				const { a, upload, download, purge } = await setUp(h);
				// A second engagement and intake for the same client.
				const engagementId = "00000000-0000-4000-8000-0000000000e2";
				const intakeId = "00000000-0000-4000-8000-0000000000a2";
				await h.tx.execute(sql`
					insert into engagement (id, client_id, name, status, started_at, created_at, updated_at)
					values (${engagementId}, ${a.clientId}, 'Second', 'active', now(), now(), now())`);
				await h.tx.execute(sql`
					insert into intake (id, engagement_id, status, source_md, open_questions, created_at, updated_at)
					values (${intakeId}, ${engagementId}, 'draft', '# B', '{}', now(), now())`);
				const data = await uploaded(await upload(a.intakeId, "a.md", BRIEF));
				expect((await download(intakeId, data.id)).status).toBe(404);
				expect((await purge(intakeId, data.id)).status).toBe(404);
				expect((await download(a.intakeId, data.id)).status).toBe(200);
			},
			{ asApp: true },
		);
	});

	for (const removed of ["engagement", "client"] as const) {
		it(`404s every route once the intake's ${removed} is removed, as GET /api/intakes/:id does`, async () => {
			await withApi(
				async (h) => {
					const { a, upload, download, purge } = await setUp(h);
					const data = await uploaded(await upload(a.intakeId, "a.md", BRIEF));
					const id = removed === "client" ? a.clientId : a.engagementId;
					await h.tx.execute(
						sql`update ${sql.identifier(removed)} set deleted_at = now() where id = ${id}`,
					);
					expect((await h.call(`/api/intakes/${a.intakeId}`)).status).toBe(404);
					for (const res of [
						await upload(a.intakeId, "b.md", BRIEF),
						await download(a.intakeId, data.id),
						await purge(a.intakeId, data.id),
						await h.call(`/api/intakes/${a.intakeId}/files`),
					]) {
						expect(res.status).toBe(404);
					}
					const [row] = await fileRows(h, a, data.id);
					expect(row?.purgedAt).toBeNull();
				},
				{ asApp: true },
			);
		});
	}

	it("purges: bytes gone, row kept as a tombstone, logged once, and idempotent", async () => {
		const blobs = memoryBlobs();
		await withApi(
			async (h) => {
				const { a, upload, download, purge } = await setUp(h);
				const data = await uploaded(await upload(a.intakeId, "a.md", BRIEF));
				const res = await purge(a.intakeId, data.id);
				expect(res.status).toBe(200);
				const body = (await res.json()) as { data: { purgedAt: string } };
				expect(body.data.purgedAt).not.toBeNull();
				expect(blobs.keys()).toEqual([]);
				const [row] = await fileRows(h, a, data.id);
				expect(row).toMatchObject({
					storageKey: null,
					sha256: sha256Of(BRIEF),
					name: "a.md",
				});
				expect(row?.purgedAt).not.toBeNull();
				expect((await download(a.intakeId, data.id)).status).toBe(404);
				expect((await purge(a.intakeId, data.id)).status).toBe(200);
				const logs = await h.logRows(data.id);
				expect(logs.map((l) => l.action)).toEqual([
					"file.uploaded",
					"file.purged",
				]);
				expect(logs[1]?.payload).toEqual({
					fileId: data.id,
					sha256: sha256Of(BRIEF),
				});
			},
			{ asApp: true, drive: { blobs, maxBytes: DEFAULT_UPLOAD_MAX_BYTES } },
		);
	});

	it("keeps bytes another of the client's files still names, and never touches another client's", async () => {
		const blobs = memoryBlobs();
		await withApi(
			async (h) => {
				const { a, b, upload, download, purge } = await setUp(h);
				const a1 = await uploaded(await upload(a.intakeId, "one.md", BRIEF));
				const a2 = await uploaded(await upload(a.intakeId, "two.md", BRIEF));
				const b1 = await uploaded(await upload(b.intakeId, "b.md", BRIEF));
				const sha256 = sha256Of(BRIEF);
				expect(blobs.keys()).toEqual(
					[
						`clients/${a.clientId}/${sha256}`,
						`clients/${b.clientId}/${sha256}`,
					].sort(),
				);
				await purge(a.intakeId, a1.id);
				expect((await download(a.intakeId, a2.id)).status).toBe(200);
				await purge(a.intakeId, a2.id);
				expect(blobs.keys()).toEqual([`clients/${b.clientId}/${sha256}`]);
				expect((await download(b.intakeId, b1.id)).status).toBe(200);
			},
			{ asApp: true, drive: { blobs, maxBytes: DEFAULT_UPLOAD_MAX_BYTES } },
		);
	});

	it("needs a session, and a trusted origin to write", async () => {
		await withApi(
			async (h) => {
				const { a, upload, download, purge } = await setUp(h);
				const data = await uploaded(await upload(a.intakeId, "a.md", BRIEF));
				expect(
					(await download(a.intakeId, data.id, { cookie: "" })).status,
				).toBe(401);
				for (const origin of ["https://evil.example", ""]) {
					const extra = { origin };
					expect((await upload(a.intakeId, "b.md", BRIEF, extra)).status).toBe(
						403,
					);
					expect((await purge(a.intakeId, data.id, extra)).status).toBe(403);
				}
				const rows = await withClientScope(h.tx, a.scope, (t) =>
					t.select().from(file),
				);
				expect(rows.map((r) => r.purgedAt)).toEqual([null]);
			},
			{ asApp: true },
		);
	});

	it("refuses a dev-preview read with no session", async () => {
		await withApi(
			async (h) => {
				const { a, upload, download } = await setUp(h);
				const data = await uploaded(await upload(a.intakeId, "a.md", BRIEF));
				expect(
					(await download(a.intakeId, data.id, { cookie: "" })).status,
				).toBe(401);
			},
			{ asApp: true, preview: true },
		);
	});

	describe("GET /api/intakes/:id/files", () => {
		type ListBody = {
			success: true;
			data: Array<{
				id: string;
				name: string;
				purgedAt: string | null;
				uploadedBy: { kind: string; userId: string | null; display: string };
				[k: string]: unknown;
			}>;
			meta: { nextCursor: string | null; total: number };
		};
		const list = async (h: ApiHarness, intakeId: string, query = "") => {
			const res = await h.call(`/api/intakes/${intakeId}/files${query}`);
			return { status: res.status, body: (await res.json()) as ListBody };
		};

		it("lists the intake's live, unpurged files oldest first, with who uploaded them", async () => {
			await withApi(
				async (h) => {
					const { a, b, upload, purge } = await setUp(h);
					const one = await uploaded(await upload(a.intakeId, "one.md", BRIEF));
					const two = await uploaded(await upload(a.intakeId, "two.md", PAGE));
					const three = await uploaded(
						await upload(a.intakeId, "three.txt", BRIEF),
					);
					await uploaded(await upload(b.intakeId, "b.md", BRIEF));
					await purge(a.intakeId, two.id);
					const { status, body } = await list(h, a.intakeId);
					expect(status).toBe(200);
					expect(body.data.map((f) => f.name)).toEqual(["one.md", "three.txt"]);
					expect(body.meta).toEqual({ nextCursor: null, total: 2 });
					const operatorId = await h.operatorId();
					expect(body.data[0]).toEqual({
						id: one.id,
						name: "one.md",
						mime: "text/markdown",
						bytes: BRIEF.byteLength,
						sha256: sha256Of(BRIEF),
						uploadedBy: {
							kind: "operator",
							userId: operatorId,
							rosterEntryId: null,
							canonSessionId: null,
							display: h.operator.login,
							agent: null,
						},
						purgedAt: null,
						createdAt: one.createdAt,
						updatedAt: one.updatedAt,
					});
					expect(body.data[0]).not.toHaveProperty("storageKey");
					expect(three.id).toBe(body.data[1]?.id);
				},
				{ asApp: true },
			);
		});

		it("lists purged tombstones only when asked, and never a removed file", async () => {
			await withApi(
				async (h) => {
					const { a, upload, purge } = await setUp(h);
					const one = await uploaded(await upload(a.intakeId, "one.md", BRIEF));
					const two = await uploaded(await upload(a.intakeId, "two.md", BRIEF));
					const gone = await uploaded(
						await upload(a.intakeId, "gone.md", BRIEF),
					);
					await purge(a.intakeId, two.id);
					await withClientScope(h.tx, a.scope, (t) =>
						t
							.update(file)
							.set({ deletedAt: new Date("2026-10-06T00:00:00Z") })
							.where(eq(file.id, gone.id)),
					);
					const { body } = await list(h, a.intakeId, "?includePurged=true");
					expect(body.data.map((f) => [f.id, f.purgedAt !== null])).toEqual([
						[one.id, false],
						[two.id, true],
					]);
					expect(body.meta.total).toBe(2);
				},
				{ asApp: true },
			);
		});

		it("pages oldest first by cursor, with the same total on every page", async () => {
			await withApi(
				async (h) => {
					const { a, upload } = await setUp(h);
					const ids = [];
					for (const name of ["1.md", "2.md", "3.md"]) {
						ids.push(
							(await uploaded(await upload(a.intakeId, name, BRIEF))).id,
						);
					}
					const first = await list(h, a.intakeId, "?limit=2");
					expect(first.body.data.map((f) => f.id)).toEqual(ids.slice(0, 2));
					expect(first.body.meta.total).toBe(3);
					const cursor = first.body.meta.nextCursor;
					expect(cursor).not.toBeNull();
					const second = await list(h, a.intakeId, `?limit=2&cursor=${cursor}`);
					expect(second.body.data.map((f) => f.id)).toEqual(ids.slice(2));
					expect(second.body.meta).toEqual({ nextCursor: null, total: 3 });
				},
				{ asApp: true },
			);
		});

		it("shows an intake only its own files, and 404s an unknown or removed intake", async () => {
			await withApi(
				async (h) => {
					const { a, b, upload } = await setUp(h);
					await uploaded(await upload(a.intakeId, "a.md", BRIEF));
					const ofB = await list(h, b.intakeId);
					expect(ofB.status).toBe(200);
					expect(ofB.body.data).toEqual([]);
					expect(ofB.body.meta.total).toBe(0);
					const unknown = await list(h, "00000000-0000-4000-8000-0000000000ff");
					expect(unknown.status).toBe(404);
					await h.tx.execute(
						sql`update intake set deleted_at = now() where id = ${a.intakeId}`,
					);
					expect((await list(h, a.intakeId)).status).toBe(404);
				},
				{ asApp: true },
			);
		});
	});

	it("reads the upload body through a real node server", async () => {
		await withApi(
			async (h) => {
				const { a, cookie } = await setUp(h);
				const server = await new Promise<ReturnType<typeof serve>>(
					(resolve) => {
						const s = serve({ fetch: h.app.fetch, port: 0 }, () => resolve(s));
					},
				);
				try {
					const base = `http://localhost:${(server.address() as AddressInfo).port}`;
					const res = await fetch(
						`${base}/api/intakes/${a.intakeId}/files?name=brief.md`,
						{
							method: "POST",
							headers: { cookie, origin: BASE_URL },
							body: BRIEF,
						},
					);
					const data = await uploaded(res);
					expect(data.sha256).toBe(sha256Of(BRIEF));
				} finally {
					await new Promise<void>((resolve) => server.close(() => resolve()));
				}
			},
			{ asApp: true },
		);
	});
});
