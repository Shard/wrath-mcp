/**
 * `useItem`'s glyph slot: the index a client's glyph frame sends with a glyph
 * rides `use_item` as `glyphSlot`, checked against the six slots before
 * anything is sent. Frames are the shared fixtures; nothing here is game data.
 */
import { describe, expect, test } from "bun:test";

import { connect } from "../src/client";
import { BACKPACK_SLOT, creatureCreate, creatureQuery, frames, inventorySlot, itemCreate, itemQuery, loginSequence, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
  return client;
}

const carried = () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, inventorySlot, itemCreate, itemQuery]);

describe("useItem glyphSlot", () => {
  test("the chosen slot rides use_item; without one the body carries none", async () => {
    const stub = startStub({ onConnect: () => carried() });
    const client = await inWorld(stub);
    await client.useItem(255, BACKPACK_SLOT, undefined, { glyphSlot: 3 });
    expect(stub.actions.at(-1)).toMatchObject({ action: "use_item", bag: 255, slot: BACKPACK_SLOT, glyphSlot: 3 });
    await client.useItem("Gritstone Charm");
    expect(stub.actions.at(-1)).not.toHaveProperty("glyphSlot");
    client.close();
    await stub.stop();
  });

  test("a slot outside 0-5 throws before anything is sent", async () => {
    const stub = startStub({ onConnect: () => carried() });
    const client = await inWorld(stub);
    const before = stub.actions.length;
    for (const bad of [6, -1, 1.5, Number.NaN]) {
      expect(() => client.useItem(255, BACKPACK_SLOT, undefined, { glyphSlot: bad })).toThrow(/glyphSlot is a glyph slot 0-5/);
    }
    expect(stub.actions.length).toBe(before);
    client.close();
    await stub.stop();
  });
});
