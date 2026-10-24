import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { contradicts, controlsBroken, facts, keptShare, loadCorpus, type Fact, type FamilyScore } from "../scripts/quality";

const texts = (fs: Fact[]) => fs.map((f) => f.text);

describe("facts", () => {
  it("takes every path and the merge state from a long git status", () => {
    const raw = [
      "On branch main", "You have unmerged paths.", "", "Unmerged paths:", "\tboth modified:   src/mod0.ts",
      "Changes not staged for commit:", "\tmodified:   lib/a.ts", "\tdeleted:    old/b.ts", "\trenamed:    x.ts -> y.ts",
      "Untracked files:", "  (use \"git add <file>...\" to include in what will be committed)", "\tnotes/",
    ].join("\n");
    const fs = facts("git-status", raw);
    expect(texts(fs)).toEqual(expect.arrayContaining(["main", "src/mod0.ts", "lib/a.ts", "old/b.ts", "x.ts", "y.ts", "notes/"]));
    expect(fs.some((f) => f.text === "unmerged" && f.pattern)).toBe(true);
  });

  it("takes every path from a short git status, both sides of a rename", () => {
    expect(texts(facts("git-status", " M src/a.ts\nR  old.ts -> new.ts\n?? tmp/\nUU both.ts"))).toEqual(["src/a.ts", "old.ts", "new.ts", "tmp/", "both.ts"]);
  });

  it("takes a quoted path without its quotes, and a detached HEAD's commit", () => {
    expect(texts(facts("git-status", '## main...origin/main [ahead 2]\n M "my file.ts"'))).toEqual(["main", "my file.ts"]);
    expect(texts(facts("git-status", "HEAD detached at abc1234\nnothing to commit, working tree clean"))).toEqual(["abc1234"]);
  });

  it("takes a removed line that starts with -- inside a hunk, which only looks like a header", () => {
    const raw = "diff --git a/a.sql b/a.sql\n--- a/a.sql\n+++ b/a.sql\n@@ -1 +1 @@\n--- a removed sql comment\n+-- an added sql comment\n";
    expect(texts(facts("git-diff", raw))).toEqual(["a.sql", "-- a removed sql comment", "-- an added sql comment"]);
  });

  it("takes each file and each changed line of a diff, not the context or headers", () => {
    const raw = "diff --git a/src/x.ts b/src/x.ts\nindex 1..2 100644\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,3 +1,3 @@\n keep this context line\n-const limit = 10;\n+const limit = 20;\n";
    expect(texts(facts("git-diff", raw))).toEqual(["src/x.ts", "const limit = 10;", "const limit = 20;"]);
  });

  it("takes each commit's short hash and subject from a log", () => {
    const oneline = facts("git-log", "abc1234 fix: one (#1)\ndef5678 feat: two (#2)");
    expect(texts(oneline)).toEqual(["abc1234", "fix: one (#1)", "def5678", "feat: two (#2)"]);
    const full = facts("git-log", "commit 0123456789abcdef0123456789abcdef01234567\nAuthor: A <a@x>\nDate:   Thu\n\n    fix: one (#1)\n\n    Why: body.\n");
    expect(texts(full)).toEqual(["0123456", "fix: one (#1)"]);
  });

  it("adds error lines whatever the family, without duplicates", () => {
    expect(texts(facts("git-diff", "fatal: bad revision 'nope'\nfatal: bad revision 'nope'"))).toEqual(["fatal: bad revision 'nope'"]);
  });

  it("returns only facts the raw output satisfies, so pass-through keeps them all", () => {
    const raw = "On branch topic\nYou have unmerged paths.\n\tboth modified:   a.ts\n";
    const fs = facts("git-status", raw);
    expect(keptShare(fs, raw)).toBe(1);
  });
});

describe("keptShare", () => {
  const fs: Fact[] = [{ text: "src/a.ts" }, { text: "unmerged", pattern: /unmerged|conflict/i }];

  it("matches text literally and a pattern by regex", () => {
    expect(keptShare(fs, "2 conflicts; see src/a.ts")).toBe(1);
    expect(keptShare(fs, "src/a.ts changed")).toBe(0.5);
  });

  it("counts a case with no facts as fully kept", () => {
    expect(keptShare([], "anything")).toBe(1);
  });
});

describe("contradicts", () => {
  const merge = "On branch main\nYou have unmerged paths.\n\tboth modified:   a.ts\n";

  it("flags a clean claim over a merge in progress", () => {
    expect(contradicts(merge, "working tree clean")).toBe(true);
    expect(contradicts(merge, "nothing to commit")).toBe(true);
  });

  it("flags a no-errors claim over an output with an error", () => {
    expect(contradicts("error: could not apply abc", "0 errors")).toBe(true);
  });

  it("does not flag a claim the output makes itself, or a summary that makes none", () => {
    expect(contradicts("nothing to commit, working tree clean", "nothing to commit, working tree clean")).toBe(false);
    expect(contradicts(merge, "2 unmerged paths")).toBe(false);
  });

  it("does not flag a merge summary for naming a file the output lists", () => {
    const withPath = `${merge}\tmodified:   src/clean.ts\n`;
    expect(contradicts(withPath, "conflicts (1): a.ts\nunstaged (1): src/clean.ts")).toBe(false);
  });
});

describe("controlsBroken", () => {
  const row = (family: string, ours: number, first: number, pass = 1): FamilyScore =>
    ({ family, cases: 1, compressed: 1, facts: 4, ours, head: ours, first, pass, oursClaims: 0, headClaims: 0, raw: 100, delivered: 50 });

  it("passes when pass-through keeps everything and the first line scores below mcp-recall in every family", () => {
    expect(controlsBroken([row("git-diff", 0.8, 0.1), row("git-log", 0.5, 0.2)])).toBeNull();
  });

  it("fails when the first line ties mcp-recall in any one family", () => {
    expect(controlsBroken([row("git-diff", 0.8, 0.1), row("git-log", 0.3, 0.3)])).toContain("git-log");
  });

  it("fails when pass-through misses a fact, which means an extractor invented it", () => {
    expect(controlsBroken([row("git-diff", 0.8, 0.1, 0.99)])).toContain("pass-through");
  });
});

describe("the committed results", () => {
  it("are what the corpus produces now", () => {
    // A subprocess: the hook reads RECALL_DB_PATH once at load, so it must not share this test process.
    const r = spawnSync("bun", ["run", join(import.meta.dir, "../scripts/quality.ts"), "--check"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 60_000);

  it("name every corpus case, with its source and tool version", () => {
    const results = readFileSync(join(import.meta.dir, "../benchmark/results.md"), "utf8");
    const cases = loadCorpus();
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.source).toStartWith("scripted: ");
      expect(c.version).not.toBe("");
      expect(results).toContain(`| ${c.id} | ${c.family} |`);
    }
  });
});
