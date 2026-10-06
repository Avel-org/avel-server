import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Operator } from "../auth";
import type { Executor } from "../db/tx";
import type { Clock } from "../lib/clock";
import type { IdGenerator } from "../lib/ids";
import { ApiError } from "../middleware/errors";

/** What every resource route factory takes. */
export type RouteDeps = {
	db: () => Executor;
	clock: Clock;
	ids: IdGenerator;
};

/** Per-request values src/app.ts hands each handler through ts-rest's platform context. */
export type RequestContext = {
	requestId: string;
	operator: Operator | undefined;
};

/**
 * The signed-in operator. src/middleware/auth.ts guarantees one on every
 * protected route; reaching a handler without one is a server bug, so it
 * answers 500, never a silent anonymous write.
 */
export function operatorOf(ctx: RequestContext): Operator {
	if (!ctx.operator)
		throw new Error("protected route reached without an operator");
	return ctx.operator;
}

/**
 * Keyset pagination, newest first, ordered by (created_at desc, id desc) so
 * rows created in the same instant still have one fixed order. The cursor is
 * the last row's position, opaque to clients.
 */
type Position = { createdAt: Date; id: string };

export function encodeCursor(row: Position): string {
	return Buffer.from(
		JSON.stringify([row.createdAt.toISOString(), row.id]),
	).toString("base64url");
}

/**
 * What encodeCursor writes: an ISO timestamp and a uuid. Both halves reach
 * Postgres, so both are checked strictly; a loose check here lets a forged
 * cursor through to a database error, a 500 instead of a 400.
 */
const cursorPosition = z.tuple([z.string().datetime(), z.string().uuid()]);

export function decodeCursor(cursor: string): Position {
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		const position = cursorPosition.safeParse(parsed);
		if (position.success) {
			const [at, id] = position.data;
			return { createdAt: new Date(at), id };
		}
	} catch {
		// Falls through to the refusal below.
	}
	throw new ApiError(
		"VALIDATION_FAILED",
		"The cursor is not one this server issued",
		{
			details: { query: [{ path: ["cursor"], message: "Invalid cursor" }] },
		},
	);
}

/** Rows after the cursor, in (created_at desc, id desc) order. */
export function after(
	table: { createdAt: AnyPgColumn; id: AnyPgColumn },
	cursor: string | undefined,
): SQL | undefined {
	if (!cursor) return undefined;
	const at = decodeCursor(cursor);
	return or(
		lt(table.createdAt, at.createdAt),
		and(eq(table.createdAt, at.createdAt), lt(table.id, at.id)),
	);
}

/**
 * Splits `limit + 1` fetched rows into one page and its next cursor. Fetching
 * one extra row is how the server knows a next page exists.
 */
export function toPage<T extends Position>(rows: T[], limit: number) {
	const items = rows.slice(0, limit);
	const last = items.at(-1);
	return {
		items,
		nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
	};
}

/**
 * A case-insensitive substring pattern for ILIKE, with the user's text taken
 * literally: \ % and _ are escaped, so "100%" matches only "100%".
 */
export function containsPattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

export function notFound(entity: string, id: string): ApiError {
	return new ApiError("NOT_FOUND", `No ${entity} with id ${id}`);
}
