import { describe, expect, test } from "bun:test";
import { cardPlacement } from "../../src/views/lib/popover";

describe("cardPlacement", () => {
  const frame = { l: 0, t: 0, r: 600, b: 300 };
  const card = { w: 200, h: 100 };

  test("right of the point, centred on it, when there is room", () => {
    expect(cardPlacement({ x: 100, y: 150 }, card, frame)).toEqual({ left: 110, top: 100 });
  });

  test("flipped left near the right edge, and held inside top and bottom", () => {
    expect(cardPlacement({ x: 500, y: 150 }, card, frame)).toEqual({ left: 290, top: 100 });
    expect(cardPlacement({ x: 500, y: 10 }, card, frame)).toEqual({ left: 290, top: 0 });
    expect(cardPlacement({ x: 500, y: 295 }, card, frame)).toEqual({ left: 290, top: 200 });
  });

  test("below the point, centred on its x, when neither side has the room; above near the bottom", () => {
    const narrow = { l: 20, t: 0, r: 320, b: 300 };
    expect(cardPlacement({ x: 170, y: 50 }, card, narrow)).toEqual({ left: 70, top: 60 });
    expect(cardPlacement({ x: 170, y: 250 }, card, narrow)).toEqual({ left: 70, top: 140 });
    expect(cardPlacement({ x: 40, y: 50 }, card, { ...narrow, r: 230 })).toEqual({ left: 20, top: 60 });
  });

  test("a point off the visible frame (a chart scrolled sideways) still gets a card inside it", () => {
    expect(cardPlacement({ x: 900, y: 150 }, card, frame)).toEqual({ left: 400, top: 100 });
    expect(cardPlacement({ x: -300, y: 150 }, card, frame)).toEqual({ left: 0, top: 100 });
  });

  test("a card larger than the frame is pinned to its top-left, never placed outside it", () => {
    const tiny = { l: 10, t: 10, r: 110, b: 60 };
    const p = cardPlacement({ x: 60, y: 30 }, card, tiny);
    expect(p).toEqual({ left: 10, top: 10 });
  });
});
