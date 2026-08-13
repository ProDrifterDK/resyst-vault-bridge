# Resyst Vault Bridge

Portable, fail-closed context and writeback infrastructure between AI agents and
Obsidian vaults. The v1 core and Prime Agent adapter are implemented and are
being validated with synthetic fixtures; production rollout remains disabled.

> [!WARNING]
> This repository is public. Never copy real notes, vault paths, usernames,
> hostnames, credentials, session records, journals, receipts, backups, or
> screenshots here. Use only the Casey/Atlas synthetic fixture vocabulary and
> neutral `/home/tester` or temporary roots.

## Architecture

- **Shared core:** strict TypeScript schemas, deterministic project resolution,
  bounded snapshot/search/read services, and pure checkpoint planning.
- **Safe mutation:** local locks, precondition hashes, backups, immutable
  journals and receipts, durable recovery, idempotent replay, and rollback.
- **Thin adapters:** Prime Agent loads bounded provenance-bearing context and
  exposes universal read tools; only an authoritative root gets checkpoint
  authority. Other agent adapters remain future work.
- **Split control plane:** portable layout plus immutable journal and receipt
  records live under the vault's `.resyst/` tree. Host identity, locks, caches,
  pending state, and backups remain machine-local outside the vault.

The approved architecture and implementation plan are in
[`docs/superpowers/specs/2026-08-11-resyst-vault-bridge-design.md`](docs/superpowers/specs/2026-08-11-resyst-vault-bridge-design.md)
and
[`docs/superpowers/plans/2026-08-11-resyst-vault-bridge-v1.md`](docs/superpowers/plans/2026-08-11-resyst-vault-bridge-v1.md).

## Status

Implemented: configuration and containment, bounded snapshots, bootstrap,
resolution, read/search, rendering, transactional apply/recovery/rollback, the
JSON CLI, Prime bootstrap/read/checkpoint integration, and automatic
missing-checkpoint evaluation, CI, and public-repository privacy gates. The
final synthetic canary and compatibility smoke remain release gates.

The package stays `private: true` until a license and release policy are chosen.
Git installation is the current canary path; this is not an npm release.

## Install from Git for synthetic testing

```bash
npm install 'git+https://github.com/ProDrifterDK/resyst-vault-bridge.git'
```

Prime Agent discovers the tracked TypeScript extension entry. See
[`docs/prime-agent.md`](docs/prime-agent.md) for adapter setup.

## Synthetic CLI examples

Configure only a disposable Casey/Atlas vault rooted under `/home/tester` or a
temporary directory, then keep early operations read-only or dry-run:

```bash
resyst-vault doctor --no-color
printf '%s\n' '{"query":"Atlas","limit":5}' \
  | resyst-vault search --no-color
resyst-vault status --no-color
```

Commands emit bounded one-line JSON or JSON Lines. Diagnostics are redacted.
Use `resyst-vault --help` for the exact grammar.

## Non-goals

- The bridge does **not** version the Obsidian vault and never runs Git inside
  it. Safety comes from hashes, locks, backups, journals, receipts, and
  deterministic recovery.
- It is not a distributed lock service and does not make Syncthing atomic.
  Conflicts defer to the configured Inbox rather than guessing.
- It does not bulk-load the vault, treat note content as trusted instructions,
  transmit telemetry, publish an npm package, or enable production writeback.
- Hermes, OpenCode, and Claude Code adapters are outside v1.

## Privacy and security

All tests and examples use synthetic people, projects, remotes, timestamps, and
filesystem roots. `npm run test:privacy` scans tracked public material for
private home paths, credentials, real session-ID forms, private-derived hashes,
and accidental durable artifacts. CI also runs the build and artifact-manifest
gate. Keep GitHub secret scanning and push protection enabled; no external
credentialed scanning service is required.

The vault itself is never versioned by this tool. Runtime note content and
metadata remain local, and failures collapse to fixed redacted outputs. See
[`docs/security.md`](docs/security.md) for the threat model.

## Development

```bash
npm ci
npm run test:unit
npm run test:privacy
npm run check
```

`npm run check` runs strict type checking, lint, the explicit-`any` gate, all
unit/integration/privacy tests, the production build, and the artifact manifest
check.

## License

To be selected before any public package release.
