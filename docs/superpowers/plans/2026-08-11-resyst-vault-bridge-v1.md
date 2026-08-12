# Resyst Vault Bridge v1 Implementation Plan

> **For agentic workers:** Implement one task at a time using TDD. Every task must observe a focused RED test, make the smallest GREEN change, run the listed focused gate, and commit before starting the next task. Run the full repository gate once, in the final task.

**Goal:** Deliver a public, installable Prime Agent package whose agent-independent core loads bounded context from an Obsidian vault and applies safe, auditable, reversible writeback after substantial root-agent work.

**Architecture:** A strict TypeScript core owns configuration, Markdown parsing, project resolution, retrieval, checkpoint validation, rendering, locking, atomic writes, journal/receipt persistence, recovery, and rollback. A JSON CLI presents the same core to future adapters. The Prime Agent extension remains a thin lifecycle/tool adapter: all sessions can search/read; only unambiguous root sessions can checkpoint. Automatic bootstrap is ephemeral per root turn, while missing-checkpoint evaluation is requested once through a guarded internal follow-up.

**Tech stack:** Node.js 22+, TypeScript NodeNext ESM, `yaml`, `typebox`, Vitest, Biome, native `fs`/`crypto`/`child_process`, Prime Agent extension API.

## Global constraints

- The approved specification is `docs/superpowers/specs/2026-08-11-resyst-vault-bridge-design.md`; this plan cannot weaken it.
- The repository is public. Never copy real Resyst Vault notes, usernames, home paths, hostnames, session IDs, screenshots, journal records, hashes derived from private text, or Syncthing conflict files into the repo.
- All fixtures use the neutral user `Casey`, the synthetic project `Atlas`, fixed timestamps, and roots under `/home/tester` or temporary test directories.
- Strict TypeScript is mandatory. Explicit `any` is forbidden in source, tests, examples, and public contracts. External values enter as `unknown` and are narrowed.
- An upstream `any` exception requires a one-line suppression, explanation, `unknown` wrapper, regression test, and explicit review. No task currently requires such an exception.
- The vault is never initialized as a Git repository. Git is used only for this software repository and read-only project identity discovery.
- No daemon or database is introduced. The index is an in-memory/on-disk regenerable cache; correctness never depends on cache freshness.
- Core writes are possible only through the transaction service. Read tools do not import mutation modules.
- Subagents may search/read but must never receive the checkpoint tool or automatic writeback. Root detection fails closed unless Prime Agent reports integer `rlmDepth === 0`.
- The bridge fails open for ordinary agent work: unavailable context/writeback emits a redacted warning and pending status rather than blocking the host turn.
- `dist/` is generated during release checks but is not committed during early implementation unless the package contract is intentionally changed in the final packaging task.
- Use TDD for every task. Focused commands belong to the task; `npm run check` runs once at the end.


## Test seams

The plan uses the highest stable behavioral seams available:

1. **Core service seam:** synthetic vault input to typed bootstrap/search/read/plan/apply/recover/rollback output. Most policy is tested here rather than through private helpers.
2. **CLI seam:** `runCli()` with injected IO for fast tests, plus one subprocess smoke against the built binary to prove JSON and exit-code behavior.
3. **Prime adapter seam:** invoke the public extension factory with a typed fake `ExtensionAPI`; exercise registered event handlers and tools without a provider call.
4. **Prime package seam:** one final disposable-home smoke loads the built git-package artifact in the real Prime Agent extension host.

Parser, path-containment, lock, and crash-frontier helpers also receive focused unit tests because failures at those security boundaries cannot be diagnosed reliably only through the highest seam.

## Managed daily-record decision

One logical session record is materialized as up to four small managed fragments, one under each configured daily heading (`Tareas`, `Reflexión`, `Notas`, and `Enlaces del día`). All fragments share the same opaque session key and are planned/applied as one recoverable transaction. This satisfies the destination policy without wrapping or rewriting manual text between headings. The project note uses one contiguous managed block. Callers see one logical record; marker parsing owns the physical fragments.

## Transactional guarantee

A rename is atomic per file; POSIX filesystems do not provide an atomic rename across several notes. Therefore v1 guarantees hash-gated, journaled, **recoverable** multi-note transactions—not impossible cross-file atomic visibility. Progress is durable after each file, retry/recovery is idempotent, and unexpected intermediate state defers rather than guesses.

## Locked package shape

```text
.github/workflows/ci.yml
.gitignore
README.md
biome.json
package.json
package-lock.json
tsconfig.json
vitest.config.ts
src/
  types.ts
  schemas.ts
  config.ts
  paths.ts
  markdown.ts
  project.ts
  bootstrap.ts
  search.ts
  checkpoint.ts
  render.ts
  lock.ts
  journal.ts
  transaction.ts
  recovery.ts
  rollback.ts
  status.ts
  cli.ts
  extension/
    host.ts
    state.ts
    tools.ts
    index.ts
tests/
  fixtures/
    create-vault.ts
  unit/
  integration/
  privacy/
docs/
  configuration.md
  security.md
  prime-agent.md
  superpowers/
    specs/2026-08-11-resyst-vault-bridge-design.md
    plans/2026-08-11-resyst-vault-bridge-v1.md
```

Public modules may be split further only when the existing file would own two unrelated policies. Do not introduce barrel files beyond the package/extension entry points.

---

## Task 1: Strict package and protocol foundation

**Files**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `biome.json`
- Create: `src/types.ts`
- Create: `src/schemas.ts`
- Create: `tests/unit/schemas.test.ts`
- Modify: `.gitignore`

**Produces:** versioned `apply`/`noop` checkpoint types, result/receipt discriminated unions, safe schema parsers, package scripts, and the no-explicit-`any` gate.

- [ ] Write `tests/unit/schemas.test.ts` first. Cover valid apply/noop values, every invalid discriminator, unknown keys, absent evidence, non-string arrays, path-like IDs, and prototype-pollution-shaped input. Assert `parseCheckpoint(unknown)` returns an exact typed union or throws a redacted validation error.
- [ ] Run `npx vitest run tests/unit/schemas.test.ts`. Expected RED: unresolved modules.
- [ ] Add the NodeNext package scaffold. Use Node `>=22`, package name `resyst-vault-bridge`, version `0.0.0`, and `private: true` until a license/release policy is explicitly selected. Set `bin.resyst-vault = ./dist/cli.js` and `pi.extensions = ["./dist/extension/index.js"]`. Runtime dependencies are `yaml` and `typebox`; Prime Agent packages remain peer dependencies. Dev dependencies include TypeScript, Vitest, Biome, Node types, and Prime Agent extension types.
- [ ] Configure TypeScript with `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, and NodeNext. Configure Biome `noExplicitAny: error` across source and tests.
- [ ] Define exact types in `src/types.ts`: `CheckpointRequest`, `ApplyCheckpoint`, `NoopCheckpoint`, `Evidence`, `Knowledge`, `Targets`, `CheckpointOutcome`, `JournalEvent`, `Receipt`, `ProjectResolution`, `BootstrapResult`, `SearchHit`, and branded opaque IDs where useful.
- [ ] Implement `src/schemas.ts` using TypeBox plus a single validation adapter. Require `additionalProperties: false` at every public object boundary. Convert schema failures to fixed messages that never echo payload values.
- [ ] Add script `check:no-any` that scans tracked `.ts`/`.tsx` source and test files for explicit `any` and fails on a match; exclusions must be an exact reviewed allowlist file, initially empty.
- [ ] Run `npx vitest run tests/unit/schemas.test.ts && npm run typecheck && npm run lint && npm run check:no-any`. Expected GREEN.
- [ ] Commit: `feat: add strict protocol foundation`.

---

## Task 2: Portable configuration and vault path safety

**Files**

- Create: `src/config.ts`
- Create: `src/paths.ts`
- Create: `tests/unit/config.test.ts`
- Create: `tests/unit/paths.test.ts`
- Create: `tests/fixtures/create-vault.ts`

**Produces:** portable `.resyst/agent-vault.yaml` loading, local path/host configuration, normalized layout, and containment/symlink checks shared by every read/write path.

- [ ] Create a synthetic fixture builder that makes a complete temporary vault with `CLAUDE.md`, `MOC — Inicio.md`, `Notas Diarias`, `Proyectos`, `Inbox`, `_plantillas`, and `.resyst`. Parameterize content; never read the real vault.
- [ ] Write failing configuration tests for: portable/local merge precedence, default context budget, malformed YAML/JSON, invalid host IDs, missing vault, wrong directory types, absent required layout, unexpected keys, and secret-shaped keys. Local path is machine-specific; portable config must reject absolute home paths.
- [ ] Write failing path tests for traversal (`../`), absolute note references, symlink escape, symlinked target files, `_adjuntos` automatic exclusion, `.stfolder`, `.git`, and accepted normalized Markdown paths within the vault.
- [ ] Run `npx vitest run tests/unit/config.test.ts tests/unit/paths.test.ts`. Expected RED.
- [ ] Implement local config at `${XDG_CONFIG_HOME:-~/.config}/resyst-vault/config.json` with `vault_path`, `host_id`, and optional exact local project overrides. Implement portable YAML with version, layout, templates, managed headings, budget, and resolution conventions.
- [ ] Treat file contents and YAML parse results as `unknown`; narrow every field. Only `ENOENT` may represent absence. Reject credentials, tokens, passwords, authorization fields, and executable hooks in either config.
- [ ] Implement `VaultPaths` so all note paths are vault-relative POSIX paths. Validate lexical containment before IO, then `realpath` containment for existing parents and targets. Reject symlink targets for writes.
- [ ] Run focused tests plus `npm run typecheck && npm run check:no-any`. Expected GREEN.
- [ ] Commit: `feat: validate vault configuration and paths`.

---

## Task 3: Obsidian Markdown model with exact manual preservation

**Files**

- Create: `src/markdown.ts`
- Create: `tests/unit/markdown.test.ts`

**Produces:** frontmatter, heading, wikilink, and managed-block parsing that preserves all non-managed bytes.

- [ ] Write table-driven failing tests for quoted YAML frontmatter, missing frontmatter, CRLF, Unicode headings, duplicate headings, setext headings, code fences containing fake headings, wikilinks with aliases/anchors, malformed managed markers, and extraction of one selected section.
- [ ] Add the core preservation test: replace one session-managed block and assert the prefix/suffix outside its begin/end offsets are byte-identical to the original input.
- [ ] Add tests proving markers in code fences and malformed/nested markers fail closed rather than being edited.
- [ ] Run `npx vitest run tests/unit/markdown.test.ts`. Expected RED.
- [ ] Implement a position-aware parser. YAML frontmatter is parsed to `unknown` and narrowed only for title/date/tags/aliases/resyst_project. Heading scanning must ignore fenced blocks. Represent selected regions as source offsets rather than rebuilding the document AST.
- [ ] Implement managed marker parsing for opaque session/target IDs. A replacement may alter only the bounded block body. New blocks are inserted under exactly one configured heading; missing or duplicate target headings return a typed ambiguity result.
- [ ] Run the focused test, typecheck, lint, and no-any gate. Expected GREEN.
- [ ] Commit: `feat: preserve Obsidian note structure`.

---

## Task 4: Deterministic project resolution and association proposals

**Files**

- Create: `src/project.ts`
- Create: `tests/unit/project.test.ts`

**Produces:** ordered project resolution with exact match or explicit unresolved/ambiguous outcomes; no semantic auto-selection.

- [ ] Write failing tests for normalized GitHub HTTPS/SSH/remotes, frontmatter `repos`, portable IDs, aliases, local overrides, exact directory/title matches, lexical candidate ordering, duplicate candidates, no-Git directories, and unreadable notes.
- [ ] Assert ordering: repo/remote > portable ID/alias > local override > exact directory/title > bounded lexical candidates. Assert candidate retrieval never becomes an automatic selection.
- [ ] Add a test that two equal candidates return `{ kind: "ambiguous" }` with redacted vault-relative paths and the daily-write-only policy.
- [ ] Run `npx vitest run tests/unit/project.test.ts`. Expected RED.
- [ ] Implement shell-free Git calls with `execFile("git", ["-C", cwd, ...])`, bounded output, normalized remotes, and injectable dependencies. Do not require the vault itself to use Git.
- [ ] Parse only allowed frontmatter fields. Use stable portable IDs when available; never derive public journal fields from absolute paths.
- [ ] Return exact discriminated unions: `resolved`, `unresolved`, or `ambiguous`. Provide `buildAssociationProposal()` data but do not write it yet.
- [ ] Run focused tests and static gates. Expected GREEN.
- [ ] Commit: `feat: resolve vault projects deterministically`.

---

## Task 5: Bounded bootstrap with provenance

**Files**

- Create: `src/bootstrap.ts`
- Create: `tests/unit/bootstrap.test.ts`

**Produces:** compact root context built from approved sections, current daily note, and resolved project note.

- [ ] Write failing tests for selection of identity/preferences/conventions/current context, exclusion of historical context, MOC used for resolution but not bulk injection, daily section selection, project status selection, provenance metadata, missing daily/project notes, and unresolved projects.
- [ ] Test deterministic budget enforcement at 4,000, 6,000, and tiny budgets. The result must state truncation and never split a Unicode surrogate pair or managed marker.
- [ ] Test prompt-injection-like Markdown is wrapped as untrusted user knowledge and cannot alter the bridge instruction prefix.
- [ ] Run `npx vitest run tests/unit/bootstrap.test.ts`. Expected RED.
- [ ] Implement a deterministic priority budget: bridge safety header, vault conventions, active context, project status/next step, daily relevant sections. Use a conservative character-to-token estimator behind an injectable interface; do not add a tokenizer dependency in v1.
- [ ] Emit provenance per fragment: vault-relative path, heading, file modification time, character count, and truncation flag. Never expose absolute vault paths.
- [ ] Run focused tests and static gates. Expected GREEN.
- [ ] Commit: `feat: build bounded vault bootstrap`.

---

## Task 6: Explicit search and section-limited reading

**Files**

- Create: `src/search.ts`
- Create: `tests/unit/search.test.ts`
- Create: `tests/integration/read-search.test.ts`

**Produces:** agent-independent read/search service with bounded results, provenance, exclusions, and regenerable cache behavior.

- [ ] Write failing unit tests for filename, title, alias, wikilink, and content matching; Unicode case folding; deterministic scoring/ties; result/character caps; ignored binary files; ignored `.resyst/journal`, receipts, `_adjuntos`, `.stfolder`, `.git`, and Syncthing conflict copies.
- [ ] Write failing integration tests against the synthetic fixture for full-note read, selected-heading read, missing/duplicate headings, stale cache rebuild, and never returning absolute paths.
- [ ] Run `npx vitest run tests/unit/search.test.ts tests/integration/read-search.test.ts`. Expected RED.
- [ ] Implement a lexical index whose persisted cache records only regenerable metadata/text and is stored outside the vault. Cache writes are atomic; cache failure falls back to direct bounded scan.
- [ ] Search output must quote bounded snippets with source note/heading/mtime and truncation. `read` requires one normalized Markdown path and optional exact heading.
- [ ] Run focused tests and static gates. Expected GREEN.
- [ ] Commit: `feat: add bounded vault retrieval`.

---

## Task 7: Structured rendering and destination policy

**Files**

- Create: `src/checkpoint.ts`
- Create: `src/render.ts`
- Create: `tests/unit/checkpoint.test.ts`
- Create: `tests/unit/render.test.ts`

**Produces:** evidence-aware checkpoint normalization and deterministic managed-record output for daily/project/landscape destinations.

- [ ] Write failing checkpoint tests for empty/trivial applies, invalid evidence, duplicate knowledge, requested project write while unresolved, landscape requests without a landscape change, no-op reason handling, idempotency-key canonicalization, and daily-only downgrade on ambiguity.
- [ ] Write failing rendering tests for creating a daily note from a synthetic template; mapping tasks/reflection/notes/links into four fragments sharing one logical session key; creating/updating that logical record without duplicates; project status/decision/evidence/blocker/next-step formatting; and exact preservation outside managed ranges.
- [ ] Write MOC/`CLAUDE.md` tests requiring exactly one targeted managed row/section. Missing or duplicate landscape targets must return a deferred plan rather than a patch.
- [ ] Run `npx vitest run tests/unit/checkpoint.test.ts tests/unit/render.test.ts`. Expected RED.
- [ ] Implement canonical checkpoint normalization: trim/dedupe while preserving order, require at least one meaningful fact for apply, require evidence for completed/status/deployment claims, and compute a SHA-256 idempotency key from schema version + opaque source IDs + canonical knowledge + targets.
- [ ] Render deterministic Obsidian Markdown without accepting model-authored Markdown patches. Escape marker-like text. Links are exact existing note titles supplied by resolution/search, never invented from arbitrary strings.
- [ ] Return an in-memory `WritePlan` containing target path, before-hash precondition, after-content, and reason. Do not write files in this task.
- [ ] Run focused tests and static gates. Expected GREEN.
- [ ] Commit: `feat: plan structured vault updates`.

---

## Task 8: Journal, local lock, and single-target transaction apply

**Files**

- Create: `src/lock.ts`
- Create: `src/journal.ts`
- Create: `src/transaction.ts`
- Create: `tests/unit/lock.test.ts`
- Create: `tests/unit/journal.test.ts`
- Create: `tests/integration/transaction.test.ts`

**Produces:** immutable per-event journal, single-host coordination, backups, per-file atomic writes, receipts, and idempotent apply for one target.

- [ ] Write failing lock tests for mutual exclusion, timeout, live-owner protection, and abandoned lock recovery using PID + process-start identity. Never break a lock on age alone.
- [ ] Write failing journal tests for one immutable file per event/receipt, `O_EXCL` creation, stable YYYY-MM placement, schema validation on read, redacted JSON, fsync/rename behavior, and duplicate idempotency key lookup.
- [ ] Write failing single-target transaction tests for daily apply, retry returning `already_applied`, stale before-hash, target symlink swap, injected failure before rename, backup creation, receipt contents, file mode preservation, and manual bytes outside managed fragments.
- [ ] Run `npx vitest run tests/unit/lock.test.ts tests/unit/journal.test.ts tests/integration/transaction.test.ts`. Expected RED.
- [ ] Implement the local lock in `~/.local/state/resyst-vault/locks/` with an atomically created owner record. Dependency-inject PID/start-ID/time for tests.
- [ ] Before locking, persist the immutable event. Under the lock, reread and revalidate the path/hash, write the local pre-image, prepare a temp file in the target directory, fsync as supported, rename atomically, persist progress, then write the receipt.
- [ ] Use idempotency markers plus receipt lookup to make retries safe. Receipt paths are vault-relative; before/after hashes are allowed locally/in receipts but no note text is logged.
- [ ] On concurrent/precondition/structure conflict, write `deferred_conflict`, keep the event pending, and create/update one idempotent synthetic `Inbox/` proposal through the same single-target primitive.
- [ ] Run focused tests and static gates. Expected GREEN.
- [ ] Commit: `feat: apply auditable vault transactions`.

---

## Task 9: Multi-target recovery, rollback, status, and doctor services

**Files**

- Create: `src/recovery.ts`
- Create: `src/rollback.ts`
- Create: `src/status.ts`
- Create: `tests/integration/recovery.test.ts`
- Create: `tests/integration/rollback.test.ts`
- Create: `tests/unit/status.test.ts`

**Produces:** recoverable daily+project+landscape transactions, crash completion, fail-closed rollback, pending/conflict inspection, and configuration/health diagnostics.

- [ ] Write failing recovery tests for crashes before any rename, between note renames, after all renames before receipt, already-applied markers, corrupt progress, and changed target after crash. Recovery completes only when every current target is at its recorded before/after frontier; otherwise it defers.
- [ ] Write a failing end-to-end multi-target apply test: daily+project uses deterministic path order, persists progress after each rename, and retry/recovery finishes without duplicate fragments. This test explicitly documents temporary cross-file visibility rather than claiming cross-file atomicity.
- [ ] Write failing rollback tests for exact after-hash restoration, later user edit rejection, partial event rejection, missing backup, repeated rollback, and rollback receipt linkage.
- [ ] Write failing doctor/status tests for permissions, missing template/headings, stale live lock, abandoned lock, pending events, Syncthing conflicts, cache health, and path redaction.
- [ ] Run `npx vitest run tests/integration/recovery.test.ts tests/integration/rollback.test.ts tests/unit/status.test.ts`. Expected RED.
- [ ] Generalize Task 8's transaction service to a `WritePlan[]`: prepare and persist all pre-images/temp paths first, then rename in deterministic order while recording a durable frontier after each file. Replay from journal/progress/markers rather than guesses. Never overwrite a file whose current hash is neither the recorded before nor after hash.
- [ ] Rollback acquires the same lock and restores all backups only if every target matches the recorded after-hash. It writes a linked receipt and is itself idempotent.
- [ ] Implement `doctor` as read-only except safe cleanup of a proven abandoned local lock when explicitly requested. `status` summarizes pending/deferred/applied/rolled-back counts without note content.
- [ ] Run focused tests and static gates. Expected GREEN.
- [ ] Commit: `feat: recover and roll back vault events`.

---

## Task 10: Stable JSON CLI over the shared core

**Files**

- Create: `src/cli.ts`
- Create: `tests/integration/cli.test.ts`
- Create: `docs/configuration.md`
- Create: `docs/security.md`

**Produces:** future-adapter protocol for doctor/bootstrap/search/read/checkpoint/status/recover/rollback with stable JSON and exit codes.

- [ ] Write failing subprocess tests for every command, stdin JSON parsing, JSON Lines/no-color output, invalid input, dry-run versus apply, stable exit codes, SIGINT, path/content redaction, and no interactive prompts.
- [ ] Run `npx vitest run tests/integration/cli.test.ts`. Expected RED.
- [ ] Implement an argument parser with no implicit environment mutation. Machine output goes to stdout as one JSON value; diagnostics go to stderr; note content appears only in requested bootstrap/read/search result fields.
- [ ] Define exit codes: `0` success/noop/already-applied, `2` invalid request/config, `3` unavailable, `4` deferred conflict, `5` recovery required, `6` rollback precondition failed. Include the symbolic outcome in JSON so adapters do not depend solely on numbers.
- [ ] `checkpoint --dry-run` builds a plan and event preview but writes neither vault nor journal. `--apply` routes only through `TransactionService`.
- [ ] Document portable/local config, synthetic examples, privacy boundary, recovery, Syncthing limitations, and no distributed-lock claim.
- [ ] Run focused tests, `npm run build`, and invoke `node dist/cli.js doctor` against a synthetic fixture. Expected GREEN.
- [ ] Commit: `feat: expose portable vault CLI`.

---

## Task 11: Prime Agent read adapter and ephemeral bootstrap

**Files**

- Create: `src/extension/host.ts`
- Create: `src/extension/tools.ts`
- Create: `src/extension/index.ts`
- Create: `tests/unit/extension-host.test.ts`
- Create: `tests/unit/extension-read.test.ts`
- Create: `tests/integration/prime-extension.test.ts`
- Create: `docs/prime-agent.md`

**Produces:** installable Prime Agent extension, root-only bootstrap injection, and read tools available at every RLM depth.

- [ ] Build a typed fake `ExtensionAPI` test harness without explicit `any`. Use `unknown` event payloads plus narrowed handler registries; isolate the unavoidable broad host surface behind `as unknown as ExtensionAPI`, matching Prime's test pattern without introducing `any`.
- [ ] Write failing host tests for integer header `rlmDepth`: `0` root, positive child, missing/string/negative/unsafe values fail closed. Persisted header is the authority; the extension must not trust session names, directory naming heuristics, or a spoofable model argument.
- [ ] Write failing extension tests proving `vault_search` and `vault_read` register for root and child; `vault_checkpoint` is absent initially; bootstrap runs once per root user turn; children receive no automatic bootstrap; retries/tool-loop `context` events do not duplicate it; resume/reload clears transient cache; unavailable bridge does not block the agent.
- [ ] Test ephemeral injection through `before_agent_start.systemPrompt` only. Assert the adapter returns no custom message and never calls `pi.appendEntry` for bootstrap content. This is turn-scoped and avoids persisting vault text in session JSONL.
- [ ] Run `npx vitest run tests/unit/extension-host.test.ts tests/unit/extension-read.test.ts tests/integration/prime-extension.test.ts`. Expected RED.
- [ ] Implement root detection only from `ctx.sessionManager.getHeader().rlmDepth`. Current Prime Agent persists this field for roots and children; absent or malformed values receive read-only child-equivalent authority. Register read tools with TypeBox parameters and bounded outputs. Convert service failures to fixed user-facing messages.
- [ ] Inject a delimited bootstrap by appending to `event.systemPrompt`; cache by session ID + normalized prompt fingerprint only for the current agent loop. Clear on `agent_end`, session replacement, and shutdown.
- [ ] Document installation from `git:github.com/ProDrifterDK/resyst-vault-bridge` and initial read-only/dry-run setup.
- [ ] Run focused tests, typecheck, build, and no-any gate. Expected GREEN.
- [ ] Commit: `feat: integrate Prime Agent vault reads`.

---

## Task 12: Root-only checkpoint and substantial-work detector

**Files**

- Create: `src/extension/state.ts`
- Modify: `src/extension/tools.ts`
- Modify: `src/extension/index.ts`
- Create: `tests/unit/extension-state.test.ts`
- Create: `tests/integration/prime-checkpoint.test.ts`

**Produces:** explicit root-only apply/noop checkpoint, per-session persistence, effect tracking, and concise receipts.

- [ ] Write failing state tests for root/child authority, session state reconstruction from machine-local pending records plus custom-entry mirrors, apply/noop completion, multiple checkpoints updating one session block, retained/resumed session state, compaction that drops older custom entries, and reset on `/new`/fork.
- [ ] Write a failing effects matrix. Substantial signals include successful mutating `edit`, successful non-read-only `bash`, deployment/commit observations supplied in checkpoint evidence, and successful model-callable tools marked by configuration. Search/read, failed tools, and the bridge's own tools are non-substantial. Conservative uncertainty sets `evaluation_pending`, not `substantial=false`.
- [ ] Write failing integration tests proving the checkpoint tool registers only for `rlmDepth === 0`; child calls are impossible from active tool registration; root `apply` routes through the transaction service; root `noop` persists an evaluation marker; receipts render exactly one compact status line.
- [ ] Run `npx vitest run tests/unit/extension-state.test.ts tests/integration/prime-checkpoint.test.ts`. Expected RED.
- [ ] Implement a small state machine: `clean -> substantial_pending -> evaluated`, plus `evaluation_pending` for uncertainty and `evaluating` for internal turns. Persist the source of truth atomically under `~/.local/state/resyst-vault/pending/<opaque-session-id>.json`; mirror it with `pi.appendEntry("resyst-vault.checkpoint-state", data)` for transcript observability. On `session_start`, reconcile both copies without trusting a mirror that is newer than the local record. This preserves pending state even when compaction drops older custom entries.
- [ ] Register `vault_checkpoint` only after root authority is established at `session_start`; if late registration is not supported by the installed Prime version, register it universally but make its execute path fail closed and remove it from child active tools. The preferred and acceptance-tested behavior is absence from child active tools.
- [ ] Never let the model choose `source.agent`, host ID, session ID, cwd, project resolution, or authority. The adapter fills them from trusted runtime context.
- [ ] Run focused tests and static gates. Expected GREEN.
- [ ] Commit: `feat: gate root vault checkpoints`.

---

## Task 13: Automatic missing-checkpoint evaluation and lifecycle safety net

**Files**

- Modify: `src/extension/state.ts`
- Modify: `src/extension/index.ts`
- Create: `tests/integration/prime-auto-evaluation.test.ts`

**Produces:** one autonomous semantic evaluation after substantial root work, plus compaction/shutdown pending-state safety without recursive loops.

- [ ] Write failing tests for: no follow-up after trivial/lookup-only work; one internal follow-up after substantial root work without a checkpoint; no follow-up if apply/noop already happened; queued user work is not reordered; internal evaluation cannot trigger itself; failed evaluation remains pending; resume and post-compaction recovery retry pending once from machine-local state; children never schedule evaluation.
- [ ] Write failing lifecycle tests for `session_before_compact` and `session_shutdown`: handlers persist pending state synchronously/awaitably but do not start an unsafe LLM turn during teardown. On the next available root start, pending evaluation is restored and requested once.
- [ ] Run `npx vitest run tests/integration/prime-auto-evaluation.test.ts`. Expected RED.
- [ ] At `agent_end`, when root state is `substantial_pending`, no checkpoint tool result exists, `ctx.hasPendingMessages()` is false, and no evaluation is in flight, send one hidden custom follow-up with `triggerTurn: true` instructing the model to call `vault_checkpoint` exactly once with apply or noop. Mark `evaluating` before sending.
- [ ] The internal prompt includes only structured criteria and opaque state; it does not repeat vault content or raw logs. Tag it with `customType: "resyst-vault.evaluate"`, `display: false`.
- [ ] If user messages are queued, persist `evaluation_pending` and defer until a later idle root boundary. `session_before_compact`/shutdown append state only. Recovery on `session_start` schedules at most once after normal startup.
- [ ] Prove via tests that tool effects from `vault_search`, `vault_read`, `vault_checkpoint`, and internal evaluation do not set substantial work.
- [ ] Run focused tests, typecheck, build, and no-any gate. Expected GREEN.
- [ ] Commit: `feat: evaluate pending vault writeback`.

---

## Task 14: Public-repository privacy gates and CI

**Files**

- Create: `tests/privacy/repository-hygiene.test.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.gitignore`

**Produces:** automated prevention of private-fixture leakage and a reproducible public CI gate.

- [ ] Write a failing hygiene test that scans tracked fixtures/docs/log snapshots for forbidden real-home prefixes, known personal-vault directory names, email/token patterns, real session-ID forms, absolute paths outside neutral fixtures, and accidental journal/receipt content. Maintain a minimal documented false-positive allowlist.
- [ ] Add a generated fixture manifest test that verifies all people/projects/remotes are synthetic and timestamps fixed.
- [ ] Run `npx vitest run tests/privacy/repository-hygiene.test.ts`. Expected RED until repository scripts/fixtures comply.
- [ ] Add `npm run check` = lint + typecheck + no-any + unit/integration/privacy tests + build + artifact-manifest check. Keep focused scripts separate for implementers.
- [ ] Add GitHub Actions on pull requests and `main`, Node 22, `npm ci`, `npm run check`. Add GitHub secret scanning guidance; do not add an external service requiring credentials in v1.
- [ ] Expand README with architecture, non-goals, privacy warning, status, and synthetic CLI examples. Explicitly state the vault is not versioned by this tool.
- [ ] Run hygiene test and focused/static gates. Expected GREEN.
- [ ] Commit: `ci: protect public vault fixtures`.

---

## Task 15: Synthetic canary, package install smoke, and final gate

**Files**

- Create: `tests/integration/canary.test.ts`
- Create: `tests/compat/prime-smoke.mjs`
- Create: `docs/runbook.md`
- Modify: `package.json`
- Modify: `README.md`

**Produces:** end-to-end synthetic proof, installable package, documented dry-run/read-only rollout, and release-ready v1 candidate without touching the real vault.

- [ ] Write a failing canary test that creates a synthetic vault, resolves Atlas from a synthetic Git remote, builds the root bootstrap, searches/reads, dry-runs an apply, applies daily+project, retries idempotently, simulates recovery, rolls back, and proves manual bytes are restored.
- [ ] Write a Prime compatibility smoke that installs/loads the built git-package extension in a temporary Prime agent directory, inspects registered tools for root/child sessions, and exercises bootstrap plus noop without provider network calls.
- [ ] Run `npx vitest run tests/integration/canary.test.ts && node tests/compat/prime-smoke.mjs`. Expected RED before harness completion, then GREEN.
- [ ] Add `docs/runbook.md` with exact sequence: `doctor`, synthetic smoke, real-vault read-only, checkpoint dry-run, temporary vault copy, one daily/project canary, manual diff, rollback, then automatic enablement. The runbook forbids enabling automatic writeback before every prior gate is recorded.
- [ ] Verify a generated artifact manifest contains only dist, public docs, README, and package metadata. No tests, source fixtures, local state, journal, receipts, or backups ship. Keep npm publication blocked by `private: true`; git-package installation is the v1 canary path until the user selects a license and release policy.
- [ ] Run the single final gate:

```bash
npm ci
npm run check
```

Expected: lint, typecheck, no-any, all tests, build, compatibility smoke, privacy scan, and artifact-manifest check PASS.

- [ ] Inspect `git diff --check`, `git status`, and the generated artifact manifest; record counts in the commit message body if non-obvious.
- [ ] Commit: `test: validate vault bridge canary`.

---

## Post-plan rollout (explicit human gate)

These are operational steps after all implementation tasks and review pass. They are not part of an implementer's automatic permission. Before npm publication, the user must also select a public open-source license; until then the package remains private-to-npm but installable from Git:

1. Install the package from the local checkout into a disposable Prime Agent home.
2. Run against a temporary copy of the Resyst Vault.
3. Configure the real vault in read-only/dry-run mode.
4. Review one bootstrap and one proposed daily/project diff.
5. Enable a single canary write and test rollback.
6. Review journal, receipt, Inbox conflict behavior, and manual-byte preservation.
7. Only then enable automatic root-turn evaluation in the normal Prime Agent home.
8. Hermes, OpenCode, and Claude Code adapters remain separate future work.
