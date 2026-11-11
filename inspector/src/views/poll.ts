/**
 * A value read now and every `ms` after, as a Solid signal, until its owner
 * is disposed. A read that throws keeps the last value and hands the error to
 * `onError`. Polling stops while the tab is hidden and reads again on return.
 */

import { createSignal, onCleanup, type Accessor } from "solid-js";

export function poll<T>(read: () => Promise<T>, ms: number, o: { initial?: T; onError?: (err: unknown) => void } = {}): { value: Accessor<T | undefined>; refresh: () => void } {
  const [value, setValue] = createSignal<T | undefined>(o.initial);
  let stopped = false;
  let busy = false;
  const tick = async (): Promise<void> => {
    if (stopped || busy || (typeof document !== "undefined" && document.hidden)) return;
    busy = true;
    try {
      const v = await read();
      if (!stopped) setValue(() => v);
    } catch (err) {
      o.onError?.(err);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = ms > 0 ? setInterval(() => void tick(), ms) : undefined;
  const onVisible = (): void => void tick();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  });
  return { value, refresh: () => void tick() };
}
