# Auto fold engine: the fold without a model trigger

## What it is

The four `mulqi_cc_*` tools are model-triggered. This document covers the second
entry of the bundle, `mulqi-context-compression/compaction-engine`
(`MulqiFoldEngine`), which makes the fold run on its own: it plugs into the host's
automatic compaction, so the engine's triggers fire with **no model call at all**.

## How the host already auto-compacts

The DSH host registers a compaction service (`ctx.compaction`, one implementation
per context) and, with its default `auto: true` policy, listens to two events:

- `agent/pre-step`: before every model request, the token meter prices the session;
  past the pressure threshold the engine compacts the oldest compressible span.
- `agent/request-error`: on a provider-confirmed context-overflow failure the engine
  forces one useful balanced reduction and retries the request.

The default implementation (`@deepseek-ai/dsh-compaction-basic`) replaces the span
with one LLM-written checkpoint. This is a plain summary: it is not restorable, not
searchable, and not shared with other sessions.

## What the fold engine changes

`MulqiFoldEngine` subclasses the host's basic engine, keeping its trigger policy,
retention policy, compaction lock, shrink pricing, durable checkpoint framing, and
overflow-retry loop. It overrides the engine's sole customization hook,
`summarize()`, so that each automatic compaction also:

1. records the shadowed span as a **tier-1 digest block** in the process-wide fold
   registry (the same registry the four tools use);
2. appends a **marker line** to the checkpoint the model sees:

   `[mulqi-fold: blk00042 · auto digest · m00110..m00188 · restore the original span
   with mulqi_cc_decompress {"blockId":"blk00042"}]`

3. publishes the block into the shared mycelium store when publishing is enabled.

The model can then list auto blocks in `mulqi_cc_status`, recall their summaries in
`mulqi_cc_search`, and restore the original span with `mulqi_cc_decompress`
(exactly, or a sub-range, or to a host-readable file).

## Digest modes

| Mode | Env | Cost | Digest |
|---|---|---|---|
| `llm` (default) | (unset) | one host-routed LLM call per compaction, prefix-cache aligned | the host's cache-aware one-shot summarization (`summarizeWithLlm`) |
| `mechanical` | `MULQI_CC_AUTO_MODE=mechanical` | zero LLM traffic | a doctrine-shaped template digest (goal, directives, errors, artifacts, final state) bounded to the tier-1 cap |

Auto blocks use the `MULQI_CC_AUTO_MAX_TOKENS` cap (default 4096, floor 2048), which
is raised on the fold state when the engine is enabled; model-authored blocks keep
the documented ~2K default.

## Opt-in (profile patch layer)

The engine row ships `disabled: true` in this package's `cordis.patch.yml`. Because
the `compaction` service slot holds ONE implementation, activating the fold engine
means:

```yaml
# your profile's cordis.patch.yml (user layer, after the bundle layers)

- id: mulqi-cc-fold-engine
  disabled: false

- id: compaction-basic
  disabled: true
```

Restart the host so the new rows load. Verify in the host log:

- `compaction (step pressure): shadowed ...` lines, now produced by the fold engine;
- no `mulqi-cc auto fold engine: ... not resolvable` warning (that warning means the
  host backend could not be imported and the entry deactivated itself).

If BOTH rows stay enabled, the loader's entry order decides who owns the slot; the
loser fails with a clear service-duplicate diagnostic and the boot continues. Keep
exactly one enabled.

## Pressure policy you must be able to reach

The engine inherits the host's pressure math:

`threshold = min(contextWindow * thresholdRatio, contextWindow - reservedCompletion - headroomTokens)`

A gate that can never fire (for example `headroomTokens` above the usable budget)
means the pre-step trigger degrades to a one-time warning and only context-overflow
recovery still compacts. The engine row ships `thresholdRatio: 0.75` and
`headroomTokens: 32000` as sane defaults; keep them, or tune per model with
`modelPolicies` in the same row.

## Failure semantics (fail-open)

The auto fold is an enhancement, never a blocker:

- unknown session identity, unknown span edges, empty digest, protected span
  (recent zone, first/last user message, tool-result protection), or an over-cap
  digest after truncation: the block is skipped and the host compaction lands
  without a marker;
- mycelium publish failure: logged, never thrown, the block stays session-local;
- host backend not importable: the whole entry deactivates with a visible warning
  and registers no service.

## Tests

- hermetic: `node --test tests/*.test.js` (registry, digest, and entry inactivity);
- host-gated: `MULQI_CC_HOST_MODULES=/path/to/deepseek-harness node --test tests/engine-host.test.js`
  (real `BasicCompactionEngine` subclassing, marker, and cross-entry visibility).
