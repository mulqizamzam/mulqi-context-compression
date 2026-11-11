/**
 * Mulqi Context Compression: environment configuration surface.
 *
 * One place where the process environment is read, shared by the tools
 * entry (index.js) and the auto fold engine entry (compaction-engine.js)
 * so both entries always derive the same store and auto settings.
 */

import path from 'node:path'
import { homedir } from 'node:os'

/**
 * Shared cross-session fold store (the mycelium) configuration.
 * Publishing own blocks into the store is off by default (privacy); a
 * configured store is readable for recall without being enabled.
 */
export function mulqiMyceliumConfig(env = process.env) {
  return {
    dir:
      (env.MULQI_CC_MYCELIUM_DIR ?? '').trim() ||
      (env.DSH_HOME
        ? path.join(env.DSH_HOME, 'mulqi-cc-mycelium')
        : path.join(homedir(), '.dsh', 'mulqi-cc-mycelium')),
    publish: env.MULQI_CC_MYCELIUM_PUBLISH === '1' || env.MULQI_CC_MYCELIUM_PUBLISH === 'true',
    nearbyLimit: (() => {
      const nl = Number(env.MULQI_CC_MYCELIUM_NEARBY)
      return Number.isFinite(nl) && nl > 0 ? Math.min(nl, 10) : 3
    })(),
  }
}

/** Digest mode of the auto fold engine: 'llm' (default) or 'mechanical'. */
export function mulqiAutoMode(env = process.env) {
  return env.MULQI_CC_AUTO_MODE === 'mechanical' ? 'mechanical' : 'llm'
}

/**
 * Tier-1 cap applied to AUTO fold blocks (model-authored blocks keep the
 * documented ~2K default). Floors at the documented default so the env
 * can only raise the cap, never shrink it.
 */
export function mulqiAutoCapTokens(env = process.env) {
  const v = Number(env.MULQI_CC_AUTO_MAX_TOKENS)
  return Number.isFinite(v) && v > 2048 ? Math.floor(v) : 4096
}
