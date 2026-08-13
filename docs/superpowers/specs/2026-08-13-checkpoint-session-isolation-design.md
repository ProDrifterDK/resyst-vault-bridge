# Checkpoint Session Isolation Design

**Date:** 2026-08-13

## Problem

The default Prime Agent extension exports one factory created by `createVaultExtension()`. The factory currently closes over mutable checkpoint lifecycle state before it is applied to an `ExtensionAPI`. Prime Agent can invoke that same factory for a root session and an RLM child in one worker. The child's non-root `session_start` then clears the shared `activeRoot`, while the root still advertises `vault_checkpoint`. Root checkpoint calls consequently fail closed as `vault checkpoint unavailable`.

The checkpoint payload schema, production planner, transaction journal, lock, recovery state, and vault configuration are healthy. The fault is isolated to extension-instance state ownership.

## Design

Each invocation of the returned extension factory owns an independent checkpoint runtime:

- production read service and lazy checkpoint service references;
- pending-state store reference;
- effect tracker;
- checkpoint registration and tool reference;
- active root authority;
- evaluation admission state and lifecycle epoch;
- bootstrap loop cache.

`createVaultExtension(options)` remains the public configuration boundary. Calling its returned factory with an `ExtensionAPI` creates the runtime state inside that invocation. Injected services and stores remain injectable for tests, while their mutable extension lifecycle references are no longer shared between APIs.

No checkpoint schema, root-authority rule, fail-closed result, planner, renderer, or transaction behavior changes.

## Data Flow

1. Prime loads the exported extension factory.
2. Prime applies it independently to a root API and any child API.
3. Each application registers its own handlers backed by its own lifecycle state.
4. A child `session_start` can disable checkpoint only for the child API.
5. The root retains its authority, effect tracking, and checkpoint execution context.

## Error Handling

Existing fail-closed behavior remains intact: malformed authority, unavailable local state, invalid payloads, or transaction failures still return the fixed unavailable receipt. Isolation prevents unrelated sessions from manufacturing that state loss.

## Regression Test

At the public extension-factory seam, apply one configured factory to separate root and child harness APIs, then:

1. start the authoritative root and verify checkpoint registration;
2. start the non-root child and verify checkpoint is absent there;
3. emit a root effect after the child starts and verify the root records it;
4. execute the root checkpoint and verify the checkpoint service runs successfully.

The test must fail against the shared-closure implementation and pass after per-API state isolation.
