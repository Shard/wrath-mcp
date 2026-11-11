/**
 * Wowhead's tooltip script is a third-party request, so the views ask for it
 * only when the page turned it on (`enableWowhead`); otherwise the panels go
 * straight to the record's names.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { enableWowhead, loadWowhead, resetWowheadStatus, wowheadEnabled, wowheadStatus } from "../../src/views/lib/wowhead";

/** Just enough of a document for `loadWowhead`: the tags it appended. */
function fakeHost(): { host: { document: Document; whTooltips?: unknown }; added: { src: string }[] } {
  const added: { src: string }[] = [];
  const document = {
    querySelector: (sel: string) => added.find((t) => sel.includes(t.src)) ?? null,
    createElement: () => ({ src: "" }),
    head: { appendChild: (el: { src: string }) => added.push(el) },
  } as unknown as Document;
  return { host: { document }, added };
}

afterEach(() => {
  enableWowhead(false);
  resetWowheadStatus();
});

describe("Wowhead is opt-in", () => {
  test("off by default: no tag, no config, and the panels hear failed at once", () => {
    resetWowheadStatus();
    expect(wowheadEnabled()).toBe(false);
    const { host, added } = fakeHost();
    expect(loadWowhead(host)).toBe(false);
    expect(added).toEqual([]);
    expect(host.whTooltips).toBeUndefined();
    expect(wowheadStatus()).toBe("failed");
  });

  test("turned on, the script is asked for once", () => {
    resetWowheadStatus();
    enableWowhead();
    const { host, added } = fakeHost();
    expect(loadWowhead(host)).toBe(true);
    expect(loadWowhead(host)).toBe(false);
    expect(added.map((t) => t.src)).toEqual(["https://wow.zamimg.com/js/tooltips.js"]);
    expect(wowheadStatus()).toBe("pending");
  });
});
