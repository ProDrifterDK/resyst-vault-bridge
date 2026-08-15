# Configuration

The Resyst Vault Bridge reads two configuration files. They describe one
vault and split their responsibilities so that a portable vault can be shared
between machines without ever exposing machine-specific information.

## Files

### Portable: `<vault>/.resyst/agent-vault.yaml`

This file lives inside the vault. The bridge never requires, reads, or
writes any Git state inside the vault; the portable file is a plain
text artifact shared by the host bridge process and any peer vault
operator. It is the only authority for layout, template references,
managed headings, context budget, and resolution conventions.

```yaml
version: 1
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
  project_frontmatter_field: "resyst_project"
```

Rules enforced by the loader:

- Every path is vault-relative POSIX. Leading slashes, backslashes, dot
  segments, doubled slashes, trailing slashes, and control characters are
  rejected.
- The portable file never carries machine-specific values: absolute home
  paths, secrets, tokens, passwords, authorization fields, or executable
  hooks are rejected.
- `attachments_dir` is optional-to-exist. Attachment-free vaults are valid;
  the directory is never required and is never containment-checked.
- `templates.daily` may be null to fall back to the built-in daily template.
- Required operational layout directories (`daily_dir`, `projects_dir`,
  `inbox_dir`, `templates_dir`) must exist as directories and resolve
  inside the vault root. Contained symlinks are allowed; escaping ones are
  rejected.

### Local: `${XDG_CONFIG_HOME:-~/.config}/resyst-vault/config.json`

This file is machine-specific. It is the only authority for the host ID and
the absolute vault path.

```json
{
  "version": 1,
  "host_id": "casey",
  "vault_path": "/home/tester/Notes",
  "pi_root_authority": false,
  "project_overrides": [
    {
      "path": "/home/tester/atlas",
      "project_id": "atlas"
    }
  ]
}
```

Rules enforced by the loader:

- The file must be valid JSON and parse cleanly.
- `vault_path` is an absolute POSIX path with no backslashes, no NUL, and no
  trailing slash.
- `host_id` must match the bridge identifier pattern (lowercase letters,
  digits, dot, underscore, hyphen).
- `project_overrides` are exact machine-local maps from a real path to a
  portable project id. They take precedence over portable resolution for
  the listed paths only.
- `pi_root_authority` is optional and defaults to `false`. Only literal boolean
  `true` opts standalone Pi sessions into bootstrap and checkpoint authority;
  positively marked Pi subagents remain read-only. The portable YAML cannot
  set this field.
- The same secret/hook rejection rules apply as for the portable file.

## Resolution order

The loader merges the two files; keys are owned by exactly one source:

| Concern                   | Portable YAML | Local JSON |
| ------------------------- | :-----------: | :--------: |
| `vault_path`              |               |     ✓      |
| `host_id`                 |               |     ✓      |
| `project_overrides`       |               |     ✓      |
| `pi_root_authority`       |               |     ✓      |
| `layout.*`                |       ✓       |            |
| `templates.daily`         |       ✓       |            |
| `managed_headings.*`      |       ✓       |            |
| `budget.context_tokens`   |       ✓       |            |
| `conventions.*`           |       ✓       |            |

Either file rejecting the other's keys is a hard error. After parsing, the
loader validates the vault itself: the configured path must exist, be a
directory, realpath-resolve, and every required layout directory must exist
and resolve inside the vault root.

## Environment variables

- `XDG_CONFIG_HOME` — overrides `~/.config` for local config lookup.
  Defaults to `~/.config` (resolved under the inherited `$HOME`) when
  unset. The bridge rejects a relative value fail-closed: a non-empty
  `XDG_CONFIG_HOME` that is not absolute terminates the CLI with
  `invalid_config` (exit 2) before any service effect.
- `XDG_STATE_HOME` — overrides `~/.local/state` for machine-local locks,
  backups/progress, and the search cache. Immutable journals and receipts
  remain portable inside `<vault>/.resyst/`; recovery reads those vault
  records. The local state root defaults to an absolute path built from the
  inherited `$HOME` (or `os.homedir()`) when unset. A non-empty
  `XDG_STATE_HOME` that is not absolute fails closed with exit 2.
- `NO_COLOR` — present in the inherited environment; the CLI accepts
  and ignores a global `--no-color` flag and never emits ANSI codes
  regardless.

The CLI never mutates the environment, never writes to either config
file, never writes under the current working directory, and never
echoes any payload value on stderr. The state root is always an
absolute, non-empty string at every service seam.

## Synthetic example

The test suite ships a complete synthetic setup. The temporary vault is
created by `tests/fixtures/create-vault.ts`. The local config used during
the CLI integration tests is:

```json
{
  "version": 1,
  "host_id": "casey",
  "vault_path": "<tmp-vault>",
  "project_overrides": [],
  "pi_root_authority": false
}
```

with `<tmp-vault>` pointing at a vault created by the synthetic fixture
(neutral layout, neutral user Casey, the synthetic project Atlas, and fixed
content). The portable YAML is the example above with no edits.

## Privacy

The two files are the only inputs the bridge trusts. They contain:

- The vault's portable layout contract (share only according to the vault operator's policy).
- The local machine's host ID and absolute vault path (machine-specific).

The bridge never reads, writes, or echoes:

- The contents of any note outside the explicitly requested operation.
- The trusted vault identity (realpath + bigint dev/ino); it is local
  runtime state only and never JSON-serialized.
- Any other on-disk state outside the vault root and the local
  `~/.local/state/resyst-vault/` directory.

Every error message on stderr is a fixed redacted string. No error
message concatenates caller-supplied data (paths, payloads, exception
messages, raw JSON). The CLI JSON envelopes contain only symbolic
fields; the only note body content that may appear in stdout is the
explicitly requested `bootstrap.context`, `read.content`, and
`search.hits[*].snippet` fields. Requested machine metadata (paths,
titles, query, IDs, timestamps) may appear in stdout as document
metadata for the requested operation; it is never echoed on stderr.
