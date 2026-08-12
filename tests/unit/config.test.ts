/**
 * Unit tests for the portable/local configuration boundary (`src/config.ts`).
 *
 * Every test builds a synthetic vault through `tests/fixtures/create-vault.ts`
 * inside a throwaway temp directory and injects the XDG/home/fs dependencies,
 * so the real vault and the real home are never touched.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ConfigError,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  loadConfig,
  nodeConfigFs,
  type BridgeConfig,
} from "../../src/config.js";
import type { HostId } from "../../src/types.js";
import {
  createVault,
  DEFAULT_LAYOUT,
  type CreatedVault,
} from "../fixtures/create-vault.js";

interface TestContext {
  root: string;
  home: string;
  xdg: string;
  vault: CreatedVault;
  localConfigFile: string;
}

/** Build a temp home/XDG plus a complete synthetic vault; cleans up after. */
async function withVault<T>(
  body: (ctx: TestContext) => Promise<T>,
  vaultOptions: Partial<Parameters<typeof createVault>[0]> = {},
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "resyst-config-test-"));
  try {
    const home = path.join(root, "home");
    const xdg = path.join(root, "xdg");
    await mkdir(path.join(xdg, "resyst-vault"), { recursive: true });
    const vault = await createVault({ vaultPath: path.join(root, "vault"), ...vaultOptions });
    return await body({
      root,
      home,
      xdg,
      vault,
      localConfigFile: path.join(xdg, "resyst-vault", "config.json"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Write the machine-local config JSON and return its path. */
async function writeLocalConfig(ctx: TestContext, value: unknown): Promise<string> {
  await writeFile(ctx.localConfigFile, JSON.stringify(value), "utf8");
  return ctx.localConfigFile;
}

function load(ctx: TestContext): Promise<BridgeConfig> {
  return loadConfig({ xdgConfigHome: ctx.xdg, home: ctx.home, fs: nodeConfigFs });
}

function validLocalConfig(): Record<string, unknown> {
  return {
    version: 1,
    host_id: "workstation",
    vault_path: "/placeholder/vault",
  };
}

describe("loadConfig: portable/local merge", () => {
  it("merges portable layout/templates/headings/budget/conventions with local host/vault/overrides", async () => {
    await withVault(async (ctx) => {
      const vaultPath = ctx.vault.vaultPath;
      await writeLocalConfig(ctx, {
        version: 1,
        host_id: "casey-laptop",
        vault_path: vaultPath,
        project_overrides: [
          { path: "/home/tester/atlas", project_id: "atlas" },
        ],
      });
      const cfg = await load(ctx);
      expect(cfg.version).toBe(1);
      expect(cfg.host_id).toBe("casey-laptop");
      expect(cfg.vault_path).toBe(vaultPath);
      expect(cfg.layout).toEqual({
        daily_dir: "Notas Diarias",
        projects_dir: "Proyectos",
        inbox_dir: "Inbox",
        templates_dir: "_plantillas",
        attachments_dir: "_adjuntos",
      });
      expect(cfg.templates).toEqual({ daily: "_plantillas/Daily Note.md" });
      expect(cfg.managed_headings).toEqual({
        tareas: "## Tareas",
        reflexion: "## Reflexión",
        notas: "## Notas",
        enlaces: "## Enlaces del día",
      });
      expect(cfg.conventions).toEqual({
        project_frontmatter_field: "resyst_project",
      });
      expect(cfg.project_overrides).toEqual([
        { path: "/home/tester/atlas", project_id: "atlas" },
      ]);
      expect(cfg.vault_real_path).toBe(await realpath(vaultPath));
    });
  });

  it("keeps local config authoritative for machine-specific keys: portable host/vault keys are rejected", async () => {
    await withVault(async (ctx) => {
      const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
host_id: "portable-host"
vault_path: "/home/tester/elsewhere"
`;
      await ctx.vault.writePortableConfig(portable);
      await writeLocalConfig(ctx, { version: 1, host_id: "local-host", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("portable_config_invalid");
      expect((caught as ConfigError).message).not.toContain("elsewhere");
      expect((caught as ConfigError).message).not.toContain("portable-host");
    });
  });

  it("keeps portable config authoritative for portable keys: local layout/budget keys are rejected", async () => {
    await withVault(async (ctx) => {
      const local = validLocalConfig();
      local.vault_path = ctx.vault.vaultPath;
      local.layout = { daily_dir: "Other" };
      local.budget = { context_tokens: 1000 };
      await writeLocalConfig(ctx, local);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("local_config_invalid");
    });
  });

  it("returns the exact BridgeConfig type", async () => {
    await withVault(async (ctx) => {
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      const cfg = await load(ctx);
      expectTypeOf(cfg).toEqualTypeOf<BridgeConfig>();
      expectTypeOf(cfg.host_id).toEqualTypeOf<HostId>();
    });
  });
});

describe("loadConfig: default context budget", () => {
  it("applies the documented default when the portable config omits a budget", async () => {
    await withVault(async (ctx) => {
      const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
`;
      await ctx.vault.writePortableConfig(portable);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      const cfg = await load(ctx);
      expect(cfg.budget.context_tokens).toBe(DEFAULT_CONTEXT_BUDGET_TOKENS);
      expect(cfg.budget.context_tokens).toBe(5000);
    });
  });

  it("honors a portable budget override", async () => {
    await withVault(async (ctx) => {
      const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
budget:
  context_tokens: 6000
`;
      await ctx.vault.writePortableConfig(portable);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      const cfg = await load(ctx);
      expect(cfg.budget.context_tokens).toBe(6000);
    });
  });

  it("rejects non-integer, zero, and negative budgets", async () => {
    for (const bad of [0, -1, 1.5, "5000", true, null]) {
      await withVault(async (ctx) => {
        const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
budget:
  context_tokens: ${JSON.stringify(bad)}
`;
        await ctx.vault.writePortableConfig(portable);
        await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `budget=${String(bad)}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("portable_config_invalid");
      });
    }
  });
});

describe("loadConfig: malformed config", () => {
  it("rejects malformed JSON in the local config with a redacted error", async () => {
    await withVault(async (ctx) => {
      await writeFile(ctx.localConfigFile, "{ not json !!!", "utf8");
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const err = caught as ConfigError;
      expect(err.code).toBe("local_config_invalid");
      expect(err.message).not.toContain("json");
      expect(err.message).not.toContain("{");
    });
  });

  it("rejects malformed YAML in the portable config with a redacted error", async () => {
    await withVault(async (ctx) => {
      await ctx.vault.writePortableConfig("version: [unclosed\n  layout: {");
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("portable_config_invalid");
    });
  });

  it("rejects duplicate YAML keys in the portable config", async () => {
    await withVault(async (ctx) => {
      const portable = `version: 1
version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
`;
      await ctx.vault.writePortableConfig(portable);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("portable_config_invalid");
    });
  });

  it("treats an absent local config as missing, not as an empty config", async () => {
    await withVault(async (ctx) => {
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("local_config_missing");
    });
  });

  it("treats an absent portable config as missing, not as a valid empty config", async () => {
    await withVault(async (ctx) => {
      await rm(ctx.vault.paths.portableConfig, { force: true });
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("portable_config_missing");
    });
  });

  it("distinguishes ENOENT from other read failures: a directory named config.json is not absence", async () => {
    await withVault(async (ctx) => {
      await rm(ctx.localConfigFile, { force: true });
      await mkdir(ctx.localConfigFile);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("local_config_unreadable");
    });
  });

  it("distinguishes ENOENT from other read failures: a directory named agent-vault.yaml is not absence", async () => {
    await withVault(async (ctx) => {
      await rm(ctx.vault.paths.portableConfig, { force: true });
      await mkdir(ctx.vault.paths.portableConfig);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("portable_config_unreadable");
    });
  });

  it("rejects non-object config roots", async () => {
    for (const value of [null, 42, "config", [], true]) {
      await withVault(async (ctx) => {
        await writeLocalConfig(ctx, value);
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `local=${String(value)}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("local_config_invalid");
      });
      await withVault(async (ctx) => {
        await ctx.vault.writePortableConfig(JSON.stringify(value));
        await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `portable=${String(value)}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("portable_config_invalid");
      });
    }
  });

  it("rejects unsupported portable versions", async () => {
    for (const version of [0, 2, "1", null, true]) {
      await withVault(async (ctx) => {
        const portable = `version: ${JSON.stringify(version)}
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
`;
        await ctx.vault.writePortableConfig(portable);
        await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `version=${String(version)}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("portable_config_invalid");
      });
    }
  });

  it("rejects unsupported local versions", async () => {
    for (const version of [0, 2, "1", null, true]) {
      await withVault(async (ctx) => {
        const local = validLocalConfig();
        local.version = version;
        local.vault_path = ctx.vault.vaultPath;
        await writeLocalConfig(ctx, local);
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `version=${String(version)}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("local_config_invalid");
      });
    }
  });
});

describe("loadConfig: host identifiers", () => {
  it("rejects invalid host ids", async () => {
    const invalidIds = [
      "",
      "with space",
      "with/slash",
      "with\\backslash",
      "..",
      "x".repeat(129),
      "con\u0000trol",
    ];
    for (const hostId of invalidIds) {
      await withVault(async (ctx) => {
        const local = validLocalConfig();
        local.host_id = hostId;
        local.vault_path = ctx.vault.vaultPath;
        await writeLocalConfig(ctx, local);
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `host_id=${JSON.stringify(hostId)}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("local_config_invalid");
      });
    }
  });

  it("rejects a missing host id", async () => {
    await withVault(async (ctx) => {
      const local = validLocalConfig();
      delete local.host_id;
      local.vault_path = ctx.vault.vaultPath;
      await writeLocalConfig(ctx, local);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("local_config_invalid");
    });
  });

  it("accepts a host id matching the documented pattern", async () => {
    await withVault(async (ctx) => {
      await writeLocalConfig(ctx, {
        version: 1,
        host_id: "casey-laptop.01",
        vault_path: ctx.vault.vaultPath,
      });
      const cfg = await load(ctx);
      expect(cfg.host_id).toBe("casey-laptop.01");
    });
  });
});

describe("loadConfig: vault and layout validation", () => {
  it("rejects a missing vault", async () => {
    await withVault(async (ctx) => {
      const local = validLocalConfig();
      local.vault_path = path.join(ctx.root, "no-such-vault");
      await writeLocalConfig(ctx, local);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("vault_missing");
    });
  });

  it("rejects a vault path that is a file", async () => {
    await withVault(async (ctx) => {
      const file = path.join(ctx.root, "not-a-vault");
      await writeFile(file, "not a directory", "utf8");
      const local = validLocalConfig();
      local.vault_path = file;
      await writeLocalConfig(ctx, local);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("vault_not_directory");
    });
  });

  it("rejects a relative vault path", async () => {
    await withVault(async (ctx) => {
      const local = validLocalConfig();
      local.vault_path = "relative/vault";
      await writeLocalConfig(ctx, local);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("local_config_invalid");
    });
  });

  it("rejects an absent required layout directory", async () => {
    await withVault(async (ctx) => {
      const { inboxDir } = ctx.vault.paths;
      await rm(inboxDir, { recursive: true, force: true });
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("layout_missing");
    });
  });

  it("rejects a required layout path that is a file", async () => {
    await withVault(async (ctx) => {
      const { projectsDir } = ctx.vault.paths;
      await rm(projectsDir, { recursive: true, force: true });
      await writeFile(projectsDir, "not a directory", "utf8");
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("layout_not_directory");
    });
  });

  it("accepts a vault whose optional attachments directory is absent", async () => {
    await withVault(async (ctx) => {
      const { attachmentsDir } = ctx.vault.paths;
      await rm(attachmentsDir, { recursive: true, force: true });
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      const cfg = await load(ctx);
      expect(cfg.layout.attachments_dir).toBe("_adjuntos");
    });
  });
});

describe("loadConfig: unknown keys", () => {
  it("rejects unknown keys at every portable boundary", async () => {
    const portableCases: Array<[string, string]> = [
      ["top level", `version: 1
extra: true
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
`],
      ["layout", `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
  extra: true
`],
      ["templates", `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
templates:
  daily: "_plantillas/Daily Note.md"
  extra: true
`],
      ["managed_headings", `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
managed_headings:
  tareas: "## Tareas"
  extra: true
`],
      ["budget", `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
budget:
  context_tokens: 5000
  extra: true
`],
      ["conventions", `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
conventions:
  project_frontmatter_field: resyst_project
  extra: true
`],
    ];
    for (const [label, yamlText] of portableCases) {
      await withVault(async (ctx) => {
        await ctx.vault.writePortableConfig(yamlText);
        await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, label).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("portable_config_invalid");
      });
    }
  });

  it("rejects unknown keys at every local boundary", async () => {
    const localCases: Array<[string, Record<string, unknown>]> = [
      ["top level", { ...validLocalConfig(), extra: true }],
      [
        "override item",
        {
          ...validLocalConfig(),
          project_overrides: [
            { path: "/home/tester/atlas", project_id: "atlas", extra: true },
          ],
        },
      ],
    ];
    for (const [label, local] of localCases) {
      await withVault(async (ctx) => {
        local.vault_path = ctx.vault.vaultPath;
        await writeLocalConfig(ctx, local);
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, label).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("local_config_invalid");
      });
    }
  });

  it("rejects prototype-pollution-shaped keys", async () => {
    await withVault(async (ctx) => {
      const local = JSON.parse(
        `{"version":1,"host_id":"workstation","vault_path":${JSON.stringify(ctx.vault.vaultPath)},"__proto__":{"polluted":true}}`,
      ) as Record<string, unknown>;
      await writeLocalConfig(ctx, local);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("local_config_invalid");
    });
    await withVault(async (ctx) => {
      const portable = `version: 1
__proto__:
  polluted: true
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
`;
      await ctx.vault.writePortableConfig(portable);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("portable_config_invalid");
    });
  });
});

describe("loadConfig: secret-shaped keys and executable hooks", () => {
  it("rejects secret-shaped keys in the portable config", async () => {
    const secretKeys = ["password", "token", "api_key", "authorization", "client_secret", "credentials"];
    for (const key of secretKeys) {
      await withVault(async (ctx) => {
        const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
  ${key}: "hunter2"
`;
        await ctx.vault.writePortableConfig(portable);
        await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `key=${key}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("secret_shaped_key");
        expect((caught as ConfigError).message).not.toContain("hunter2");
        expect((caught as ConfigError).message).not.toContain(key);
      });
    }
  });

  it("rejects secret-shaped keys in the local config", async () => {
    await withVault(async (ctx) => {
      const local = validLocalConfig();
      local.vault_path = ctx.vault.vaultPath;
      local["access_key"] = "AKIAEXAMPLE";
      await writeLocalConfig(ctx, local);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("secret_shaped_key");
      expect((caught as ConfigError).message).not.toContain("AKIAEXAMPLE");
    });
  });

  it("rejects executable hook keys in either config", async () => {
    const hookKeys = ["hook", "hooks", "script", "scripts", "command", "exec", "shell"];
    for (const key of hookKeys) {
      await withVault(async (ctx) => {
        const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
${key}: "curl evil.example"
`;
        await ctx.vault.writePortableConfig(portable);
        await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `key=${key}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("executable_hook");
      });
      await withVault(async (ctx) => {
        const local = validLocalConfig();
        local.vault_path = ctx.vault.vaultPath;
        local[key] = "rm -rf /";
        await writeLocalConfig(ctx, local);
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `local key=${key}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("executable_hook");
      });
    }
  });

  it("does not treat secret-shaped or hook-shaped values inside allowed keys as forbidden", async () => {
    await withVault(async (ctx) => {
      const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
managed_headings:
  tareas: "## Password"
  notas: "## Script"
budget:
  context_tokens: 5000
`;
      await ctx.vault.writePortableConfig(portable);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      const cfg = await load(ctx);
      expect(cfg.managed_headings.tareas).toBe("## Password");
      expect(cfg.managed_headings.notas).toBe("## Script");
    });
  });
});

describe("loadConfig: portable absolute home paths", () => {
  it("rejects absolute layout directories in portable config", async () => {
    await withVault(async (ctx) => {
      const portable = `version: 1
layout:
  daily_dir: "/home/tester/Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
`;
      await ctx.vault.writePortableConfig(portable);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("portable_config_invalid");
      expect((caught as ConfigError).message).not.toContain("/home/tester");
    });
  });

  it("rejects tilde home references in portable layout and template paths", async () => {
    const badPaths = ["~/Notas Diarias", "~/.config/vault", "~/plantillas/x.md"];
    for (const badPath of badPaths) {
      await withVault(async (ctx) => {
        const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
templates:
  daily: ${JSON.stringify(badPath)}
`;
        await ctx.vault.writePortableConfig(portable);
        await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `path=${badPath}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("portable_config_invalid");
      });
    }
  });

  it("rejects traversal in portable layout and template paths", async () => {
    const badPaths = ["../Notas Diarias", "Proyectos/../../x", "../plantillas/x.md"];
    for (const badPath of badPaths) {
      await withVault(async (ctx) => {
        const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: ${JSON.stringify(badPath)}
`;
        await ctx.vault.writePortableConfig(portable);
        await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `path=${badPath}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("portable_config_invalid");
      });
    }
  });

  it("rejects a non-Markdown daily template path", async () => {
    await withVault(async (ctx) => {
      const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
templates:
  daily: "_plantillas/Daily Note.txt"
`;
      await ctx.vault.writePortableConfig(portable);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("portable_config_invalid");
    });
  });

  it("accepts unicode and spaced relative layout names", async () => {
    await withVault(async (ctx) => {
      const layout = {
        dailyDir: "Notas Diarias",
        projectsDir: "Proyectos",
        inboxDir: "Inbox",
        templatesDir: "_plantillas",
        attachmentsDir: "_adjuntos",
      };
      expect(DEFAULT_LAYOUT).toEqual(layout);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      const cfg = await load(ctx);
      expect(cfg.layout.daily_dir).toBe("Notas Diarias");
    });
  });
});

describe("loadConfig: local project overrides", () => {
  it("rejects override paths that are not absolute POSIX paths", async () => {
    for (const badPath of ["relative/atlas", "~/atlas", "C:\\atlas", "", "/trailing/", "/home/tester\\x"]) {
      await withVault(async (ctx) => {
        const local = validLocalConfig();
        local.vault_path = ctx.vault.vaultPath;
        local.project_overrides = [{ path: badPath, project_id: "atlas" }];
        await writeLocalConfig(ctx, local);
        let caught: unknown;
        try {
          await load(ctx);
        } catch (error) {
          caught = error;
        }
        expect(caught, `path=${JSON.stringify(badPath)}`).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).code).toBe("local_config_invalid");
      });
    }
  });

  it("rejects override project ids that are invalid identifiers", async () => {
    await withVault(async (ctx) => {
      const local = validLocalConfig();
      local.vault_path = ctx.vault.vaultPath;
      local.project_overrides = [{ path: "/home/tester/atlas", project_id: "../atlas" }];
      await writeLocalConfig(ctx, local);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).code).toBe("local_config_invalid");
    });
  });
});

describe("loadConfig: error redaction", () => {
  it("never echoes local payload values in error messages", async () => {
    await withVault(async (ctx) => {
      const local = validLocalConfig();
      local.vault_path = ctx.vault.vaultPath;
      local.host_id = "sup3r-s3cret-hostname";
      local.extra_nested = { clue: "private-vault-name" };
      await writeLocalConfig(ctx, local);
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const message = (caught as ConfigError).message;
      expect(message).not.toContain("sup3r-s3cret-hostname");
      expect(message).not.toContain("private-vault-name");
      expect(JSON.stringify(caught)).not.toContain("private-vault-name");
    });
  });

  it("never echoes portable payload values in error messages", async () => {
    await withVault(async (ctx) => {
      const portable = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
secret_note: "private-vault-name"
`;
      await ctx.vault.writePortableConfig(portable);
      await writeLocalConfig(ctx, { version: 1, host_id: "workstation", vault_path: ctx.vault.vaultPath });
      let caught: unknown;
      try {
        await load(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const message = (caught as ConfigError).message;
      expect(message).not.toContain("private-vault-name");
      expect(JSON.stringify(caught)).not.toContain("private-vault-name");
    });
  });
});
