/**
 * Which chat lines a player addresses to us: game semantics a client draws
 * in its own colours, kept here so every reader classifies a line the same
 * way — the sandbox's `sleep` wakes on one, a harness's HUD labels one.
 */

/**
 * The types a player addresses to our group or to us: `PARTY`/`PARTY_LEADER`,
 * `RAID`/`RAID_LEADER`/`RAID_WARNING`, and a whisper received (`WHISPER`,
 * `WHISPER_FOREIGN`). Not our own whisper's echo (`WHISPER_INFORM`), whose
 * sender is the recipient; whether the line is our own is the caller's check.
 */
export const GROUP_OR_WHISPER_CHAT_TYPES: ReadonlySet<number> = new Set([0x02, 0x33, 0x03, 0x27, 0x28, 0x07, 0x08]);

/** A party, raid or whisper line by `type` (`GROUP_OR_WHISPER_CHAT_TYPES`). */
export function isGroupOrWhisperChat(c: { type?: unknown }): boolean {
  return typeof c.type === "number" && GROUP_OR_WHISPER_CHAT_TYPES.has(c.type);
}
