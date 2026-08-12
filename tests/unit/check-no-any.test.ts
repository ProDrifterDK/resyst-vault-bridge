import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Behavioral tests for the `check:no-any` gate.
 *
 * The gate is Biome's AST-based `noExplicitAny` rule run over every tracked
 * TypeScript source and test file. AST-based detection must catch explicit
 * type `any` while leaving the token alone inside comments and strings.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const GATE_SCRIPT = path.join(REPO_ROOT, "scripts", "check-no-any.mjs");

let probeDir: string;

beforeAll(() => {
  probeDir = mkdtempSync(path.join(REPO_ROOT, "src", ".noany-probe-"));
});

afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

function runGate(args: string[]): number {
  try {
    execFileSync(process.execPath, [GATE_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

describe("check:no-any gate", () => {
  it("passes files where the token appears only in comments and strings", () => {
    const ok = path.join(probeDir, "ok.ts");
    writeFileSync(
      ok,
      [
        "// A comment may mention `any` as a word: any comment is fine.",
        'const note = "the string any is not a type annotation";',
        "export const value: string = note;",
        "",
      ].join("\n"),
    );
    expect(runGate([ok])).toBe(0);
  });

  it("fails on an explicit type-any in a source file", () => {
    const bad = path.join(probeDir, "bad.ts");
    writeFileSync(bad, "export const probe: any = 1;\n");
    expect(runGate([bad])).toBe(1);
  });

  it("fails repo-wide when an untracked source file contains explicit type-any", () => {
    const bad = path.join(probeDir, "repo-wide-bad.ts");
    writeFileSync(bad, "export function probe(): any { return 1; }\n");
    expect(runGate([])).toBe(1);
  });

  it("passes repo-wide once the offending file is removed", () => {
    rmSync(probeDir, { recursive: true, force: true });
    expect(runGate([])).toBe(0);
  });
});
