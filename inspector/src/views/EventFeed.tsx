/**
 * What happened to a session's character, newest first: its `events` stream
 * over the last hours of the session, and, while it is live, every row its
 * writer adds after, as it lands.
 */

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { RowWire } from "../wire";
import type { InspectorClient } from "./client";
import { eventLine } from "./lib/sessions";

/** How far back the feed reads when it opens, and how many lines it keeps. */
export const FEED_LOOKBACK_MS = 6 * 60 * 60_000;
export const FEED_MAX = 300;

/** Row kinds that state a stream rather than report something happening. */
const BOOKKEEPING = new Set(["key", "achievements_at_login", "spells_at_login"]);

export function EventFeed(props: { client: InspectorClient; id: string; live: boolean; end?: number | null; rows?: (rows: RowWire[]) => void }) {
  const [rows, setRows] = createSignal<RowWire[]>([]);
  const add = (more: readonly RowWire[]): void => {
    const next = [...rows(), ...more].sort((a, b) => a.ts - b.ts);
    setRows(next.slice(-FEED_MAX));
    props.rows?.(next);
  };
  onMount(() => {
    const to = props.end ?? Date.now();
    void props.client
      .rows(props.id, "events", to - FEED_LOOKBACK_MS, to + 60_000)
      .then(add)
      .catch(() => undefined);
    if (props.live) onCleanup(props.client.tail(props.id, "events", add));
  });
  const shown = () => rows().filter((r) => !BOOKKEEPING.has(r.kind)).reverse();
  return (
    <Show when={shown().length > 0} fallback={<p class="dim">no events</p>}>
      <div class="scroller">
        <table>
          <tbody>
          <For each={shown()}>
            {(r) => (
              <tr>
                <td class="mono dim" title={new Date(r.ts).toISOString()}>
                  {new Date(r.ts).toISOString().slice(11, 19)}
                </td>
                <td>{eventLine(r)}</td>
              </tr>
            )}
          </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
