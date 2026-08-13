# Resyst Vault Bridge — Design

**Date:** 2026-08-11

**Status:** Approved

**Repository:** `github.com/ProDrifterDK/resyst-vault-bridge` (public)

**First integration:** Prime Agent

## Purpose

Build a portable, agent-independent bridge that gives Prime Agent and, later,
Hermes, Claude Code, and OpenCode selective context from the Resyst Obsidian
Vault and safely writes verified session knowledge back to it.

The LLM decides **what** knowledge deserves persistence. Runtime adapters ensure
**when** that decision is evaluated. The shared core controls **how** updates are
applied safely.

The vault remains outside Git. Git may later be added as an audit and recovery
layer, but it is not part of this version.

## Product decisions

- Use a shared core with thin adapters rather than agent-specific sync logic.
- Implement the core and Prime Agent adapter first. Existing Hermes, Claude
  Code, and OpenCode workflows remain unchanged in phase one.
- Load a compact bootstrap automatically and retrieve other notes on demand.
- Evaluate writeback after each substantial root-agent turn. Compaction and
  shutdown provide a safety net.
- Subagents may read but cannot write. The root session is the sole write
  authority.
- Automatically update the daily note for substantial work, update a project
  note only when project state changed, and update the MOC and vault context
  only when the active project landscape changed.
- Persist results, decisions and rationale, status changes, current blockers,
  reusable failure learnings, and next steps. Exclude transient commands, large
  logs, and inconsequential conversation.
- All vault Markdown may be read and updated. External credential stores and
  binary attachments are excluded from automatic loading. Attachments require
  an explicit read request.
- Use local locks, content hashes, idempotency keys, an immutable journal, and
  auditable receipts. Do not use Git inside the vault.
- Publish the software repository publicly. Fixtures, examples, tests, logs,
  and documentation must contain no real personal vault content or paths beyond
  generic placeholders.

## Architecture

### Shared core: `resyst-vault-bridge`

The local core has no model dependency and exposes a versioned JSON CLI. It:

- locates and validates a vault;
- creates a bounded context bootstrap;
- resolves projects from repository metadata and aliases;
- searches and reads Markdown notes;
- validates structured checkpoint requests;
- renders Obsidian Markdown;
- applies transactions with locks, hashes, atomic writes, and idempotency;
- maintains journal events, receipts, backups, and recovery state;
- defers unsafe or ambiguous updates to `Inbox/`.

The core never independently decides what should be remembered.

### Portable vault configuration

```text
<Vault>/.resyst/
  agent-vault.yaml
  journal/YYYY-MM/<event-id>.json
  receipts/YYYY-MM/<event-id>.json
```

`agent-vault.yaml` defines the portable contract: vault layout, templates,
managed sections, context budget, project metadata conventions, and format
version. Journal and receipt entries use one file per event so Syncthing does
not have multiple hosts appending to one shared file.

### Machine-local configuration and state

```text
~/.config/resyst-vault/config.json
~/.local/state/resyst-vault/
  cache/
  locks/
  backups/
```

The local configuration contains the host identifier, the local vault path,
and optional path-to-project overrides. Cache and indexes are disposable and
must be reproducible from the vault.

### Prime Agent adapter

A thin TypeScript extension connects Prime Agent lifecycle events to the core:

- `before_agent_start` obtains and injects the compact bootstrap;
- `vault_search` and `vault_read` expose on-demand retrieval;
- `vault_checkpoint` submits either a structured update or an explicit no-op;
- root-turn effects determine whether a checkpoint evaluation is required;
- `agent_end`, pre-compaction, and shutdown detect missing evaluations and
  provide a safety net;
- retained/restarted sessions preserve pending checkpoint state;
- subagent sessions receive read tools only;
- internal checkpoint turns cannot recursively trigger checkpoint loops.

The adapter must preserve Prime Agent operation when the bridge is unavailable:
it emits a concise warning, never blocks ordinary agent work, and retains an
observable pending state for later recovery.

## Read and context flow

### Automatic bootstrap

Each root turn receives at most the configured budget, initially 4,000–6,000
estimated tokens. The bootstrap contains:

1. selected identity, preferences, and conventions from `CLAUDE.md`;
2. current context, without accumulated historical context;
3. relevant sections from today's daily note;
4. the detected project's current status;
5. source note, section, and modification timestamp for every fragment.

The bridge does not inject complete long-form `CLAUDE.md`, MOC, daily, or project
notes. `MOC — Inicio.md` is an index and resolution source, not bulk context.

Retrieved note content is delimited as user knowledge, not executable
instructions. Only `.resyst/agent-vault.yaml` and explicitly designated vault
context sections define bridge behavior.

### Project resolution

Resolution is deterministic and ordered:

1. normalized repository or remote metadata in note frontmatter;
2. portable project identifier or alias;
3. a machine-local path override;
4. exact directory, title, or alias match;
5. bounded lexical candidates presented to the LLM.

Semantic retrieval may help identify candidates but cannot silently select an
ambiguous project. If resolution is not unique, the bootstrap reports
`project: unresolved`; writeback affects only the daily note, and the bridge
creates an association proposal in `Inbox/`.

Recommended portable frontmatter fields are exact and versioned, for example:

```yaml
resyst_project:
  id: prime-agent
  repos:
    - github.com/PrimeIntellect-ai/prime-agent
  aliases:
    - Prime Agent
```

Existing notes without these fields remain readable and use fallback
resolution. Migration is incremental, not a prerequisite.

### On-demand reading

- `vault_search` searches filenames, titles, aliases, wikilinks, and content.
- `vault_read` reads one note or selected headings with provenance.
- Results have explicit limits and truncation metadata.
- Subagents may use both commands.
- `_adjuntos/` and other binary files are not indexed or automatically loaded.

## Writeback contract

The LLM submits structured data rather than Markdown patches:

```yaml
version: 1
kind: apply
source:
  agent: prime-agent
  host_id: workstation
  session_id: opaque-session-id
  cwd: /home/tester/project
project:
  id: prime-agent
knowledge:
  completed_tasks: []
  decisions: []
  status_changes: []
  blockers: []
  reusable_learnings: []
  next_steps: []
evidence:
  commits: []
  tests: []
  files: []
  deployments: []
  observations: []
targets:
  daily: true
  project: true
  landscape: false
```

Every factual item may cite evidence. A checkpoint may instead be:

```yaml
version: 1
kind: noop
reason: trivial | lookup_only | no_new_knowledge | unverified | already_recorded
```

This distinguishes an explicit evaluation from a missed checkpoint.

### Managed content

Each session owns stable managed blocks in daily and project notes. Repeated
checkpoints update the same session block instead of appending a block per turn.
The bridge may update its managed blocks but must preserve all content outside
them byte-for-byte.

Markers contain opaque IDs, not sensitive prompt text:

```html
<!-- resyst-vault:begin session=<opaque-id> target=daily -->
...
<!-- resyst-vault:end session=<opaque-id> target=daily -->
```

### Destination policy

**Daily note**

- Create it from the configured vault template when absent.
- Completed work goes under `## Tareas`.
- The activity summary goes under `## Reflexión`.
- Decisions and reusable learning go under `## Notas`.
- Related project and note links go under `## Enlaces del día`.

**Project note**

Update its managed session block only when project status, decisions, blockers,
or next steps changed. Record concise evidence. Do not rewrite historical or
manual sections.

**MOC and `CLAUDE.md`**

Modify only when verified landscape state changes: a project is created,
activated, archived, materially changes canonical state, or changes its
canonical next step. Changes must target one unambiguous row or managed section.

## Transactions, concurrency, and recovery

For every apply checkpoint:

1. derive an event ID and idempotency key;
2. validate all untrusted JSON as `unknown` against the versioned schema;
3. write an immutable journal event;
4. acquire the machine-local global write lock;
5. reread involved files and verify containment, symlinks, hashes, and expected
   structure;
6. build all outputs in memory;
7. save reversible pre-images to local state;
8. write temporary files, fsync as supported, and atomically rename;
9. insert or update idempotency markers;
10. write a receipt containing paths, before/after hashes, and outcome;
11. release the lock.

A crash is recovered by replaying the immutable journal. Existing markers and
hashes prevent duplicate content.

### Cross-host behavior

The local lock coordinates processes on one host. Cross-host safety is achieved
through precondition hashes, per-event files, idempotency markers, and
conflict-file detection; no distributed lock is claimed.

If a note changes after its precondition is captured, an expected section is
missing, multiple project candidates remain, or a Syncthing conflict exists:

- do not force a merge;
- record a `deferred_conflict` receipt;
- keep the event pending;
- create an idempotent proposal note in `Inbox/` with proposed facts, evidence,
  and target paths;
- never silently overwrite the canonical note.

### Backups and rollback

Before applying, save affected pre-images under
`~/.local/state/resyst-vault/backups/<event-id>/`. `rollback <event-id>` restores
only when current hashes still match the event's recorded after-hashes. If the
files changed later, rollback fails closed and reports the mismatch.

## Public CLI

All machine-readable commands support JSON input/output and stable exit codes:

```text
resyst-vault doctor
resyst-vault bootstrap
resyst-vault search
resyst-vault read
resyst-vault checkpoint --dry-run
resyst-vault checkpoint --apply
resyst-vault status
resyst-vault recover
resyst-vault rollback <event-id>
```

Human-readable output is optional presentation over the typed protocol, not a
second behavior implementation.

## TypeScript policy

The project uses strict TypeScript. Explicit `any` is prohibited in source,
tests, generated examples, and public contracts.

- External JSON, YAML, process messages, frontmatter, and extension payloads
  enter as `unknown`.
- Versioned schemas, type guards, and discriminated unions narrow them.
- Public objects are exact and avoid catch-all index signatures unless the
  protocol explicitly requires one.
- Generics do not use unsafe defaults.
- `noImplicitAny`, `strict`, and lint `noExplicitAny` are required gates.
- If an upstream boundary makes `any` unavoidable, the exception must be
  minimal, documented inline, suppressed on one line, wrapped behind an
  `unknown`-based adapter, and covered by a regression test. Such an exception
  requires explicit review and is not a convenience escape hatch.

## Privacy and public-repository hygiene

The software repository is public, while the vault is personal.

- Never commit real notes, journal events, receipts, hostnames, usernames,
  session IDs, local paths, credentials, hashes derived from private fixture
  text, or screenshots of the real vault.
- Tests use synthetic people, projects, remotes, timestamps, and filesystem
  roots.
- Documentation uses `<Vault>`, `<home>`, and neutral example projects.
- Runtime logs redact note content and use opaque IDs.
- CI includes secret scanning and a fixture-hygiene test.
- No telemetry transmits note content or metadata.

## Testing

### Unit tests

- frontmatter and heading parsing;
- bootstrap selection and token budget;
- project resolution priority and ambiguity;
- path containment and symlink rejection;
- Markdown rendering and managed blocks;
- exact preservation of manual content;
- schemas and exhaustive discriminated unions;
- idempotency and deterministic formatting.

### Concurrency and recovery tests

- simultaneous local writers;
- stale precondition hash;
- crash between file writes;
- replay without duplication;
- Syncthing conflict detection;
- abandoned local lock recovery;
- rollback before and after subsequent edits.

### Prime Agent integration tests

- bootstrap injection into a root session;
- read tools available to children;
- checkpoint application unavailable to children;
- explicit apply and no-op;
- missing-checkpoint fallback after a substantial root turn;
- compaction, shutdown, restart, and retained session recovery;
- bridge failure does not block ordinary agent work;
- internal evaluation cannot create a checkpoint loop.

## Rollout

1. Build and test against synthetic fixture vaults.
2. Test against a temporary copy of the Resyst Vault.
3. Run the real vault in read-only and checkpoint dry-run mode.
4. Canary one daily note and one unambiguous project note.
5. Compare generated output manually and test rollback.
6. Enable automatic root-turn writeback.
7. Observe deferred events and duplicates before broader adoption.

Phase one does not change Hermes, OpenCode, or Claude Code. Later adapters use
the same schemas and CLI, then replace their existing context/sync mechanisms
incrementally.

## Acceptance criteria

- Bootstrap stays within its configured budget and includes provenance.
- Project resolution selects only an unambiguous match or returns unresolved.
- A retry or process restart cannot duplicate content.
- Manual content outside managed blocks remains byte-identical.
- Subagents cannot obtain write authority.
- Every change has a journal event, receipt, evidence, and reversible pre-image.
- Concurrent or ambiguous updates defer rather than overwrite.
- Prime Agent evaluates every substantial root turn, with compact/shutdown as a
  safety net.
- Existing Hermes, OpenCode, and Claude Code behavior remains unchanged in phase
  one.
- The public repository contains no real vault data.
- The source and tests pass strict TypeScript and the explicit-`any` gate.

## Deferred decisions

- Git audit/rollback for the vault itself.
- Private Forgejo or GitHub backup of the vault.
- Hermes, OpenCode, and Claude Code adapter details.
- Semantic/vector indexing beyond bounded lexical retrieval.
- Binary attachment extraction and indexing.
