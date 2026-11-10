/**
 * Mulqi Context Compression: native tool layer.
 *
 * Builds the four model-facing tools on top of the fold engine and wires
 * them to one host-provided message reader (DSH `ctx.sessionQuery.readSurface`
 * in production; any `(sessionId) => Promise<{ events?: unknown[] }>` in tests).
 *
 * Every tool returns a plain JSON DTO (the registry's canonical value); the
 * model sees it as one text block via `output.render`.
 */

import {
  composition,
  createFold,
  decompressBlock,
  emergencyTruncate,
  ingest,
  nudgeFor,
  promoteTier,
  recordBlock,
  searchContext,
  surfaceEventsToMessages,
} from './fold.js'
import { fingerprint, keyTokens, phaseFor, rankNearby } from './mycelium.js'
import { openMyceliumStore } from './store.js'

/** Max shared blocks scanned per status call for the nearby list. */
const NEARBY_SCAN_CAP = 200

/**
 * @param {object} host
 * @param {(sessionId: string) => Promise<{ events?: unknown[] } | unknown[] | null | undefined>} host.readMessages
 * @param {(sessionId: string) => string | undefined} [host.sessionKeyFor] resolves the fold key for the call context
 * @param {(name: string, text: string) => string} [host.writeFile] decompress-to-file sink
 * @param {object} [host.config] fold engine config overrides
 * @param {{ dir?: string, publish?: boolean, nearbyLimit?: number }} [host.mycelium]
 *   shared cross-session fold store. `dir` enables it; `publish` (default
 *   false) decides whether new blocks are written into the store; `nearbyLimit`
 *   (default 3) caps the status nearby list.
 */
export function createFoldTools(host) {
  const folds = new Map()
  const myc = host?.mycelium ?? null
  let storeCache = null
  let storeError = null

  /** Lazily open the shared store; retry after a failure, never crash apply(). */
  function store() {
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

  /** @returns {object} the fold state for the current session, after ingesting fresh messages */
  async function foldForCall() {
    const resolved = typeof host.sessionKeyFor === 'function' ? host.sessionKeyFor() : undefined
    // No silent 'default' bucket: two unattributed agents sharing one fold would
    // read each other's blocks and summaries. Fail closed and say so.
    if (typeof resolved !== 'string' || resolved.length === 0) {
      const e = new Error('no agent session identity for this call (ctx.agents.currentInitiator() unavailable)')
      e.code = 'no-session'
      throw e
    }
    const key = resolved
    let fold = folds.get(key)
    if (!fold) {
      fold = createFold({
        sessionKey: key,
        config: host.config,
        writeFile: host.writeFile
          ? (name, text) => host.writeFile(name, text, key)
          : undefined,
      })
      folds.set(key, fold)
    }
    try {
      const snapshot = await host.readMessages(key)
      const events = Array.isArray(snapshot) ? snapshot : (snapshot?.events ?? null)
      ingest(fold, surfaceEventsToMessages(events ?? []))
      // An absent snapshot is not an empty session: flag it, never fake success.
      fold.hostRead = events ? 'ok' : 'unavailable'
      delete fold._lastIngestError
    } catch (err) {
      // A host read failure must not wedge the tool; it must stay visible,
      // otherwise the model sees an empty composition and believes it is clean.
      fold.hostRead = 'failed'
      fold._lastIngestError = String(err?.message ?? err)
    }
    return fold
  }

  const err = (code, detail) => ({ ok: false, code, detail })

  /** Host-read health, surfaced on every DTO so a degraded read is never invisible. */
  const hostState = (fold) => ({
    hostRead: fold.hostRead ?? 'unknown',
    ...(fold._lastIngestError ? { hostReadError: fold._lastIngestError } : {}),
  })

  /**
   * Publish the just-recorded block into the shared mycelium store.
   * A publish failure never taints the engine result; it is surfaced in the
   * DTO (mycelium: 'failed' + myceliumError), never swallowed (RT-4).
   */
  function publishDto(dto, fold, out) {
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
  }

  /** Fold for this call, or a visible DTO explaining why the call cannot run. */
  async function foldOrDeny() {
    try {
      return { fold: await foldForCall() }
    } catch (e) {
      if (e?.code === 'no-session') return { deny: err('no_session_identity', e.message) }
      return { deny: err('internal', String(e?.message ?? e)) }
    }
  }

  return [
    {
      name: 'mulqi_cc_status',
      description:
        'Mulqi Context Compression: inspect the current context fold. Returns a composition breakdown ' +
        '(raw vs folded vs summaries), compressible candidate ranges with real sizes, the active block list, ' +
        'and, when the growth gate fires, an efficiency nudge with a recommendation list. ' +
        'Call it between task steps to decide what to compress; it never discloses the window fill ratio.',
      parameters: {
        type: 'object',
        properties: {
          includeRanges: {
            type: 'boolean',
            description: 'Include compressible candidate ranges (default true).',
          },
          truncateTo: {
            type: 'integer',
            description:
              'Last-resort hard cap in approximate tokens: drop the oldest unprotected messages until the context fits. Rare; prefer mulqi_cc_compress.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (exec?.signal?.aborted) return err('aborted', 'cancelled before dispatch')
        const got = await foldOrDeny()
        if (got.deny) return got.deny
        const fold = got.fold
        const out = {
          ok: true,
          sessionKey: fold.sessionKey,
          ...hostState(fold),
          composition: composition(fold),
          nudge: nudgeFor(fold),
          blocks: fold.blocks.map((b) => ({
            blockId: b.blockId,
            tier: b.tier,
            topic: b.topic,
            active: b.active,
            approxSummaryTokens: b.approxSummaryTokens,
            sourceCount: b.sourceRefs.length > 0 ? b.sourceRefs.length : b.sourceBlockIds.length,
            phase: phaseFor(b, { accesses: b.accessCount ?? 0 }),
          })),
        }
        if (args?.includeRanges === false) out.composition.ranges = []
        if (typeof args?.truncateTo === 'number') {
          const trunc = emergencyTruncate(fold, args.truncateTo)
          out.truncation = trunc.ok ? { dropped: trunc.dropped, totalTokens: trunc.totalTokens } : trunc
        }
        if (myc && typeof myc.dir === 'string') {
          const st = store()
          if (!st) {
            out.mycelium = 'unavailable'
            out.myceliumError = storeError?.detail ?? 'mycelium store unavailable'
          } else {
            out.mycelium = 'ok'
            out.publish = !!myc.publish
            if (st.stats.degraded > 0) out.myceliumDegraded = st.stats.degraded
            const recs = st.listBlocks(NEARBY_SCAN_CAP)
            const byFp = new Map(recs.map((r) => [r.fp, r]))
            // The session's DNA: key tokens of everything still folded in it.
            const dna = keyTokens(fold.blocks.filter((b) => b.active).map((b) => `${b.topic}\n${b.summary}`).join('\n'))
            const ranked = rankNearby(dna, recs, Number(myc.nearbyLimit) > 0 ? Number(myc.nearbyLimit) : 3)
            out.nearby =
              ranked.length === 0
                ? null
                : ranked.map((r) => {
                    const rec = byFp.get(r.fp)
                    return {
                      fp: r.fp,
                      score: Number(r.score.toFixed(3)),
                      topic: rec?.topic ?? '',
                      sessionKey: rec?.sessionKey ?? '',
                      phase: phaseFor({ active: true, tier: rec?.tier ?? 1 }, { accesses: rec?.accessCount ?? 0 }),
                    }
                  })
          }
        } else {
          out.mycelium = 'off'
        }
        return out
      },
    },
    {
      name: 'mulqi_cc_compress',
      description:
        'Mulqi Context Compression: fold a consumed message range into a restorable digest block. ' +
        'YOU write the summary text (task-relative, under ~2K tokens for tier 1): keep verbatim the file ' +
        'paths, exact values, error strings, decisions with rationale, and message refs you may need; ' +
        'drop verbose logs once the result is extracted, duplicate reads, and dead-end journeys (keep their lessons). ' +
        'Compress only what the current task step no longer needs; you may refuse at a critical juncture. ' +
        'Protected (engine-enforced): first and last user message, the recent zone, compression tool results.',
      parameters: {
        type: 'object',
        properties: {
          fromRef: { type: 'string', description: 'Inclusive start, mNNNNN message ref (see mulqi_cc_status ranges).' },
          toRef: { type: 'string', description: 'Inclusive end, mNNNNN message ref.' },
          topic: { type: 'string', description: 'Task-relative one-line label, e.g. "build fix + verification".' },
          summary: {
            type: 'string',
            description: 'Your digest of the range. Compact, task-relative ("TASK AS OF THIS BLOCK").',
          },
          tier: {
            type: 'integer',
            enum: [1, 2],
            description:
              '1 (default) folds a message range. 2 distills existing tier-1 blocks; pair with sourceBlockIds via mulqi_cc_status block list.',
          },
          sourceBlockIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'For tier 2: the blkNNNNN ids this distillation consumes.',
          },
        },
        required: ['fromRef', 'toRef', 'summary'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (exec?.signal?.aborted) return err('aborted', 'cancelled before dispatch')
        const got = await foldOrDeny()
        if (got.deny) return got.deny
        const fold = got.fold
        if (Number(args?.tier) === 2) {
          const out = promoteTier(fold, {
            blockIds: args?.sourceBlockIds,
            topic: args?.topic,
            summary: args?.summary,
          })
          if (!out.ok) return err('tier2', out.error)
          const dto = { ok: true, ...out, sessionKey: fold.sessionKey, ...hostState(fold) }
          publishDto(dto, fold, out)
          return dto
        }
        const out = recordBlock(fold, args)
        if (!out.ok) return err('compress', out.error)
        const dto = { ok: true, sessionKey: fold.sessionKey, ...hostState(fold), ...out, nudge: nudgeFor(fold) }
        publishDto(dto, fold, out)
        return dto
      },
    },
    {
      name: 'mulqi_cc_decompress',
      description:
        'Mulqi Context Compression: restore a digest block\'s original messages: whole block, a sub-range ' +
        '(fromRef/toRef within the block), or to a host-readable file (toFile=true) which returns the path ' +
        'instead of the text. Use when a compressed detail is needed again; pass "list" as blockId to enumerate active blocks.',
      parameters: {
        type: 'object',
        properties: {
          blockId: { type: 'string', description: 'blkNNNNN to restore, or "list" to enumerate active blocks.' },
          fromRef: { type: 'string', description: 'Optional inclusive sub-range start (mNNNNN, tier-1 blocks only).' },
          toRef: { type: 'string', description: 'Optional inclusive sub-range end (mNNNNN, tier-1 blocks only).' },
          toFile: { type: 'boolean', description: 'Write the restored text to a file and return the path (keeps context lean).' },
        },
        required: ['blockId'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (exec?.signal?.aborted) return err('aborted', 'cancelled before dispatch')
        const got = await foldOrDeny()
        if (got.deny) return got.deny
        const fold = got.fold
        const id = String(args?.blockId ?? '').trim()
        if (id === 'list' || id === '') {
          return {
            ok: true,
            listed: fold.blocks.map((b) => ({
              blockId: b.blockId,
              tier: b.tier,
              topic: b.topic,
              active: b.active,
              approxSummaryTokens: b.approxSummaryTokens,
            })),
          }
        }
        const out = decompressBlock(fold, { blockId: id, fromRef: args?.fromRef, toRef: args?.toRef, toFile: args?.toFile === true })
        if (!out.ok) return err('decompress', out.error)
        if (out.file) return { ok: true, blockId: id, file: out.file, restoredRefs: out.restoredRefs }
        return { ok: true, blockId: id, restoredRefs: out.restoredRefs, text: out.text }
      },
    },
    {
      name: 'mulqi_cc_search',
      description:
        'Mulqi Context Compression: keyword recall across active digest blocks and the recent unfolded messages ' +
        'of this session. Use scope "shared" to recall digests published by other sessions into the ' +
        'cross-session mycelium store (summaries only; the original messages stay in their own session), and ' +
        'remember: true when that recall actually shaped your next action so the shared blocks\' fidelity ' +
        'phases advance. Use before re-reading a file or re-running a command that may already have been summarized.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Space-separated keywords (exact-substring matching, case-insensitive).' },
          limit: { type: 'integer', description: 'Max hits, 1-20 (default 5).' },
          scope: {
            type: 'string',
            enum: ['local', 'shared'],
            description:
              'local (default): this session digest blocks + recent messages. shared: the cross-session mycelium store.',
          },
          remember: {
            type: 'boolean',
            description:
              'shared scope only: when true, count each returned hit as a use (bumps its accessCount), ' +
              'which drives its fidelity phase. Set it when the recall actually shaped your next action.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (exec?.signal?.aborted) return err('aborted', 'cancelled before dispatch')
        const got = await foldOrDeny()
        if (got.deny) return got.deny
        const fold = got.fold
        if (args?.scope === 'shared') {
          const st = store()
          if (!st) {
            return { ok: false, code: 'mycelium_unavailable', detail: storeError?.detail ?? 'no mycelium store configured (set host.mycelium.dir)' }
          }
          const cap = fold.cfg.searchLimitMax
          const r = st.searchBlocks(String(args?.query ?? ''), Math.max(1, Math.min(cap, Number(args?.limit) || fold.cfg.searchLimitDefault)))
          // remember: count the hits as uses so the store's fidelity phases
          // advance. Only set when the recall actually shaped the next action.
          let remembered = 0
          if (args?.remember === true) {
            for (const h of r.hits) {
              try {
                st.bump(h.fp)
                remembered += 1
              } catch {
                /* bump failure: the read already succeeded; the count is best-effort */
              }
            }
          }
          return {
            ok: true,
            scope: 'shared',
            sessionKey: fold.sessionKey,
            ...hostState(fold),
            hits: r.hits.map((h) => ({ ...h, phase: phaseFor({ active: true, tier: h.tier }, { accesses: h.accessCount }) })),
            ...(remembered > 0 ? { remembered } : {}),
            skipped: r.skipped,
            ...(r.degraded > 0 ? { degraded: r.degraded } : {}),
          }
        }
        const out = searchContext(fold, args)
        if (!out.ok) return err('search', out.error)
        return { ok: true, sessionKey: fold.sessionKey, ...hostState(fold), ...out }
      },
    },
  ]
}

export { emergencyTruncate }
