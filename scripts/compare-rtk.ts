/**
 * Measured comparison with rtk (https://github.com/rtk-ai/rtk), the source of
 * every figure in docs/rtk.md (#351). Each output goes through mcp-recall and
 * through `rtk pipe -f <filter>`, rtk's stdin mode, so both see identical bytes.
 *
 *   bun scripts/compare-rtk.ts [--rtk <path>]                 # bench fixtures
 *   bun scripts/compare-rtk.ts --transcripts [--rtk <path>]   # your own Bash history
 *   bun scripts/compare-rtk.ts --both [--rtk <path>]          # running both, on this repo
 *
 * --fixtures (the default) uses the bench fixtures in scripts/benchmark.ts and
 * checks each summary for the facts the fixture lists in `keep`. It is
 * deterministic: anyone with the same rtk version gets the same table.
 *
 * --transcripts replays the Bash results recorded in ~/.claude/projects (or
 * --projects <dir>) through mcp-recall's PostToolUse hook, into a throwaway
 * store, and prints only per-family totals: no command or output is printed.
 * A transcript holds what the hook delivered, so an output mcp-recall already
 * compressed is skipped and counted; the sample leans to output it passed whole.
 *
 * --both runs real commands in this checkout, at pinned commits where it can,
 * through mcp-recall's hook twice: as typed, and as `rtk rewrite` turns them
 * into what rtk's PreToolUse hook would run. It shows what running both does.
 *
 * rtk always runs with HOME pointed at a temporary directory, so your rtk
 * config, history and recall store are neither read nor written.
 */
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { FIXTURES, fmt, summarize } from "./benchmark";
import { FAMILIES, loadHook, recordedBash } from "./transcripts";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const RTK = opt("--rtk") ?? "rtk";
const scratch = mkdtempSync(join(tmpdir(), "compare-rtk-"));
const rtkEnv = { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, ".config"), XDG_DATA_HOME: join(scratch, ".local/share"), RTK_TELEMETRY_DISABLED: "1" };

/** rtk's filtered form of `input`, or null when rtk failed. */
function rtkPipe(filter: string, input: string): string | null {
  const p = spawnSync(RTK, ["pipe", "-f", filter], { input, env: rtkEnv, encoding: "utf8", maxBuffer: 256 << 20 });
  return p.status === 0 ? p.stdout : null;
}

const pct = (part: number, whole: number) => (whole > 0 ? `${(100 * (1 - part / whole)).toFixed(1)}%` : "—");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function compareFixtures(): void {
  console.log("| Fixture | Original | mcp-recall | rtk | Facts kept (mcp-recall · rtk) |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const f of FIXTURES.filter((x) => x.rtk)) {
    const raw = [f.stdout, f.stderr].filter(Boolean).join("\n");
    const { summary, original } = summarize(f);
    const theirs = rtkPipe(f.rtk!, raw);
    if (theirs === null) throw new Error(`rtk pipe -f ${f.rtk} failed on ${f.label}`);
    const kept = (text: string) => (f.keep ?? []).filter((k) => new RegExp(k).test(text)).length;
    const facts = f.keep?.length ? `${kept(summary)}/${f.keep.length} · ${kept(theirs)}/${f.keep.length}` : "—";
    console.log(`| ${f.label} | ${fmt(original)} | ${fmt(bytes(summary))} (${pct(bytes(summary), original)}) | ${fmt(bytes(theirs))} (${pct(bytes(theirs), original)}) | ${facts} |`);
  }
}

// Commands run by --both. A pinned commit keeps the git rows stable across checkouts.
const BOTH = [
  "git status",
  "cat src/handlers/collapse.ts",
  "cat src/handlers/bash.ts",
  "git diff db0eb5c~3 db0eb5c",
  "git log --stat -20 db0eb5c",
  // Reaches a commit message quoting the GCP key pattern, so the secret scan skips it.
  "git log --stat -60 db0eb5c",
  "grep -rn export src",
];

const HINT_RE = /rtk recall [0-9a-f]{6,}|\[full [a-z ]+: rtk [^\]]+\]/g;

async function compareBoth(): Promise<void> {
  const hook = await loadHook(scratch, "compare-rtk");
  const repo = join(import.meta.dir, "..");
  // rtk's rewrite names `rtk`, so the rewritten command finds the binary on PATH.
  // A bare `rtk` is on PATH already; prepending its dirname would add `.`.
  const path = RTK.includes("/") ? `${join(RTK, "..")}:${process.env.PATH}` : process.env.PATH;
  const sh = (command: string) => spawnSync("bash", ["-c", command], { cwd: repo, env: { ...rtkEnv, PATH: path }, encoding: "utf8", maxBuffer: 256 << 20 });
  const describe = (d: { delivered: string; stored: boolean; body: boolean }) =>
    `${fmt(bytes(d.delivered))}${d.stored ? (d.body ? ", stored with body" : ", stored, no body") : ", whole"}`;
  console.log("| Command | mcp-recall alone | rtk rewrites it to | rtk alone | rtk + mcp-recall | rtk hints kept |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const command of BOTH) {
    const plain = sh(command);
    const rewritten = spawnSync(RTK, ["rewrite", command], { env: rtkEnv, encoding: "utf8" }).stdout.trim() || command;
    const viaRtk = sh(rewritten);
    const alone = hook.deliver(command, plain.stdout, plain.stderr);
    const both = hook.deliver(rewritten, viaRtk.stdout, viaRtk.stderr);
    const hints = (viaRtk.stdout.match(HINT_RE) ?? []).length;
    const kept = (both.delivered.match(HINT_RE) ?? []).length;
    console.log(`| \`${command}\` | ${describe(alone)} | \`${rewritten}\` | ${fmt(bytes(viaRtk.stdout))} | ${describe(both)} | ${hints ? `${kept}/${hints}` : "—"} |`);
  }
}

async function compareTranscripts(): Promise<void> {
  const hook = await loadHook(scratch, "compare-rtk");
  const { normalizeCommand, isCompoundCommand } = await import("../src/handlers/bash");

  const { calls, compressed } = recordedBash(opt("--projects") ?? join(homedir(), ".claude/projects"));
  const totals = new Map<string, { n: number; orig: number; ours: number; theirs: number; rtkSmaller: number; oursSmaller: number }>();
  for (const c of calls) {
    const n = normalizeCommand(c.command);
    // Single commands only: a pipe or a sequence is not one filter's input.
    if (isCompoundCommand(n) || /[|<>]/.test(n.replace(/'[^']*'|"[^"]*"/g, ""))) continue;
    const family = FAMILIES.find(([re]) => re.test(n))?.[1];
    const raw = c.stderr ? `${c.stdout}\n${c.stderr}` : c.stdout;
    if (!family || raw.trim() === "") continue;
    const ours = bytes(hook.deliver(c.command, c.stdout, c.stderr).delivered);
    const filtered = rtkPipe(family, raw);
    if (filtered === null) continue;
    const theirs = bytes(filtered);
    for (const key of [family, "all"]) {
      const t = totals.get(key) ?? { n: 0, orig: 0, ours: 0, theirs: 0, rtkSmaller: 0, oursSmaller: 0 };
      t.n++; t.orig += bytes(raw); t.ours += ours; t.theirs += theirs;
      if (theirs < ours) t.rtkSmaller++;
      if (ours < theirs) t.oursSmaller++;
      totals.set(key, t);
    }
  }
  console.log(`${calls.length} recorded Bash results; ${compressed} skipped (already compressed by mcp-recall)\n`);
  console.log("| Family | Calls | Original | mcp-recall | rtk | Smaller (rtk · mcp-recall) |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const [k, t] of [...totals].sort((a, b) => b[1].orig - a[1].orig)) {
    console.log(`| ${k} | ${t.n} | ${fmt(t.orig)} | ${fmt(t.ours)} (${pct(t.ours, t.orig)}) | ${fmt(t.theirs)} (${pct(t.theirs, t.orig)}) | ${t.rtkSmaller} · ${t.oursSmaller} |`);
  }
}

try {
  const version = spawnSync(RTK, ["--version"], { env: rtkEnv, encoding: "utf8" });
  if (version.status !== 0) throw new Error(`cannot run rtk at "${RTK}": pass --rtk <path>`);
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version;
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: import.meta.dir, encoding: "utf8" }).stdout.trim();
  console.log(`${version.stdout.trim()}, mcp-recall ${pkg}${head ? ` @ ${head}` : ""}\n`);
  if (args.includes("--transcripts")) await compareTranscripts();
  else if (args.includes("--both")) await compareBoth();
  else compareFixtures();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
