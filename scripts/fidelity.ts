/**
 * Referenced-content recall beside bytes saved (#352). Bytes saved rewards
 * dropping content; this asks whether what Claude went on to use survived.
 *
 *   bun run fidelity [--projects <dir>] [--root <checkout>] [--rtk <path>]
 *
 * For each Bash result recorded whole in the transcripts, a "referenced piece"
 * is a line or a distinctive token (a path, identifier, hash, number-bearing
 * word) of the output that reappears verbatim in Claude's next turn: its text,
 * thinking or tool inputs, and that the command itself did not already contain.
 * Each compressor's delivered text is then scored on how many pieces it kept.
 *
 * Compressors: mcp-recall's PostToolUse hook from --root (default: this
 * checkout, so another revision runs from a worktree), the output's head cut to
 * mcp-recall's delivered size (scored only where mcp-recall compressed, since
 * elsewhere both are the whole output), rtk's stdin filter when rtk runs, and
 * two controls. Pass-through must score 100% and the first line alone must score
 * low, or the run fails: a metric that cannot tell those apart measures nothing.
 *
 * Limits, printed with the result: only outputs Claude received whole are
 * scored (one compressed by mcp-recall left no record of what was cut), so the
 * sample leans to what those showed; matching is literal, so a paraphrase
 * counts as unused; it is one user's workload. Totals only: no command or
 * output is printed.
 */
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { FAMILIES, loadHook, recordedBash, type Recorded } from "./transcripts";

const MIN_TOKEN = 6;
const MIN_LINE = 24;
const MAX_LINE = 300;
/** The first-line control must score below this, or the metric cannot fail. */
export const CONTROL_CEILING = 0.5;

const TOKEN_RE = /[A-Za-z0-9_][\w./:@+-]*[\w/]/g;
// A plain word is too common to show use; a token needs a digit, a separator or camelCase.
const DISTINCT_RE = /[\d/._:]|[a-z][A-Z]/;

/** The pieces of `raw` that could show Claude used it: long lines and distinctive tokens. */
export function candidates(raw: string): Set<string> {
  const out = new Set<string>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length >= MIN_LINE && t.length <= MAX_LINE) out.add(t);
    for (const tok of t.match(TOKEN_RE) ?? []) {
      if (tok.length >= MIN_TOKEN && DISTINCT_RE.test(tok) && !/^\d+$/.test(tok)) out.add(tok);
    }
  }
  return out;
}

/**
 * Candidates of what Claude was shown that reappear in its follow-up and were not
 * already in the command it typed. A piece must also be in the raw output, so text
 * Claude Code added around a preview (a saved-file notice) is never credited to it.
 */
export function referenced(shown: string, raw: string, command: string, followup: string): string[] {
  if (!followup) return [];
  return [...candidates(shown)].filter((p) => followup.includes(p) && !command.includes(p) && raw.includes(p));
}

export const kept = (pieces: string[], delivered: string): number => pieces.filter((p) => delivered.includes(p)).length;

const CLAIM_RE = /\b(0 errors?|no errors?|0 failed|0 failures|no matches|no changes|nothing to commit|all clean|clean)\b/gi;
export const ERROR_RE = /\b(error|errors|fail|failed|failure|fatal|panic|exception|traceback)\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A summary that claims a clean result over an output with an error, where the
 * output does not make that claim itself (word-bounded, any case), so a copied
 * line is never counted.
 */
export function falseClaim(raw: string, delivered: string): boolean {
  if (!ERROR_RE.test(raw)) return false;
  return [...delivered.matchAll(CLAIM_RE)].some(([claim]) => !new RegExp(`\\b${escapeRe(claim)}\\b`, "i").test(raw));
}

export const headBytes = (raw: string, n: number): string => Buffer.from(raw, "utf8").subarray(0, n).toString("utf8");
export const firstLine = (raw: string): string => raw.split("\n")[0];

/**
 * Recall and bytes cover calls with referenced pieces. False claims cover every
 * scored output that holds an error, referenced or not: a summary claiming "0
 * errors" is most harmful exactly when Claude then has nothing to follow up on.
 */
export interface Score { pieces: number; kept: number; orig: number; delivered: number; calls: number; errorCalls: number; falseClaims: number }
export const emptyScore = (): Score => ({ pieces: 0, kept: 0, orig: 0, delivered: 0, calls: 0, errorCalls: 0, falseClaims: 0 });

export function add(s: Score, pieces: string[], raw: string, delivered: string): void {
  if (pieces.length > 0) {
    s.calls++;
    s.pieces += pieces.length;
    s.kept += kept(pieces, delivered);
    s.orig += Buffer.byteLength(raw, "utf8");
    s.delivered += Buffer.byteLength(delivered, "utf8");
  }
  if (ERROR_RE.test(raw)) {
    s.errorCalls++;
    if (falseClaim(raw, delivered)) s.falseClaims++;
  }
}

export const recall = (s: Score): number => (s.pieces > 0 ? s.kept / s.pieces : 1);

/**
 * Why the controls fail, or null when pass-through is perfect and the first line
 * scores low. Pass-through holds by construction (pieces are substrings of the raw
 * output), so it guards the extraction code; the first line is the real check.
 */
export function controlsBroken(pass: Score, first: Score): string | null {
  if (pass.pieces === 0) return "no referenced pieces found: nothing to score";
  if (pass.kept !== pass.pieces) return `pass-through kept ${pass.kept}/${pass.pieces}; it must keep every piece`;
  if (recall(first) >= CONTROL_CEILING) return `first-line control scored ${(100 * recall(first)).toFixed(1)}%; it must score below ${100 * CONTROL_CEILING}%`;
  return null;
}

// Wider than FAMILIES, which lists only what rtk filters; the rest is "other".
const MORE_FAMILIES: [RegExp, string][] = [
  [/^(cat|head|tail|sed\s+-n|less|nl)\b/, "read"], [/^ls\b/, "ls"],
  [/^(bun|npm|pnpm|yarn)\s+(run\s+)?test\b|^(just|make)\b/, "test-runner"],
  [/^(ssh|pct\s+exec|docker\s+exec|kubectl\s+exec)\b/, "remote"], [/^gh\s/, "gh"], [/^git\s/, "git-other"],
];

interface Row { family: string; rtkFamily?: string; pieces: string[]; call: Recorded; raw: string }

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = opt("--root") ?? join(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "fidelity-"));
  try {
    const rtk = rtkRunner(opt("--rtk") ?? "rtk", scratch);
    const hook = await loadHook(scratch, "fidelity", root);
    const { normalizeCommand, isCompoundCommand } = await import("../src/handlers/bash");
    const { calls, compressed } = recordedBash(opt("--projects") ?? join(homedir(), ".claude/projects"));
    const rows = toRows(calls, normalizeCommand, isCompoundCommand);
    printHeader(root, rtk.version, calls.length, compressed, rows.filter((r) => r.pieces.length > 0).length);
    const totals = score(rows, hook, rtk.version !== null ? rtk.pipe : null);
    printTable(totals, rtk.version !== null);
    const broken = controlsBroken(totals.get("all")!.pass, totals.get("all")!.first);
    if (broken) { console.error(`\ncontrols failed: ${broken}`); process.exitCode = 1; }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function toRows(calls: Recorded[], normalize: (c: string) => string, compound: (c: string) => boolean): Row[] {
  const rows: Row[] = [];
  for (const call of calls) {
    const raw = call.stderr ? `${call.stdout}\n${call.stderr}` : call.stdout;
    const pieces = referenced(call.shown, raw, call.command, call.followup);
    // Unreferenced output still counts for false claims when it holds an error.
    if (pieces.length === 0 && !ERROR_RE.test(raw)) continue;
    // normalizeCommand has already dropped `cd … &&` prefixes and wrappers, so the
    // family is the command that ran, whatever follows it.
    const n = normalize(call.command);
    const family = [...FAMILIES, ...MORE_FAMILIES].find(([re]) => re.test(n))?.[1] ?? "other";
    // A pipe or a sequence is not one filter's input, so rtk scores single commands
    // only. `2>&1` is allowed: stdout and stderr are scored together anyway.
    const single = !compound(n) && !/[|<>]/.test(n.replace(/'[^']*'|"[^"]*"/g, "").replace(/\s2>&1\b/g, ""));
    const rtkFamily = single ? FAMILIES.find(([re]) => re.test(n))?.[1] : undefined;
    rows.push({ family, rtkFamily, pieces, call, raw });
  }
  return rows;
}

// oursChanged and head cover only the calls mcp-recall compressed: elsewhere both
// deliver the whole output, which would hide the comparison. rtkFailed counts
// outputs rtk's filter exited non-zero on; they are left out of rtk's column.
interface Totals { ours: Score; oursChanged: Score; head: Score; first: Score; pass: Score; rtk: Score; rtkFailed: number }

function score(rows: Row[], hook: { deliver: (c: string, o: string, e: string) => { delivered: string } }, rtkPipe: ((f: string, raw: string) => string | null) | null): Map<string, Totals> {
  const totals = new Map<string, Totals>();
  const at = (k: string) => totals.get(k) ?? (totals.set(k, { ours: emptyScore(), oursChanged: emptyScore(), head: emptyScore(), first: emptyScore(), pass: emptyScore(), rtk: emptyScore(), rtkFailed: 0 }), totals.get(k)!);
  for (const r of rows) {
    const ours = hook.deliver(r.call.command, r.call.stdout, r.call.stderr).delivered;
    const theirs = r.rtkFamily && rtkPipe ? rtkPipe(r.rtkFamily, r.raw) : null;
    for (const t of [at(r.family), at("all")]) {
      if (r.rtkFamily && rtkPipe && theirs === null) t.rtkFailed++;
      add(t.ours, r.pieces, r.raw, ours);
      if (ours !== r.raw) {
        add(t.oursChanged, r.pieces, r.raw, ours);
        add(t.head, r.pieces, r.raw, headBytes(r.raw, Buffer.byteLength(ours, "utf8")));
      }
      add(t.first, r.pieces, r.raw, firstLine(r.raw));
      add(t.pass, r.pieces, r.raw, r.raw);
      if (theirs !== null) add(t.rtk, r.pieces, r.raw, theirs);
    }
  }
  return totals;
}

function rtkRunner(bin: string, scratch: string) {
  const env = { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, ".config"), XDG_DATA_HOME: join(scratch, ".local/share"), RTK_TELEMETRY_DISABLED: "1" };
  const v = spawnSync(bin, ["--version"], { env, encoding: "utf8" });
  return {
    version: v.status === 0 ? v.stdout.trim() : null,
    pipe(filter: string, input: string): string | null {
      if (v.status !== 0) return null;
      const p = spawnSync(bin, ["pipe", "-f", filter], { input, env, encoding: "utf8", maxBuffer: 256 << 20 });
      return p.status === 0 ? p.stdout : null;
    },
  };
}

const pc = (x: number) => `${(100 * x).toFixed(1)}%`;
const red = (s: Score) => (s.orig > 0 ? pc(1 - s.delivered / s.orig) : "—");

function printHeader(root: string, rtkVersion: string | null, recorded: number, compressed: number, scored: number): void {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  console.log(`mcp-recall ${pkg}${head ? ` @ ${head}` : ""}${rtkVersion ? `, ${rtkVersion}` : ", rtk not found (pass --rtk <path>)"}\n`);
  console.log(`${recorded} recorded Bash results (${compressed} more were already compressed, so cannot be scored); ${scored} have pieces Claude went on to use\n`);
}

// The compressed-only columns lead: on every other call mcp-recall passes the
// output whole, so its all-calls recall is mostly 100% by construction.
function printTable(totals: Map<string, Totals>, withRtk: boolean): void {
  const cols = ["Family", "Calls", "Pieces", "Compressed: mcp-recall (calls)", "Compressed: head, same size"];
  if (withRtk) cols.push("rtk recall · reduction (calls)");
  cols.push("All calls: mcp-recall recall · reduction", "First line", "Pass-through");
  cols.push(withRtk ? "False claims / outputs with an error (mcp-recall · rtk)" : "False claims / outputs with an error");
  console.log(`| ${cols.join(" | ")} |`);
  console.log(`|${cols.map(() => " --- ").join("|")}|`);
  for (const [k, t] of [...totals].sort((a, b) => (a[0] === "all" ? -1 : b[0] === "all" ? 1 : b[1].ours.pieces - a[1].ours.pieces))) {
    const cells = [k, `${t.ours.calls}`, `${t.ours.pieces}`,
      t.oursChanged.calls ? `${pc(recall(t.oursChanged))} (${t.oursChanged.calls})` : "—", t.head.calls ? pc(recall(t.head)) : "—"];
    if (withRtk) cells.push(t.rtk.calls ? `${pc(recall(t.rtk))} · ${red(t.rtk)} (${t.rtk.calls})` : "—");
    const rc = (s: Score) => (s.pieces > 0 ? pc(recall(s)) : "—");
    cells.push(`${rc(t.ours)} · ${red(t.ours)}`, rc(t.first), rc(t.pass));
    const claims = (s: Score) => `${s.falseClaims}/${s.errorCalls}`;
    cells.push(withRtk ? `${claims(t.ours)} · ${claims(t.rtk)}` : claims(t.ours));
    console.log(`| ${cells.join(" | ")} |`);
  }
  const failed = totals.get("all")?.rtkFailed ?? 0;
  if (withRtk && failed > 0) console.log(`\nrtk's filter exited non-zero on ${failed} outputs; they are left out of its column.`);
  console.log("\nRecall: share of referenced pieces still in what Claude would receive first. Literal matching; outputs received whole only; one user's workload.");
  console.log("It does not credit retrieval: mcp-recall can return a stored body on request, and rtk prints recovery hints.");
}

if (import.meta.main) await main();
