# Security model

The Resyst Vault Bridge is a fail-closed, single-host, single-user
mediator between an AI agent and an Obsidian vault. Every value entering
the bridge is treated as untrusted `unknown` and narrowed through a
versioned schema at a single validation boundary. Every executable path
is bounded, every backup is journaled, and every write is recoverable.

## Threat model

The bridge defends against:

- **Malformed or hostile payloads.** Any external JSON, YAML, or frontmatter
  is narrowed through TypeBox schemas. Throwing getters, prototype
  pollution, cycles, and adversarial depths are detected at the
  validation boundary and rejected with a fixed redacted message.
- **Injection through untrusted Markdown.** Automatic bootstrap context and
  search snippets quote and visibly delimit note content as untrusted data.
  Explicit `read` returns the requested note/section as data in `read.content`;
  adapters must not promote it to instructions. The bridge never executes
  directives from note content.
- **Path traversal and symlink escape.** Vault paths are validated
  lexically (relative, normalized, no dot segments, no reserved segments)
  and then realpath-checked against the config-trusted vault root. Writes
  additionally reject any symlinked target.
- **Concurrent overwrite.** Every apply takes a single-host lock
  (`~/.local/state/resyst-vault/locks/write.lock`) under which the
  preimage is backed up, the file is prepared in a temp file, the parent
  directory is fsynced, then the rename is published. The progress
  record is fsynced after the rename.
- **Partial transactions.** A crash between durable bytes and the receipt
  is recovered by replaying the journaled progress. The next apply of
  the same idempotency key observes the recorded after-hash and finishes
  the transaction without creating a contradictory failed receipt.
- **Vault substitution.** The vault path is read once from
  `${XDG_CONFIG_HOME}/resyst-vault/config.json` and pinned to its realpath
  plus bigint dev/ino. The path layer re-establishes that identity on every
  resolve and rejects a retargeted symlink, renamed-away root, or
  same-pathname replacement.
- **Secret-shaped keys.** Configuration files are scanned for keys that
  could carry credentials, tokens, passwords, authorization fields, or
  executable hooks. Any match is a hard rejection with a fixed redacted
  message.
- **Host authority confusion.** Prime Agent uses persisted `rlmDepth`; Pi uses
  an explicit machine-local opt-in. Exact Pi child/depth markers are parsed
  with a strict grammar before either host adapter, so a positive child signal
  can only remove authority. Malformed or contradictory markers fail closed,
  and mid-session marker revocation is permanent until a normal lifecycle
  restart.

The bridge does not defend against:

- A compromised host account that can read or modify the vault directly.
  The bridge is a single-host, single-user mediator; it does not introduce
  a security boundary against a hostile local user.
- Network attackers. The bridge never listens, never makes a network
  request, and never accepts a network connection.
- An attacker that can substitute the durable state files under
  `~/.local/state/resyst-vault/`. Those files are protected by the
  filesystem permissions of the host account, not by an additional
  cryptographic layer.
- A child process that has an independent shell or filesystem-write capability.
  Root/child authority constrains the bridge interface; it is not a local-user
  sandbox.

## Privacy boundary

The bridge is a private consumer of the vault. It does not implement a
public protocol. There is no version negotiation, no extension points, and
no network-facing surface. The CLI is a future-adapter seam; it never
echoes any payload value on stderr, and it never includes the trusted
vault identity (a bigint dev/ino) in any JSON response.

Output fields that may contain user note body content:

- `bootstrap.context` — the bounded root-turn context fragment.
- `read.content` — the quoted note content (or one heading section).
- `search.hits[*].snippet` — the quoted matching snippet.

These three are the only fields that carry note body content. No other
field contains note body content. The CLI does not echo the search
query string in the response envelope; only the matched hit metadata
(path, heading, snippet, score) is returned.

Output fields that carry requested machine metadata for the operation:

- Path fields (`path`, `note_path`, `conflict_paths`, `proposal_path`,
  `rollback_targets[*].path`, etc.).
- Title and heading fields.
- Timestamps (`modified_at`, `created_at`).
- Identifier fields (`event_id`, `idempotency_key`, `target_event_id`,
  `pending_event_ids`, etc.).
- Counts and ordered id lists for status/recovery reports.

These fields are part of the requested operation's response; they are
machine metadata, not user content, and they may appear in stdout.
They are never echoed on stderr.

Diagnostics on stderr are closed fixed strings; the bridge never prints
the offending path, the offending JSON, the offending search query,
the rejected value, or any error message that concatenates caller
data. Diagnostics map known error types and codes (`ConfigError`,
`VaultReadError`, `JournalIntegrityError`, `TransactionIntegrityError`)
to fixed redacted strings; an unknown error maps to the fixed string
`unavailable: service failed`. The state root is always absolute, so
the CLI never writes under the current working directory.

## Recovery

A crashed apply is a recoverable state. The journal (under
`<vault>/.resyst/journal/<YYYY-MM>/<event-id>.json`) records the
immutable event and its planned targets. The progress file (under
`~/.local/state/resyst-vault/backups/<event-id>/progress-<path>.json`)
records the durable frontier after each rename. The next run of `recover`
replays the pending events and finishes each at the recorded frontier.

Recovery is bounded by the lock owner; if the lock is held by a live
process, the recover call waits up to the lock timeout. The recovery
batch is idempotent; replays after successful recovery return
`outcome: "nothing_pending"`.

The built-in local lock is a single-host lock. It does not coordinate
between machines. See "Distributed deployments" below.

## Rollback

A rolled-back event is replayed deterministically. The rollback service
verifies every target's current hash against the recorded after-hash
before any mutation, restores each from the journaled backup, then writes
a linked `rolled_back` receipt. A later user edit (a hash that is neither
the recorded before nor the recorded after) is rejected with a
`precondition_mismatch` outcome and exit code 6.

The rollback event id is derived from the SHA-256 of
`rollback:<target_event_id>`. The rollback idempotency key is the same
digest. Two rollback calls for the same target event produce the same
rollback event id and the same idempotency key, so the second call is a
no-op.

## Syncthing and similar sync tools

The bridge recognises Syncthing conflict copies (`*.sync-conflict-*`) and
excludes them from search and read paths. The conflict copies are not
modified by any bridge operation. The `doctor` command reports every
existing conflict so the operator can review them.

The bridge makes no claim about the safety of running it concurrently
with another bridge process on a different machine. The local lock is a
single-host lock. A multi-machine deployment must synchronize writeback
through a coordination layer outside the bridge.

## Distributed locks: not provided

The bridge does not implement a distributed lock. The local lock is a
PID + process-start identity record under
`~/.local/state/resyst-vault/locks/write.lock`. It is the only writer
gate.

For a multi-machine deployment, configure your coordination layer
(Syncthing's pause-before-receive, a manual runbook, or an external
orchestrator) to ensure only one machine writes at a time. The local
lock guarantees mutual exclusion on one host; it does not extend to
multiple hosts.

## Exit codes

The CLI uses stable symbolic exit codes:

| Code | Meaning |
| ---- | ------- |
| 0    | Success, no-op, or already applied |
| 2    | Invalid request or invalid configuration |
| 3    | Vault unavailable |
| 4    | Deferred conflict |
| 5    | Recovery required or invalid state |
| 6    | Rollback precondition failed |
| 130  | SIGINT; no partial stdout was emitted |

The JSON envelope always includes an `outcome` field so adapters do not
depend solely on the exit code.

## Stable JSON line protocol

The CLI reads stdin as UTF-8 JSON Lines (a single JSON value is a one-line
JSONL stream) and validates the complete framed input before any service effect. The
exact framing per command is:

- `doctor`, `status`, `recover`, `rollback`, `help` are bodyless. They
  reject any nonempty piped body. When stdin is an interactive TTY
  with no piped body, the CLI does not wait on stdin.
- `search`, `read`, `bootstrap` accept 1..128 JSONL requests on stdin
  and emit exactly one JSON response per request, in order. Each
  request is one JSON value per line, bounded to 128 nonblank lines
  total across the stream.
- `checkpoint` requires exactly ONE JSON request on stdin. Any other
  count is `invalid_request` (exit 2).
- The stdin reader is bounded: at most 8 MiB total bytes, at most 128
  nonblank lines, parsed JSON iteratively bounded to depth 64 and
  10000 nodes, and each string bounded to one million characters.
  Unknown JSON keys are rejected at the TypeBox schema boundary
  (`additionalProperties: false`).

Each response line carries:

- `version` — the protocol version (always 1).
- `command` — the request command (`doctor`, `status`, `search`, `read`,
  `bootstrap`, `checkpoint`, `recover`, `rollback`, `help`).
- `outcome` — the symbolic outcome (`ok`, `dry_run`, `applied`,
  `deferred`, `rolled_back`, `nothing_pending`, `recovery_required`,
  `invalid_request`, `invalid_config`, `unavailable`, `invalid_state`,
  `precondition_mismatch`, `not_applied`, `failed`).
- Command-specific fields (see `help` output).

The CLI never emits ANSI codes, never prompts interactively, and never
emits a trailing partial line. SIGINT during a read of stdin (before any
stdout) results in exit 130 with no stdout output. Normal completion
sets the exit code via `process.exitCode`; only the SIGINT handler calls
`process.exit(EXIT_SIGINT)`. Importing the CLI module does NOT install
a SIGINT handler, read stdin, or exit the process; the handler is
gated to the executable entry.
