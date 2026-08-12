#!/usr/bin/env node
/**
 * Repository-wide no-explicit-`any` gate.
 *
 * Runs Biome's AST-based `noExplicitAny` rule over every tracked TypeScript
 * source and test file (plus untracked, non-ignored files so the gate works
 * before staging). AST-based detection cannot be fooled by comments or
 * string literals, and passing the explicit file list keeps coverage
 * repository-wide regardless of Biome configuration includes.
 *
 * Usage:
 *   node scripts/check-no-any.mjs            # scan tracked + untracked .ts/.tsx
 *   node scripts/check-no-any.mjs <path>...  # scan exactly the given paths
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIOME = path.join(ROOT, "node_modules", ".bin", "biome");

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

const explicit = process.argv.slice(2);
const targets = explicit.length > 0 ? explicit : trackedFiles();

if (targets.length === 0) {
  console.log("check:no-any passed: no TypeScript files to scan");
  process.exit(0);
}

try {
  execFileSync(BIOME, ["lint", ...targets], { cwd: ROOT, stdio: "inherit" });
} catch {
  console.error(
    "check:no-any failed: explicit `any` found by Biome (see diagnostics above)",
  );
  process.exit(1);
}
console.log(
  "check:no-any passed: Biome found no explicit `any` in tracked source or tests",
);
