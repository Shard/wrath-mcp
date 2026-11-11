/**
 * A character's unit frame: three stacked bars the way the client draws them —
 * health, power tinted by type, experience with the level badged at the left.
 * The arithmetic and the colour choice are `lib/unitframe.ts`; this is the
 * markup. No images and no fonts: the bevel is a gradient in `styles.css`.
 *
 * Where the run recorded a trace, the frame also carries what the trace knows
 * at the playhead and a 60 s sample never did: a cast bar, the target, the
 * combat and mount states, and the buffs row. Each is drawn only when it is
 * given, so a frame without a trace — every run before the recorder, and the
 * character page — is the three bars it always was. Spell icons are links to
 * Wowhead decorated by its tooltip script in the reader's browser, exactly as
 * the inventory's item icons are (`lib/wowhead.ts`): we hold no spell art.
 */

import { For, Show, createMemo, onCleanup, onMount, type JSX } from "solid-js";
import {
  type AuraView,
  type BarReading,
  type CastReading,
  type PowerType,
  type UnitFlag,
  auraLeft,
  barReading,
  healthReading,
  powerToken,
  xpToNext,
} from "./lib/unitframe";
import { loadWowhead, refreshLinks, spellUrl } from "./lib/wowhead";
import { watchDecoration } from "./Inventory";

export interface UnitFrameProps {
  level: number | null | undefined;
  xp: number | null | undefined;
  nextLevelXp?: number | null | undefined;
  health?: number | null | undefined;
  maxHealth?: number | null | undefined;
  power?: number | null | undefined;
  maxPower?: number | null | undefined;
  powerType?: PowerType | undefined;
  dead?: boolean | null | undefined;
  /* The trace's half, at the playhead; absent without a trace. */
  cast?: CastReading | null | undefined;
  target?: BarReading | null | undefined;
  flags?: readonly UnitFlag[] | undefined;
  /** The buffs row. Pass a stable array (`sameAuras`): a fresh one per tick would remount every icon. */
  auras?: readonly AuraView[] | undefined;
  /** The playhead the auras count down against. */
  now?: number | undefined;
}

function Bar(props: { cls: string; pct: number; text: string; title: string; observed: boolean; fill?: string; dead?: boolean }) {
  return (
    <div
      class={`bar ${props.cls}${props.observed ? "" : " unobserved"}${props.dead ? " dead" : ""}`}
      title={props.title}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.pct}
    >
      <div class="bar-fill" style={{ width: `${props.pct}%`, ...(props.fill ? { "background-color": props.fill } : {}) }} />
      <span class="bar-text">{props.text}</span>
    </div>
  );
}

/**
 * One spell's square: its Wowhead link, which the script turns into the
 * icon, with the id as the fallback a blocked reader sees — we have no names.
 * The squares and the decoration watch are the inventory's own.
 */
function SpellCell(props: { spellId: number; stacks?: number; debuff?: boolean }) {
  onMount(() => {
    loadWowhead();
    refreshLinks();
  });
  return (
    <span class="inv-cell" classList={{ debuff: props.debuff === true }}>
      <Show
        when={spellUrl(props.spellId)}
        fallback={
          <span class="inv-link">
            <span class="inv-name">{props.spellId}</span>
          </span>
        }
      >
        {(href) => (
          <a
            class="inv-link"
            href={href()}
            target="_blank"
            rel="noreferrer"
            data-wh-icon-size="small"
            data-wh-rename-link="false"
          >
            <span class="inv-name">{props.spellId}</span>
          </a>
        )}
      </Show>
      <Show when={(props.stacks ?? 0) > 1}>
        <span class="inv-count">{props.stacks}</span>
      </Show>
    </span>
  );
}

/** A row of spell squares, watched for the script's decoration as the inventory's grid is. */
function SpellRow(props: { class: string; children: JSX.Element }) {
  let root!: HTMLDivElement;
  onMount(() => onCleanup(watchDecoration(root)));
  return (
    <div class={props.class} ref={root}>
      {props.children}
    </div>
  );
}

/**
 * The buffs row. Keyed by the aura's key, a string, so a cell — and the link
 * the script decorated — lives as long as the aura does, while its stacks and
 * its time left update in place.
 */
function Auras(props: { auras: readonly AuraView[]; now: number }) {
  const keys = createMemo(() => props.auras.map((a) => a.key));
  const byKey = createMemo(() => new Map(props.auras.map((a) => [a.key, a])));
  return (
    <SpellRow class="auras">
      <For each={keys()}>
        {(key) => (
          <Show when={byKey().get(key)}>
            {(a) => (
              <span>
                <SpellCell spellId={a().spellId} stacks={a().stacks} debuff={a().debuff} />
                <span class="inv-note">{auraLeft(a().expiresAt, props.now)}</span>
              </span>
            )}
          </Show>
        )}
      </For>
    </SpellRow>
  );
}

/**
 * The experience row on its own: the level badge and the xp bar, at the size a
 * line of text wants.
 *
 * Exported rather than copied, because the frame's bar is the site's bar — the
 * bevel, the track, the unobserved treatment and the level badge are one set of
 * rules in `styles.css` and one `Bar` here. The character card needed the
 * reading without the health and power bars above it, which is a narrower use
 * of this component, not a second one.
 */
export function XpBar(props: Pick<UnitFrameProps, "level" | "xp" | "nextLevelXp">) {
  // Read once per change, not once per attribute the bar draws from it.
  const xp = createMemo(() => barReading(props.xp, xpToNext(props.level, props.nextLevelXp)));
  return (
    <span class="xp-row xp-inline">
      <span class="level-badge" title="level">
        <Show when={typeof props.level === "number"} fallback="—">{props.level}</Show>
      </span>
      <Bar cls="xp" pct={xp().pct} text={xp().text} title={xp().title} observed={xp().observed} />
    </span>
  );
}

export function UnitFrame(props: UnitFrameProps) {
  const hp = createMemo(() => healthReading(props.health, props.maxHealth, props.dead));
  const pw = createMemo(() => barReading(props.power, props.maxPower));
  const xp = createMemo(() => barReading(props.xp, xpToNext(props.level, props.nextLevelXp)));
  // Keyed on the spell, so a new cast is a new square rather than an old
  // icon under a new link.
  const castSpell = createMemo(() => props.cast?.spellId);
  return (
    <div class="unit-frame">
      <Bar cls="hp" pct={hp().pct} text={hp().text} title={hp().dead ? "dead" : hp().title} observed={hp().observed} dead={hp().dead} />
      <Bar cls="pw" pct={pw().pct} text={pw().text} title={pw().title} observed={pw().observed} fill={powerToken(props.powerType ?? "mana")} />
      <div class="xp-row">
        <span class="level-badge" title="level">
          <Show when={typeof props.level === "number"} fallback="—">{props.level}</Show>
        </span>
        <Bar cls="xp" pct={xp().pct} text={xp().text} title={xp().title} observed={xp().observed} />
      </div>
      <Show when={castSpell()} keyed>
        {(spellId) => (
          <SpellRow class="xp-row cast-row">
            <SpellCell spellId={spellId} />
            <Bar cls="cast" pct={props.cast?.pct ?? 0} text={props.cast?.text ?? ""} title="casting" observed={true} />
          </SpellRow>
        )}
      </Show>
      <Show when={props.target}>
        {(t) => <Bar cls="hp target" pct={t().pct} text={t().text} title={t().title} observed={t().observed} />}
      </Show>
      <Show when={(props.flags?.length ?? 0) > 0}>
        <div class="unit-flags">
          <For each={props.flags}>{(f) => <span class={`badge ${f}`}>{f}</span>}</For>
        </div>
      </Show>
      <Show when={(props.auras?.length ?? 0) > 0}>
        <Auras auras={props.auras ?? []} now={props.now ?? 0} />
      </Show>
    </div>
  );
}
