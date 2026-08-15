import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVault } from "../fixtures/create-vault.js";

const roots: string[] = [];
let vaultRoot = "";
let xdgConfig = "";
let xdgState = "";
let environment: Record<string, string | undefined>;
const cli = path.resolve("dist/cli.js");

interface Invocation { status: number | null; stdout: string; stderr: string; lines: Array<Record<string, unknown>>; }
function invoke(args: string[], body?: unknown | unknown[]): Invocation {
  const input = body === undefined ? "" : `${(Array.isArray(body) ? body : [body]).map((value) => JSON.stringify(value)).join("\n")}\n`;
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: path.resolve("."), env: environment, encoding: "utf8", input, timeout: 15_000 });
  const stdout = result.stdout ?? "";
  return { status: result.status, stdout, stderr: result.stderr ?? "", lines: stdout.trim().length === 0 ? [] : stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) };
}
function invokeRaw(args: string[], input: string, env: NodeJS.ProcessEnv = environment): Invocation {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: path.resolve("."), env, encoding: "utf8", input, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  const stdout = result.stdout ?? "";
  return { status: result.status, stdout, stderr: result.stderr ?? "", lines: stdout.trim().length === 0 ? [] : stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) };
}

function checkpoint(date: string): Record<string, unknown> {
  return {
    version: 1, kind: "apply",
    source: { agent: "prime-agent", host_id: "casey", session_id: "cli-atlas", cwd: "/home/tester/synthetic/atlas" },
    project: { id: "atlas" },
    knowledge: { completed_tasks: [{ text: "Completed CLI integration", evidence: ["cli-test"] }], decisions: [], status_changes: [], blockers: [], reusable_learnings: [], next_steps: [] },
    evidence: { commits: [], tests: [{ id: "cli-test", value: "CLI integration passed" }], files: [], deployments: [], observations: [] },
    targets: { daily: true, project: false, landscape: false },
    _date: date,
  };
}

beforeAll(async () => {
  const build = spawnSync("npm", ["run", "build"], { cwd: path.resolve("."), encoding: "utf8", timeout: 30_000 });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr || build.stdout}`);
  vaultRoot = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-vault-")); roots.push(vaultRoot);
  await createVault({ vaultPath: vaultRoot, withDailyNote: true, withProjectNote: true, dailyNoteDate: "2026-08-11" });
  xdgConfig = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-config-")); roots.push(xdgConfig);
  xdgState = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-state-")); roots.push(xdgState);
  await mkdir(path.join(xdgConfig, "resyst-vault"), { recursive: true });
  await writeFile(path.join(xdgConfig, "resyst-vault", "config.json"), JSON.stringify({ version: 1, host_id: "casey", vault_path: vaultRoot, project_overrides: [] }), "utf8");
  environment = { ...process.env, XDG_CONFIG_HOME: xdgConfig, XDG_STATE_HOME: xdgState, NO_COLOR: "1" };
  delete environment.FORCE_COLOR;
}, 45_000);
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

describe("stable JSON CLI", () => {
  it("exposes doctor, status, search, read, bootstrap and recover as one-line no-color JSON", () => {
    const doctor = invoke(["doctor"]); expect(doctor.status).toBe(0); expect(doctor.lines[0]).toMatchObject({ version: 1, command: "doctor" });
    const status = invoke(["status"]); expect(status.status).toBe(0); expect(status.lines[0]).toMatchObject({ outcome: "ok", recovery_required: false });
    const search = invoke(["search"], { query: "Atlas", limit: 3 }); expect(search.status).toBe(0); expect(search.lines[0]).toMatchObject({ command: "search", outcome: "ok" });
    const read = invoke(["read"], { path: "Proyectos/Atlas.md" }); expect(read.status).toBe(0); expect(read.lines[0]).toMatchObject({ command: "read", outcome: "ok", path: "Proyectos/Atlas.md" }); expect(read.lines[0]?.content).toContain("Atlas");
    const bootstrap = invoke(["bootstrap"], { notes: { claude: null, current_daily: null, project: null, moc: null }, project: { kind: "unresolved", reason: "no_match" }, budget_tokens: 5000 }); expect(bootstrap.status).toBe(0); expect(bootstrap.lines[0]).toMatchObject({ command: "bootstrap", outcome: "ok", version: 1 });
    const recover = invoke(["recover"]); expect(recover.status).toBe(0); expect(recover.lines[0]).toMatchObject({ command: "recover", outcome: "nothing_pending" });
    for (const item of [doctor, status, search, read, bootstrap, recover]) { expect(item.stdout.endsWith("\n")).toBe(true); expect(item.stdout.trim().split("\n")).toHaveLength(1); expect(item.stdout).not.toMatch(/\u001b\[/u); }
  });

  it("accepts JSON Lines, rejects malformed input with exit 2, and redacts paths and payloads", () => {
    const jsonl = invoke(["search"], [{ query: "Atlas" }, { query: "Casey" }]); expect(jsonl.status).toBe(0); expect(jsonl.lines).toHaveLength(2);
    const malformed = spawnSync(process.execPath, [cli, "read"], { cwd: path.resolve("."), env: environment, encoding: "utf8", input: "{not-json}\n" });
    expect(malformed.status).toBe(2); expect(malformed.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ outcome: "invalid_request" })]);
    expect(`${malformed.stdout}${malformed.stderr}`).not.toContain(vaultRoot); expect(`${malformed.stdout}${malformed.stderr}`).not.toContain("not-json");
    const invalid = invoke(["read"], { path: "../../private.md" }); expect(invalid.status).toBe(2); expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(vaultRoot); expect(`${invalid.stdout}${invalid.stderr}`).not.toContain("private.md");
  });

  it("keeps checkpoint dry-run pure, applies only explicitly, then rolls back deterministically", async () => {
    const daily = path.join(vaultRoot, "Notas Diarias", "2026-08-11.md");
    const before = await readFile(daily, "utf8");
    const raw = checkpoint("2026-08-11");
    const body = { checkpoint: Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "_date")), project: { kind: "unresolved", reason: "no_match" }, project_title: null, snapshots: { daily: before, project: null, moc: null, claude: null }, template_source: null, date: raw._date };
    const dry = invoke(["checkpoint", "--dry-run"], body); expect(dry.status).toBe(0); expect(dry.lines[0]).toMatchObject({ command: "checkpoint", outcome: "dry_run" }); expect(JSON.stringify(dry.lines[0])).not.toContain("Completed CLI integration");
    expect(await readFile(daily, "utf8")).toBe(before); expect(await readdir(path.join(vaultRoot, ".resyst", "journal"))).toHaveLength(0);
    const implicit = invoke(["checkpoint"], body); expect(implicit.status).toBe(2); expect(await readFile(daily, "utf8")).toBe(before);
    const applied = invoke(["checkpoint", "--apply"], body); expect(applied.status).toBe(0); expect(applied.lines[0]).toMatchObject({ command: "checkpoint", outcome: "applied" });
    const eventId = applied.lines[0]?.event_id; expect(typeof eventId).toBe("string"); expect(await readFile(daily, "utf8")).not.toBe(before);
    const rolled = invoke(["rollback", String(eventId)]); expect(rolled.status).toBe(0); expect(rolled.lines[0]).toMatchObject({ command: "rollback", outcome: "rolled_back", target_event_id: eventId }); expect(await readFile(daily, "utf8")).toBe(before);
  });

  it("uses stable symbolic exit mappings for deferred, recovery and rollback preconditions", () => {
    const missingRollback = invoke(["rollback", "evt-never-applied"]); expect(missingRollback.status).toBe(2); expect(missingRollback.lines[0]).toMatchObject({ outcome: "not_applied" });
    const invalidCheckpoint = invoke(["checkpoint", "--dry-run"], { checkpoint: { version: 1, kind: "apply" } }); expect(invalidCheckpoint.status).toBe(2); expect(invalidCheckpoint.lines[0]).toMatchObject({ outcome: "invalid_request" });
  });

  it("handles SIGINT without prompts or partial stdout", async () => {
    const child = spawn(process.execPath, [cli, "search"], { cwd: path.resolve("."), env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    // Low-memory single-worker CI can make Node ESM startup noticeably slower;
    // wait for the top-level SIGINT handler before delivering the signal.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500)); child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(130); expect(stdout).toBe("");
  });
});

describe("stable JSON CLI: adjudication coverage", () => {
  it("never echoes caller data on stderr across known and unknown errors", () => {
    // Search invalid_query => exit 2 with fixed stderr (no caller text).
    const badQuery = invoke(["search"], { query: "" });
    expect(badQuery.status).toBe(2);
    expect(badQuery.lines[0]).toMatchObject({ outcome: "invalid_request" });
    expect(badQuery.stderr.trim()).toBe("invalid_request: details redacted");

    // Read invalid_path => exit 2, fixed stderr.
    const badRead = invoke(["read"], { path: "/abs/../escape.md" });
    expect(badRead.status).toBe(2);
    expect(badRead.lines[0]).toMatchObject({ outcome: "invalid_request" });
    expect(`${badRead.stdout}${badRead.stderr}`).not.toContain("/abs/");

    // Search with unknown field rejected at the schema boundary.
    const unknownField = invoke(["search"], { query: "Atlas", evil: true });
    expect(unknownField.status).toBe(2);
    expect(unknownField.lines[0]).toMatchObject({ outcome: "invalid_request" });
    expect(`${unknownField.stdout}${unknownField.stderr}`).not.toContain("evil");
  });

  it("enforces stdin byte, line, depth, node and string bounds", () => {
    // Malformed JSON => exit 2.
    const malformed = spawnSync(process.execPath, [cli, "search"], { cwd: path.resolve("."), env: environment, encoding: "utf8", input: "{\n" });
    expect(malformed.status).toBe(2);
    expect(JSON.parse(malformed.stdout.trim().split("\n")[0]!)).toMatchObject({ outcome: "invalid_request" });
    expect(malformed.stderr).toMatch(/invalid_request/u);

    // 129 search requests => too many requests, exit 2.
    const tooMany: unknown[] = [];
    for (let i = 0; i < 129; i += 1) tooMany.push({ query: `q${String(i)}` });
    const tooManyRes = invoke(["search"], tooMany);
    expect(tooManyRes.status).toBe(2);
    expect(tooManyRes.lines[0]).toMatchObject({ outcome: "invalid_request" });

    // 128 search requests is the maximum allowed.
    const exactly128: unknown[] = [];
    for (let i = 0; i < 128; i += 1) exactly128.push({ query: `q${String(i)}` });
    const ok128 = invoke(["search"], exactly128);
    expect(ok128.status).toBe(0);
    expect(ok128.lines).toHaveLength(128);

    // Unknown key in bootstrap request => exit 2 (additionalProperties:false).
    const unknownKey = invoke(["bootstrap"], {
      notes: { claude: null, current_daily: null, project: null, moc: null },
      project: { kind: "unresolved", reason: "no_match" },
      budget_tokens: 5000,
      evil: true,
    });
    expect(unknownKey.status).toBe(2);
    expect(unknownKey.lines[0]).toMatchObject({ outcome: "invalid_request" });

    const baseRequest = JSON.stringify({ query: "a" });
    const atByteLimit = invokeRaw(["search"], `${baseRequest}${" ".repeat(8 * 1024 * 1024 - Buffer.byteLength(baseRequest, "utf8") - 1)}\n`);
    expect(atByteLimit.status).toBe(0);
    const overBytes = invokeRaw(["search"], `${JSON.stringify({ query: "a" })}${" ".repeat(8 * 1024 * 1024)}\n`);
    expect(overBytes.status).toBe(2);
    expect(overBytes.stderr).toBe("invalid_request: stdin exceeds bounded size\n");

    let nested: unknown = { query: "a" };
    for (let index = 0; index < 65; index += 1) nested = [nested];
    const tooDeep = invokeRaw(["search"], `${JSON.stringify(nested)}\n`);
    expect(tooDeep.status).toBe(2);
    expect(tooDeep.stderr).toContain("bounded depth");

    const nodeHeavy = invokeRaw(["search"], `${JSON.stringify({ query: "a", extra: Array.from({ length: 10_001 }, () => null) })}\n`);
    expect(nodeHeavy.status).toBe(2);
    expect(nodeHeavy.stderr).toContain("bounded node count");

    const stringHeavy = invokeRaw(["search"], `${JSON.stringify({ query: "x".repeat(1_000_001) })}\n`);
    expect(stringHeavy.status).toBe(2);
    expect(stringHeavy.stderr).toContain("bounded length");

    const depth64 = invokeRaw(["search"], `${JSON.stringify(Array.from({ length: 64 }).reduce<unknown>((value) => [value], null))}\n`);
    expect(depth64.status).toBe(2); // structurally bounded, then exact search schema rejection
    expect(depth64.stderr).not.toContain("bounded depth");

    const nodesAtLimit = invokeRaw(["search"], `${JSON.stringify({ query: "a", extra: Array.from({ length: 9_997 }, () => null) })}\n`);
    expect(nodesAtLimit.status).toBe(2); // exact schema rejection, not node-budget rejection
    expect(nodesAtLimit.stderr).not.toContain("bounded node count");

    const stringAtLimit = invokeRaw(["search"], `${JSON.stringify({ query: "x".repeat(1_000_000) })}\n`);
    expect(stringAtLimit.status).toBe(2); // exact query schema rejection, not global string budget
    expect(stringAtLimit.stderr).not.toContain("bounded length");
  }, 15_000);

  it("validates every JSONL schema before emitting output or writing the cache", async () => {
    const atomicState = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-atomic-state-"));
    roots.push(atomicState);
    const atomicEnv: NodeJS.ProcessEnv = { ...environment, XDG_STATE_HOME: atomicState };
    const result = invokeRaw(["search"], `${JSON.stringify({ query: "Atlas" })}\n${JSON.stringify({ query: "Atlas", extra: true })}\n`, atomicEnv);
    expect(result.status).toBe(2);
    expect(result.lines).toEqual([expect.objectContaining({ outcome: "invalid_request" })]);
    await expect(readdir(path.join(atomicState, "resyst-vault", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces exact argv grammar: --no-color, doctor cleanup, checkpoint modes, rollback id", async () => {
    // Global --no-color accepted once.
    expect(invoke(["status", "--no-color"]).status).toBe(0);
    // Repeated --no-color => exit 2.
    const repeatColor = invoke(["status", "--no-color", "--no-color"]);
    expect(repeatColor.status).toBe(2);
    expect(repeatColor.lines[0]).toMatchObject({ outcome: "invalid_request" });

    // Doctor without --clean-abandoned-lock => exit 0 (read-only).
    expect(invoke(["doctor"]).status).toBe(0);
    // Doctor with --clean-abandoned-lock => exit 0/4 depending on state.
    const cleanup = invoke(["doctor", "--clean-abandoned-lock"]);
    expect([0, 4]).toContain(cleanup.status);
    expect(cleanup.lines[0]).toMatchObject({ command: "doctor" });
    expect(cleanup.lines[0]).toHaveProperty("cleanup");
    // Doctor rejects extra positionals.
    expect(invoke(["doctor", "extra"]).status).toBe(2);

    // Checkpoint: --dry-run and --apply mutually exclusive.
    const dualMode = invoke(["checkpoint", "--dry-run", "--apply"], { checkpoint: { version: 1, kind: "noop", reason: "trivial" } });
    expect(dualMode.status).toBe(2);
    expect(dualMode.lines[0]).toMatchObject({ outcome: "invalid_request" });

    // Checkpoint requires exactly one request.
    const multi = invoke(["checkpoint", "--dry-run"], [
      { checkpoint: { version: 1, kind: "noop", reason: "trivial" } },
      { checkpoint: { version: 1, kind: "noop", reason: "trivial" } },
    ]);
    expect(multi.status).toBe(2);
    expect(multi.lines[0]).toMatchObject({ outcome: "invalid_request" });

    // NOOP only accepts `{checkpoint: NoopCheckpoint}`; no rendering or config mutation.
    // Use an isolated vault so prior checkpoint --apply tests cannot leave
    // journal/receipt artefacts behind.
    const noopVault = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-noop-"));
    roots.push(noopVault);
    await createVault({ vaultPath: noopVault, withDailyNote: true, dailyNoteDate: "2026-08-11" });
    const noopConfig = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-noop-config-"));
    roots.push(noopConfig);
    const noopState = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-noop-state-"));
    roots.push(noopState);
    await mkdir(path.join(noopConfig, "resyst-vault"), { recursive: true });
    await writeFile(path.join(noopConfig, "resyst-vault", "config.json"),
      JSON.stringify({ version: 1, host_id: "casey", vault_path: noopVault, project_overrides: [] }),
      "utf8",
    );
    const noopEnv: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: noopConfig, XDG_STATE_HOME: noopState, NO_COLOR: "1" };
    delete noopEnv.FORCE_COLOR;
    const noopResult = spawnSync(process.execPath, [cli, "checkpoint", "--apply"], {
      cwd: path.resolve("."),
      env: noopEnv,
      encoding: "utf8",
      input: JSON.stringify({ checkpoint: { version: 1, kind: "noop", reason: "trivial" } }),
      timeout: 15_000,
    });
    expect(noopResult.status).toBe(0);
    expect(JSON.parse(noopResult.stdout.trim().split(String.fromCharCode(10))[0]!)).toMatchObject({ outcome: "noop", reason: "trivial" });
    // NOOP must not write under the vault's .resyst journal or receipts.
    expect(await readdir(path.join(noopVault, ".resyst", "journal"))).toHaveLength(0);
    expect(await readdir(path.join(noopVault, ".resyst", "receipts"))).toHaveLength(0);

    // Rollback missing positional => exit 2.
    expect(invoke(["rollback"]).status).toBe(2);
    // Rollback invalid EventId shape => exit 2.
    expect(invoke(["rollback", "not/valid/id"]).status).toBe(2);
    // Rollback with extra flag => exit 2.
    expect(invoke(["rollback", "evt-1", "--no-color"]).status).toBe(2);

    // Unknown command => exit 2.
    expect(invoke(["frobnicate"]).status).toBe(2);
  });

  it("rejects nonempty piped body on bodyless commands", () => {
    // status with piped body => exit 2.
    const statusWithBody = spawnSync(process.execPath, [cli, "status"], {
      cwd: path.resolve("."),
      env: environment,
      encoding: "utf8",
      input: '{"x":1}\n',
    });
    expect(statusWithBody.status).toBe(2);
    expect(JSON.parse(statusWithBody.stdout.trim().split("\n")[0]!)).toMatchObject({ outcome: "invalid_request" });
    expect(statusWithBody.stderr).toMatch(/invalid_request/u);

    // recover with piped body => exit 2.
    const recoverWithBody = spawnSync(process.execPath, [cli, "recover"], {
      cwd: path.resolve("."),
      env: environment,
      encoding: "utf8",
      input: '{"x":1}\n',
    });
    expect(recoverWithBody.status).toBe(2);

    // help with piped body => exit 2.
    const helpWithBody = spawnSync(process.execPath, [cli, "help"], {
      cwd: path.resolve("."),
      env: environment,
      encoding: "utf8",
      input: '{"x":1}\n',
    });
    expect(helpWithBody.status).toBe(2);

    const whitespaceBody = invokeRaw(["help"], "   \n\t\n");
    expect(whitespaceBody.status).toBe(2);
    expect(whitespaceBody.lines[0]).toMatchObject({ outcome: "invalid_request" });
  });

  it("importing runCli does not register SIGINT, read stdin, or exit", async () => {
    // Use the dist/cli.js as a module import (no SIGINT handler is added at
    // import time; only the executable main installs one).
    const sigintBefore = process.listenerCount("SIGINT");
    const dataBefore = process.stdin.listenerCount("data");
    const endBefore = process.stdin.listenerCount("end");
    const cliModule = await import(path.resolve("dist/cli.js"));
    expect(typeof cliModule.runCli).toBe("function");
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.stdin.listenerCount("data")).toBe(dataBefore);
    expect(process.stdin.listenerCount("end")).toBe(endBefore);
    expect(process.exitCode).toBeUndefined();
  });

  it("falls back to absolute HOME/.local/state when XDG_STATE_HOME is unset", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-home-"));
    roots.push(tempHome);
    // Build a vault+config in fresh, isolated dirs under tempHome; do not
    // touch the test's xdgState dir, so no cwd state can be created there.
    const homeVault = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-home-vault-"));
    roots.push(homeVault);
    await createVault({ vaultPath: homeVault, withDailyNote: true, dailyNoteDate: "2026-08-11" });
    const homeConfig = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-home-config-"));
    roots.push(homeConfig);
    await mkdir(path.join(homeConfig, "resyst-vault"), { recursive: true });
    await writeFile(path.join(homeConfig, "resyst-vault", "config.json"),
      JSON.stringify({ version: 1, host_id: "casey", vault_path: homeVault, project_overrides: [] }),
      "utf8",
    );
    // No XDG_STATE_HOME. HOME points to a temp directory containing no
    // .local/state; the CLI must fall back to <HOME>/.local/state, which
    // is the absolute state root and the only place it touches.
    const noXdgEnv: Record<string, string | undefined> = { ...process.env, HOME: tempHome, XDG_CONFIG_HOME: homeConfig };
    delete noXdgEnv.XDG_STATE_HOME;
    delete noXdgEnv.FORCE_COLOR;
    const result = spawnSync(process.execPath, [cli, "status"], {
      cwd: tempHome,
      env: noXdgEnv,
      encoding: "utf8",
      input: "",
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n")[0]!)).toMatchObject({ outcome: "ok" });
    // The CLI never wrote under cwd (tempHome); only inside <HOME>/.local/state.
    const cwdContents = await readdir(tempHome);
    expect(cwdContents).not.toContain(".local");
    expect(cwdContents).not.toContain(".resyst");
    expect(cwdContents).not.toContain("resyst-vault");
  });

  it("rejects relative XDG_STATE_HOME fail-closed", () => {
    const rel = spawnSync(process.execPath, [cli, "status"], {
      cwd: path.resolve("."),
      env: { ...environment, XDG_STATE_HOME: "relative/state" },
      encoding: "utf8",
      input: "",
      timeout: 15_000,
    });
    expect(rel.status).toBe(2);
    expect(JSON.parse(rel.stdout.trim().split("\n")[0]!)).toMatchObject({ outcome: "invalid_config" });
    expect(rel.stderr).toMatch(/invalid_config/u);
  });

  it("rejects relative XDG_CONFIG_HOME fail-closed", () => {
    const rel = spawnSync(process.execPath, [cli, "status"], {
      cwd: path.resolve("."),
      env: { ...environment, XDG_CONFIG_HOME: "relative/config" },
      encoding: "utf8",
      input: "",
      timeout: 15_000,
    });
    expect(rel.status).toBe(2);
    expect(JSON.parse(rel.stdout.trim().split("\n")[0]!)).toMatchObject({ outcome: "invalid_config" });
    expect(rel.stderr).toMatch(/invalid_config/u);
  });
  it("rejects hostile relative or empty HOME when XDG roots are unset", () => {
    for (const home of ["relative/home", ""]) {
      const env: NodeJS.ProcessEnv = { ...environment, HOME: home };
      delete env.XDG_CONFIG_HOME;
      delete env.XDG_STATE_HOME;
      const result = spawnSync(process.execPath, [cli, "status"], {
        cwd: path.resolve("."), env, encoding: "utf8", input: "", timeout: 15_000,
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout.trim().split("\n")[0]!)).toMatchObject({ outcome: "invalid_config" });
    }
  });

  it("does not echo the search query string in the response envelope", () => {
    const secretQuery = "E2E-QUERYSECRET-MARKER-XYZ";
    const res = invoke(["search"], { query: secretQuery, limit: 1 });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain(secretQuery);
    expect(res.stderr).not.toContain(secretQuery);
  });

  it("checkpoint dry-run never touches the journal or vault file contents", async () => {
    // Build an isolated vault so prior checkpoint --apply tests cannot
    // leave journal/receipt artefacts behind.
    const dryVault = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-dryrun-"));
    roots.push(dryVault);
    await createVault({ vaultPath: dryVault, withDailyNote: true, dailyNoteDate: "2026-08-11" });
    const dryConfig = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-dryrun-config-"));
    roots.push(dryConfig);
    const dryState = await mkdtemp(path.join(os.tmpdir(), "resyst-cli-dryrun-state-"));
    roots.push(dryState);
    await mkdir(path.join(dryConfig, "resyst-vault"), { recursive: true });
    await writeFile(path.join(dryConfig, "resyst-vault", "config.json"),
      JSON.stringify({ version: 1, host_id: "casey", vault_path: dryVault, project_overrides: [] }),
      "utf8",
    );
    const dryEnv: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: dryConfig, XDG_STATE_HOME: dryState, NO_COLOR: "1" };
    delete dryEnv.FORCE_COLOR;
    const daily = path.join(dryVault, "Notas Diarias", "2026-08-11.md");
    const before = await readFile(daily, "utf8");
    const raw = checkpoint("2026-08-11");
    const body = {
      checkpoint: Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "_date")),
      project: { kind: "unresolved", reason: "no_match" },
      project_title: null,
      snapshots: { daily: before, project: null, moc: null, claude: null },
      template_source: null,
      date: raw._date,
    };
    const r1 = spawnSync(process.execPath, [cli, "checkpoint", "--dry-run"], {
      cwd: path.resolve("."),
      env: dryEnv,
      encoding: "utf8",
      input: JSON.stringify(body),
      timeout: 15_000,
    });
    expect(r1.status).toBe(0);
    const line = JSON.parse(r1.stdout.trim().split(String.fromCharCode(10))[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ outcome: "dry_run" });
    expect(await readFile(daily, "utf8")).toBe(before);
    expect(await readdir(path.join(dryVault, ".resyst", "journal"))).toHaveLength(0);
    expect(await readdir(path.join(dryVault, ".resyst", "receipts"))).toHaveLength(0);
  });

  it("applies a stable event id derived from the canonical idempotency key regardless of JSON key order", async () => {
    const daily = path.join(vaultRoot, "Notas Diarias", "2026-08-11.md");
    const before = await readFile(daily, "utf8");
    const raw = checkpoint("2026-08-11");
    const ck = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "_date"));
    // Reordered keys + extra known keys produce the same canonical event id.
    const reordered: Record<string, unknown> = {
      date: raw._date,
      template_source: null,
      snapshots: { daily: before, project: null, moc: null, claude: null },
      project: { kind: "unresolved", reason: "no_match" },
      checkpoint: ck,
      project_title: null,
    };
    const r = invoke(["checkpoint", "--apply"], reordered);
    expect(r.status).toBe(0);
    const firstId = r.lines[0]?.event_id;
    expect(typeof firstId).toBe("string");
    // Apply a second time; the idempotency key is identical so the event id
    // is stable and the second apply is `already_applied`.
    const r2 = invoke(["checkpoint", "--apply"], reordered);
    expect([0]).toContain(r2.status);
    expect(r2.lines[0]).toMatchObject({ outcome: "already_applied" });
    // Cleanup: rollback the first apply.
    expect(invoke(["rollback", String(firstId)]).status).toBe(0);
    expect(await readFile(daily, "utf8")).toBe(before);
  });
});
