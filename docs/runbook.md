# Synthetic canary and rollout runbook

This runbook is a **manual safety gate**, not permission to enable production
writeback. Keep npm publication blocked and never run Git inside an Obsidian
vault.

## Preconditions

Record the bridge commit, Node and Prime Agent versions, completed gate counts,
and the generated artifact manifest and hash. Stop if any value cannot be
recorded or if any prior gate is not green.

## Required sequence

1. Run `resyst-vault doctor --no-color` without cleanup flags. Stop on pending
   recovery, a live or unverifiable lock owner, root identity drift, unreadable
   paths, or symlink containment failure.
2. Run `npm run build`, `npx vitest run tests/integration/canary.test.ts`, and
   `npm run test:compat`. The compatibility bootstrap fetches immutable Prime
   commit `83a0f9f9566219551fcb6ffaf7f519a815749a58` plus its locked npm
   dependencies into `node_modules/.cache`; verify the commit before proceeding.
   The subsequent Git-package install and extension exercise are offline. All
   runtime probes operate only on generated temporary Casey/Atlas vaults and
   must not contact a model provider.
3. Against the real vault, run only `doctor`, `status`, `search`, and `read`.
   Do not enable checkpoints or automatic evaluation.
4. Prepare one bounded checkpoint request and run `resyst-vault checkpoint
   --dry-run --no-color`. Record target paths and before/after hashes. Confirm
   that the vault bytes, journal, receipts, backups, and machine-local pending
   state did not change.
5. Make an offline temporary copy of the vault that preserves modes and
   symlinks. Keep the copy outside the repository and do not initialize Git in
   it. Re-run `doctor` and the read-only checks against the copy.
6. On the copy only, apply one Casey/Atlas daily-plus-project canary with
   `resyst-vault checkpoint --apply --no-color`. Confirm the event and receipt
   contain exactly the reviewed targets and hashes.
7. Manually diff the complete files and managed fragments. Stop on unexpected
   targets, missing manual bytes, malformed framing, excessive content, private
   data in diagnostics, conflicts, or any hash/path/identity drift.
8. Retry the identical checkpoint and require an idempotent already-applied
   outcome with byte-identical files and no duplicate durable records.
9. Roll back the canary with `resyst-vault rollback EVENT_ID --no-color`. Require
   both files to equal their pre-canary bytes and retain the linked rollback
   journal and receipt.
10. Re-run `npm ci` and `npm run check`. Review `git diff --check`, repository
    status, and the artifact manifest. Automatic writeback remains forbidden
    until a human explicitly approves it after every preceding record is
    reviewed.

## Hard stops

Stop without cleanup or retries that overwrite evidence when any check reports
path, root identity, inode, symlink, hash, or lock drift; pending or failed
recovery; an unexpected target or diff; a conflict; a redaction leak; a provider
request; a failed test/build/artifact gate; or any access outside the selected
vault copy. Preserve evidence and diagnose offline.

## Release boundary

The package remains `private: true`. Do not publish to npm until the user selects
and approves a license and release policy. The only v1 installation canary is the offline Git-package exercise against the pinned Prime Agent v0.7.2 host capability. Legacy npm SDK 0.84.1 is only a read-only fail-closed probe, not a root-authority claim. This runbook does not authorize a
real-vault apply, deployment, automatic evaluation, or production rollout.
