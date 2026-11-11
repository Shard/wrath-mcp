/**
 * The bin's page: the live map with every session beside it, and a page per
 * session (`#/session/<id>`). Off loopback, a 401 from the API is answered
 * with the sign-in, which sets the cookie every later request carries.
 */

import { Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { LiveMap, SessionList, SessionView, Unauthorized, createInspectorClient, poll } from "../src/views";
import { enableWowhead } from "../src/views/lib/wowhead";
import "../src/views/inspector.css";

// Wowhead's tooltip script only when the bin was started with `--wowhead` (`src/serve.ts`).
if (document.querySelector('meta[name="wrath-inspector-wowhead"]') !== null) enableWowhead();

const client = createInspectorClient("/api");
const href = (id: string): string => `#/session/${encodeURIComponent(id)}`;

function route(): { session: string | null } {
  const m = /^#\/session\/([^/]+)$/.exec(location.hash);
  return { session: m === null ? null : decodeURIComponent(m[1]!) };
}

function SignIn(props: { done: () => void }) {
  const [secret, setSecret] = createSignal("");
  const [refused, setRefused] = createSignal(false);
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (await client.signIn(secret())) props.done();
    else setRefused(true);
  };
  return (
    <form class="page" onSubmit={(e) => void submit(e)}>
      <input type="password" autocomplete="current-password" placeholder="secret" aria-label="secret" value={secret()} onInput={(e) => setSecret(e.currentTarget.value)} />{" "}
      <button type="submit">sign in</button>
      <Show when={refused()}>
        {" "}
        <span class="err">refused</span>
      </Show>
    </form>
  );
}

function App() {
  const [where, setWhere] = createSignal(route());
  const onHash = (): void => {
    setWhere(route());
  };
  window.addEventListener("hashchange", onHash);
  onCleanup(() => window.removeEventListener("hashchange", onHash));
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1_000);
  onCleanup(() => clearInterval(clock));
  const [locked, setLocked] = createSignal(false);
  const list = poll(() => client.sessions(), 5_000, { onError: (err) => setLocked(err instanceof Unauthorized) });
  const sessions = () => list.value() ?? [];
  const [selected, setSelected] = createSignal<string | null>(null);
  const current = createMemo(() => {
    const id = where().session;
    return id === null ? null : (sessions().find((s) => s.id === id) ?? null);
  });
  return (
    <div class="app">
      <header class="top">
        <a class="wordmark" href="#/">
          wrath-inspector
        </a>
        <span class="dim">{sessions().length}</span>
      </header>
      <Switch>
        <Match when={locked()}>
          <SignIn
            done={() => {
              setLocked(false);
              list.refresh();
            }}
          />
        </Match>
        <Match when={where().session !== null}>
          <main>
            <Show when={current()} fallback={<p class="page dim">no such session</p>}>
              {(s) => <SessionView client={client} summary={s()} sessions={sessions()} now={now()} href={href} />}
            </Show>
          </main>
        </Match>
        <Match when={true}>
          <main class="flush">
            <div class="map-wrap">
              <LiveMap sessions={sessions()} now={now()} selected={selected()} onSelect={setSelected} nearby={client.nearby} tilesBase="/tiles" />
              <div class="side">
                <SessionList sessions={sessions()} now={now()} href={href} selected={selected()} onSelect={setSelected} />
              </div>
            </div>
          </main>
        </Match>
      </Switch>
    </div>
  );
}

render(() => <App />, document.getElementById("root")!);
