/**
 * Builds the scripted cases of the public quality benchmark (#390): each one
 * sets up a repo state in a throwaway directory, runs the real command, and
 * writes what it printed to benchmark/corpus/<id>.json.
 *
 *   bun run scripts/quality-corpus.ts
 *
 * The benchmark reads the captures, never this script, so its table does not
 * depend on the installed git. Authors, dates and config are pinned, so a rerun
 * on the same git version rewrites the same bytes; `version` records which git
 * made each capture.
 */
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

export interface Case {
  id: string;
  family: string;
  command: string;
  /** How the output was made: the scenario's description and the tool version. */
  source: string;
  version: string;
  stdout: string;
  stderr: string;
}

const CORPUS = join(import.meta.dir, "..", "benchmark", "corpus");
const BASE_DATE = 1_760_000_000; // 2025-10-09, fixed so hashes and log dates are stable

class Repo {
  readonly dir = mkdtempSync(join(tmpdir(), "quality-corpus-"));
  private tick = 0;
  constructor() { this.git("init", "-q", "-b", "main"); }

  private env(): NodeJS.ProcessEnv {
    const date = `${BASE_DATE + 60 * this.tick} +0000`;
    return {
      PATH: process.env.PATH, HOME: this.dir, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Ada Example", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "Ada Example", GIT_COMMITTER_EMAIL: "ada@example.com", GIT_COMMITTER_DATE: date,
    };
  }

  /** Runs git; returns what it printed, and throws only when `check` and it failed. */
  git(...args: string[]): { stdout: string; stderr: string; status: number } {
    const r = spawnSync("git", ["-c", "color.ui=never", "-c", "core.pager=cat", ...args], { cwd: this.dir, env: this.env(), encoding: "utf8" });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
  }

  write(path: string, text: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), text);
  }

  commit(message: string): void {
    this.tick++;
    this.git("add", "-A");
    const r = this.git("commit", "-q", "-m", message);
    if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`);
  }

  remove(): void { rmSync(this.dir, { recursive: true, force: true }); }
}

/** A plausible source file: `n` lines that differ by `seed`, so edits make real hunks. */
const source = (name: string, n: number, seed = 0): string =>
  Array.from({ length: n }, (_, i) => `export function ${name}Step${i}(input: number): number { return input * ${i + 1} + ${(i * 7 + seed) % 13}; }`).join("\n") + "\n";

const SUBJECTS = ["fix: handle an empty config", "feat: add retry to the uploader", "refactor: split the parser", "docs: explain the cache key", "test: cover the timeout path", "chore: bump the linter"];

/** A refactor in progress: modified, deleted, renamed and untracked files across packages. */
function refactorInProgress(repo: Repo): void {
  for (let d = 0; d < 9; d++) for (let f = 0; f < 10; f++) repo.write(`packages/pkg${d}/src/file${f}.ts`, source(`p${d}f${f}`, 6));
  repo.write("legacy/old-entry.ts", source("old", 6));
  for (let i = 0; i < 4; i++) repo.write(`scripts/tool${i}.ts`, source(`tool${i}`, 4));
  repo.commit("chore: initial import");
  for (let d = 0; d < 9; d++) for (let f = 0; f < 10; f++) repo.write(`packages/pkg${d}/src/file${f}.ts`, source(`p${d}f${f}`, 6, 1));
  for (let i = 0; i < 4; i++) rmSync(join(repo.dir, `scripts/tool${i}.ts`));
  repo.git("mv", "legacy/old-entry.ts", "src/entry.ts");
  for (let i = 0; i < 25; i++) repo.write(`packages/pkg${i % 9}/test/new${i}.test.ts`, source(`t${i}`, 3));
}

type Scenario = { id: string; family: string; source: string; build(repo: Repo): string[] };

const SCENARIOS: Scenario[] = [
  {
    id: "git-status-merge-conflict",
    family: "git-status",
    source: "a merge stopped on two conflicts, beside 41 unstaged edits, one staged file and untracked files",
    build(repo) {
      for (let i = 0; i < 6; i++) repo.write(`src/mod${i}.ts`, source(`mod${i}`, 20));
      for (let i = 0; i < 40; i++) repo.write(`lib/part${i}.ts`, source(`part${i}`, 4));
      repo.commit("chore: initial import");
      repo.git("checkout", "-q", "-b", "topic");
      repo.write("src/mod0.ts", source("mod0", 20, 5));
      repo.write("src/mod1.ts", source("mod1", 20, 5));
      repo.write("src/mod2.ts", source("mod2", 20, 5));
      repo.commit("feat: tune the topic weights");
      repo.git("checkout", "-q", "main");
      repo.write("src/mod0.ts", source("mod0", 20, 9));
      repo.write("src/mod1.ts", source("mod1", 20, 9));
      repo.commit("fix: main weights");
      repo.git("merge", "topic");
      repo.write("src/mod4.ts", source("mod4", 20, 3));
      for (let i = 0; i < 40; i++) repo.write(`lib/part${i}.ts`, source(`part${i}`, 4, 2));
      for (let i = 0; i < 12; i++) repo.write(`notes/plan${i}.md`, `resolve step ${i}\n`);
      repo.write("scratch.log", "merge attempt 1\n");
      return ["status"];
    },
  },
  {
    id: "git-status-many-changes",
    family: "git-status",
    source: "a refactor in progress: 90 modified files over 9 directories, 4 deleted, 1 renamed, 25 untracked",
    build(repo) {
      refactorInProgress(repo);
      return ["status"];
    },
  },
  {
    id: "git-status-short-many",
    family: "git-status",
    source: "the same refactor shown with `git status -s`",
    build(repo) {
      refactorInProgress(repo);
      return ["status", "-s"];
    },
  },
  {
    id: "git-diff-many-files",
    family: "git-diff",
    source: "an unstaged edit touching 24 files, a few changed lines in each",
    build(repo) {
      for (let i = 0; i < 24; i++) repo.write(`src/area${i % 4}/unit${i}.ts`, source(`unit${i}`, 30));
      repo.commit("chore: initial import");
      for (let i = 0; i < 24; i++) {
        const lines = source(`unit${i}`, 30).split("\n");
        lines[3 + (i % 5)] = `export function unit${i}Changed(input: number): number { return input - ${i}; }`;
        lines[20] = `// reviewed in pass ${i}`;
        repo.write(`src/area${i % 4}/unit${i}.ts`, lines.join("\n"));
      }
      return ["diff"];
    },
  },
  {
    id: "git-diff-one-large-file",
    family: "git-diff",
    source: "one file rewritten across many hunks",
    build(repo) {
      repo.write("src/engine.ts", source("engine", 400));
      repo.commit("chore: initial import");
      const lines = source("engine", 400).split("\n").map((l, i) => (i % 9 === 0 ? l.replace("input *", "input / 2 *") : l));
      repo.write("src/engine.ts", lines.join("\n"));
      return ["diff"];
    },
  },
  {
    id: "git-log-oneline-200",
    family: "git-log",
    source: "200 commits listed one per line",
    build(repo) {
      for (let i = 0; i < 200; i++) {
        repo.write(`src/c${i % 10}.ts`, source(`c${i % 10}`, 3, i));
        repo.commit(`${SUBJECTS[i % SUBJECTS.length]} (#${1000 + i})`);
      }
      return ["log", "--oneline"];
    },
  },
  {
    id: "git-log-stat-30",
    family: "git-log",
    source: "30 commits with their file stats",
    build(repo) {
      for (let i = 0; i < 30; i++) {
        repo.write(`src/c${i % 7}.ts`, source(`c${i % 7}`, 8, i));
        repo.write(`tests/c${i % 5}.test.ts`, source(`t${i % 5}`, 4, i));
        repo.commit(`${SUBJECTS[i % SUBJECTS.length]} (#${2000 + i})\n\nWhy: case ${i} needed it.`);
      }
      return ["log", "--stat"];
    },
  },
];

function capture(s: Scenario, version: string): Case {
  const repo = new Repo();
  try {
    const args = s.build(repo);
    const r = repo.git(...args);
    return { id: s.id, family: s.family, command: `git ${args.join(" ")}`, source: `scripted: ${s.source}`, version, stdout: r.stdout, stderr: r.stderr };
  } finally {
    repo.remove();
  }
}

if (import.meta.main) {
  const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(CORPUS, { recursive: true });
  for (const s of SCENARIOS) {
    const c = capture(s, version);
    writeFileSync(join(CORPUS, `${c.id}.json`), JSON.stringify(c, null, 2) + "\n");
    console.log(`${c.id}: ${Buffer.byteLength(c.stdout + c.stderr, "utf8")} B`);
  }
}
