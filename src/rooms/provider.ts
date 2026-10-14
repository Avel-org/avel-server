import {
	mkdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { COMMIT_SHA, git } from "./git";

/**
 * Rooms (module 7; SANDBOX.md, The four rooms). Tier 0 is worktree-only
 * (J, 2026-10-13): one git worktree per dispatch, checked out detached at
 * the source's pinned commit, and file tools only. Local Docker and remote
 * sandboxes are future RoomProviders; nothing is built for them.
 *
 * A room outlives its dispatch: closing a dispatch leaves the worktree so
 * the operator can inspect a halted run's work, until release() removes
 * it. No route calls release yet, and no table records rooms: a room is
 * its directory and a small record beside it.
 */

export type RoomSpec = {
	dispatchId: string;
	/** The resolved source clone (src/rooms/sources.ts). */
	repoPath: string;
	commit: string;
	/** The roster entry's resolved writable globs. */
	writableGlobs: readonly string[];
};

export type Room = {
	dispatchId: string;
	/** The worktree's directory, absolute. */
	root: string;
	repoPath: string;
	/** The pinned commit: the checkpoint measures changes from it. */
	commit: string;
	writableGlobs: string[];
};

export type RoomProvider = {
	/** Makes the room. Throws RoomUnavailable when it cannot. */
	open: (spec: RoomSpec) => Promise<Room>;
	/** The dispatch's room, or null when it has none. */
	get: (dispatchId: string) => Promise<Room | null>;
	/** Removes the dispatch's room. Nothing to remove does nothing. */
	release: (dispatchId: string) => Promise<void>;
};

/** The source resolved, but no room could be made. Retrying may help. */
export class RoomUnavailable extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RoomUnavailable";
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function within(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const exists = (p: string) =>
	stat(p).then(
		() => true,
		() => false,
	);

/**
 * Worktrees under `rootDir` (%LOCALAPPDATA%\avel\rooms in production, a
 * temp dir in tests): <rootDir>/<dispatchId> is the room, and
 * <rootDir>/<dispatchId>.json records its source, commit and globs.
 */
export function worktreeRooms(rootDir: string): RoomProvider {
	const dirOf = (id: string) => path.join(rootDir, id);
	const recordOf = (id: string) => path.join(rootDir, `${id}.json`);

	const get = async (dispatchId: string): Promise<Room | null> => {
		if (!UUID.test(dispatchId)) return null;
		let text: string;
		try {
			text = await readFile(recordOf(dispatchId), "utf8");
		} catch {
			return null;
		}
		const room = JSON.parse(text) as Room;
		// The record's root is trusted only when it is this dispatch's own
		// directory, so a stale or edited record cannot point the tools
		// elsewhere.
		const [recorded, own] = await Promise.all([
			realpath(room.root).catch(() => null),
			realpath(dirOf(dispatchId)).catch(() => null),
		]);
		return recorded !== null && recorded === own ? room : null;
	};

	return {
		get,

		open: async (spec) => {
			if (!UUID.test(spec.dispatchId) || !COMMIT_SHA.test(spec.commit)) {
				throw new RoomUnavailable(`no room for ${spec.dispatchId}`);
			}
			const root = dirOf(spec.dispatchId);
			try {
				await mkdir(rootDir, { recursive: true });
			} catch (err) {
				throw new RoomUnavailable(`cannot make ${rootDir}`, { cause: err });
			}
			if ((await exists(root)) || (await exists(recordOf(spec.dispatchId)))) {
				throw new RoomUnavailable(`${root} already exists`);
			}
			try {
				await git(["worktree", "add", "--detach", root, spec.commit], {
					cwd: spec.repoPath,
				});
			} catch (err) {
				throw new RoomUnavailable(`cannot add a worktree at ${root}`, {
					cause: err,
				});
			}
			const room: Room = {
				dispatchId: spec.dispatchId,
				root: await realpath(root),
				repoPath: spec.repoPath,
				commit: spec.commit,
				writableGlobs: [...spec.writableGlobs],
			};
			try {
				await writeFile(
					recordOf(spec.dispatchId),
					`${JSON.stringify(room, null, 2)}\n`,
					"utf8",
				);
			} catch (err) {
				await removeWorktree(spec.repoPath, root);
				throw new RoomUnavailable(`cannot record the room at ${root}`, {
					cause: err,
				});
			}
			return room;
		},

		release: async (dispatchId) => {
			if (!UUID.test(dispatchId)) {
				throw new Error(`${dispatchId} names no room`);
			}
			const room = await get(dispatchId);
			if (room) {
				// Only ever <rootDir>/<dispatchId>, whatever the record says,
				// and only when it really sits under the rooms root (not a
				// junction to elsewhere): realpath both, then compare.
				const [base, target] = await Promise.all([
					realpath(rootDir),
					realpath(dirOf(dispatchId)),
				]);
				if (!within(base, target)) {
					throw new Error(`${room.root} is not under ${rootDir}`);
				}
				await removeWorktree(room.repoPath, target);
			}
			await rm(recordOf(dispatchId), { force: true });
		},
	};
}

async function removeWorktree(repoPath: string, root: string): Promise<void> {
	await git(["worktree", "remove", "--force", root], { cwd: repoPath });
	await git(["worktree", "prune"], { cwd: repoPath });
}
