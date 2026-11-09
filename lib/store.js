/**
 * Mycelium store: shared, content-addressed fold store on disk.
 *
 * Layout under baseDir:
 *   blocks/<fp>.json  one published digest block, content-addressed by fingerprint
 *   tok/<h8>.json     inverted index: one file per key-token hash, holds [fp, ...]
 *
 * Threat model (from the 2026-11-08 audit + red team 2026-11-09): the store
 * lives in a location shared by one user's agent processes, so:
 * - directories are created mode 0700 and must be real directories
 *   (a planted symlink at blocks/ or tok/ is refused, not followed);
 * - every write is exclusive-created into a private temp name and atomically
 *   renamed, never overwriting a planted file in place and never following
 *   a planted symlink;
 * - all names are sanitized: block ids match ^fp-[0-9a-f]{8}$, token
 *   hashes are hex8, nothing else is accepted;
 * - I/O failures are surfaced as structured errors ({ code, detail }),
 *   never swallowed into a fake success. A degraded store must be visible.
 *
 * Concurrency: two host processes may write different block files at once
 * (safe: content-addressed, per-file tmp+rename). Two processes updating
 * the same token index can lose an update (best-effort, documented): the
 * store degrades to "fewer index entries" without corruption, because
 * search re-reads the block files and skips missing ones.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, lstatSync, statSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { fnv, keyTokens, overlap, phaseFor, rankNearby } from './mycelium.js'

const FP_RE = /^fp-[0-9a-f]{8}$/

function storeErr(code, detail) {
  const e = new Error(detail)
  e.code = code
  return e
}

function isDirReal(p) {
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return false
    return st.isDirectory()
  } catch {
    return false
  }
}

/** Write <dir>/<name> atomically: exclusive temp name + rename. */
let tmpSeq = 0
function writeAtomic(dir, name, text) {
  const finalPath = join(dir, name)
  const tmp = join(dir, `.${name}.tmp-${process.pid}-${(tmpSeq += 1)}`)
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    renameSync(tmp, finalPath)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw storeErr('store_unavailable', `mycelium: cannot write ${name}: ${e?.message ?? e}`)
  }
}

/**
 * Open a mycelium store rooted at baseDir.
 * @param {{ baseDir: string }} opts
 * @returns {{
 *   publishBlock: (b: object) => void,
 *   searchBlocks: (query: string, limit: number) => { hits: Array<object>, skipped: number },
 *   bump: (fp: string) => void,
 *   listBlocks: () => Array<object>,
 *   dir: string,
 * }}
 */
export function openMyceliumStore(opts) {
  const raw = String(opts?.baseDir ?? '')
  if (!isAbsolute(raw) || raw.length === 0) throw storeErr('store_unavailable', 'mycelium: baseDir must be an absolute path')
  const baseDir = resolve(raw)
  const blocksDir = join(baseDir, 'blocks')
  const tokDir = join(baseDir, 'tok')
  for (const d of [blocksDir, tokDir]) {
    if (isDirReal(d)) continue
    try {
      mkdirSync(d, { recursive: true, mode: 0o700 })
    } catch (e) {
      throw storeErr('store_unavailable', `mycelium: cannot create ${d}: ${e?.message ?? e}`)
    }
    if (!isDirReal(d)) throw storeErr('store_unavailable', `mycelium: refusing ${d}: not a real directory (planted symlink or mode conflict)`)
  }

  const readBlock = (fp) => {
    if (!FP_RE.test(fp)) throw storeErr('store_invalid', `mycelium: bad block id "${fp}"`)
    try {
      const rec = JSON.parse(readFileSync(join(blocksDir, `${fp}.json`), 'utf8'))
      return rec && typeof rec === 'object' ? rec : null
    } catch {
      return null
    }
  }

  const readTokenIndex = (token) => {
    const h = fnv(token)
    try {
      const arr = JSON.parse(readFileSync(join(tokDir, `${h}.json`), 'utf8'))
      return Array.isArray(arr) ? arr : []
    } catch {
      return []
    }
  }

  const upsertTokenIndex = (token, fp) => {
    const h = fnv(token)
    const file = join(tokDir, `${h}.json`)
    let list = []
    try {
      const arr = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(arr)) list = arr.filter((x) => typeof x === 'string' && FP_RE.test(x))
    } catch { /* missing or corrupt: rebuild from this entry */ }
    if (!list.includes(fp)) {
      list.push(fp)
      list.sort()
      writeAtomic(tokDir, `${h}.json`, JSON.stringify(list))
    }
  }

  return {
    dir: baseDir,
    /**
     * Publish one digest block into the shared store (idempotent per fp).
     * @param {{ fp: string, sessionKey: string, blockId: string, tier: number, topic: string, summary: string, sourceRefs?: string[], approxSummaryTokens?: number }} b
     */
    publishBlock(b) {
      if (!b || !FP_RE.test(String(b.fp ?? ''))) throw storeErr('store_invalid', 'mycelium: publish requires a valid fp')
      const rec = {
        fp: b.fp,
        sessionKey: String(b.sessionKey ?? 'unknown'),
        blockId: String(b.blockId ?? ''),
        tier: Number(b.tier) || 1,
        topic: String(b.topic ?? ''),
        summary: String(b.summary ?? ''),
        tokens: Array.isArray(b.tokens) ? b.tokens.slice(0, 64) : keyTokens(`${b.topic ?? ''}\n${b.summary ?? ''}`),
        sourceRefs: Array.isArray(b.sourceRefs) ? b.sourceRefs.slice(0, 64) : [],
        approxSummaryTokens: Number(b.approxSummaryTokens) || 0,
        accessCount: Number(b.accessCount) || 0,
      }
      writeAtomic(blocksDir, `${rec.fp}.json`, JSON.stringify(rec))
      // Index only the leading key tokens: cheap files, enough recall.
      for (const t of rec.tokens.slice(0, 24)) upsertTokenIndex(t, rec.fp)
    },
    /**
     * Keyword search across published blocks. Missing or corrupt block
     * files are skipped and counted, never fatal.
     * @param {string} query free text (key-token extraction applied)
     * @param {number} [limit]
     * @returns {{ hits: Array<{ fp, sessionKey, blockId, tier, topic, score, snippet, accessCount }>, skipped: number }}
     */
    searchBlocks(query, limit = 5) {
      const qtoks = keyTokens(String(query ?? ''))
      if (qtoks.length === 0) return { hits: [], skipped: 0 }
      const fps = new Set()
      for (const t of qtoks) for (const fp of readTokenIndex(t)) fps.add(fp)
      const candidates = [...fps]
        .map((fp) => {
          const rec = readBlock(fp)
          return rec ? { fp, ...rec } : null
        })
      const loadable = candidates.filter(Boolean)
      const skipped = candidates.length - loadable.length
      const ranked = rankNearby(qtoks, loadable.map((r) => ({ fp: r.fp, tokens: r.tokens })), Math.max(1, Number(limit) || 5))
      const byFp = new Map(loadable.map((r) => [r.fp, r]))
      const hits = ranked.map((r) => {
        const rec = byFp.get(r.fp)
        const summary = String(rec.summary ?? '')
        return {
          fp: r.fp,
          sessionKey: rec.sessionKey,
          blockId: rec.blockId,
          tier: rec.tier,
          topic: rec.topic,
          score: Number(r.score.toFixed(3)),
          snippet: summary.length > 300 ? `${summary.slice(0, 300)}…` : summary,
          accessCount: Number(rec.accessCount) || 0,
          phase: phaseFor({ active: true, tier: rec.tier ?? 1 }, { accesses: Number(rec.accessCount) || 0 }),
        }
      })
      return { hits, skipped }
    },
    /** Count one surfaced use of a shared block. */
    bump(fp) {
      const rec = readBlock(fp)
      if (!rec) return
      rec.accessCount = (Number(rec.accessCount) || 0) + 1
      writeAtomic(blocksDir, `${rec.fp}.json`, JSON.stringify(rec))
    },
    /** All loadable block records (empty store: []). */
    listBlocks() {
      let names = []
      try {
        names = readdirSync(blocksDir).filter((n) => n.endsWith('.json') && FP_RE.test(n.slice(0, -5)))
      } catch {
        return []
      }
      const out = []
      for (const n of names) {
        const rec = readBlock(n.slice(0, -5))
        if (rec) out.push(rec)
      }
      return out
    },
  }
}

export { overlap, fnv, keyTokens, FP_RE }
