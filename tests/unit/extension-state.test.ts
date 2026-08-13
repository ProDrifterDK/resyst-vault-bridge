import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_STATE_CUSTOM_TYPE,
  EffectTracker,
  PendingStateStore,
  CheckpointStateError,
  initialCheckpointRecord,
  reconcileCheckpointState,
  reduceCheckpointState,
  type CheckpointStateRecord,
} from "../../src/extension/state.js";

const NOW = "2026-08-13T00:00:00.000Z";
const LATER = "2026-08-13T00:01:00.000Z";

function record(
  state: CheckpointStateRecord["state"],
  revision = 3,
): CheckpointStateRecord {
  return {
    version: 1,
    session_id: "session-atlas",
    revision,
    state,
    substantial: state === "substantial_pending",
    uncertainty: state === "evaluation_pending" || state === "evaluating",
    checkpoint_seen: state === "evaluated",
    updated_at: NOW,
  };
}

describe("checkpoint state transitions", () => {
  it("uses the exact custom-entry type and starts clean", () => {
    expect(CHECKPOINT_STATE_CUSTOM_TYPE).toBe("resyst-vault.checkpoint-state");
    expect(initialCheckpointRecord("session-atlas", NOW)).toEqual({
      version: 1,
      session_id: "session-atlas",
      revision: 0,
      state: "clean",
      substantial: false,
      uncertainty: false,
      checkpoint_seen: false,
      updated_at: NOW,
    });
  });

  it("follows the complete pending/evaluating/evaluated transition table", () => {
    const cases: Array<{
      from: CheckpointStateRecord["state"];
      event: Parameters<typeof reduceCheckpointState>[1];
      to: CheckpointStateRecord["state"];
    }> = [
      { from: "clean", event: { kind: "substantial" }, to: "substantial_pending" },
      { from: "clean", event: { kind: "uncertain" }, to: "evaluation_pending" },
      { from: "substantial_pending", event: { kind: "uncertain" }, to: "evaluation_pending" },
      { from: "evaluation_pending", event: { kind: "substantial" }, to: "evaluation_pending" },
      { from: "substantial_pending", event: { kind: "begin_evaluation" }, to: "evaluating" },
      { from: "evaluation_pending", event: { kind: "begin_evaluation" }, to: "evaluating" },
      { from: "evaluating", event: { kind: "evaluation_incomplete" }, to: "evaluation_pending" },
      { from: "substantial_pending", event: { kind: "evaluation_incomplete" }, to: "evaluation_pending" },
      { from: "substantial_pending", event: { kind: "evaluation_completed" }, to: "evaluated" },
      { from: "evaluating", event: { kind: "evaluation_completed" }, to: "evaluated" },
      { from: "evaluated", event: { kind: "substantial" }, to: "substantial_pending" },
      { from: "evaluated", event: { kind: "uncertain" }, to: "evaluation_pending" },
    ];
    for (const item of cases) {
      const next = reduceCheckpointState(record(item.from), item.event, LATER);
      expect(next.state, `${item.from}:${item.event.kind}`).toBe(item.to);
      expect(next.revision).toBe(4);
      expect(next.updated_at).toBe(LATER);
    }
  });

  it("does not clear pending state for invalid, failed, or deferred evaluations", () => {
    for (const outcome of ["invalid", "failed", "deferred"] as const) {
      const next = reduceCheckpointState(
        record("substantial_pending"),
        { kind: "checkpoint_outcome", outcome, basis_revision: 3 },
        LATER,
      );
      expect(next.state).toBe("evaluation_pending");
    }
    for (const outcome of ["applied", "noop", "already_applied"] as const) {
      const next = reduceCheckpointState(
        record("substantial_pending"),
        { kind: "checkpoint_outcome", outcome, basis_revision: 3 },
        LATER,
      );
      expect(next.state).toBe("evaluated");
    }
  });
});

describe("effect matrix", () => {
  it("classifies successful edits, bash, configured tools, reads, failures, and uncertainty", () => {
    const tracker = new EffectTracker({ substantialTools: ["deploy_release"] });
    expect(tracker.observe({ tool_call_id: "1", tool_name: "edit", is_error: false, input: {} })).toBe("substantial");
    expect(tracker.observe({ tool_call_id: "2", tool_name: "edit", is_error: true, input: {} })).toBe("ignore");
    expect(tracker.observe({ tool_call_id: "3", tool_name: "bash", is_error: false, input: { command: "git status --short" } })).toBe("ignore");
    expect(tracker.observe({ tool_call_id: "4", tool_name: "bash", is_error: false, input: { command: "git commit -m done" } })).toBe("substantial");
    expect(tracker.observe({ tool_call_id: "5", tool_name: "bash", is_error: false, input: { command: "custom-script --maybe" } })).toBe("uncertain");
    expect(tracker.observe({ tool_call_id: "6", tool_name: "deploy_release", is_error: false, input: {} })).toBe("substantial");
    expect(tracker.observe({ tool_call_id: "7", tool_name: "vault_search", is_error: false, input: {} })).toBe("ignore");
    expect(tracker.observe({ tool_call_id: "8", tool_name: "vault_read", is_error: false, input: {} })).toBe("ignore");
    expect(tracker.observe({ tool_call_id: "9", tool_name: "vault_checkpoint", is_error: false, input: {} })).toBe("ignore");
    expect(tracker.observe({ tool_call_id: "10", tool_name: "unknown_custom", is_error: false, input: {} })).toBe("uncertain");
    for (const [index, toolName] of ["read", "grep", "find", "ls"].entries()) {
      expect(tracker.observe({ tool_call_id: `read-${index}`, tool_name: toolName, is_error: false, input: {} })).toBe("ignore");
    }
    for (const [index, command] of [
      "git branch feature/new",
      "git branch -D old",
      "git remote add origin synthetic",
      "sed -i s/old/new/ file",
      "find . -delete",
    ].entries()) {
      expect(tracker.observe({ tool_call_id: `mutating-${index}`, tool_name: "bash", is_error: false, input: { command } })).toBe("substantial");
    }
  });

  it("deduplicates bounded call ids and fails uncertainty closed", () => {
    const tracker = new EffectTracker();
    const effect = { tool_call_id: "same", tool_name: "edit", is_error: false, input: {} } as const;
    expect(tracker.observe(effect)).toBe("substantial");
    expect(tracker.observe(effect)).toBe("ignore");
    expect(tracker.observe({ tool_call_id: "bad", tool_name: "bash", is_error: false, input: { command: 42 } })).toBe("uncertain");
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(tracker.observe(proxy)).toBe("uncertain");
  });
});

describe("pending state persistence and reconciliation", () => {
  it("writes an opaque 0600 atomic record and restores it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-checkpoint-state-"));
    try {
      const store = new PendingStateStore({ stateRoot: root });
      const saved = record("substantial_pending", 7);
      await store.save(saved);
      await expect(store.load("session-atlas")).resolves.toEqual(saved);
      const file = store.pathFor("session-atlas");
      expect(path.basename(file)).toMatch(/^[a-f0-9]{64}\.json$/u);
      expect(file).not.toContain("session-atlas");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(saved);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes full state mutations so a later edit cannot be erased", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-checkpoint-serialized-"));
    try {
      const store = new PendingStateStore({ stateRoot: root });
      const concurrentStore = new PendingStateStore({ stateRoot: root });
      await store.save(initialCheckpointRecord("session-atlas", NOW));
      await Promise.all([
        store.update("session-atlas", (current) =>
          reduceCheckpointState(current!, { kind: "checkpoint_outcome", outcome: "applied", basis_revision: 0 }, LATER),
        ),
        concurrentStore.update("session-atlas", (current) =>
          reduceCheckpointState(current!, { kind: "substantial" }, LATER),
        ),
      ]);
      await expect(store.load("session-atlas")).resolves.toMatchObject({
        revision: 2,
        state: "substantial_pending",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dangerous roots and symlinked ancestors without chmodding caller roots", async () => {
    expect(() => new PendingStateStore({ stateRoot: path.parse(process.cwd()).root })).toThrow(CheckpointStateError);
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-checkpoint-root-safety-"));
    try {
      const shared = path.join(root, "shared");
      await mkdir(shared, { mode: 0o755 });
      const sharedStore = new PendingStateStore({ stateRoot: shared });
      await expect(sharedStore.save(record("clean"))).rejects.toBeInstanceOf(CheckpointStateError);
      expect((await stat(shared)).mode & 0o777).toBe(0o755);

      const target = path.join(root, "target");
      await mkdir(target, { mode: 0o700 });
      const link = path.join(root, "link");
      await symlink(target, link, "dir");
      const linkedStore = new PendingStateStore({ stateRoot: path.join(link, "state") });
      await expect(linkedStore.save(record("clean"))).rejects.toBeInstanceOf(CheckpointStateError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects relative roots, corrupted local state, and unreadable state", async () => {
    expect(() => new PendingStateStore({ stateRoot: "relative" })).toThrow(CheckpointStateError);
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-checkpoint-corrupt-"));
    try {
      const store = new PendingStateStore({ stateRoot: root });
      await store.save(record("clean"));
      await writeFile(store.pathFor("session-atlas"), "{not-json", "utf8");
      await expect(store.load("session-atlas")).rejects.toBeInstanceOf(CheckpointStateError);
      await chmod(store.pathFor("session-atlas"), 0o000);
      if (process.getuid?.() !== 0) {
        await expect(store.load("session-atlas")).rejects.toBeInstanceOf(CheckpointStateError);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps valid local authority and never trusts newer or foreign mirrors", () => {
    const local = record("substantial_pending", 4);
    const reconciled = reconcileCheckpointState({
      sessionId: "session-atlas",
      local,
      mirrors: [
        record("evaluated", 9),
        { ...record("evaluated", 4), session_id: "session-other" },
      ],
      reset: false,
      now: LATER,
    });
    expect(reconciled).toEqual(local);
  });

  it("conservatively reconstructs lost pending state from a valid same-session mirror", () => {
    for (const state of ["substantial_pending", "evaluation_pending", "evaluating"] as const) {
      const reconciled = reconcileCheckpointState({
        sessionId: "session-atlas",
        local: null,
        mirrors: [record(state, 6)],
        reset: false,
        now: LATER,
      });
      expect(reconciled.state).toBe("evaluation_pending");
      expect(reconciled.revision).toBe(1);
    }
    expect(reconcileCheckpointState({
      sessionId: "session-atlas",
      local: null,
      mirrors: [record("evaluated", 6)],
      reset: false,
      now: LATER,
    }).state).toBe("clean");
    const hostileRevision = reconcileCheckpointState({
      sessionId: "session-atlas",
      local: null,
      mirrors: [record("evaluation_pending", Number.MAX_SAFE_INTEGER - 1)],
      reset: false,
      now: LATER,
    });
    expect(hostileRevision).toMatchObject({ state: "evaluation_pending", revision: 1 });
  });

  it("new and fork reset instead of inheriting ancestor mirrors", () => {
    for (const reset of [true] as const) {
      const next = reconcileCheckpointState({
        sessionId: "session-new",
        local: record("substantial_pending", 8),
        mirrors: [record("evaluation_pending", 9)],
        reset,
        now: LATER,
      });
      expect(next).toEqual(initialCheckpointRecord("session-new", LATER));
    }
  });
});
