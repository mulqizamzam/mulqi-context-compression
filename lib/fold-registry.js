/**
 * Mulqi Context Compression: the process-wide fold registry.
 *
 * One fold-state map and one mycelium store cache per process, shared by
 * every entry of this package in the host (the four model-facing tools in
 * index.js and the auto fold engine in compaction-engine.js). Sharing is
 * what makes auto-fold blocks visible to `mulqi_cc_status`,
 * `mulqi_cc_decompress` and `mulqi_cc_search`: the engine records a
 * restorable block into the same fold state the tools read, keyed by the
 * same session identity (`Agent.id` / `ctx.agents.currentInitiator().id`).
 *
 * Dependency wiring is per-field merged: the first entry to call
 * `configure()` wins each field, later calls only fill in what is missing.
 * This keeps the two entries independent of their load order.
 */

import { createFold, ingest, recordBlock, surfaceEventsToMessages, estimateTokens } from './fold.js'
import { openMyceliumStore } from './store.js'
import { fingerprint } from './mycelium.js'

let instance = null

/** The shared process registry (lazily created). */
export function foldRegistry() {
  if (!instance) instance = createFoldRegistry()
  return instance
}

/** Test seam: drop the shared registry so the next call starts fresh. */
export function _resetRegistryForTests() {
  instance = null
}

/**
 * Build a fold registry.
 * @returns {object} the registry API.
 */
export function createFoldRegistry() {
  const folds = new Map()
  let deps = null
  let storeCache = null
  let storeError = null

  /** Lazily open the shared store; retry after a failure, never crash apply(). */
  function store() {
    const myc = deps?.mycelium
    if (!myc || typeof myc.dir !== 'string') return null
    if (storeCache) return storeCache
    try {
      storeCache = openMyceliumStore({ baseDir: myc.dir })
      storeError = null
    } catch (e) {
      storeError = { code: 'mycelium_unavailable', detail: String(e?.message ?? e) }
    }
    return storeCache
  }

  const api = {
    /** Per-session fold states, keyed by the session identity string. */
    folds,

    /**
     * Merge dependency wiring. Only fields present on `d` are set; earlier
     * values are kept (first entry wins per field).
     * @param {object} d
     */
    configure(d) {
      if (d == null || typeof d !== 'object') return
      deps = {
        readMessages: d.readMessages ?? deps?.readMessages,
        sessionKeyFor: d.sessionKeyFor ?? deps?.sessionKeyFor,
        writeFile: d.writeFile ?? deps?.writeFile,
        config: d.config !== undefined ? d.config : deps?.config,
        mycelium: d.mycelium ?? deps?.mycelium,
        logger: d.logger ?? deps?.logger,
      }
    },

    /** Current dependency wiring (read-only view). */
    get deps() {
      return deps
    },

    /** Last shared-store open failure, if any. */
    get storeError() {
      return storeError
    },

    /** Lazily opened shared mycelium store, or null when unavailable. */
    store,

    /**
     * Fold state for one session after ingesting fresh messages.
     * Mirrors the tool-layer `foldForCall` semantics exactly: an absent
     * snapshot is flagged `unavailable`, a host read failure stays visible
     * (`failed` + `hostReadError`), and the snapshot is never faked.
     * @param {string} key session identity.
     * @returns {Promise<object>} the fold state.
     */
    async ensureFold(key) {
      const d = deps
      let fold = folds.get(key)
      if (!fold) {
        fold = createFold({
          sessionKey: key,
          config: d?.config,
          writeFile: d?.writeFile
            ? (name, text) => d.writeFile(name, text, key)
            : undefined,
        })
        folds.set(key, fold)
      }
      if (typeof d?.readMessages === 'function') {
        try {
          const snapshot = await d.readMessages(key)
          const events = Array.isArray(snapshot) ? snapshot : (snapshot?.events ?? null)
          ingest(fold, surfaceEventsToMessages(events ?? []))
          // An absent snapshot is not an empty session: flag it, never fake success.
          fold.hostRead = events ? 'ok' : 'unavailable'
          delete fold._lastIngestError
        } catch (err) {
          // A host read failure must not wedge the engine; it must stay visible.
          fold.hostRead = 'failed'
          fold._lastIngestError = String(err?.message ?? err)
        }
      }
      return fold
    },

    /** Host-read health for one fold, shaped like the tool DTO field. */
    hostState(fold) {
      return {
        hostRead: fold.hostRead ?? 'unknown',
        ...(fold._lastIngestError ? { hostReadError: fold._lastIngestError } : {}),
      }
    },

    /**
     * Record one auto-fold block for a captured compaction span.
     * Fail-open by design: any miss (no fold, unknown span edge, empty
     * digest, tier-1 protected-zone rejection) returns null and the
     * host compaction still lands without a restorable marker.
     * @param {{ key: string, startSeq: number, endSeq: number, digest: string, topic?: string, maxTokens?: number }} a
     * @returns {?{ blockId: string, fromRef: string, toRef: string, truncated: boolean, fold: object }}
     */
    recordAutoBlock(a) {
      try {
        const fold = folds.get(String(a?.key ?? ''))
        if (!fold) return null
        const startEdge = fold.bySeq.get(Number(a?.startSeq))
        const endEdge = fold.bySeq.get(Number(a?.endSeq))
        if (!startEdge || !endEdge) return null
        const iFrom = fold.byRef.get(startEdge.ref)
        const iTo = fold.byRef.get(endEdge.ref)
        if (iFrom == null || iTo == null || iFrom > iTo) return null
        let text = String(a?.digest ?? '').trim()
        if (text.length === 0) return null
        // Auto blocks may use a larger tier-1 cap than model-authored blocks
        // (MULQI_CC_AUTO_MAX_TOKENS). The cap is raised monotonically on the
        // fold state; recordBlock then enforces it for everyone in this
        // session, which is the documented consequence of enabling the
        // engine (model summaries stay well under the default cap anyway).
        const cap = Math.max(fold.cfg.maxSummaryTokens, Number(a?.maxTokens) > 0 ? Number(a.maxTokens) : 0)
        if (cap > fold.cfg.maxSummaryTokens) fold.cfg.maxSummaryTokens = cap
        let truncated = false
        if (estimateTokens(text) > cap) {
          // 16 tokens reserved for the truncation marker line.
          text = `${text.slice(0, (cap - 16) * 4)}\n[auto digest truncated to the tier-1 cap]`
          truncated = true
        }
        const out = recordBlock(fold, {
          fromRef: startEdge.ref,
          toRef: endEdge.ref,
          tier: 1,
          topic: typeof a?.topic === 'string' && a.topic.trim() ? a.topic.trim().slice(0, 120) : 'auto-fold',
          summary: text,
        })
        if (!out.ok) return null
        return {
          blockId: out.blockId,
          fromRef: startEdge.ref,
          toRef: endEdge.ref,
          truncated,
          fold,
        }
      } catch {
        // A block is an enhancement, never a blocker for the host compaction.
        return null
      }
    },

    /**
     * Publish one recorded block into the shared mycelium store, shaping a
     * tool DTO exactly like the legacy tool-layer `publishDto` did.
     * @param {object} dto the tool DTO to mutate.
     * @param {object} fold the recording fold.
     * @param {object} out the recordBlock/promoteTier result.
     */
    publishForDto(dto, fold, out) {
      const myc = deps?.mycelium
      if (!myc || typeof myc.dir !== 'string') { dto.mycelium = 'off'; return }
      if (!myc.publish) { dto.mycelium = 'off'; return }
      const st = store()
      if (!st) {
        dto.mycelium = 'failed'
        dto.myceliumError = storeError?.detail ?? 'mycelium store unavailable'
        return
      }
      try {
        const rec = fold.byBlockId.get(out.blockId)
        const dna = fingerprint(String(rec?.topic ?? out.topic ?? ''), String(rec?.summary ?? ''))
        const pr = st.publishBlock({
          fp: dna.id,
          tokens: dna.tokens,
          sessionKey: fold.sessionKey,
          blockId: out.blockId,
          tier: out.tier,
          topic: rec?.topic ?? out.topic ?? '',
          summary: rec?.summary ?? '',
          sourceRefs: rec?.sourceRefs ?? [],
          approxSummaryTokens: rec?.approxSummaryTokens ?? out.summaryTokens ?? 0,
        })
        dto.mycelium = 'ok'
        if (pr?.degradedTokens > 0) dto.myceliumIndexDegraded = pr.degradedTokens
      } catch (e) {
        dto.mycelium = 'failed'
        dto.myceliumError = String(e?.message ?? e)
      }
    },

    /**
     * Publish one auto-fold block for the engine path. A publish failure is
     * reported, never thrown: the engine's own digest already landed on the
     * surface.
     * @param {string} key session identity.
     * @param {string} blockId a recorded block id.
     * @returns {{ status: 'off'|'ok'|'failed', error?: string, degraded?: number }}
     */
    publishAutoBlock(key, blockId) {
      const myc = deps?.mycelium
      if (!myc || typeof myc.dir !== 'string') return { status: 'off' }
      if (!myc.publish) return { status: 'off' }
      const st = store()
      if (!st) return { status: 'failed', error: storeError?.detail ?? 'mycelium store unavailable' }
      try {
        const fold = folds.get(String(key))
        const rec = fold?.byBlockId.get(blockId)
        if (!rec) return { status: 'off' }
        const dna = fingerprint(String(rec.topic ?? ''), String(rec.summary ?? ''))
        const pr = st.publishBlock({
          fp: dna.id,
          tokens: dna.tokens,
          sessionKey: fold.sessionKey,
          blockId: rec.blockId,
          tier: rec.tier,
          topic: rec.topic,
          summary: rec.summary,
          sourceRefs: rec.sourceRefs ?? [],
          approxSummaryTokens: rec.approxSummaryTokens ?? 0,
        })
        if (deps?.logger?.info && pr?.degradedTokens > 0) {
          deps.logger.info(`mulqi-cc auto fold: published ${blockId} into the mycelium store with ${pr.degradedTokens} degraded tokens`)
        }
        return { status: 'ok', ...(pr?.degradedTokens > 0 ? { degraded: pr.degradedTokens } : {}) }
      } catch (e) {
        return { status: 'failed', error: String(e?.message ?? e) }
      }
    },
  }
  return api
}
