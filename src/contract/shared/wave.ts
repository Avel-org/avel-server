import { z } from "zod";

/**
 * The global phases A to E; E is Operate. The wave pgEnum is built from it.
 * Its own module so dispatch.ts can use it: agent-template.ts imports
 * dispatch.ts, and re-exports these.
 */
export const WAVES = ["A", "B", "C", "D", "E"] as const;

export const wave = z.enum(WAVES);

export type Wave = z.infer<typeof wave>;
