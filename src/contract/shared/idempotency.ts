import { z } from "zod";

/**
 * The Idempotency-Key header (DATA-CONTRACTS-V2.md, Idempotency): a uuid,
 * never in the body. Agent creates key it per dispatch; dispatch creates
 * key it per mission.
 */
export const idempotencyHeaders = z.object({
	"idempotency-key": z.string().uuid(),
});
