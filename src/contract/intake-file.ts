import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { activityActor } from "./activity";
import { pageMeta, pageQuery } from "./shared/pagination";

const c = initContract();

/**
 * The types an upload may be. Detected from the bytes, never from the
 * request. HTML, PDF and Word files are downloaded as attachments and never
 * rendered inline. Canon reads a PDF's or Word file's text, so one with
 * none (a scan) is refused at upload.
 */
export const INTAKE_FILE_MIMES = [
	"text/markdown",
	"text/plain",
	"text/html",
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

/**
 * A file attached to an Intake: Canon's source material (DATA-CONTRACTS-V2.md,
 * File). The bytes are behind the byte routes outside this contract:
 * POST /api/intakes/:id/files?name=, GET .../files/:fileId/content, and
 * DELETE .../files/:fileId.
 */
export const intakeFile = z.object({
	id: z.string().uuid(),
	name: z.string(),
	mime: z.enum(INTAKE_FILE_MIMES),
	bytes: z.number().int().nonnegative(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	/** Who uploaded it, resolved as the activity feed resolves actors: the operator today, Canon later. */
	uploadedBy: activityActor,
	/** Set when the bytes were destroyed; the row stays as a tombstone. Only listed with includePurged. */
	purgedAt: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

export type IntakeFile = z.infer<typeof intakeFile>;

export const intakeFileListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(intakeFile),
	meta: pageMeta.extend({ total: z.number().int().nonnegative() }),
});

export const intakeFileContract = c.router({
	list: {
		method: "GET",
		path: "/api/intakes/:id/files",
		pathParams: z.object({ id: z.string().uuid() }),
		query: pageQuery.extend({
			/** Also list purged tombstones, with purgedAt set. Removed files are never listed. */
			includePurged: z
				.enum(["true", "false"])
				.transform((v) => v === "true")
				.default("false"),
		}),
		responses: { 200: intakeFileListEnvelope },
		summary:
			"The intake's files, oldest first; purged ones only with includePurged",
	},
});
