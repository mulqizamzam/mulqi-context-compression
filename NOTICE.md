# NOTICE: Concept Provenance

Mulqi Context Compression v0.1.0 is an independent, clean-room product. It contains no code,
prompt text, tests, or other copyrighted material from any other project.

The concepts implemented here were studied from the publicly documented design of the
open-source project **billion-context** (https://github.com/ranxianglei/billion-context),
MIT License, © 2026 ranxianglei. That design documentation includes the published preprint
"Model-Driven Incremental Hierarchical Compression: Training-Free Multi-Generational Context
Management for Long-Lived Coding Agents".

The concepts derived from that study are:

- Model-driven incremental hierarchical context compression, referred to here as "the fold".
- Tiered restorable digest blocks.
- Growth-gated, demand-side triggering of compression.
- A versioned compression doctrine shipped as an executable prompt specification.

Per the upstream license, and for transparent attribution, those concepts are acknowledged
here. The code, documentation, and tooling in this product are original work by Mulqi and are
licensed MIT (see LICENSE).
