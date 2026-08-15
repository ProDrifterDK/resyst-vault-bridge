# Pi authority adapter design

## Status

Approved for implementation on 2026-08-14.

## Goal

Give explicitly opted-in, standalone Pi sessions the same ephemeral bootstrap
and checkpoint capability that authoritative Prime Agent roots receive, while
keeping Pi subagents read-only and preserving the bridge's fail-closed trust
model.

## Non-goals

- Forking the bridge into a separate Pi package or repository.
- Changing the shared snapshot, search, checkpoint, transaction, recovery, or
  rollback implementations.
- Granting write authority to Pi subagents.
- Treating session names, working-directory conventions, or model arguments as
  authority.
- Enabling production writeback merely by shipping this adapter.

## Chosen approach

The existing package gains one host-authority seam with two adapters:

- **Prime Agent:** the persisted safe-integer `SessionHeader.rlmDepth` remains
  authoritative. Depth zero is root; positive depth is child; malformed or
  missing depth remains read-only unless the Pi adapter is explicitly enabled.
- **Pi:** root authority requires the machine-local boolean
  `pi_root_authority: true`. Without that exact opt-in, Pi remains read-only.
  A positively identified Pi subagent remains read-only even when the flag is
  enabled.

The shared extension behavior consumes the resulting authority decision rather
than interpreting one host's metadata directly.

## Configuration

The machine-local file
`${XDG_CONFIG_HOME:-~/.config}/resyst-vault/config.json` accepts one optional
field:

```json
{
  "version": 1,
  "host_id": "casey",
  "vault_path": "/home/tester/Notes",
  "project_overrides": [],
  "pi_root_authority": true
}
```

Rules:

- The field is optional and defaults to `false`.
- Only the literal boolean `true` enables the Pi root adapter.
- The portable vault configuration cannot enable Pi authority.
- Malformed values are rejected by the existing strict local-config schema.
- Loading this opt-in reads only machine-local configuration; it does not read
  vault notes or mutate state.

## Authority resolution

Authority resolution returns one of three semantic results:

- `root`: bootstrap and checkpoint authority.
- `child`: on-demand read/search only.
- `unavailable`: fail-closed read/search only.

Resolution order:

1. Read Pi's process markers conservatively. Child markers are subtractive and
   override every host header:
   - `PI_SUBAGENT_CHILD=1` with missing or positive safe-integer depth is
     `child`.
   - A positive safe-integer `PI_SUBAGENT_DEPTH` is `child` even when the child
     marker is missing.
   - Missing `PI_SUBAGENT_CHILD` with missing or exactly zero
     `PI_SUBAGENT_DEPTH` is a root candidate.
   - Unknown values, negative/unsafe/non-integer depth, or contradictory marker
     combinations are `unavailable`.
2. Read and validate the persisted session header ID.
3. For a remaining root candidate, if `rlmDepth` is a safe non-negative
   integer, use the Prime adapter: zero is `root`; positive is `child`.
4. Otherwise, consider the Pi adapter only when `pi_root_authority` is true.
5. A Pi root candidate becomes `root` only with the existing valid session ID
   and absolute bounded `cwd`; otherwise it is `unavailable`.

The opt-in is sampled once at `session_start`; changing it requires a reload or
new session. Process markers are rechecked before bootstrap and checkpoint use,
but can only revoke an existing grant, never create one mid-session.

`PI_SUBAGENT_PARENT_SESSION` is not an authority signal because pi-subagents
sets it in both the parent and child processes.

## Extension behavior

All hosts register `vault_search` and `vault_read` synchronously without vault
I/O.

At `session_start`, the extension resolves host authority once for that session:

- A root initializes the existing machine-local checkpoint state, activates
  `vault_checkpoint`, and permits ephemeral bootstrap injection.
- A child or unavailable session removes/deactivates `vault_checkpoint` and
  suppresses automatic bootstrap.
- Lifecycle changes clear the cached authority alongside the existing bootstrap
  and checkpoint state.

Before bootstrap injection or checkpoint execution, the extension revalidates
that the current session ID and `cwd` still match the active root. Environment
markers that become less trusted during the process lifetime revoke authority;
they never grant authority after session start without a normal reload or new
session lifecycle.

Checkpoint provenance records the resolved adapter as `source.agent`:
`prime-agent` for Prime Agent and `pi` for Pi. The version-1 schema accepts both
literals; legacy callers that omit the trusted adapter continue to default to
`prime-agent`.

## Security and failure behavior

- Authority remains machine-local and explicit.
- Vault content cannot grant authority.
- Child markers can only remove authority.
- Missing, malformed, hostile, or contradictory host values fail closed.
- A local user able to modify process environment or machine-local config is
  already inside the bridge's documented single-user host trust model.
- Existing path containment, precondition hashes, lock, journal, receipt,
  recovery, rollback, and redaction behavior remains unchanged.
- The adapter does not convert the local lock into a distributed lock or
  authorize concurrent multi-machine writeback.

## Test seams

Tests exercise behavior through these agreed seams:

1. **Local configuration:** omitted/false/true `pi_root_authority`, malformed
   values, and portable-config rejection.
2. **Host authority:** subtractive Pi child-marker precedence; Prime root/child;
   opted-in Pi root; Pi child; malformed, contradictory, and unopted Pi states.
3. **Extension integration:** an actual Pi 0.84.2-compatible root exposes and
   activates `vault_checkpoint` and injects one bounded bootstrap; a marked
   child exposes only `vault_read` and `vault_search` and receives no bootstrap;
   a mid-session child marker revokes but removing one never grants authority.
4. **Checkpoint provenance:** Pi writes `source.agent: "pi"`; existing
   Prime/default callers write `source.agent: "prime-agent"`.
5. **Regression:** existing Prime Agent root/child compatibility, checkpoint
   state persistence, privacy gates, synthetic canary, and full test suite.

Implementation follows vertical red-green slices: config opt-in, pure authority
resolution, then extension integration.

## Rollout

The Git package remains pinned and unreleased. After implementation, run the
full repository gate and the existing manual runbook. Installing the adapter in
Pi does not by itself authorize production writeback; the operator must set the
machine-local opt-in and separately complete the documented rollout gates.
