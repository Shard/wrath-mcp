/**
 * The `path_incomplete` hint names where the mesh's route ends in three
 * dimensions. By the Deadmines entrance an end 0.4y from its target in 2D
 * was on the hillside 23y over it, and an x,y-only hint read as a near miss.
 * The height clause rides only past MESH_Z_QUOTE_BAND, the band that already
 * tells a stale z from a different level.
 */
import { describe, expect, test } from "bun:test";
import { heightGap, MESH_Z_QUOTE_BAND, MOVE_HINTS } from "../src/client";

const pos = { x: 0, y: 0, z: 0, o: 0, map: 0 };
const hint = (target: { x: number; y: number; z: number }, reachedPos?: { x: number; y: number; z: number }) =>
  MOVE_HINTS.path_incomplete!(target, { pos, reachedPos } as never);

describe("path_incomplete hint", () => {
  test("the Deadmines case reads as the operator approved it", () => {
    expect(hint({ x: -11161.3, y: 1644.3, z: 29.1 }, { x: -11161.1, y: 1644.7, z: 51.8 })).toBe(
      "the walkable mesh has no continuous route to (-11161.3, 1644.3); it ends at (-11161.1, 1644.7, z 51.8), " +
        "23y above the point asked for. The module already tried one subdivision. Route around (a road, a ramp, " +
        "a door) or approach from another side.",
    );
  });

  test("an end a level down says below", () => {
    expect(hint({ x: 1, y: 2, z: 40 }, { x: 3, y: 4, z: 30 })).toContain("ends at (3.0, 4.0, z 30.0), 10y below the point asked for. ");
  });

  test("a gap within the band names the z and no clause", () => {
    expect(hint({ x: 1, y: 2, z: 30 }, { x: 3, y: 4, z: 30 + MESH_Z_QUOTE_BAND })).toContain("ends at (3.0, 4.0, z 33.0). The module");
    expect(heightGap(-MESH_Z_QUOTE_BAND)).toBe("");
    expect(heightGap(MESH_Z_QUOTE_BAND + 0.1)).toBe(", 3y above the point asked for");
  });

  test("no reachedPos, no end named", () => {
    expect(hint({ x: 1, y: 2, z: 3 })).toBe(
      "the walkable mesh has no continuous route to (1.0, 2.0). The module already tried one subdivision. " +
        "Route around (a road, a ramp, a door) or approach from another side.",
    );
  });
});
