# Mulqi Context Compression

Native DeepSeek Harness plugin for **model-driven, incremental, hierarchical context compression**
("the fold") — long-lived agent sessions with a bounded context window, restorable digest blocks,
and no re-summarization decay.

- Target host: DeepSeek Harness `0.2.1-rc.2` (exact pin; the host refuses the bundle on any other version)
- Runtime: Node.js builtins only — zero runtime dependencies
- Surfaces: one bundled doctrine skill (`mulqi-context-compression`) + four native tools
  (`mulqi_cc_status`, `mulqi_cc_compress`, `mulqi_cc_decompress`, `mulqi_cc_search`)

## What it does

Long sessions accumulate tool output until the context window fills. The classic remedy — summarize
the whole history into one opaque blob and discard the source — is irreversible and degrades with
every round. The fold works differently:

1. **The model writes the summary.** When a task step settles, the model digests the *consumed
   increment* into one compact, task-relative block (`mulqi_cc_compress`), keeping verbatim the
   paths, exact values, error strings, and decisions with rationale it may still need.
2. **The engine orchestrates everything else.** Stable per-message refs (`mNNNNN`), tiered digest
   blocks with lineage (tier-1 → tier-2 distillation), protected zones enforced in code (first and
   last user message, the recent working zone, compression tool results), and a demand-side growth
   gate that recommends compression between task steps with real sizes — never with a fill-ratio
   number to anchor on.
3. **Everything folded stays restorable.** `mulqi_cc_decompress` re-activates a block's original
   messages (whole block, sub-range, or to a host-readable file), and `mulqi_cc_search` recalls
   folded detail by keyword before you re-read or re-run anything.

The doctrine — when, what, how much — ships as a bundled skill so the judgment is resident and
inspectable, not baked into model weights or a hidden prompt.

## Install (DSH 0.2.1-rc.2)

```bash
# from this directory (or the published tarball/registry entry)
dsh plugin --profile <name> add <path-or-spec>
dsh --profile <name> --dump-config | grep mulqi-context-compression   # mounted row, no "skipping"
```

Restart the profile's host after installing. The skill appears in the session catalog under
`mulqi-context-compression`; the four tools appear in the tool registry for every agent in the
profile.

## Usage

- **Check between task steps:** `mulqi_cc_status` — composition breakdown, compressible ranges with
  real sizes, block list, and a nudge when the growth gate fires.
- **Compress a settled step:** `mulqi_cc_compress` with `fromRef`/`toRef` (taken from status
  ranges), a task-relative `topic`, and your `summary` (under ~2K tokens for tier 1).
- **Recall before re-doing work:** `mulqi_cc_search` with exact identifiers.
- **Restore:** `mulqi_cc_decompress` — whole block, `fromRef`/`toRef` sub-range, or `toFile: true`
  for large payloads (returns a path; keep context lean).

The bundled skill documents the full doctrine (timing rules, KEEP/DROP classes, protected zones,
tiering, anti-patterns). Read it first.

## Configuration

The engine ships with documented defaults (table in `docs/engineering.md` §Configuration). The
bundle registers the tools with those defaults; every knob is also available programmatically:
`createFoldTools({ config })` in `lib/tools.js` accepts overrides, so a host that composes the
engine directly can retune gates without forking. Per-profile config wiring through the bundle
patch row is intentionally not claimed in v1.

Token counting is a documented `chars/4` heuristic — no tokenizer dependency.

## Known boundaries (v1)

- **No wire-level proxy:** compression state lives in-process per session; host compaction (if
  configured) remains the backstop for overflow, and the model-API cache economics of a proxy
  layout are out of scope for this native bundle.
- **In-memory fold state:** blocks are not persisted across host restarts.
- **Tier-2 distillation is model-initiated:** the doctrine says when; the engine does not auto-promote.
- **Sub-agent lanes:** fold state is keyed per session; child agents see their own lane.

## License

MIT — see `LICENSE`. Concept provenance and attribution: `NOTICE.md`.
