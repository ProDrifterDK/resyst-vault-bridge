import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Behavioral tests for the `check:no-any` gate and its exact reviewed
 * allowlist contract (`scripts/no-any-allowlist.txt`, initially empty).
 *
 * Detection is Biome's AST-based `suspicious/noExplicitAny` rule, so the
 * token is left alone inside comments and strings. Exceptions are allowed
 * only through exact fingerprinted entries
 * `path|line|column|sha256|test-path|rationale`; malformed, broad, stale,
 * duplicate, test-less, and traversal entries must fail the gate.
 *
 * Every probe file lives in a per-test temporary directory created inside
 * src/ and is removed in a `finally` block, so a failed assertion cannot
 * leave probe files behind. No real exception is ever committed: fixture
 * allowlists are temporary and the committed allowlist stays empty.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const GATE_SCRIPT = path.join(REPO_ROOT, "scripts", "check-no-any.mjs");
const BAD_LINE = "export const probe: any = 1;\n";
const REAL_TEST = "tests/unit/check-no-any.test.ts";

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

/** SHA-256 of one source line (bytes excluding the line terminator). */
function sha256Line(line: string): string {
  return createHash("sha256")
    .update(line.replace(/\r?\n$/, ""), "utf8")
    .digest("hex");
}

/**
 * Run a test body with a private temporary probe directory under src/,
 * removing the directory (and every probe file inside it) in `finally`.
 */
function withProbeDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(REPO_ROOT, "src", ".noany-probe-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("check:no-any gate", () => {
  it("passes files where the token appears only in comments and strings", () => {
    withProbeDir((dir) => {
      const ok = path.join(dir, "ok.ts");
      writeFileSync(
        ok,
        [
          "// A comment may mention `any` as a word: any comment is fine.",
          'const note = "the string any is not a type annotation";',
          "export const value: string = note;",
          "",
        ].join("\n"),
      );
      expect(runGate([ok]).status).toBe(0);
    });
  });

  it("fails on an explicit type-any in a source file", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "bad.ts");
      writeFileSync(bad, BAD_LINE);
      const result = runGate([bad]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("required allowlist entry:");
    });
  });

  it("fails repo-wide when an untracked source file contains explicit type-any", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "repo-wide-bad.ts");
      writeFileSync(bad, "export function probe(): any { return 1; }\n");
      expect(runGate([]).status).toBe(1);
    });
  });

  it("passes repo-wide when no probe files remain", () => {
    expect(runGate([]).status).toBe(0);
  });

  it("rejects a malformed allowlist entry", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "malformed.ts");
      writeFileSync(bad, BAD_LINE);
      const allowlist = path.join(dir, "allow-malformed.txt");
      writeFileSync(
        allowlist,
        "src/whatever.ts|1|21|not-a-sha|tests/unit/check-no-any.test.ts|why\n",
      );
      const result = runGate(["--allowlist", allowlist, bad]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("sha256 must be 64 lowercase hex");
    });
  });

  it("rejects a broad line-only allowlist entry", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "broad.ts");
      writeFileSync(bad, BAD_LINE);
      const allowlist = path.join(dir, "allow-broad.txt");
      const rel = path.relative(REPO_ROOT, bad);
      writeFileSync(allowlist, `${rel}|1\n`);
      const result = runGate(["--allowlist", allowlist, bad]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("malformed entry");
    });
  });

  it("rejects a stale allowlist entry with no matching violation", () => {
    withProbeDir((dir) => {
      const ok = path.join(dir, "stale-ok.ts");
      writeFileSync(ok, 'export const fine: string = "x";\n');
      const allowlist = path.join(dir, "allow-stale.txt");
      const rel = path.relative(REPO_ROOT, ok);
      const entry = `${rel}|1|1|${sha256Line('export const fine: string = "x";')}|${REAL_TEST}|stale probe`;
      writeFileSync(allowlist, `${entry}\n`);
      const result = runGate(["--allowlist", allowlist, ok]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stale or missing entry");
    });
  });

  it("rejects duplicate allowlist entries", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "dup.ts");
      writeFileSync(bad, BAD_LINE);
      const allowlist = path.join(dir, "allow-dup.txt");
      const rel = path.relative(REPO_ROOT, bad);
      const entry = `${rel}|1|21|${sha256Line(BAD_LINE)}|${REAL_TEST}|dup probe`;
      writeFileSync(allowlist, `${entry}\n${entry}\n`);
      const result = runGate(["--allowlist", allowlist, bad]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("duplicate entry");
    });
  });

  it("rejects an entry whose regression-test path is absent", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "no-test.ts");
      writeFileSync(bad, BAD_LINE);
      const allowlist = path.join(dir, "allow-notest.txt");
      const rel = path.relative(REPO_ROOT, bad);
      const entry = `${rel}|1|21|${sha256Line(BAD_LINE)}|tests/does-not-exist.test.ts|no test`;
      writeFileSync(allowlist, `${entry}\n`);
      const result = runGate(["--allowlist", allowlist, bad]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("test-path does not exist");
    });
  });

  it("rejects a source path that traverses outside the repository", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "traversal.ts");
      writeFileSync(bad, BAD_LINE);
      const allowlist = path.join(dir, "allow-traversal.txt");
      const entry = `../escape.ts|1|21|${sha256Line(BAD_LINE)}|${REAL_TEST}|traversal probe`;
      writeFileSync(allowlist, `${entry}\n`);
      const result = runGate(["--allowlist", allowlist, bad]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dotdot segments");
    });
  });

  it("rejects a test path that traverses outside the tests directory", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "test-traversal.ts");
      writeFileSync(bad, BAD_LINE);
      const allowlist = path.join(dir, "allow-test-traversal.txt");
      const rel = path.relative(REPO_ROOT, bad);
      const entry = `${rel}|1|21|${sha256Line(BAD_LINE)}|tests/../../escape.test.ts|traversal probe`;
      writeFileSync(allowlist, `${entry}\n`);
      const result = runGate(["--allowlist", allowlist, bad]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dotdot segments");
    });
  });

  it("rejects non-TypeScript source and test paths", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "ext.ts");
      writeFileSync(bad, BAD_LINE);
      const allowlist = path.join(dir, "allow-ext.txt");
      const entry = `src/notes.txt|1|21|${sha256Line(BAD_LINE)}|tests/unit/notes.txt|ext probe`;
      writeFileSync(allowlist, `${entry}\n`);
      const result = runGate(["--allowlist", allowlist, bad]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must end with");
    });
  });

  it("keeps lint and check:no-any coherent for an allowed exception", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "interaction.ts");
      writeFileSync(bad, BAD_LINE);

      // The zero-exception default still fails repo-wide.
      expect(runGate([]).status).toBe(1);

      // `npm run lint` owns every rule except noExplicitAny and must pass
      // even while the probe file exists, because check:no-any is the sole
      // exception authority for the `any` rule.
      execFileSync("npm", ["run", "lint", "--silent"], {
        cwd: REPO_ROOT,
        stdio: "pipe",
        encoding: "utf8",
      });

      // With the exact fingerprinted exception, check:no-any also passes.
      const first = runGate([bad]);
      const match = /required allowlist entry: (\S+)/.exec(first.stderr);
      expect(match).not.toBeNull();
      const skeleton = match?.[1] ?? "";
      const entry = `${skeleton.slice(0, -2)}|${REAL_TEST}|test-only fixture`;
      const allowlist = path.join(dir, "allow-interaction.txt");
      writeFileSync(allowlist, `${entry}\n`);
      const second = runGate(["--allowlist", allowlist, bad]);
      expect(second.status).toBe(0);
    });
  });

  it("accepts an exact fingerprinted allowlist entry", () => {
    withProbeDir((dir) => {
      const bad = path.join(dir, "exact.ts");
      writeFileSync(bad, BAD_LINE);
      const first = runGate([bad]);
      expect(first.status).toBe(1);
      const match = /required allowlist entry: (\S+)/.exec(first.stderr);
      expect(match).not.toBeNull();
      const skeleton = match?.[1] ?? "";
      const entry = `${skeleton.slice(0, -2)}|${REAL_TEST}|test-only fixture`;
      const allowlist = path.join(dir, "allow-exact.txt");
      writeFileSync(allowlist, `${entry}\n`);
      const second = runGate(["--allowlist", allowlist, bad]);
      expect(second.status).toBe(0);
      expect(second.stderr).not.toContain("required allowlist entry:");
    });
  });
});
