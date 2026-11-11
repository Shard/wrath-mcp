/**
 * A session's character at the end of its trace: the unit frame, money, and
 * the inventory and quest log from the character sheet. Read from the trace's
 * open tail while the session is live, else from its last closed window.
 */

import { Show, createMemo } from "solid-js";
import type { InspectorClient } from "./client";
import { InventoryPanel } from "./Inventory";
import { characterAt, decoded, fmtMoney, segmentEnd, type CharacterAt } from "./lib/sessions";
import { poll } from "./poll";
import { UnitFrame } from "./UnitFrame";

/** Where the newest packed window is: the open tail, else the last closed window. */
async function newestCharacter(client: InspectorClient, id: string, klass: number | null): Promise<CharacterAt | null> {
  const index = await client.traceIndex(id);
  let seg = decoded(index.tail);
  if (seg === null) {
    const last = index.segs[index.segs.length - 1];
    if (last === undefined) return null;
    seg = decoded(await client.traceSegment(id, last[0] + (last[1] - 1) * index.segMs));
  }
  return seg === null ? null : characterAt(seg, segmentEnd(seg), klass);
}

export function CharacterPanel(props: { client: InspectorClient; id: string; live: boolean; klass?: number | null }) {
  const reading = poll(() => newestCharacter(props.client, props.id, props.klass ?? null), props.live ? 5_000 : 0);
  const c = createMemo(() => reading.value() ?? null);
  return (
    <Show when={c()} fallback={<p class="dim">no trace</p>}>
      {(ch) => (
        <div class="card live-attempt">
          <UnitFrame
            level={ch().gauges.level}
            xp={ch().gauges.xp}
            nextLevelXp={ch().gauges.nextLevelXp}
            health={ch().gauges.health}
            maxHealth={ch().gauges.maxHealth}
            power={ch().gauges.power}
            maxPower={ch().gauges.maxPower}
            powerType={ch().powerType}
            dead={ch().gauges.dead ?? null}
            cast={ch().cast}
            target={ch().target}
            flags={ch().flags}
            auras={ch().auras}
            now={ch().t}
          />
          <div class="k">money</div>
          <div class="v mono">{fmtMoney(ch().money)}</div>
          <InventoryPanel items={ch().items} quests={ch().quests} />
        </div>
      )}
    </Show>
  );
}
