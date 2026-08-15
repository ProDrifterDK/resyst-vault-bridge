# Pi integration

The Resyst Vault Bridge runs in Pi through the same Git package and shared core
used by Prime Agent. Every Pi session receives bounded `vault_search` and
`vault_read` tools. Automatic bootstrap and `vault_checkpoint` remain disabled
unless the operator explicitly opts in on that machine.

## Install

Pin a reviewed commit during rollout:

```bash
pi install git:github.com/ProDrifterDK/resyst-vault-bridge@COMMIT
```

Reload or restart Pi after installation.

## Enable standalone Pi root authority

Set the machine-local flag in
`${XDG_CONFIG_HOME:-~/.config}/resyst-vault/config.json`:

```json
{
  "version": 1,
  "host_id": "casey",
  "vault_path": "/home/tester/Notes",
  "project_overrides": [],
  "pi_root_authority": true
}
```

The flag is sampled at `session_start`; changing it requires reloading Pi or a
new session. It cannot be enabled from `<vault>/.resyst/agent-vault.yaml`.

## Authority behavior

- A standalone opted-in Pi session receives the ephemeral bounded bootstrap and
  activates `vault_checkpoint` after checkpoint state is persisted.
- `PI_SUBAGENT_CHILD=1` or a positive safe-integer `PI_SUBAGENT_DEPTH` marks a
  child and removes authority, even if another host header looks root-like.
- Malformed or contradictory marker values fail closed.
- Once child markers revoke a session, removing them does not restore authority;
  a normal reload or new session lifecycle is required.
- `PI_SUBAGENT_PARENT_SESSION` is ignored because pi-subagents sets it in both
  parent and child processes.
- Pi checkpoints record `source.agent: "pi"`; Prime checkpoints retain
  `source.agent: "prime-agent"`.

The child restriction applies to this bridge interface. It is not a filesystem
sandbox: a local process with independent shell or file-write authority remains
inside the documented single-user host trust model.

## Safe validation

Before enabling the flag against a real vault:

1. Run the synthetic test and compatibility gates from `docs/runbook.md`.
2. Confirm an unopted Pi session exposes only `vault_search` and `vault_read`.
3. Enable the flag against a disposable synthetic vault and confirm the root
   gets `vault_checkpoint` plus one framed bootstrap.
4. Spawn foreground and background pi-subagents and confirm they remain
   read-only.
5. Continue with read-only and dry-run rollout gates. Do not treat installation
   or opt-in as approval for production writeback.
