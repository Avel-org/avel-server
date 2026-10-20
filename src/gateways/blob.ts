import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IdGenerator } from "../lib/ids";

/**
 * Where AVEL keeps bytes (DECISIONS-V2, *the Drive*): Drive files now,
 * frozen export snapshots later. Local disk in dev and tests, R2 in
 * production behind the same interface.
 *
 * Keys are namespaced by owner, `clients/<clientId>/<sha256>` or
 * `general/<sha256>`, never the bare hash. Identical bytes from two clients
 * are two blobs, so purging one client's file never touches another's, and
 * the reference count a purge needs runs under that client's row-level
 * scope alone (decided with BE Main, 2026-10-19).
 */
export type BlobStore = {
	/** Stores the bytes under the prefix; idempotent for the same bytes. */
	put(
		prefix: BlobPrefix,
		bytes: Uint8Array,
	): Promise<{ sha256: string; key: string }>;
	/** The bytes, or null when the key holds nothing. Throws if they no longer match their hash. */
	get(key: string): Promise<Uint8Array | null>;
	/** Hard-deletes the bytes. A key that holds nothing is not an error. */
	remove(key: string): Promise<void>;
};

export type BlobPrefix = "general" | `clients/${string}`;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PREFIX = new RegExp(`^(general|clients/${UUID})$`);
const KEY = new RegExp(`^(general|clients/${UUID})/([0-9a-f]{64})$`);

export function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The prefix for a file's owner: its client, or general when it has none. */
export function blobPrefix(clientId: string | null): BlobPrefix {
	return clientId === null ? "general" : `clients/${clientId}`;
}

/**
 * The key's prefix and hash. A key that is not exactly a known prefix and a
 * lowercase hex SHA-256 is refused, so no key can name a path outside the
 * store.
 */
export function parseBlobKey(key: string): {
	prefix: BlobPrefix;
	sha256: string;
} {
	const match = KEY.exec(key);
	if (!match?.[1] || !match[2]) throw new Error(`Not a blob key: ${key}`);
	return { prefix: match[1] as BlobPrefix, sha256: match[2] };
}

function keyFor(prefix: BlobPrefix, bytes: Uint8Array) {
	if (!PREFIX.test(prefix)) throw new Error(`Not a blob prefix: ${prefix}`);
	const sha256 = sha256Of(bytes);
	return { sha256, key: `${prefix}/${sha256}` };
}

function verified(key: string, bytes: Uint8Array): Uint8Array {
	if (sha256Of(bytes) !== parseBlobKey(key).sha256) {
		throw new Error(`Blob ${key} does not match its hash`);
	}
	return bytes;
}

/**
 * Bytes on local disk under `root`. A put writes a temporary file beside the
 * target and renames it into place, so a reader never sees half a blob.
 * `ids` names the temporary file (no randomness outside src/lib/ids.ts).
 */
export function localDiskBlobs(root: string, ids: IdGenerator): BlobStore {
	const pathOf = (key: string) => {
		parseBlobKey(key);
		return path.join(root, ...key.split("/"));
	};
	return {
		async put(prefix, bytes) {
			const { sha256, key } = keyFor(prefix, bytes);
			const target = pathOf(key);
			const exists = await stat(target).then(
				() => true,
				() => false,
			);
			if (!exists) {
				await mkdir(path.dirname(target), { recursive: true });
				const temp = `${target}.${ids.next()}.tmp`;
				await writeFile(temp, bytes);
				await rename(temp, target);
			}
			return { sha256, key };
		},
		async get(key) {
			try {
				return verified(key, new Uint8Array(await readFile(pathOf(key))));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw e;
			}
		},
		async remove(key) {
			await rm(pathOf(key), { force: true });
		},
	};
}

/** Bytes in memory: unit tests, and API tests that do not look at the disk. */
export function memoryBlobs(): BlobStore & { keys(): string[] } {
	const blobs = new Map<string, Uint8Array>();
	return {
		async put(prefix, bytes) {
			const { sha256, key } = keyFor(prefix, bytes);
			if (!blobs.has(key)) blobs.set(key, new Uint8Array(bytes));
			return { sha256, key };
		},
		async get(key) {
			parseBlobKey(key);
			const bytes = blobs.get(key);
			return bytes ? verified(key, bytes) : null;
		},
		async remove(key) {
			parseBlobKey(key);
			blobs.delete(key);
		},
		keys: () => [...blobs.keys()].sort(),
	};
}
