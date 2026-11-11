# Mulqi Context Compression

Native DeepSeek Harness plugin that compresses a long agent session by folding settled work
into restorable digest blocks. The model writes each summary; the engine keeps every folded
message addressable, so detail is recalled instead of lost. An optional shared store (the
mycelium) carries those digest blocks between sessions of the same user.

- Target host: DeepSeek Harness `0.2.1-rc.2` (exact pin; the host refuses the bundle on any
  other version)
- Runtime: Node.js `>=22`, builtins only, zero runtime dependencies
- Surfaces: one bundled doctrine skill (`mulqi-context-compression`, catalog rank 600) plus
  four native tools (`mulqi_cc_status`, `mulqi_cc_compress`, `mulqi_cc_decompress`,
  `mulqi_cc_search`), the cross-session mycelium store (publishing off by default), and the
  opt-in auto fold engine that plugs the fold into the host's automatic compaction

## What it does

Long sessions accumulate tool output until the context window fills. The usual remedy is to
summarize the whole history into one opaque blob and discard the source. That is irreversible,
and the summary degrades with every round because it summarizes earlier summaries.

The fold avoids both problems:

1. **The model writes the summary.** When a task step settles, the model folds the consumed
   increment into one compact, task-relative block (`mulqi_cc_compress`). Paths, exact values,
   error strings, and decisions with their rationale stay verbatim when the model judges it
   may still need them.
2. **The engine orchestrates everything else.** It assigns stable per-message refs (`mNNNNN`),
   tracks tiered blocks with lineage (tier-1 to tier-2 distillation), enforces protected zones
   in code (first and last user message, the recent working zone, compression tool results),
   and gates growth on the demand side. The gate recommends compression between task steps
   and reports real byte sizes rather than a fill-ratio number the model could anchor on.
3. **Every folded message stays restorable.** `mulqi_cc_decompress` re-activates a block's
   original messages: the whole block, a sub-range, or a host-readable file under
   `<tmpdir>/mulqi-cc/<sessionKey>/` (exclusive-created, never overwrites). `mulqi_cc_search`
   recalls folded detail by keyword before you re-read or re-run anything.

The doctrine (when to fold, what to keep, how much to keep) ships as a bundled skill. The
judgment stays resident in the session and inspectable in text, not baked into model weights
or a hidden prompt.

## Install (DSH 0.2.1-rc.2)

`dsh plugin` forwards its arguments to pnpm inside the profile directory, so every form below
is an ordinary pnpm `add`/`remove`. The profile is created on first use if it does not exist
yet. The host registers the bundle from the package's `dsh.bundle` declaration on its own; no
manifest editing is needed after the install.

Pick the source that matches your situation:

```bash
# From GitHub (the published package):
dsh plugin --profile <name> add github:mulqizamzam/mulqi-context-compression

# From a local checkout (run inside this repository):
dsh plugin --profile <name> add .

# From a tarball or registry entry (pnpm form):
dsh plugin --profile <name> add <pkg-name>@<version>
```

Then confirm the mount and restart the profile's host:

```bash
# Expect the mount row, and no skip line for this package.
dsh --profile <name> --dump-config | grep -A1 mulqi-context-compression
#   # == mulqi-context-compression
#   - id: mulqi-cc

# Restart so the new row is loaded.
dsh --profile <name>
```

After the restart, the skill `mulqi-context-compression` appears in the session catalog and
the four `mulqi_cc_*` tools appear in the tool registry for every agent in the profile.

### Uninstall

```bash
dsh plugin --profile <name> remove mulqi-context-compression
```

This removes the pnpm dependency from the profile; the mount row disappears from
`--dump-config` on the next check.

### Troubleshooting

- **`dsh: skipping profile bundle "mulqi-context-compression": <reason>`** at boot. The host
  writes one such line per skipped bundle to stderr. The most common reason is a host version
  mismatch: the pin in `package.json` is `dsh.engines.dsh: "0.2.1-rc.2"`, an exact version, so
  the row is refused on any other host. Check with `dsh --version`. The two ways forward:
  run the matching host version, or grant an exact-version exemption on the host that is
  actually running:

  ```bash
  dsh plugin --profile <name> allow-version mulqi-context-compression@0.3.0 \
    --dsh-version <running-host-version> --accept-risk
  ```

  The host prints its own warning ("allowing incompatible plugin versions can break the
  application or corrupt data. Approval applies only to the exact package and DSH versions")
  and refuses to approve a version that is not the one currently running. Revoke the entry
  again with `dsh plugin --profile <name> revoke-version mulqi-context-compression@0.3.0
  --dsh-version <version>`. An exemption is a persistent row in the profile's
  `compatibility.json`; prefer matching host versions over carrying exemptions.
- **No mount row at all.** The bundle never registered: the install failed, or the profile
  was not restarted. Re-run the install form and the `--dump-config` check.
- **Config wiring.** The bundle mounts with the engine's defaults and exposes no config row
  (see Configuration below); per-profile wiring through the patch row is not claimed in v1.

## Usage

- **Check between task steps:** `mulqi_cc_status` returns the composition breakdown, the
  compressible ranges with real sizes, the block list, and a nudge when the growth gate fires.
- **Compress a settled step:** `mulqi_cc_compress` takes `fromRef` and `toRef` (from the status
  ranges), a task-relative `topic`, and your `summary`. Keep tier-1 summaries under about 2K
  tokens.
- **Recall before redoing work:** `mulqi_cc_search` with exact identifiers.
- **Restore:** `mulqi_cc_decompress` takes a whole block, a `fromRef`/`toRef` sub-range, or
  `toFile: true` for large payloads. The file variant returns a path, which keeps context lean.
  A sub-range bound that resolves to no live message (already truncated, or never
  existed) returns an explicit error; resolvable bounds outside the block span clamp to
  the block's span.

The bundled skill documents the full doctrine: timing rules, KEEP and DROP classes, protected
zones, tiering, anti-patterns, and the shared-store etiquette below. Read it first.

## Cross-session: the mycelium store

A per-user directory of content-addressed digest blocks (`fp-<8hex>`, FNV-1a over the block's
topic + summary key tokens) with an inverted token index. It is what makes cross-session recall
possible: a later session can find settled work an earlier one compressed, instead of
re-deriving it.

- Location: `$DSH_HOME/mulqi-cc-mycelium`, or `~/.dsh/mulqi-cc-mycelium` when `DSH_HOME` is
  unset. Override with `MULQI_CC_MYCELIUM_DIR`.
- **Publishing is off by default.** A configured store is readable for recall without being
  enabled, so a session can use the mycelium's memory without contributing to it. Enable
  publishing per host with `MULQI_CC_MYCELIUM_PUBLISH=1`. The store lives under your user's
  home, shared across all profiles on that host; treat it as user-private.
- `mulqi_cc_status` reports `mycelium: "ok" | "off" | "unavailable"` and, when the store holds
  work related to this session's active blocks (topic + summary token overlap, 0.15 Jaccard
  floor), lists a `nearby` preview: `fp`, `topic`, `sessionKey`, `phase`.
- `mulqi_cc_search` with `scope: "shared"` recalls store blocks from other sessions. Each hit
  carries `fp`, `sessionKey`, `topic`, a 300-char `snippet`, `accessCount`, and `phase`. Pass
  `remember: true` when that recall actually shaped the next action: each hit is then counted as
  a use and its fidelity phase advances.
- Blocks carry a fidelity `phase`: `archived` (deactivated or tier-2 distilled), `active`
  (used at least once), `dormant` (published and untouched). For local blocks every
  `mulqi_cc_decompress` counts as a use; for shared blocks the use is counted when a session
  recalls with `remember: true`.
- Failures never hide: when a store write fails the compress DTO reports
  `mycelium: "failed"` plus `myceliumError`, and the local compression still succeeds; when no
  store is configured, shared recall returns `mycelium_unavailable` instead of a fake result.
- A corrupt index file is never destructively rebuilt: the affected token is skipped for that
  write and the compress DTO surfaces `myceliumIndexDegraded`; `mulqi_cc_status` surfaces
  `myceliumDegraded` for read-side skips (missing block files, swapped symlink files,
  records whose tokens do not hash to their own fingerprint). The explicit repair path is the
  store's `reindex()` (not exposed as a tool in v0.2.1).
- Concurrent publishers cannot lose index entries: token indexes are append-only line files
  (one fingerprint per line, `O_APPEND`), so two sessions publishing at once degrade at worst
  to duplicate lines, which the reader de-duplicates. Fidelity use counters are append-only
  too (one line per `remember: true` use under `count/<fp>`, derived at read time), so
  concurrent sessions cannot lose each other's increments either.
- Store layout is write-secure: directories are created in mode 0700 and re-locked to 0700
  on open; block files and index lines are exclusive-created (`O_EXCL`) into a per-operation
  unique private temp and renamed (a second writer to the same file gets its own temp and
  never deletes the first writer's in-flight one), and a temp path that is, or was turned
  into, a symlink is refused, never followed, never truncated. Append paths (token index lines, fidelity counters) open with
  `O_NOFOLLOW` so a symlink planted at those paths is refused the same way. Refused writes
  surface as `mycelium: "failed"` in the compress DTO, and `mulqi_cc_status` recomputes
  composition and nudge after an emergency truncation instead of reporting the
  pre-truncation state.

## Configuration

The engine ships with these defaults (table source: `lib/fold.js` `DEFAULTS`):

| Knob | Default | Meaning |
|---|---|---|
| `gateFloorTokens` | 50000 | growth-gate trigger floor |
| `effectiveFloorFraction` | 0.45 | effective-floor fraction when pending mass is under the floor |
| `windowTokens` | 204800 | assumed model window |
| `windowFloorFraction` | 0.45 | fill fraction below which the nudge stays quiet |
| `recentZoneMessages` | 5 | raw tail messages (hard floor) |
| `recentZoneTokens` | 5000 | raw tail token floor |
| `maxSummaryTokens` | 2000 | tier-1 summary cap (engine-enforced) |
| `searchLimitDefault` / `searchLimitMax` | 5 / 20 | recall result caps |
| `searchRecentMessages` | 20 | recent window scanned for recall |

Every knob is overridable programmatically: `createFoldTools({ config })` in `lib/tools.js`
accepts overrides, so a host that composes the engine directly can retune gates without
forking. Per-profile config wiring through the bundle patch row is not claimed in v1.

The mycelium store is configured at host boot, not through the profile:

| Variable | Default | Meaning |
|---|---|---|
| `MULQI_CC_MYCELIUM_DIR` | `$DSH_HOME/mulqi-cc-mycelium` (or `~/.dsh/mulqi-cc-mycelium` when `DSH_HOME` is unset) | where the shared block store lives |
| `MULQI_CC_MYCELIUM_PUBLISH` | off | set to `1` to write this host's digest blocks into the shared store |
| `MULQI_CC_MYCELIUM_NEARBY` | `3` | cap on `nearby` previews in `mulqi_cc_status` |
| `MULQI_CC_AUTO_MODE` | `llm` | digest mode of the auto fold engine: `llm` (host cache-aware summarization) or `mechanical` (zero-LLM template digest) |
| `MULQI_CC_AUTO_MAX_TOKENS` | `4096` | tier-1 cap applied to auto-fold blocks (floors at 2048) |

Token counting uses a documented `chars/4` heuristic, so there is no tokenizer dependency.

## Auto fold engine (opt-in, no model trigger)

The bundle's second entry (`compaction-engine.js`, `MulqiFoldEngine`) plugs the fold into
the host's automatic compaction: the host's `agent/pre-step` pressure trigger and
context-overflow recovery run without any model call, and each compacted span is
recorded as a restorable digest block in the same fold registry as the four tools,
with a `[mulqi-fold: ...]` marker line in the checkpoint. The host engine keeps its
trigger policy, retention, lock, and durable checkpoint framing; the entry overrides
only the engine's `summarize()` hook.

The row ships `disabled: true` in `cordis.patch.yml` (the `compaction` service slot
holds one implementation). Opt in from your profile's patch layer:

```yaml
- id: mulqi-cc-fold-engine
  disabled: false

- id: compaction-basic
  disabled: true
```

then restart the host. Full guide, failure semantics, and pressure-policy notes:
`docs/auto.md`.

## What is in the bundle

The `files` whitelist in `package.json` ships exactly: `index.js` (Cordis entry, registers the
skill provider and four tools), `compaction-engine.js` (the opt-in auto fold engine entry),
`lib/**` (the fold engine, the process-wide fold registry, the mechanical digest, the
environment surface, the write sink, the mycelium DNA layer, the shared block store, tool
builder, and skill provider),
`skills/**` (the doctrine skill), `cordis.patch.yml` (the bundle mount rows), `docs/**`,
`README.md`, `NOTICE.md`, `LICENSE`. The test suite (`tests/*.test.js`) and the private audit
notes (`work/`) stay out of the published package.

Engineering detail for integrators: `docs/engineering.md` covers engine contracts, tool DTO
shapes, and host wiring notes.

## Verify

```bash
npm test          # node --test, 92 tests: fold engine, registry, digest, auto-fold, provider, tool contract, mycelium
node --check index.js compaction-engine.js lib/fold.js lib/fold-registry.js lib/fold-digest.js lib/env.js lib/write-sink.js lib/mycelium.js lib/store.js lib/provider.js lib/tools.js
# host-gated engine tests (real BasicCompactionBackend subclassing + cross-entry proof):
MULQI_CC_HOST_MODULES=/path/to/deepseek-harness node --test tests/engine-host.test.js
```

The registry test suite also asserts that the private `work/` directory is not packaged and
that the manifest pins the exact host version.

## Known boundaries

- **No wire-level proxy:** compression state lives in-process per session. With the auto fold
  engine enabled (opt-in), the host's automatic compaction itself runs through the fold;
  otherwise host compaction remains the plain-summary backstop for overflow. The model-API
  cache economics of a proxy layout are out of scope for this native bundle.
- **In-memory fold state:** local blocks are not persisted across host restarts. The mycelium
  store (when publishing is enabled) persists shared blocks to disk under the user's home, but
  a block's own original messages still live only inside the session that compressed them.
- **Tier-2 distillation is model-initiated:** the doctrine says when to promote; the engine
  does not auto-promote.
- **Sub-agent lanes:** fold state is keyed per session, so a child agent sees its own lane.
- **Mycelium privacy:** the store is user-private by location (no network), not by access
  control: every profile on the same host and the same `DSH_HOME` reads and, when publishing
  is enabled, writes the same directory. The store carries digest blocks (summaries + refs),
  not raw transcripts; summaries still contain whatever the model put in them. Enable
  publishing only on hosts where that trade is acceptable.
- **Mycelium fingerprints are 32-bit FNV-1a:** two different digests can hash to the same
  `fp-<8hex>` slot, in which case the later publish overwrites the block file and the token
  indexes point both digests at the surviving record. The fingerprint covers key tokens only,
  not full text, so a same-user writer can deliberately rewrite a block's summary under a
  known fp (a "same topic, fresh summary" republish, or a hostile one); the store cannot
  tell the two apart. Each record's `contentLength` makes such an override detectable after
  the fact; signed blocks (a per-store key) are the planned structural closure. At user
  scale the birthday collision probability is negligible; the policy is last-writer-wins,
  documented here instead of silently engineered around.
- **The store has no eviction:** published blocks stay until you delete the store directory.
  The `nearby` preview in `mulqi_cc_status` is a bounded read (at most 200 block files per
  call), so status cost stays flat as the store grows; full-store operations like `reindex()`
  are paid only when you run them.

## License

MIT. See `LICENSE`. Concept provenance and attribution are recorded in `NOTICE.md`.
