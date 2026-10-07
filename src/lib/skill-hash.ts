import { createHash } from "node:crypto";

/** Bumped if the hashed fields or their encoding ever change, so old and new hashes never compare equal. */
export const SKILL_HASH_VERSION = "skill-sha256-v1";

export type HashedSkillFields = {
	description: string;
	contentMd: string;
	avelEnhancementMd: string | null;
	grants: string[] | null;
	ioShape: { reads: "large" | "small"; returns: "large" | "small" } | null;
	type: "knowledge" | "capability";
	layer: "role" | "stack" | "domain";
};

/**
 * Skill.content_sha256: everything that changes an agent's behavior
 * (DATA-CONTRACTS-V2, Skill). The fields are encoded as a JSON array in a
 * fixed order, and ioShape's keys are written out, so the hash never depends
 * on object key order. Grants keep their given order.
 */
export function skillContentSha256(fields: HashedSkillFields): string {
	const encoded = JSON.stringify([
		SKILL_HASH_VERSION,
		fields.description,
		fields.contentMd,
		fields.avelEnhancementMd,
		fields.grants,
		fields.ioShape ? [fields.ioShape.reads, fields.ioShape.returns] : null,
		fields.type,
		fields.layer,
	]);
	return createHash("sha256").update(encoded, "utf8").digest("hex");
}
