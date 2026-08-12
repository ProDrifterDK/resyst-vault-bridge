#!/usr/bin/env node
/**
 * Repository-wide no-explicit-`any` gate with an exact reviewed allowlist.
 *
 * Detection is Biome's AST-based `suspicious/noExplicitAny` rule, invoked
 * with `--only=suspicious/noExplicitAny` so this gate never becomes a
 * duplicate general lint gate. The gate scans every tracked TypeScript
 * source and test file (plus untracked, non-ignored files so it works before
 * staging).
 *
 * Allowlist contract (`scripts/no-any-allowlist.txt`, initially empty):
 *
 *   <path>|<line>|<column>|<sha256>|<test-path>|<rationale>
 *
 * - path:      repo-relative path of the file carrying the exception.
 * - line:      1-based line of the `any` occurrence (Biome start line).
 * - column:    1-based column of the occurrence start (Biome start column).
 * - sha256:    lowercase hex SHA-256 of the exact source line (bytes up to
 *              but excluding the line terminator) at <path>:<line>.
 * - test-path: repo-relative path of a regression test that exercises the
 *              exception; must exist under tests/.
 * - rationale: nonempty free-text justification (the remainder of the line,
 *              so it may contain further `|` characters).
 *
 * An entry suppresses a violation only when path, line, column, and sha256
 * all match the current diagnostic exactly. No broad line-only suppression
 * exists. The gate fails when:
 *   - any entry is malformed (wrong field count, bad line/column, non-hex
 *     or wrong-length sha256, absolute or traversal path, absent test
 *     file, empty rationale, duplicate path|line|column key);
 *   - any entry is stale (no current violation matches it) or references a
 *     missing file;
 *   - any current violation has no matching entry.
 *
 * For every unmatched violation the gate prints a ready-to-review entry
 * skeleton ending with empty test-path and rationale fields.
 *
 * Usage:
 *   node scripts/check-no-any.mjs [--allowlist PATH] [PATH...]
 * Default allowlist: scripts/no-any-allowlist.txt.
 * Default targets: tracked + untracked .ts/.tsx files.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ALLOWLIST = path.join(ROOT, "scripts", "no-any-allowlist.txt");
const BIOME = path.join(ROOT, "node_modules", ".bin", "biome");
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Repo-relative form of a path reported by Biome (absolute when passed so). */
function repoRelative(file) {
  return path.isAbsolute(file) ? path.relative(ROOT, file) : file;
}

function trackedFiles() {
  const files = new Set();
  const scopes = [
    ["ls-files", "-z", "--", "*.ts", "*.tsx"],
    ["ls-files", "-z", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"],
  ];
  for (const args of scopes) {
    const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
    for (const file of out.split("\0")) {
      if (file.length > 0) files.add(file);
    }
  }
  return [...files].sort();
}

function sha256Line(file, line) {
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const text = lines[line - 1] ?? "";
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Parse and validate allowlist entries.
 * Returns { entries, errors } where entries is a Map keyed by
 * path|line|column and errors is a list of human-readable problems.
 */
function parseAllowlist(allowlistPath) {
  const entries = new Map();
  const errors = [];
  if (!existsSync(allowlistPath)) return { entries, errors };
  const lines = readFileSync(allowlistPath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    if (raw.length === 0) continue;
    const number = index + 1;
    const parts = raw.split("|");
    if (parts.length < 6) {
      errors.push(
        `allowlist ${number}: malformed entry (expected ` +
          "path|line|column|sha256|test-path|rationale): " +
          raw,
      );
      continue;
    }
    const [entryPath, lineText, columnText, sha, testPath, rationale] = parts;
    if (!entryPath || entryPath.startsWith("/") || entryPath.includes("\\")) {
      errors.push(`allowlist ${number}: path must be repo-relative: ${raw}`);
      continue;
    }
    const line = Number(lineText);
    const column = Number(columnText);
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      errors.push(`allowlist ${number}: line and column must be positive integers: ${raw}`);
      continue;
    }
    if (!SHA256_HEX.test(sha ?? "")) {
      errors.push(`allowlist ${number}: sha256 must be 64 lowercase hex chars: ${raw}`);
      continue;
    }
    if (!testPath || testPath.startsWith("/") || !testPath.startsWith("tests/")) {
      errors.push(`allowlist ${number}: test-path must be a repo-relative path under tests/: ${raw}`);
      continue;
    }
    if (!existsSync(path.join(ROOT, testPath))) {
      errors.push(`allowlist ${number}: test-path does not exist: ${testPath}`);
      continue;
    }
    if (!rationale || rationale.trim().length === 0) {
      errors.push(`allowlist ${number}: rationale must be nonempty: ${raw}`);
      continue;
    }
    const key = `${entryPath}|${line}|${column}`;
    if (entries.has(key)) {
      errors.push(`allowlist ${number}: duplicate entry for ${key}`);
      continue;
    }
    entries.set(key, { path: entryPath, line, column, sha, testPath, rationale });
  }
  return { entries, errors };
}

const args = process.argv.slice(2);
let allowlistPath = DEFAULT_ALLOWLIST;
const explicit = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  if (arg.startsWith("--allowlist=")) {
    allowlistPath = path.resolve(ROOT, arg.slice("--allowlist=".length));
  } else if (arg === "--allowlist") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--allowlist requires a value (use --allowlist PATH)");
    }
    allowlistPath = path.resolve(ROOT, value);
    index += 1;
  } else {
    explicit.push(arg);
  }
}

const targets = explicit.length > 0 ? explicit : trackedFiles();
if (targets.length === 0) {
  console.log("check:no-any passed: no TypeScript files to scan");
  process.exit(0);
}

let biomeExit = 0;
let diagnostics = [];
try {
  execFileSync(
    BIOME,
    ["lint", "--only=suspicious/noExplicitAny", "--reporter=json", ...targets],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
} catch (error) {
  biomeExit = error.status ?? 1;
  if (error.stdout) {
    try {
      diagnostics = JSON.parse(error.stdout).diagnostics ?? [];
    } catch {
      // Fall through: no parseable diagnostics, the gate still fails below.
    }
  }
}

const violations = [];
for (const diagnostic of diagnostics) {
  if (diagnostic.category !== "lint/suspicious/noExplicitAny") continue;
  const file = repoRelative(diagnostic.location?.path ?? "");
  const line = diagnostic.location?.start?.line;
  const column = diagnostic.location?.start?.column;
  if (Number.isInteger(line) && Number.isInteger(column)) {
    violations.push({ path: file, line, column });
  }
}

const { entries, errors } = parseAllowlist(allowlistPath);
let failed = errors.length > 0;
for (const error of errors) console.error(`check:no-any allowlist error: ${error}`);

// Every violation must be covered by an exact matching entry.
const consumed = new Set();
for (const violation of violations) {
  const file = path.join(ROOT, violation.path);
  const lineHash = existsSync(file) ? sha256Line(file, violation.line) : "";
  const key = `${violation.path}|${violation.line}|${violation.column}`;
  const entry = entries.get(key);
  if (entry && entry.sha === lineHash) {
    consumed.add(key);
    continue;
  }
  failed = true;
  console.error(
    `explicit \`any\` at ${violation.path}:${violation.line}:${violation.column}`,
  );
  console.error(
    `  required allowlist entry: ${violation.path}|${violation.line}|${violation.column}|${lineHash}||`,
  );
}

// Every allowlist entry must be consumed by a current violation.
for (const [key, entry] of entries) {
  if (consumed.has(key)) continue;
  failed = true;
  console.error(
    `check:no-any allowlist error: stale or missing entry ` +
      `${entry.path}:${entry.line}:${entry.column} ` +
      `(no current violation matches; test: ${entry.testPath})`,
  );
}

// Fail closed when Biome errored without emitting parseable diagnostics.
if (biomeExit !== 0 && violations.length === 0) {
  failed = true;
  console.error(
    "check:no-any error: Biome exited with an error but produced no " +
      "parseable noExplicitAny diagnostics",
  );
}

if (failed) {
  console.error(
    "check:no-any failed: explicit `any` found by Biome or allowlist is " +
      "malformed/stale (see diagnostics above)",
  );
  process.exit(1);
}
console.log(
  "check:no-any passed: Biome found no explicit `any` in tracked source or tests",
);
