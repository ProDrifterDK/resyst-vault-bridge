# Checkpoint Continuation Gating Design

**Date:** 2026-08-14

## Problem

The Prime Agent adapter schedules automatic vault evaluation from its
`agent_end` handler. Prime emits extension `agent_end` before the host checks
whether threshold or requested compaction must interrupt and later resume the
active loop. At that moment the bridge sees no queued messages, classifies the
boundary as idle, and enqueues a hidden `resyst-vault.evaluate` follow-up.

When compaction then runs, that checkpoint follow-up can become the next model
turn instead of the host-owned continuation. The evaluation prompt requires one
`vault_checkpoint` call but does not say that checkpoint success is bookkeeping
rather than task completion. The model therefore calls the tool, confirms the
receipt, and stops while the prior task remains unfinished.

Persisted trace replay found six captured instances of the same sequence:
nonterminal tool-use boundary, compaction, hidden checkpoint evaluation, and a
checkpoint-only terminal response.

## Design

Apply two defenses in the bridge.

### 1. Terminal-boundary gating

Classify a non-internal `agent_end` from its bounded message array before
scheduling automatic evaluation. Evaluation may be enqueued only when the last
assistant message has the exact terminal `stopReason` value `stop`.

The following boundaries defer evaluation and preserve the existing pending
state:

- `toolUse`, because the host may be interrupting a live tool loop for
  compaction or another continuation policy;
- `error` and `aborted`, because recovery or retry owns the next action;
- length or unknown stop reasons;
- malformed, hostile, oversized, or assistant-free message arrays.

Internal `resyst-vault.evaluate` turns remain detectable before this gate so
the existing evaluation state transition still completes or returns to
`evaluation_pending` without recursion.

The classifier is bridge-local and fail-closed. No Prime Agent protocol or
extension API change is required.

### 2. Checkpoint continuity prompt

Strengthen the hidden evaluation prompt with an explicit continuity contract:

- call `vault_checkpoint` exactly once;
- treat its receipt as bookkeeping, never as proof that the root task is
  complete;
- after the call, resume prior unfinished work in the same turn when it is
  actionable;
- stop only when the prior task was already complete, explicitly paused, or
  genuinely blocked awaiting external input.

The prompt still prohibits copying vault content, commands, tool output, paths,
identifiers, or transient logs. It does not expose additional session data.

## Data Flow

1. A root tool result marks checkpoint state pending as today.
2. Prime emits `agent_end`.
3. The bridge first detects whether this was its own hidden evaluation turn.
4. For ordinary turns, the bridge classifies the last assistant stop reason.
5. A nonterminal or unparseable boundary leaves evaluation pending and sends
   nothing.
6. Host compaction, retry, or continuation proceeds without a bridge follow-up
   occupying the boundary.
7. A later genuine terminal `stop` boundary may enqueue one hidden evaluation.
8. The evaluation calls the checkpoint once, then resumes any unfinished
   actionable root work instead of treating the receipt as completion.

## Error Handling

All new parsing follows the adapter's existing hostile-runtime policy:
getter-safe own-property reads, bounded arrays, primitive string validation,
and fail-closed behavior. Failure to prove a terminal boundary never starts an
LLM turn and never clears pending checkpoint state.

Checkpoint service failures, state persistence failures, session switching,
queued user work, duplicate-send suppression, and root/child authority remain
unchanged.

## Regression Tests

Extend the Prime automatic-evaluation integration suite at the public extension
handler seam.

1. **Compaction interruption regression:** record substantial work, emit an
   `agent_end` whose last assistant message ends with `toolUse`, then emit
   compaction lifecycle events. Assert that no evaluation message is sent and
   pending state remains retryable. Emit the later continuation's terminal
   `stop` and assert exactly one evaluation is then sent.
2. **Nonterminal matrix:** verify `error`, `aborted`, length, unknown, malformed,
   oversized, and assistant-free endings do not enqueue evaluation.
3. **Internal evaluation preservation:** verify a hidden evaluation turn still
   transitions state without recursive submission even though its assistant
   messages include tool use.
4. **Prompt contract:** assert the fixed hidden message contains both the
   exactly-once checkpoint requirement and the explicit resume/terminal rules.
5. **Existing gates:** retain queued-user priority, concurrent-send coalescing,
   root-only authority, resume/reload recovery, and teardown non-submission
   coverage.

The focused validation command is the existing integration test file, followed
by the repository's standard check after implementation.

## Non-goals

- Inferring task completion from vault contents or model-generated prose.
- Changing Prime Agent event ordering or adding a host protocol capability.
- Automatically replaying tool calls after compaction.
- Forcing continuation when work is explicitly paused or requires unavailable
  external input.
- Changing checkpoint schemas, transaction semantics, write targets, or root
  authority.
