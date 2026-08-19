import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  createVaultExtension,
  type CreateVaultExtensionOptions,
} from "../../src/extension/index.js";
import {
  CHECKPOINT_TOOL_UNAVAILABLE,
  type CheckpointService,
  type VaultCheckpointCommandModel,
} from "../../src/extension/checkpoint.js";
import { createProductionCheckpointService } from "../../src/checkpoint-service.js";
import { loadConfig } from "../../src/config.js";
import { JournalStore } from "../../src/journal.js";
import { TransactionCrashError, TransactionService } from "../../src/transaction.js";
import {
  CHECKPOINT_STATE_CUSTOM_TYPE,
  CheckpointStateError,
  PendingStateStore,
} from "../../src/extension/state.js";
import { createVault } from "../fixtures/create-vault.js";

interface Harness {
  api: ExtensionAPI;
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>>>;
  tools: ToolDefinition[];
  appendEntry: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>>>();
  const tools: ToolDefinition[] = [];
  const appendEntry = vi.fn();
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
  } as unknown as ExtensionAPI;
  return { api, handlers, tools, appendEntry };
}

function context(header: unknown, entries: unknown[] = [], cwd = "/home/tester/atlas"): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getHeader: () => header,
      getEntries: () => entries,
    },
  } as unknown as ExtensionContext;
}

async function emit(
  fixture: Harness,
  name: string,
  event: unknown,
  ctx: ExtensionContext,
): Promise<unknown[]> {
  return Promise.all((fixture.handlers.get(name) ?? []).map((handler) => handler(event, ctx)));
}

function fakeReadService() {
  return {
    bootstrap: vi.fn(async () => ""),
    search: vi.fn(async () => ({ version: 1 as const, hits: [], truncated: false, scanned_notes: 0, cache: "bypassed" as const })),
    read: vi.fn(async () => {
      throw new Error("unused");
    }),
  };
}

function noopCommand() {
  return { version: 1, kind: "noop", reason: "no_new_knowledge" } as const;
}

function applyCommand(): VaultCheckpointCommandModel {
  return {
    version: 1,
    kind: "apply",
    knowledge: {
      completed_tasks: [{ text: "Finished Atlas integration", evidence: ["commit-1"] }],
      decisions: [],
      status_changes: [],
      blockers: [],
      reusable_learnings: [],
      next_steps: [],
    },
    evidence: {
      commits: [{ id: "commit-1", value: "abc123" }],
      tests: [],
      files: [],
      deployments: [],
      observations: [],
    },
    targets: { daily: true, project: false, landscape: false },
  };
}

async function install(
  root: string,
  fixture: Harness,
  checkpointService: CheckpointService,
  extra: Partial<CreateVaultExtensionOptions> = {},
): Promise<PendingStateStore> {
  const store = new PendingStateStore({ stateRoot: root });
  createVaultExtension({
    service: fakeReadService(),
    checkpointService,
    checkpointStateStore: store,
    now: () => new Date("2026-08-13T00:00:00.000Z"),
    ...extra,
  })(fixture.api);
  return store;
}

function checkpointTool(fixture: Harness): ToolDefinition {
  const tool = fixture.tools.find((candidate) => candidate.name === "vault_checkpoint");
  if (tool === undefined) throw new Error("checkpoint tool not registered");
  return tool;
}

describe("Prime root checkpoint integration", () => {
  it("registers checkpoint late only for an authoritative root and exposes an exact schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-checkpoint-register-"));
    try {
      const service: CheckpointService = { checkpoint: vi.fn(async () => ({ outcome: "noop" })) };
      const rootHarness = harness();
      await install(root, rootHarness, service);
      expect(rootHarness.tools.map((tool) => tool.name).sort()).toEqual(["vault_read", "vault_search"]);
      await emit(rootHarness, "session_start", { type: "session_start", reason: "startup" }, context({ id: "session-atlas", rlmDepth: 0 }));
      expect(rootHarness.tools.map((tool) => tool.name).sort()).toEqual(["vault_checkpoint", "vault_read", "vault_search"]);
      const tool = checkpointTool(rootHarness);
      expect(Value.Check(tool.parameters, noopCommand())).toBe(true);
      expect(Value.Check(tool.parameters, applyCommand())).toBe(true);
      expect(Value.Check(tool.parameters, { ...applyCommand(), source: { agent: "prime-agent" } })).toBe(false);
      expect(Value.Check(tool.parameters, { ...applyCommand(), project: { id: "spoof" } })).toBe(false);
      expect(Value.Check(tool.parameters, { ...noopCommand(), cwd: "/spoof" })).toBe(false);
      expect(tool.executionMode).toBe("sequential");
      const boundedApply = applyCommand();
      if (boundedApply.kind !== "apply") throw new Error("synthetic apply unavailable");
      expect(Value.Check(tool.parameters, {
        ...boundedApply,
        knowledge: {
          ...boundedApply.knowledge,
          decisions: Array.from({ length: 33 }, (_, index) => ({ text: `decision-${index}`, evidence: [] })),
        },
      })).toBe(false);

      await emit(
        rootHarness,
        "session_start",
        { type: "session_start", reason: "startup" },
        context({ id: "session-child-after-root", rlmDepth: 1 }),
      );
      expect(rootHarness.api.getActiveTools()).not.toContain("vault_checkpoint");

      for (const header of [
        { id: "session-child", rlmDepth: 1 },
        { id: "session-child" },
        { id: "session-child", rlmDepth: "0" },
        { id: "session-child", rlmDepth: -1 },
      ]) {
        const childHarness = harness();
        await install(root, childHarness, service, {
          authorityEnv: {},
          loadPiRootAuthority: async () => false,
        });
        await emit(childHarness, "session_start", { type: "session_start", reason: "startup" }, context(header));
        expect(childHarness.tools.some((tool) => tool.name === "vault_checkpoint")).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("grants opted-in Pi roots, records Pi provenance, and never grants children", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-pi-checkpoint-authority-"));
    try {
      const env: Record<string, string | undefined> = {};
      const run = vi.fn(async () => ({ outcome: "noop" as const }));
      const bootstrap = vi.fn(async () => "PI CONTEXT");
      const rootHarness = harness();
      await install(root, rootHarness, { checkpoint: run }, {
        authorityEnv: env,
        loadPiRootAuthority: async () => true,
        service: { ...fakeReadService(), bootstrap },
      });
      const rootCtx = context({ id: "session-pi" });
      await emit(rootHarness, "session_start", { type: "session_start", reason: "startup" }, rootCtx);
      expect(rootHarness.api.getActiveTools()).toContain("vault_checkpoint");
      await expect(checkpointTool(rootHarness).execute(
        "pi-noop",
        noopCommand(),
        undefined,
        undefined,
        rootCtx,
      )).resolves.toMatchObject({ details: { outcome: "noop" } });
      expect(run).toHaveBeenCalledWith({
        command: noopCommand(),
        trusted: {
          agent: "pi",
          cwd: "/home/tester/atlas",
          session_id: "session-pi",
        },
      });
      const [bootstrapResult] = await emit(rootHarness, "before_agent_start", {
        type: "before_agent_start",
        prompt: "status",
        systemPrompt: "BASE",
      }, rootCtx);
      expect(bootstrapResult).toMatchObject({ systemPrompt: expect.stringContaining("PI CONTEXT") });

      env.PI_SUBAGENT_CHILD = "1";
      const revoked = await checkpointTool(rootHarness).execute(
        "pi-revoked",
        noopCommand(),
        undefined,
        undefined,
        rootCtx,
      );
      expect(revoked).toMatchObject({ details: { outcome: "unavailable" } });
      expect(run).toHaveBeenCalledTimes(1);
      expect((await emit(rootHarness, "before_agent_start", {
        type: "before_agent_start",
        prompt: "after revoke",
        systemPrompt: "BASE",
      }, rootCtx))[0]).toBeUndefined();
      delete env.PI_SUBAGENT_CHILD;
      const stillRevoked = await checkpointTool(rootHarness).execute(
        "pi-still-revoked",
        noopCommand(),
        undefined,
        undefined,
        rootCtx,
      );
      expect(stillRevoked).toMatchObject({ details: { outcome: "unavailable" } });
      expect((await emit(rootHarness, "before_agent_start", {
        type: "before_agent_start",
        prompt: "cannot restore",
        systemPrompt: "BASE",
      }, rootCtx))[0]).toBeUndefined();

      const childEnv: Record<string, string | undefined> = {
        PI_SUBAGENT_CHILD: "1",
        PI_SUBAGENT_DEPTH: "1",
      };
      const childHarness = harness();
      await install(root, childHarness, { checkpoint: run }, {
        authorityEnv: childEnv,
        loadPiRootAuthority: async () => true,
      });
      const childCtx = context({ id: "session-child" });
      await emit(childHarness, "session_start", { type: "session_start", reason: "startup" }, childCtx);
      delete childEnv.PI_SUBAGENT_CHILD;
      delete childEnv.PI_SUBAGENT_DEPTH;
      expect(childHarness.tools.some((tool) => tool.name === "vault_checkpoint")).toBe(false);
      expect((await emit(childHarness, "before_agent_start", {
        type: "before_agent_start",
        prompt: "cannot promote",
        systemPrompt: "BASE",
      }, childCtx))[0]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the root checkpoint authoritative after the same factory starts a child", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-checkpoint-isolation-"));
    try {
      const run = vi.fn(async () => ({ outcome: "noop" as const }));
      const store = new PendingStateStore({ stateRoot: root });
      const factory = createVaultExtension({
        service: fakeReadService(),
        checkpointService: { checkpoint: run },
        checkpointStateStore: store,
        now: () => new Date("2026-08-13T00:00:00.000Z"),
      });
      const rootHarness = harness();
      const childHarness = harness();
      factory(rootHarness.api);
      factory(childHarness.api);

      const rootCtx = context({ id: "session-atlas", rlmDepth: 0 });
      await emit(rootHarness, "session_start", { type: "session_start", reason: "startup" }, rootCtx);
      expect(rootHarness.api.getActiveTools()).toContain("vault_checkpoint");

      await emit(
        childHarness,
        "session_start",
        { type: "session_start", reason: "startup" },
        context({ id: "session-child", rlmDepth: 1 }),
      );
      expect(childHarness.tools.some((tool) => tool.name === "vault_checkpoint")).toBe(false);

      await emit(rootHarness, "tool_result", {
        type: "tool_result",
        toolCallId: "edit-after-child",
        toolName: "edit",
        input: { path: "src/app.ts" },
        content: [],
        details: {},
        isError: false,
      }, rootCtx);
      expect(rootHarness.appendEntry).toHaveBeenLastCalledWith(
        CHECKPOINT_STATE_CUSTOM_TYPE,
        expect.objectContaining({ state: "substantial_pending" }),
      );

      const result = await checkpointTool(rootHarness).execute(
        "checkpoint-after-child",
        noopCommand(),
        undefined,
        undefined,
        rootCtx,
      );
      expect(run).toHaveBeenCalledOnce();
      expect(result.content).toEqual([{ type: "text", text: "vault checkpoint: noop" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tracks substantial effects and persists one evaluated noop marker plus one-line receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-checkpoint-noop-"));
    try {
      const run = vi.fn(async () => ({ outcome: "noop" as const }));
      const fixture = harness();
      const store = await install(root, fixture, { checkpoint: run });
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await emit(fixture, "session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit(fixture, "tool_result", {
        type: "tool_result",
        toolCallId: "edit-1",
        toolName: "edit",
        input: { path: "src/app.ts" },
        content: [],
        details: {},
        isError: false,
      }, ctx);
      expect((await store.load("session-atlas"))?.state).toBe("substantial_pending");

      const result = await checkpointTool(fixture).execute(
        "checkpoint-1",
        noopCommand(),
        undefined,
        undefined,
        ctx,
      );
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith({
        command: noopCommand(),
        trusted: {
          agent: "prime-agent",
          cwd: "/home/tester/atlas",
          session_id: "session-atlas",
        },
      });
      expect(result.content).toEqual([{ type: "text", text: "vault checkpoint: noop" }]);
      expect(result.details).toEqual({ version: 1, outcome: "noop" });
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toMatch(/[\r\n]/u);
      const saved = await store.load("session-atlas");
      expect(saved?.state).toBe("evaluated");
      expect(saved?.checkpoint_seen).toBe(true);
      expect(fixture.appendEntry).toHaveBeenLastCalledWith(
        CHECKPOINT_STATE_CUSTOM_TYPE,
        saved,
      );

      await emit(fixture, "tool_result", {
        type: "tool_result",
        toolCallId: "edit-2",
        toolName: "edit",
        input: { path: "src/second.ts" },
        content: [],
        details: {},
        isError: false,
      }, ctx);
      expect((await store.load("session-atlas"))?.state).toBe("substantial_pending");
      await checkpointTool(fixture).execute(
        "checkpoint-2",
        noopCommand(),
        undefined,
        undefined,
        ctx,
      );
      expect(run).toHaveBeenCalledTimes(2);
      expect((await store.load("session-atlas"))?.state).toBe("evaluated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rechecks root authority at execute and preserves pending state on deferred/failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-checkpoint-fail-"));
    try {
      const outcomes = [
        { outcome: "deferred" as const },
        { outcome: "failed" as const },
      ];
      const run = vi.fn(async () => outcomes.shift() ?? { outcome: "failed" as const });
      const fixture = harness();
      const store = await install(root, fixture, { checkpoint: run });
      const rootCtx = context({ id: "session-atlas", rlmDepth: 0 });
      await emit(fixture, "session_start", { type: "session_start", reason: "startup" }, rootCtx);
      await emit(fixture, "tool_result", {
        type: "tool_result", toolCallId: "edit-1", toolName: "edit", input: {}, content: [], isError: false,
      }, rootCtx);
      const tool = checkpointTool(fixture);
      const childResult = await tool.execute(
        "child-spoof",
        applyCommand(),
        undefined,
        undefined,
        context({ id: "session-child", rlmDepth: 1 }),
      );
      expect(childResult.content).toEqual([{ type: "text", text: CHECKPOINT_TOOL_UNAVAILABLE }]);
      expect(run).not.toHaveBeenCalled();

      const deferred = await tool.execute("deferred", applyCommand(), undefined, undefined, rootCtx);
      expect(deferred.content).toEqual([{ type: "text", text: "vault checkpoint: deferred" }]);
      expect((await store.load("session-atlas"))?.state).toBe("evaluation_pending");
      const failed = await tool.execute("failed", applyCommand(), undefined, undefined, rootCtx);
      expect(failed.content).toEqual([{ type: "text", text: "vault checkpoint: failed" }]);
      expect((await store.load("session-atlas"))?.state).toBe("evaluation_pending");

      const throwing = harness();
      const throwingStore = await install(root, throwing, {
        checkpoint: vi.fn(async () => { throw new Error("synthetic failure"); }),
      });
      const throwingCtx = context({ id: "session-throw", rlmDepth: 0 });
      await emit(throwing, "session_start", { type: "session_start", reason: "startup" }, throwingCtx);
      const unavailable = await checkpointTool(throwing).execute(
        "throwing",
        applyCommand(),
        undefined,
        undefined,
        throwingCtx,
      );
      expect(unavailable.content).toEqual([{ type: "text", text: CHECKPOINT_TOOL_UNAVAILABLE }]);
      expect((await throwingStore.load("session-throw"))?.state).toBe("substantial_pending");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a symbolic in-memory pending state when local persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-checkpoint-volatile-"));
    try {
      class FlakyStore extends PendingStateStore {
        failWrites = false;
        override async save(record: Parameters<PendingStateStore["save"]>[0]): Promise<void> {
          if (this.failWrites) throw new CheckpointStateError("io_error");
          await super.save(record);
        }
      }
      const store = new FlakyStore({ stateRoot: root });
      const fixture = harness();
      createVaultExtension({
        service: fakeReadService(),
        checkpointService: { checkpoint: vi.fn(async () => ({ outcome: "noop" })) },
        checkpointStateStore: store,
        now: () => new Date("2026-08-13T00:00:00.000Z"),
      })(fixture.api);
      const ctx = context({ id: "session-atlas", rlmDepth: 0 });
      await emit(fixture, "session_start", { type: "session_start", reason: "startup" }, ctx);
      store.failWrites = true;
      await emit(fixture, "tool_result", {
        type: "tool_result", toolCallId: "edit-fail", toolName: "edit", input: {}, isError: false,
      }, ctx);
      expect(await store.current("session-atlas")).toMatchObject({ state: "substantial_pending" });
      expect(await store.load("session-atlas")).toMatchObject({ state: "clean" });
      expect(fixture.appendEntry).toHaveBeenLastCalledWith(
        "resyst-vault.checkpoint-warning",
        { version: 1, status: "pending_unpersisted" },
      );
      store.failWrites = false;
      await emit(fixture, "tool_result", {
        type: "tool_result", toolCallId: "edit-retry", toolName: "edit", input: {}, isError: false,
      }, ctx);
      expect(await store.load("session-atlas")).toMatchObject({ state: "substantial_pending", revision: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats malformed root tool results conservatively without child dedupe poisoning", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-checkpoint-hostile-"));
    try {
      const fixture = harness();
      const store = await install(root, fixture, { checkpoint: vi.fn(async () => ({ outcome: "noop" })) });
      const rootCtx = context({ id: "session-atlas", rlmDepth: 0 });
      await emit(fixture, "session_start", { type: "session_start", reason: "startup" }, rootCtx);
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      await expect(emit(fixture, "tool_result", proxy, rootCtx)).resolves.toBeDefined();
      expect((await store.current("session-atlas"))?.state).toBe("evaluation_pending");

      await emit(
        fixture,
        "tool_result",
        { type: "tool_result", toolCallId: "shared", toolName: "edit", input: {}, isError: false },
        context({ id: "session-child", rlmDepth: 1 }),
      );
      await emit(
        fixture,
        "tool_result",
        { type: "tool_result", toolCallId: "shared", toolName: "edit", input: {}, isError: false },
        rootCtx,
      );
      expect(await store.current("session-atlas")).toMatchObject({
        state: "evaluation_pending",
        revision: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores resume/compaction from local state and resets new or fork sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-checkpoint-lifecycle-"));
    try {
      const store = new PendingStateStore({ stateRoot: root });
      await store.save({
        version: 1, session_id: "session-atlas", revision: 5,
        state: "substantial_pending", substantial: true, uncertainty: false,
        checkpoint_seen: false, updated_at: "2026-08-12T23:59:00.000Z",
      });
      const service: CheckpointService = { checkpoint: vi.fn(async () => ({ outcome: "noop" })) };
      const resumed = harness();
      createVaultExtension({
        service: fakeReadService(), checkpointService: service,
        checkpointStateStore: store,
        now: () => new Date("2026-08-13T00:00:00.000Z"),
      })(resumed.api);
      const resumedCtx = context({ id: "session-atlas", rlmDepth: 0 }, []);
      await emit(resumed, "session_start", { type: "session_start", reason: "resume" }, resumedCtx);
      expect((await store.load("session-atlas"))?.state).toBe("substantial_pending");
      await emit(resumed, "session_compact", { type: "session_compact" }, resumedCtx);
      expect(resumed.appendEntry).toHaveBeenLastCalledWith(
        CHECKPOINT_STATE_CUSTOM_TYPE,
        expect.objectContaining({ state: "substantial_pending" }),
      );

      for (const reason of ["new", "fork"] as const) {
        const fresh = harness();
        createVaultExtension({
          service: fakeReadService(), checkpointService: service,
          checkpointStateStore: store,
          now: () => new Date("2026-08-13T00:00:00.000Z"),
        })(fresh.api);
        const freshCtx = context({ id: `session-${reason}`, rlmDepth: 0 }, [
          { type: "custom", customType: CHECKPOINT_STATE_CUSTOM_TYPE, data: { ...(await store.load("session-atlas")), session_id: `session-${reason}` } },
        ]);
        await emit(fresh, "session_start", { type: "session_start", reason }, freshCtx);
        expect((await store.load(`session-${reason}`))?.state).toBe("clean");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers missing local pending state from the newest bounded mirror", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-checkpoint-mirror-"));
    try {
      const fixture = harness();
      const store = new PendingStateStore({ stateRoot: root });
      createVaultExtension({
        service: fakeReadService(),
        checkpointService: { checkpoint: vi.fn(async () => ({ outcome: "noop" })) },
        checkpointStateStore: store,
        now: () => new Date("2026-08-13T00:00:00.000Z"),
      })(fixture.api);
      const mirror = {
        version: 1 as const,
        session_id: "session-atlas",
        revision: 4,
        state: "substantial_pending" as const,
        substantial: true,
        uncertainty: false,
        checkpoint_seen: false,
        updated_at: "2026-08-12T23:59:00.000Z",
      };
      const entries = [
        {
          type: "custom",
          customType: CHECKPOINT_STATE_CUSTOM_TYPE,
          data: mirror,
        },
        ...Array.from({ length: 256 }, (_, index) => ({ type: "message", id: index })),
      ];
      class SyntheticSessionManager {
        getHeader() { return { id: "session-atlas", rlmDepth: 0 }; }
        getEntries() { return entries; }
      }
      const ctx = {
        cwd: "/home/tester/atlas",
        sessionManager: new SyntheticSessionManager(),
      } as unknown as ExtensionContext;
      await emit(
        fixture,
        "session_start",
        { type: "session_start", reason: "resume" },
        ctx,
      );
      await expect(store.load("session-atlas")).resolves.toMatchObject({
        revision: 1,
        state: "evaluation_pending",
      });
      expect(checkpointTool(fixture).name).toBe("vault_checkpoint");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps read tools available when hostile state roots disable checkpoint state", async () => {
    const prior = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "relative-hostile-state";
    try {
      const fixture = harness();
      expect(() =>
        createVaultExtension({
          service: fakeReadService(),
          checkpointService: { checkpoint: vi.fn(async () => ({ outcome: "noop" })) },
        })(fixture.api),
      ).not.toThrow();
      await emit(
        fixture,
        "session_start",
        { type: "session_start", reason: "startup" },
        context({ id: "session-atlas", rlmDepth: 0 }),
      );
      expect(fixture.tools.map((tool) => tool.name).sort()).toEqual([
        "vault_read",
        "vault_search",
      ]);
    } finally {
      if (prior === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prior;
    }
  });

  it("routes a production apply through the transaction service using only synthetic trusted context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-checkpoint-production-"));
    try {
      const vaultPath = path.join(root, "vault");
      const configHome = path.join(root, "config");
      const stateHome = path.join(root, "state");
      const vault = await createVault({
        vaultPath,
        withDailyNote: true,
        withProjectNote: true,
        dailyNoteDate: "2026-08-13",
      });
      await mkdir(path.join(configHome, "resyst-vault"), { recursive: true });
      await writeFile(
        path.join(configHome, "resyst-vault", "config.json"),
        JSON.stringify({
          version: 1,
          host_id: "casey",
          vault_path: vaultPath,
          project_overrides: [{ path: root, project_id: "atlas" }],
        }),
        "utf8",
      );
      const service = createProductionCheckpointService({
        xdgConfigHome: configHome,
        xdgStateHome: stateHome,
        now: () => new Date("2026-08-13T00:00:00.000Z"),
      });
      const outcome = await service.checkpoint({
        command: applyCommand(),
        trusted: { cwd: root, session_id: "session-atlas" },
      });
      expect(outcome.outcome).toBe("applied");
      const daily = await readFile(vault.dailyNoteAbsolute("2026-08-13"), "utf8");
      expect(daily).toContain("Finished Atlas integration");
      const journalFiles = await import("node:fs/promises").then((fs) => fs.readdir(vault.paths.journalDir, { recursive: true }));
      const receiptFiles = await import("node:fs/promises").then((fs) => fs.readdir(vault.paths.receiptsDir, { recursive: true }));
      expect(journalFiles.some((name) => String(name).endsWith(".json"))).toBe(true);
      expect(receiptFiles.some((name) => String(name).endsWith(".json"))).toBe(true);
      const applyJournalName = journalFiles.find((name) => String(name).endsWith(".json"));
      expect(applyJournalName).toBeDefined();
      const durableApply = JSON.parse(
        await readFile(path.join(vault.paths.journalDir, String(applyJournalName)), "utf8"),
      ) as { checkpoint?: { source?: unknown; project?: unknown } };
      expect(durableApply.checkpoint?.source).toEqual({
        agent: "prime-agent",
        host_id: "casey",
        session_id: "session-atlas",
        cwd: root,
      });
      expect(durableApply.checkpoint?.project).toEqual({ id: "atlas" });
      await expect(service.checkpoint({
        command: applyCommand(),
        trusted: { cwd: root, session_id: "session-atlas" },
      })).resolves.toEqual({ outcome: "already_applied" });

      const secondApply = applyCommand();
      if (secondApply.kind !== "apply") throw new Error("synthetic apply unavailable");
      const secondOutcome = await service.checkpoint({
        command: {
          ...secondApply,
          knowledge: {
            ...secondApply.knowledge,
            completed_tasks: [{ text: "Finished Atlas follow-up", evidence: ["commit-1"] }],
          },
        },
        trusted: { cwd: root, session_id: "session-atlas" },
      });
      expect(secondOutcome.outcome).toBe("applied");
      const dailyAfterSecond = await readFile(vault.dailyNoteAbsolute("2026-08-13"), "utf8");
      expect(dailyAfterSecond).toContain("Finished Atlas follow-up");
      const sessionMarkers = [...dailyAfterSecond.matchAll(
        /resyst-vault:begin session=session-atlas target=([^ ]+)/gu,
      )].map((match) => match[1]);
      expect(sessionMarkers).toHaveLength(4);
      expect(new Set(sessionMarkers).size).toBe(4);

      await expect(service.checkpoint({
        command: applyCommand(),
        trusted: { agent: "pi", cwd: root, session_id: "session-pi" },
      })).resolves.toEqual({ outcome: "applied" });
      const journalAfterPi = await import("node:fs/promises").then((fs) =>
        fs.readdir(vault.paths.journalDir, { recursive: true }),
      );
      const durableAgents = await Promise.all(
        journalAfterPi
          .filter((name) => String(name).endsWith(".json"))
          .map(async (name) => {
            const parsed = JSON.parse(
              await readFile(path.join(vault.paths.journalDir, String(name)), "utf8"),
            ) as { checkpoint?: { source?: { agent?: unknown } } };
            return parsed.checkpoint?.source?.agent;
          }),
      );
      expect(durableAgents).toContain("pi");

      const config = await loadConfig({ xdgConfigHome: configHome });
      const crashJournal = new JournalStore({
        vaultRoot: config.vault_path,
        identity: config.vault_identity,
        now: () => "2026-08-13T00:00:00.000Z",
      });
      let crashOnce = true;
      const crashTransaction = new TransactionService({
        vaultRoot: config.vault_path,
        stateRoot: stateHome,
        journal: crashJournal,
        config,
        now: () => "2026-08-13T00:00:00.000Z",
        afterRename: async () => {
          if (crashOnce) {
            crashOnce = false;
            throw new TransactionCrashError();
          }
        },
      });
      const crashService = createProductionCheckpointService({
        xdgConfigHome: configHome,
        xdgStateHome: stateHome,
        journal: crashJournal,
        transaction: crashTransaction,
        now: () => new Date("2026-08-13T00:00:00.000Z"),
      });
      const crashApply = applyCommand();
      if (crashApply.kind !== "apply") throw new Error("synthetic apply unavailable");
      const crashCommand: VaultCheckpointCommandModel = {
        ...crashApply,
        knowledge: {
          ...crashApply.knowledge,
          completed_tasks: [{ text: "Finished crash frontier", evidence: ["commit-1"] }],
          status_changes: [{ text: "Crash frontier recovered", evidence: ["commit-1"] }],
        },
        targets: { daily: true, project: true, landscape: false },
      };
      await expect(crashService.checkpoint({
        command: crashCommand,
        trusted: { cwd: root, session_id: "session-crash" },
      })).rejects.toBeInstanceOf(TransactionCrashError);
      await expect(service.checkpoint({
        command: crashCommand,
        trusted: { cwd: root, session_id: "session-crash" },
      })).resolves.toEqual({ outcome: "applied" });
      expect(await readFile(vault.dailyNoteAbsolute("2026-08-13"), "utf8")).toContain("Finished crash frontier");
      expect(await readFile(vault.absolute("Proyectos/Atlas.md"), "utf8")).toContain("Crash frontier recovered");

      const noop = await service.checkpoint({
        command: noopCommand(),
        trusted: { cwd: root, session_id: "session-atlas" },
      });
      expect(noop.outcome).toBe("noop");
      const journalAfterNoop = await import("node:fs/promises").then((fs) =>
        fs.readdir(vault.paths.journalDir, { recursive: true }),
      );
      const receiptsAfterNoop = await import("node:fs/promises").then((fs) =>
        fs.readdir(vault.paths.receiptsDir, { recursive: true }),
      );
      expect(journalAfterNoop.filter((name) => String(name).endsWith(".json"))).toHaveLength(5);
      expect(receiptsAfterNoop.filter((name) => String(name).endsWith(".json"))).toHaveLength(5);
      await expect(
        service.checkpoint({
          command: noopCommand(),
          trusted: { cwd: root, session_id: "session-atlas" },
        }),
      ).resolves.toEqual({ outcome: "noop" });
      const receiptAfterRetry = await import("node:fs/promises").then((fs) =>
        fs.readdir(vault.paths.receiptsDir, { recursive: true }),
      );
      expect(receiptAfterRetry.filter((name) => String(name).endsWith(".json"))).toHaveLength(5);

      await expect(Promise.all([
        service.checkpoint({ command: noopCommand(), trusted: { cwd: root, session_id: "session-race" } }),
        service.checkpoint({ command: noopCommand(), trusted: { cwd: root, session_id: "session-race" } }),
      ])).resolves.toEqual([{ outcome: "noop" }, { outcome: "noop" }]);
      const receiptsAfterRace = await import("node:fs/promises").then((fs) =>
        fs.readdir(vault.paths.receiptsDir, { recursive: true }),
      );
      expect(receiptsAfterRace.filter((name) => String(name).endsWith(".json"))).toHaveLength(6);

      await expect(
        service.checkpoint({
          command: noopCommand(),
          trusted: { cwd: root, session_id: "session-other" },
        }),
      ).resolves.toEqual({ outcome: "noop" });
      const journalAfterOtherSession = await import("node:fs/promises").then((fs) =>
        fs.readdir(vault.paths.journalDir, { recursive: true }),
      );
      expect(
        journalAfterOtherSession.filter((name) => String(name).endsWith(".json")),
      ).toHaveLength(7);

      const projectBefore = await readFile(vault.absolute("Proyectos/Atlas.md"), "utf8");
      const unresolvedCwd = path.join(root, "unmatched");
      await mkdir(unresolvedCwd);
      await writeFile(
        path.join(configHome, "resyst-vault", "config.json"),
        JSON.stringify({ version: 1, host_id: "casey", vault_path: vaultPath }),
        "utf8",
      );
      await expect(service.checkpoint({
        command: applyCommand(),
        trusted: { cwd: unresolvedCwd, session_id: "session-unresolved" },
      })).resolves.toEqual({ outcome: "applied" });
      expect(await readFile(vault.absolute("Proyectos/Atlas.md"), "utf8")).toBe(projectBefore);
      const inboxFiles = await import("node:fs/promises").then((fs) =>
        fs.readdir(path.join(vaultPath, "Inbox")),
      );
      expect(inboxFiles.filter((name) => name.startsWith("resyst-association-"))).toHaveLength(1);
      await expect(service.checkpoint({
        command: applyCommand(),
        trusted: { cwd: unresolvedCwd, session_id: "session-unresolved" },
      })).resolves.toEqual({ outcome: "already_applied" });
      const inboxAfterRetry = await import("node:fs/promises").then((fs) =>
        fs.readdir(path.join(vaultPath, "Inbox")),
      );
      expect(inboxAfterRetry.filter((name) => name.startsWith("resyst-association-"))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
