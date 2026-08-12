import { describe, expect, expectTypeOf, it } from "vitest";
import {
  parseCheckpoint,
  parseReceipt,
  SchemaValidationError,
} from "../../src/schemas.js";
import type {
  ApplyCheckpoint,
  CheckpointRequest,
  NoopCheckpoint,
  Receipt,
} from "../../src/types.js";

/** Build a fresh, schema-valid apply payload with neutral fixture values. */
function validApply(): Record<string, unknown> {
  return {
    version: 1,
    kind: "apply",
    source: {
      agent: "prime-agent",
      host_id: "workstation",
      session_id: "sess-01ab",
      cwd: "/home/tester/atlas",
    },
    project: { id: "atlas" },
    knowledge: {
      completed_tasks: ["Parsed the atlas manifest"],
      decisions: ["Keep the parser strict"],
      status_changes: [],
      blockers: [],
      reusable_learnings: [],
      next_steps: [],
    },
    evidence: {
      commits: ["a1b2c3d4"],
      tests: ["manifest.parser.test.ts"],
      files: ["src/parser.ts"],
      deployments: [],
      observations: [],
    },
    targets: { daily: true, project: true, landscape: false },
  };
}

/** Build a fresh, schema-valid noop payload. */
function validNoop(reason: string): Record<string, unknown> {
  return { version: 1, kind: "noop", reason };
}

describe("parseCheckpoint", () => {
  it("accepts a valid apply checkpoint", () => {
    const parsed = parseCheckpoint(validApply());
    expect(parsed.kind).toBe("apply");
    if (parsed.kind === "apply") {
      expect(parsed.version).toBe(1);
      expect(parsed.source.host_id).toBe("workstation");
      expect(parsed.source.session_id).toBe("sess-01ab");
      expect(parsed.source.cwd).toBe("/home/tester/atlas");
      expect(parsed.project.id).toBe("atlas");
      expect(parsed.knowledge.completed_tasks).toEqual(["Parsed the atlas manifest"]);
      expect(parsed.evidence.commits).toEqual(["a1b2c3d4"]);
      expect(parsed.targets).toEqual({ daily: true, project: true, landscape: false });
    }
  });

  it("accepts a valid noop checkpoint for every documented reason", () => {
    const reasons = [
      "trivial",
      "lookup_only",
      "no_new_knowledge",
      "unverified",
      "already_recorded",
    ];
    for (const reason of reasons) {
      const parsed = parseCheckpoint(validNoop(reason));
      expect(parsed.kind).toBe("noop");
      if (parsed.kind === "noop") {
        expect(parsed.reason).toBe(reason);
      }
    }
  });

  it("returns the exact checkpoint union type", () => {
    const applyParsed = parseCheckpoint(validApply());
    expectTypeOf(applyParsed).toEqualTypeOf<CheckpointRequest>();
    if (applyParsed.kind === "apply") {
      expectTypeOf(applyParsed).toEqualTypeOf<ApplyCheckpoint>();
      expect(applyParsed.targets.daily).toBe(true);
    }
    const noopParsed = parseCheckpoint(validNoop("trivial"));
    if (noopParsed.kind === "noop") {
      expectTypeOf(noopParsed).toEqualTypeOf<NoopCheckpoint>();
      expect(noopParsed.reason).toBe("trivial");
    }
  });

  it("accepts payloads that arrive through JSON serialization", () => {
    const wirePayload = JSON.parse(JSON.stringify(validApply())) as unknown;
    const parsed = parseCheckpoint(wirePayload);
    expect(parsed.kind).toBe("apply");
  });

  it("rejects every invalid kind discriminator", () => {
    const invalidKinds: unknown[] = [
      "",
      "APPLY",
      "Apply",
      "apply ",
      "checkpoint",
      "noopx",
      "apply\n",
      1,
      null,
      true,
      {},
      [],
    ];
    for (const kind of invalidKinds) {
      const payload = validApply();
      payload.kind = kind;
      expect(() => parseCheckpoint(payload), `kind=${String(kind)}`).toThrow(
        SchemaValidationError,
      );
    }
  });

  it("rejects a noop checkpoint carrying apply-only fields", () => {
    const payload = validNoop("trivial");
    payload.source = { agent: "prime-agent", host_id: "workstation", session_id: "s-1", cwd: "/home/tester" };
    expect(() => parseCheckpoint(payload)).toThrow(SchemaValidationError);
  });

  it("rejects invalid noop reasons", () => {
    const invalidReasons: unknown[] = [
      "",
      "TRIVIAL",
      "trivial ",
      "maybe",
      "later",
      "noop",
      1,
      null,
      true,
      {},
    ];
    for (const reason of invalidReasons) {
      const payload = validNoop("trivial");
      payload.reason = reason;
      expect(() => parseCheckpoint(payload), `reason=${String(reason)}`).toThrow(
        SchemaValidationError,
      );
    }
    const missingReason = validNoop("trivial");
    delete missingReason.reason;
    expect(() => parseCheckpoint(missingReason)).toThrow(SchemaValidationError);
  });

  it("rejects unsupported protocol versions", () => {
    for (const version of [0, 2, "1", null, true, {}]) {
      const payload = validApply();
      payload.version = version;
      expect(() => parseCheckpoint(payload), `version=${String(version)}`).toThrow(
        SchemaValidationError,
      );
      const noopPayload = validNoop("trivial");
      noopPayload.version = version;
      expect(() => parseCheckpoint(noopPayload), `noop version=${String(version)}`).toThrow(
        SchemaValidationError,
      );
    }
    const missingVersion = validApply();
    delete missingVersion.version;
    expect(() => parseCheckpoint(missingVersion)).toThrow(SchemaValidationError);
  });

  it("rejects unknown keys at every public object boundary", () => {
    const cases: Array<[string, (payload: Record<string, unknown>) => void]> = [
      ["top level", (p) => { p.extra = "x"; }],
      ["source", (p) => {
        const source = p.source as Record<string, unknown>;
        source.extra = "x";
      }],
      ["project", (p) => {
        const project = p.project as Record<string, unknown>;
        project.extra = "x";
      }],
      ["knowledge", (p) => {
        const knowledge = p.knowledge as Record<string, unknown>;
        knowledge.extra = "x";
      }],
      ["evidence", (p) => {
        const evidence = p.evidence as Record<string, unknown>;
        evidence.extra = "x";
      }],
      ["targets", (p) => {
        const targets = p.targets as Record<string, unknown>;
        targets.extra = "x";
      }],
      ["noop top level", (p) => { p.extra = "x"; }],
    ];
    for (const [label, mutate] of cases) {
      const payload = label === "noop top level" ? validNoop("trivial") : validApply();
      mutate(payload);
      expect(() => parseCheckpoint(payload), label).toThrow(SchemaValidationError);
    }
  });

  it("rejects apply payloads with absent required sections", () => {
    const requiredKeys = ["source", "project", "knowledge", "evidence", "targets"];
    for (const key of requiredKeys) {
      const payload = validApply();
      delete payload[key];
      expect(() => parseCheckpoint(payload), `missing ${key}`).toThrow(
        SchemaValidationError,
      );
    }
  });

  it("rejects non-string entries in knowledge and evidence arrays", () => {
    const cases: Array<[string, unknown]> = [
      ["completed_tasks with a number", [1]],
      ["decisions with a mixed entry", ["ok", 42]],
      ["blockers with null", [null]],
      ["next_steps with an object", [{}]],
      ["commits with an object", [{ sha: "abc" }]],
      ["tests with null", [null]],
      ["files with a boolean", [true]],
      ["observations with an array", [[]]],
    ];
    for (const [label, entries] of cases) {
      const payload = validApply();
      const section = label.startsWith("completed") || label.startsWith("decisions") || label.startsWith("blockers") || label.startsWith("next_steps")
        ? (payload.knowledge as Record<string, unknown>)
        : (payload.evidence as Record<string, unknown>);
      const key = label.split(" ")[0] as string;
      section[key] = entries;
      expect(() => parseCheckpoint(payload), label).toThrow(SchemaValidationError);
    }
  });

  it("rejects wrong section shapes", () => {
    const cases: Array<[string, () => void]> = [
      ["knowledge as null", () => {
        const p = validApply();
        p.knowledge = null;
        parseCheckpoint(p);
      }],
      ["evidence as a string", () => {
        const p = validApply();
        p.evidence = "evidence";
        parseCheckpoint(p);
      }],
      ["targets with a string flag", () => {
        const p = validApply();
        const t = p.targets as Record<string, unknown>;
        t.daily = "yes";
        parseCheckpoint(p);
      }],
      ["targets missing landscape", () => {
        const p = validApply();
        const t = p.targets as Record<string, unknown>;
        delete t.landscape;
        parseCheckpoint(p);
      }],
      ["source with unknown agent", () => {
        const p = validApply();
        const s = p.source as Record<string, unknown>;
        s.agent = "hermes";
        parseCheckpoint(p);
      }],
      ["project without an id", () => {
        const p = validApply();
        p.project = {};
        parseCheckpoint(p);
      }],
    ];
    for (const [label, run] of cases) {
      expect(run, label).toThrow(SchemaValidationError);
    }
  });

  it("rejects path-like and malformed identifiers", () => {
    const cases: Array<[string, unknown]> = [
      ["host_id containing a slash", "/etc/passwd"],
      ["session_id with traversal", "../etc"],
      ["session_id with a space", "sess id"],
      ["session_id with a null byte", "sess\u0000id"],
      ["project id of dots", ".."],
      ["host_id empty", ""],
      ["session_id too long", "x".repeat(129)],
    ];
    for (const [label, id] of cases) {
      const payload = validApply();
      const source = payload.source as Record<string, unknown>;
      source.host_id = id;
      source.session_id = id;
      const project = payload.project as Record<string, unknown>;
      project.id = id;
      expect(() => parseCheckpoint(payload), label).toThrow(SchemaValidationError);
    }
  });

  it("rejects relative and malformed cwd values", () => {
    for (const cwd of ["work", ".", "~", "C:\\work", "/home/tester\u0000x", ""]) {
      const payload = validApply();
      const source = payload.source as Record<string, unknown>;
      source.cwd = cwd;
      expect(() => parseCheckpoint(payload), `cwd=${cwd}`).toThrow(
        SchemaValidationError,
      );
    }
  });

  it("rejects prototype-pollution-shaped input", () => {
    const shaped: Array<[string, string]> = [
      ["own __proto__ key at the top level", '{"__proto__":{"polluted":true},"version":1,"kind":"apply","source":{"agent":"prime-agent","host_id":"workstation","session_id":"s-1","cwd":"/home/tester"},"project":{"id":"atlas"},"knowledge":{"completed_tasks":[],"decisions":[],"status_changes":[],"blockers":[],"reusable_learnings":[],"next_steps":[]},"evidence":{"commits":[],"tests":[],"files":[],"deployments":[],"observations":[]},"targets":{"daily":true,"project":true,"landscape":false}}'],
      ["constructor key inside source", '{"version":1,"kind":"apply","source":{"agent":"prime-agent","host_id":"workstation","session_id":"s-1","cwd":"/home/tester","constructor":{"prototype":{"polluted":true}}},"project":{"id":"atlas"},"knowledge":{"completed_tasks":[],"decisions":[],"status_changes":[],"blockers":[],"reusable_learnings":[],"next_steps":[]},"evidence":{"commits":[],"tests":[],"files":[],"deployments":[],"observations":[]},"targets":{"daily":true,"project":true,"landscape":false}}'],
      ["prototype key inside knowledge", '{"version":1,"kind":"apply","source":{"agent":"prime-agent","host_id":"workstation","session_id":"s-1","cwd":"/home/tester"},"project":{"id":"atlas"},"knowledge":{"completed_tasks":[],"decisions":[],"status_changes":[],"blockers":[],"reusable_learnings":[],"next_steps":[],"prototype":{"polluted":true}},"evidence":{"commits":[],"tests":[],"files":[],"deployments":[],"observations":[]},"targets":{"daily":true,"project":true,"landscape":false}}'],
      ["nested __proto__ key inside targets", '{"version":1,"kind":"apply","source":{"agent":"prime-agent","host_id":"workstation","session_id":"s-1","cwd":"/home/tester"},"project":{"id":"atlas"},"knowledge":{"completed_tasks":[],"decisions":[],"status_changes":[],"blockers":[],"reusable_learnings":[],"next_steps":[]},"evidence":{"commits":[],"tests":[],"files":[],"deployments":[],"observations":[]},"targets":{"daily":true,"project":true,"landscape":false,"__proto__":{"polluted":true}}}'],
    ];
    for (const [label, jsonText] of shaped) {
      const payload = JSON.parse(jsonText) as unknown;
      expect(() => parseCheckpoint(payload), label).toThrow(SchemaValidationError);
    }
  });

  it("rejects non-object inputs", () => {
    for (const value of [undefined, null, 42, "apply", true, [], "noop"]) {
      expect(() => parseCheckpoint(value), `value=${String(value)}`).toThrow(
        SchemaValidationError,
      );
    }
  });

  it("throws a fixed redacted error that never echoes payload values", () => {
    const payload = validApply();
    const source = payload.source as Record<string, unknown>;
    source.secret = "sup3r-s3cret-payload-value";
    let caught: unknown;
    try {
      parseCheckpoint(payload);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const message = (caught as SchemaValidationError).message;
    expect(message).toBe(
      "invalid checkpoint: rejected by versioned schema; details redacted",
    );
    expect(message).not.toContain("sup3r-s3cret-payload-value");
    expect(message).not.toContain("workstation");
    expect(message).not.toContain("atlas");
    expect(JSON.stringify(caught)).not.toContain("sup3r-s3cret-payload-value");
  });
});

describe("parseReceipt", () => {
  const sha256 = (char: string) => char.repeat(64);

  function validAppliedReceipt(): Record<string, unknown> {
    return {
      version: 1,
      outcome: "applied",
      event_id: "evt-0001",
      paths: ["Notas Diarias/2026-08-11.md"],
      before_hashes: { "Notas Diarias/2026-08-11.md": sha256("a") },
      after_hashes: { "Notas Diarias/2026-08-11.md": sha256("b") },
      created_at: "2026-08-11T09:30:00.000Z",
    };
  }

  function validDeferredReceipt(): Record<string, unknown> {
    return {
      version: 1,
      outcome: "deferred_conflict",
      event_id: "evt-0002",
      proposal_path: "Inbox/proposal-evt-0002.md",
      conflict_paths: ["Notas Diarias/2026-08-11.md"],
      created_at: "2026-08-11T09:31:00.000Z",
    };
  }

  it("accepts an applied receipt", () => {
    const parsed = parseReceipt(validAppliedReceipt());
    expect(parsed.outcome).toBe("applied");
    if (parsed.outcome === "applied") {
      expect(parsed.event_id).toBe("evt-0001");
      expect(parsed.paths).toEqual(["Notas Diarias/2026-08-11.md"]);
      expect(parsed.before_hashes["Notas Diarias/2026-08-11.md"]).toBe(sha256("a"));
      expect(parsed.after_hashes["Notas Diarias/2026-08-11.md"]).toBe(sha256("b"));
    }
  });

  it("accepts a deferred-conflict receipt", () => {
    const parsed = parseReceipt(validDeferredReceipt());
    expect(parsed.outcome).toBe("deferred_conflict");
    if (parsed.outcome === "deferred_conflict") {
      expect(parsed.proposal_path).toBe("Inbox/proposal-evt-0002.md");
      expect(parsed.conflict_paths).toEqual(["Notas Diarias/2026-08-11.md"]);
    }
  });

  it("returns the exact receipt union type", () => {
    expectTypeOf(parseReceipt(validAppliedReceipt())).toEqualTypeOf<Receipt>();
  });

  it("rejects receipts with unknown keys, bad hashes, and unsafe paths", () => {
    const withExtraKey = validAppliedReceipt();
    withExtraKey.extra = 1;
    expect(() => parseReceipt(withExtraKey)).toThrow(SchemaValidationError);

    const withBadHash = validAppliedReceipt();
    const hashes = withBadHash.before_hashes as Record<string, unknown>;
    hashes["Notas Diarias/2026-08-11.md"] = "zz";
    expect(() => parseReceipt(withBadHash)).toThrow(SchemaValidationError);

    const withTraversal = validAppliedReceipt();
    withTraversal.paths = ["a/../b.md"];
    expect(() => parseReceipt(withTraversal)).toThrow(SchemaValidationError);

    const withAbsolutePath = validAppliedReceipt();
    withAbsolutePath.paths = ["/etc/passwd"];
    expect(() => parseReceipt(withAbsolutePath)).toThrow(SchemaValidationError);

    const withBadEventId = validAppliedReceipt();
    withBadEventId.event_id = "evt/0001";
    expect(() => parseReceipt(withBadEventId)).toThrow(SchemaValidationError);

    const withBadTimestamp = validAppliedReceipt();
    withBadTimestamp.created_at = "yesterday";
    expect(() => parseReceipt(withBadTimestamp)).toThrow(SchemaValidationError);

    const missingHashes = validAppliedReceipt();
    delete missingHashes.before_hashes;
    expect(() => parseReceipt(missingHashes)).toThrow(SchemaValidationError);

    const unknownOutcome = validAppliedReceipt();
    unknownOutcome.outcome = "failed";
    expect(() => parseReceipt(unknownOutcome)).toThrow(SchemaValidationError);
  });
});
