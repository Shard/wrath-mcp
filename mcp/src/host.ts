/**
 * One host of the stack's own tools: a confined sandbox, its scratchpad and
 * client cache, the session record, the roster at fan-out above 1, the
 * program when one is asked for, and the tool list a client is served over
 * them. `main.ts` serves one over stdio; a hosted gateway opens one per
 * credential (`hosted/gateway.ts`). Both build it here, so a client of
 * either is served the same tools, in the same order, with the same text.
 *
 * The host never learns who drives it. It takes its leases through a
 * `Leaser` (the port secret's own unless it is handed another), stamps
 * `owner` on its session records when told one, and keeps everything in the
 * state directory and session store it is given.
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CharacterRoster, fanoutTools, PLAIN_FANOUT_RENDER, type FanoutGrant, type FanoutToolContext, type RosterEntry } from "./fanout";
import { compactJson } from "./jsonsafe";
import { leaseRedacted, moduleAuthHeaders, moduleIdentity, portSecretLeaser, tokenFingerprint, type Leaser } from "./module-auth";
import { ownGuidIndex } from "./record/gate";
import { pruneSessions } from "./record/retention";
import { SessionStore } from "./record/store";
import { SessionWriter } from "./record/writer";
import { SecretRedactor } from "./redact";
import { CLIENT_CACHE_FILE, ClientCacheStore } from "./sandbox/client-cache";
import { SandboxHost } from "./sandbox/host";
import type { EventSummary } from "./sandbox/ipc";
import { Scratchpad } from "./scratchpad";
import type { ToolHost } from "./server";
import { coreTools, programTools, ToolSet, type CoreToolContext, type CoreToolRender, type ProgramToolContext, type ToolDef, type ToolResult, type ToolSpec } from "./tools";
import { MCP_PACKAGE_VERSION } from "./version";
import { Workspace } from "./workspace";

/**
 * Ambient motion, out-of-sight party frames, threat list updates and world
 * state changes: folded out of `recent_events` unless asked for, as its fold
 * note says. The state cache keeps them all.
 */
const AMBIENT = /^(SMSG_MONSTER_MOVE|MSG_MOVE_|SMSG_PARTY_MEMBER_STATS|SMSG_THREAT_UPDATE|SMSG_HIGHEST_THREAT_UPDATE|SMSG_UPDATE_WORLD_STATE)/;

/** The bare stack's rendering: one event per line, and the snapshot's own fields as JSON. */
export const PLAIN_RENDER: CoreToolRender<CoreToolContext> = {
  eventLine: (e: EventSummary) =>
    `${e.opcode === "stream_gap" ? "#gap" : `#${e.seq}`} ${e.opcode}${e.schemaError !== undefined ? " [schema mismatch]" : ""} ${compactJson(e.data, 220)}${e.note !== undefined ? ` — ${e.note}` : ""}`,
  isAmbient: (opcode) => AMBIENT.test(opcode),
  stateSummary: (snapshot, o) =>
    JSON.stringify({
      sessionLive: o.sessionLive,
      self: snapshot["self"],
      xp: snapshot["xp"],
      money: snapshot["money"],
      questLog: snapshot["questLog"],
      eventCount: snapshot["eventCount"],
      lastSeq: snapshot["lastSeq"],
      observation: snapshot["observation"],
      move: snapshot["move"],
    }),
};

/**
 * `result` with the sandbox's pending notices at its foot — a restart and the
 * state it lost, a background fault — scrubbed like the result. A harness
 * puts these in its own turn context; the bare stack has no turns, so the
 * next tool result is where the agent hears of them.
 */
export function withNotices(
  sandbox: Pick<SandboxHost, "drainNotices">,
  secrets: { scrub(text: string): string },
  result: ToolResult,
): ToolResult {
  const notices = sandbox.drainNotices();
  if (notices.length === 0) return result;
  const block = ["--- notices ---", ...notices.map((n) => `${n.kind}: ${n.text}`)].join("\n");
  return { ...result, text: secrets.scrub(`${result.text}\n${block}`) };
}

/** Which tools a host serves: a function of its grant and the program opt-in, fixed for its life. */
export interface HostSurface {
  /** Fan-out above 1. */
  fanout: boolean;
  /** The model's program: files, routines, and `run_snippet` as a one-off. */
  program: boolean;
}

/** One context type over every surface: a single-character host's lacks `fanout` and a snippet host's `program`, and no tool it serves reads them. */
type HostToolContext = FanoutToolContext & ProgramToolContext;

/**
 * The tools a host serves, in the order it serves them.
 *
 * - The core five; at fan-out above 1 the three that act on a character
 *   take `character`, and `login_character`, `logout_character` and
 *   `list_characters` follow.
 * - With a program, `run_snippet` is the program's one-off, the file and
 *   routine tools follow it, and the other four core tools come after them;
 *   at fan-out the routine tools take `character` too.
 */
export function hostToolSpecs(s: HostSurface): ToolSpec<HostToolContext>[] {
  const render = PLAIN_RENDER as CoreToolRender<HostToolContext>;
  const core = coreTools(render);
  const fan = s.fanout ? fanoutTools<HostToolContext>(render, PLAIN_FANOUT_RENDER, { program: s.program }) : undefined;
  const logins = fan !== undefined ? [fan.login_character, fan.logout_character, fan.list_characters] : [];
  if (!s.program) {
    const c = fan ?? core;
    return [c.run_snippet, c.recent_events, c.state_summary, c.write_scratchpad, c.edit_scratchpad, ...logins];
  }
  const prog = programTools(render, { characters: s.fanout });
  return [
    fan?.run_snippet ?? prog.run_snippet,
    prog.read_file,
    prog.write_file,
    prog.edit_file,
    prog.delete_file,
    prog.start_routine,
    prog.stop_routine,
    (fan ?? core).recent_events,
    (fan ?? core).state_summary,
    core.write_scratchpad,
    core.edit_scratchpad,
    ...logins,
  ];
}

/** The tool definitions a host of this surface lists. */
export function hostToolDefs(s: HostSurface): ToolDef[] {
  return new ToolSet(hostToolSpecs(s)).defs;
}

export interface HostOptions {
  moduleUrl: string;
  /** The state directory: scratchpad, client cache, roster and program live in it. Created by the caller, mode 0700. */
  dir: string;
  /**
   * The single character's session token; at fan-out above 1 the client's
   * own, which is never leased and whose fingerprint is every one of its
   * session records' `group`.
   */
  token: string;
  /** The single character's account. */
  account?: string | undefined;
  /** The GM opt-in for the single character's lease. A fan-out grant carries its own. */
  allowGm?: boolean;
  /** Fan-out above 1, or null for the single-character host. */
  grant: FanoutGrant | null;
  program: boolean;
  /** Where the sessions are recorded and for how long, or null to record nothing. */
  record: { root: string; retentionMs: number } | null;
  /** `session.json`'s `owner` on every record this host writes. */
  owner?: string | undefined;
  /** How leases are taken and given back; absent, with the port secret in the environment. */
  leaser?: Leaser;
  /** Where the host's own lines go (stderr for the standalone server). */
  log: (line: string) => void;
  /** A snippet's output, which the standalone server writes to stderr. */
  logSink?: (stream: "stdout" | "stderr", text: string) => void;
  snippetTimeoutMs?: number;
}

export interface OpenedHost {
  /** The tools, as an MCP server serves them: the list, and a call with the sandbox's notices at its foot. */
  readonly tools: ToolHost;
  readonly surface: HostSurface;
  /** Where the single character's record is written, or the store each character's is written in; undefined when nothing is recorded. */
  readonly recordedIn: string | undefined;
  /** At fan-out, bring back the characters that were logged in when the state directory was last used; one that does not come back is logged. A single-character host has nothing to bring back. */
  resume(): Promise<void>;
  readonly sandbox: SandboxHost;
  /**
   * The clean exit, once however many ways it is asked for: stop the
   * sandbox and close every record, each bounded; with `logout`, log every
   * character out and give its lease back through the leaser, so a wedged
   * child cannot hold one in the world.
   */
  shutdown(o?: { logout: boolean }): Promise<void>;
}

/**
 * Open a host: lease (the single character's, now; at fan-out, each as it
 * logs in), open the record, and build the sandbox and the tools. Nothing
 * starts the child before the first call or `resume`.
 */
export async function openHost(o: HostOptions): Promise<OpenedHost> {
  return o.grant !== null ? openFanoutHost(o, o.grant) : openSingleHost(o);
}

function toolHost(tools: ToolSet<HostToolContext>, ctx: HostToolContext, sandbox: SandboxHost, secrets: SecretRedactor): ToolHost {
  return {
    list: () => tools.defs,
    coerce: (name, raw) => tools.coerce(name, raw),
    call: async (name, args, origin) => withNotices(sandbox, secrets, await tools.call(ctx, name, args, origin)),
    appendPending: async (result) => withNotices(sandbox, secrets, await tools.appendPending(ctx, result)),
  };
}

function programOption(o: HostOptions): { program: { workspace: Workspace } } | Record<string, never> {
  return o.program ? { program: { workspace: new Workspace(join(o.dir, "program")) } } : {};
}

async function openSingleHost(o: HostOptions): Promise<OpenedHost> {
  const { moduleUrl, token, account, dir } = o;
  const allowGm = o.allowGm === true;
  const secrets = new SecretRedactor();
  const leaser = o.leaser ?? portSecretLeaser({ moduleUrl });
  // The opt-in rides the lease, which only the host can take: the child's
  // creates inherit it, and nothing a snippet sends can raise it.
  const lease = await leaseRedacted(leaser, { token, ...(account !== undefined ? { account } : {}), ...(allowGm ? { allowGm } : {}) }, secrets);
  if (lease.secret === undefined) o.log(lease.note);
  else if (allowGm && !lease.allowGm) o.log("--allow-gm: the module did not confirm the GM opt-in (it predates it), so it serves player use only");
  else if (allowGm) o.log("GM opt-in on: the module serves a GM account and passes command chat for this session");

  // The session record: in the store, named by the token's fingerprint and never by the token.
  let record: SessionWriter | undefined;
  if (o.record !== null) {
    const store = new SessionStore(o.record.root);
    const id = tokenFingerprint(token);
    const pruned = pruneSessions(store, o.record.retentionMs, { except: id });
    if (pruned.length > 0) o.log(`removed ${pruned.length} session record(s) past retention from ${o.record.root}`);
    record = new SessionWriter({ dir: store.sessionDir(id), id, stack: { version: MCP_PACKAGE_VERSION }, own: ownGuidIndex(() => store.dirs()), scrub: (text) => secrets.scrub(text), token, ...(o.owner !== undefined ? { owner: o.owner } : {}) });
    record.open();
    const writer = record;
    void moduleIdentity(moduleUrl, moduleAuthHeaders()).then((m) => writer.setModule(m));
  }

  const scratchpad = new Scratchpad(join(dir, "scratchpad.md"));
  const clientCache = new ClientCacheStore(join(dir, CLIENT_CACHE_FILE));
  const sandbox = new SandboxHost({
    moduleUrl,
    token,
    ...(lease.secret !== undefined ? { secret: lease.secret } : {}),
    ...(account !== undefined ? { account } : {}),
    scratchpad,
    snippetTimeoutMs: o.snippetTimeoutMs ?? 30_000,
    pingGraceMs: 5_000,
    clientCache,
    ...(record !== undefined ? { record: { writer: record } } : {}),
    ...programOption(o),
    // Scrubbed like everything else the host writes: a crash notice quotes the child's stderr, and the child holds the lease secret.
    onNotice: (n) => o.log(secrets.scrub(`${n.kind}: ${n.text}`)),
    ...(o.logSink !== undefined ? { logSink: o.logSink } : {}),
  });
  const ctx = {
    sandbox,
    scratchpad,
    sessionLive: () => true,
    turn: () => 0,
    secrets,
    ...(record !== undefined ? { record } : {}),
    ...(sandbox.program !== undefined ? { program: sandbox.program } : {}),
  } as unknown as HostToolContext;
  const surface = { fanout: false, program: o.program };
  let done: Promise<void> | undefined;
  return {
    tools: toolHost(new ToolSet(hostToolSpecs(surface)), ctx, sandbox, secrets),
    surface,
    sandbox,
    recordedIn: record?.dir,
    resume: async () => {},
    shutdown: (s = { logout: true }) =>
      (done ??= (async () => {
        await Promise.race([sandbox.stop().catch(() => {}), Bun.sleep(5_000)]);
        clientCache.flush();
        if (record !== undefined) await Promise.race([record.close().catch(() => {}), Bun.sleep(5_000)]);
        if (s.logout) {
          await leaser.logout(token);
          await leaser.release(token);
        }
      })()),
  };
}

/** The file in the state directory that keeps where each character lives, at fan-out above 1. Mode 0600: it holds tokens. */
export const ROSTER_FILE = "roster.json";

/** The entries a state directory's roster file holds; none when it has no file or one that does not read. */
export function readRoster(path: string): RosterEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is RosterEntry =>
        e !== null && typeof e === "object" && typeof (e as RosterEntry).character === "string" && typeof (e as RosterEntry).account === "string" && typeof (e as RosterEntry).token === "string",
    ).map((e) => ({ character: e.character, account: e.account, token: e.token, in: e.in === true }));
  } catch {
    return [];
  }
}

/** Write the roster file whole, 0600, by rename, so a reader never sees half and never a looser mode. */
export function writeRoster(path: string, entries: readonly RosterEntry[]): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

async function openFanoutHost(o: HostOptions, grant: FanoutGrant): Promise<OpenedHost> {
  const { moduleUrl, dir } = o;
  const secrets = new SecretRedactor();
  const group = tokenFingerprint(o.token);
  const rosterPath = join(dir, ROSTER_FILE);
  const known = readRoster(rosterPath);

  const store = o.record !== null ? new SessionStore(o.record.root) : null;
  if (store !== null && o.record !== null) {
    const pruned = pruneSessions(store, o.record.retentionMs);
    if (pruned.length > 0) o.log(`removed ${pruned.length} session record(s) past retention from ${o.record.root}`);
  }
  const module = store !== null ? moduleIdentity(moduleUrl, moduleAuthHeaders()) : null;

  const scratchpad = new Scratchpad(join(dir, "scratchpad.md"));
  const clientCache = new ClientCacheStore(join(dir, CLIENT_CACHE_FILE));
  const sandbox = new SandboxHost({
    moduleUrl,
    token: "",
    scratchpad,
    snippetTimeoutMs: o.snippetTimeoutMs ?? 30_000,
    pingGraceMs: 5_000,
    clientCache,
    fanout: { maxCharacters: grant.maxCharacters },
    ...(store !== null ? { record: {} } : {}),
    ...programOption(o),
    onNotice: (n) => o.log(secrets.scrub(`${n.kind}: ${n.text}`)),
    ...(o.logSink !== undefined ? { logSink: o.logSink } : {}),
  });
  const roster: CharacterRoster = new CharacterRoster({
    grant,
    moduleUrl,
    sandbox,
    secrets,
    known,
    ...(o.leaser !== undefined ? { leaser: o.leaser } : {}),
    onChange: (entries) => writeRoster(rosterPath, entries),
    ...(store !== null
      ? {
          record: (seat) => {
            const id = tokenFingerprint(seat.token);
            const writer = new SessionWriter({ dir: store.sessionDir(id), id, stack: { version: MCP_PACKAGE_VERSION }, group, own: ownGuidIndex(() => store.dirs()), scrub: (text) => roster.scrubTokens(secrets.scrub(text)), token: seat.token, ...(o.owner !== undefined ? { owner: o.owner } : {}) });
            writer.open();
            void module?.then((m) => writer.setModule(m));
            return writer;
          },
        }
      : {}),
  });
  const ctx = {
    sandbox,
    scratchpad,
    sessionLive: () => true,
    turn: () => 0,
    secrets,
    fanout: roster,
    ...(store !== null ? { record: roster.calls } : {}),
    ...(sandbox.program !== undefined ? { program: sandbox.program } : {}),
  } as unknown as HostToolContext;
  const surface = { fanout: true, program: o.program };
  let done: Promise<void> | undefined;
  return {
    tools: toolHost(new ToolSet(hostToolSpecs(surface)), ctx, sandbox, secrets),
    surface,
    sandbox,
    recordedIn: o.record?.root,
    resume: async () => {
      for (const f of await roster.resume()) o.log(secrets.scrub(`${f.character} was not brought back: ${f.error}`));
    },
    shutdown: (s = { logout: true }) =>
      (done ??= (async () => {
        await Promise.race([sandbox.stop().catch(() => {}), Bun.sleep(5_000)]);
        clientCache.flush();
        await Promise.race([roster.shutdown({ logout: s.logout }).catch(() => {}), Bun.sleep(5_000 + 1_000 * grant.maxCharacters)]);
      })()),
  };
}
