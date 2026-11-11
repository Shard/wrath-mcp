/**
 * `@wrathbench/inspector/views`: the inspector's SolidJS views, for its own
 * page and for any page that embeds them. Browser-side: nothing here imports
 * a runtime built-in or the inspector's server half (`scripts/boundary.ts`).
 *
 * - The pages' parts: `LiveMap`, `SessionList`, `SessionView`,
 *   `CharacterPanel`, `PartyView`, `EventFeed`, over the API through
 *   `createInspectorClient`.
 * - The character's parts, which draw from the trace codec's readings and
 *   need no client: `UnitFrame`, `XpBar`, `InventoryPanel` and the pure
 *   helpers behind them, each also its own entry point
 *   (`@wrathbench/inspector/views/unitframe`, `…/inventory`, `…/questlog`,
 *   `…/nearbyplayer`, `…/chatbubbles`, `…/popover`, `…/wowhead`), so a test
 *   or a page that wants only the arithmetic loads no component.
 *
 * The class names are the stylesheet's (`@wrathbench/inspector/views/inspector.css`).
 */

export { CharacterPanel } from "./CharacterPanel";
export { Unauthorized, createInspectorClient, type InspectorClient } from "./client";
export { EventFeed } from "./EventFeed";
export { BagGrid, Equipment, InventoryPanel, QuestLog, watchDecoration } from "./Inventory";
export { LiveMap, type LiveMapProps } from "./LiveMap";
export { PartyView } from "./PartyView";
export { poll } from "./poll";
export { SessionList } from "./SessionList";
export { SessionView } from "./SessionView";
export { UnitFrame, XpBar, type UnitFrameProps } from "./UnitFrame";
export * from "./lib/sessions";
export * from "./lib/world";
export type * from "../wire";
