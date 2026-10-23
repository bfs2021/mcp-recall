import type { CompressionResult, Handler } from "./types";
import { shellHandler } from "./shell";
import { bashOutputText, extractStdout, MAX_LOG_COMMITS } from "./bash-shared";

// ---------------------------------------------------------------------------
// git diff / git show
// ---------------------------------------------------------------------------

interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  hunks: number;
}

export function parseGitDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      const path = match ? match[1]! : line.slice(11);
      current = { path, additions: 0, deletions: 0, hunks: 0 };
    } else if (current) {
      if (line.startsWith("@@ ")) {
        current.hunks++;
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        current.additions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        current.deletions++;
      }
    }
  }
  if (current) files.push(current);
  return files;
}

export const gitDiffHandler: Handler = (
  toolName: string,
  output: unknown
): CompressionResult => {
  const stdout = extractStdout(output);
  const originalSize = Buffer.byteLength(bashOutputText(output), "utf8");

  if (!stdout.trim()) {
    return { summary: "[git diff — no changes]", originalSize };
  }

  const files = parseGitDiff(stdout);

  if (files.length === 0) {
    // Binary diff, submodule change, or unusual output — fall back to shell
    return shellHandler(toolName, output);
  }

  const totalAdded = files.reduce((s, f) => s + f.additions, 0);
  const totalDeleted = files.reduce((s, f) => s + f.deletions, 0);
  const header = `git diff — ${files.length} file${files.length === 1 ? "" : "s"} changed, +${totalAdded} -${totalDeleted}`;

  const fileLines = files.map((f) => {
    const stats = `+${f.additions} -${f.deletions}`;
    const hunks = `(${f.hunks} hunk${f.hunks === 1 ? "" : "s"})`;
    return `  ${f.path.padEnd(48)}  ${stats.padEnd(10)}  ${hunks}`;
  });

  return { summary: [header, ...fileLines].join("\n"), originalSize };
};

// ---------------------------------------------------------------------------
// git log
// ---------------------------------------------------------------------------

export const gitLogHandler: Handler = (
  toolName: string,
  output: unknown
): CompressionResult => {
  const stdout = extractStdout(output);
  const originalSize = Buffer.byteLength(bashOutputText(output), "utf8");

  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    return { summary: "[git log — no commits]", originalSize };
  }

  // Detect --oneline / --format="%h %s" style: every line starts with a short hash
  const isOneline = lines.every((l) => /^[0-9a-f]{6,40}\s/.test(l.trim()));

  if (isOneline) {
    const total = lines.length;
    const shown = lines.slice(0, MAX_LOG_COMMITS);
    const overflow =
      total > MAX_LOG_COMMITS ? `\n… (+${total - MAX_LOG_COMMITS} more commits)` : "";
    const summary =
      `git log — ${total} commit${total === 1 ? "" : "s"}\n` +
      shown.map((l) => `  ${l}`).join("\n") +
      overflow;
    return { summary, originalSize };
  }

  // Full format: extract short hash + subject line from each "commit <hash>" block.
  // Skip known git header lines (Author:, Date:, Merge:, gpgsig continuation lines
  // starting with a space) so GPG-signed commits parse correctly.
  const commits: string[] = [];
  let hash = "";
  let seenBlank = false;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("commit ")) {
      hash = line.slice(7, 14);
      seenBlank = false;
    } else if (hash && !seenBlank && (
      line.startsWith("Author:") ||
      line.startsWith("Date:") ||
      line.startsWith("Merge:") ||
      line.startsWith("gpgsig ") ||
      (line.startsWith(" ") && line.trim() !== "")  // gpgsig continuation lines
    )) {
      // skip git metadata headers before the blank separator
    } else if (hash && line.trim() === "" && !seenBlank) {
      seenBlank = true;
    } else if (hash && seenBlank && line.startsWith("    ") && line.trim()) {
      const subject = line.trim().slice(0, 72);
      commits.push(`  ${hash}  ${subject}`);
      hash = "";
      seenBlank = false;
    }
  }

  // A custom --format/--pretty parses to nothing; a count is only stated when parsed (#350)
  if (commits.length === 0) return shellHandler(toolName, output);

  const total = commits.length;
  const shown = commits.slice(0, MAX_LOG_COMMITS);
  const overflow =
    total > MAX_LOG_COMMITS ? `\n… (+${total - MAX_LOG_COMMITS} more commits)` : "";
  const header = `git log — ${total} commit${total === 1 ? "" : "s"}`;
  return {
    summary: [header, ...shown].join("\n") + overflow,
    originalSize,
  };
};

// ---------------------------------------------------------------------------
// git status
// ---------------------------------------------------------------------------

// Paths listed per category before the rest are counted. git status is usually
// short, and the paths are what Claude acts on (#352: a 5-path cap dropped them).
const MAX_STATUS_PATHS = 50;

// Unmerged pairs in porcelain v1 (git-status(1), "Short Format").
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const LONG_CONFLICT = /^(both modified|both added|both deleted|added by us|added by them|deleted by us|deleted by them):\s*/;
const LONG_ENTRY = /^(modified|new file|deleted|renamed|copied|typechange):\s*/;
// Kept verbatim: the branch, its upstream and ahead/behind are often why status was run.
const BRANCH_LINE = /^(On branch |HEAD detached |Your branch |## )/;

interface StatusParts { branch: string[]; staged: string[]; unstaged: string[]; untracked: string[]; conflicts: string[] }

/**
 * One porcelain v1 line: two status columns, a space, the path. Matched on the
 * untrimmed line, since a blank first column (" M file", changed but unstaged) is
 * the most common entry.
 */
function parsePorcelain(line: string, parts: StatusParts): boolean {
  const m = line.match(/^([ MTADRCU?!])([ MTADRCU?!]) (.+)$/);
  if (!m) return false;
  const [, x, y, path] = m as [string, string, string, string];
  if (CONFLICT_CODES.has(x + y)) parts.conflicts.push(`${x}${y} ${path}`);
  else if (x === "?") parts.untracked.push(path);
  else if (x !== "!") {
    if (x !== " ") parts.staged.push(`${x} ${path}`);
    if (y !== " ") parts.unstaged.push(`${y} ${path}`);
  }
  return true;
}

function parseStatus(stdout: string): StatusParts {
  const parts: StatusParts = { branch: [], staged: [], unstaged: [], untracked: [], conflicts: [] };
  let section: "staged" | "unstaged" | "untracked" | "unmerged" | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (BRANCH_LINE.test(trimmed)) { parts.branch.push(trimmed); continue; }
    if (trimmed.startsWith("Changes to be committed")) { section = "staged"; continue; }
    if (trimmed.startsWith("Changes not staged")) { section = "unstaged"; continue; }
    if (trimmed.startsWith("Untracked files")) { section = "untracked"; continue; }
    if (trimmed.startsWith("Unmerged paths")) { section = "unmerged"; continue; }
    if (!trimmed || trimmed.startsWith("(") || trimmed.startsWith("no changes") || trimmed.startsWith("nothing")) continue;
    // Long-format entries are tab-indented, so a porcelain line never starts with a tab.
    if (!line.startsWith("\t") && parsePorcelain(line, parts)) continue;
    if (LONG_CONFLICT.test(trimmed)) parts.conflicts.push(trimmed.replace(LONG_CONFLICT, ""));
    else if ((section === "staged" || section === "unstaged") && LONG_ENTRY.test(trimmed)) parts[section].push(trimmed.replace(LONG_ENTRY, ""));
    else if (section === "untracked") parts.untracked.push(trimmed);
  }
  return parts;
}

const pathList = (label: string, paths: string[]): string =>
  `  ${label} (${paths.length}): ${paths.slice(0, MAX_STATUS_PATHS).join(", ")}${paths.length > MAX_STATUS_PATHS ? ` +${paths.length - MAX_STATUS_PATHS} more` : ""}`;

export const gitStatusHandler: Handler = (
  toolName: string,
  output: unknown
): CompressionResult => {
  const stdout = extractStdout(output);
  const originalSize = Buffer.byteLength(bashOutputText(output), "utf8");

  if (!stdout.trim()) {
    return { summary: "[git status — clean working tree]", originalSize };
  }

  const parts = parseStatus(stdout);
  const { branch, staged, unstaged, untracked, conflicts } = parts;
  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && conflicts.length === 0) {
    // Couldn't parse — fall back to shell
    return shellHandler(toolName, output);
  }

  const lines = ["git status", ...branch.map((b) => `  ${b}`)];
  if (conflicts.length > 0) lines.push(pathList("conflicts", conflicts));
  if (staged.length > 0) lines.push(pathList("staged", staged));
  if (unstaged.length > 0) lines.push(pathList("unstaged", unstaged));
  if (untracked.length > 0) lines.push(pathList("untracked", untracked));

  return { summary: lines.join("\n"), originalSize };
};

// ---------------------------------------------------------------------------
// git branch / stash list / remote -v — long ref listings
// ---------------------------------------------------------------------------

const MAX_REFS = 25;

export const gitRefsHandler: Handler = (
  toolName: string,
  output: unknown
): CompressionResult => {
  const stdout = extractStdout(output);
  const originalSize = Buffer.byteLength(bashOutputText(output), "utf8");
  const lines = stdout.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return shellHandler(toolName, output);

  // git stash list: "stash@{0}: WIP on ..."
  if (lines.filter((l) => /^stash@\{\d+\}:/.test(l.trim())).length >= Math.ceil(lines.length * 0.5)) {
    const shown = lines.slice(0, MAX_REFS).map((l) => `  ${l.trim().slice(0, 100)}`);
    const overflow = lines.length > MAX_REFS ? [`  … (+${lines.length - MAX_REFS} more)`] : [];
    return { summary: [`git stash — ${lines.length} entr${lines.length === 1 ? "y" : "ies"}`, ...shown, ...overflow].join("\n"), originalSize };
  }

  // git remote -v: "origin\tgit@...\t(fetch)"
  if (lines.filter((l) => /\((fetch|push)\)\s*$/.test(l)).length >= Math.ceil(lines.length * 0.5)) {
    const remotes = new Map<string, string>();
    for (const l of lines) {
      const m = l.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
      if (m) remotes.set(m[1]!, m[2]!);
    }
    const shown = [...remotes].slice(0, MAX_REFS).map(([n, u]) => `  ${n} → ${u.slice(0, 80)}`);
    const overflow = remotes.size > MAX_REFS ? [`  … (+${remotes.size - MAX_REFS} more)`] : [];
    return { summary: [`git remote — ${remotes.size} remote${remotes.size === 1 ? "" : "s"}`, ...shown, ...overflow].join("\n"), originalSize };
  }

  // git branch: "* main" / "  feat/x" / "  remotes/origin/y". A branch line is
  // the leading marker (`* `/`+ `/spaces) followed by a single whitespace-free ref.
  const refOf = (l: string) => l.replace(/^[*+]?\s*/, "").trim();
  const branchLines = lines.filter((l) => {
    const r = refOf(l);
    return r.length > 0 && !/\s/.test(r);
  });
  if (branchLines.length >= Math.ceil(lines.length * 0.5)) {
    const current = lines.find((l) => l.trimStart().startsWith("* "));
    const remotes = branchLines.filter((l) => l.includes("remotes/")).length;
    const local = branchLines.length - remotes;
    const header = `git branch — ${local} local${remotes ? `, ${remotes} remote` : ""}${current ? ` (on ${current.replace(/^\s*\*\s*/, "").trim()})` : ""}`;
    const shown = branchLines.slice(0, MAX_REFS).map((l) => `  ${l.trim().slice(0, 80)}`);
    const overflow = branchLines.length > MAX_REFS ? [`  … (+${branchLines.length - MAX_REFS} more)`] : [];
    return { summary: [header, ...shown, ...overflow].join("\n"), originalSize };
  }

  return shellHandler(toolName, output);
};
