import { createHash } from "node:crypto";

/**
 * The sha git gives a blob of these bytes, as `git hash-object` prints it:
 * the sha1 of "blob <length>\0" followed by the bytes. The bytes are hashed
 * as they are, with no text decoding and no line-ending conversion.
 */
export function gitBlobSha(bytes: Uint8Array): string {
	return createHash("sha1")
		.update(`blob ${bytes.byteLength}\0`, "utf8")
		.update(bytes)
		.digest("hex");
}
