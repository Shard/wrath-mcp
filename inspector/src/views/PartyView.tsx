/**
 * A session's party as its record left it: each member that is one of this
 * deployment's sessions, linked, with its level and where it stands; any
 * other member is only counted, as the write gate keeps them.
 */

import { For, Show } from "solid-js";
import type { RowWire, SessionSummary } from "../wire";
import { isLive, partyOf, sessionName } from "./lib/sessions";

export function PartyView(props: { events: readonly RowWire[]; sessions: readonly SessionSummary[]; now: number; href: (id: string) => string }) {
  const party = () => partyOf(props.events, props.sessions);
  return (
    <Show when={party()} fallback={<p class="dim">no party</p>}>
      {(p) => (
        <div class="scroller">
        <table>
          <tbody>
            <For each={p().members}>
              {(m) => (
                <tr>
                  <td>
                    <Show when={m.session} fallback={<span class="dim">{m.guid}</span>}>
                      {(s) => <a href={props.href(s().id)}>{sessionName(s())}</a>}
                    </Show>
                    <Show when={m.guid === p().leaderGuid}>
                      {" "}
                      <span class="badge">leader</span>
                    </Show>
                  </td>
                  <td class="right mono">{m.session?.live?.level ?? "—"}</td>
                  <td>
                    <span class={`badge${m.session !== null && isLive(m.session, props.now) ? " running" : ""}`}>
                      {m.session !== null && isLive(m.session, props.now) ? "live" : "—"}
                    </span>
                  </td>
                </tr>
              )}
            </For>
            <Show when={p().foreign > 0}>
              <tr>
                <td class="dim" colSpan={3}>
                  +{p().foreign}
                </td>
              </tr>
            </Show>
          </tbody>
        </table>
        </div>
      )}
    </Show>
  );
}
