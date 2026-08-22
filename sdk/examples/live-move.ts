/**
 * The movement + world-observation slice, driven entirely through the SDK.
 *
 * What it proves, in order: the update stream fills the state cache with real
 * objects (`waitForNearby` on a *named* creature needs both a create block and
 * the creature-query answer), `moveTo` returns the server's own verdict, and
 * the cache's own position agrees with it afterwards.
 *
 * The destination is a point on the line toward an observed creature rather
 * than a blind offset: a creature is standing on walkable ground by
 * construction, whereas an arbitrary 30y bearing lands in a wall or a lake and
 * comes back `target_off_mesh` / `path_incomplete`.
 *
 * Not part of `bun test`: it needs a booted worldserver. Run it from inside the
 * compose network:
 *
 *   docker compose -f infra/compose.yml exec runner bun sdk/examples/live-move.ts
 *
 * Override the target with MODULE_HOST / MODULE_PORT (default worldserver:8086).
 */

import { randomBytes } from "node:crypto";
import { connect, WrathRequestError, type NearbyObject, type WrathClient } from "../src/index";

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
// Random hex, not a timestamp: session tokens under 32 chars are rejected with
// `weak_token`, and a per-session token must be unique anyway.
const TOKEN = `sdk-move-${randomBytes(16).toString("hex")}`;
const CHARACTER = process.env.MOVE_CHARACTER ?? "Benchmove";
/** How far to walk, in yards, when the geometry allows it. */
const TARGET_DISTANCE = 30;
/** How long to keep retrying while the module is being rebuilt under us. */
const BOOT_WAIT_MS = 240_000;

function log(msg: string): void {
  console.log(`[live-move] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[live-move] FAIL: ${msg}`);
  process.exit(1);
}

interface Point {
  x: number;
  y: number;
  z: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function describe(obj: NearbyObject, from: Point | undefined): string {
  const p = obj.position?.value;
  const pos = p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})` : "unobserved";
  const away = p && from ? ` ${distance(from, p).toFixed(1)}y away` : "";
  return (
    `${obj.name?.value ?? "<unnamed>"} lvl ${obj.level?.value ?? "?"} ` +
    `[${obj.objectType?.value ?? "?"} entry ${obj.entry?.value ?? "?"} guid ${obj.guid}] ` +
    `hp ${obj.health ? `${obj.health.value.current}/${obj.health.value.max}` : "unobserved"} ` +
    `at ${pos}${away} @seq ${obj.lastSeq}`
  );
}

/** Wait for the module to answer /health — it is rebuilt and restarted often. */
async function waitForModule(client: WrathClient): Promise<void> {
  const deadline = Date.now() + BOOT_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      const health = await client.health();
      if (!health.worldStopped) {
        log(`health: ${JSON.stringify(health)}`);
        return;
      }
      log(`world is stopped, waiting (attempt ${attempt})`);
    } catch (e) {
      log(`module not answering yet (attempt ${attempt}): ${String((e as Error).message)}`);
    }
    if (Date.now() > deadline) fail(`module did not come up within ${BOOT_WAIT_MS}ms`);
    await Bun.sleep(5000);
  }
}

async function main(): Promise<void> {
  // Health first, without a subscription: the WS would only reconnect-loop
  // while the worldserver is down.
  const probe = await connect({ baseUrl: BASE, token: TOKEN, subscribeEvents: false, requestTimeoutMs: 10_000 });
  await waitForModule(probe);
  probe.close();

  const client = await connect({ baseUrl: BASE, token: TOKEN });
  log(`subscribed to events for token ${TOKEN}`);

  try {
    const session = await client.createSession({ character: CHARACTER, race: 1, class: 1, gender: 0 });
    log(`in world as ${session.character} (guid ${session.guid})`);

    const start = client.state.self.position;
    if (!start) fail("no position after login");
    log(
      `start: map=${start.value.map} (${start.value.x.toFixed(1)}, ${start.value.y.toFixed(1)}, ` +
        `${start.value.z.toFixed(1)}) @seq ${start.seq}`,
    );

    // 1. The world arrives on the update stream. A *named* creature needs the
    //    create block and the creature-query answer the module fired on first
    //    sight, so this is a cache predicate, not an event predicate.
    const seen = await client.waitForNearby(
      (o) => o.objectType?.value === "unit" && o.name !== undefined && o.position !== undefined,
      { timeout: 30_000 },
    );
    log(`first named creature in view: ${describe(seen, start.value)}`);
    log(
      `state.nearby: ${client.state.nearby.size} objects, ${client.state.nearbyUnits().length} units, ` +
        `${client.state.creatures.size} creature names resolved`,
    );

    const self = client.state.self;
    log(
      `state.self: hp ${self.health ? `${self.health.value.current}/${self.health.value.max}` : "unobserved"} ` +
        `power ${self.power ? `${self.power.value.current}/${self.power.value.max}` : "unobserved"} ` +
        `level ${self.level?.value ?? "?"} (health/power @seq ${self.health?.seq ?? "-"})`,
    );

    // 2. Walk toward an observed creature, stopping short of it. Candidates are
    //    tried farthest-first so the walk is as close to TARGET_DISTANCE as the
    //    neighbourhood allows; an off-mesh/incomplete verdict just moves to the next one.
    const from = client.state.self.position?.value ?? start.value;
    const candidates = client
      .state.nearbyUnits()
      .filter((o) => o.position !== undefined && o.name !== undefined)
      .map((o) => ({ obj: o, d: distance(from, o.position!.value) }))
      .filter((c) => c.d > 5)
      .sort((a, b) => Math.abs(a.d - TARGET_DISTANCE) - Math.abs(b.d - TARGET_DISTANCE));
    if (candidates.length === 0) fail("nothing in view to walk toward");

    let arrived = false;
    for (const { obj, d } of candidates.slice(0, 4)) {
      const p = obj.position!.value;
      // Stop ~4y short of the creature: its own footprint is not walkable.
      const travel = Math.min(TARGET_DISTANCE, d - 4);
      const t = travel / d;
      const dest = {
        x: from.x + (p.x - from.x) * t,
        y: from.y + (p.y - from.y) * t,
        z: from.z + (p.z - from.z) * t,
      };
      log(
        `move_to (${dest.x.toFixed(1)}, ${dest.y.toFixed(1)}, ${dest.z.toFixed(1)}) — ` +
          `${travel.toFixed(1)}y toward ${obj.name?.value}`,
      );
      const result = await client.moveTo(dest, { timeout: 90_000 });
      log(
        `WB_MOVE_RESULT moveId=${result.moveId} status=${result.status} ` +
          `server-confirmed pos=(${result.position.x.toFixed(1)}, ${result.position.y.toFixed(1)}, ` +
          `${result.position.z.toFixed(1)}) @seq ${result.seq}`,
      );
      if (result.ok) {
        const moved = distance(from, result.position);
        log(`arrived: ${moved.toFixed(1)}y from where we started`);
        const cached = client.state.self.position;
        if (!cached) fail("cache lost our position");
        log(
          `state.self.position now (${cached.value.x.toFixed(1)}, ${cached.value.y.toFixed(1)}, ` +
            `${cached.value.z.toFixed(1)}) @seq ${cached.seq} — from the move events, not the login`,
        );
        if (distance(cached.value, result.position) > 0.01) {
          fail("cache position disagrees with the server-confirmed result");
        }
        arrived = true;
        break;
      }
      log(`not walkable (${result.status}); trying the next candidate`);
    }
    if (!arrived) fail("no candidate destination was reachable");

    // 3. What is nearest now, named and typed straight out of the cache.
    const here = client.state.self.position?.value;
    const closest = client.state.closest((o) => o.objectType?.value === "unit" && o.name !== undefined);
    if (!closest) fail("no named creature in view after the move");
    log(`closest creature: ${describe(closest, here)}`);
    log(`face it: ${JSON.stringify(await client.face({ x: closest.position!.value.x, y: closest.position!.value.y }))}`);

    if (client.state.gaps.length > 0) fail(`stream had gaps: ${JSON.stringify(client.state.gaps)}`);
    if (client.state.anomalies.length > 0) {
      fail(`cache recorded anomalies: ${JSON.stringify(client.state.anomalies)}`);
    }
    log(
      `cache summary: ${client.state.eventCount} events, lastSeq=${client.state.lastSeq}, ` +
        `nearby=${client.state.nearby.size}, names=${client.state.names.size}, ` +
        `creatures=${client.state.creatures.size}`,
    );
  } finally {
    try {
      log(`logged out: ${JSON.stringify(await client.logout())}`);
    } catch (e) {
      if (e instanceof WrathRequestError) log(`logout rejected: ${e.code}`);
      else throw e;
    }
    client.close();
  }

  log("PASS: session -> observed world -> server-confirmed move -> closest creature -> logout");
  process.exit(0);
}

main().catch((e: unknown) => fail(String((e as Error)?.stack ?? e)));
