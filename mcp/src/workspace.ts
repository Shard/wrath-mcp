/**
 * The program workspace: the model's own files, for a sandbox that hosts a
 * program (`SandboxHostOptions.program`). A host that does not ask for one
 * never constructs this, and the snippet sandbox is what it always was.
 *
 * One directory, written by the host process alone:
 *
 *   <dir>/files/          the files as the model reads and writes them
 *                         (`main.ts`, `lib/…`, `memory.json`)
 *   <dir>/store/<sha256>  every file content a version ever held, once
 *   <dir>/deploys/<n>/    version n of the files: hard links into `store/`
 *   <dir>/registry.json   the routine registry (`sandbox/program-host.ts`)
 *
 * The confined child is granted read access to `deploys/` and nothing else
 * here (`confine.ts`, `--read=`), so it has no write grant, and every change
 * it wants goes through the host. It imports a version's files by their plain
 * paths under `deploys/<n>/`: each version is a module graph of its own, so
 * code that is running never sees a half-edited file, a later version is
 * never served from the module cache, and the directory is the record of
 * which code was live when. `deploys/` is created once and never removed or
 * replaced: the child's read grant is bound to that inode.
 *
 * Paths are relative to the workspace and normalised; `..`, absolute paths
 * and anything that would land outside the directory are refused with the
 * path named. Limits are refusals, never truncation: a write whose result
 * would exceed a file's limit or the workspace total is refused with the size
 * it would have had, and nothing is written.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import { importCandidates, IMPORTABLE_EXTENSIONS, isImportable, MAIN_PATH, MEMORY_MAX_CHARS, MEMORY_PATH } from "./sandbox/rewrite";

export { IMPORTABLE_EXTENSIONS, isImportable, MAIN_PATH, MEMORY_MAX_CHARS, MEMORY_PATH };

/** Every file's limit, in characters. The scratchpad's cap. */
export const FILE_MAX_CHARS = 32_000;
/** The whole workspace's limit, in UTF-8 bytes on disk. */
export const WORKSPACE_MAX_BYTES = 1_048_576;

/** What the file tools answer for a write, edit or delete of memory.json. */
export const MEMORY_WRITE_REFUSAL =
  'memory.json is saved by the harness from `memory`; change it in code, e.g. `memory.phase = "grind"` in a snippet or a routine.';

export type WorkspaceResult = { ok: true; text: string } | { ok: false; error: string };

/** One file as a listing shows it. */
export interface WorkspaceEntry {
  /** Relative to the workspace, `/`-separated. */
  path: string;
  bytes: number;
}

type ResolvedPath = { ok: true; rel: string; abs: string } | { ok: false; error: string };

/** A part of a file `read_file` returns: `limit` lines from line `offset` (1-based); either absent reads from the first line or to the last. */
export interface LineRange {
  offset?: number | undefined;
  limit?: number | undefined;
}

/**
 * Lines `offset` to `offset + limit - 1` of a file's text, exactly as stored,
 * under one line saying which lines of how many they are. A final newline
 * ends the last line rather than starting one more. Pure.
 */
export function lineRange(rel: string, text: string, range: LineRange): WorkspaceResult {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const offset = range.offset ?? 1;
  if (!Number.isInteger(offset) || offset < 1) return { ok: false, error: `offset must be a whole number from 1, got ${offset}` };
  if (range.limit !== undefined && (!Number.isInteger(range.limit) || range.limit < 1)) return { ok: false, error: `limit must be a whole number from 1, got ${range.limit}` };
  if (offset > total) return { ok: false, error: `${rel} has ${total} line${total === 1 ? "" : "s"}; offset ${offset} is past its end` };
  const last = range.limit === undefined ? total : Math.min(total, offset + range.limit - 1);
  return { ok: true, text: `${rel}, lines ${offset}-${last} of ${total}:\n${lines.slice(offset - 1, last).join("\n")}` };
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Every file under a directory, sorted by path (code-unit order, so a listing is locale-free and stable). */
function listFiles(dir: string): WorkspaceEntry[] {
  const out: WorkspaceEntry[] = [];
  const walk = (absDir: string, relDir: string): void => {
    for (const d of readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir.length === 0 ? d.name : `${relDir}/${d.name}`;
      const abs = join(absDir, d.name);
      if (d.isDirectory()) walk(abs, rel);
      else if (d.isFile()) out.push({ path: rel, bytes: statSync(abs).size });
    }
  };
  walk(dir, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The transpiler loader for a workspace code file. */
function scanLoader(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "ts";
  return "js";
}

/**
 * The files an entry module's import graph depends on, as the runtime follows
 * it: every file under `root` reachable from `entry` through a relative
 * specifier, and every file whose creation would change what one of those
 * specifiers resolves to (the candidates tried before the one that exists, or
 * all of them when none does). Root-relative paths, mapped to the file's text
 * or null when it is absent; `entry` is always a key. A file that does not
 * scan (a syntax error) is a leaf, and a JSON file is never scanned. The host
 * reads it to decide whether a save changed the program.
 */
export function workspaceImportGraph(root: string, entry: string = MAIN_PATH): Map<string, string | null> {
  const base = resolve(root);
  const graph = new Map<string, string | null>();
  const queue: string[] = [];
  const note = (abs: string): boolean => {
    const rel = abs.slice(base.length + 1);
    const exists = isFile(abs);
    if (!graph.has(rel)) {
      graph.set(rel, exists ? readFileSync(abs, "utf8") : null);
      if (exists) queue.push(abs);
    }
    return exists;
  };
  note(join(base, entry));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    let specifiers: string[];
    try {
      specifiers = new Bun.Transpiler({ loader: scanLoader(file) })
        .scanImports(graph.get(file.slice(base.length + 1)) ?? "")
        .map((i) => i.path)
        .filter((p) => p.startsWith("./") || p.startsWith("../"));
    } catch {
      continue;
    }
    for (const spec of specifiers) {
      const target = resolve(dirname(file), spec);
      if (!target.startsWith(base + sep)) continue;
      for (const candidate of importCandidates(target)) if (note(candidate)) break;
    }
  }
  return graph;
}

/** Whether two import graphs hold the same files with the same text. */
export function sameImportGraph(a: ReadonlyMap<string, string | null>, b: ReadonlyMap<string, string | null>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, text] of a) if (!b.has(path) || b.get(path) !== text) return false;
  return true;
}

export class Workspace {
  /** The workspace's own directory: `files/`, `store/`, `deploys/` and the registry live in it. */
  readonly dir: string;
  /** The files as the model reads and writes them. */
  readonly filesDir: string;
  /** The versions the child imports from; the one directory it may read. */
  readonly deploysDir: string;
  private readonly storeDir: string;
  private current = 0;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.filesDir = join(this.dir, "files");
    this.deploysDir = join(this.dir, "deploys");
    this.storeDir = join(this.dir, "store");
    for (const d of [this.filesDir, this.deploysDir, this.storeDir]) mkdirSync(d, { recursive: true });
    for (const name of readdirSync(this.deploysDir)) {
      const n = Number(name);
      if (Number.isInteger(n) && n > this.current) this.current = n;
    }
  }

  /** The newest version of the files, 0 before the first. */
  get version(): number {
    return this.current;
  }

  /** Where version `n` of the files lives. */
  versionDir(n: number): string {
    return join(this.deploysDir, String(n));
  }

  /**
   * Keep the files as they stand as a new version and return its number: each
   * file's content goes into `store/` under its hash, once, and the version's
   * directory holds a hard link to it (a copy where the filesystem refuses
   * the link). memory.json is left out: it is no module, and it changes every
   * second.
   */
  snapshot(): number {
    const n = this.current + 1;
    const dir = this.versionDir(n);
    mkdirSync(dir, { recursive: true });
    for (const f of listFiles(this.filesDir)) {
      if (f.path === MEMORY_PATH) continue;
      const bytes = readFileSync(join(this.filesDir, ...f.path.split("/")));
      const blob = join(this.storeDir, createHash("sha256").update(bytes).digest("hex"));
      if (!existsSync(blob)) {
        const tmp = `${blob}.tmp`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, blob);
      }
      const dest = join(dir, ...f.path.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      try {
        linkSync(blob, dest);
      } catch {
        copyFileSync(blob, dest);
      }
    }
    this.current = n;
    return n;
  }

  /** The import graph of main.ts as the files stand now (`workspaceImportGraph`). */
  graph(): Map<string, string | null> {
    return workspaceImportGraph(this.filesDir);
  }

  /** The import graph of main.ts in version `n`. */
  graphAt(n: number): Map<string, string | null> {
    return workspaceImportGraph(this.versionDir(n));
  }

  /**
   * A model-supplied path, checked and normalised. The refusals name the path
   * as given, because that is the text the model has to fix.
   */
  resolve(path: unknown): ResolvedPath {
    if (typeof path !== "string") return { ok: false, error: `path must be a string, got ${typeof path}` };
    const shown = JSON.stringify(path);
    if (path.length === 0) return { ok: false, error: "path is empty; name a file such as main.ts or lib/combat.ts" };
    if (CONTROL_CHARS.test(path)) return { ok: false, error: `path ${shown} contains a control character` };
    if (path.includes("\\")) return { ok: false, error: `path ${shown} uses \\; the separator is /` };
    if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) {
      return { ok: false, error: `path ${shown} is absolute; paths are relative to the workspace, e.g. main.ts or lib/combat.ts` };
    }
    if (path.split("/").includes("..")) return { ok: false, error: `path ${shown} contains ..; paths stay inside the workspace` };
    if (path.endsWith("/")) return { ok: false, error: `path ${shown} names a directory, not a file` };
    const rel = posix.normalize(path).replace(/^(\.\/)+/, "");
    if (rel === "." || rel.length === 0) return { ok: false, error: `path ${shown} names the workspace itself, not a file` };
    const abs = join(this.filesDir, ...rel.split("/"));
    if (!abs.startsWith(this.filesDir + sep)) return { ok: false, error: `path ${shown} resolves outside the workspace` };
    // Nothing but this class writes here and it never makes a link in
    // `files/`, so this is belt and braces: the deepest part of the path that
    // exists must really be inside the workspace.
    let probe = abs;
    while (!existsSync(probe) && probe !== this.filesDir) probe = dirname(probe);
    try {
      const real = realpathSync(probe);
      const root = realpathSync(this.filesDir);
      if (real !== root && !real.startsWith(root + sep)) return { ok: false, error: `path ${shown} resolves outside the workspace` };
    } catch {
      return { ok: false, error: `path ${shown} could not be checked` };
    }
    return { ok: true, rel, abs };
  }

  /** Every file, sorted by path. */
  list(): WorkspaceEntry[] {
    return listFiles(this.filesDir);
  }

  /** UTF-8 bytes on disk across every file. */
  totalBytes(): number {
    return this.list().reduce((n, f) => n + f.bytes, 0);
  }

  /** One file exactly as stored, or a range of its lines (`lineRange`) when one is asked for. */
  read(path: unknown, range?: LineRange): WorkspaceResult {
    const r = this.resolve(path);
    if (!r.ok) return r;
    if (!existsSync(r.abs)) return { ok: false, error: this.missing(r.rel) };
    if (statSync(r.abs).isDirectory()) return { ok: false, error: `${r.rel} is a directory; read_file reads one file` };
    const text = readFileSync(r.abs, "utf8");
    return range === undefined || (range.offset === undefined && range.limit === undefined) ? { ok: true, text } : lineRange(r.rel, text, range);
  }

  /** A missing file, with what is there: a model that misremembers a path should not need a second call to find it. */
  private missing(rel: string): string {
    const there = this.list().map((f) => f.path);
    return `no such file in the workspace: ${rel}. ${there.length === 0 ? "The workspace is empty." : `Files: ${there.join(", ")}.`}`;
  }

  /** Create a file or replace its whole content. */
  write(path: unknown, content: unknown): WorkspaceResult {
    const r = this.resolve(path);
    if (!r.ok) return r;
    if (typeof content !== "string") return { ok: false, error: `content must be a string, got ${typeof content}` };
    if (r.rel === MEMORY_PATH) return { ok: false, error: MEMORY_WRITE_REFUSAL };
    const blocked = this.blockedByFile(r.rel);
    if (blocked !== undefined) return { ok: false, error: blocked };
    if (existsSync(r.abs) && statSync(r.abs).isDirectory()) return { ok: false, error: `${r.rel} is a directory, not a file` };
    const created = !existsSync(r.abs);
    return this.commit(r.rel, r.abs, content, `${created ? "created" : "wrote"} ${r.rel}`);
  }

  /**
   * Replace an exact substring, as `edit_scratchpad` does. Refusals are the
   * point: an absent or ambiguous `old` means the model's picture of the file
   * and the file have diverged, and guessing which of two matches was meant is
   * referent selection the harness never makes. Plain string operations only:
   * `old` and `new` are model text, so a RegExp would choke on metacharacters
   * and String.replace would read `$&`.
   */
  edit(path: unknown, oldText: unknown, newText: unknown, replaceAll: unknown = false): WorkspaceResult {
    const r = this.resolve(path);
    if (!r.ok) return r;
    if (typeof oldText !== "string") return { ok: false, error: `old must be a string, got ${typeof oldText}` };
    if (typeof newText !== "string") return { ok: false, error: `new must be a string, got ${typeof newText}` };
    if (typeof replaceAll !== "boolean") return { ok: false, error: `replaceAll must be true or false, got ${typeof replaceAll}` };
    if (r.rel === MEMORY_PATH) return { ok: false, error: MEMORY_WRITE_REFUSAL };
    if (!existsSync(r.abs)) return { ok: false, error: `${r.rel} does not exist; create it with write_file` };
    if (statSync(r.abs).isDirectory()) return { ok: false, error: `${r.rel} is a directory, not a file` };
    if (oldText.length === 0) return { ok: false, error: "old was empty, so there is nothing to match; to replace a whole file use write_file" };
    if (oldText === newText) return { ok: false, error: "old and new are the same text, so this edit would change nothing" };
    const current = readFileSync(r.abs, "utf8");
    const at: number[] = [];
    for (let i = current.indexOf(oldText); i !== -1; i = current.indexOf(oldText, i + oldText.length)) at.push(i);
    if (at.length === 0) {
      return { ok: false, error: `old was not found in ${r.rel}; copy the text exactly, whitespace included (read_file shows the file as it is now)` };
    }
    if (at.length > 1 && !replaceAll) {
      const lines = at.map((i) => current.slice(0, i).split("\n").length);
      return { ok: false, error: `old matches ${at.length} places in ${r.rel}, at lines ${lines.join(", ")}; include more surrounding text or set replaceAll` };
    }
    const next = replaceAll ? current.split(oldText).join(newText) : current.slice(0, at[0]!) + newText + current.slice(at[0]! + oldText.length);
    const n = replaceAll ? at.length : 1;
    return this.commit(r.rel, r.abs, next, `edited ${r.rel} (${n} replacement${n === 1 ? "" : "s"})`);
  }

  delete(path: unknown): WorkspaceResult {
    const r = this.resolve(path);
    if (!r.ok) return r;
    if (r.rel === MEMORY_PATH) return { ok: false, error: MEMORY_WRITE_REFUSAL };
    if (!existsSync(r.abs)) return { ok: false, error: this.missing(r.rel) };
    const st = lstatSync(r.abs);
    if (st.isDirectory()) return { ok: false, error: `${r.rel} is a directory; delete the files in it one by one` };
    unlinkSync(r.abs);
    // Prune directories the delete left empty, never the root itself.
    for (let d = dirname(r.abs); d !== this.filesDir && d.startsWith(this.filesDir + sep); d = dirname(d)) {
      if (readdirSync(d).length > 0) break;
      rmdirSync(d);
    }
    return { ok: true, text: `deleted ${r.rel}` };
  }

  /** The saved memory's JSON, or null when none was saved. */
  readMemory(): string | null {
    const abs = join(this.filesDir, MEMORY_PATH);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  /**
   * Save the program's memory: the JSON the sandbox serialized from `memory`.
   * The host's own write, so the file tools' refusal does not apply, but the
   * limits do, and a refusal names both numbers and keeps the last save.
   */
  writeMemory(json: string): WorkspaceResult {
    if (json.length > MEMORY_MAX_CHARS) {
      return { ok: false, error: `memory would be ${json.length} chars of JSON, over its ${MEMORY_MAX_CHARS}-char limit. The last saved memory stays.` };
    }
    const abs = join(this.filesDir, MEMORY_PATH);
    const bytes = Buffer.byteLength(json, "utf8");
    const before = existsSync(abs) ? statSync(abs).size : 0;
    const total = this.totalBytes() - before + bytes;
    if (total > WORKSPACE_MAX_BYTES) {
      return { ok: false, error: `the workspace would total ${total} bytes with this memory, over its ${WORKSPACE_MAX_BYTES}-byte limit. The last saved memory stays.` };
    }
    writeFileSync(abs, json, "utf8");
    return { ok: true, text: `saved ${MEMORY_PATH} (${json.length} chars)` };
  }

  /** A parent component that exists as a file, which would make the path impossible. */
  private blockedByFile(rel: string): string | undefined {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const abs = join(this.filesDir, ...parts.slice(0, i));
      if (existsSync(abs) && !statSync(abs).isDirectory()) return `${parts.slice(0, i).join("/")} is a file, so ${rel} cannot be created under it`;
    }
    return undefined;
  }

  /** The limit checks shared by write and edit, then the write itself. */
  private commit(rel: string, abs: string, content: string, head: string): WorkspaceResult {
    if (content.length > FILE_MAX_CHARS) {
      return { ok: false, error: `${rel} would be ${content.length} chars, over the ${FILE_MAX_CHARS}-char limit of a file. Nothing was written.` };
    }
    const bytes = Buffer.byteLength(content, "utf8");
    const before = existsSync(abs) ? statSync(abs).size : 0;
    const total = this.totalBytes() - before + bytes;
    if (total > WORKSPACE_MAX_BYTES) {
      return { ok: false, error: `the workspace would total ${total} bytes, over its ${WORKSPACE_MAX_BYTES}-byte limit. Nothing was written.` };
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return { ok: true, text: `${head} (${content.length} chars)` };
  }
}
