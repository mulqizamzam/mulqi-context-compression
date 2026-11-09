# Mulqi Context Compression

Native DeepSeek Harness plugin that compresses a long agent session by folding settled work
into restorable digest blocks. The model writes each summary; the engine keeps every folded
message addressable, so detail is recalled instead of lost.

- Target host: DeepSeek Harness `0.2.1-rc.2` (exact pin; the host refuses the bundle on any
  other version)
- Runtime: Node.js builtins only, zero runtime dependencies
- Surfaces: one bundled doctrine skill (`mulqi-context-compression`) plus four native tools
  (`mulqi_cc_status`, `mulqi_cc_compress`, `mulqi_cc_decompress`, `mulqi_cc_search`)

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
   and gates growth on the demand side. The gate recommends compression between task steps and
   reports real byte sizes rather than a fill-ratio number the model could anchor on.
3. **Every folded message stays restorable.** `mulqi_cc_decompress` re-activates a block's
   original messages: the whole block, a sub-range, or a host-readable file. `mulqi_cc_search`
   recalls folded detail by keyword before you re-read or re-run anything.

The doctrine (when to fold, what to keep, how much to keep) ships as a bundled skill. The
judgment stays resident in the session and inspectable in text, not baked into model weights
or a hidden prompt.

## Install (DSH 0.2.1-rc.2)

`dsh plugin` forwards its arguments to pnpm inside the profile directory, so the install is an
ordinary pnpm `add`. The profile is created on first use if it does not exist yet.

```bash
# 1. Install. Run from this directory so the relative path resolves.
dsh plugin --profile <name> add .

#    or install a published tarball / registry entry instead of the working copy:
# dsh plugin --profile <name> add <pkg-name>@<version>
```

```bash
# 2. Confirm the bundle row is mounted. Expect a `mulqi-context-compression` entry
#    and no "skipping" line for it.
dsh --profile <name> --dump-config | grep -A1 mulqi-context-compression
```

```bash
# 3. Restart the profile's host so the new row is loaded.
dsh --profile <name>
```

After the restart, the skill `mulqi-context-compression` appears in the session catalog and the
four `mulqi_cc_*` tools appear in the tool registry for every agent in the profile.

Two things the install does not do, by design:

- **Install-time version check.** The pin lives in `package.json` as `dsh.engines.dsh:
  "0.2.1-rc.2"`, which is an exact version and not a range. `pnpm add` accepts it on any host;
  the host then rejects the row at mount time unless its own version is exactly `0.2.1-rc.2`.
  Check with `dsh --version` before installing.
- **Config wiring.** The bundle mounts with the engine's defaults and exposes no config row (see
  Configuration below).

## Usage

- **Check between task steps:** `mulqi_cc_status` returns the composition breakdown, the
  compressible ranges with real sizes, the block list, and a nudge when the growth gate fires.
- **Compress a settled step:** `mulqi_cc_compress` takes `fromRef` and `toRef` (from the status
  ranges), a task-relative `topic`, and your `summary`. Keep tier-1 summaries under about 2K
  tokens.
- **Recall before redoing work:** `mulqi_cc_search` with exact identifiers.
- **Restore:** `mulqi_cc_decompress` takes a whole block, a `fromRef`/`toRef` sub-range, or
  `toFile: true` for large payloads. The file variant returns a path, which keeps context lean.

The bundled skill documents the full doctrine: timing rules, KEEP and DROP classes, protected
zones, tiering, and anti-patterns. Read it first.

## Configuration

The engine ships with documented defaults (table in `docs/engineering.md`, section
Configuration). The bundle registers the tools with those defaults. Every knob is also
available programmatically: `createFoldTools({ config })` in `lib/tools.js` accepts overrides,
so a host that composes the engine directly can retune gates without forking. Per-profile
config wiring through the bundle patch row is not claimed in v1.

Token counting uses a documented `chars/4` heuristic, so there is no tokenizer dependency.

## Known boundaries (v1)

- **No wire-level proxy:** compression state lives in-process per session. Host compaction, if
  configured, remains the backstop for overflow. The model-API cache economics of a proxy
  layout are out of scope for this native bundle.
- **In-memory fold state:** blocks are not persisted across host restarts.
- **Tier-2 distillation is model-initiated:** the doctrine says when to promote; the engine
  does not auto-promote.
- **Sub-agent lanes:** fold state is keyed per session, so a child agent sees its own lane.

## License

MIT. See `LICENSE`. Concept provenance and attribution are recorded in `NOTICE.md`.
