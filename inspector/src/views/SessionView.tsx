/**
 * One session: what it is (`session.json`), its character now, its party and
 * what happened to it.
 */

import { For, Show, createSignal } from "solid-js";
import type { RowWire, SessionSummary } from "../wire";
import { CharacterPanel } from "./CharacterPanel";
import type { InspectorClient } from "./client";
import { EventFeed } from "./EventFeed";
import { fmtAgo, groupSiblings, isLive, sessionName } from "./lib/sessions";
import { PartyView } from "./PartyView";

export function SessionView(props: { client: InspectorClient; summary: SessionSummary; sessions: readonly SessionSummary[]; now: number; href: (id: string) => string }) {
  const [events, setEvents] = createSignal<RowWire[]>([]);
  const s = () => props.summary.session;
  const live = () => isLive(props.summary, props.now);
  const stamp = (ms: number | null | undefined): string => (ms === null || ms === undefined ? "—" : new Date(ms).toISOString().replace("T", " ").slice(0, 19));
  return (
    <div class="page">
      <h1>{sessionName(props.summary)}</h1>
      <div class="cards">
        <div class="card">
          <div class="k">state</div>
          <div class="v">
            <span class={`badge${live() ? " running" : ""}`}>{live() ? "live" : s()?.ended != null ? "ended" : "quiet"}</span>
          </div>
          <div class="sub">
            {stamp(s()?.started)} · {s()?.ended != null ? fmtAgo(s()!.ended! - s()!.started) : fmtAgo(props.now - (s()?.started ?? props.now))}
          </div>
        </div>
        <div class="card">
          <div class="k">character</div>
          <div class="v">{s()?.character?.name ?? "—"}</div>
          <div class="sub mono">
            race {s()?.character?.race ?? "—"} · class {s()?.character?.class ?? "—"} · guid {s()?.character?.guid ?? "—"}
          </div>
        </div>
        <div class="card">
          <div class="k">stack</div>
          <div class="v mono">{s()?.stack.version ?? "—"}</div>
          <div class="sub mono">
            {s()?.stack.commit?.slice(0, 12) ?? "—"} · module {s()?.module?.build ?? "—"}
          </div>
        </div>
        <Show when={s()?.owner !== undefined || s()?.group !== undefined}>
          <div class="card">
            <div class="k">owner</div>
            <div class="v">{s()?.owner ?? "—"}</div>
            <div class="sub">{s()?.group ?? ""}</div>
          </div>
        </Show>
        <Show when={s()?.world !== undefined}>
          <div class="card">
            <div class="k">world</div>
            <div class="v mono">{s()?.world}</div>
          </div>
        </Show>
      </div>
      {/* The other characters the same client drives, each a link to its own session. */}
      <Show when={groupSiblings(props.sessions, props.summary).length > 0}>
        <p>
          <For each={groupSiblings(props.sessions, props.summary)}>
            {(o) => (
              <>
                <a href={props.href(o.id)}>{sessionName(o)}</a>{" "}
                <span class={`badge${isLive(o, props.now) ? " running" : ""}`}>{isLive(o, props.now) ? "live" : o.session?.ended != null ? "ended" : "quiet"}</span>{" "}
              </>
            )}
          </For>
        </p>
      </Show>
      <h2 class="section">character</h2>
      <CharacterPanel client={props.client} id={props.summary.id} live={live()} klass={s()?.character?.class ?? null} />
      <h2 class="section">party</h2>
      <PartyView events={events()} sessions={props.sessions} now={props.now} href={props.href} />
      <h2 class="section">events</h2>
      <EventFeed client={props.client} id={props.summary.id} live={live()} end={s()?.ended ?? null} rows={setEvents} />
    </div>
  );
}
