/**
 * Public quality benchmark, tier 1 (#390): does what Claude receives still
 * carry the facts in the output, and does it ever claim something the output
 * contradicts?
 *
 *   bun run quality            print the table
 *   bun run quality --write    rewrite benchmark/results.md
 *   bun run quality --check    exit 1 if results.md is stale or a control fails
 *
 * Every case in benchmark/corpus/ (built by scripts/quality-corpus.ts) runs
 * through four arms on identical bytes: mcp-recall's real PostToolUse hook, the
 * output's head cut to mcp-recall's delivered size, the first line alone (the
 * sabotage control), and pass-through. Facts are extracted from the raw output
 * by the rules below, which never import from src/: a shared parser would make
 * a handler bug an extractor bug, and it would score as a pass. Pass-through
 * must keep every fact (or an extractor invented one) and the first line must
 * score below mcp-recall in every family (or the benchmark cannot fail).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ERROR_RE, falseClaim, firstLine, headBytes } from "./fidelity";
import type { Case } from "./quality-corpus";
import { loadHook } from "./transcripts";

const DIR = join(import.meta.dir, "..", "benchmark");
const RESULTS = join(DIR, "results.md");
const MIN_LINE = 8;

/** A fact is kept when the delivered text contains `text`, or matches `pattern` when one is given. */
export interface Fact { text: string; pattern?: RegExp }

const MERGE_RE = /^You have unmerged paths\./m;
const STATUS_LONG_RE = /^\t(?:[a-z ]+:\s+)?(.+)$/;
const STATUS_SHORT_RE = /^[ MADRCU?!]{2} (.+)$/;
const ONELINE_RE = /^([0-9a-f]{7,40}) (.+)$/;

// git quotes a path with spaces or special bytes. Only the quotes are dropped, not the
// escapes, so the fact stays a substring of the raw output.
const unquote = (p: string) => (p.length > 1 && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
const paths = (entry: string): string[] => entry.split(" -> ").map(unquote);

function statusFacts(lines: string[]): Fact[] {
  const out: Fact[] = [];
  for (const line of lines) {
    const branch = line.match(/^On branch (\S+)/)?.[1] ?? line.match(/^HEAD detached (?:at|from) (\S+)/)?.[1] ?? line.match(/^## ([^.\s]+)/)?.[1];
    if (branch) { out.push({ text: branch }); continue; }
    const entry = line.match(STATUS_LONG_RE)?.[1] ?? line.match(STATUS_SHORT_RE)?.[1];
    if (entry) out.push(...paths(entry).map((text) => ({ text })));
  }
  if (lines.some((l) => MERGE_RE.test(l))) out.push({ text: "unmerged", pattern: /unmerged|conflict/i });
  return out;
}

function diffFacts(lines: string[]): Fact[] {
  const out: Fact[] = [];
  // Headers (---/+++) come before a file's first hunk; inside one, "--- x" is a removed "-- x".
  let inHunk = false;
  for (const line of lines) {
    const file = line.match(/^diff --git a\/(\S+) b\//)?.[1];
    if (file) { out.push({ text: file }); inHunk = false; continue; }
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk || !/^[+-]/.test(line)) continue;
    const changed = line.slice(1).trim();
    if (changed.length >= MIN_LINE) out.push({ text: changed });
  }
  return out;
}

function logFacts(lines: string[]): Fact[] {
  const out: Fact[] = [];
  let awaitingSubject = false;
  for (const line of lines) {
    const full = line.match(/^commit ([0-9a-f]{40})/)?.[1];
    if (full) { out.push({ text: full.slice(0, 7) }); awaitingSubject = true; continue; }
    if (awaitingSubject && /^ {4}\S/.test(line)) { out.push({ text: line.trim() }); awaitingSubject = false; continue; }
    const one = awaitingSubject ? null : line.match(ONELINE_RE);
    if (one) out.push({ text: one[1].slice(0, 7) }, { text: one[2] });
  }
  return out;
}

const FAMILY_FACTS: Record<string, (lines: string[]) => Fact[]> = { "git-status": statusFacts, "git-diff": diffFacts, "git-log": logFacts };

/** The facts in `raw` for `family`, plus every error line, once each. */
export function facts(family: string, raw: string): Fact[] {
  const lines = raw.split("\n");
  const errors = lines.map((l) => l.trim()).filter((l) => l.length >= MIN_LINE && ERROR_RE.test(l)).map((text) => ({ text }));
  const seen = new Set<string>();
  return [...(FAMILY_FACTS[family]?.(lines) ?? []), ...errors].filter((f) => !seen.has(f.text) && (seen.add(f.text), true));
}

/** The share of `fs` that `delivered` still carries; a case with no facts is fully kept. */
export function keptShare(fs: Fact[], delivered: string): number {
  if (fs.length === 0) return 1;
  return fs.filter((f) => (f.pattern ? f.pattern.test(delivered) : delivered.includes(f.text))).length / fs.length;
}

const CLEAN_RE = /\b(nothing to commit|working tree clean|clean)\b/gi;

/** A summary claiming a clean or error-free result that the output contradicts and does not claim itself. */
export function contradicts(raw: string, delivered: string): boolean {
  if (falseClaim(raw, delivered)) return true;
  if (!MERGE_RE.test(raw)) return false;
  return [...delivered.matchAll(CLEAN_RE)].some(([claim]) => !raw.toLowerCase().includes(claim.toLowerCase()));
}

/** Per family: mean share of each case's facts kept, per arm, and false claims. */
export interface FamilyScore {
  family: string; cases: number; compressed: number; facts: number;
  ours: number; head: number; first: number; pass: number;
  oursClaims: number; headClaims: number; raw: number; delivered: number;
}

/** Why the controls fail, or null when they hold in every family. */
export function controlsBroken(rows: FamilyScore[]): string | null {
  for (const r of rows) {
    if (r.pass < 1) return `pass-through kept ${pc(r.pass)} in ${r.family}; it must keep every fact`;
    if (r.first >= r.ours) return `first-line control scored ${pc(r.first)} in ${r.family}, not below mcp-recall's ${pc(r.ours)}`;
  }
  return null;
}

export function loadCorpus(dir = join(DIR, "corpus")): Case[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Case);
}

const rawOf = (c: Case) => (c.stderr ? `${c.stdout}\n${c.stderr}` : c.stdout);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

async function score(cases: Case[]): Promise<FamilyScore[]> {
  const scratch = mkdtempSync(join(tmpdir(), "quality-"));
  try {
    const hook = await loadHook(scratch, "quality");
    const by = new Map<string, FamilyScore>();
    for (const c of cases) {
      const raw = rawOf(c);
      const ours = hook.deliver(c.command, c.stdout, c.stderr).delivered;
      const head = ours === raw ? raw : headBytes(raw, bytes(ours));
      const fs = facts(c.family, raw);
      const r = by.get(c.family) ?? { family: c.family, cases: 0, compressed: 0, facts: 0, ours: 0, head: 0, first: 0, pass: 0, oursClaims: 0, headClaims: 0, raw: 0, delivered: 0 };
      by.set(c.family, r);
      r.cases++; r.compressed += ours === raw ? 0 : 1; r.facts += fs.length;
      r.ours += keptShare(fs, ours); r.head += keptShare(fs, head); r.first += keptShare(fs, firstLine(raw)); r.pass += keptShare(fs, raw);
      r.oursClaims += contradicts(raw, ours) ? 1 : 0; r.headClaims += contradicts(raw, head) ? 1 : 0;
      r.raw += bytes(raw); r.delivered += bytes(ours);
    }
    // Sums become means; the sort makes the table independent of corpus file order.
    return [...by.values()].sort((a, b) => a.family.localeCompare(b.family)).map((r) =>
      ({ ...r, ours: r.ours / r.cases, head: r.head / r.cases, first: r.first / r.cases, pass: r.pass / r.cases }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const pc = (x: number) => `${(100 * x).toFixed(1)}%`;
const cell = (s: string) => s.replace(/\|/g, "\\|");

export function render(rows: FamilyScore[], cases: Case[]): string {
  const out = [
    "# Quality benchmark results",
    "",
    "Generated by `bun run quality --write` from `benchmark/corpus/`. Do not edit by hand: CI fails when this file",
    "differs from what the corpus produces. Method, arms and limits: `scripts/quality.ts`.",
    "",
    "Facts kept: the mean, over a family's cases, of the share of each case's facts still in what Claude receives.",
    "",
    "| Family | Cases (compressed) | Facts | mcp-recall | Head, same size | First line | Pass-through | False claims: mcp-recall · head | Reduction |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.family} | ${r.cases} (${r.compressed}) | ${r.facts} | ${pc(r.ours)} | ${pc(r.head)} | ${pc(r.first)} | ${pc(r.pass)} | ${r.oursClaims} · ${r.headClaims} | ${pc(1 - r.delivered / r.raw)} |`),
    "",
    "## Cases",
    "",
    "| Case | Family | Command | Bytes | Source | Made with |",
    "| --- | --- | --- | --- | --- | --- |",
    ...cases.map((c) => `| ${c.id} | ${c.family} | \`${cell(c.command)}\` | ${bytes(rawOf(c))} | ${cell(c.source)} | ${c.version} |`),
    "",
    "## Limits",
    "",
    "- Scripted git cases only so far: this table shows the harness works, not mcp-recall's quality across workloads.",
    "- Matching is literal (or one fixed pattern per state fact), so a correct paraphrase scores as lost.",
    "- Retrieval is not credited: mcp-recall can return the stored output on request.",
    "",
  ];
  return out.join("\n");
}

async function main(): Promise<void> {
  const cases = loadCorpus();
  const rows = await score(cases);
  const text = render(rows, cases);
  const mode = process.argv[2];
  if (mode === "--write") writeFileSync(RESULTS, text);
  else if (mode !== "--check") process.stdout.write(text);
  const broken = controlsBroken(rows);
  if (broken) { console.error(`controls failed: ${broken}`); process.exitCode = 1; }
  if (mode === "--check" && readFileSync(RESULTS, "utf8") !== text) {
    console.error("benchmark/results.md is stale: run `bun run quality --write` and commit it");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
