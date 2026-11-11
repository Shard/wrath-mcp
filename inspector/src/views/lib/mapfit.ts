/**
 * When the map's camera moves on its own: the fit.
 *
 * Fitting is deliberate, not reactive. The view is fitted on a few occasions
 * only: the first map to appear, a track load, a chip click, a replay's
 * cursor crossing to another continent, and a pick from the sidebar's live
 * list, which frames that one character. It never refits on a mere change of
 * `activeMap`, because an unrelated agent logging out can flip which map is
 * busiest, and yanking a panned view out from under an operator for that would
 * be hostile. So a fit is asked for and then made once someone stands on the
 * active map. Asked for with nobody there, it waits for the feed to bring
 * someone.
 *
 * The ask is a plain flag rather than a signal, and that is why `askNow`
 * exists. An ask made from an effect can come after the fit effect has
 * already run for the very change that prompted it, and nothing then wakes
 * the fit effect again. That is what a replay's cursor crossing a continent
 * did. `cursorMap` subscribes to the feed only once a track exists, so it
 * sits behind the fit effect among the feed's observers, and the fit ran
 * first, with nothing asked. The camera then stayed on the old continent's
 * coordinates over the new continent's tiles (open sea, no pip) until some
 * unrelated feed change. Over an API that came within a poll, when the tail
 * grew. On a published feed, whose tail is fixed until the next publish, a
 * replay paused at its end stayed blank for minutes. A crossing or a chip
 * click therefore fits on the spot, from the graph as it stands. An ask
 * that should wait, such as a load whose trace has not arrived, uses `ask`.
 */

import { type Accessor, createEffect, on, untrack } from "solid-js";

/** Anything the map places; the fit needs nothing more than where and on which map. */
export interface Fittable {
  map: number;
  x: number;
  y: number;
}

export interface MapFitSources<P extends Fittable> {
  activeMap: Accessor<number>;
  /** The feed on screen, live or replayed. */
  feed: Accessor<readonly P[]>;
  /** In replay, the map the cursor stands on; null when live (`createMapState`). */
  cursorMap: Accessor<number | null>;
  /** Frame the camera on these: everyone on the active map, never an empty list. */
  fit: (here: readonly Fittable[]) => void;
  /**
   * The cursor has moved to another map, just before the camera follows it.
   * The page lets go of its pinned chip here, since the character is no
   * longer on the map the reader pinned.
   */
  onCross?: (map: number) => void;
}

export interface MapFit {
  /** Ask for a fit, made the next time the feed or the active map changes with someone on it. */
  ask: () => void;
  /** Ask for a fit and make it now, if someone already stands on the active map. */
  askNow: () => void;
  /** Whether an ask is still waiting for someone to fit to. */
  pending: () => boolean;
  /**
   * Frame one character now, the reader having picked it from the live list,
   * and drop any ask still waiting, so it cannot take the view back when
   * someone else arrives. The caller puts the character's map on screen first.
   */
  focus: (target: Fittable) => void;
}

/**
 * The fit, wired to the map's graph: an effect that makes a fit asked for once
 * someone is on the active map, and one that follows a replay's cursor across
 * continents. Pending from the start, so the first map to appear is fitted.
 * Call it under the page's owner.
 */
export function createMapFit<P extends Fittable>(src: MapFitSources<P>): MapFit {
  let pending = true;
  const attempt = (map: number, list: readonly P[]): void => {
    if (!pending) return;
    const here = list.filter((p) => p.map === map);
    if (here.length === 0) return;
    pending = false;
    src.fit(here);
  };
  const fit: MapFit = {
    ask: () => {
      pending = true;
    },
    askNow: () => {
      pending = true;
      untrack(() => attempt(src.activeMap(), src.feed()));
    },
    pending: () => pending,
    focus: (target) => {
      pending = false;
      src.fit([target]);
    },
  };

  /*
   * Following the cursor across a continent is the honest behaviour: the
   * character is not on the map the reader was looking at any more, so a
   * pinned chip stops applying and the view refits. Terminates: `cursorMap`
   * changes, `onCross` may write the pin, and `activeMap` recomputes from it
   * without writing anything.
   */
  createEffect(
    on(src.cursorMap, (map) => {
      if (map === null) return;
      src.onCross?.(map);
      fit.askNow();
    }),
  );
  createEffect(() => attempt(src.activeMap(), src.feed()));
  return fit;
}
