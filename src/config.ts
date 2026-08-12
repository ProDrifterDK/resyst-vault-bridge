/**
 * Portable + machine-local configuration boundary.
 *
 * Two files describe a vault:
 *
 * - `<vault>/.resyst/agent-vault.yaml` — the portable contract (layout,
 *   templates, managed headings, context budget, conventions). It must never
 *   contain machine-specific values: path fields are vault-relative only, and
 *   absolute home paths, secrets, and executable hooks are rejected.
 * - `${XDG_CONFIG_HOME:-~/.config}/resyst-vault/config.json` — the
 *   machine-local contract (host id, absolute vault path, exact local project
 *   overrides). It is the only authority for machine-specific keys.
 *
 * Merge precedence is by ownership: portable keys come only from the portable
 * file, machine-local keys only from the local file, and each file rejects the
 * other's keys as unknown. `loadConfig` validates the vault itself: the vault
 * path must exist and be a directory, and every required layout directory
 * (`daily_dir`, `projects_dir`, `inbox_dir`, `templates_dir`) must exist as a
 * directory and resolve (realpath) inside the vault root; contained symlink
 * directories are allowed, escaping ones fail with `layout_escape`.
 * Adjudicated contract: `attachments_dir` is optional-to-exist. The plan names
 * `_adjuntos` for fixtures and read exclusion but never mandates its
 * existence, so attachment-free vaults remain valid. It is a soft exclusion
 * boundary for read/path checks, not a required operational directory: it is
 * never required to exist and is never containment-checked here. File contents and YAML/JSON
 * parse results are treated as `unknown` and narrowed through versioned
 * schemas; only `ENOENT` represents absence (any other read failure is a hard
 * error). Error messages are fixed and never echo payload values.
 */
import { homedir } from "node:os";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Type, type StaticDecode, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";
import { HostIdSchema, ProjectIdSchema, VAULT_PATH_PATTERN } from "./schemas.js";
import type { HostId, ProjectId } from "./types.js";

/** Default context budget in estimated tokens when the portable config omits it. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 5000;

/** Default managed daily headings when the portable config omits them. */
export const DEFAULT_MANAGED_HEADINGS = {
  tareas: "## Tareas",
  reflexion: "## Reflexión",
  notas: "## Notas",
  enlaces: "## Enlaces del día",
} as const;

/** Default frontmatter field carrying portable project metadata. */
export const DEFAULT_PROJECT_FRONTMATTER_FIELD = "resyst_project";

/** Maximum bytes accepted for either configuration file. */
export const MAX_CONFIG_BYTES = 256 * 1024;

/** Maximum visited nodes accepted while classifying a config tree. */
export const MAX_CONFIG_NODES = 10_000;

/** Maximum nesting depth accepted while classifying a config tree. */
export const MAX_CONFIG_DEPTH = 128;

/** Maximum YAML alias references accepted during portable config parsing. */
export const MAX_YAML_ALIASES = 100;

/** Stable error codes produced by the configuration boundary. */
export type ConfigErrorCode =
  | "local_config_missing"
  | "local_config_unreadable"
  | "local_config_invalid"
  | "portable_config_missing"
  | "portable_config_unreadable"
  | "portable_config_invalid"
  | "vault_missing"
  | "vault_not_directory"
  | "vault_unreadable"
  | "layout_missing"
  | "layout_not_directory"
  | "layout_unreadable"
  | "layout_escape"
  | "secret_shaped_key"
  | "executable_hook";

/** Fixed, redacted messages keyed by {@link ConfigErrorCode}. */
const CONFIG_ERROR_MESSAGES: Record<ConfigErrorCode, string> = {
  local_config_missing: "local configuration is absent",
  local_config_unreadable: "local configuration is unreadable",
  local_config_invalid: "local configuration is invalid; details redacted",
  portable_config_missing: "portable vault configuration is absent",
  portable_config_unreadable: "portable vault configuration is unreadable",
  portable_config_invalid: "portable vault configuration is invalid; details redacted",
  vault_missing: "configured vault does not exist",
  vault_not_directory: "configured vault path is not a directory",
  vault_unreadable: "configured vault is unreadable",
  layout_missing: "a required vault layout directory is absent",
  layout_not_directory: "a required vault layout path is not a directory",
  layout_unreadable: "a required vault layout directory is unreadable",
  layout_escape: "a required vault layout directory escapes the vault",
  secret_shaped_key: "configuration contains a secret-shaped key; rejected",
  executable_hook: "configuration contains an executable hook; rejected",
};

/** Fixed, redacted error for a configuration failure; never echoes values. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;

  constructor(code: ConfigErrorCode) {
    super(CONFIG_ERROR_MESSAGES[code]);
    this.name = "ConfigError";
    this.code = code;
  }
}

/** Minimal filesystem seam so tests never touch the real home or vault. */
export interface ConfigFs {
  readFile(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  realpath(filePath: string): Promise<string>;
}

/** Node `fs/promises` adapter for {@link ConfigFs}. */
export const nodeConfigFs: ConfigFs = {
  readFile: (filePath) => readFile(filePath, "utf8"),
  stat,
  realpath,
};

/** Injection points for deterministic tests. */
export interface LoadConfigDeps {
  /** Override of `$XDG_CONFIG_HOME`; when unset, `~/.config` from `home`. */
  xdgConfigHome?: string;
  /** Override of the home directory for `~/.config` resolution. */
  home?: string;
  /** Override of the filesystem seam. */
  fs?: ConfigFs;
}

/** One exact machine-local path -> portable project id override. */
export interface LocalProjectOverride {
  path: string;
  project_id: ProjectId;
}

/** Portable vault contract parsed from `<vault>/.resyst/agent-vault.yaml`. */
export interface PortableConfig {
  version: 1;
  layout: {
    daily_dir: string;
    projects_dir: string;
    inbox_dir: string;
    templates_dir: string;
    /**
     * Attachment directory, adjudicated optional-to-exist: never required to
     * exist (attachment-free vaults stay valid) and never containment-checked.
     * Unlike the required operational directories it is a soft exclusion
     * boundary for automatic reads.
     */
    attachments_dir: string;
  };
  templates: {
    /** Vault-relative template note, or null to fall back to a built-in. */
    daily: string | null;
  };
  managed_headings: {
    tareas: string;
    reflexion: string;
    notas: string;
    enlaces: string;
  };
  budget: {
    context_tokens: number;
  };
  conventions: {
    project_frontmatter_field: string;
  };
}

/** Machine-local contract parsed from `resyst-vault/config.json`. */
export interface LocalConfig {
  version: 1;
  host_id: HostId;
  vault_path: string;
  project_overrides: LocalProjectOverride[];
}

/** Fully validated, merged configuration returned by {@link loadConfig}. */
export interface BridgeConfig {
  version: 1;
  host_id: HostId;
  /** Absolute vault path exactly as configured locally. */
  vault_path: string;
  /** Symlink-resolved vault path; the containment root for path checks. */
  vault_real_path: string;
  layout: PortableConfig["layout"];
  templates: PortableConfig["templates"];
  managed_headings: PortableConfig["managed_headings"];
  budget: PortableConfig["budget"];
  conventions: PortableConfig["conventions"];
  project_overrides: LocalProjectOverride[];
}

/**
 * Portable relative path: no leading slash or backslash, no `~` home
 * reference, no dot/dotdot segments, no doubled or trailing slashes, no
 * control characters. `VAULT_PATH_PATTERN` already rejects leading slashes,
 * backslashes, dot segments, doubled/trailing slashes and control chars; the
 * `~` rejection is added here because portable config must stay machine
 * independent.
 */
const PORTABLE_RELATIVE_PATH_PATTERN = String.raw`^(?!.*~)${VAULT_PATH_PATTERN.slice(1, -1)}$`;

const PortableRelativePathSchema = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: PORTABLE_RELATIVE_PATH_PATTERN,
});

/** Portable template paths must additionally be Markdown notes. */
const PortableMarkdownPathSchema = Type.String({
  minLength: 5,
  maxLength: 1024,
  pattern: String.raw`^(?=.*\.md$)${PORTABLE_RELATIVE_PATH_PATTERN.slice(1, -1)}$`,
});

/** Absolute POSIX path without NUL, backslash, or trailing slash. */
const AbsolutePathSchema = Type.String({
  minLength: 2,
  maxLength: 4096,
  pattern: "^(?!.*/$)/[^\\\\\\u0000]*$",
});

const LayoutSchema = Type.Object(
  {
    daily_dir: PortableRelativePathSchema,
    projects_dir: PortableRelativePathSchema,
    inbox_dir: PortableRelativePathSchema,
    templates_dir: PortableRelativePathSchema,
    attachments_dir: Type.Optional(PortableRelativePathSchema),
  },
  { additionalProperties: false },
);

const TemplatesSchema = Type.Object(
  {
    daily: Type.Optional(PortableMarkdownPathSchema),
  },
  { additionalProperties: false },
);

const ManagedHeadingsSchema = Type.Object(
  {
    tareas: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    reflexion: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    notas: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    enlaces: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const BudgetSchema = Type.Object(
  {
    context_tokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    ),
  },
  { additionalProperties: false },
);

const ConventionsSchema = Type.Object(
  {
    project_frontmatter_field: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }),
    ),
  },
  { additionalProperties: false },
);

const PortableConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    layout: LayoutSchema,
    templates: Type.Optional(TemplatesSchema),
    managed_headings: Type.Optional(ManagedHeadingsSchema),
    budget: Type.Optional(BudgetSchema),
    conventions: Type.Optional(ConventionsSchema),
  },
  { additionalProperties: false },
);

const LocalProjectOverrideSchema = Type.Object(
  {
    path: AbsolutePathSchema,
    project_id: ProjectIdSchema,
  },
  { additionalProperties: false },
);

const LocalConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    host_id: HostIdSchema,
    vault_path: AbsolutePathSchema,
    project_overrides: Type.Optional(Type.Array(LocalProjectOverrideSchema)),
  },
  { additionalProperties: false },
);

type PortableConfigShape = StaticDecode<typeof PortableConfigSchema>;
type LocalConfigShape = StaticDecode<typeof LocalConfigSchema>;

/**
 * Key names that would carry credentials or authorization material. Matching
 * is case-insensitive over lowercased keys at any depth.
 */
const SECRET_KEY_PATTERN =
  /^(password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth|credential|credentials|bearer|cookie|session[_-]?key)$/i;

/** Key names that would carry executable behavior. */
const HOOK_KEY_PATTERN =
  /^(hook|hooks|script|scripts|command|commands|exec|executable|shell|run|callback|plugin|plugins)$/i;

/**
 * Classification of a config tree scan. `secret`/`hook` preserve the precise
 * rejection for normal bounded trees; `cycle`, `too_complex`, and `hostile`
 * are boundary failures that must surface as the source-appropriate fixed
 * redacted invalid error rather than a raw exception or a harmless pass.
 */
type ConfigScanResult =
  | "secret"
  | "hook"
  | "cycle"
  | "too_complex"
  | "hostile"
  | null;

/**
 * Cycle-safe, bounded, hostile-safe scan of an `unknown` config tree.
 *
 * - Cycles (YAML anchor self-references or hand-built cyclic objects) are
 *   detected with an ancestor `WeakSet` and reported as `cycle` instead of
 *   overflowing the stack.
 * - Total visited nodes and nesting depth are bounded so adversarial YAML or
 *   JSON cannot consume unbounded resources; exceeding the budget reports
 *   `too_complex`.
 * - Throwing getters, `Object.keys`, or proxy traps report `hostile`.
 *
 * The function never throws; the caller maps every result to the correct
 * redacted {@link ConfigError}.
 */
function scanConfig(value: unknown): ConfigScanResult {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): ConfigScanResult => {
    if (nodes >= MAX_CONFIG_NODES || depth > MAX_CONFIG_DEPTH) {
      return "too_complex";
    }
    nodes += 1;
    if (Array.isArray(current)) {
      if (ancestors.has(current)) {
        return "cycle";
      }
      ancestors.add(current);
      for (const item of current) {
        const result = visit(item, depth + 1);
        if (result !== null) {
          return result;
        }
      }
      ancestors.delete(current);
      return null;
    }
    if (typeof current === "object" && current !== null) {
      if (ancestors.has(current)) {
        return "cycle";
      }
      ancestors.add(current);
      let keys: string[];
      try {
        keys = Object.keys(current);
      } catch {
        return "hostile";
      }
      for (const key of keys) {
        if (SECRET_KEY_PATTERN.test(key)) {
          return "secret";
        }
        if (HOOK_KEY_PATTERN.test(key)) {
          return "hook";
        }
        let child: unknown;
        try {
          child = (current as Record<string, unknown>)[key];
        } catch {
          return "hostile";
        }
        const result = visit(child, depth + 1);
        if (result !== null) {
          return result;
        }
      }
      ancestors.delete(current);
      return null;
    }
    return null;
  };
  return visit(value, 0);
}

/** Narrow a parsed portable value or throw a redacted ConfigError. */
export function parsePortableConfig(value: unknown): PortableConfig {
  try {
    const scan = scanConfig(value);
    if (scan === "secret") {
      throw new ConfigError("secret_shaped_key");
    }
    if (scan === "hook") {
      throw new ConfigError("executable_hook");
    }
    if (scan !== null) {
      // cycle, too_complex, or hostile: a boundary failure, not a pass.
      throw new ConfigError("portable_config_invalid");
    }
    const parsed = narrowConfig<PortableConfigShape>(
      value,
      PortableConfigSchema,
      "portable",
    );
    return {
      version: 1,
      layout: {
        daily_dir: parsed.layout.daily_dir,
        projects_dir: parsed.layout.projects_dir,
        inbox_dir: parsed.layout.inbox_dir,
        templates_dir: parsed.layout.templates_dir,
        attachments_dir: parsed.layout.attachments_dir ?? "_adjuntos",
      },
      templates: {
        daily: parsed.templates?.daily ?? null,
      },
      managed_headings: {
        tareas: parsed.managed_headings?.tareas ?? DEFAULT_MANAGED_HEADINGS.tareas,
        reflexion:
          parsed.managed_headings?.reflexion ?? DEFAULT_MANAGED_HEADINGS.reflexion,
        notas: parsed.managed_headings?.notas ?? DEFAULT_MANAGED_HEADINGS.notas,
        enlaces: parsed.managed_headings?.enlaces ?? DEFAULT_MANAGED_HEADINGS.enlaces,
      },
      budget: {
        context_tokens:
          parsed.budget?.context_tokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      },
      conventions: {
        project_frontmatter_field:
          parsed.conventions?.project_frontmatter_field ??
          DEFAULT_PROJECT_FRONTMATTER_FIELD,
      },
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    // Hostile values (throwing getters/proxy traps) or unexpected boundary
    // failures always surface as the fixed redacted invalid error.
    throw new ConfigError("portable_config_invalid");
  }
}

/** Narrow a parsed local value or throw a redacted ConfigError. */
export function parseLocalConfig(value: unknown): LocalConfig {
  try {
    const scan = scanConfig(value);
    if (scan === "secret") {
      throw new ConfigError("secret_shaped_key");
    }
    if (scan === "hook") {
      throw new ConfigError("executable_hook");
    }
    if (scan !== null) {
      // cycle, too_complex, or hostile: a boundary failure, not a pass.
      throw new ConfigError("local_config_invalid");
    }
    const parsed = narrowConfig<LocalConfigShape>(
      value,
      LocalConfigSchema,
      "local",
    );
    return {
      version: 1,
      host_id: parsed.host_id,
      vault_path: parsed.vault_path,
      project_overrides: parsed.project_overrides ?? [],
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    // Hostile values (throwing getters/proxy traps) or unexpected boundary
    // failures always surface as the fixed redacted invalid error.
    throw new ConfigError("local_config_invalid");
  }
}

/**
 * Shared narrowing helper: schema-check an `unknown` value and throw a
 * redacted {@link ConfigError} when it does not match. The static shape is
 * projected to the exact public type by the caller after the check.
 */
function narrowConfig<Shape>(
  value: unknown,
  schema: TSchema,
  source: "portable" | "local",
): Shape {
  if (!Value.Check(schema, value)) {
    throw new ConfigError(
      source === "portable" ? "portable_config_invalid" : "local_config_invalid",
    );
  }
  return value as Shape;
}

export async function loadConfig(deps: LoadConfigDeps = {}): Promise<BridgeConfig> {
  const fs = deps.fs ?? nodeConfigFs;
  const localConfigDir = path.join(
    deps.xdgConfigHome ?? path.join(deps.home ?? homedir(), ".config"),
    "resyst-vault",
  );
  const localConfigFile = path.join(localConfigDir, "config.json");

  const localRaw = await readOrAbsent(fs, localConfigFile, "local_config_missing", "local_config_unreadable");
  if (localRaw.length > MAX_CONFIG_BYTES) {
    throw new ConfigError("local_config_invalid");
  }
  let localValue: unknown;
  try {
    localValue = JSON.parse(localRaw) as unknown;
  } catch {
    throw new ConfigError("local_config_invalid");
  }
  const local = parseLocalConfig(localValue);

  const vaultStat = await statOrError(fs, local.vault_path, "vault_missing", "vault_unreadable");
  if (!vaultStat.isDirectory()) {
    throw new ConfigError("vault_not_directory");
  }
  let vaultReal: string;
  try {
    vaultReal = await fs.realpath(local.vault_path);
  } catch {
    throw new ConfigError("vault_unreadable");
  }

  const portableFile = path.join(local.vault_path, ".resyst", "agent-vault.yaml");
  const portableRaw = await readOrAbsent(fs, portableFile, "portable_config_missing", "portable_config_unreadable");
  if (portableRaw.length > MAX_CONFIG_BYTES) {
    throw new ConfigError("portable_config_invalid");
  }
  let portableValue: unknown;
  try {
    portableValue = parseYaml(portableRaw, {
      maxAliasCount: MAX_YAML_ALIASES,
    }) as unknown;
  } catch {
    throw new ConfigError("portable_config_invalid");
  }
  const portable = parsePortableConfig(portableValue);

  // Required layout directories fail early: existence + directory type first,
  // then realpath containment inside the resolved vault root. Contained
  // symlink directories are allowed; escaping ones are rejected. The optional
  // attachments directory is intentionally not in this set (see layout docs).
  const requiredLayoutDirs = [
    portable.layout.daily_dir,
    portable.layout.projects_dir,
    portable.layout.inbox_dir,
    portable.layout.templates_dir,
  ];
  for (const relative of requiredLayoutDirs) {
    const absolute = path.join(local.vault_path, ...relative.split("/"));
    const layoutStat = await statOrError(fs, absolute, "layout_missing", "layout_unreadable");
    if (!layoutStat.isDirectory()) {
      throw new ConfigError("layout_not_directory");
    }
    let layoutReal: string;
    try {
      layoutReal = await fs.realpath(absolute);
    } catch (error) {
      if (errorIsCode(error, "ENOENT")) {
        throw new ConfigError("layout_missing");
      }
      throw new ConfigError("layout_unreadable");
    }
    if (!isContainedWithin(layoutReal, vaultReal)) {
      throw new ConfigError("layout_escape");
    }
  }

  return {
    version: 1,
    host_id: local.host_id,
    vault_path: local.vault_path,
    vault_real_path: vaultReal,
    layout: portable.layout,
    templates: portable.templates,
    managed_headings: portable.managed_headings,
    budget: portable.budget,
    conventions: portable.conventions,
    project_overrides: local.project_overrides,
  };
}

/** Read a file, mapping only ENOENT to absence; every other failure is hard. */
async function readOrAbsent(
  fs: ConfigFs,
  filePath: string,
  absentCode: ConfigErrorCode,
  unreadableCode: ConfigErrorCode,
): Promise<string> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (errorIsCode(error, "ENOENT")) {
      throw new ConfigError(absentCode);
    }
    throw new ConfigError(unreadableCode);
  }
}

/** Stat a path, mapping only ENOENT to absence; every other failure is hard. */
async function statOrError(
  fs: ConfigFs,
  filePath: string,
  absentCode: ConfigErrorCode,
  unreadableCode: ConfigErrorCode,
): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (errorIsCode(error, "ENOENT")) {
      throw new ConfigError(absentCode);
    }
    throw new ConfigError(unreadableCode);
  }
}

/** Whether a resolved path stays inside the vault's real root. */
function isContainedWithin(realPath: string, vaultReal: string): boolean {
  return realPath === vaultReal || realPath.startsWith(`${vaultReal}/`);
}

/** Narrow a thrown `unknown` to its Node error code, if any. */
function errorIsCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
