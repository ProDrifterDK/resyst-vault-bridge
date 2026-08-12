/**
 * Synthetic vault fixture builder for unit tests.
 *
 * Builds a complete temporary Obsidian vault under a caller-supplied path
 * (always a test temp directory; the real vault is never read or written).
 * The fixture uses the neutral user Casey, the synthetic project Atlas, and
 * fixed content. Layout and content are parameterized so tests can create
 * deliberately broken or adversarial vaults.
 */
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Neutral default vault layout used by the fixture and generated config. */
export interface VaultLayoutSpec {
  dailyDir?: string;
  projectsDir?: string;
  inboxDir?: string;
  templatesDir?: string;
  attachmentsDir?: string;
}

export interface CreateVaultOptions {
  /** Absolute path of the new temporary vault (created by the fixture). */
  vaultPath: string;
  layout?: VaultLayoutSpec;
  /** Full `agent-vault.yaml` content; defaults to {@link portableYamlFor}. */
  portableYaml?: string;
  claudeMd?: string;
  mocContent?: string;
  dailyTemplate?: string;
  /** Create today's daily note under the daily directory when true. */
  withDailyNote?: boolean;
  dailyNoteDate?: string;
  /** Create a project note for Atlas under the projects directory. */
  withProjectNote?: boolean;
}

export const DEFAULT_LAYOUT: Required<VaultLayoutSpec> = {
  dailyDir: "Notas Diarias",
  projectsDir: "Proyectos",
  inboxDir: "Inbox",
  templatesDir: "_plantillas",
  attachmentsDir: "_adjuntos",
};

export const DEFAULT_CLAUDE_MD = `# Resyst Vault

## Identity
- Name: Casey

## Preferences
- Concise summaries

## Conventions
- Daily notes live in Notas Diarias
`;

export const DEFAULT_MOC = `# Inicio

## Proyectos
- [[Atlas]]

## Notas Diarias
- [[2026-08-11]]
`;

export const DEFAULT_DAILY_TEMPLATE = `# {{date}}

## Tareas

## Reflexión

## Notas

## Enlaces del día
`;

export const DEFAULT_PORTABLE_YAML = `version: 1
layout:
  daily_dir: "Notas Diarias"
  projects_dir: "Proyectos"
  inbox_dir: "Inbox"
  templates_dir: "_plantillas"
  attachments_dir: "_adjuntos"
templates:
  daily: "_plantillas/Daily Note.md"
managed_headings:
  tareas: "## Tareas"
  reflexion: "## Reflexión"
  notas: "## Notas"
  enlaces: "## Enlaces del día"
budget:
  context_tokens: 5000
conventions:
  project_frontmatter_field: resyst_project
`;

export interface CreatedVaultPaths {
  claudeMd: string;
  moc: string;
  dailyDir: string;
  projectsDir: string;
  inboxDir: string;
  templatesDir: string;
  attachmentsDir: string;
  resystDir: string;
  journalDir: string;
  receiptsDir: string;
  portableConfig: string;
  dailyTemplate: string;
}

export interface CreatedVault {
  vaultPath: string;
  layout: Required<VaultLayoutSpec>;
  paths: CreatedVaultPaths;
  /** Join a vault-relative POSIX path against the vault root. */
  absolute(relative: string): string;
  /** Vault-relative daily note path for an ISO date. */
  dailyNotePath(date: string): string;
  /** Absolute daily note path for an ISO date. */
  dailyNoteAbsolute(date: string): string;
  /** Write a note at a vault-relative path; returns its absolute path. */
  writeNote(relative: string, content: string): Promise<string>;
  /** Replace the portable configuration file content. */
  writePortableConfig(yamlText: string): Promise<void>;
  /** Create a symlink at a vault-relative path pointing at an absolute target. */
  createSymlink(relative: string, targetAbsolute: string): Promise<string>;
}

/** Double-quote a YAML scalar value, escaping quotes and backslashes. */
function yamlQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

/** Generate a valid portable `agent-vault.yaml` for the given layout. */
export function portableYamlFor(
  layout: Required<VaultLayoutSpec>,
  options: {
    dailyTemplate?: string;
    contextTokens?: number;
    projectFrontmatterField?: string;
  } = {},
): string {
  const template = options.dailyTemplate ?? "_plantillas/Daily Note.md";
  const budget = options.contextTokens ?? 5000;
  const field = options.projectFrontmatterField ?? "resyst_project";
  return [
    "version: 1",
    "layout:",
    `  daily_dir: ${yamlQuote(layout.dailyDir)}`,
    `  projects_dir: ${yamlQuote(layout.projectsDir)}`,
    `  inbox_dir: ${yamlQuote(layout.inboxDir)}`,
    `  templates_dir: ${yamlQuote(layout.templatesDir)}`,
    `  attachments_dir: ${yamlQuote(layout.attachmentsDir)}`,
    "templates:",
    `  daily: ${yamlQuote(template)}`,
    "managed_headings:",
    `  tareas: ${yamlQuote("## Tareas")}`,
    `  reflexion: ${yamlQuote("## Reflexión")}`,
    `  notas: ${yamlQuote("## Notas")}`,
    `  enlaces: ${yamlQuote("## Enlaces del día")}`,
    "budget:",
    `  context_tokens: ${budget}`,
    "conventions:",
    `  project_frontmatter_field: ${yamlQuote(field)}`,
    "",
  ].join("\n");
}

/** Build a complete synthetic temporary vault; never touches a real vault. */
export async function createVault(
  options: CreateVaultOptions,
): Promise<CreatedVault> {
  const layout: Required<VaultLayoutSpec> = {
    ...DEFAULT_LAYOUT,
    ...options.layout,
  };
  const vaultPath = options.vaultPath;
  const dailyDir = path.join(vaultPath, layout.dailyDir);
  const projectsDir = path.join(vaultPath, layout.projectsDir);
  const inboxDir = path.join(vaultPath, layout.inboxDir);
  const templatesDir = path.join(vaultPath, layout.templatesDir);
  const attachmentsDir = path.join(vaultPath, layout.attachmentsDir);
  const resystDir = path.join(vaultPath, ".resyst");
  const journalDir = path.join(resystDir, "journal");
  const receiptsDir = path.join(resystDir, "receipts");
  const portableConfig = path.join(resystDir, "agent-vault.yaml");
  const dailyTemplate = path.join(templatesDir, "Daily Note.md");
  const claudeMd = path.join(vaultPath, "CLAUDE.md");
  const moc = path.join(vaultPath, "MOC — Inicio.md");

  await mkdir(dailyDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  await mkdir(inboxDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await mkdir(attachmentsDir, { recursive: true });
  await mkdir(journalDir, { recursive: true });
  await mkdir(receiptsDir, { recursive: true });

  await writeFile(claudeMd, options.claudeMd ?? DEFAULT_CLAUDE_MD, "utf8");
  await writeFile(moc, options.mocContent ?? DEFAULT_MOC, "utf8");
  await writeFile(dailyTemplate, options.dailyTemplate ?? DEFAULT_DAILY_TEMPLATE, "utf8");
  await writeFile(
    portableConfig,
    options.portableYaml ?? portableYamlFor(layout),
    "utf8",
  );

  const date = options.dailyNoteDate ?? "2026-08-11";
  if (options.withDailyNote) {
    const dailyNote = path.join(dailyDir, `${date}.md`);
    await writeFile(
      dailyNote,
      `# ${date}\n\n## Tareas\n\n## Reflexión\n\n## Notas\n\n## Enlaces del día\n`,
      "utf8",
    );
  }
  if (options.withProjectNote) {
    const projectNote = path.join(projectsDir, "Atlas.md");
    await writeFile(
      projectNote,
      `# Atlas\n\n## Estado\n- En progreso\n`,
      "utf8",
    );
  }

  return {
    vaultPath,
    layout,
    paths: {
      claudeMd,
      moc,
      dailyDir,
      projectsDir,
      inboxDir,
      templatesDir,
      attachmentsDir,
      resystDir,
      journalDir,
      receiptsDir,
      portableConfig,
      dailyTemplate,
    },
    absolute: (relative) => path.join(vaultPath, ...relative.split("/")),
    dailyNotePath: (isoDate) => `${layout.dailyDir}/${isoDate}.md`,
    dailyNoteAbsolute: (isoDate) => path.join(dailyDir, `${isoDate}.md`),
    writeNote: async (relative, content) => {
      const absolute = path.join(vaultPath, ...relative.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
      return absolute;
    },
    writePortableConfig: async (yamlText) => {
      await writeFile(portableConfig, yamlText, "utf8");
    },
    createSymlink: async (relative, targetAbsolute) => {
      const absolute = path.join(vaultPath, ...relative.split("/"));
      await symlink(targetAbsolute, absolute);
      return absolute;
    },
  };
}

/** Resolve the real path of an existing path (helper for symlink tests). */
export async function realpathOf(absolute: string): Promise<string> {
  return realpath(absolute);
}
