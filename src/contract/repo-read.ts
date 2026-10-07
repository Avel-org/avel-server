import { z } from "zod";

/**
 * What the repo read (module 2) derives, in DATA-CONTRACTS-V2's ConventionSet
 * and Boundary shapes. Every entry is extracted by code from one commit and
 * carries the paths that demonstrate it. Nothing here is proposed by a model.
 */

export const conventionConfidence = z.enum(["high", "low"]);

/**
 * Shared by every extracted entry. An entry is low exactly when
 * `disagreements` is non-empty, and each disagreement says what the tree
 * held, in counts: "naming: 5 .spec (62%), 3 .test (38%)".
 */
const entry = {
	evidence: z.array(z.string()),
	confidence: conventionConfidence,
	disagreements: z.array(z.string()),
};

export const conventionSetSchema = z
	.object({
		layering: z
			.object({ pattern: z.string(), ...entry })
			.strict()
			.optional(),
		testing: z
			.object({
				runner: z.string().nullable(),
				location: z.enum(["separate", "colocated"]).nullable(),
				naming: z.string().nullable(),
				...entry,
			})
			.strict()
			.optional(),
		naming: z
			.object({
				files: z.enum(["kebab", "camel", "pascal", "snake"]).nullable(),
				exports: z.enum(["named", "default"]).nullable(),
				...entry,
			})
			.strict()
			.optional(),
		imports: z
			.object({ rules: z.array(z.string()), ...entry })
			.strict()
			.optional(),
		formatting: z
			.object({ tool: z.string(), configPath: z.string(), ...entry })
			.strict()
			.optional(),
		/** Config paths that enforce rules mechanically. Empty arrays when none. */
		enforcement: z
			.object({
				eslint: z.array(z.string()),
				tsconfig: z.array(z.string()),
				precommit: z.array(z.string()),
				ci: z.array(z.string()),
			})
			.strict(),
		/** Low when any entry is low. Low blocks approval. */
		confidence: conventionConfidence,
		/** The entries the tree gave no evidence for; the repository must supply them. */
		unextracted: z.array(z.string()),
	})
	.strict();

export type ConventionSet = z.infer<typeof conventionSetSchema>;

export const boundarySchema = z
	.object({
		kind: z.enum(["feature", "layer"]),
		/** The directory that is the boundary. */
		path: z.string(),
		files: z.number().int().nonnegative(),
		/** Approximate: counted lines for text files, size / 40 for the rest. */
		loc: z.number().int().nonnegative(),
		suggestedTerritory: z.string(),
		/** Files outside every boundary that this one and another both touch. */
		collidesWith: z.array(z.string()),
	})
	.strict();

export type Boundary = z.infer<typeof boundarySchema>;
