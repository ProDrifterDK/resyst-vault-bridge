import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Behavioral tests for the `check:no-any` gate and its exact reviewed
 * allowlist contract (`scripts/no-any-allowlist.txt`, initially empty).
 *
 * Detection is Biome's AST-based `suspicious/noExplicitAny` rule, so the
 * token is left alone inside comments and strings. Exceptions are allowed
 * only through exact fingerprinted entries
 * `path|line|column|sha256|test-path|rationale`; malformed, broad, stale,
 * duplicate, and test-less entries must fail the gate. No real exception is
 * ever committed: every fixture entry lives in a temporary allowlist under
 * the probe directory and is removed by cleanup.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const GATE_SCRIPT = path.join(REPO_ROOT, "scripts", "check-no-any.mjs");
const BAD_LINE = "export const probe: any = 1;\n";
const REAL_TEST = "tests/unit/check-no-any.test.ts";

let probeDir: string;

beforeAll(() => {
  probeDir = mkdtempSync(path.join(REPO_ROOT, "src", ".noany-probe-"));
});

afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

function runGate(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [GATE_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stderr?: string };
    return { status: err.status ?? 1, stderr: err.stderr ?? "" };
  }
}

/** Write a probe file inside the temporary probe directory. */
function writeProbe(name: string, content: string): string {
  const file = path.join(probeDir, name);
  writeFileSync(file, content);
  return file;
}

/** SHA-256 of one source line (bytes excluding the line terminator). */
function sha256Line(line: string): string {
  return createHash("sha256")
    .update(line.replace(/\r?\n$/, ""), "utf8")
    .digest("hex");
}

describe("check:no-any gate", () => {
  it("passes files where the token appears only in comments and strings", () => {
    const ok = writeProbe(
      "ok.ts",
      [
        "// A comment may mention `any` as a word: any comment is fine.",
        'const note = "the string any is not a type annotation";',
        "export const value: string = note;",
        "",
      ].join("\n"),
    );
    expect(runGate([ok]).status).toBe(0);
  });

  it("fails on an explicit type-any in a source file", () => {
    const bad = writeProbe("bad.ts", BAD_LINE);
    const result = runGate([bad]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required allowlist entry:");
  });

  it("fails repo-wide when an untracked source file contains explicit type-any", () => {
    writeProbe("repo-wide-bad.ts", "export function probe(): any { return 1; }\n");
    expect(runGate([]).status).toBe(1);
  });

  it("passes repo-wide once the offending files are removed", () => {
    for (const file of readdirSync(probeDir)) {
      rmSync(path.join(probeDir, file), { force: true });
    }
    expect(runGate([]).status).toBe(0);
  });

  it("rejects a malformed allowlist entry", () => {
    const bad = writeProbe("malformed.ts", BAD_LINE);
    const allowlist = path.join(probeDir, "allow-malformed.txt");
    writeFileSync(
      allowlist,
      "src/whatever.ts|1|21|not-a-sha|tests/unit/check-no-any.test.ts|why\n",
    );
    const result = runGate(["--allowlist", allowlist, bad]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sha256 must be 64 lowercase hex");
  });

  it("rejects a broad line-only allowlist entry", () => {
    const bad = writeProbe("broad.ts", BAD_LINE);
    const allowlist = path.join(probeDir, "allow-broad.txt");
    writeFileSync(allowlist, `${path.relative(REPO_ROOT, bad)}|1\n`);
    const result = runGate(["--allowlist", allowlist, bad]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("malformed entry");
  });

  it("rejects a stale allowlist entry with no matching violation", () => {
    const ok = writeProbe("stale-ok.ts", 'export const fine: string = "x";\n');
    const allowlist = path.join(probeDir, "allow-stale.txt");
    const rel = path.relative(REPO_ROOT, ok);
    const entry = `${rel}|1|1|${sha256Line('export const fine: string = "x";')}|${REAL_TEST}|stale probe`;
    writeFileSync(allowlist, `${entry}\n`);
    const result = runGate(["--allowlist", allowlist, ok]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale or missing entry");
  });

  it("rejects duplicate allowlist entries", () => {
    const bad = writeProbe("dup.ts", BAD_LINE);
    const allowlist = path.join(probeDir, "allow-dup.txt");
    const rel = path.relative(REPO_ROOT, bad);
    const entry = `${rel}|1|21|${sha256Line(BAD_LINE)}|${REAL_TEST}|dup probe`;
    writeFileSync(allowlist, `${entry}\n${entry}\n`);
    const result = runGate(["--allowlist", allowlist, bad]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicate entry");
  });

  it("rejects an entry whose regression-test path is absent", () => {
    const bad = writeProbe("no-test.ts", BAD_LINE);
    const allowlist = path.join(probeDir, "allow-notest.txt");
    const rel = path.relative(REPO_ROOT, bad);
    const entry = `${rel}|1|21|${sha256Line(BAD_LINE)}|tests/does-not-exist.test.ts|no test`;
    writeFileSync(allowlist, `${entry}\n`);
    const result = runGate(["--allowlist", allowlist, bad]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("test-path does not exist");
  });

  it("accepts an exact fingerprinted allowlist entry", () => {
    const bad = writeProbe("exact.ts", BAD_LINE);
    const first = runGate([bad]);
    expect(first.status).toBe(1);
    const match = /required allowlist entry: (\S+)/.exec(first.stderr);
    expect(match).not.toBeNull();
    const skeleton = match?.[1] ?? "";
    const entry = `${skeleton.slice(0, -2)}|${REAL_TEST}|test-only fixture`;
    const allowlist = path.join(probeDir, "allow-exact.txt");
    writeFileSync(allowlist, `${entry}\n`);
    const second = runGate(["--allowlist", allowlist, bad]);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain("required allowlist entry:");
  });
});
