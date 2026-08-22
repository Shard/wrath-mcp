/**
 * The Stage-2 vertical slice, driven entirely through the SDK.
 *
 * This is the same ground infra/smoke/module-slice.ts covers, but where the
 * probe pokes the wire by hand, this asserts the SDK's own surface: `connect`
 * opens the event stream, `createSession` seeds the state cache,
 * `waitForChat` reads the echo back off the stream, and the cache — which was
 * never told anything except events plus the session seed — agrees.
 *
 * Not part of `bun test`: it needs a booted worldserver. Run it from inside the
 * compose network:
 *
 *   docker compose -f infra/compose.yml exec runner bun sdk/examples/live-slice.ts
 *
 * Override the target with MODULE_HOST / MODULE_PORT (default worldserver:8086).
 */

import { randomBytes } from "node:crypto";
import { connect, WrathRequestError } from "../src/index";

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
// The token is per-session, so it must be unique: a leaked one comes back as
// `token_in_use`. It must also be at least 32 chars or the module rejects it
// with `weak_token`, so it is random hex, not a timestamp. The *character* is
// deliberately stable — `POST /session` is create-or-reuse, so a fixed name
// makes re-runs idempotent instead of leaving a new saved character on the
// account every time (the realm caps them, and Phase 0 has no delete-character
// action). It also exercises the reuse branch.
const TOKEN = `sdk-slice-${randomBytes(16).toString("hex")}`;
const CHARACTER = process.env.SLICE_CHARACTER ?? "Benchslice";
const SAY_TEXT = "hello from the sdk";

function log(msg: string): void {
  console.log(`[live-slice] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[live-slice] FAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // 1. Connect. This opens the event subscription before any session exists,
  //    which is what lets the cache see the login handshake.
  const client = await connect({ baseUrl: BASE, token: TOKEN });
  log(`subscribed to events for token ${TOKEN}`);

  const health = await client.health();
  log(`health: ${JSON.stringify(health)}`);
  if (health.worldStopped) fail("world is stopped");

  try {
    // 2. Create the character and enter the world.
    const session = await client.createSession({ character: CHARACTER, race: 1, class: 1, gender: 0 });
    log(`in world as ${session.character} (guid ${session.guid}) on account ${session.account}`);
    if (!session.inWorld) fail("session reported not in world");

    // 3. The login events arrived while the POST was blocking; waitFor searches
    //    the retained buffer, so this resolves from history.
    const verify = await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 5000 });
    log(`observed ${verify.opcode} at seq ${verify.seq}`);

    const self = client.state.self;
    if (self.position === undefined) fail("state cache has no position after login verify world");
    log(
      `state.self: guid=${self.guid} name=${self.name} level=${self.level?.value ?? "unobserved"} ` +
        `map=${self.position.value.map} pos=(${self.position.value.x.toFixed(2)}, ` +
        `${self.position.value.y.toFixed(2)}, ${self.position.value.z.toFixed(2)}) @seq ${self.position.seq}`,
    );
    log(`state.characters: ${client.state.characters?.value.map((c) => `${c.name}(${c.level})`).join(", ")}`);
    // The observation contract in action: nothing on the wire carries these.
    log(`state.self.health=${String(self.health)} state.nearby.size=${client.state.nearby.size}`);

    // 4. Say, then read the echo back off the stream.
    const sinceSeq = client.state.lastSeq + 1;
    const ack = await client.say(SAY_TEXT);
    log(`say acked: ${JSON.stringify(ack)}`);

    const chat = await client.waitForChat(SAY_TEXT, { timeout: 5000, sinceSeq });
    log(`chat echo: seq=${chat.seq} type=${chat.type} sender=${chat.senderGuid} msg="${chat.message}"`);
    if (chat.senderGuid !== session.guid) {
      fail(`chat sender ${chat.senderGuid} is not self ${session.guid}`);
    }
    if (client.state.chat.at(-1)?.message !== SAY_TEXT) fail("chat tail did not record the echo");

    if (client.state.gaps.length > 0) fail(`stream had gaps: ${JSON.stringify(client.state.gaps)}`);

    log(
      `cache summary: ${client.state.eventCount} events, lastSeq=${client.state.lastSeq}, ` +
        `chat=${client.state.chat.length}, notifications=${client.state.notifications.length}`,
    );
  } finally {
    // Always release the token: a leaked one comes back as 409 token_in_use.
    try {
      const bye = await client.logout();
      log(`logged out: ${JSON.stringify(bye)}`);
    } catch (e) {
      if (e instanceof WrathRequestError) log(`logout rejected: ${e.code}`);
      else throw e;
    }
    client.close();
  }

  log("PASS: connect -> session -> say -> chat event -> logout, all through the SDK");
  process.exit(0);
}

main().catch((e: unknown) => fail(String((e as Error)?.stack ?? e)));
