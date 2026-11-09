# Engineering Reference: Mulqi Context Compression

For agents and integrators maintaining or extending this bundle. Not user-facing product copy.

## Module map

| File | Exports | Role |
|---|---|---|
| `index.js` | `name`, `inject`, `apply(ctx)` | Cordis entry: registers skill provider + 4 tools; wires host services and the mycelium store config |
| `lib/fold.js` | `createFold`, `ingest`, `recordBlock`, `decompressBlock`, `searchContext`, `nudgeFor`, `composition`, `promoteTier`, `emergencyTruncate`, `stats`, `estimateTokens`, `surfaceEventsToMessages`, `DEFAULTS` | Pure fold engine (zero deps, no I/O, no clock) |
| `lib/mycelium.js` | `keyTokens`, `fnv`, `fingerprint`, `overlap`, `rankNearby`, `phaseFor`, `NEARBY_THRESHOLD` | Pure DNA layer: content-addressed block ids, token overlap, fidelity phases |
| `lib/store.js` | `openMyceliumStore` | Shared block store I/O (atomic writes, token index, fail-safe validation) |
| `lib/tools.js` | `createFoldTools(host)` | Builds the 4 `ToolDefinition`s over a host adapter (incl. `host.mycelium`) |
| `lib/provider.js` | `makeProvider`, `parseFrontmatter`, `stripFrontmatter` | Bundled skill provider; catalog entry derived from SKILL.md frontmatter |

## Engine contracts

### DNA and mycelium (`lib/mycelium.js`)
- `keyTokens(text)`: lowercase, split on `[^a-z0-9_]+`, keep tokens of length ≥ 4, drop a
  closed stopword set, dedupe, cap at 64. Pure and deterministic; no input type escapes.
- `fingerprint(topic, summary)` → `{ id: 'fp-<8hex>', tokens }`; the id is FNV-1a 32-bit hex
  over the sorted key tokens of `topic + '\n' + summary`, so any surface re-ordering of the
  same key-token multiset yields the same id.
- `overlap(a, b)` is Jaccard similarity over two token sets; `rankNearby(candidate, entries,
  limit)` scores entries against `candidate`, drops scores below `NEARBY_THRESHOLD` (0.15),
  and breaks ties by ascending `fp`.
- `phaseFor(block, stats)`: `archived` when the block is deactivated or tier ≥ 2; otherwise
  `active` when `stats.accesses > 0`; else `dormant`.

### Shared store (`lib/store.js`)
- `openMyceliumStore({ baseDir })` → `{ publishBlock, searchBlocks, bump, listBlocks, dir }`.
  Layout: `blocks/<fp>.json` (one block per file) plus `tok/<fnv(token)>.json` (an inverted
  index, one file per key-token hash).
- Fail-safe by construction: `baseDir` must be absolute and a real directory; a planted
  symlink at `blocks/` or `tok/` is refused, not followed. Writes are atomic (temp file +
  rename under a 0700 dir). Corrupt or missing index entries count as `skipped`, never throw.
- `searchBlocks(query, cap)` → `{ hits: [{ fp, sessionKey, blockId, tier, topic, score,
  snippet (300 chars), accessCount, phase }], skipped }`.

### Fidelity signal (`lib/fold.js`)
- Every block carries an `accessCount` (starts at 0). Each successful `decompressBlock`
  increments it; the status and shared-search DTOs derive the `phase` from it.

### Message normalization
`surfaceEventsToMessages(events)` maps DSH `SessionSurfaceSnapshot.events` to
`{ seq, role, text, toolName? }`. Roles: `user`, `assistant`, `tool`, `system`, `developer`.
Unknown event types are skipped; text extraction is defensive (string, ContentBlock[] with
`text`/image blocks, or JSON-fallback). `ingest(state, messages)` is idempotent by `seq`.

### Refs and blocks
- Message ref: `m` + 1-based zero-padded 5-digit index **at ingestion time** (stable anchor;
  surviving messages keep their labels after emergency truncation: the `byRef` label→index
  map is rebuilt after every truncation, so refs always resolve to the right surviving
  message, never to a shifted position).
- Block: `{ blockId: blkNNNNN, tier: 1|2, topic, summary, sourceRefs | sourceBlockIds,
  active, approxSummaryTokens, createdAt }`. Tier-2 blocks deactivate their source blocks
  (lineage retained for bulk restore).
- `recordBlock` validations (all reject with a machine-readable `error`): unknown refs,
  reversed range, empty summary, over-cap summary (tier-1: `maxSummaryTokens`; tier-2: 4×),
  tier ≥ 2 with no *known* source blocks (phantom ids are filtered; zero known = reject),
  any range message that is protected (first/last user message, recent zone, `mulqi_cc_*`
  tool results, already-folded).
- `decompressBlock`: a sub-range restore keeps the block active (the remaining folded
  messages stay bookkept under it); only a full restore deactivates it. Distilled tier-2
  blocks have no message refs and are rejected with a pointer to their source blocks.

### Growth gate (`nudgeFor`)
- `effectiveFloor = pendingMass < gateFloorTokens ? gateFloorTokens * effectiveFloorFraction : gateFloorTokens`
- `triggered = renderedTokens > windowTokens * windowFloorFraction && pendingMass > 0 && growthSinceLastCompression >= effectiveFloor`
- Nudge text carries: the directive, an explicit refusal right, and a recommendation list with
  real sizes (tokens, message counts, tool-result counts). It never contains a window fill ratio.
- The gate baseline resets to the rendered total after every successful `recordBlock`.

### Token math
`estimateTokens = ceil(chars / 4)`. `renderedTokens = rawMessagesTokens − foldedTokens +
activeSummaryTokens`, the quantity the gate and composition report.

## Configuration (engine defaults, overridable via `createFoldTools({ config })`)

| Knob | Default | Meaning |
|---|---|---|
| `gateFloorTokens` | 50 000 | growth-gate trigger floor |
| `effectiveFloorFraction` | 0.45 | effective-floor fraction when pending mass < floor |
| `windowTokens` | 204 800 | assumed model window |
| `windowFloorFraction` | 0.45 | fill fraction below which the nudge stays quiet |
| `recentZoneMessages` | 5 | raw tail messages (hard floor) |
| `recentZoneTokens` | 5 000 | raw tail token floor |
| `maxSummaryTokens` | 2 000 | tier-1 summary cap (engine-enforced) |
| `searchLimitDefault` / `searchLimitMax` | 5 / 20 | recall result caps |
| `searchRecentMessages` | 20 | recent window scanned for recall |

## Tool DTOs (canonical values, all JSON)

Every successful DTO also carries the host-read health:
`hostRead: 'ok' | 'unavailable' | 'failed'` plus `hostReadError` when a read threw. A model
must never see an empty composition and mistake it for "nothing happened".

- `mulqi_cc_status` → `{ ok, sessionKey, hostRead, composition, nudge, blocks[] (each with
  `phase`), mycelium: 'ok' | 'off' | 'unavailable', nearby?, publish, truncation? }`.
  `nearby` is null when the store holds nothing related to this session's active blocks, else
  `[{ fp, score, topic, sessionKey, phase }]` (capped by `host.mycelium.nearbyLimit`,
  default 3). When a store is configured but cannot be opened, `mycelium: 'unavailable'`
  plus `myceliumError`.
- `mulqi_cc_compress` → `{ ok, blockId, tier, ratio, savedTokens, summaryTokens, nudge,
  mycelium: 'off' | 'ok' | 'failed' }` or `{ ok: false, code, detail }`. `code` is
  `compress` or `tier2`. A store write failure sets `mycelium: 'failed'` plus `myceliumError`
  without rolling back the local compression.
- `mulqi_cc_decompress` → `{ ok, blockId, restoredRefs, text | file }` or `{ ok, listed[] }`
  when `blockId: "list"`. `toFile` writes under `<tmpdir>/mulqi-cc/<sessionKey>/`
  (dir mode 0700; the file is exclusive-created with `wx` and never overwrites or follows
  a planted symlink; a free `-N` name is chosen when the base name exists).
- `mulqi_cc_search` → `{ ok, hits: [{ kind, ref|id, tier?, topic?, score, snippet }] }` for
  the default local scope, or `{ ok, scope: 'shared', sessionKey, hostRead, hits:
  [{ fp, sessionKey, blockId, tier, topic, score, snippet, accessCount, phase }], skipped }`
  when `scope: 'shared'` and a store is configured. When `scope: 'shared'` but no store is
  configured the DTO is `{ ok: false, code: 'mycelium_unavailable', detail }`.
- Any tool called without an agent identity returns `{ ok: false, code: 'no_session_identity' }`
  instead of falling back to a shared bucket.

Every successful value passes through `output.render` → one `{ type: 'text' }` block
(`JSON.stringify(value, null, 2)`); the registry enforces `output.schema`
(`{ type: 'object' }`) before dispatch.

## Host wiring notes

- Session key = `ctx.agents.currentInitiator()?.id` read **at call time** (AsyncLocalStorage
  attribution). **No identity → the call is refused** (`no_session_identity`). There is no
  `'default'` bucket: two unattributed agents sharing one fold would read each other's
  summaries. This is a deliberate fail-closed choice.
- The mycelium store is wired in `index.js` from the host environment:
  `MULQI_CC_MYCELIUM_DIR` (defaults to `$DSH_HOME/mulqi-cc-mycelium`, or
  `~/.dsh/mulqi-cc-mycelium` when `DSH_HOME` is unset), `MULQI_CC_MYCELIUM_PUBLISH`
  (off unless `1`/`true`), and `MULQI_CC_MYCELIUM_NEARBY` (default 3, capped at 10). The
  store handle is opened lazily by the tool layer and retried after a failure; a failure is
  surfaced, never swallowed.
- `ctx.get('sessionQuery')` is probed lazily, so boot never blocks. Absence is **reported**
  (`hostRead: 'unavailable'`) and a throwing read is **reported** (`hostRead: 'failed'` plus
  `hostReadError`); ingestion degrades to last-known state but the model is told.
  Note: `sessionQuery` is a separate service (`@deepseek-ai/dsh-session-query`); the base
  bundle ships only its sqlite backend, so `hostRead: 'unavailable'` is a real configuration,
  not a bug in this package.
- A source block may be distilled **once**: `promoteTier` rejects blocks already consumed by
  another distillation (no double lineage, no double accounting).
- `composition().folded` counts only messages still carried by a **live** block.
- Disposer: `apply` returns a single composite disposer; teardown runs registrations in reverse.

## Test surface (private gate)

- `tests/fold.test.js`: engine: refs, protection zones, blocks, tiers, gate math, search,
  truncation, surface-event normalization (pure fixtures, no host).
- `tests/registry.test.js`: provider list/get, frontmatter re-parse, tool-definition shape
  against the DSH `ToolDefinition` contract, `apply()` against a mock `ctx` (assertions via
  `assert.ok` for boolean conditions).
- `tests/mycelium.test.js`: the DNA layer (keyTokens, fingerprint, overlap, rankNearby,
  phaseFor), the shared store I/O (atomic write, token index, symlink refusal, path
  confinement, graceful degradation on corrupt indexes), and the tool-level integration
  (publish on/off, shared-scope recall, nearby in status, fidelity signal via
  `decompressBlock` incrementing `accessCount`).
- Gate: `node --check` on all shipped JS; `node --test tests/`; positive/negative boot controls
  in a scratch `DSH_HOME`; `dsh --dump-config` mount check. No system install, no publish.
