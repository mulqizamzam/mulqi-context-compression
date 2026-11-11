/**
 * Mulqi Context Compression: native DeepSeek Harness bundle.
 *
 * Cordis plugin entry. On apply:
 *   1. registers the bundled doctrine skill (`mulqi-context-compression`)
 *      on ctx.skills at the DSH bundled-skill rank (600);
 *   2. registers four native tools (mulqi_cc_status / mulqi_cc_compress /
 *      mulqi_cc_decompress / mulqi_cc_search) on ctx.tools, backed by the
 *      pure fold engine in lib/fold.js;
 *   3. per-session fold state is keyed by the initiating agent's session id
 *      (ctx.agents.currentInitiator(), read at call time);
 *   4. message ingestion uses ctx.get('sessionQuery').readSurface when the
 *      service is available and degrades to last-known state otherwise
 *      (boot is never blocked by its absence);
 *   5. decompress-to-file writes under the OS temp dir (host-readable);
 *   6. cross-session mycelium store: a shared, content-addressed fold store
 *      under $DSH_HOME/mulqi-cc-mycelium (or ~/.dsh/mulqi-cc-mycelium when
 *      DSH_HOME is unset; override with MULQI_CC_MYCELIUM_DIR). Publishing
 *      own blocks into it is off by default (enable with
 *      MULQI_CC_MYCELIUM_PUBLISH=1); shared-scope recall works as long as
 *      the store directory exists and is readable. The nearby-preview cap
 *      defaults to 3 (override with MULQI_CC_MYCELIUM_NEARBY, 1..10).
 *   7. the process-wide fold registry (lib/fold-registry.js) shares fold
 *      state between this entry and the auto fold engine entry
 *      (compaction-engine.js), so auto-fold blocks are visible to the tools
 *      and model blocks to the engine;
 *
 * Zero runtime dependencies (Node builtins only).
 */

import { mulqiMyceliumConfig } from './lib/env.js'
import { makeProvider } from './lib/provider.js'
import { createFoldTools } from './lib/tools.js'
import { createWriteSink } from './lib/write-sink.js'

/** Cordis entry id (diagnostic label in host logs). */
export const name = 'mulqi-cc'

/** Services required at composition time. */
export const inject = ['skills', 'tools', 'agents']

/**
 * @param {object} ctx Cordis plugin context.
 * @returns {() => void} disposer for every registration performed here.
 */
export function apply(ctx) {
  const disposers = []

  // 1. Doctrine skill.
  const skillDisposer = ctx.skills.registerProvider(() => makeProvider())
  disposers.push(skillDisposer)

  // 2-5. Native tools over the fold engine.
  const sessionKeyFor = () => {
    const initiator = ctx.agents?.currentInitiator?.()
    return typeof initiator?.id === 'string' ? initiator.id : undefined
  }

  const readMessages = async (sessionId) => {
    const sessionQuery = ctx.get?.('sessionQuery')
    if (!sessionQuery || typeof sessionQuery.readSurface !== 'function') return null
    return sessionQuery.readSurface(sessionId ?? 'default')
  }

  // The session key is a host identity, not a path segment we control. The
  // shared write sink (lib/write-sink.js) confines it to one safe directory
  // name and refuses any target that resolves outside its base dir; the same
  // sink is used by the auto fold engine entry, so both share one policy.
  const writeSink = createWriteSink()

  const defs = createFoldTools({
    readMessages,
    sessionKeyFor,
    writeFile: writeSink,
    config: undefined,
    mycelium: mulqiMyceliumConfig(),
  })
  for (const def of defs) disposers.push(ctx.tools.register(def))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
