import { tsr } from "@ts-rest/serverless/fetch";
import { and, asc, eq, gt, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Operator } from "../auth";
import { type IntakeFile, intakeFileContract } from "../contract";
import { logActivity } from "../db/activity";
import { lockBlobKey } from "../db/blob-lock";
import { clientIdOfIntake } from "../db/client-id";
import {
	client,
	engagement,
	file,
	intake,
	intakeFiles,
	user,
} from "../db/schema";
import { live, stamp } from "../db/schema/columns";
import { type Executor, type Tx, withClientScope, withTx } from "../db/tx";
import { type BlobStore, blobPrefix, sha256Of } from "../gateways/blob";
import type { Caller } from "../middleware/caller";
import { ApiError } from "../middleware/errors";
import { activityActor } from "./activity";
import {
	decodeCursor,
	notFound,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

/**
 * The Drive's byte routes (DATA-CONTRACTS-V2, *File*). Bytes are not
 * envelopes, so these sit outside the ts-rest contract, the way the template
 * cover does. Operator only: an agent token or the runner never reaches them
 * (src/middleware/caller.ts refuses a route the contract does not declare),
 * and a dev-preview read without a session is refused here.
 *
 *   POST   /api/intakes/:intakeId/files?name=<name>      raw body; 201
 *   GET    /api/intakes/:intakeId/files/:fileId/content  the bytes, as an attachment
 *   DELETE /api/intakes/:intakeId/files/:fileId          purge: bytes gone, row kept
 *
 * Each runs under the intake's client scope (withClientScope, from
 * clientIdOfIntake), and reaches a file only through its intake_files link.
 * Another client's intake or file is 404, never 403, so ids cannot be probed.
 */

export type Drive = {
	blobs: BlobStore;
	/** The largest upload, in bytes. 10 MB for now: a [hypothesis], not a measured need. */
	maxBytes: number;
};

export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** What the Drive accepts: J's uploads are mostly Markdown and artifacts. */
export type DriveMime = "text/markdown" | "text/plain" | "text/html";

type FileDeps = RouteDeps & {
	drive: Drive;
	/** Origins a write may come from (the auth config's trusted origins). */
	trustedOrigins: readonly string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Starts of an HTML document, after leading whitespace, as the WHATWG MIME
// sniffing standard lists them; each must be followed by a space or `>`.
const HTML_STARTS = [
	"<!doctype html",
	"<html",
	"<head",
	"<script",
	"<iframe",
	"<h1",
	"<div",
	"<font",
	"<table",
	"<a",
	"<style",
	"<title",
	"<b",
	"<body",
	"<br",
	"<p",
	"<!--",
];

/**
 * The type, from the bytes alone. UTF-8 text with no NUL or other control
 * characters (tab, newline, carriage return and form feed aside) is text;
 * anything else, binary, XML and SVG included, is refused (null). Text that
 * opens like an HTML document is HTML, whatever its name says. Only the
 * label between Markdown and plain text comes from the name, and both are
 * served the same way.
 */
export function detectMime(bytes: Uint8Array, name: string): DriveMime | null {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	if (hasControl(text, TEXT_WHITESPACE)) return null;
	// TextDecoder has already dropped a leading byte order mark.
	const head = text.trimStart().slice(0, 64).toLowerCase();
	if (head.startsWith("<?xml") || head.startsWith("<svg")) return null;
	for (const start of HTML_STARTS) {
		const next = head.charAt(start.length);
		if (head.startsWith(start) && (next === ">" || /\s/.test(next))) {
			return "text/html";
		}
	}
	return /\.(md|markdown)$/i.test(name) ? "text/markdown" : "text/plain";
}

// Tab, newline, form feed and carriage return: the control characters text keeps.
const TEXT_WHITESPACE = [0x09, 0x0a, 0x0c, 0x0d];

/** Any C0 control character or DEL, other than those allowed. */
function hasControl(text: string, allowed: readonly number[]): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if ((code < 0x20 || code === 0x7f) && !allowed.includes(code)) return true;
	}
	return false;
}

/** A display name: 1 to 255 characters, no path separators, no control characters. */
function checkName(raw: string | undefined): string {
	const name = raw?.trim() ?? "";
	if (
		name.length === 0 ||
		name.length > 255 ||
		/[/\\]/.test(name) ||
		hasControl(name, [])
	) {
		throw new ApiError(
			"VALIDATION_FAILED",
			"name must be 1 to 255 characters, with no path separators or control characters",
		);
	}
	return name;
}

function operatorFrom(ctx: Context): Operator {
	const caller = ctx.get("caller") as Caller | undefined;
	if (!caller) {
		throw new ApiError("UNAUTHENTICATED", "Files need a signed-in operator");
	}
	if (caller.kind !== "operator") {
		throw new ApiError("FORBIDDEN", "Only an operator may reach files");
	}
	return caller.operator;
}

/**
 * A write needs an Origin the auth config trusts. The upload's raw body is
 * a "simple" request that no CORS preflight guards, so this is what keeps
 * another site's form from posting with the operator's cookie.
 */
function checkOrigin(ctx: Context, trusted: readonly string[]) {
	const origin = ctx.req.header("origin");
	if (!origin || !trusted.includes(origin)) {
		throw new ApiError("FORBIDDEN", "This origin may not write files");
	}
}

/** The live intake's client and engagement (both live too), or 404. */
async function intakeScope(db: Executor, intakeId: string | undefined) {
	if (!intakeId || !UUID.test(intakeId)) {
		throw notFound("intake", String(intakeId));
	}
	const [row] = await db
		.select({ engagementId: intake.engagementId })
		.from(intake)
		.innerJoin(
			engagement,
			and(eq(engagement.id, intake.engagementId), live(engagement)),
		)
		.innerJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.where(and(eq(intake.id, intakeId), live(intake)));
	const clientId = row ? await clientIdOfIntake(db, intakeId) : null;
	if (!row || !clientId) throw notFound("intake", intakeId);
	return { intakeId, clientId, engagementId: row.engagementId };
}

/** The intake's linked file, under the scope, or 404. */
async function linkedFile(
	tx: Tx,
	intakeId: string,
	fileId: string | undefined,
) {
	if (!fileId || !UUID.test(fileId)) throw notFound("file", String(fileId));
	const [row] = await tx
		.select({ file })
		.from(file)
		.innerJoin(intakeFiles, eq(intakeFiles.fileId, file.id))
		.where(and(eq(file.id, fileId), eq(intakeFiles.intakeId, intakeId)));
	if (!row) throw notFound("file", fileId);
	return row.file;
}

/** Reads the body, refusing as soon as it passes the cap. */
async function readCapped(ctx: Context, maxBytes: number): Promise<Uint8Array> {
	const tooLarge = () =>
		new ApiError(
			"VALIDATION_FAILED",
			`The upload is larger than ${maxBytes} bytes`,
		);
	const declared = Number(ctx.req.header("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
	const body = ctx.req.raw.body;
	if (!body) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}

type FileRow = typeof file.$inferSelect;

/** The wire: never the storage key. */
function toWire(row: FileRow, intakeId: string) {
	return {
		id: row.id,
		intakeId,
		scope: row.scope,
		clientId: row.clientId,
		engagementId: row.engagementId,
		name: row.name,
		mime: row.mime,
		bytes: row.bytes,
		sha256: row.sha256,
		uploadedBy: row.uploadedBy,
		purgedAt: row.purgedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** RFC 6266: an ASCII fallback and the exact name, percent-encoded. */
function attachment(name: string): string {
	const ascii = name.replace(/[^A-Za-z0-9._ -]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function fileRoutes(deps: FileDeps) {
	const { blobs, maxBytes } = deps.drive;

	const upload = async (ctx: Context) => {
		const operator = operatorFrom(ctx);
		checkOrigin(ctx, deps.trustedOrigins);
		const db = deps.db();
		const scope = await intakeScope(db, ctx.req.param("intakeId"));
		const name = checkName(ctx.req.query("name"));
		const bytes = await readCapped(ctx, maxBytes);
		const mime = detectMime(bytes, name);
		if (!mime) {
			throw new ApiError(
				"VALIDATION_FAILED",
				"Only UTF-8 Markdown, plain text and HTML are accepted",
			);
		}
		const sha256 = sha256Of(bytes);
		const prefix = blobPrefix(scope.clientId);
		const key = `${prefix}/${sha256}`;
		const values = {
			id: deps.ids.next(),
			scope: "engagement" as const,
			clientId: scope.clientId,
			engagementId: scope.engagementId,
			name,
			mime,
			bytes: bytes.byteLength,
			sha256,
			storageKey: key,
			uploadedBy: operator.id,
			purgedAt: null,
			...stamp(deps.clock),
		};
		const row = await withTx(db, (tx) =>
			withClientScope(tx, scope.clientId, async (s) => {
				await lockBlobKey(s, key);
				const [inserted] = await s.insert(file).values(values).returning();
				await s
					.insert(intakeFiles)
					.values({ intakeId: scope.intakeId, fileId: values.id });
				await logActivity(s, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "file.uploaded",
					entityType: "file",
					entityId: values.id,
					engagementId: scope.engagementId,
					requestId: ctx.get("requestId"),
					payload: {
						fileId: values.id,
						intakeId: scope.intakeId,
						name,
						mime,
						bytes: bytes.byteLength,
						sha256,
					},
				});
				// Last, so a refused row writes no bytes. A commit that fails
				// after this leaves an orphan blob, which src/db/blob-sweep.ts
				// removes once it is past its grace.
				await blobs.put(prefix, bytes);
				if (!inserted) throw new Error("file insert returned no row");
				return inserted;
			}),
		);
		return ctx.json({ success: true, data: toWire(row, scope.intakeId) }, 201);
	};

	const download = async (ctx: Context) => {
		operatorFrom(ctx);
		const db = deps.db();
		const scope = await intakeScope(db, ctx.req.param("intakeId"));
		const row = await withClientScope(db, scope.clientId, (tx) =>
			linkedFile(tx, scope.intakeId, ctx.req.param("fileId")),
		);
		if (row.deletedAt || row.purgedAt || !row.storageKey) {
			throw notFound("file", row.id);
		}
		const bytes = await blobs.get(row.storageKey);
		if (!bytes) {
			throw new Error(`file ${row.id}: no bytes under ${row.storageKey}`);
		}
		return new Response(bytes, {
			status: 200,
			headers: {
				// HTML is never sent as text/html, so nothing can render it in
				// place even if the attachment is ignored.
				"content-type":
					row.mime === "text/html"
						? "application/octet-stream"
						: `${row.mime}; charset=utf-8`,
				"content-length": String(bytes.byteLength),
				"content-disposition": attachment(row.name),
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'; sandbox",
				"cache-control": "private, no-store",
			},
		});
	};

	const purge = async (ctx: Context) => {
		const operator = operatorFrom(ctx);
		checkOrigin(ctx, deps.trustedOrigins);
		const db = deps.db();
		const scope = await intakeScope(db, ctx.req.param("intakeId"));
		const row = await withTx(db, (tx) =>
			withClientScope(tx, scope.clientId, async (s) => {
				const found = await linkedFile(
					s,
					scope.intakeId,
					ctx.req.param("fileId"),
				);
				// Already purged: nothing changes, so nothing is logged.
				if (found.purgedAt || !found.storageKey) return found;
				const key = found.storageKey;
				await lockBlobKey(s, key);
				// A concurrent purge may have committed while this one waited
				// for the lock, so decide again on a row read after taking it.
				const locked = await linkedFile(
					s,
					scope.intakeId,
					ctx.req.param("fileId"),
				);
				if (locked.purgedAt || !locked.storageKey) return locked;
				const [purged] = await s
					.update(file)
					.set({
						purgedAt: deps.clock.now(),
						storageKey: null,
						updatedAt: deps.clock.now(),
					})
					.where(eq(file.id, found.id))
					.returning();
				await logActivity(s, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "file.purged",
					entityType: "file",
					entityId: found.id,
					engagementId: found.engagementId,
					requestId: ctx.get("requestId"),
					payload: { fileId: found.id, sha256: found.sha256 },
				});
				// Keys are per client, so every row that could share these
				// bytes is visible under this scope. Bytes another live row
				// still names stay.
				const [shared] = await s
					.select({ id: file.id })
					.from(file)
					.where(and(eq(file.storageKey, key), ne(file.id, found.id)))
					.limit(1);
				if (!shared) await blobs.remove(key);
				if (!purged) throw new Error("file purge returned no row");
				return purged;
			}),
		);
		return ctx.json({ success: true, data: toWire(row, scope.intakeId) }, 200);
	};

	return { upload, download, purge };
}

/** The keyset after a cursor, ascending: (created_at asc, id asc). */
function afterAscending(cursor: string | undefined): SQL | undefined {
	if (!cursor) return undefined;
	const at = decodeCursor(cursor);
	return or(
		gt(file.createdAt, at.createdAt),
		and(eq(file.createdAt, at.createdAt), gt(file.id, at.id)),
	);
}

type ListedRow = FileRow & { login: string | null };

/** The contract's wire: uploadedBy resolved as the activity feed resolves an operator. */
function toListWire(row: ListedRow): IntakeFile {
	return {
		id: row.id,
		name: row.name,
		mime: row.mime as IntakeFile["mime"],
		bytes: row.bytes,
		sha256: row.sha256,
		uploadedBy: activityActor({
			id: row.id,
			actorKind: "operator",
			actorUserId: row.uploadedBy,
			actorRosterEntryId: null,
			actorCanonSessionId: null,
			login: row.login,
			agentTemplateId: null,
			agentSlug: null,
			agentName: null,
			territory: null,
		}),
		purgedAt: row.purgedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * GET /api/intakes/:id/files, a contract route (src/contract/intake-file.ts).
 * Under the intake's client scope, oldest first. Removed (soft-deleted) files
 * are never listed; purged tombstones only with includePurged. The total
 * follows the same filters and ignores the cursor.
 */
export function intakeFileRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(intakeFileContract, {
		list: async ({ params, query }) => {
			const db = deps.db();
			const scope = await intakeScope(db, params.id);
			const { rows, total } = await withClientScope(
				db,
				scope.clientId,
				async (tx) => {
					const filters = and(
						eq(intakeFiles.intakeId, scope.intakeId),
						isNull(file.deletedAt),
						query.includePurged ? undefined : isNull(file.purgedAt),
					);
					const rows = await tx
						.select({ file, login: user.githubLogin })
						.from(file)
						.innerJoin(intakeFiles, eq(intakeFiles.fileId, file.id))
						.leftJoin(user, eq(user.id, file.uploadedBy))
						.where(and(filters, afterAscending(query.cursor)))
						.orderBy(asc(file.createdAt), asc(file.id))
						.limit(query.limit + 1);
					const [counted] = await tx
						.select({ total: sql<number>`count(*)`.mapWith(Number) })
						.from(file)
						.innerJoin(intakeFiles, eq(intakeFiles.fileId, file.id))
						.where(filters);
					return { rows, total: counted?.total ?? 0 };
				},
			);
			const { items, nextCursor } = toPage(
				rows.map((r) => ({ ...r.file, login: r.login })),
				query.limit,
			);
			return {
				status: 200,
				// The contract makes total required, so the envelope is written
				// out rather than built by page(), whose total is optional.
				body: {
					success: true as const,
					data: items.map(toListWire),
					meta: { nextCursor, total },
				},
			};
		},
	});
}
