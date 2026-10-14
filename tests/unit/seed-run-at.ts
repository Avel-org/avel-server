import { fixedClock } from "../../src/lib/clock";

/** When the seed tests say the seed ran: only running dispatches are timed from it. */
export const SEED_RUN_AT = fixedClock("2026-10-13T12:00:00.000Z").now();
