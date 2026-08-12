# Resyst Vault Bridge

Portable, safe context and writeback bridge between AI agents and Obsidian vaults.

> [!IMPORTANT]
> This project is in the design phase. No vault integration is implemented yet.

The approved architecture is documented in
[`docs/superpowers/specs/2026-08-11-resyst-vault-bridge-design.md`](docs/superpowers/specs/2026-08-11-resyst-vault-bridge-design.md).

## Planned first release

- Agent-independent JSON CLI and shared core
- Compact, provenance-aware context bootstrap
- Deterministic project resolution
- Read/search tools
- Transactional, idempotent Obsidian writeback
- Immutable journals, receipts, backups, recovery, and rollback
- Prime Agent adapter
- Strict TypeScript with explicit `any` prohibited

## Privacy

The repository is public, but real vault content is not. Tests and documentation
must use synthetic fixtures only.

## License

To be selected before the first implementation release.
