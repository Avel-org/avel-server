import type { Room, RoomProvider } from "../../src/rooms/provider";
import { RoomUnavailable } from "../../src/rooms/provider";
import type { RoomSourceResolver } from "../../src/rooms/sources";

// Rooms and sources for tests that are not about rooms: no git and no
// disk. tests/api/rooms*.test.ts use the real worktree provider against a
// temp repository. Not collected as a test file.

/** Rooms kept in memory. `refuse` makes every open throw RoomUnavailable. */
export function memoryRooms(): RoomProvider & {
	opened: string[];
	released: string[];
	refuse: boolean;
} {
	const rooms = new Map<string, Room>();
	const provider = {
		opened: [] as string[],
		released: [] as string[],
		refuse: false,
		open: async (spec: Parameters<RoomProvider["open"]>[0]) => {
			if (provider.refuse || rooms.has(spec.dispatchId)) {
				throw new RoomUnavailable(`no room for ${spec.dispatchId}`);
			}
			const room: Room = {
				dispatchId: spec.dispatchId,
				root: `memory-rooms/${spec.dispatchId}`,
				repoPath: spec.repoPath,
				commit: spec.commit,
				writableGlobs: [...spec.writableGlobs],
			};
			rooms.set(spec.dispatchId, room);
			provider.opened.push(spec.dispatchId);
			return room;
		},
		get: async (dispatchId: string) => rooms.get(dispatchId) ?? null,
		release: async (dispatchId: string) => {
			if (rooms.delete(dispatchId)) provider.released.push(dispatchId);
		},
	};
	return provider;
}

/** Resolves every source to a made-up clone at the source's own commit. */
export const anySource: RoomSourceResolver = {
	resolve: async (source) => ({
		ok: true,
		repoPath: `memory-sources/${source.kind}`,
		commit: source.commit,
	}),
};
