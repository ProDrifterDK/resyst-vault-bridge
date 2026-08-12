import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildWritePlans } from "../../src/render.js";
import { parseCheckpoint, parseProjectResolution } from "../../src/schemas.js";

function checkpoint() {
  const parsed = parseCheckpoint({
    version: 1,
    kind: "apply",
    source: {
      agent: "prime-agent",
      host_id: "workstation",
      session_id: "sess-01ab",
      cwd: "/workspace/atlas",
    },
    project: { id: "atlas" },
    knowledge: {
      completed_tasks: [{ text: "Shipped parser", evidence: ["c1"] }],
      decisions: [{ text: "Keep strict parsing", evidence: [] }],
      status_changes: [{ text: "Active", evidence: ["t1"] }],
      blockers: [{ text: "Waiting for review", evidence: [] }],
      reusable_learnings: [{ text: "Prefer exact headings", evidence: [] }],
      next_steps: [{ text: "Run canary", evidence: [] }],
    },
    evidence: {
      commits: [{ id: "c1", value: "abc123" }],
      tests: [{ id: "t1", value: "parser test passed" }],
      files: [], deployments: [], observations: [],
    },
    targets: { daily: true, project: true, landscape: false },
  });
  if (parsed.kind !== "apply") throw new Error("fixture must be apply");
  return parsed;
}

const config = {
  daily_dir: "Notas Diarias",
  managed_headings: {
    tareas: "## Tareas",
    reflexion: "## Reflexión",
    notas: "## Notas",
    enlaces: "## Enlaces del día",
  },
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    checkpoint: checkpoint(),
    effective_targets: { daily: true, project: false, landscape: false },
    resolution: parseProjectResolution({
      kind: "resolved",
      project_id: "atlas",
      basis: "portable_id",
      note_path: "Proyectos/Atlas.md",
    }),
    project_title: "Atlas",
    snapshots: { daily: null, project: null, moc: null, claude: null },
    template_source: [
      "# {{date}}", "", "## Tareas", "", "## Reflexión", "", "## Notas", "", "## Enlaces del día", "",
    ].join("\n"),
    config,
    date: "2026-08-12",
    ...overrides,
  };
}

describe("buildWritePlans", () => {
  it("creates a daily note with four distinct fragments sharing one session key", () => {
    const result = buildWritePlans(input());
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plans).toHaveLength(1);
    const plan = result.plans[0];
    expect(plan?.path).toBe("Notas Diarias/2026-08-12.md");
    expect(plan?.before_hash).toBeNull();
    expect(plan?.reason).toBe("daily_create");
    expect(plan?.after_hash).toBe(
      createHash("sha256").update(plan?.after_content ?? "", "utf8").digest("hex"),
    );
    expect(plan?.after_content).toContain("# 2026-08-12");
    expect(plan?.after_content).toContain("session=sess-01ab target=daily-tareas");
    expect(plan?.after_content).toContain("session=sess-01ab target=daily-reflexion");
    expect(plan?.after_content).toContain("session=sess-01ab target=daily-notas");
    expect(plan?.after_content).toContain("session=sess-01ab target=daily-enlaces");
    expect(plan?.after_content).toContain("- [x] Shipped parser");
    expect(plan?.after_content).toContain("evidencia: abc123");
    expect(plan?.after_content).toContain("[[Atlas]]");
  });

  it("updates one logical daily record without duplicates and becomes idempotent", () => {
    const created = buildWritePlans(input());
    if (created.kind !== "plan") throw new Error("expected initial plan");
    const firstContent = created.plans[0]?.after_content ?? "";
    const manual = `manual-prefix\n${firstContent}manual-suffix\n`;

    const changed = checkpoint();
    changed.knowledge.completed_tasks[0] = {
      text: "Shipped parser safely",
      evidence: changed.knowledge.completed_tasks[0]?.evidence ?? [],
    };
    const updated = buildWritePlans(input({
      checkpoint: changed,
      snapshots: { daily: manual, project: null, moc: null, claude: null },
    }));
    expect(updated.kind).toBe("plan");
    if (updated.kind === "plan") {
      const content = updated.plans[0]?.after_content ?? "";
      expect(content.startsWith("manual-prefix\n")).toBe(true);
      expect(content.endsWith("manual-suffix\n")).toBe(true);
      expect((content.match(/target=daily-tareas/g) ?? [])).toHaveLength(2);
      expect(content).toContain("Shipped parser safely");
    }

    const identical = buildWritePlans(input({
      snapshots: { daily: firstContent, project: null, moc: null, claude: null },
    }));
    expect(identical).toEqual({ kind: "nothing" });
  });

  it("updates all four daily fragments as one logical record and clears stale bodies", () => {
    const first = buildWritePlans(input());
    if (first.kind !== "plan") throw new Error("expected first daily plan");
    const prior = first.plans[0]?.after_content ?? "";
    const sparse = checkpoint();
    sparse.knowledge = {
      completed_tasks: [{
        text: "Only current task",
        evidence: sparse.knowledge.completed_tasks[0]?.evidence ?? [],
      }],
      decisions: [],
      status_changes: [],
      blockers: [],
      reusable_learnings: [],
      next_steps: [],
    };
    const second = buildWritePlans(input({
      checkpoint: sparse,
      snapshots: { daily: prior, project: null, moc: null, claude: null },
    }));
    expect(second.kind).toBe("plan");
    if (second.kind !== "plan") return;
    const content = second.plans[0]?.after_content ?? "";
    expect(content).toContain("Only current task");
    expect(content).not.toContain("Keep strict parsing");
    expect(content).not.toContain("Waiting for review");
    expect((content.match(/session=sess-01ab target=daily-/gu) ?? []).length).toBe(8);
  });

  it("keeps next steps in the daily-only ambiguity fallback", () => {
    const nextOnly = checkpoint();
    nextOnly.knowledge = {
      completed_tasks: [], decisions: [], status_changes: [], blockers: [], reusable_learnings: [],
      next_steps: [{ text: "Associate the project", evidence: [] }],
    };
    const result = buildWritePlans(input({
      checkpoint: nextOnly,
      resolution: { kind: "unresolved", basis: "none", candidates: [] },
      project_title: null,
    }));
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plans[0]?.after_content).toContain("- [ ] Associate the project");
  });

  it("plans one deterministic project block and preserves manual bytes", () => {
    const projectSource = "manual-prefix\n# Atlas\n\n## Estado actual\nmanual history\nmanual-suffix\n";
    const result = buildWritePlans(input({
      effective_targets: { daily: false, project: true, landscape: false },
      snapshots: { daily: null, project: projectSource, moc: null, claude: null },
    }));

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plans).toHaveLength(1);
    const plan = result.plans[0];
    expect(plan?.path).toBe("Proyectos/Atlas.md");
    expect(plan?.reason).toBe("project_update");
    expect(plan?.before_hash).toBe(
      createHash("sha256").update(projectSource, "utf8").digest("hex"),
    );
    expect(plan?.after_content.startsWith("manual-prefix\n")).toBe(true);
    expect(plan?.after_content).toContain("manual history");
    expect(plan?.after_content).toContain("manual-suffix");
    expect(plan?.after_content).toContain("target=project");
    expect(plan?.after_content).toContain("### Estado");
    expect(plan?.after_content).toContain("Active");
    expect(plan?.after_content).toContain("parser test passed");
    expect(plan?.after_content).toContain("### Decisiones");
    expect(plan?.after_content).toContain("### Bloqueos");
    expect(plan?.after_content).toContain("### Siguientes pasos");
  });

  it("returns nothing when project and landscape managed content is already identical", () => {
    const projectSource = "# Atlas\n## Estado actual\nmanual\n";
    const firstProject = buildWritePlans(input({
      effective_targets: { daily: false, project: true, landscape: false },
      snapshots: { daily: null, project: projectSource, moc: null, claude: null },
    }));
    if (firstProject.kind !== "plan") throw new Error("expected project plan");
    const projectContent = firstProject.plans[0]?.after_content ?? "";
    expect(buildWritePlans(input({
      effective_targets: { daily: false, project: true, landscape: false },
      snapshots: { daily: null, project: projectContent, moc: null, claude: null },
    }))).toEqual({ kind: "nothing" });

    const firstLandscape = buildWritePlans(input({
      effective_targets: { daily: false, project: false, landscape: true },
      snapshots: {
        daily: null,
        project: null,
        moc: "# Inicio\n## Proyectos\nmanual\n",
        claude: "# Context\n## Contexto activo\nmanual\n",
      },
    }));
    if (firstLandscape.kind !== "plan") throw new Error("expected landscape plan");
    expect(buildWritePlans(input({
      effective_targets: { daily: false, project: false, landscape: true },
      snapshots: {
        daily: null,
        project: null,
        moc: firstLandscape.plans[0]?.after_content ?? "",
        claude: firstLandscape.plans[1]?.after_content ?? "",
      },
    }))).toEqual({ kind: "nothing" });
  });

  it("defers project alias ambiguity instead of choosing one heading", () => {
    const result = buildWritePlans(input({
      effective_targets: { daily: false, project: true, landscape: false },
      snapshots: {
        daily: null,
        project: "# Atlas\n## Estado actual\none\n## Estado\ntwo\n",
        moc: null,
        claude: null,
      },
    }));
    expect(result).toEqual({
      kind: "deferred",
      reason: "conflict",
      conflict_paths: ["Proyectos/Atlas.md"],
    });
  });

  it("plans exactly targeted MOC and CLAUDE landscape sections", () => {
    const moc = "# Inicio\n\n## Proyectos\nmanual moc row\n";
    const claude = "# Context\n\n## Contexto activo\nmanual active context\n";
    const result = buildWritePlans(input({
      effective_targets: { daily: false, project: false, landscape: true },
      snapshots: { daily: null, project: null, moc, claude },
    }));

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plans.map((plan) => plan.reason)).toEqual([
      "landscape_moc",
      "landscape_claude",
    ]);
    expect(result.plans.map((plan) => String(plan.path))).toEqual([
      "MOC — Inicio.md",
      "CLAUDE.md",
    ]);
    for (const plan of result.plans) {
      expect(plan.after_content).toContain("target=landscape");
      expect(plan.after_content).toContain("[[Atlas]]");
      expect(plan.after_content).toContain("estado: Active");
      expect(plan.after_content).toContain("siguiente: Run canary");
    }
    expect(result.plans[0]?.after_content).toContain("manual moc row");
    expect(result.plans[1]?.after_content).toContain("manual active context");
  });

  it("escapes marker-like and invented wikilink text from model-authored facts", () => {
    const hostile = checkpoint();
    hostile.knowledge.decisions[0] = {
      text: "<!-- resyst-vault:begin --> [[Invented]] <iframe> [click](https://evil)",
      evidence: [],
    };
    const result = buildWritePlans(input({ checkpoint: hostile }));
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    const content = result.plans[0]?.after_content ?? "";
    expect(content).toContain("&lt;!-- resyst-vault:begin -->");
    expect(content).toContain("\\[\\[Invented\\]\\]");
    expect(content).toContain("&lt;iframe>");
    expect(content).toContain("\\[click\\](https://evil)");
    expect(content).not.toContain("<!-- resyst-vault:begin --> [[Invented]]");
    expect(buildWritePlans(input({ project_title: "Atlas|invented" }))).toEqual({
      kind: "deferred",
      reason: "conflict",
      conflict_paths: [],
    });
  });

  it("defers a daily template with missing or duplicate managed headings", () => {
    const missing = buildWritePlans(input({ template_source: "# {{date}}\n## Tareas\n" }));
    const duplicate = buildWritePlans(input({
      template_source: [
        "# {{date}}", "## Tareas", "## Tareas", "## Reflexión", "## Notas", "## Enlaces del día",
      ].join("\n"),
    }));
    expect(missing.kind).toBe("deferred");
    expect(duplicate.kind).toBe("deferred");
  });

  it("defers ambiguous landscape targets instead of returning a patch", () => {
    const result = buildWritePlans(input({
      effective_targets: { daily: false, project: false, landscape: true },
      snapshots: {
        daily: null,
        project: null,
        moc: "# Inicio\n## Proyectos\none\n## Proyectos\ntwo\n",
        claude: "# Context\n## Contexto activo\nvalid\n",
      },
    }));

    expect(result).toEqual({
      kind: "deferred",
      reason: "landscape_ambiguous",
      conflict_paths: ["MOC — Inicio.md"],
    });
  });
});
