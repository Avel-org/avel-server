import { logActivity } from "../db/activity";
import { type Executor, withTx } from "../db/tx";
import type { Clock } from "../lib/clock";
import type { IdGenerator } from "../lib/ids";

/**
 * The production recordSignIn: one auth.signed_in row, in its own
 * transaction, written after Better Auth commits the session in another.
 * See the session.create hook in src/auth/index.ts for what that leaves open.
 */
export function signInRecorder(deps: {
	db: () => Executor;
	clock: Clock;
	ids: IdGenerator;
}) {
	return async (entry: { userId: string; requestId: string }) => {
		await withTx(deps.db(), (tx) =>
			logActivity(tx, deps, {
				actorKind: "operator",
				actorUserId: entry.userId,
				action: "auth.signed_in",
				entityType: "user",
				entityId: entry.userId,
				requestId: entry.requestId,
				payload: { provider: "github" },
			}),
		);
	};
}
