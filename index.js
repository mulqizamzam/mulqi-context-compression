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
 *
 * Zero runtime dependencies (Node builtins only).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { makeProvider } from './lib/provider.js'
import { createFoldTools } from './lib/tools.js'

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

  // The session key is a host identity, not a path segment we control. Confine
  // it to one safe directory name (same policy as the host's safeSessionId)
  // and, independently, refuse any target that resolves outside the base dir.
  const safeKey = (key) =>
    String(key ?? 'default')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 128) || 'default'

  const writeSink = (fileBaseName, text, key) => {
    const base = path.resolve(tmpdir(), 'mulqi-cc')
    const dir = path.join(base, safeKey(key))
    const target = path.resolve(dir, fileBaseName)
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      throw new Error('mulqi-cc: refusing to write outside the session directory')
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // pick a free name, then exclusive-create: never overwrite an existing
    // file and never follow a symlink planted in the shared tmp dir
    let free = target
    let n = 1
    while (existsSync(free)) free = path.join(dir, fileBaseName.replace(/\.txt$/, `-${n++}.txt`))
    writeFileSync(free, text, { encoding: 'utf8', flag: 'wx' })
    return free
  }

  const defs = createFoldTools({
    readMessages,
    sessionKeyFor,
    writeFile: writeSink,
    config: undefined,
    mycelium: {
      dir:
        process.env.MULQI_CC_MYCELIUM_DIR?.trim() ||
        (process.env.DSH_HOME
          ? path.join(process.env.DSH_HOME, 'mulqi-cc-mycelium')
          : path.join(homedir(), '.dsh', 'mulqi-cc-mycelium')),
      publish: process.env.MULQI_CC_MYCELIUM_PUBLISH === '1' || process.env.MULQI_CC_MYCELIUM_PUBLISH === 'true',
      nearbyLimit: (() => {
        const nl = Number(process.env.MULQI_CC_MYCELIUM_NEARBY)
        return Number.isFinite(nl) && nl > 0 ? Math.min(nl, 10) : 3
      })(),
    },
  })
  for (const def of defs) disposers.push(ctx.tools.register(def))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
