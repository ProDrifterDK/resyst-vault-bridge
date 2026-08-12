#!/usr/bin/env node
/**
 * Gate that fails on explicit `any` in TypeScript source and test files.
 *
 * Scans git-tracked `.ts`/`.tsx` files (plus untracked, non-ignored ones so
 * the gate works before staging) for the standalone token `any` and fails on
 * the first match.
 *
 * Exclusions live in the exact, reviewed allowlist file
 * `scripts/no-any-allowlist.txt` (initially empty). Each line names one
 * exact occurrence as `path:line` (1-based, relative to the repository
 * root). Adding an exclusion requires explicit review: the file documents
 * why the occurrence is a reviewed exception rather than an escape hatch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = path.join(ROOT, "scripts", "no-any-allowlist.txt");

/** Match the standalone token `any`, including in type positions. */
const EXPLICIT_ANY = /\bany\b/;

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

function loadAllowlist() {
  const entries = new Set();
  if (!existsSync(ALLOWLIST_PATH)) return entries;
  for (const line of readFileSync(ALLOWLIST_PATH, "utf8").split(/\r?\n/)) {
    const entry = line.trim();
    if (entry.length === 0 || entry.startsWith("#")) continue;
    entries.add(entry);
  }
  return entries;
}

let violations = 0;
const allowlist = loadAllowlist();
for (const file of trackedFiles()) {
  const content = readFileSync(path.join(ROOT, file), "utf8");
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!EXPLICIT_ANY.test(lines[index] ?? "")) continue;
    const location = `${file}:${index + 1}`;
    if (allowlist.has(location)) continue;
    violations += 1;
    console.error(`explicit \`any\` at ${location}`);
  }
}

if (violations > 0) {
  console.error(
    `check:no-any failed with ${violations} occurrence(s); ` +
      "fix the code or add a reviewed entry to scripts/no-any-allowlist.txt",
  );
  process.exit(1);
}
console.log("check:no-any passed: no explicit `any` in tracked source or tests");
