# Engineering Reference: Mulqi Context Compression

For agents and integrators maintaining or extending this bundle. Not user-facing product copy.

## Module map

| File | Exports | Role |
|---|---|---|
| `index.js` | `name`, `inject`, `apply(ctx)` | Cordis entry: registers skill provider + 4 tools; wires host services and the mycelium store config |
| `lib/fold.js` | `createFold`, `ingest`, `recordBlock`, `decompressBlock`, `searchContext`, `nudgeFor`, `composition`, `promoteTier`, `emergencyTruncate`, `stats`, `estimateTokens`, `surfaceEventsToMessages`, `DEFAULTS` | Pure fold engine (zero deps, no I/O, no clock) |
| `lib/mycelium.js` | `keyTokens`, `fnv`, `fingerprint`, `fingerprintMatches`, `overlap`, `rankNearby`, `phaseFor`, `NEARBY_THRESHOLD` | Pure DNA layer: content-addressed block ids, token overlap, fidelity phases |
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
- `openMyceliumStore({ baseDir })` → `{ publishBlock, searchBlocks, bump, listBlocks, reindex, stats, dir }`.
  Layout: `blocks/<fp>.json` (one block per file), `tok/<fnv(token)>.json` (an inverted index,
  one file per key-token hash), and `count/<fp>` (an append-only fidelity counter, one line
  per `remember: true` use). Index files use a line format (one fingerprint per line);
  v0.2.0 JSON-array files are read transparently and migrated to lines on first write.
- Fail-safe by construction (audit 2026-11-08, hardened by red team 2026-11-10 and the
  2026-11-10 external audit fixes):
  - `baseDir` must be absolute and a real directory; a planted symlink at `blocks/`, `tok/`,
    or `count/` is refused, not followed. All four directories are created in mode 0700 and
    re-locked to 0700 on open; a looser pre-existing directory is secured (or the open is
    refused when it cannot be secured).
  - Every file is `lstat`-checked at read time: a block or index file swapped for a symlink
    after open is skipped and counted, never followed.
  - Every block record is verified by content addressing: its stored tokens must hash to its
    own `fp` (recomputed FNV-1a, `fingerprintMatches` in `lib/mycelium.js`), or the record is
    treated as planted and rejected. Publish enforces the same check, so a mismatched record
    never lands on disk.
  - Writes are atomic: a per-operation unique private temp
    (`.<name>.tmp-<pid>-<seq>-<attempt>`) exclusive-created with `O_EXCL | O_NOFOLLOW`
    (mode 0600), written through the descriptor, and renamed under a 0700 dir. The unique
    name is the two-writer contract: a concurrent process writing the same file gets its
    own temp and never touches this writer's in-flight one; a writer may unlink only the
    temp it created itself. EEXIST on our exact name (planted file, pid reuse) skips to
    the next name instead of deleting it; ELOOP (planted symlink) is a hard refusal; a
    rename that finds its own temp gone retries with a fresh temp. Orphan temps from a
    crashed writer are inert dot files, never read.
  - Index updates and fidelity counters are single `O_APPEND` lines through an
    `O_NOFOLLOW` open (helper `appendLine` in `lib/store.js`), so concurrent publishers and
    concurrent `bump()` calls cannot lose an entry, and a symlink planted at an index or
    counter path is refused instead of followed; duplicate lines are de-duplicated at read
    time.
  - A corrupt index file is left untouched: the affected token is skipped for that write and
    counted in `stats.degradedTokens`; `reindex()` is the only supported repair (it rebuilds
    every index from the block files and drops orphans).
  - Missing or skipped block files count as `skipped` in `searchBlocks`; read-side skips and
    integrity rejections count in `stats.degraded`.
- `publishBlock(b)` → `{ degradedTokens }` (number of index updates skipped this call).
- `searchBlocks(query, cap)` → `{ hits: [{ fp, sessionKey, blockId, tier, topic, score,
  snippet (300 chars), accessCount, phase }], skipped, degraded }`.
- `listBlocks(limit?)` loads at most `limit` block files per call (readdir order, advisory
  preview); the status `nearby` preview passes a cap of 200.
- `reindex()` → `{ blocks, tokens }`; rebuilds all `tok/` files from the block files and
  drops `count/` files whose block is gone.

### Fidelity signal (`lib/fold.js`, `lib/store.js`)
- Every local block carries an `accessCount` (starts at 0). Each successful
  `decompressBlock` increments it; the status and shared-search DTOs derive the `phase`
  from it.
- Shared store blocks carry their own `accessCount`. It advances only through an explicit
  use signal: `mulqi_cc_search` with `scope: "shared"` and `remember: true` bumps every
  returned hit via `store.bump(fp)`. A shared recall without `remember` is read-only and
  does not move the phase. (Red team 2026-11-10 RT-4: an exported `bump()` with no call
  site is a dead signal, so the wiring is asserted in the test suite.)
- Counter storage (v0.2.3, audit claim 4): `bump()` no longer rewrites the block record.
  It appends one line to `count/<fp>` (`O_WRONLY|O_CREAT|O_APPEND`), and `readBlock`
  derives the effective `accessCount` as the record's stored count plus the counter's line
  count at read time. Appends from several processes can no longer overwrite each other
  (the old read-modify-write path lost 44% of increments across four concurrent
  processes in the audit PoC).

### Message normalization
`surfaceEventsToMessages(events)` maps DSH `SessionSurfaceSnapshot.events` to
`{ seq, role, text, toolName? }`. Roles: `user`, `assistant`, `tool`, `system`, `developer`.
Unknown event types are skipped; text extraction is defensive (string, ContentBlock[] with
`text`/image blocks, or JSON-fallback). `ingest(state, messages)` is idempotent by `seq`.

### Refs and blocks
- Message ref: `m` + zero-padded 5-digit number minted from a monotonic per-fold counter
  (stable anchor; the label space only grows, so labels of old blocks stay valid).
  Surviving messages keep their labels after emergency truncation: the `byRef` label→index
  map is rebuilt after every truncation, so refs always resolve to the right surviving
  message, never to a shifted position. The monotonic counter (v0.2.3, audit claim 1)
  prevents label recycling: a message ingested after a truncation always gets a new
  label, so no block's `sourceRefs` can be re-pointed at different messages.
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
  `phase`), mycelium: 'ok' | 'off' | 'unavailable', myceliumDegraded?, nearby?, publish,
  truncation? }`. `nearby` is null when the store holds nothing related to this session's
  active blocks, else `[{ fp, score, topic, sessionKey, phase }]` (capped by
  `host.mycelium.nearbyLimit`, default 3; the underlying read is bounded to 200 block files).
  When a store is configured but cannot be opened, `mycelium: 'unavailable'` plus
  `myceliumError`. `myceliumDegraded` (count) appears when read-side skips were recorded on
  this store handle (symlinked files, integrity rejections, corrupt index reads). With
  `truncateTo`, the emergency truncation runs before the DTO is shaped, so `composition`,
  `nudge` and `blocks` describe the post-truncation state (audit claim 5).
- `mulqi_cc_compress` → `{ ok, blockId, tier, ratio, savedTokens, summaryTokens, nudge,
  mycelium: 'off' | 'ok' | 'failed', myceliumIndexDegraded? }` or `{ ok: false, code,
  detail }`. `code` is `compress` or `tier2`. A store write failure sets `mycelium:
  'failed'` plus `myceliumError` without rolling back the local compression.
  `myceliumIndexDegraded` (count) appears when one or more index updates had to be skipped
  because the target index file is corrupt.
- `mulqi_cc_decompress` → `{ ok, blockId, restoredRefs, text | file }` or `{ ok, listed[] }`
  when `blockId: "list"`. A `fromRef`/`toRef` bound that resolves to no live message
  (truncated, or never ingested) returns `{ ok: false, error }` (audit claim 2);
  resolvable bounds outside the block span clamp to the block's span (the official
  sub-range contract, aligned in the tool description, README, and skill body).
  `toFile` writes under `<tmpdir>/mulqi-cc/<sessionKey>/`
  (dir mode 0700; the file is exclusive-created with `wx` and never overwrites or follows
  a planted symlink; a free `-N` name is chosen when the base name exists).
- `mulqi_cc_search` → `{ ok, hits: [{ kind, ref|id, tier?, topic?, score, snippet }] }` for
  the default local scope, or `{ ok, scope: 'shared', sessionKey, hostRead, hits:
  [{ fp, sessionKey, blockId, tier, topic, score, snippet, accessCount, phase }],
  remembered?, skipped, degraded? }` when `scope: 'shared'` and a store is configured.
  The optional `remember: true` argument counts each returned hit as a use (bumps its stored
  `accessCount`, advancing its fidelity phase); the DTO reports `remembered` with the count.
  When `scope: 'shared'` but no store is configured the DTO is `{ ok: false, code:
  'mycelium_unavailable', detail }`.
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
   Degradation counters are per store handle (per host process): `myceliumDegraded` in the status
   DTO and `myceliumIndexDegraded` in the compress DTO reflect skips seen by *this* process;
   a cross-process view of fidelity use counts lives on disk in the `count/` dir, derived
   at read time (v0.2.3); the per-process degradation counters above remain advisory.
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
  phaseFor), the shared store I/O (atomic write, append-only token index, symlink refusal at
  directory and file level, path confinement, content-addressing rejection, non-destructive
  handling of corrupt indexes + `reindex()`, a concurrent-publisher regression, bounded
  `listBlocks`), and the tool-level integration (publish on/off, shared-scope recall,
  `remember`-driven fidelity, nearby in status, `accessCount` advanced via `decompressBlock`
  for local blocks). Red-team regression tests are labelled `RT-1` through `RT-5`.
- Gate: `node --check` on all shipped JS; `node --test tests/`; positive/negative boot controls
  in a scratch `DSH_HOME`; `dsh --dump-config` mount check. No system install, no publish.
