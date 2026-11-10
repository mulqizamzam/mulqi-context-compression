/**
 * Mulqi Context Compression: fold engine (original implementation, zero dependencies).
 *
 * In-process implementation of model-driven incremental hierarchical context
 * compression ("the fold"):
 *
 *   - stable per-message reference ids (mNNNNN)
 *   - tiered digest blocks (tier-1 folds messages; tier-2/3 fold blocks, and
 *     the lineage survives re-compression)
 *   - protected zones enforced by the engine (first user message, last user
 *     message, the recent zone, compression tool results, active blocks)
 *   - demand-side growth-gated nudge with a recommendation list of candidate
 *     ranges carrying real sizes; the fill ratio is never disclosed
 *   - decompress (whole block, sub-range, or to file) and keyword recall
 *   - emergency truncation as a last-resort hard cap
 *
 * The engine is pure: no I/O, no clock, no host services. File writing is
 * injected via options.writeFile so the library stays testable in isolation.
 */

export const DEFAULTS = Object.freeze({
  /** Growth-gate trigger floor, tokens. */
  gateFloorTokens: 50_000,
  /** Assumed model context window, tokens. */
  windowTokens: 204_800,
  /** Nudge only considers a window beyond this fill fraction. */
  windowFloorFraction: 0.45,
  /** When pending compressible mass is below the floor, the effective floor drops to this fraction of the floor. */
  effectiveFloorFraction: 0.45,
  /** Messages that always stay raw at the tail. */
  recentZoneMessages: 5,
  /** Token floor for the raw recent zone. */
  recentZoneTokens: 5_000,
  /** Hard ceiling for one tier-1 summary, tokens. */
  maxSummaryTokens: 2_000,
  /** Default recall result count. */
  searchLimitDefault: 5,
  searchLimitMax: 20,
  /** Messages scanned for recall beyond active blocks. */
  searchRecentMessages: 20,
})

/** Heuristic token estimate: ~4 chars per token. Documented, not a tokenizer. */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

function blockLabel(n) {
  return `blk${String(n).padStart(5, '0')}`
}

/**
 * Create a fold state for one session.
 * @param {object} [options] overrides for DEFAULTS + { sessionKey, writeFile? }
 */
export function createFold(options = {}) {
  const cfg = { ...DEFAULTS, ...(options.config ?? {}) }
  const state = {
    sessionKey: options.sessionKey ?? 'default',
    cfg,
    writeFile: options.writeFile,
    messages: [], // normalized: { seq, ref, role, text, toolName?, approxTokens, foldedBy? }
    bySeq: new Map(),
    byRef: new Map(),
    blocks: [],
    byBlockId: new Map(),
    nextBlockNo: 1,
    nextRefNo: 1, // monotonic ref minting: labels are never recycled, even after truncation
    gate: {
      baselineTotalTokens: 0, // total at the last compression
      baselineMessageCount: 0,
    },
  }
  return state
}

/**
 * Ingest normalized messages (idempotent by event seq).
 * @param {object} state
 * @param {Array<{seq:number, role:string, text:string, toolName?:string}>} incoming
 * @returns {{ added: number, total: number, totalTokens: number }}
 */
export function ingest(state, incoming) {
  let added = 0
  for (const msg of incoming ?? []) {
    if (msg == null || typeof msg !== 'object' || typeof msg.seq !== 'number') continue
    if (state.bySeq.has(msg.seq)) continue
    const ref = `m${String(state.nextRefNo).padStart(5, '0')}`
    state.nextRefNo += 1
    const entry = {
      seq: msg.seq,
      ref,
      role: msg.role ?? 'user',
      text: typeof msg.text === 'string' ? msg.text : '',
      toolName: msg.toolName,
      approxTokens: estimateTokens(typeof msg.text === 'string' ? msg.text : JSON.stringify(msg.text ?? '')),
      foldedBy: undefined,
    }
    state.messages.push(entry)
    state.bySeq.set(entry.seq, entry)
    state.byRef.set(entry.ref, state.messages.length - 1)
    added += 1
  }
  const totalTokens = totalTokensOf(state)
  return { added, total: state.messages.length, totalTokens }
}

export function totalTokensOf(state) {
  let sum = 0
  for (const m of state.messages) sum += m.approxTokens
  return sum
}

/** Sum of active block summary tokens. */
export function summaryTokensOf(state) {
  let sum = 0
  for (const b of state.blocks) if (b.active) sum += b.approxSummaryTokens
  return sum
}

/** Raw tokens already folded into blocks. */
export function foldedTokensOf(state) {
  let sum = 0
  for (const m of state.messages) if (m.foldedBy) sum += m.approxTokens
  return sum
}

/**
 * What the model actually carries: raw messages minus folded, plus active
 * block summaries. This is the quantity the growth gate measures.
 */
export function renderedTokensOf(state) {
  return totalTokensOf(state) - foldedTokensOf(state) + summaryTokensOf(state)
}

/**
 * The recent zone: a suffix of messages that stays raw.
 * @returns {number} index of the first message in the recent zone
 */
export function recentZoneStart(state) {
  const { cfg } = state
  const byCount = Math.max(0, state.messages.length - cfg.recentZoneMessages)
  let zoneStart = byCount
  let acc = 0
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    acc += state.messages[i].approxTokens
    zoneStart = Math.min(zoneStart, i)
    if (acc >= cfg.recentZoneTokens) break
    if (i === byCount) break
  }
  return zoneStart
}

/** Roles the compression engine treats as protected. */
function firstUserMsgIndex(state) {
  for (let i = 0; i < state.messages.length; i += 1) {
    if (state.messages[i].role === 'user') return i
  }
  return -1
}

function lastUserMsgIndex(state) {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === 'user') return i
  }
  return -1
}

/** Whether a message index is hard-protected (engine floor, not a prompt rule). */
export function isProtectedIndex(state, i) {
  if (i < 0 || i >= state.messages.length) return false
  const m = state.messages[i]
  if (m.foldedBy) return true // already inside a block
  if (m.toolName != null && String(m.toolName).startsWith('mulqi_cc_')) return true
  if (i === firstUserMsgIndex(state)) return true
  if (i === lastUserMsgIndex(state)) return true
  if (i >= recentZoneStart(state)) return true
  return false
}

/**
 * Compressible candidate ranges: contiguous runs of unprotected, unfolded,
 * non-recent messages. Each carries real sizes for the model's judgment.
 */
export function compressibleRanges(state) {
  const ranges = []
  let start = -1
  const close = (end) => {
    if (start < 0) return
    let tokens = 0
    let toolResults = 0
    let userText = 0
    for (let i = start; i <= end; i += 1) {
      tokens += state.messages[i].approxTokens
      if (state.messages[i].toolName != null) toolResults += 1
      if (state.messages[i].role === 'user') userText += 1
    }
    ranges.push({
      fromRef: state.messages[start].ref,
      toRef: state.messages[end].ref,
      messageCount: end - start + 1,
      approxTokens: tokens,
      toolResults,
      userText,
    })
    start = -1
  }
  for (let i = 0; i < state.messages.length; i += 1) {
    if (isProtectedIndex(state, i)) close(i - 1)
    else if (start < 0) start = i
  }
  close(state.messages.length - 1)
  return ranges
}

/** Full composition breakdown (the native "status" primitive). */
export function composition(state) {
  const totals = { user: 0, assistant: 0, tool: 0, system: 0, developer: 0 }
  const folded = { messages: 0, tokens: 0 }
  let recentTokens = 0
  const zone = recentZoneStart(state)
  for (let i = 0; i < state.messages.length; i += 1) {
    const m = state.messages[i]
    if (m.role in totals) totals[m.role] += m.approxTokens
    else totals.other = (totals.other ?? 0) + m.approxTokens
    // only count messages still carried by a LIVE block: a message whose block
    // was deactivated is no longer represented by a summary in context
    if (m.foldedBy && state.byBlockId.get(m.foldedBy)?.active) {
      folded.messages += 1
      folded.tokens += m.approxTokens
    }
    if (i >= zone) recentTokens += m.approxTokens
  }
  const activeBlocks = state.blocks.filter((b) => b.active)
  const byTier = { 1: 0, 2: 0, 3: 0 }
  for (const b of activeBlocks) byTier[b.tier] += 1
  return {
    messages: state.messages.length,
    totalTokens: totalTokensOf(state),
    renderedTokens: renderedTokensOf(state),
    activeSummaryTokens: summaryTokensOf(state),
    folded: folded,
    recentZone: { messages: state.messages.length - zone, approxTokens: recentTokens },
    byRoleTokens: totals,
    blocks: { active: activeBlocks.length, byTier, total: state.blocks.length },
    ranges: compressibleRanges(state),
  }
}

function pendingMass(state) {
  return compressibleRanges(state).reduce((sum, r) => sum + r.approxTokens, 0)
}

/** Growth gate + recommendation list. Never discloses the window fill ratio. */
export function nudgeFor(state) {
  const { cfg } = state
  const total = renderedTokensOf(state)
  const mass = pendingMass(state)
  const growth = total - state.gate.baselineTotalTokens
  const effectiveFloor = mass < cfg.gateFloorTokens ? cfg.gateFloorTokens * cfg.effectiveFloorFraction : cfg.gateFloorTokens
  const triggered = total > cfg.windowTokens * cfg.windowFloorFraction && mass > 0 && growth >= effectiveFloor
  const ranges = compressibleRanges(state).filter((r) => r.approxTokens >= 500)
  const lines = ranges
    .slice(0, 8)
    .map(
      (r) =>
        `- ${r.fromRef} to ${r.toRef} · ~${Math.round(r.approxTokens / 1000)}K tokens · ${r.messageCount} messages` +
        (r.toolResults > 0 ? ` · ${r.toolResults} tool results` : ''),
    )
  const text =
    [
      'Context is growing. An efficiency nudge to compress early and keep context lean, not an overflow warning.',
      'Compress only content the current task step no longer needs; you may refuse at a critical juncture and compress later.',
      'Candidate ranges (compressed, one decision each; keep the summary under ' + Math.round(cfg.maxSummaryTokens) + ' tokens):',
      ...lines,
      'Write the summary with mulqi_cc_compress (fromRef, toRef, topic, summary).',
    ]
      .filter((s) => s.length > 0)
      .join('\n')
  return {
    triggered,
    gate: {
      windowTokens: cfg.windowTokens,
      floorTokens: cfg.gateFloorTokens,
      effectiveFloorTokens: effectiveFloor,
      pendingMassTokens: mass,
      growthSinceLastCompression: Math.max(0, growth),
    },
    text: triggered ? text : null,
    ranges: ranges.length > 0 ? ranges : null,
  }
}

function resolveRef(state, ref) {
  if (typeof ref !== 'string') return -1
  // label -> live-index map (rebuilt after emergency truncation): surviving
  // messages keep their labels as stable anchors instead of positional guesses
  const i = state.byRef.get(ref.trim())
  return i !== undefined && i >= 0 && i < state.messages.length ? i : -1
}

/**
 * Record one compression decision written by the model.
 * @param {object} state
 * @param {object} args { fromRef, toRef, topic, summary, tier? }
 * @returns {object} { ok, blockId?, error?, ratio?, savedTokens? }
 */
export function recordBlock(state, args) {
  const from = resolveRef(state, args?.fromRef)
  const to = resolveRef(state, args?.toRef)
  const tier = args?.tier === 2 || args?.tier === 3 ? args.tier : 1
  if (from < 0 || to < 0) return { ok: false, error: 'range refs must be mNNNNN ids present in this session' }
  if (from > to) return { ok: false, error: 'fromRef must not be after toRef' }
  if (tier === 1) {
    for (let i = from; i <= to; i += 1) {
      if (isProtectedIndex(state, i)) {
        const m = state.messages[i]
        const why = m.foldedBy ? `${m.ref} is already inside block ${m.foldedBy}`
          : m.toolName != null && String(m.toolName).startsWith('mulqi_cc_') ? 'compression tool results are hard-protected'
          : i === firstUserMsgIndex(state) ? 'the first user message (task intent) is protected'
          : i === lastUserMsgIndex(state) ? 'the last user message is protected'
          : 'the range touches the protected recent zone'
        return { ok: false, error: why }
      }
    }
  }
  const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
  if (summary.length === 0) return { ok: false, error: 'summary text is required: the model writes the digest' }
  const summaryTokens = estimateTokens(summary)
  const cap = tier === 1 ? state.cfg.maxSummaryTokens : state.cfg.maxSummaryTokens * (tier === 2 ? 4 : 3)
  if (summaryTokens > cap) {
    return { ok: false, error: `summary exceeds the tier-${tier} cap of ~${cap} tokens (${summaryTokens} est.); split the range or condense` }
  }
  const topic = typeof args?.topic === 'string' && args.topic.trim() ? args.topic.trim().slice(0, 120) : 'untitled fold'
  // tier >= 2 lineage: only blocks that exist may be referenced (phantom ids
  // would corrupt search, restoration and the tier counters)
  const t2Ids = tier === 1 ? [] : (Array.isArray(args?.sourceBlockIds) ? args.sourceBlockIds.map(String).slice(0, 32) : []).filter((id) => state.byBlockId.has(id))
  if (tier !== 1 && t2Ids.length === 0) return { ok: false, error: `tier-${tier} records require sourceBlockIds that reference known blocks` }
  const block = {
    blockId: blockLabel(state.nextBlockNo),
    tier,
    topic,
    summary,
    sourceRefs: tier === 1 ? state.messages.slice(from, to + 1).map((m) => m.ref) : [],
    sourceBlockIds: t2Ids,
    active: true,
    generation: 'young',
    approxSummaryTokens: summaryTokens,
    createdAt: state.messages.length,
    accessCount: 0, // how many times this block's content was restored (fidelity signal)
  }
  if (tier === 1) {
    for (let i = from; i <= to; i += 1) state.messages[i].foldedBy = block.blockId
  } else {
    for (const id of block.sourceBlockIds) {
      const src = state.byBlockId.get(id)
      if (src) src.active = false
    }
  }
  state.nextBlockNo += 1
  state.blocks.push(block)
  state.byBlockId.set(block.blockId, block)
  const saved = tier === 1 ? state.messages.slice(from, to + 1).reduce((s, m) => s + m.approxTokens, 0) : 0
  state.gate.baselineTotalTokens = renderedTokensOf(state)
  state.gate.baselineMessageCount = state.messages.length
  return {
    ok: true,
    blockId: block.blockId,
    tier,
    ratio: saved > 0 ? Math.max(1, Math.round(saved / Math.max(1, block.approxSummaryTokens))) : 1,
    savedTokens: saved,
    summaryTokens: block.approxSummaryTokens,
  }
}

/**
 * Restore a block's sources (whole, or a sub-range), optionally to a file.
 */
export function decompressBlock(state, args) {
  const block = state.byBlockId.get(String(args?.blockId ?? '').trim())
  if (!block) return { ok: false, error: `unknown block id "${String(args?.blockId ?? '')}"` }
  const full = block.sourceRefs
  if (full.length === 0) {
    return {
      ok: false,
      error: `block ${block.blockId} is a tier-${block.tier} distilled block with no message refs; decompress its source blocks (${(block.sourceBlockIds ?? []).join(', ') || 'none'}) instead`,
    }
  }
  let refs = full
  if (block.tier === 1 && (args?.fromRef || args?.toRef)) {
    const fromIdx = args.fromRef ? resolveRef(state, args.fromRef) : (full.length > 0 ? resolveRef(state, full[0]) : -1)
    const toIdx = args.toRef ? resolveRef(state, args.toRef) : (full.length > 0 ? resolveRef(state, full[full.length - 1]) : -1)
    // explicit rejection instead of a silent clamp: a ref no live message
    // holds (truncated, or never existed) must not be ignored, because an
    // ignored bound silently widens the restored range (audit claim 2)
    if (args.fromRef && fromIdx < 0) return { ok: false, error: `unknown fromRef "${args.fromRef}": no live message holds that label (truncated, or never existed)` }
    if (args.toRef && toIdx < 0) return { ok: false, error: `unknown toRef "${args.toRef}": no live message holds that label (truncated, or never existed)` }
    refs = full.filter((r) => {
      const i = resolveRef(state, r)
      if (fromIdx >= 0 && i < fromIdx) return false
      if (toIdx >= 0 && i > toIdx) return false
      return true
    })
    if (refs.length === 0) return { ok: false, error: 'sub-range selects no messages of this block' }
  }
  const parts = refs.map((r) => {
    const i = resolveRef(state, r)
    const m = i >= 0 ? state.messages[i] : undefined
    if (!m) return null
    m.foldedBy = undefined
    return `## ${r} [${m.role}${m.toolName ? ` · ${m.toolName}` : ''}]\n${m.text}`
  }).filter(Boolean)
  if (refs.length === full.length) block.active = false // full restore: lineage retained, sources live again
  // a sub-range restore keeps the block active so the remaining folded messages stay bookkept
  block.accessCount = (block.accessCount ?? 0) + 1 // fidelity signal: this block's content was reopened
  if (args?.toFile && typeof state.writeFile === 'function') {
    const file = state.writeFile(`${block.blockId}-${block.topic.replace(/[^\w-]+/g, '-').slice(0, 40)}.txt`, parts.join('\n\n'))
    return { ok: true, blockId: block.blockId, restoredRefs: refs, file }
  }
  return { ok: true, blockId: block.blockId, restoredRefs: refs, text: parts.join('\n\n') }
}

/** Keyword recall over active block summaries + recent unfolded messages. */
export function searchContext(state, args) {
  const query = String(args?.query ?? '').trim().toLowerCase()
  if (query.length === 0) return { ok: false, error: 'query is required' }
  const terms = [...new Set(query.split(/\s+/).filter(Boolean))]
  const limit = Math.min(state.cfg.searchLimitMax, Math.max(1, Number(args?.limit) || state.cfg.searchLimitDefault))
  const score = (text, extra = '') => {
    const hay = `${text} ${extra}`.toLowerCase()
    let n = 0
    for (const t of terms) if (hay.includes(t)) n += 1
    return n
  }
  const hits = []
  for (const b of state.blocks) {
    if (!b.active) continue
    const s = score(b.summary, b.topic)
    if (s > 0) hits.push({ kind: 'block', id: b.blockId, tier: b.tier, topic: b.topic, score: s, snippet: b.summary.slice(0, 400) })
  }
  const zone = recentZoneStart(state)
  const recent = state.messages.slice(Math.max(zone, state.messages.length - state.cfg.searchRecentMessages))
  for (const m of recent) {
    if (m.foldedBy) continue
    const s = score(m.text, m.toolName ?? '')
    if (s > 0) hits.push({ kind: 'message', ref: m.ref, role: m.role, score: s, snippet: m.text.slice(0, 400) })
  }
  hits.sort((a, b) => b.score - a.score || String(a.id ?? a.ref ?? '').localeCompare(String(b.id ?? b.ref ?? '')))
  return { ok: true, hits: hits.slice(0, limit) }
}

/**
 * Tier promotion: fold a set of tier-1 blocks into a tier-2 block.
 * The model writes the distilled summary; the engine records lineage.
 */
export function promoteTier(state, args) {
  const ids = Array.isArray(args?.blockIds) ? args.blockIds.map(String) : []
  if (ids.length === 0) return { ok: false, error: 'blockIds is required' }
  const known = ids.filter((id) => state.byBlockId.has(id))
  if (known.length === 0) return { ok: false, error: 'no known blocks in blockIds' }
  // a source block may be distilled once: re-consuming an inactive block would
  // put the same content into two live lineages (double accounting, lost provenance)
  const alreadyConsumed = known.filter((id) => state.byBlockId.get(id).active === false)
  if (alreadyConsumed.length > 0) {
    return { ok: false, error: `source blocks already consumed by another distillation: ${alreadyConsumed.join(', ')}` }
  }
  const src = known.map((id) => state.byBlockId.get(id))
  const out = recordBlock(state, {
    fromRef: src[0].sourceRefs[0] ?? 'm00001',
    toRef: src[src.length - 1].sourceRefs[0] ?? 'm00001',
    tier: 2,
    topic: args.topic,
    summary: args.summary,
    sourceBlockIds: known,
  })
  if (!out.ok && out.error?.includes('refs must be')) {
    // tier-2 records are block-anchored; retry with sourceBlockIds only.
    // The fallback path enforces the same summary validation as recordBlock.
    const summary = String(args?.summary ?? '').trim()
    if (summary.length === 0) return { ok: false, error: 'summary text is required: the model writes the digest' }
    const cap = state.cfg.maxSummaryTokens * 4
    const summaryTokens = estimateTokens(summary)
    if (summaryTokens > cap) {
      return { ok: false, error: `summary exceeds the tier-2 cap of ~${cap} tokens (${summaryTokens} est.); split or condense` }
    }
    const manual = {
      blockId: blockLabel(state.nextBlockNo),
      tier: 2,
      topic: typeof args?.topic === 'string' ? args.topic.trim().slice(0, 120) : 'distilled tier',
      summary,
      sourceRefs: [],
      sourceBlockIds: known,
      active: true,
      generation: 'young',
      approxSummaryTokens: summaryTokens,
      createdAt: state.messages.length,
    }
    for (const b of src) b.active = false
    state.nextBlockNo += 1
    state.blocks.push(manual)
    state.byBlockId.set(manual.blockId, manual)
    return { ok: true, blockId: manual.blockId, tier: 2, ratio: 1, savedTokens: 0, summaryTokens: manual.approxSummaryTokens }
  }
  return out
}

/**
 * Last-resort hard cap: drop oldest unprotected messages until the total
 * fits the budget. Returns what was dropped.
 */
export function emergencyTruncate(state, budgetTokens) {
  const budget = Number(budgetTokens)
  if (!Number.isFinite(budget) || budget <= 0) return { ok: false, error: 'budgetTokens must be a positive number' }
  const dropped = []
  let i = 0
  while (totalTokensOf(state) > budget && i < state.messages.length) {
    if (i >= recentZoneStart(state)) break
    const m = state.messages[i]
    if (isProtectedIndex(state, i)) {
      i += 1
      continue
    }
    state.messages.splice(i, 1)
    state.bySeq.delete(m.seq)
    m.foldedBy = undefined
    dropped.push(m.ref)
  }
  // rebuild the label -> index map so surviving labels keep pointing at the
  // right messages (stable anchors, not positional guesses)
  state.byRef.clear()
  state.messages.forEach((msg, idx) => state.byRef.set(msg.ref, idx))
  return { ok: true, dropped, totalTokens: totalTokensOf(state) }
}

/** Session-wide counters. */
export function stats(state) {
  const byTier = { 1: 0, 2: 0, 3: 0 }
  for (const b of state.blocks) byTier[b.tier] += 1
  return {
    sessionKey: state.sessionKey,
    messages: state.messages.length,
    totalTokens: totalTokensOf(state),
    blocks: { total: state.blocks.length, active: state.blocks.filter((b) => b.active).length, byTier },
    gate: state.gate,
  }
}

/**
 * Normalize DSH session surface events into engine messages.
 * Pure helper shared by the tool layer and tests.
 * @param {Array} events SessionSurfaceSnapshot.events
 */
export function surfaceEventsToMessages(events) {
  if (!Array.isArray(events)) return []
  const out = []
  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((b) => {
          if (typeof b === 'string') return b
          if (b && typeof b === 'object') {
            if (typeof b.text === 'string') return b.text
            if (b.type === 'toolCall' || b.type === 'tool-call') return `[tool-call ${b.name ?? '?'}]`
            if (b.type === 'image') return '[image]'
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    return content ? JSON.stringify(content) : ''
  }
  for (const ev of events) {
    if (ev == null || typeof ev !== 'object' || typeof ev.seq !== 'number') continue
    const d = ev.data ?? ev
    switch (ev.type) {
      case 'user/message':
        out.push({ seq: ev.seq, role: 'user', text: textOf(d?.content ?? d?.text ?? '') })
        break
      case 'assistant/message':
        out.push({ seq: ev.seq, role: 'assistant', text: textOf(d?.message?.content ?? d?.message?.text ?? d?.text ?? '') })
        break
      case 'tool/result': {
        const msg = d?.message ?? {}
        out.push({
          seq: ev.seq,
          role: 'tool',
          toolName: msg?.toolName ?? msg?.name,
          text: textOf(msg?.content ?? msg?.text ?? '') + (msg?.isError ? '\n[tool result: isError]' : ''),
        })
        break
      }
      case 'system/message':
        out.push({ seq: ev.seq, role: 'system', text: textOf(d?.message?.content ?? d?.message?.text ?? '') })
        break
      case 'developer/message':
        out.push({ seq: ev.seq, role: 'developer', text: textOf(d?.content ?? d?.message?.content ?? '') })
        break
      default:
        break
    }
  }
  return out
}
