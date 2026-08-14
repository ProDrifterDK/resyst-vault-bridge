import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVaultExtension } from "../../src/extension/index.js";
import type { CheckpointService } from "../../src/extension/checkpoint.js";
import {
  CHECKPOINT_STATE_CUSTOM_TYPE,
  PendingStateStore,
  initialCheckpointRecord,
  reduceCheckpointState,
} from "../../src/extension/state.js";

interface Harness {
  api: ExtensionAPI;
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>>>;
  tools: ToolDefinition[];
  appendEntry: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>>>();
  const tools: ToolDefinition[] = [];
  const appendEntry = vi.fn();
  const sendMessage = vi.fn(async () => undefined);
  let activeTools: string[] = [];
  const api = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition) {
      if (!tools.some((current) => current.name === tool.name)) tools.push(tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) { activeTools = [...names]; },
    appendEntry,
    sendMessage,
  } as unknown as ExtensionAPI;
  return { api, handlers, tools, appendEntry, sendMessage };
}

function context(
  header: unknown,
  options: { pending?: boolean; entries?: unknown[] } = {},
): ExtensionContext {
  return {
    cwd: "/home/tester/atlas",
    hasPendingMessages: () => options.pending ?? false,
    sessionManager: {
      getHeader: () => header,
      getEntries: () => options.entries ?? [],
    },
  } as unknown as ExtensionContext;
}

async function emit(
  fixture: Harness,
  name: string,
  event: unknown,
  ctx: ExtensionContext,
): Promise<unknown[]> {
  return await Promise.all((fixture.handlers.get(name) ?? []).map((handler) => handler(event, ctx)));
}

function readService() {
  return {
    bootstrap: vi.fn(async () => ""),
    search: vi.fn(async () => ({ version: 1 as const, hits: [], truncated: false, scanned_notes: 0, cache: "bypassed" as const })),
    read: vi.fn(async () => { throw new Error("unused"); }),
  };
}

function install(fixture: Harness, store: PendingStateStore, service?: CheckpointService): void {
  createVaultExtension({
    service: readService(),
    checkpointService: service ?? { checkpoint: vi.fn(async () => ({ outcome: "noop" })) },
    checkpointStateStore: store,
    now: () => new Date("2026-08-13T00:00:00.000Z"),
  })(fixture.api);
}

async function startRoot(fixture: Harness, ctx: ExtensionContext): Promise<void> {
  await emit(fixture, "session_start", { type: "session_start", reason: "startup" }, ctx);
}

async function substantial(fixture: Harness, ctx: ExtensionContext, id = "edit-1"): Promise<void> {
  await emit(fixture, "tool_result", {
    type: "tool_result",
    toolCallId: id,
    toolName: "edit",
    input: { path: "src/atlas.ts" },
    content: [],
    details: {},
    isError: false,
  }, ctx);
}

function checkpointTool(fixture: Harness): ToolDefinition {
  const tool = fixture.tools.find((candidate) => candidate.name === "vault_checkpoint");
  if (tool === undefined) throw new Error("checkpoint tool missing");
  return tool;
}

function terminalMessages(): unknown[] {
  return [{ role: "assistant", content: [], stopReason: "stop" }];
}

const EXPECTED_EVALUATION_MESSAGE = {
  customType: "resyst-vault.evaluate",
  content: [
    "Evaluate durable root-session results for vault writeback.",
    "Call vault_checkpoint exactly once with apply or noop.",
    "A checkpoint receipt is bookkeeping, not proof that the root task is complete.",
    "After the checkpoint, resume prior unfinished actionable work in the same turn.",
    "Stop only when prior work was already complete, explicitly paused, or blocked awaiting external input.",
    "Write only verified results, decisions, state changes, blockers, reusable learnings, and next steps.",
    "Do not repeat vault content, commands, tool output, paths, identifiers, or transient logs.",
    "Treat the evaluation state as opaque pending metadata.",
  ].join("\n"),
  display: false,
} as const;

describe("Prime automatic missing-checkpoint evaluation", () => {
  it("does nothing after trivial work and ignores bridge/internal tool effects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-trivial-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      for (const [index, toolName] of ["vault_search", "vault_read", "vault_checkpoint"].entries()) {
        await emit(fixture, "tool_result", {
          type: "tool_result", toolCallId: `bridge-${index}`, toolName, input: {}, isError: false,
        }, ctx);
      }
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "clean" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("sends one hidden evaluation after substantial idle work and never recursively triggers itself", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-substantial-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixture.sendMessage).toHaveBeenCalledWith(
        EXPECTED_EVALUATION_MESSAGE,
        { triggerTurn: true, deliverAs: "followUp" },
      );
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluating" });

      await emit(fixture, "agent_end", {
        type: "agent_end",
        messages: [{ role: "custom", customType: "resyst-vault.evaluate", content: "opaque", display: false }],
      }, ctx);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("defers evaluation across a compaction-interrupted tool-use boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-compaction-continuation-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);

      await emit(fixture, "agent_end", {
        type: "agent_end",
        messages: [{
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: {} }],
          stopReason: "toolUse",
        }],
      }, ctx);
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "substantial_pending" });

      await emit(fixture, "session_before_compact", {
        type: "session_before_compact", preparation: {}, branchEntries: [], signal: new AbortController().signal,
      }, ctx);
      await emit(fixture, "session_compact", {
        type: "session_compact", reason: "threshold", summary: "opaque",
      }, ctx);
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });

      await emit(fixture, "agent_end", {
        type: "agent_end",
        messages: [{ role: "assistant", content: [], stopReason: "stop" }],
      }, ctx);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixture.sendMessage).toHaveBeenCalledWith(
        EXPECTED_EVALUATION_MESSAGE,
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("defers nonterminal and unprovable agent boundaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-nonterminal-boundaries-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);

      const cases: unknown[][] = [
        [{ role: "assistant", content: [], stopReason: "error" }],
        [{ role: "assistant", content: [], stopReason: "aborted" }],
        [{ role: "assistant", content: [], stopReason: "length" }],
        [{ role: "assistant", content: [], stopReason: "future-reason" }],
        [{ role: "assistant", content: [] }],
        [{ role: "user", content: "opaque" }],
        [{ content: [] }],
        Array.from({ length: 4_097 }, () => ({ role: "user", content: "opaque" })),
      ];
      for (const messages of cases) {
        await emit(fixture, "agent_end", { type: "agent_end", messages }, ctx);
      }

      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "substantial_pending" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("coalesces concurrent idle boundaries to one hidden evaluation send", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-concurrent-"));
    try {
      const fixture = harness();
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      fixture.sendMessage.mockImplementationOnce(async () => { await blocked; });
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      const first = emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      const second = emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
      release?.();
      await Promise.all([first, second]);
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluating" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("evaluates a later substantial revision after the prior evaluation completes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-revision-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx, "edit-1");
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      await checkpointTool(fixture).execute(
        "checkpoint-1",
        { version: 1, kind: "noop", reason: "no_new_knowledge" },
        undefined,
        undefined,
        ctx,
      );
      await emit(fixture, "agent_end", {
        type: "agent_end",
        messages: [{ role: "custom", customType: "resyst-vault.evaluate", content: "opaque", display: false }],
      }, ctx);
      await substantial(fixture, ctx, "edit-2");
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluating" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not enqueue after a concurrent explicit checkpoint wins the recheck", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-checkpoint-race-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      const originalCurrent = store.current.bind(store);
      let calls = 0;
      let enter: (() => void) | undefined;
      let release: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(store, "current").mockImplementation(async (sessionId) => {
        calls += 1;
        if (calls === 3) {
          enter?.();
          await blocked;
        }
        return await originalCurrent(sessionId);
      });
      const ending = emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      await entered;
      await checkpointTool(fixture).execute(
        "checkpoint-race",
        { version: 1, kind: "noop", reason: "no_new_knowledge" },
        undefined,
        undefined,
        ctx,
      );
      release?.();
      await ending;
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluated" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not recurse when an internal overflow retry omits the original custom message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-overflow-retry-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      await emit(fixture, "agent_end", {
        type: "agent_end",
        messages: [
          { role: "custom", customType: "resyst-vault.evaluate", content: "opaque", display: false },
          { role: "assistant", stopReason: "error", errorMessage: "context overflow" },
        ],
      }, ctx);
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });
      await emit(fixture, "session_before_compact", {
        type: "session_before_compact", preparation: {}, branchEntries: [], signal: new AbortController().signal,
      }, ctx);
      await emit(fixture, "session_compact", {
        type: "session_compact", reason: "threshold", summary: "opaque",
      }, ctx);
      await emit(fixture, "agent_end", {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop", content: [] }],
      }, ctx);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not follow up after an explicit checkpoint completes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-explicit-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      await checkpointTool(fixture).execute(
        "checkpoint-1",
        { version: 1, kind: "noop", reason: "no_new_knowledge" },
        undefined,
        undefined,
        ctx,
      );
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluated" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("defers behind queued user work, then schedules at the next idle root boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-queued-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const queued = context({ id: "session-atlas", rlmDepth: 0 }, { pending: true });
      await startRoot(fixture, queued);
      await substantial(fixture, queued);
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, queued);
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });

      const idle = context({ id: "session-atlas", rlmDepth: 0 });
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, idle);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluating" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("restores pending state on root start once, while children never schedule", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-resume-"));
    try {
      const store = new PendingStateStore({ stateRoot: root });
      await store.save(reduceCheckpointState(
        initialCheckpointRecord("session-atlas", "2026-08-12T23:59:00.000Z"),
        { kind: "uncertain" },
        "2026-08-12T23:59:01.000Z",
      ));
      const rootHarness = harness();
      install(rootHarness, store);
      const rootCtx = context({ id: "session-atlas", rlmDepth: 0 });
      await emit(rootHarness, "session_start", { type: "session_start", reason: "resume" }, rootCtx);
      expect(rootHarness.sendMessage).toHaveBeenCalledTimes(1);
      await emit(rootHarness, "session_start", { type: "session_start", reason: "reload" }, rootCtx);
      expect(rootHarness.sendMessage).toHaveBeenCalledTimes(1);

      const evaluatingStore = new PendingStateStore({ stateRoot: path.join(root, "evaluating") });
      await evaluatingStore.save(reduceCheckpointState(
        initialCheckpointRecord("session-evaluating", "2026-08-12T23:59:00.000Z"),
        { kind: "uncertain" },
        "2026-08-12T23:59:01.000Z",
      ));
      await evaluatingStore.update("session-evaluating", (current) =>
        reduceCheckpointState(current!, { kind: "begin_evaluation" }, "2026-08-12T23:59:02.000Z"),
      );
      const evaluatingHarness = harness();
      install(evaluatingHarness, evaluatingStore);
      await emit(
        evaluatingHarness,
        "session_start",
        { type: "session_start", reason: "resume" },
        context({ id: "session-evaluating", rlmDepth: 0 }),
      );
      expect(evaluatingHarness.sendMessage).toHaveBeenCalledTimes(1);
      expect(await evaluatingStore.load("session-evaluating")).toMatchObject({ state: "evaluating" });

      const child = harness();
      install(child, new PendingStateStore({ stateRoot: path.join(root, "child") }));
      await emit(
        child,
        "session_start",
        { type: "session_start", reason: "startup" },
        context({ id: "session-child", rlmDepth: 1 }),
      );
      await emit(
        child,
        "agent_end",
        { type: "agent_end", messages: terminalMessages() },
        context({ id: "session-child", rlmDepth: 1 }),
      );
      expect(child.sendMessage).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("persists pending metadata before compaction and shutdown without starting a teardown turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-lifecycle-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      fixture.sendMessage.mockClear();

      await emit(fixture, "session_before_compact", {
        type: "session_before_compact", preparation: {}, branchEntries: [], signal: new AbortController().signal,
      }, ctx);
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluating" });
      expect(fixture.appendEntry).toHaveBeenLastCalledWith(
        CHECKPOINT_STATE_CUSTOM_TYPE,
        expect.objectContaining({ state: "evaluating" }),
      );
      await emit(fixture, "agent_end", {
        type: "agent_end",
        messages: [{ role: "custom", customType: "resyst-vault.evaluate", content: "opaque", display: false }],
      }, ctx);
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });

      await emit(fixture, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });

      const resumed = harness();
      install(resumed, store);
      await emit(
        resumed,
        "session_start",
        { type: "session_start", reason: "resume" },
        context({ id: "session-atlas", rlmDepth: 0 }),
      );
      expect(resumed.sendMessage).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps fire-and-forget host submission durably retryable without duplicating reload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-void-send-"));
    try {
      const fixture = harness();
      fixture.sendMessage.mockImplementationOnce(() => undefined);
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });
      await emit(fixture, "session_start", { type: "session_start", reason: "reload" }, ctx);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("cancels an in-flight boundary when the authoritative session switches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-switch-race-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      const originalCurrent = store.current.bind(store);
      let enter: (() => void) | undefined;
      let release: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(store, "current").mockImplementationOnce(async (sessionId) => {
        enter?.();
        await blocked;
        return await originalCurrent(sessionId);
      });
      const ending = emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      await entered;
      await emit(fixture, "session_before_switch", { type: "session_before_switch" }, ctx);
      release?.();
      await ending;
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(fixture.api.getActiveTools()).not.toContain("vault_checkpoint");
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("narrows hostile agent-end message arrays without throwing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-hostile-event-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      const revoked = Proxy.revocable([], {});
      revoked.revoke();
      await expect(emit(fixture, "agent_end", {
        type: "agent_end",
        messages: revoked.proxy,
      }, ctx)).resolves.toBeDefined();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(await store.load("session-atlas")).toMatchObject({ state: "substantial_pending" });
      await emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx);
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps failed hidden-send evaluation pending for a later external boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-auto-send-failure-"));
    try {
      const fixture = harness();
      fixture.sendMessage.mockRejectedValueOnce(new Error("synthetic send failure"));
      const store = new PendingStateStore({ stateRoot: root });
      install(fixture, store);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await startRoot(fixture, ctx);
      await substantial(fixture, ctx);
      await expect(
        emit(fixture, "agent_end", { type: "agent_end", messages: terminalMessages() }, ctx),
      ).resolves.toBeDefined();
      expect(await store.load("session-atlas")).toMatchObject({ state: "evaluation_pending" });
      expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
