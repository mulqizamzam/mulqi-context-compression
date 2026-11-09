/**
 * Mulqi Context Compression — native tool layer.
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

/**
 * @param {object} host
 * @param {(sessionId: string) => Promise<{ events?: unknown[] } | unknown[] | null | undefined>} host.readMessages
 * @param {(sessionId: string) => string | undefined} [host.sessionKeyFor] resolves the fold key for the call context
 * @param {(name: string, text: string) => string} [host.writeFile] decompress-to-file sink
 * @param {object} [host.config] fold engine config overrides
 */
export function createFoldTools(host) {
  const folds = new Map()

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
      // A host read failure must not wedge the tool — but it must be visible,
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
        'and — when the growth gate fires — an efficiency nudge with a recommendation list. ' +
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
          })),
        }
        if (args?.includeRanges === false) out.composition.ranges = []
        if (typeof args?.truncateTo === 'number') {
          const trunc = emergencyTruncate(fold, args.truncateTo)
          out.truncation = trunc.ok ? { dropped: trunc.dropped, totalTokens: trunc.totalTokens } : trunc
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
          return out.ok ? { ok: true, ...out, sessionKey: fold.sessionKey, ...hostState(fold) } : err('tier2', out.error)
        }
        const out = recordBlock(fold, args)
        if (!out.ok) return err('compress', out.error)
        return { ok: true, sessionKey: fold.sessionKey, ...hostState(fold), ...out, nudge: nudgeFor(fold) }
      },
    },
    {
      name: 'mulqi_cc_decompress',
      description:
        'Mulqi Context Compression: restore a digest block\'s original messages — whole block, a sub-range ' +
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
        'Mulqi Context Compression: keyword recall across active digest blocks and the recent unfolded messages. ' +
        'Use before re-reading a file or re-running a command that may already have been summarized.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Space-separated keywords (exact-substring matching, case-insensitive).' },
          limit: { type: 'integer', description: 'Max hits, 1-20 (default 5).' },
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
        const out = searchContext(fold, args)
        if (!out.ok) return err('search', out.error)
        return { ok: true, sessionKey: fold.sessionKey, ...hostState(fold), ...out }
      },
    },
  ]
}

export { emergencyTruncate }
