/**
 * What the character wears and carries, drawn the way a client draws it.
 *
 * Two buttons over one inventory sample — "N carrying" and "N equipped" —
 * each opening a popover on hover or a tap, and on the map a third, "N
 * quests", over the trace's quest log. Buttons rather than panels because
 * this sits in a run card and a map sidebar, and a paperdoll inline spends
 * that whole column on something a reader looks at occasionally.
 *
 * The art is Wowhead's, fetched by the reader's browser from a link we render;
 * we hold no icons. That is why a square is not the
 * unconditional shape here. A square is a frame around an icon, so it is drawn
 * only where an icon can arrive: a row with an entry to link, and a script
 * that loaded. Everything else — a row whose name resolved and so carries no
 * id, or any row at all once the script has failed — is a list of `name
 * ×count`, which reads. A grid of 40px boxes with "Barba ric Cloth Breec"
 * wrapped inside them does not.
 *
 * Decoration is detected with a MutationObserver rather than an effect,
 * because `tooltips.js` loads async: the `refreshLinks()` an effect fires
 * after a render usually finds no global at all, and the script's own later
 * pass is what decorates.
 */

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { type InvItem, carried, carriedCount, paperdoll, splitLinked } from "./lib/inventory";
import { type Placement, popoverPlacement, popoverStyle } from "./lib/popover";
import {
  QUEST_STATUS_LABEL,
  type QuestObjective,
  type QuestRow,
  type QuestStatus,
  objectiveText,
  questsInLog,
} from "./lib/questlog";
import {
  PAPERDOLL_BOTTOM,
  PAPERDOLL_LEFT,
  PAPERDOLL_RIGHT,
  type WowheadStatus,
  entryOf,
  isDecorated,
  itemUrl,
  loadWowhead,
  onWowheadStatus,
  qualityColor,
  questUrl,
  refreshLinks,
  slotLabel,
  slotShort,
} from "./lib/wowhead";

/**
 * Keep every `a.inv-link` under `root` labelled with whether Wowhead got to it.
 *
 * Attribute changes are not observed, so the class this writes cannot feed the
 * observer its own next mutation. Exported for the unit frame's spell squares,
 * which are the same cells over spell links.
 */
export function watchDecoration(root: HTMLElement): () => void {
  const mark = (): void => {
    for (const a of Array.from(root.querySelectorAll("a.inv-link"))) {
      a.classList.toggle("decorated", isDecorated(a));
    }
  };
  mark();
  const obs = new MutationObserver(mark);
  obs.observe(root, { childList: true, subtree: true });
  return () => obs.disconnect();
}

const hasEntry = (i: InvItem): boolean => entryOf(i) !== null;
const linkOf = (i: InvItem): string | null => {
  const e = entryOf(i);
  return e === null ? null : itemUrl(e, i.rand);
};
const countSuffix = (i: InvItem): string => (i.count > 1 ? ` ×${i.count}` : "");
/** A worn item's durability, on its square's tooltip, where the trace's sheet carries it. */
const durabilitySuffix = (i: InvItem): string =>
  i.durability === null || i.durability === undefined ? "" : ` · durability ${i.durability[0]} / ${i.durability[1]}`;

/** One square: the item's link and its stack count, framed in its quality. */
function Cell(props: { item: InvItem }) {
  const color = () => qualityColor(props.item.quality);
  return (
    <div
      class="inv-cell"
      title={`${props.item.name}${countSuffix(props.item)}${durabilitySuffix(props.item)}`}
      // The border carries the quality even once an icon covers the middle,
      // which is the only place a decorated cell can still say it.
      style={color() === null ? undefined : { "border-color": color()! }}
    >
      <Show when={linkOf(props.item)} fallback={<span class="inv-link" />}>
        {(href) => (
          <a
            class="inv-link"
            href={href()}
            target="_blank"
            rel="noreferrer"
            data-wh-icon-size="medium"
            data-wh-rename-link="false"
            style={color() === null ? undefined : { color: color()! }}
          >
            <span class="inv-name">{props.item.name}</span>
          </a>
        )}
      </Show>
      <Show when={props.item.count > 1}>
        <span class="inv-count">{props.item.count}</span>
      </Show>
    </div>
  );
}

/** The readable shape: one row per stack, in quality colour, linked if we can. */
function ItemList(props: { items: readonly InvItem[] }) {
  return (
    <ul class="inv-list">
      <For each={props.items}>
        {(item) => {
          const color = qualityColor(item.quality);
          const href = linkOf(item);
          const label = (
            <span class="inv-list-name" style={color === null ? undefined : { color }}>
              {item.name}
            </span>
          );
          return (
            <li>
              <Show when={href} fallback={label}>
                {(h) => (
                  <a class="inv-list-link" href={h()} target="_blank" rel="noreferrer">
                    {label}
                  </a>
                )}
              </Show>
              <Show when={item.count > 1}>
                <span class="inv-list-count">×{item.count}</span>
              </Show>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

/** An equipment square with nothing in it: dim, and named. */
function EmptySlot(props: { slot: number }) {
  return (
    <div class="inv-cell empty" title={slotLabel(props.slot)}>
      <span class="inv-slot-label">{slotShort(props.slot)}</span>
    </div>
  );
}

function SlotColumn(props: { slots: readonly number[]; bySlot: Map<number, InvItem>; cls: string }) {
  return (
    <div class={props.cls}>
      <For each={props.slots}>
        {(slot) => (
          <Show when={props.bySlot.get(slot)} fallback={<EmptySlot slot={slot} />}>
            {(item) => <Cell item={item()} />}
          </Show>
        )}
      </For>
    </div>
  );
}

/**
 * Which panel is open, for the whole page.
 *
 * One at a time, deliberately: two popovers hanging off adjacent buttons
 * overlap each other, and the reader's question is "what is in this one".
 * Opening either closes the other because there is one answer to hold.
 */
const [active, setActive] = createSignal<symbol | null>(null);
const [sticky, setSticky] = createSignal(false);

/**
 * A count you can hover on a desktop and tap on a phone.
 *
 * Hover alone would hide the contents from touch, so the trigger is a real
 * button and a click pins the popover open; hover is the shortcut, not the
 * mechanism.
 *
 * The panel itself is portalled to the body and positioned against the
 * viewport (`popoverPlacement`). As a child of its card it was clipped by the
 * sidebar's scroll area — a full paperdoll showed four rows — and no amount of
 * z-index fixes a clip.
 */
function Popover(props: { icon: JSX.Element; count: number; label: string; children: JSX.Element }) {
  const me = Symbol(props.label);
  const open = () => active() === me;
  const [place, setPlace] = createSignal<Placement>({ below: true, offset: 0, left: 0, maxHeight: 320 });
  let root!: HTMLDivElement;
  let btn!: HTMLButtonElement;
  let panel: HTMLDivElement | undefined;

  const measure = (needed?: number): void => {
    const r = btn.getBoundingClientRect();
    setPlace(
      popoverPlacement(
        r,
        { width: window.innerWidth, height: window.innerHeight },
        needed === undefined ? {} : { needed },
      ),
    );
  };

  onMount(() => {
    loadWowhead();
    const away = (e: MouseEvent): void => {
      if (!open() || !(e.target instanceof Node)) return;
      if (!root.contains(e.target) && !(panel?.contains(e.target) ?? false)) {
        setSticky(false);
        setActive(null);
      }
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && open()) {
        setSticky(false);
        setActive(null);
      }
    };
    // A scroll moves the button out from under a fixed panel, so the panel
    // follows it rather than floating where it was opened.
    const follow = (): void => {
      if (open()) measure();
    };
    document.addEventListener("click", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    onCleanup(() => {
      document.removeEventListener("click", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      if (open()) setActive(null);
    });
  });

  createEffect(() => {
    // A newly opened popover has links the script has not seen yet, and a
    // place to be measured into.
    if (!open()) return;
    props.count;
    measure();
    refreshLinks();
  });

  createEffect(() => {
    // The portal's contents live outside `root`, so the decoration observer
    // watches the panel itself for as long as it exists.
    const el = open() ? panel : undefined;
    if (el === undefined) return;
    // Now that there is a panel, place it against its real height rather than
    // against a floor: the side with room for the whole thing wins.
    measure(el.scrollHeight);
    const stop = watchDecoration(el);
    onCleanup(stop);
  });

  return (
    <div
      class="popover-anchor bag"
      ref={root}
      onMouseEnter={() => {
        setSticky(false);
        setActive(me);
      }}
      onMouseLeave={() => {
        if (!sticky() && open()) setActive(null);
      }}
    >
      <button
        type="button"
        class="popover-button"
        ref={btn}
        aria-expanded={open()}
        onClick={(e) => {
          e.stopPropagation();
          if (open() && sticky()) {
            setSticky(false);
            setActive(null);
          } else {
            setActive(me);
            setSticky(true);
          }
        }}
      >
        {props.icon}
        <span class="bag-count">{props.count}</span>
        <span class="bag-label">{props.label}</span>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            class="popover bag-popover floating"
            ref={panel}
            onMouseEnter={() => setActive(me)}
            onMouseLeave={() => {
              if (!sticky()) setActive(null);
            }}
            style={popoverStyle(place())}
          >
            {props.children}
          </div>
        </Portal>
      </Show>
    </div>
  );
}

/**
 * Grid for what an icon can reach, list for the rest.
 *
 * Once the script has failed there is no such thing as a cell an icon can
 * reach, so the whole set is a list — the squares would be empty frames.
 */
function Items(props: { items: readonly InvItem[]; status: WowheadStatus }) {
  const split = createMemo(() =>
    props.status === "failed"
      ? { linked: [], unlinked: [...props.items] }
      : splitLinked(props.items, hasEntry),
  );
  return (
    <>
      <Show when={split().linked.length > 0}>
        <div class="inv-grid">
          <For each={split().linked}>{(item) => <Cell item={item} />}</For>
        </div>
      </Show>
      <Show when={split().unlinked.length > 0}>
        <ItemList items={split().unlinked} />
      </Show>
    </>
  );
}

/**
 * The equipment sheet, when the run recorded where things are worn.
 *
 * The doll is drawn only when at least one worn row carries a `slot`. On every
 * run recorded before the column existed, none does — and a doll of nineteen
 * empty squares beside a chip row of the actual armour is not a character
 * sheet, it is a picture of the data being missing. Those runs get the list.
 */
export function Equipment(props: { items: readonly InvItem[]; status: WowheadStatus }) {
  const doll = createMemo(() => paperdoll(props.items));
  const worn = createMemo(() => props.items.filter((i) => i.equipped));
  return (
    <Popover icon={<span class="bag-icon worn" aria-hidden="true" />} count={worn().length} label="equipped">
      {/*
        A doll of empty frames is the worst of both: once the script has failed
        the squares can never be filled, so the sheet degrades to the same list
        the bag does. The slots are lost with it, which is the honest trade —
        nothing on the page can draw them.
      */}
      <Show
        when={doll().bySlot.size > 0 && props.status !== "failed"}
        fallback={<Items items={worn()} status={props.status} />}
      >
        <div class="paperdoll">
          <div class="paperdoll-grid">
            <SlotColumn slots={PAPERDOLL_LEFT} bySlot={doll().bySlot} cls="paperdoll-col" />
            <div class="paperdoll-mid" />
            <SlotColumn slots={PAPERDOLL_RIGHT} bySlot={doll().bySlot} cls="paperdoll-col" />
          </div>
          <SlotColumn slots={PAPERDOLL_BOTTOM} bySlot={doll().bySlot} cls="paperdoll-row" />
          <Show when={doll().unplaced.length > 0}>
            <div class="inv-unplaced">
              <div class="inv-note">slot unknown</div>
              <ItemList items={doll().unplaced} />
            </div>
          </Show>
        </div>
      </Show>
      <Show when={worn().length === 0}>
        <div class="inv-note">nothing equipped</div>
      </Show>
    </Popover>
  );
}

/** The bag: what is carried, in bag order where the sample says so. */
export function BagGrid(props: { items: readonly InvItem[]; status: WowheadStatus }) {
  const rows = createMemo(() => carried(props.items));
  return (
    <Popover icon={<span class="bag-icon bag" aria-hidden="true" />} count={carriedCount(props.items)} label="carrying">
      <Show when={rows().length > 0} fallback={<div class="inv-note">bags empty</div>}>
        <Items items={rows()} status={props.status} />
      </Show>
    </Popover>
  );
}

/** The colour a row's status is drawn in: the stylesheet's own utility classes. */
const QUEST_STATUS_CLASS: Readonly<Record<QuestStatus, string | undefined>> = {
  active: undefined,
  complete: "ok",
  failed: "err",
  turnedIn: "ok-muted",
};

/**
 * One quest: its Wowhead link, then its objectives as `have / need` while it
 * is in progress, and once it is not, its status alone in its status's colour.
 * A complete quest's objectives are met on the server's word, and the carried
 * count cannot always show that (a key on the keyring reads 0 wherever the
 * module did not serve the keyring), so its numbers would only be a way to
 * contradict it.
 *
 * Keyed by the quest id, not by the row: the anchor is made once per quest
 * and only the progress beside it follows the playhead. The script renames a
 * link by replacing what is inside it, so an anchor rebuilt on every counter
 * would read `quest <id>` again until the next refresh.
 */
function QuestEntry(props: { questId: number; row: QuestRow | undefined }) {
  const href = questUrl(props.questId);
  const fallback = `quest ${props.questId}`;
  const status = (): QuestStatus => props.row?.status ?? "active";
  const objectives = (): readonly QuestObjective[] => (status() === "active" ? (props.row?.objectives ?? []) : []);
  return (
    <li>
      <Show when={href} fallback={<span class="inv-list-name">{fallback}</span>}>
        {(h) => (
          <a class="inv-list-link" href={h()} target="_blank" rel="noreferrer" data-wh-rename-link="true">
            <span class="inv-list-name">{fallback}</span>
          </a>
        )}
      </Show>
      <span class="inv-list-count" title={QUEST_STATUS_LABEL[status()]}>
        <span class={QUEST_STATUS_CLASS[status()]}>
          <Show when={objectives().length > 0} fallback={status() === "active" ? "" : QUEST_STATUS_LABEL[status()]}>
            <For each={objectives()}>
              {(o, i) => (
                <>
                  {i() > 0 ? " · " : ""}
                  <span title={o.itemId === undefined ? undefined : (o.name ?? `item ${o.itemId}`)}>{objectiveText(o)}</span>
                </>
              )}
            </For>
          </Show>
        </span>
      </span>
    </li>
  );
}

const sameIds = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/** The rows, one per quest id; a new id since the panel opened is a link the script has not seen yet. */
function QuestList(props: { rows: readonly QuestRow[] }) {
  const ids = createMemo(() => props.rows.map((q) => q.questId), undefined, { equals: sameIds });
  const byId = createMemo(() => new Map(props.rows.map((q) => [q.questId, q] as const)));
  createEffect(on(ids, () => refreshLinks(), { defer: true }));
  return (
    <ul class="inv-list">
      <For each={ids()}>{(id) => <QuestEntry questId={id} row={byId().get(id)} />}</For>
    </ul>
  );
}

/**
 * The quest log at the playhead: how many quests it holds, and a panel of
 * them in log-slot order, then any turned in since the trace's window began.
 */
export function QuestLog(props: { rows: readonly QuestRow[] }) {
  return (
    <Popover icon={<span class="quest-mark" aria-hidden="true">?</span>} count={questsInLog(props.rows)} label="quests">
      <Show when={props.rows.length > 0} fallback={<div class="inv-note">log empty</div>}>
        <QuestList rows={props.rows} />
      </Show>
    </Popover>
  );
}

/**
 * The buttons, for the places that show a whole character.
 *
 * `null` items is an inventory not observed, which is not an empty bag: in
 * place of the two buttons is `missing`, the caller's word for that. The
 * quest log is drawn only where the trace's sheet carries it (`questLog`): it
 * has no coarser reading to stand in, so where the sheet cannot say there is
 * no button rather than an empty log. The two are independent: a sheet that
 * has the log and not yet the bags (the stretch after a sandbox restart, live,
 * where the feed carries no inventory to fall back to) still has its quest
 * button beside `missing`.
 */
export function InventoryPanel(props: {
  items: readonly InvItem[] | null | undefined;
  quests?: readonly QuestRow[] | null;
  missing?: string;
}) {
  const [status, setStatus] = createSignal<WowheadStatus>("pending");
  onMount(() => {
    loadWowhead();
    onCleanup(onWowheadStatus(setStatus));
  });
  const missing = (): JSX.Element => <span class="inv-note">{props.missing ?? "inventory not recorded"}</span>;
  return (
    <Show when={props.items || props.quests} fallback={missing()}>
      <div class="inventory">
        <Show when={props.items} fallback={missing()}>
          {(items) => (
            <>
              <BagGrid items={items()} status={status()} />
              <Equipment items={items()} status={status()} />
            </>
          )}
        </Show>
        <Show when={props.quests}>{(rows) => <QuestLog rows={rows()} />}</Show>
      </div>
    </Show>
  );
}
