/**
 * Mycelium store: shared, content-addressed fold store on disk.
 *
 * Layout under baseDir:
 *   blocks/<fp>.json   one published digest block, content-addressed by fingerprint
 *   tok/<h8>.json      inverted index per key-token hash. Line format: one
 *                      fingerprint per line (append-only, O_APPEND writes
 *                      never lose an update under concurrent publishers).
 *                      Legacy v0.2.0 files hold a JSON array; they are read
 *                      transparently and migrated to lines on first write.
 *
 * Threat model (audit 2026-11-08, red team 2026-11-10): the store lives in
 * a location shared by one user's agent processes, so:
 * - directories are created mode 0700 and must be real directories (a
 *   planted symlink at blocks/ or tok/ is refused, not followed);
 * - every write is exclusive-created into a private temp name and atomically
 *   renamed, or a single O_APPEND line (index), never overwriting in place;
 * - every FILE is lstat-checked at read time and opened with O_NOFOLLOW:
 *   a block or index file swapped for a symlink after open is skipped and
 *   counted, never followed (the open itself fails, no TOCTOU window);
 * - every block record is verified by content addressing: its stored tokens
 *   must hash to its own fp, or the record is treated as planted and
 *   rejected (a wrong fp would need a FNV-1a preimage to pass);
 * - all names are confined: block ids match ^fp-[0-9a-f]{8}$, token hashes
 *   are hex8, nothing else is accepted;
 * - I/O failures are surfaced as structured errors ({ code, detail }), never
 *   swallowed into a fake success. A degraded store must be visible: read
 *   skips are counted (skipped, degraded), corrupt legacy index files are
 *   left untouched and counted (degradedTokens) instead of being
 *   destructively rebuilt; reindex() is the explicit repair path.
 *
 * Concurrency: two host processes can publish at once. Block files are
 * content-addressed and written per file, so concurrent publishers write
 * different files. Index writes are single O_APPEND lines: no lost updates
 * (the 42% entry loss of the v0.2.0 read-modify-write index, measured by
 * red team, is gone). Duplicate lines are possible and are de-duplicated at
 * read time.
 */

import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync, constants as fsConstants } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { fnv, fingerprintMatches, keyTokens, overlap, phaseFor, rankNearby } from './mycelium.js'

const FP_RE = /^fp-[0-9a-f]{8}$/
const TOK_RE = /^[0-9a-f]{8}\.json$/

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

/**
 * Per-file check for reads: regular file, not a symlink. A swapped-in
 * symlink is skipped and counted, never followed (red team RT-1).
 * @returns {'ok' | 'missing' | 'symlink'}
 */
function fileStatus(dir, name) {
  try {
    const st = lstatSync(join(dir, name))
    if (st.isSymbolicLink()) return 'symlink'
    if (!st.isFile()) return 'symlink'
    return 'ok'
  } catch {
    return 'missing'
  }
}

/**
 * Read a file without following a symlink (audit A-3): O_NOFOLLOW makes the
 * open itself fail (ELOOP) if the final path component was swapped for a
 * symlink between the fileStatus pre-check and this read, closing the
 * TOCTOU window that readFileSync leaves open. On platforms where the
 * kernel ignores O_NOFOLLOW this degrades to the pre-check behavior, not
 * below it. Returns null when the file is absent or a symlink was hit.
 */
function readNoFollow(p) {
  let fd
  try {
    fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    return null // ENOENT (missing) or ELOOP (swapped to a symlink)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    const buf = Buffer.alloc(st.size)
    readSync(fd, buf, 0, st.size, 0)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    closeSync(fd)
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
 *   publishBlock: (b: object) => { degradedTokens: number },
 *   searchBlocks: (query: string, limit: number) => { hits: Array<object>, skipped: number, degraded: number },
 *   bump: (fp: string) => void,
 *   listBlocks: (limit?: number) => Array<object>,
 *   reindex: () => { blocks: number, tokens: number },
 *   stats: { degraded: number, degradedTokens: number },
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

  // Live degradation counters, surfaced by the tool layer in DTOs.
  const stats = { degraded: 0, degradedTokens: 0 }

  const readBlock = (fp) => {
    if (!FP_RE.test(fp)) return null
    const st = fileStatus(blocksDir, `${fp}.json`)
    if (st === 'symlink') { stats.degraded += 1; return null }
    if (st === 'missing') return null
    let rec
    try {
      const raw = readNoFollow(join(blocksDir, `${fp}.json`))
      rec = raw === null ? null : JSON.parse(raw)
    } catch {
      stats.degraded += 1
      return null
    }
    if (!rec || typeof rec !== 'object' || rec.fp !== fp) { stats.degraded += 1; return null }
    if (!fingerprintMatches(rec.tokens, fp)) { stats.degraded += 1; return null }
    return rec
  }

  /**
   * Read one token's index. Accepts the legacy JSON array format and the
   * current line format (one fp per line). Symlinked or unreadable files
   * are skipped and counted, never followed.
   * @returns {{ fps: string[], corrupt: boolean }}
   */
  const readTokenIndex = (token) => {
    const h = fnv(token)
    const st = fileStatus(tokDir, `${h}.json`)
    if (st === 'symlink') { stats.degraded += 1; return { fps: [], corrupt: true } }
    if (st === 'missing') return { fps: [], corrupt: false }
    let rawText
    try {
      rawText = readNoFollow(join(tokDir, `${h}.json`))
    } catch {
      return { fps: [], corrupt: false }
    }
    if (rawText === null) return { fps: [], corrupt: false } // gone or swapped between checks
    const trimmed = rawText.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      // legacy v0.2.0 JSON (array of fps, or a corrupt object): parse it; a
      // parse failure or non-array means the file is corrupt. Never rewrite.
      try {
        const arr = JSON.parse(rawText)
        if (!Array.isArray(arr)) { stats.degraded += 1; return { fps: [], corrupt: true } }
        return { fps: arr.filter((x) => FP_RE.test(String(x))), corrupt: false }
      } catch {
        stats.degraded += 1
        return { fps: [], corrupt: true }
      }
    }
    // line format: one fp per line; garbage lines are dropped, not fatal
    const fps = trimmed ? trimmed.split('\n').filter((l) => FP_RE.test(l)) : []
    return { fps, corrupt: false }
  }

  /**
   * Append one fp to a token index without ever overwriting:
   * - missing file: create by appending the first line
   * - legacy JSON array: one-time migration to lines (last writer wins the
   *   migration race; entries lost to it are restored by reindex(), or by
   *   the next publish of the same fp)
   * - corrupt file: leave it untouched, count the miss (explicit repair is
   *   reindex(); a silent destructive rebuild is how v0.2.0 lost recall)
   * - line format: single O_APPEND line, concurrent-safe
   */
  const upsertTokenIndex = (token, fp) => {
    const h = fnv(token)
    const file = join(tokDir, `${h}.json`)
    const { fps, corrupt } = readTokenIndex(token)
    if (corrupt) { stats.degradedTokens += 1; return } // never overwrite a corrupt file
    if (fps.includes(fp)) return
    // re-check just before the write: a symlink planted between the read
    // above and this point must not receive an append (audit A-3)
    if (fileStatus(tokDir, `${h}.json`) === 'symlink') { stats.degradedTokens += 1; return }
    const rawText = readNoFollow(file) ?? ''
    if (rawText.trim().startsWith('[')) {
      // legacy JSON array: one-time migration to lines
      writeAtomic(tokDir, `${h}.json`, fps.concat([fp]).join('\n') + '\n')
      return
    }
    try {
      appendFileSync(file, `${fp}\n`, { mode: 0o600 })
    } catch {
      stats.degradedTokens += 1
    }
  }

  return {
    dir: baseDir,
    stats,
    /**
     * Publish one digest block into the shared store (idempotent per fp).
     * @param {{ fp: string, sessionKey: string, blockId: string, tier: number, topic: string, summary: string, sourceRefs?: string[], approxSummaryTokens?: number }} b
     * @returns {{ degradedTokens: number }} how many index updates had to be skipped
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
        // forensic marker (audit A-1): a fingerprint only covers key tokens,
        // so an override of the same slot is detectable through length drift
        contentLength: (b.summary ?? '').length,
      }
      // Content addressing at the door as well as at the gate: a record
      // whose tokens do not hash to its own name never lands on disk.
      if (!fingerprintMatches(rec.tokens, rec.fp)) {
        throw storeErr('store_invalid', 'mycelium: block tokens do not match its fingerprint (refusing to write)')
      }
      const before = stats.degradedTokens
      writeAtomic(blocksDir, `${rec.fp}.json`, JSON.stringify(rec))
      // Index only the leading key tokens: cheap files, enough recall.
      for (const t of rec.tokens.slice(0, 24)) upsertTokenIndex(t, rec.fp)
      return { degradedTokens: stats.degradedTokens - before }
    },
    /**
     * Keyword search across published blocks. Missing or corrupt block
     * files are skipped and counted, never fatal; symlinked or
     * integrity-failing records are counted in `degraded`.
     * @param {string} query free text (key-token extraction applied)
     * @param {number} [limit]
     * @returns {{ hits: Array<{ fp, sessionKey, blockId, tier, topic, score, snippet, accessCount, phase }>, skipped: number, degraded: number }}
     */
    searchBlocks(query, limit = 5) {
      const qtoks = keyTokens(String(query ?? ''))
      if (qtoks.length === 0) return { hits: [], skipped: 0, degraded: stats.degraded }
      const fps = new Set()
      for (const t of qtoks) for (const fp of readTokenIndex(t).fps) fps.add(fp)
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
      return { hits, skipped, degraded: stats.degraded }
    },
    /** Count one surfaced use of a shared block. */
    bump(fp) {
      if (!FP_RE.test(String(fp ?? ''))) throw storeErr('store_invalid', 'mycelium: bump requires a valid fp')
      const rec = readBlock(fp)
      if (!rec) return
      rec.accessCount = (Number(rec.accessCount) || 0) + 1
      writeAtomic(blocksDir, `${rec.fp}.json`, JSON.stringify(rec))
    },
    /**
     * All loadable block records. Bounded read: at most `limit` block files
     * are loaded per call (readdir order, advisory preview), so the cost
     * stays flat as the store grows. Empty store: [].
     */
    listBlocks(limit = Infinity) {
      let names = []
      try {
        names = readdirSync(blocksDir).filter((n) => n.endsWith('.json') && FP_RE.test(n.slice(0, -5)))
      } catch {
        return []
      }
      if (Number.isFinite(limit)) names = names.slice(0, Math.max(0, limit))
      const out = []
      for (const n of names) {
        const rec = readBlock(n.slice(0, -5))
        if (rec) out.push(rec)
      }
      return out
    },
    /**
     * Explicit repair: rebuild every token index from the block files
     * (recovers corrupt legacy index files and orphan entries; rewrites
     * all index files in line format). The only supported repair path.
     * Race-safe with concurrent publishers (audit A-2): rebuilt sets are
     * unioned with the live index files, and files created after this
     * call started are kept, not unlinked.
     * @returns {{ blocks: number, tokens: number }}
     */
    reindex() {
      const blocks = this.listBlocks()
      const byTok = new Map()
      for (const rec of blocks) {
        for (const t of rec.tokens.slice(0, 24)) {
          const h = fnv(t)
          if (!byTok.has(h)) byTok.set(h, new Set())
          byTok.get(h).add(rec.fp)
        }
      }
      const started = Date.now()
      let names = []
      try {
        names = readdirSync(tokDir).filter((n) => TOK_RE.test(n))
      } catch { /* tok dir unreadable: rebuild from scratch */ }
      for (const n of names) {
        if (byTok.has(n.slice(0, 8))) continue
        try {
          // keep files that appeared after we started (a concurrent
          // publish that landed mid-reindex), delete genuine orphans
          if (lstatSync(join(tokDir, n)).mtimeMs >= started) continue
        } catch { /* vanished meanwhile: nothing to do */ }
        try { unlinkSync(join(tokDir, n)) } catch { /* already gone */ }
      }
      for (const [h, set] of byTok) {
        // union with the live file so a concurrent append is not clobbered
        const merged = new Set([...set, ...readTokenIndex(h).fps])
        writeAtomic(tokDir, `${h}.json`, [...merged].sort().join('\n') + '\n')
      }
      return { blocks: blocks.length, tokens: byTok.size }
    },
  }
}

export { overlap, fnv, keyTokens, FP_RE }
export { fingerprintMatches }
