import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EVIDENCE_CITATION_ERROR_MESSAGE,
  parseBootstrapResult,
  parseCheckpoint,
  parseJournalEvent,
  parseProjectResolution,
  parseReceipt,
  parseSearchHit,
  SchemaValidationError,
} from "../../src/schemas.js";
import type {
  ApplyCheckpoint,
  BootstrapResult,
  CheckpointRequest,
  JournalEvent,
  NoopCheckpoint,
  ProjectResolution,
  Receipt,
  SearchHit,
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
      completed_tasks: [{ text: "Parsed the atlas manifest", evidence: ["c1"] }],
      decisions: [{ text: "Keep the parser strict", evidence: [] }],
      status_changes: [],
      blockers: [],
      reusable_learnings: [],
      next_steps: [],
    },
    evidence: {
      commits: [{ id: "c1", value: "a1b2c3d4" }],
      tests: [{ id: "t1", value: "manifest.parser.test.ts" }],
      files: [{ id: "f1", value: "src/parser.ts" }],
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

const sha256 = (char: string) => char.repeat(64);

function validAppliedReceipt(): Record<string, unknown> {
  return {
    version: 1,
    outcome: "applied",
    event_id: "evt-0001",
    idempotency_key: "idem-0001",
    targets: [
      {
        path: "Notas Diarias/2026-08-11.md",
        before_hash: null,
        after_hash: sha256("a"),
      },
      {
        path: "Proyectos/Atlas.md",
        before_hash: sha256("b"),
        after_hash: sha256("c"),
      },
    ],
    created_at: "2026-08-11T09:30:00.000Z",
  };
}

function validNoopReceipt(): Record<string, unknown> {
  return {
    version: 1,
    outcome: "noop",
    event_id: "evt-0002",
    idempotency_key: "idem-0002",
    created_at: "2026-08-11T09:31:00.000Z",
  };
}

function validDeferredReceipt(): Record<string, unknown> {
  return {
    version: 1,
    outcome: "deferred_conflict",
    event_id: "evt-0003",
    idempotency_key: "idem-0003",
    proposal_path: "Inbox/proposal-evt-0003.md",
    conflict_paths: ["Notas Diarias/2026-08-11.md"],
    created_at: "2026-08-11T09:32:00.000Z",
  };
}

function validFailedReceipt(reason = "precondition_mismatch"): Record<string, unknown> {
  return {
    version: 1,
    outcome: "failed",
    event_id: "evt-0004",
    idempotency_key: "idem-0004",
    reason,
    created_at: "2026-08-11T09:33:00.000Z",
  };
}

function validRolledBackReceipt(): Record<string, unknown> {
  return {
    version: 1,
    outcome: "rolled_back",
    event_id: "evt-0005",
    idempotency_key: "idem-0005",
    target_event_id: "evt-0001",
    created_at: "2026-08-11T09:34:00.000Z",
  };
}

function validJournal(kind: string): Record<string, unknown> {
  const base = {
    version: 1,
    kind,
    event_id: "evt-0101",
    idempotency_key: "idem-0101",
    created_at: "2026-08-11T09:35:00.000Z",
  };
  switch (kind) {
    case "apply":
      return { ...base, checkpoint: validApply() };
    case "noop":
      return { ...base, checkpoint: validNoop("trivial") };
    case "deferred":
      return { ...base, checkpoint: validApply(), reason: "conflict" };
    case "recover":
      return { ...base, recovered_event_ids: ["evt-0001", "evt-0003"] };
    case "rollback":
      return { ...base, target_event_id: "evt-0001" };
    default:
      return base;
  }
}

function validResolvedResolution(basis = "portable_id"): Record<string, unknown> {
  return {
    kind: "resolved",
    project_id: "atlas",
    basis,
    note_path: "Proyectos/Atlas.md",
  };
}

function validUnresolvedResolution(reason = "no_match"): Record<string, unknown> {
  return { kind: "unresolved", reason };
}

function validAmbiguousResolution(): Record<string, unknown> {
  return {
    kind: "ambiguous",
    candidates: ["Proyectos/Atlas.md", "Proyectos/Atlas 2.md"],
  };
}

function validBootstrap(): Record<string, unknown> {
  return {
    version: 1,
    context: "bridge context",
    truncated: false,
    estimated_tokens: 120,
    budget_tokens: 4000,
    fragments: [
      {
        section: "identity",
        source_path: "CLAUDE.md",
        heading: "Identity",
        modified_at: "2026-08-10T08:00:00.000Z",
        char_count: 240,
        truncated: false,
      },
    ],
    project: validResolvedResolution(),
  };
}

function validSearchHit(): Record<string, unknown> {
  return {
    path: "Proyectos/Atlas.md",
    title: "Atlas",
    heading: "Status",
    modified_at: "2026-08-10T08:00:00.000Z",
    snippet: "…manifest parsed…",
    snippet_truncated: false,
    matched_on: ["filename", "content"],
    score: 0.42,
  };
}

/**
 * Insert an own `__proto__` key into the object whose opening brace follows
 * `objectPath` inside `rootJson`; returns the modified JSON text.
 */
function jsonWithOwnProtoKey(rootJson: string, objectPath: string): string {
  const marker = `${objectPath}{`;
  const insertion = `${objectPath}{"__proto__":{"polluted":true},`;
  return rootJson.replace(marker, insertion);
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
      expect(parsed.knowledge.completed_tasks).toEqual([
        { text: "Parsed the atlas manifest", evidence: ["c1"] },
      ]);
      expect(parsed.evidence.commits).toEqual([{ id: "c1", value: "a1b2c3d4" }]);
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
      "apply\n",
      "checkpoint",
      "noopx",
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
    payload.source = {
      agent: "prime-agent",
      host_id: "workstation",
      session_id: "s-1",
      cwd: "/home/tester",
    };
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
      ["knowledge item", (p) => {
        const knowledge = p.knowledge as Record<string, unknown>;
        const item = (knowledge.completed_tasks as Array<Record<string, unknown>>)[0]!;
        item.extra = "x";
      }],
      ["evidence", (p) => {
        const evidence = p.evidence as Record<string, unknown>;
        evidence.extra = "x";
      }],
      ["evidence item", (p) => {
        const evidence = p.evidence as Record<string, unknown>;
        const item = (evidence.commits as Array<Record<string, unknown>>)[0]!;
        item.extra = "x";
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

  it("rejects malformed knowledge and evidence items", () => {
    const cases: Array<[string, (p: Record<string, unknown>) => void]> = [
      ["completed_tasks with a plain string", (p) => {
        (p.knowledge as Record<string, unknown>).completed_tasks = ["Parsed the atlas manifest"];
      }],
      ["decisions with a number entry", (p) => {
        (p.knowledge as Record<string, unknown>).decisions = [1];
      }],
      ["blockers with null", (p) => {
        (p.knowledge as Record<string, unknown>).blockers = [null];
      }],
      ["next_steps with an object lacking text", (p) => {
        (p.knowledge as Record<string, unknown>).next_steps = [{ evidence: [] }];
      }],
      ["completed task with empty text", (p) => {
        const knowledge = p.knowledge as Record<string, unknown>;
        const item = (knowledge.completed_tasks as Array<Record<string, unknown>>)[0]!;
        item.text = "";
      }],
      ["completed task with object evidence entries", (p) => {
        const knowledge = p.knowledge as Record<string, unknown>;
        const item = (knowledge.completed_tasks as Array<Record<string, unknown>>)[0]!;
        item.evidence = [{ id: "c1" }];
      }],
      ["commits with an object lacking id", (p) => {
        (p.evidence as Record<string, unknown>).commits = [{ value: "a1b2c3d4" }];
      }],
      ["tests with null", (p) => {
        (p.evidence as Record<string, unknown>).tests = [null];
      }],
      ["files with a boolean", (p) => {
        (p.evidence as Record<string, unknown>).files = [true];
      }],
      ["observations with an array", (p) => {
        (p.evidence as Record<string, unknown>).observations = [[]];
      }],
      ["evidence id containing a slash", (p) => {
        const evidence = p.evidence as Record<string, unknown>;
        const item = (evidence.commits as Array<Record<string, unknown>>)[0]!;
        item.id = "c/1";
      }],
      ["evidence id empty", (p) => {
        const evidence = p.evidence as Record<string, unknown>;
        const item = (evidence.commits as Array<Record<string, unknown>>)[0]!;
        item.id = "";
      }],
      ["evidence value empty", (p) => {
        const evidence = p.evidence as Record<string, unknown>;
        const item = (evidence.commits as Array<Record<string, unknown>>)[0]!;
        item.value = "";
      }],
    ];
    for (const [label, mutate] of cases) {
      const payload = validApply();
      mutate(payload);
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

  it("accepts evidence citations that resolve across any collection", () => {
    const payload = validApply();
    const knowledge = payload.knowledge as Record<string, unknown>;
    knowledge.completed_tasks = [
      { text: "Parsed the atlas manifest", evidence: ["c1"] },
      { text: "Verified the parser", evidence: ["t1", "f1"] },
    ];
    const parsed = parseCheckpoint(payload);
    expect(parsed.kind).toBe("apply");
  });

  it("rejects evidence citations that reference unknown ids", () => {
    const payload = validApply();
    const knowledge = payload.knowledge as Record<string, unknown>;
    knowledge.completed_tasks = [
      { text: "Parsed the atlas manifest", evidence: ["ghost-id"] },
    ];
    let caught: unknown;
    try {
      parseCheckpoint(payload);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const message = (caught as SchemaValidationError).message;
    expect(message).toBe(
      `invalid checkpoint: ${EVIDENCE_CITATION_ERROR_MESSAGE}`,
    );
    expect(message).not.toContain("ghost-id");
    expect(message).not.toContain("Parsed the atlas manifest");
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
    const base = JSON.stringify(validApply());
    const jsonShaped: Array<[string, string]> = [
      ["own __proto__ key at the top level", jsonWithOwnProtoKey(base, "")],
      ["own __proto__ key inside source", jsonWithOwnProtoKey(base, '"source":')],
      ["own __proto__ key inside targets", jsonWithOwnProtoKey(base, '"targets":')],
    ];
    for (const [label, jsonText] of jsonShaped) {
      const payload = JSON.parse(jsonText) as unknown;
      expect(() => parseCheckpoint(payload), label).toThrow(SchemaValidationError);
    }
    const objectShaped: Array<[string, (p: Record<string, unknown>) => void]> = [
      ["constructor key inside source", (p) => {
        (p.source as Record<string, unknown>)["constructor"] = {
          prototype: { polluted: true },
        };
      }],
      ["prototype key inside knowledge", (p) => {
        (p.knowledge as Record<string, unknown>)["prototype"] = { polluted: true };
      }],
      ["prototype key inside a knowledge item", (p) => {
        const item = (
          (p.knowledge as Record<string, unknown>).completed_tasks as Array<
            Record<string, unknown>
          >
        )[0]!;
        item["prototype"] = { polluted: true };
      }],
    ];
    for (const [label, mutate] of objectShaped) {
      const payload = validApply();
      mutate(payload);
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
  it("accepts an applied receipt with exact target records", () => {
    const parsed = parseReceipt(validAppliedReceipt());
    expect(parsed.outcome).toBe("applied");
    if (parsed.outcome === "applied") {
      expect(parsed.event_id).toBe("evt-0001");
      expect(parsed.idempotency_key).toBe("idem-0001");
      expect(parsed.targets).toEqual([
        { path: "Notas Diarias/2026-08-11.md", before_hash: null, after_hash: sha256("a") },
        { path: "Proyectos/Atlas.md", before_hash: sha256("b"), after_hash: sha256("c") },
      ]);
    }
  });

  it("accepts a noop receipt", () => {
    const parsed = parseReceipt(validNoopReceipt());
    expect(parsed.outcome).toBe("noop");
  });

  it("accepts a deferred-conflict receipt", () => {
    const parsed = parseReceipt(validDeferredReceipt());
    expect(parsed.outcome).toBe("deferred_conflict");
    if (parsed.outcome === "deferred_conflict") {
      expect(parsed.proposal_path).toBe("Inbox/proposal-evt-0003.md");
      expect(parsed.conflict_paths).toEqual(["Notas Diarias/2026-08-11.md"]);
    }
  });

  it("accepts a failed receipt for every failure reason", () => {
    for (const reason of ["lock_unavailable", "precondition_mismatch", "io_error", "invalid_state"]) {
      const parsed = parseReceipt(validFailedReceipt(reason));
      expect(parsed.outcome).toBe("failed");
      if (parsed.outcome === "failed") {
        expect(parsed.reason).toBe(reason);
      }
    }
  });

  it("accepts a rolled-back receipt with rollback linkage", () => {
    const parsed = parseReceipt(validRolledBackReceipt());
    expect(parsed.outcome).toBe("rolled_back");
    if (parsed.outcome === "rolled_back") {
      expect(parsed.target_event_id).toBe("evt-0001");
    }
  });

  it("returns the exact receipt union type", () => {
    expectTypeOf(parseReceipt(validAppliedReceipt())).toEqualTypeOf<Receipt>();
    expectTypeOf(parseReceipt(validNoopReceipt())).toEqualTypeOf<Receipt>();
    expectTypeOf(parseReceipt(validDeferredReceipt())).toEqualTypeOf<Receipt>();
    expectTypeOf(parseReceipt(validFailedReceipt())).toEqualTypeOf<Receipt>();
    expectTypeOf(parseReceipt(validRolledBackReceipt())).toEqualTypeOf<Receipt>();
  });

  it("rejects unknown keys at every receipt variant boundary", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["applied", validAppliedReceipt()],
      ["noop", validNoopReceipt()],
      ["deferred_conflict", validDeferredReceipt()],
      ["failed", validFailedReceipt()],
      ["rolled_back", validRolledBackReceipt()],
    ];
    for (const [label, payload] of cases) {
      payload.extra = 1;
      expect(() => parseReceipt(payload), label).toThrow(SchemaValidationError);
    }
  });

  it("rejects malformed receipts", () => {
    const withBadHash = validAppliedReceipt();
    const targets = withBadHash.targets as Array<Record<string, unknown>>;
    targets[0]!.after_hash = "zz";
    expect(() => parseReceipt(withBadHash)).toThrow(SchemaValidationError);

    const withNullAfterHash = validAppliedReceipt();
    const targets2 = withNullAfterHash.targets as Array<Record<string, unknown>>;
    targets2[0]!.after_hash = null;
    expect(() => parseReceipt(withNullAfterHash)).toThrow(SchemaValidationError);

    const withBadBeforeHash = validAppliedReceipt();
    const targets3 = withBadBeforeHash.targets as Array<Record<string, unknown>>;
    targets3[0]!.before_hash = "abc";
    expect(() => parseReceipt(withBadBeforeHash)).toThrow(SchemaValidationError);

    const withTraversal = validAppliedReceipt();
    const targets4 = withTraversal.targets as Array<Record<string, unknown>>;
    targets4[0]!.path = "a/../b.md";
    expect(() => parseReceipt(withTraversal)).toThrow(SchemaValidationError);

    const withAbsolutePath = validAppliedReceipt();
    const targets5 = withAbsolutePath.targets as Array<Record<string, unknown>>;
    targets5[0]!.path = "/etc/passwd";
    expect(() => parseReceipt(withAbsolutePath)).toThrow(SchemaValidationError);

    const withEmptyTargets = validAppliedReceipt();
    withEmptyTargets.targets = [];
    expect(() => parseReceipt(withEmptyTargets)).toThrow(SchemaValidationError);

    const withBadEventId = validAppliedReceipt();
    withBadEventId.event_id = "evt/0001";
    expect(() => parseReceipt(withBadEventId)).toThrow(SchemaValidationError);

    const withBadIdempotencyKey = validAppliedReceipt();
    withBadIdempotencyKey.idempotency_key = "../idem";
    expect(() => parseReceipt(withBadIdempotencyKey)).toThrow(SchemaValidationError);

    const missingIdempotencyKey = validAppliedReceipt();
    delete missingIdempotencyKey.idempotency_key;
    expect(() => parseReceipt(missingIdempotencyKey)).toThrow(SchemaValidationError);

    const withBadTimestamp = validAppliedReceipt();
    withBadTimestamp.created_at = "yesterday";
    expect(() => parseReceipt(withBadTimestamp)).toThrow(SchemaValidationError);

    const unknownOutcome = validAppliedReceipt();
    unknownOutcome.outcome = "failedx";
    expect(() => parseReceipt(unknownOutcome)).toThrow(SchemaValidationError);

    const failedMissingReason = validFailedReceipt();
    delete failedMissingReason.reason;
    expect(() => parseReceipt(failedMissingReason)).toThrow(SchemaValidationError);

    const rolledBackMissingTarget = validRolledBackReceipt();
    delete rolledBackMissingTarget.target_event_id;
    expect(() => parseReceipt(rolledBackMissingTarget)).toThrow(SchemaValidationError);

    const deferredMissingProposal = validDeferredReceipt();
    delete deferredMissingProposal.proposal_path;
    expect(() => parseReceipt(deferredMissingProposal)).toThrow(SchemaValidationError);

    const deferredWithAbsoluteProposal = validDeferredReceipt();
    deferredWithAbsoluteProposal.proposal_path = "/tmp/escape.md";
    expect(() => parseReceipt(deferredWithAbsoluteProposal)).toThrow(SchemaValidationError);
  });
});

describe("parseJournalEvent", () => {
  it("accepts an apply journal event", () => {
    const parsed = parseJournalEvent(validJournal("apply"));
    expect(parsed.kind).toBe("apply");
    if (parsed.kind === "apply") {
      expect(parsed.checkpoint.kind).toBe("apply");
      expect(parsed.idempotency_key).toBe("idem-0101");
    }
  });

  it("accepts a noop journal event", () => {
    const parsed = parseJournalEvent(validJournal("noop"));
    expect(parsed.kind).toBe("noop");
    if (parsed.kind === "noop") {
      expect(parsed.checkpoint.kind).toBe("noop");
    }
  });

  it("accepts a deferred journal event", () => {
    const parsed = parseJournalEvent(validJournal("deferred"));
    expect(parsed.kind).toBe("deferred");
    if (parsed.kind === "deferred") {
      expect(parsed.checkpoint.kind).toBe("apply");
      expect(parsed.reason).toBe("conflict");
    }
  });

  it("accepts a recover journal event", () => {
    const parsed = parseJournalEvent(validJournal("recover"));
    expect(parsed.kind).toBe("recover");
    if (parsed.kind === "recover") {
      expect(parsed.recovered_event_ids).toEqual(["evt-0001", "evt-0003"]);
    }
  });

  it("accepts a rollback journal event", () => {
    const parsed = parseJournalEvent(validJournal("rollback"));
    expect(parsed.kind).toBe("rollback");
    if (parsed.kind === "rollback") {
      expect(parsed.target_event_id).toBe("evt-0001");
    }
  });

  it("returns the exact journal union type", () => {
    expectTypeOf(parseJournalEvent(validJournal("apply"))).toEqualTypeOf<JournalEvent>();
    expectTypeOf(parseJournalEvent(validJournal("noop"))).toEqualTypeOf<JournalEvent>();
    expectTypeOf(parseJournalEvent(validJournal("deferred"))).toEqualTypeOf<JournalEvent>();
    expectTypeOf(parseJournalEvent(validJournal("recover"))).toEqualTypeOf<JournalEvent>();
    expectTypeOf(parseJournalEvent(validJournal("rollback"))).toEqualTypeOf<JournalEvent>();
  });

  it("rejects unknown keys at every journal variant boundary", () => {
    for (const kind of ["apply", "noop", "deferred", "recover", "rollback"]) {
      const payload = validJournal(kind);
      payload.extra = 1;
      expect(() => parseJournalEvent(payload), kind).toThrow(SchemaValidationError);
    }
  });

  it("rejects malformed journal events", () => {
    const applyWithNoopCheckpoint = validJournal("apply");
    applyWithNoopCheckpoint.checkpoint = validNoop("trivial");
    expect(() => parseJournalEvent(applyWithNoopCheckpoint)).toThrow(SchemaValidationError);

    const noopWithApplyCheckpoint = validJournal("noop");
    noopWithApplyCheckpoint.checkpoint = validApply();
    expect(() => parseJournalEvent(noopWithApplyCheckpoint)).toThrow(SchemaValidationError);

    const deferredMissingReason = validJournal("deferred");
    delete deferredMissingReason.reason;
    expect(() => parseJournalEvent(deferredMissingReason)).toThrow(SchemaValidationError);

    const deferredWithNoopCheckpoint = validJournal("deferred");
    deferredWithNoopCheckpoint.checkpoint = validNoop("trivial");
    expect(() => parseJournalEvent(deferredWithNoopCheckpoint)).toThrow(SchemaValidationError);

    const recoverMissingIds = validJournal("recover");
    delete recoverMissingIds.recovered_event_ids;
    expect(() => parseJournalEvent(recoverMissingIds)).toThrow(SchemaValidationError);

    const recoverWithBadId = validJournal("recover");
    recoverWithBadId.recovered_event_ids = ["evt/0001"];
    expect(() => parseJournalEvent(recoverWithBadId)).toThrow(SchemaValidationError);

    const rollbackMissingTarget = validJournal("rollback");
    delete rollbackMissingTarget.target_event_id;
    expect(() => parseJournalEvent(rollbackMissingTarget)).toThrow(SchemaValidationError);

    const unknownKind = validJournal("apply");
    unknownKind.kind = "checkpoint";
    expect(() => parseJournalEvent(unknownKind)).toThrow(SchemaValidationError);

    const missingIdempotencyKey = validJournal("apply");
    delete missingIdempotencyKey.idempotency_key;
    expect(() => parseJournalEvent(missingIdempotencyKey)).toThrow(SchemaValidationError);
  });
});

describe("parseProjectResolution", () => {
  it("accepts every resolved basis", () => {
    for (const basis of ["remote", "portable_id", "alias", "local_override", "exact_name", "lexical"]) {
      const parsed = parseProjectResolution(validResolvedResolution(basis));
      expect(parsed.kind).toBe("resolved");
      if (parsed.kind === "resolved") {
        expect(parsed.basis).toBe(basis);
      }
    }
  });

  it("accepts a resolved resolution with a null note path", () => {
    const payload = validResolvedResolution();
    payload.note_path = null;
    const parsed = parseProjectResolution(payload);
    expect(parsed.kind).toBe("resolved");
  });

  it("accepts every unresolved reason", () => {
    for (const reason of ["no_git", "no_match", "unreadable"]) {
      const parsed = parseProjectResolution(validUnresolvedResolution(reason));
      expect(parsed.kind).toBe("unresolved");
      if (parsed.kind === "unresolved") {
        expect(parsed.reason).toBe(reason);
      }
    }
  });

  it("accepts an ambiguous resolution", () => {
    const parsed = parseProjectResolution(validAmbiguousResolution());
    expect(parsed.kind).toBe("ambiguous");
    if (parsed.kind === "ambiguous") {
      expect(parsed.candidates).toEqual(["Proyectos/Atlas.md", "Proyectos/Atlas 2.md"]);
    }
  });

  it("returns the exact resolution union type", () => {
    expectTypeOf(parseProjectResolution(validResolvedResolution())).toEqualTypeOf<ProjectResolution>();
    expectTypeOf(parseProjectResolution(validUnresolvedResolution())).toEqualTypeOf<ProjectResolution>();
    expectTypeOf(parseProjectResolution(validAmbiguousResolution())).toEqualTypeOf<ProjectResolution>();
  });

  it("rejects unknown keys at every resolution variant boundary", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["resolved", validResolvedResolution()],
      ["unresolved", validUnresolvedResolution()],
      ["ambiguous", validAmbiguousResolution()],
    ];
    for (const [label, payload] of cases) {
      payload.extra = 1;
      expect(() => parseProjectResolution(payload), label).toThrow(SchemaValidationError);
    }
  });

  it("rejects malformed resolutions", () => {
    const badBasis = validResolvedResolution("fuzzy");
    expect(() => parseProjectResolution(badBasis)).toThrow(SchemaValidationError);

    const badReason = validUnresolvedResolution("blocked");
    expect(() => parseProjectResolution(badReason)).toThrow(SchemaValidationError);

    const missingNotePath = validResolvedResolution();
    delete missingNotePath.note_path;
    expect(() => parseProjectResolution(missingNotePath)).toThrow(SchemaValidationError);

    const absoluteNotePath = validResolvedResolution();
    absoluteNotePath.note_path = "/home/tester/Atlas.md";
    expect(() => parseProjectResolution(absoluteNotePath)).toThrow(SchemaValidationError);

    const traversalCandidate = validAmbiguousResolution();
    traversalCandidate.candidates = ["Proyectos/../Atlas.md"];
    expect(() => parseProjectResolution(traversalCandidate)).toThrow(SchemaValidationError);

    const unknownKind = validResolvedResolution();
    unknownKind.kind = "found";
    expect(() => parseProjectResolution(unknownKind)).toThrow(SchemaValidationError);
  });
});

describe("parseBootstrapResult", () => {
  it("accepts a valid bootstrap result", () => {
    const parsed = parseBootstrapResult(validBootstrap());
    expect(parsed.version).toBe(1);
    expect(parsed.truncated).toBe(false);
    expect(parsed.estimated_tokens).toBe(120);
    expect(parsed.budget_tokens).toBe(4000);
    expect(parsed.fragments).toEqual([
      {
        section: "identity",
        source_path: "CLAUDE.md",
        heading: "Identity",
        modified_at: "2026-08-10T08:00:00.000Z",
        char_count: 240,
        truncated: false,
      },
    ]);
    if (parsed.project.kind === "resolved") {
      expect(parsed.project.project_id).toBe("atlas");
    }
  });

  it("returns the exact bootstrap result type", () => {
    expectTypeOf(parseBootstrapResult(validBootstrap())).toEqualTypeOf<BootstrapResult>();
  });

  it("rejects unknown keys at the bootstrap and fragment boundaries", () => {
    const payload = validBootstrap();
    payload.extra = 1;
    expect(() => parseBootstrapResult(payload)).toThrow(SchemaValidationError);

    const withFragmentExtra = validBootstrap();
    const fragments = withFragmentExtra.fragments as Array<Record<string, unknown>>;
    fragments[0]!.extra = 1;
    expect(() => parseBootstrapResult(withFragmentExtra)).toThrow(SchemaValidationError);
  });

  it("rejects malformed bootstrap results", () => {
    const absoluteSource = validBootstrap();
    const fragments = absoluteSource.fragments as Array<Record<string, unknown>>;
    fragments[0]!.source_path = "/home/tester/CLAUDE.md";
    expect(() => parseBootstrapResult(absoluteSource)).toThrow(SchemaValidationError);

    const badHeading = validBootstrap();
    const fragments2 = badHeading.fragments as Array<Record<string, unknown>>;
    fragments2[0]!.heading = 42;
    expect(() => parseBootstrapResult(badHeading)).toThrow(SchemaValidationError);

    const negativeChars = validBootstrap();
    const fragments3 = negativeChars.fragments as Array<Record<string, unknown>>;
    fragments3[0]!.char_count = -1;
    expect(() => parseBootstrapResult(negativeChars)).toThrow(SchemaValidationError);

    const badModifiedAt = validBootstrap();
    const fragments4 = badModifiedAt.fragments as Array<Record<string, unknown>>;
    fragments4[0]!.modified_at = "not-a-date";
    expect(() => parseBootstrapResult(badModifiedAt)).toThrow(SchemaValidationError);

    const nonBooleanTruncation = validBootstrap();
    const fragments5 = nonBooleanTruncation.fragments as Array<Record<string, unknown>>;
    fragments5[0]!.truncated = "yes";
    expect(() => parseBootstrapResult(nonBooleanTruncation)).toThrow(SchemaValidationError);

    const invalidProject = validBootstrap();
    invalidProject.project = { kind: "found", project_id: "atlas" };
    expect(() => parseBootstrapResult(invalidProject)).toThrow(SchemaValidationError);

    const missingFragments = validBootstrap();
    delete missingFragments.fragments;
    expect(() => parseBootstrapResult(missingFragments)).toThrow(SchemaValidationError);
  });
});

describe("parseSearchHit", () => {
  it("accepts a valid search hit", () => {
    const parsed = parseSearchHit(validSearchHit());
    expect(parsed.path).toBe("Proyectos/Atlas.md");
    expect(parsed.heading).toBe("Status");
    expect(parsed.matched_on).toEqual(["filename", "content"]);
    expect(parsed.snippet_truncated).toBe(false);
    expect(parsed.score).toBe(0.42);
  });

  it("accepts a search hit without a heading", () => {
    const payload = validSearchHit();
    payload.heading = null;
    const parsed = parseSearchHit(payload);
    expect(parsed.heading).toBeNull();
  });

  it("returns the exact search hit type", () => {
    expectTypeOf(parseSearchHit(validSearchHit())).toEqualTypeOf<SearchHit>();
  });

  it("rejects unknown keys on a search hit", () => {
    const payload = validSearchHit();
    payload.extra = 1;
    expect(() => parseSearchHit(payload)).toThrow(SchemaValidationError);
  });

  it("rejects malformed search hits", () => {
    const badMatchField = validSearchHit();
    badMatchField.matched_on = ["body"];
    expect(() => parseSearchHit(badMatchField)).toThrow(SchemaValidationError);

    const negativeScore = validSearchHit();
    negativeScore.score = -0.5;
    expect(() => parseSearchHit(negativeScore)).toThrow(SchemaValidationError);

    const nonBooleanTruncation = validSearchHit();
    nonBooleanTruncation.snippet_truncated = "yes";
    expect(() => parseSearchHit(nonBooleanTruncation)).toThrow(SchemaValidationError);

    const absolutePath = validSearchHit();
    absolutePath.path = "/home/tester/Atlas.md";
    expect(() => parseSearchHit(absolutePath)).toThrow(SchemaValidationError);

    const missingModifiedAt = validSearchHit();
    delete missingModifiedAt.modified_at;
    expect(() => parseSearchHit(missingModifiedAt)).toThrow(SchemaValidationError);

    const backslashPath = validSearchHit();
    backslashPath.path = "Proyectos\\Atlas.md";
    expect(() => parseSearchHit(backslashPath)).toThrow(SchemaValidationError);
  });
});
