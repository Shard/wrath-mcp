/**
 * Item icons and tooltips, without holding any item art.
 *
 * The inventory panels want what a player sees on their character sheet: an
 * icon per item, a tooltip naming its stats. We have neither, and extracting
 * either from the client would put Blizzard-derived art in this repository,
 * which `docs/DATA-AND-LEGAL.md` forbids outright. What we do have is the one
 * identifier that makes the art findable: `item_template.entry`, the 3.3.5a
 * item id the server already tells us about.
 *
 * So the dashboard links the entry and lets Wowhead's public tooltip script
 * decorate the link in the reader's browser. Nothing is
 * served by us, nothing is cached by us, and a reader who blocks
 * `wow.zamimg.com` sees the fallback this module's callers render — the item's
 * name in its quality colour — rather than a broken page. The external-request
 * consequence is recorded in `docs/PUBLIC-DASHBOARD.md`.
 *
 * `wotlk` in the link is Wowhead's Wrath dataset, which is the one our ids
 * belong to; the retail path would resolve the same numbers to different items.
 */

/** Where the script and the item, spell and quest pages live. One place spells each. */
const SCRIPT_SRC = "https://wow.zamimg.com/js/tooltips.js";
const ITEM_BASE = "https://www.wowhead.com/wotlk/item=";
const SPELL_BASE = "https://www.wowhead.com/wotlk/spell=";
const QUEST_BASE = "https://www.wowhead.com/wotlk/quest=";

/**
 * The link for one item entry, and the instance's random property when it has
 * one.
 *
 * Entries are positive integers; anything else is not an id we can link, and
 * the caller renders the name alone. `rand` is the item's random property id
 * as the server sends it, negative for a random suffix: the tooltip script
 * reads `rand` off the link and asks for that roll, so the tooltip names the
 * suffix and its stats where the base item's says "<Random enchantment>". Zero
 * and anything not an integer is no roll, and the link is the base item's.
 */
export function itemUrl(entry: number, rand?: number | null): string | null {
  if (!Number.isInteger(entry) || entry <= 0) return null;
  const roll = typeof rand === "number" && Number.isInteger(rand) && rand !== 0 ? `?rand=${rand}` : "";
  return `${ITEM_BASE}${entry}${roll}`;
}

/**
 * The link for one spell id: a buff, a debuff, or a cast in progress on the
 * unit frame. The same arrangement as an item's — the trace carries the id
 * the server sent, and the reader's browser asks Wowhead for the icon and the
 * tooltip — so the frame holds no spell art and no spell text.
 */
export function spellUrl(spellId: number): string | null {
  if (!Number.isInteger(spellId) || spellId <= 0) return null;
  return `${SPELL_BASE}${spellId}`;
}

/**
 * The link for one quest id: a row of the map's quest log. The trace records
 * the id and its counters and never the title, so this link is the only place
 * a quest's name can come from: the panel asks the script to rename it
 * (`data-wh-rename-link`, against the page-wide `renameLinks: false`), and
 * where the script never arrives the row reads `quest <id>`.
 */
export function questUrl(questId: number): string | null {
  if (!Number.isInteger(questId) || questId <= 0) return null;
  return `${QUEST_BASE}${questId}`;
}

/**
 * The entry hiding in a name the item cache never resolved.
 *
 * A state sample records whatever name the client cache held, and for an item
 * the server had not yet described that is the placeholder `item <id>` — which
 * still carries the id. Runs recorded before the `itemId` column existed
 * are entirely made of these and of real names, so parsing the placeholder is
 * what gets such a run icons at all. A real name returns null.
 */
export function parseEntryFromName(name: string | null | undefined): number | null {
  if (typeof name !== "string") return null;
  const m = /^item\s+(\d+)$/i.exec(name.trim());
  if (m === null) return null;
  const entry = Number(m[1]);
  return Number.isInteger(entry) && entry > 0 ? entry : null;
}

/** The entry to link for one item row: the recorded id, else the placeholder's. */
export function entryOf(item: { itemId?: number | null; name?: string | null }): number | null {
  const id = item.itemId;
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return id;
  return parseEntryFromName(item.name);
}

/**
 * The colour a quality is drawn in.
 *
 * The client's own palette, with one deliberate change: common (1) returns
 * null rather than white, because this page has a light theme and white text
 * on `#fbfbfc` is invisible. Null means "the page's own foreground", which is
 * what common items look like against either background. Poor (0) is the one
 * quality that reads as deliberately dim in both themes, so it keeps its grey.
 */
export function qualityColor(quality: number | null | undefined): string | null {
  switch (quality) {
    case 0:
      return "#9d9d9d"; // poor
    case 2:
      return "#1eff00"; // uncommon
    case 3:
      return "#0070dd"; // rare
    case 4:
      return "#a335ee"; // epic
    case 5:
      return "#ff8000"; // legendary
    case 6:
    case 7:
      return "#e6cc80"; // artifact, heirloom
    default:
      return null; // common, and anything unrecorded
  }
}

/**
 * The globals the script reads, set before it loads.
 *
 * `renameLinks: false` matters most: left on, the script replaces our link
 * text with the item's name, which would wipe the fallback text we rely on
 * when the script never arrives. A quest link is the one exception, per link:
 * its fallback is only the id, so it asks to be renamed (`questUrl`).
 * `iconizeLinks` and `iconSize` set what a link with no per-link attribute
 * gets; the grid overrides both per cell, and the script iconizes no quest.
 */
export function wowheadConfig(): Record<string, unknown> {
  return { colorLinks: true, iconizeLinks: true, renameLinks: false, iconSize: "medium" };
}

interface ScriptHost {
  document: Document;
  whTooltips?: unknown;
}

function host(): ScriptHost | null {
  const g = globalThis as unknown as Partial<ScriptHost>;
  return typeof g.document === "object" && g.document !== null ? (g as ScriptHost) : null;
}

/**
 * Inject the config and the script tag, once.
 *
 * Idempotent by the tag already being in the document, not by a module-level
 * flag: the SPA mounts these panels on two pages and remounts them on every
 * navigation, and a flag would also have to survive HMR. A no-op where there
 * is no document at all (tests, and any server render) so importing this
 * module costs nothing there.
 *
 * Returns whether a tag was added, which is only interesting to the tests.
 */
export function loadWowhead(target?: ScriptHost): boolean {
  const h = target ?? host();
  if (h === null) return false;
  // Globals first: the script reads them as it evaluates, so setting them
  // after the tag is a race we would lose on a warm cache.
  h.whTooltips = wowheadConfig();
  if (h.document.querySelector(`script[src="${SCRIPT_SRC}"]`) !== null) return false;
  const el = h.document.createElement("script");
  el.src = SCRIPT_SRC;
  el.async = true;
  el.onload = () => setStatus("ready");
  el.onerror = () => setStatus("failed");
  h.document.head.appendChild(el);
  // A host that resolves but never answers fires neither event for a long
  // time, so the wait has an end: whatever is true then is the answer.
  setTimeout(() => setStatus(powerPresent() ? "ready" : "failed"), READY_TIMEOUT_MS);
  return true;
}

/**
 * Whether the script arrived, and what the panels do while they wait.
 *
 * A square is only worth drawing if something will fill it. Ours never fills
 * it — the art is Wowhead's — so a blocked or missing script leaves a grid of
 * boxes with truncated names in them, which is worse than a plain list. The
 * panels therefore watch this: `pending` and `ready` draw the grid, `failed`
 * degrades the whole thing to a list of `name ×count` rows.
 *
 * `failed` is reached two ways, because a blocked host and a slow one look the
 * same at first: the tag's own error event, and a timeout after which the
 * global still is not there.
 */
export type WowheadStatus = "pending" | "ready" | "failed";

/** How long a reader waits for the script before the panels stop waiting. */
const READY_TIMEOUT_MS = 6000;

let status: WowheadStatus = "pending";
const watchers = new Set<(s: WowheadStatus) => void>();

function setStatus(next: WowheadStatus): void {
  if (status === next || status === "ready") return;
  status = next;
  for (const w of watchers) w(next);
}

/** The status now. */
export function wowheadStatus(): WowheadStatus {
  return status;
}

/** Follow the status, starting with the one standing. Returns an unsubscribe. */
export function onWowheadStatus(cb: (s: WowheadStatus) => void): () => void {
  watchers.add(cb);
  cb(status);
  return () => watchers.delete(cb);
}

/**
 * Back to `pending`, for a test that wants the clean slate.
 *
 * The status is module state because the script is: one page load fetches it
 * once, and every panel on the page shares the answer. A test file exercising
 * both outcomes needs a way back, and this is narrower than making every
 * caller thread the state through.
 */
export function resetWowheadStatus(): void {
  status = "pending";
  watchers.clear();
}

function powerPresent(): boolean {
  return (globalThis as { $WowheadPower?: unknown }).$WowheadPower !== undefined;
}

/**
 * Ask the script to decorate links added since it last looked.
 *
 * Guarded on the global, because this is called from an effect that runs on
 * every item change and the script is loaded async: before it lands this is a
 * no-op, and the script's own load-time pass decorates what is already there.
 * That is why no caller may treat a call here as the thing that makes icons
 * appear — the grid watches the DOM instead.
 */
export function refreshLinks(): void {
  const power = (globalThis as { $WowheadPower?: { refreshLinks?: () => void } }).$WowheadPower;
  if (power === undefined) return;
  setStatus("ready");
  if (typeof power.refreshLinks === "function") power.refreshLinks();
}

/**
 * Has the script decorated this link?
 *
 * It replaces the anchor's contents with an icon element of its own; ours is a
 * single `span.inv-name`. So "there is an element in here that is not our
 * fallback" is the signal, and it is a pure predicate over the node so the
 * grid's observer has nothing to test beyond wiring.
 */
export function isDecorated(el: Element | null | undefined): boolean {
  if (el === null || el === undefined) return false;
  for (const child of Array.from(el.children)) {
    if (!child.classList.contains("inv-name")) return true;
  }
  return false;
}

/** The equipment slots, by the server's own numbering. */
export const EQUIPMENT_SLOTS = [
  // `EquipmentSlots` in deps/azerothcore/src/server/game/Entities/Player/Player.h:660.
  // Bags are 19-22 and are not part of the paperdoll.
  { slot: 0, key: "head", label: "head" },
  { slot: 1, key: "neck", label: "neck" },
  { slot: 2, key: "shoulders", label: "shoulder" },
  { slot: 14, key: "back", label: "back" },
  { slot: 4, key: "chest", label: "chest" },
  { slot: 3, key: "body", label: "shirt" },
  { slot: 18, key: "tabard", label: "tabard" },
  { slot: 8, key: "wrists", label: "wrist" },
  { slot: 9, key: "hands", label: "hands" },
  { slot: 5, key: "waist", label: "waist" },
  { slot: 6, key: "legs", label: "legs" },
  { slot: 7, key: "feet", label: "feet" },
  { slot: 10, key: "finger1", label: "ring" },
  { slot: 11, key: "finger2", label: "ring" },
  { slot: 12, key: "trinket1", label: "trinket" },
  { slot: 13, key: "trinket2", label: "trinket" },
  { slot: 15, key: "mainhand", label: "main hand" },
  { slot: 16, key: "offhand", label: "off hand" },
  { slot: 17, key: "ranged", label: "ranged" },
] as const;

/** The paperdoll's three regions, in the order the classic sheet reads. */
export const PAPERDOLL_LEFT = [0, 1, 2, 14, 4, 3, 18, 8] as const;
export const PAPERDOLL_RIGHT = [9, 5, 6, 7, 10, 11, 12, 13] as const;
export const PAPERDOLL_BOTTOM = [15, 16, 17] as const;

/** What a slot is called, in full: the square's tooltip. */
export function slotLabel(slot: number): string {
  return EQUIPMENT_SLOTS.find((s) => s.slot === slot)?.label ?? `slot ${slot}`;
}

/**
 * What fits *inside* an empty square, which is about six characters.
 *
 * Abbreviating rather than shrinking the type: the scale in `styles.css` has a
 * floor (`--fs-2xs`, 9px) that a phone does not step below, so a label that
 * does not fit is a label that gets clipped. The full word is the square's
 * `title` either way.
 */
export function slotShort(slot: number): string {
  const full = slotLabel(slot);
  switch (full) {
    case "shoulder":
      return "shldr";
    case "trinket":
      return "trink";
    case "main hand":
      return "main";
    case "off hand":
      return "off";
    default:
      return full;
  }
}

/** Is this a paperdoll slot at all? Bags (19-22) and nonsense are not. */
export function isEquipmentSlot(slot: number | null | undefined): slot is number {
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot <= 18;
}
