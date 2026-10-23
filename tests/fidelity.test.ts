import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  add, candidates, CONTROL_CEILING, controlsBroken, emptyScore, falseClaim, firstLine, headBytes, kept, recall, referenced,
} from "../scripts/fidelity";
import { recordedBash } from "../scripts/transcripts";

describe("candidates", () => {
  it("keeps paths, identifiers and long lines, and drops plain words and bare numbers", () => {
    const c = candidates("error in src/db/queries.ts at storeOutput\nok\n123456 done\nthe function returned nothing useful at all here");
    expect(c.has("src/db/queries.ts")).toBe(true);
    expect(c.has("storeOutput")).toBe(true);
    expect(c.has("the function returned nothing useful at all here")).toBe(true);
    expect(c.has("function")).toBe(false);
    expect(c.has("123456")).toBe(false);
    expect(c.has("ok")).toBe(false);
  });
});

describe("referenced", () => {
  const raw = "M src/hooks/post-tool-use.ts\nM tests/fidelity.test.ts";

  it("returns pieces of the output that Claude used next", () => {
    expect(referenced(raw, raw, "git status", "I'll open src/hooks/post-tool-use.ts")).toEqual(["src/hooks/post-tool-use.ts"]);
  });

  it("ignores a piece the command already contained", () => {
    expect(referenced(raw, raw, "git diff src/hooks/post-tool-use.ts", "src/hooks/post-tool-use.ts changed")).toEqual([]);
  });

  it("returns nothing without a follow-up", () => {
    expect(referenced(raw, raw, "git status", "")).toEqual([]);
  });

  it("never credits text Claude Code added around a preview", () => {
    const shown = "Output too large. Full output saved to /home/u/.claude/tool-results/b1.txt\nM src/hooks/post-tool-use.ts";
    expect(referenced(shown, raw, "git status", "cat /home/u/.claude/tool-results/b1.txt; open src/hooks/post-tool-use.ts"))
      .toEqual(["src/hooks/post-tool-use.ts"]);
  });

  it("scores only pieces Claude was shown, not the rest of a saved output", () => {
    expect(referenced("M src/hooks/post-tool-use.ts", raw, "git status", "tests/fidelity.test.ts and src/hooks/post-tool-use.ts"))
      .toEqual(["src/hooks/post-tool-use.ts"]);
  });
});

describe("falseClaim", () => {
  const raw = "build step 3\nerror: cannot find module 'zod'\n";

  it("flags a summary claiming a clean result over an output with an error", () => {
    expect(falseClaim(raw, "0 errors · 0 warnings")).toBe(true);
  });

  it("does not flag the output passed through, or a claim the output itself makes", () => {
    expect(falseClaim(raw, raw)).toBe(false);
    expect(falseClaim("0 errors\nerror budget: fine", "0 errors")).toBe(false);
  });

  it("does not flag a clean claim over an output with no error", () => {
    expect(falseClaim("all 12 tests passed", "no errors")).toBe(false);
  });

  it("does not flag a claim the output makes in another case", () => {
    expect(falseClaim("no errors in lint\n1 failed in test", "No errors")).toBe(false);
  });

  it("is not hidden by a longer word in the output that contains the claim", () => {
    expect(falseClaim("cleanup done\nFATAL: disk full", "clean")).toBe(true);
  });
});

describe("add", () => {
  it("counts an output with an error for false claims even when Claude referenced nothing", () => {
    const s = emptyScore();
    add(s, [], "step 1\nerror: boom", "0 errors");
    expect(s).toMatchObject({ calls: 0, pieces: 0, errorCalls: 1, falseClaims: 1 });
  });
});

describe("controls", () => {
  const raw = "first line here\nsrc/a/b.ts:12 failure in parseThing\nsrc/c/d.ts:40 failure in otherThing";
  const pieces = referenced(raw, raw, "bun test", "fix src/a/b.ts:12 parseThing then src/c/d.ts:40 otherThing");

  it("pass-through keeps every piece and the first line keeps none", () => {
    expect(pieces.length).toBeGreaterThan(0);
    expect(kept(pieces, raw)).toBe(pieces.length);
    expect(kept(pieces, firstLine(raw))).toBe(0);
  });

  it("hold when pass-through is perfect and the first line scores low", () => {
    const pass = emptyScore(), first = emptyScore();
    add(pass, pieces, raw, raw);
    add(first, pieces, raw, firstLine(raw));
    expect(controlsBroken(pass, first)).toBeNull();
  });

  it("fail when pass-through loses a piece", () => {
    const pass = emptyScore(), first = emptyScore();
    add(pass, pieces, raw, firstLine(raw));
    add(first, pieces, raw, firstLine(raw));
    expect(controlsBroken(pass, first)).toContain("pass-through");
  });

  it("fail when the first line scores at or above the ceiling", () => {
    const pass = emptyScore(), first = emptyScore();
    add(pass, pieces, raw, raw);
    add(first, pieces, raw, raw);
    expect(recall(first)).toBeGreaterThanOrEqual(CONTROL_CEILING);
    expect(controlsBroken(pass, first)).toContain("first-line");
  });

  it("fail when there is nothing to score", () => {
    expect(controlsBroken(emptyScore(), emptyScore())).toContain("nothing to score");
  });
});

describe("headBytes", () => {
  it("cuts to a byte budget", () => {
    expect(headBytes("abcdef", 3)).toBe("abc");
  });
});

describe("recordedBash follow-up", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const line = (o: object) => JSON.stringify(o);
  const bashUse = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
  const said = (id: string, content: object[]) => line({ message: { id, role: "assistant", content } });
  const result = (id: string, stdout: string) =>
    line({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: stdout }] }, toolUseResult: { stdout, stderr: "" } });

  it("collects the assistant turn after a result, including tool inputs, and stops at the next user line", () => {
    dir = mkdtempSync(join(tmpdir(), "fidelity-test-"));
    writeFileSync(join(dir, "s.jsonl"), [
      said("m1", [bashUse("a", "ls"), bashUse("b", "pwd")]),
      result("a", "src/x.ts"),
      result("b", "/home/u"),
      said("m2", [{ type: "text", text: "Reading src/x.ts" }]),
      said("m2", [{ type: "tool_use", id: "c", name: "Read", input: { file_path: "/home/u/src/x.ts" } }]),
      line({ message: { role: "user", content: "thanks" } }),
      said("m3", [{ type: "text", text: "unrelated later turn" }]),
    ].join("\n"));

    const { calls } = recordedBash(dir);
    expect(calls.map((c) => c.command)).toEqual(["ls", "pwd"]);
    expect(calls.map((c) => c.shown)).toEqual(["src/x.ts", "/home/u"]);
    for (const c of calls) {
      expect(c.followup).toBe("Reading src/x.ts\n/home/u/src/x.ts");
    }
  });

  it("does not take the issuing message's later blocks as the follow-up when results interleave", () => {
    dir = mkdtempSync(join(tmpdir(), "fidelity-test-"));
    writeFileSync(join(dir, "s.jsonl"), [
      said("m1", [bashUse("a", "ls")]),
      result("a", "src/x.ts"),
      said("m1", [bashUse("b", "cat src/y.ts")]),
      result("b", "export const y = 1"),
      said("m2", [{ type: "text", text: "Both read; src/x.ts next" }]),
    ].join("\n"));

    const { calls } = recordedBash(dir);
    expect(calls.map((c) => [c.command, c.followup])).toEqual([
      ["ls", "Both read; src/x.ts next"],
      ["cat src/y.ts", "Both read; src/x.ts next"],
    ]);
  });

  it("skips a result mcp-recall already compressed", () => {
    dir = mkdtempSync(join(tmpdir(), "fidelity-test-"));
    writeFileSync(join(dir, "s.jsonl"), [
      line({ message: { role: "assistant", content: [bashUse("a", "ls")] } }),
      result("a", "[recall:recall_0123abcd · 9KB→1KB]"),
    ].join("\n"));
    expect(recordedBash(dir)).toEqual({ calls: [], compressed: 1 });
  });
});
