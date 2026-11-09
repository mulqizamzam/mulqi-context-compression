---
name: mulqi-context-compression
description: "Use when a long agent session's context has grown heavy with consumed tool output, before re-reading a file or re-running a command that may already have been summarized, or when the user asks to compress or shrink session context. Model-driven incremental compression (the fold): between task steps, digest consumed, no-longer-needed ranges into small restorable summary blocks via mulqi_cc_compress, recall details with mulqi_cc_search, restore originals with mulqi_cc_decompress, and inspect state with mulqi_cc_status. Protects task intent, the last user request, the recent working zone, and compression results. Not for audit or verbatim-history workloads where original wording must stay visible, and not a substitute for deciding what the task still needs."
---

# Mulqi Context Compression — the fold

## Core principle

Compress if and only if the content is **no longer needed by the current task step** — not "old", not "large".
Compression is a query about the *task*, not about the *text*. Everything else follows from that:
timing, target selection, summary craft, and restoration.

Each compression is **incremental**: it folds only the range accumulated since the last compression,
replaces it with one compact summary block, and the block stays restorable for the life of the session.
The recent working zone and the task's opening and latest user messages never fold.

## Quick reference

| Tool | When | Input | Returns |
|---|---|---|---|
| `mulqi_cc_status` | Between task steps, or when context feels heavy | optional `truncateTo` (rare hard cap) | composition breakdown, compressible ranges with real sizes, block list, and — when the growth gate fires — a nudge with recommendations |
| `mulqi_cc_compress` | After you finish consuming a range | `fromRef`, `toRef`, `topic`, `summary` (you write it), optional `tier`/`sourceBlockIds` | block id, compression ratio, tokens saved |
| `mulqi_cc_search` | Before re-reading a file or re-running a command | `query`, optional `limit` | keyword hits across active block summaries + recent messages |
| `mulqi_cc_decompress` | When a folded detail is needed again | `blockId` (`"list"` to enumerate), optional `fromRef`/`toRef` sub-range, optional `toFile: true` | restored text, or a file path (keeps context lean) |

## Timing — the growth gate

- Compress **between task steps**, never mid-step (mid-debugging, mid-refactor, mid-investigation).
- The status tool fires a nudge when the context has grown past the gate floor since the last
  compression. Treat it as an *efficiency nudge* ("keep context lean"), not an overflow alarm.
- You may **refuse** a nudge at a critical juncture and compress later; refusal is a quality valve,
  not a failure. A refusal is valid only with a concrete reason ("mid-debug; need these logs until
  the fix is verified").
- The nudge list shows candidate ranges with real sizes — pick the structurally sensible ones
  (tool-output-heavy runs, settled phases), not scattered small slivers.

## Protected zones (engine-enforced — the engine rejects a range that touches these)

| Zone | Why |
|---|---|
| First user message | Task intent — the north star of every later judgment |
| Last user message | The current request |
| Recent zone (last ~5 messages / ~5K tokens) | The active working set |
| Compression tool results (`mulqi_cc_*`) | They carry the summaries; folding them orphans the blocks |

## Summary craft

A good tier-1 summary is task-relative ("TASK AS OF THIS BLOCK"), under ~2K tokens, and:

**KEEP verbatim:**
- File paths with line numbers, and load-bearing code/signature lines
- Exact error strings and the one-line explanation of their cause
- Decisions **with rationale** ("use pnpm instead of npm because …")
- Exact values that matter later: ports, ids, versions, flags, thresholds
- Goal evolution and open questions
- Message refs (mNNNNN) for content you expect to restore later

**DROP:**
- Verbose logs **once the extracted result is recorded** (keep the verdict, not the scrollback)
- Duplicate reads of the same file/command output
- Dead-end explorations **with their lesson preserved in one line**
- The journey to the conclusion — keep the conclusion

**Priority order on a tight budget:** goal > decisions + rationale > artifacts > conclusions > lessons.

## One excellent example

Mid-refactor, you just finished verifying the migration: 14 tool results of `pnpm test` runs,
diff dumps, and file reads — the task step is settled, the verdict is "all 412 pass, 3 flakes
retried and green, migration commit 7f3a1c2 pushed".

```
mulqi_cc_status            → nudge fired; range m00041–m00112 · ~31K tokens · 72 messages · 41 tool results
mulqi_cc_compress {
  fromRef: "m00041", toRef: "m00112",
  topic: "migration verification",
  summary: "TASK AS OF THIS BLOCK: migration verified. 412 tests pass (3 flakes retried green,
  see m00088). Commit 7f3a1c2 pushed to main. Flake cause: CI-only sqlite lock timeout
  (m00097, keep ref). Next: backfill script (open question, user request m00115)."
}
```

The verdict, the refs, and the open question survive; the 31K of scrollback becomes ~90 tokens,
and the whole range stays restorable via `mulqi_cc_decompress { blockId }`.

## Tiering (when to distill blocks into tier 2)

When several older tier-1 blocks belong to one finished phase and their summaries themselves are
crowding the context, distill: call `mulqi_cc_compress` with `tier: 2` and `sourceBlockIds`
listing the blocks, and write one coarser summary of the phase. The consumed blocks keep their
lineage (restorable in bulk later). Distill rarely — a tier-2 pass is a phase boundary, not a
routine step.

## Restoration

Before re-reading a file, re-running a command, or asking the user again: `mulqi_cc_search` with
the exact identifiers (file name, error string, flag). If a hit points at a block, restore it —
`toFile: true` when the payload is large (the path comes back instead of the text; read the file
with your normal read tool), plain restore for a few lines. Restoring re-activates the original
messages; the block steps aside.

## Anti-patterns

- **Mid-step compression.** Folding logs you are still debugging → quality loss that no summary
  can fully repay. Compress the step *after* it settles.
- **The one giant blob.** Compressing the whole history in one call. The fold is many small,
  task-relative blocks; one blob is the old lossy compaction this skill exists to replace.
- **Anchoring on numbers.** The tools never disclose window fill ratios, and you should not ask
  the user to either — judge by task need, not by a percentage you cannot calibrate.
- **Paraphrase-only summaries.** If a value was exact (a port, an id, a flag), keep it exact.
  Paraphrase is an exception for prose, never for artifacts.
- **Restoring from memory.** If the detail is folded, re-fetching it from the engine beats
  re-deriving it from scratch — search first, always.

## Common mistakes

| Mistake | Correction |
|---|---|
| `fromRef`/`toRef` guessed instead of taken from `mulqi_cc_status` ranges | Ranges carry real refs and sizes — copy them |
| Summary over the ~2K cap | Split the range or condense; the engine rejects over-cap summaries |
| Range touches the recent zone and gets rejected | End the range before the recent zone starts (status shows it) |
| `tier: 2` without `sourceBlockIds` | List the block ids from the status block list |
| Expecting auto-compression | Nothing fires by itself: the doctrine (this skill) + your compress calls are the mechanism |
