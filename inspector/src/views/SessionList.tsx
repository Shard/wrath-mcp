/**
 * Every session the caller may see, one row each, live first: who, where,
 * how they stand, and since when. A row is a link to the session.
 */

import { For, Show } from "solid-js";
import type { SessionSummary } from "../wire";
import { fmtAgo, isLive, sessionName, sessionOrder } from "./lib/sessions";

export function SessionList(props: {
  sessions: readonly SessionSummary[];
  now: number;
  /** The link a row is, by session id. */
  href: (id: string) => string;
  selected?: string | null;
  onSelect?: (id: string) => void;
  mapName?: (map: number) => string | null;
}) {
  const rows = () => sessionOrder(props.sessions, props.now);
  return (
    <Show when={rows().length > 0} fallback={<p class="dim">no sessions</p>}>
      <div class="scroller">
        <table>
          <thead>
            <tr>
              <th>character</th>
              <th class="right">level</th>
              <th>state</th>
              <th class="right">seen</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(s) => {
                const live = () => isLive(s, props.now);
                const where = () => {
                  const l = s.live;
                  if (l === null || l.map === null) return "—";
                  const name = props.mapName?.(l.map) ?? null;
                  return `${name ?? `map ${l.map}`}${l.zone !== null ? ` · zone ${l.zone}` : ""}`;
                };
                return (
                  <tr classList={{ hovered: props.selected === s.id }} title={where()} onClick={() => props.onSelect?.(s.id)}>
                    <td>
                      <a href={props.href(s.id)} title={s.id}>
                        {sessionName(s)}
                      </a>
                    </td>
                    <td class="right mono">{s.live?.level ?? "—"}</td>
                    <td>
                      <span class={`badge${live() ? " running" : ""}`}>{live() ? "live" : s.session?.ended != null ? "ended" : "quiet"}</span>
                      <For each={s.live?.flags ?? []}>{(f) => <> <span class={`badge ${f}`}>{f}</span></>}</For>
                    </td>
                    <td class="right mono dim" title={new Date(s.live?.ts ?? s.session?.opened ?? 0).toISOString()}>
                      {fmtAgo(props.now - (s.live?.ts ?? s.session?.opened ?? props.now))}
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
