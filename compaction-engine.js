/**
 * Mulqi Context Compression: the auto fold engine entry.
 *
 * A Cordis class entry that makes the fold run WITHOUT any model trigger:
 * it subclasses the host's basic compaction engine and inherits its
 * automatic machinery (the `agent/pre-step` pressure trigger, context-
 * overflow recovery, retention policy, compaction lock, and durable
 * checkpoint framing). The subclass overrides the host engine's sole
 * customization hook, `summarize()`, so every automatic compaction lands
 * as a restorable mulqi-cc digest block:
 *
 *   - the shadowed span is recorded as a tier-1 block in the process-wide
 *     fold registry, making it visible to `mulqi_cc_status`,
 *     `mulqi_cc_decompress` and `mulqi_cc_search`;
 *   - a marker line is appended to the checkpoint text so the model knows
 *     how to restore the original span later;
 *   - when publishing is enabled (MULQI_CC_MYCELIUM_PUBLISH=1), the block
 *     is also written into the shared mycelium store.
 *
 * Digest mode: `llm` (default; the host's cache-aware one-shot
 * summarization, `summarizeWithLlm` inherited through `super.summarize`)
 * or `mechanical` (MULQI_CC_AUTO_MODE=mechanical; a zero-LLM-cost
 * doctrine-shaped template digest, no provider traffic at all).
 *
 * Opt-in entry: it ships `disabled: true` in this package's cordis.patch.yml.
 * The 'compaction' service slot holds ONE implementation, so activating the
 * fold engine means activating this row and disabling the host's
 * `compaction-basic` row (both live in the profile's cordis patch layers).
 * If both rows are enabled, the loader's entry order decides who owns the
 * slot; the loser fails with a clear service-duplicate diagnostic and the
 * boot continues. See docs/auto.md.
 */

import { mulqiAutoCapTokens, mulqiAutoMode, mulqiMyceliumConfig } from './lib/env.js'
import { buildMechanicalDigest, messageText } from './lib/fold-digest.js'
import { foldRegistry } from './lib/fold-registry.js'

/**
 * The host compaction backend is a peer of this installation, resolved
 * through the host's runtime resolution. Import it lazily and fail soft:
 * when it is not resolvable the engine entry deactivates itself instead of
 * breaking the profile boot. `MULQI_CC_ENGINE_BASE` (a test-only seam)
 * redirects the base import to a resolvable module URL.
 */
let Base = null
try {
  const specifier = process.env.MULQI_CC_ENGINE_BASE || '@deepseek-ai/dsh-compaction-basic'
  Base = (await import(specifier)).default ?? null
} catch {
  Base = null
}

/** Fallback base when the host backend is unavailable: registers nothing. */
class InactiveBase {
  constructor(ctx) {
    ctx.logger?.warn?.(
      'mulqi-cc auto fold engine: @deepseek-ai/dsh-compaction-basic is not resolvable in this ' +
        'installation; the fold engine is inactive and no compaction service was registered',
    )
  }
}

/**
 * Resolve the fold session key for one agent: the same identity the tools
 * entry keys fold state by (`ctx.agents.currentInitiator().id`).
 * @param {object} agent
 * @returns {string|undefined}
 */
export function agentSessionKey(agent) {
  if (agent == null || typeof agent !== 'object') return undefined
  if (typeof agent.id === 'string' && agent.id.length > 0) return agent.id
  const sid = agent.session?.id
  return typeof sid === 'string' && sid.length > 0 ? sid : undefined
}

/** Flatten a SummaryResult's content blocks to one digest string. */
function digestTextOf(result) {
  return (Array.isArray(result?.summary) ? result.summary : [])
    .map((b) => (typeof b?.text === 'string' ? b.text : (typeof b === 'string' ? b : '')))
    .filter((t) => t.length > 0)
    .join('\n')
}

export default class MulqiFoldEngine extends (Base ?? InactiveBase) {
  /** In-flight compaction spans, keyed by the live agent object. */
  #inFlight = new WeakMap()

  constructor(ctx, config) {
    super(ctx, config)
    if (Base === null) return
    // Share fold + mycelium state with the tools entry through the process
    // registry; per-field first-wins merge keeps load order irrelevant.
    foldRegistry().configure({
      readMessages: async (key) => {
        const q = ctx.get?.('sessionQuery')
        if (!q || typeof q.readSurface !== 'function') return null
        return q.readSurface(key)
      },
      mycelium: mulqiMyceliumConfig(),
      logger: ctx.logger,
    })
  }

  /**
   * Capture the span before the host region flow runs, so the fold block
   * can be recorded from exact surface seqs while the surface still holds
   * them. The parent implementation dynamically dispatches `this.summarize`
   * (our override) before committing the replacement.
   * @internal test seam: records an in-flight span without running the
   * host region flow.
   */
  _captureSpan(agent, start, end) {
    this.#inFlight.set(agent, { start, end })
  }

  async compactRegion(start, end, agent, signal) {
    this._captureSpan(agent, start, end)
    try {
      return await super.compactRegion(start, end, agent, signal)
    } finally {
      this.#inFlight.delete(agent)
    }
  }

  /**
   * The fold-aware summarization hook. LLM mode delegates to the inherited
   * cache-aware pipeline; mechanical mode builds a zero-LLM digest. Either
   * way the shadowed span is recorded as a restorable block and a marker
   * line is appended to the checkpoint projection.
   */
  async summarize(input, agent, signal) {
    let result
    if (mulqiAutoMode() === 'mechanical') {
      const { digest } = buildMechanicalDigest(input)
      result = {
        summary: [{ type: 'text', text: digest }],
        provider: 'mulqi-cc',
        model: 'mulqi-cc-mechanical',
      }
    } else {
      result = await super.summarize(input, agent, signal)
    }
    const marker = await this.#foldMarker(agent, result)
    if (marker !== null) result.summary = [...result.summary, { type: 'text', text: marker }]
    return result
  }

  /**
   * Record one auto-fold block for the in-flight span and publish it into
   * the mycelium store when enabled. Fail-open: any miss returns null and
   * the host compaction still lands without a marker.
   * @returns {Promise<string|null>} the marker line, or null.
   */
  async #foldMarker(agent, result) {
    const span = this.#inFlight.get(agent)
    if (!span) return null
    const key = agentSessionKey(agent)
    if (typeof key !== 'string') return null
    const reg = foldRegistry()
    await reg.ensureFold(key)
    const digest = digestTextOf(result)
    if (digest.length === 0) return null
    const out = reg.recordAutoBlock({
      key,
      startSeq: span.start,
      endSeq: span.end,
      digest,
      topic: 'auto-fold',
      maxTokens: mulqiAutoCapTokens(),
    })
    if (out === null) return null
    const pub = reg.publishAutoBlock(key, out.blockId)
    if (pub.status === 'failed') {
      this.ctx?.logger?.warn?.(
        `mulqi-cc auto fold: mycelium publish failed for ${out.blockId}: ${pub.error}`,
      )
    }
    return (
      `[mulqi-fold: ${out.blockId} · auto digest · ${out.fromRef}..${out.toRef} ` +
      `· restore the original span with mulqi_cc_decompress {"blockId":"${out.blockId}"}]`
    )
  }
}

export { buildMechanicalDigest, messageText }
