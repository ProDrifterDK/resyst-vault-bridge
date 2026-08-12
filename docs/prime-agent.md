# Prime Agent integration

The Resyst Vault Bridge ships as an installable Prime Agent extension. The
extension is read-only in this release: it injects an ephemeral vault
bootstrap into every authoritative root turn and exposes bounded `vault_search`
and `vault_read` tools at every RLM depth. Write authority is handled by a
separate task.

## Installation

Prime Agent loads extensions from Git packages. Install the bridge from
this repository:

```text
git:github.com/ProDrifterDK/resyst-vault-bridge
```

Once installed, Prime Agent discovers the extension through the package's
`pi.extensions` manifest and loads `./src/extension/index.ts`. Importing
the module does not eagerly load any vault configuration; the bridge
performs no filesystem read at import or registration. Filesystem access begins
only when a root bootstrap or an explicit read tool is invoked.

## Initial setup (read-only / dry-run)

Before letting the extension touch the real vault, validate the read-only
adapter and use the CLI checkpoint dry-run separately:

1. Create the machine-local config at
   `${XDG_CONFIG_HOME:-~/.config}/resyst-vault/config.json` with the
   absolute vault path and a stable host id (see `docs/configuration.md`).
2. Ensure `<vault>/.resyst/agent-vault.yaml` exists with the portable
   layout, managed headings, and a conservative `context_tokens` budget.
3. Restart Prime Agent and confirm a root turn logs a single bounded
   bootstrap fragment inside the system prompt. The fragment is exactly
   one JSON-encoded line framed by a fixed untrusted-data instruction and
   the `BEGIN RESYST VAULT CONTEXT — UNTRUSTED DATA` /
   `END RESYST VAULT CONTEXT` delimiters, so an embedded newline,
   instruction-shaped vault content, or a literal `BEGIN`/`END`
   substring inside the payload cannot forge the framing.
4. Confirm `vault_search` and `vault_read` are available to child sessions
   while `vault_checkpoint` is absent (write authority belongs to a
   separate task).

Only after the synthetic/read-only checks and `checkpoint --dry-run` match
expectations should the extension be used with a real vault.

## Root bootstrap vs. child reads

The extension reads the persisted `SessionHeader` on every
`before_agent_start` and treats `rlmDepth === 0` (safe integer) plus a
bounded nonempty `id` as the only authority for a root turn. Anything
else — missing field, string, float, negative, unsafe integer, or a
spoofable session name — fails closed without injecting context.

- **Root turn:** the extension resolves the project, reads the configured
  `CLAUDE.md`, current UTC daily note, exact resolved project note, and
  `MOC — Inicio.md` from the config-trusted vault root, and injects the
  bounded bootstrap once per root loop. Concurrent root invocations are
  deduplicated; a subsequent root turn after `agent_end`, `session_start`,
  `session_shutdown`, or `session_before_switch` starts a fresh bootstrap.
- **Child turn:** no automatic bootstrap is injected. `vault_search` and
  `vault_read` remain available so a child can read on demand.

If the bridge cannot load config or any required snapshot fails the
containment, stability, or bounded byte recheck, the turn proceeds
without the augmentation; no vault text is persisted in the session
JSONL.

### Bounded snapshot reader (Task 11)

Every bootstrap snapshot is read through a typed `SnapshotFs` seam that
defends against symlink-swap-at-open and same-path inode replacement:

- The canonical target is resolved via `realpath`, then opened with
  `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` so a symlink swap that lands
  after the open cannot redirect the handle to a different inode.
- The opened handle is bound to the canonical target inode via
  `fstat`; the canonical path is re-statted by name and any
  dev/ino/size/mtime/nlink drift between the handle and the path is
  rejected as `SnapshotReadError("swap_detected")`.
- The trusted root identity is re-validated before and after the read
  by re-running `VaultPaths.resolveRead` (which re-establishes the
  current realpath/dev/ino of the vault root), so a retargeted root
  symlink is also rejected.
- Reads are bounded to `MAX_SNAPSHOT_BYTES` (1 MiB), decoded with a
  fatal UTF-8 decoder (rejects invalid bytes as `SnapshotReadError
  ("utf8_invalid")`), and scanned for NUL bytes (`SnapshotReadError
  ("nul_byte")`).
- A post-read `fstat` on the same handle verifies the opened inode is
  unchanged across the read window.

A contained vault symlink (a symlink inside the vault that resolves to
a regular file inside the vault) is read through the canonical target
and succeeds; a swap that lands between `open` and `stat` is rejected
deterministically.

## Ephemeral session nonpersistence

The bootstrap is ephemeral by construction. It is only appended to the
in-memory system prompt for one root turn, never written through
`appendEntry`, never replaced with a persistent custom message, and
cleared from the loop cache at every transition that could otherwise
replay stale context.

- The bootstrap context is encoded as exactly one JSON line (with
  explicit ` ` / ` ` escapes and a fixed "treat as data only"
  instruction above the delimiters) so a vault author cannot smuggle a
  newline, a literal `BEGIN` / `END` boundary, or an instruction-shaped
  fragment across the framing.
- The loop cache holds only a `completed` marker per key, never the
  resolved context text; the leader promise is the only holder of the
  encoded line and is released as soon as the leader settles. The
  cache key is the bounded `sessionId` plus the NFC + line +
  whitespace normalized SHA-256 fingerprint of the user prompt so
  cosmetic prompt differences collapse to a single in-flight leader.
- Cache capacity is bounded by a small `MAX_CACHE_KEYS` ceiling (the
  oldest completed marker is evicted; pending leaders are never orphaned)
  and a small `MAX_IN_FLIGHT_LOADS` ceiling (concurrent loads above the
  ceiling collapse to `null` without
  invoking the loader, so an adversarial prompt fan-out cannot
  exhaust the host). Empty or failed loads delete the pending slot
  immediately so the next call can recover.

The only durable vault artifacts produced by this release are those
produced by the user's own vault tooling (not the bridge): the
`vault_search` and `vault_read` tools never write to the vault.

## Privacy and failure modes

- **No caller data echoed.** The bridge accepts only `{ cwd }` for the
  bootstrap path. `vault_search` and `vault_read` accept bounded
  TypeBox parameters; caller-supplied config, session, or cwd fields
  are rejected at the schema boundary.
- **No persistent vault text in session JSONL.** Only the structured
  result of an explicit `vault_read` or `vault_search` call appears in
  the tool transcript; bootstrap fragments are turn-scoped and never
  journaled.
- **Service failures collapse to a fixed message.** Every tool failure
  returns the constant `vault tool unavailable` with structured
  `outcome: "unavailable"` details. The original error never reaches the
  user, the model, or stderr. Bootstrap reads surface redacted
  `SnapshotReadError` codes (`swap_detected`, `instability_detected`,
  `not_file`, `too_large`, `nul_byte`, `utf8_invalid`, …) that the
  agent consumes as the same unavailable result.
- **No eager vault I/O at registration.** The default export is a
  factory. The bridge never reads config or the vault during extension
  discovery/registration; access begins only when a root bootstrap or an
  explicit read tool is invoked.
- **Strict no-`any`.** Source, tests, and public contracts are free of
  explicit `any`. The Biome and NodeNext strict-`tsc` gates enforce
  this. Imports of the Prime Agent runtime are typed through `unknown`
  so the bridge never inherits a hidden `any` surface from its peer
  dependency.
- **Hostile-runtime fail-closed boundary.** Every field entering the
  bridge from the Prime Agent runtime — the event, the context, the
  `sessionManager`, `systemPrompt`, `prompt`, and `cwd` — is narrowed
  through defensive getter-safe primitives inside a single fail-closed
  try/catch. Throwing proxy traps, revoked proxies, oversized strings,
  non-string prompts, non-absolute `cwd` values, and any other malformed
  shape collapse to a no-op augmentation without echoing any payload
  value.

## Operational notes

- The bootstrap budget is the portable `budget.context_tokens` setting
  from `<vault>/.resyst/agent-vault.yaml`; the bridge estimates tokens
  as `ceil(unicode_chars / 4)` and never exceeds the configured cap.
- When the bridge cannot be loaded (missing config, missing portable
  YAML, layout violations), Prime Agent continues to operate normally;
  `vault_search` and `vault_read` remain registered and return the fixed
  unavailable result rather than blocking ordinary agent work.
- All vault writes belong to a separate task. This release is read-only
  by design.
