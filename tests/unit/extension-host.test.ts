import { describe, expect, it } from "vitest";
import {
  BootstrapLoopCache,
  MAX_CACHE_KEYS,
  MAX_IN_FLIGHT_LOADS,
  authorityFromHeader,
  promptFingerprint,
  safeReadStringProperty,
} from "../../src/extension/host.js";

describe("Prime host authority", () => {
  it.each([
    [0, true, 0],
    [1, false, 1],
    [9, false, 9],
    [undefined, false, null],
    ["0", false, null],
    [-1, false, null],
    [1.5, false, null],
    [Number.NaN, false, null],
    [Number.POSITIVE_INFINITY, false, null],
    [Number.MAX_SAFE_INTEGER + 1, false, null],
  ])("treats persisted integer depth %s as the only authority", (depth, isRoot, normalizedDepth) => {
    const authority = authorityFromHeader({
      type: "session",
      id: "session-atlas",
      rlmDepth: depth,
      name: "root",
      parentSession: undefined,
      cwd: "/root-looking/path",
      model: "spoofed-root",
    });
    expect(authority).toEqual({ session_id: "session-atlas", depth: normalizedDepth, is_root: isRoot });
  });

  it("requires a bounded nonempty session id without trusting spoofable metadata", () => {
    expect(authorityFromHeader({ id: "", rlmDepth: 0 }).is_root).toBe(false);
    expect(authorityFromHeader({ id: "x".repeat(1025), rlmDepth: 0 }).is_root).toBe(false);
    expect(authorityFromHeader(null)).toEqual({ session_id: null, depth: null, is_root: false });
    expect(authorityFromHeader({ name: "root", parentSession: null, rlmDepth: "0" }).is_root).toBe(false);
  });

  it("treats throwing getters, revoked proxies, and hostile shapes as fail-closed", () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("private path");
        },
      },
    );
    expect(authorityFromHeader(throwing)).toEqual({
      session_id: null,
      depth: null,
      is_root: false,
    });
    const throwingRlmDepth = {
      id: "session-atlas",
      get rlmDepth(): never {
        throw new Error("private");
      },
    };
    expect(authorityFromHeader(throwingRlmDepth)).toEqual({
      session_id: "session-atlas",
      depth: null,
      is_root: false,
    });
    const nonStringId = {
      id: { toString: () => "session-atlas" },
      rlmDepth: 0,
    };
    expect(authorityFromHeader(nonStringId)).toEqual({
      session_id: null,
      depth: null,
      is_root: false,
    });
  });
});

describe("host-side defensive primitive readers", () => {
  it("returns null for non-objects, throwing getters, and oversize strings", () => {
    expect(safeReadStringProperty(null, "id", 100)).toBeNull();
    expect(safeReadStringProperty(undefined, "id", 100)).toBeNull();
    expect(safeReadStringProperty("string-not-object", "id", 100)).toBeNull();
    expect(safeReadStringProperty(42, "id", 100)).toBeNull();
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error("private");
        },
      },
    );
    expect(safeReadStringProperty(trap, "id", 100)).toBeNull();
    expect(safeReadStringProperty({}, "id", 100)).toBeNull();
    expect(safeReadStringProperty({ id: "" }, "id", 100)).toBeNull();
    expect(safeReadStringProperty({ id: "x".repeat(101) }, "id", 100)).toBeNull();
    expect(safeReadStringProperty({ id: 42 }, "id", 100)).toBeNull();
    expect(safeReadStringProperty({ id: "session-atlas" }, "id", 100)).toBe(
      "session-atlas",
    );
  });
});

describe("ephemeral bootstrap loop cache", () => {
  it("fingerprints normalized prompt text without retaining it", () => {
    const first = promptFingerprint("  Atlas\r\n  status  ");
    const second = promptFingerprint("Atlas\nstatus");
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain("Atlas");
  });

  it("returns a stable fingerprint for non-string or oversized inputs", () => {
    const objectFingerprint = promptFingerprint({ malicious: true });
    const arrayFingerprint = promptFingerprint(["x"]);
    const numberFingerprint = promptFingerprint(42);
    expect(objectFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(arrayFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(numberFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(objectFingerprint).not.toContain("malicious");
    const oversized = "a".repeat(70_000);
    const oversizedFingerprint = promptFingerprint(oversized);
    expect(oversizedFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(oversizedFingerprint).toBe(promptFingerprint(oversized));
    expect(oversizedFingerprint).not.toBe(promptFingerprint(oversized.slice(0, 1024)));
  });

  it("deduplicates successful and concurrent loads only within one loop", async () => {
    const cache = new BootstrapLoopCache();
    let calls = 0;
    let release: ((value: string) => void) | undefined;
    const load = () => {
      calls += 1;
      return new Promise<string>((resolve) => { release = resolve; });
    };
    const first = cache.load("session-atlas", "same prompt", load);
    const second = cache.load("session-atlas", "same prompt", load);
    expect(calls).toBe(1);
    release?.("context");
    await expect(first).resolves.toBe("context");
    await expect(second).resolves.toBeNull();
    await expect(cache.load("session-atlas", "same prompt", async () => "again")).resolves.toBeNull();
    cache.clear();
    await expect(cache.load("session-atlas", "same prompt", async () => "next loop")).resolves.toBe("next loop");
  });

  it("does not cache empty or failed loads", async () => {
    const cache = new BootstrapLoopCache();
    await expect(cache.load("session-atlas", "prompt", async () => "")).resolves.toBeNull();
    await expect(cache.load("session-atlas", "prompt", async () => { throw new Error("private path"); })).rejects.toThrow();
    await expect(cache.load("session-atlas", "prompt", async () => "recovered")).resolves.toBe("recovered");
  });

  it("stores only a completed marker, never the resolved context text", async () => {
    const cache = new BootstrapLoopCache();
    const privateText = "private-resolved-text";
    await expect(
      cache.load("session-atlas", "marker-only", async () => privateText),
    ).resolves.toBe(privateText);
    expect(cache.size()).toBe(1);
    const entries = (cache as unknown as { entries: Map<string, { status: string; value?: string }> }).entries;
    const values = Array.from(entries.values());
    expect(values).toHaveLength(1);
    expect(values[0]).toEqual({ status: "completed" });
    expect(values[0]).not.toHaveProperty("value");
    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain(privateText);
    const stale: Array<Promise<string | null>> = [];
    stale.push(cache.load("session-atlas", "marker-only", async () => "another"));
    const resolved = await Promise.all(stale);
    for (const value of resolved) {
      expect(value).toBeNull();
    }
  });

  it("collapses concurrent loads above the in-flight budget to null without invoking the loader", async () => {
    const cache = new BootstrapLoopCache();
    let loaderCalls = 0;
    const pending: Array<() => void> = [];
    const load = (): Promise<string> =>
      new Promise<string>((resolve) => {
        loaderCalls += 1;
        pending.push(() => resolve("context"));
      });
    const inflight: Array<Promise<string | null>> = [];
    for (let i = 0; i < MAX_IN_FLIGHT_LOADS; i += 1) {
      inflight.push(cache.load("session-atlas", `prompt-${String(i)}`, load));
    }
    expect(loaderCalls).toBe(MAX_IN_FLIGHT_LOADS);
    expect(cache.size()).toBe(MAX_IN_FLIGHT_LOADS);
    const overflow = cache.load("session-atlas", "overflow", load);
    await expect(overflow).resolves.toBeNull();
    expect(loaderCalls).toBe(MAX_IN_FLIGHT_LOADS);
    expect(pending).toHaveLength(MAX_IN_FLIGHT_LOADS);
    for (const release of pending) release();
    for (const promise of inflight) {
      await expect(promise).resolves.toBe("context");
    }
    expect(cache.size()).toBe(MAX_IN_FLIGHT_LOADS);
  });

  it("evicts the oldest key once the cache reaches its capacity and the leader runs again", async () => {
    const cache = new BootstrapLoopCache();
    for (let i = 0; i < MAX_CACHE_KEYS; i += 1) {
      await expect(
        cache.load("session-atlas", `prompt-${String(i)}`, async () => `value-${String(i)}`),
      ).resolves.toBe(`value-${String(i)}`);
    }
    expect(cache.size()).toBe(MAX_CACHE_KEYS);
    await expect(
      cache.load("session-atlas", "newest-prompt", async () => "newest-value"),
    ).resolves.toBe("newest-value");
    expect(cache.size()).toBe(MAX_CACHE_KEYS);
    let reloaderCalls = 0;
    await expect(
      cache.load("session-atlas", "prompt-0", async () => {
        reloaderCalls += 1;
        return "fresh-value";
      }),
    ).resolves.toBe("fresh-value");
    expect(reloaderCalls).toBe(1);
  });

  it("normalizes hostile session and prompt inputs into bounded stable keys", async () => {
    const cache = new BootstrapLoopCache();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return "context";
    };
    const oversizedSession = "x".repeat(2048);
    await expect(cache.load(oversizedSession, "prompt", load)).resolves.toBeNull();
    expect(calls).toBe(0);
    await expect(cache.load(oversizedSession, "prompt", load)).resolves.toBeNull();
    // Non-string sessions fail closed without invoking the loader.
    await expect(
      cache.load({ toString: () => "session-atlas" }, "prompt", load),
    ).resolves.toBeNull();
    expect(calls).toBe(0);
    // Non-string prompts collapse to a single stable fingerprint so an
    // attacker cannot widen the cache key space with hostile payloads.
    const hostileA = { hostile: true, marker: "a" };
    const hostileB = { hostile: true, marker: "b" };
    let hostileCalls = 0;
    const hostileLoad = async () => {
      hostileCalls += 1;
      return "context";
    };
    await expect(cache.load("session-atlas", hostileA, hostileLoad)).resolves.toBe("context");
    expect(hostileCalls).toBe(1);
    await expect(cache.load("session-atlas", hostileA, hostileLoad)).resolves.toBeNull();
    await expect(cache.load("session-atlas", hostileB, hostileLoad)).resolves.toBeNull();
    expect(hostileCalls).toBe(1);
  });

  it("treats clear as a complete reset including the in-flight counter", async () => {
    const cache = new BootstrapLoopCache();
    let loaderCalls = 0;
    const pending: Array<() => void> = [];
    const load = (): Promise<string> =>
      new Promise<string>((resolve) => {
        loaderCalls += 1;
        pending.push(() => resolve("context"));
      });
    for (let i = 0; i < MAX_IN_FLIGHT_LOADS; i += 1) {
      cache.load("session-atlas", `prompt-${String(i)}`, load);
    }
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(loaderCalls).toBe(MAX_IN_FLIGHT_LOADS);
    let postClearCalls = 0;
    const postLoad = (): Promise<string> =>
      new Promise<string>((resolve) => {
        postClearCalls += 1;
        pending.push(() => resolve("context"));
      });
    for (let i = 0; i < MAX_IN_FLIGHT_LOADS + 1; i += 1) {
      cache.load("session-atlas", `next-${String(i)}`, postLoad);
    }
    expect(postClearCalls).toBe(MAX_IN_FLIGHT_LOADS);
    for (const release of pending) release();
  });
});