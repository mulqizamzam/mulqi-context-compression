/**
 * Mycelium: pure layer of the cross-session fold store.
 * No I/O, no clock, no dependencies. Everything here is deterministic so
 * fingerprints stay stable across processes and host restarts.
 *
 * The "mycelium" is a shared, content-addressed store of folded digest
 * blocks. Each block carries a DNA fingerprint (key tokens of its
 * topic + summary). Other sessions can find related prior work by
 * token overlap, without re-deriving it.
 */

/** Minimal stopword set for key-token extraction. Boring, boring words
 *  carry no DNA. Everything with 4+ letters that is not a stopword
 *  counts as a key token. */
const STOP = new Set([
  'the', 'and', 'with', 'from', 'that', 'this', 'for', 'into', 'are',
  'was', 'not', 'you', 'your', 'has', 'have', 'will', 'can', 'but',
  'all', 'one', 'two', 'then', 'than', 'when', 'which', 'were', 'over',
  'under', 'about', 'after', 'before', 'because', 'while', 'each',
  'some', 'other', 'the', 'its', 'their', 'them', 'new', 'old', 'use',
  'used', 'using', 'see', 'now', 'also', 'still', 'only', 'must',
])

/** Max key tokens kept per fingerprint. Keeps store files small. */
export const MAX_TOKENS = 64

/** Jaccard floor for a "nearby" suggestion. Below this, overlap is noise. */
export const NEARBY_THRESHOLD = 0.15

/**
 * Extract normalized key tokens from free text.
 * Lower-cased, split on non [a-z0-9_], min length 4, stopword-filtered,
 * de-duplicated in first-seen order, capped at MAX_TOKENS.
 * @param {string} text
 * @returns {string[]}
 */
export function keyTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const seen = new Set()
  const out = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 4 || STOP.has(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
    if (out.length >= MAX_TOKENS) break
  }
  return out
}

/** FNV-1a 32-bit string hash, hex. Stable across platforms. */
export function fnv(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Content-addressed DNA of a digest block.
 * @param {string} topic block topic line
 * @param {string} summary the folded digest text
 * @returns {{ id: string, tokens: string[] }} id = "fp-" + 8-hex
 */
export function fingerprint(topic, summary) {
  const tokens = keyTokens(`${typeof topic === 'string' ? topic : ''}\n${typeof summary === 'string' ? summary : ''}`)
  return { id: `fp-${fnv([...new Set(tokens)].sort().join('|'))}`, tokens }
}

/** Jaccard overlap of two token sets. */
export function overlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0
  const A = new Set(a)
  const B = new Set(b)
  let inter = 0
  for (const t of A) if (B.has(t)) inter += 1
  const uni = A.size + B.size - inter
  return uni === 0 ? 0 : inter / uni
}

/**
 * Content-addressing check: does this token multiset produce this fingerprint?
 * A block file whose stored tokens do not hash to its own name is planted or
 * tampered and must be rejected at read time (red team 2026-11-10, RT-1).
 * @param {string[]} tokens the record's key tokens
 * @param {string} fp the block id the record claims
 * @returns {boolean}
 */
export function fingerprintMatches(tokens, fp) {
  if (!Array.isArray(tokens) || tokens.length === 0) return false
  if (typeof fp !== 'string' || !/^fp-[0-9a-f]{8}$/.test(fp)) return false
  const clean = tokens.filter((t) => typeof t === 'string')
  const id = `fp-${fnv([...new Set(clean)].sort().join('|'))}`
  return id === fp
}

/**
 * Rank store entries against a candidate token set.
 * @param {string[]} candidate key tokens of what is being done now
 * @param {Array<{fp: string, tokens?: string[]}>} entries store records
 * @param {number} [limit] max results
 * @returns {Array<{fp: string, score: number}>} best first, stable by fp on ties
 */
export function rankNearby(candidate, entries, limit = 3) {
  if (!Array.isArray(candidate) || candidate.length === 0) return []
  const scored = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.fp === 'string')
    .map((e) => ({ fp: e.fp, score: overlap(candidate, e.tokens ?? keyTokens(e.topic ?? '')) }))
    .filter((e) => e.score >= NEARBY_THRESHOLD)
  scored.sort((x, y) => y.score - x.score || (x.fp < y.fp ? -1 : x.fp > y.fp ? 1 : 0))
  return limit > 0 ? scored.slice(0, limit) : scored
}

/**
 * Fidelity phase of a block, derived deterministically (no clock).
 * - deactivated blocks and tier-2 distillations are archived: a phase
 *   boundary has passed, they stay restorable but are out of the working set.
 * - active blocks nobody has reopened are dormant: folded, untouched.
 * - blocks that have been reopened at least once are active (hot).
 * @param {{ active?: boolean, tier?: number }} block
 * @param {{ accesses?: number }} [stats]
 * @returns {'archived' | 'dormant' | 'active'}
 */
export function phaseFor(block, stats = {}) {
  if (!block || block.active === false || block.tier === 2) return 'archived'
  if ((stats.accesses ?? 0) > 0) return 'active'
  return 'dormant'
}
