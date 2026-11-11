/**
 * Mycelium tests: pure DNA layer, shared store I/O, and tool integration.
 * Follows the audit + red-team discipline: every failure path is asserted
 * to surface, never to silently succeed.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync, lstatSync, chmodSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { keyTokens, fingerprint, overlap, rankNearby, phaseFor, fnv, NEARBY_THRESHOLD } from '../lib/mycelium.js'
import { openMyceliumStore } from '../lib/store.js'
import { createFold, ingest, recordBlock, decompressBlock } from '../lib/fold.js'
import { createFoldTools } from '../lib/tools.js'
import { _resetRegistryForTests } from '../lib/fold-registry.js'

// ---------- pure DNA layer ----------

test('keyTokens: lowercase, 4+ chars, stopword-filtered, capped, stable order', () => {
  const toks = keyTokens('Build Fix + Verification: pnpm test showed 3 flakes, sqlite lock timeout (see m00088)')
  assert.ok(toks.includes('build'))
  assert.ok(toks.includes('verification'))
  assert.ok(toks.includes('sqlite'))
  assert.ok(!toks.includes('the')) // stopword
  assert.ok(!toks.includes('m00088'.slice(0, 2))) // short tokens dropped
  assert.equal(toks.length, keyTokens('Build Fix + Verification: pnpm test showed 3 flakes, sqlite lock timeout (see m00088)').length)
  assert.ok(toks.length <= 64)
})

test('keyTokens: empty and non-string input are safe', () => {
  assert.deepEqual(keyTokens(''), [])
  assert.deepEqual(keyTokens(null), [])
  assert.deepEqual(keyTokens(undefined), [])
})

test('fingerprint: deterministic, content-addressed, distinct for distinct content', () => {
  const a = fingerprint('build fix', 'pnpm test shows sqlite lock timeout in ci')
  const b = fingerprint('build fix', 'pnpm test shows sqlite lock timeout in ci')
  const c = fingerprint('migration', 'postgres v2 cutover completed')
  assert.equal(a.id, b.id)
  assert.notEqual(a.id, c.id)
  assert.match(a.id, /^fp-[0-9a-f]{8}$/)
  // order-independence: same key-token multiset, different surface order, same fingerprint
  const d = fingerprint('build fix', 'in ci sqlite lock timeout pnpm test shows')
  assert.equal(a.id, d.id, 'same key tokens, any order, same fingerprint')
})

test('fnv: stable 8-hex string hash', () => {
  assert.equal(fnv('abc'), fnv('abc'))
  assert.notEqual(fnv('abc'), fnv('abd'))
  assert.match(fnv('x'), /^[0-9a-f]{8}$/)
})

test('overlap: jaccard bounds and monotonicity', () => {
  assert.equal(overlap(['a', 'b'], ['a', 'b']), 1)
  assert.equal(overlap(['a'], ['b']), 0)
  assert.equal(overlap([], ['a']), 0)
  const close = overlap(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'e'])
  const far = overlap(['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h'])
  assert.ok(close > far)
})

test('rankNearby: ranks by score, applies threshold and limit, ties break by fp', () => {
  const entries = [
    { fp: 'fp-aaaaaaaa', tokens: ['sqlite', 'lock', 'timeout', 'ci'] },
    { fp: 'fp-99999999', tokens: ['sqlite', 'lock', 'timeout', 'ci'] },
    { fp: 'fp-bbbbbbbb', tokens: ['zulu', 'alpha'] },
  ]
  const cand = ['sqlite', 'lock', 'timeout']
  const ranked = rankNearby(cand, entries, 10)
  assert.equal(ranked.length, 2, 'unrelated entry below threshold is dropped')
  assert.ok(ranked[0].score >= ranked[1].score)
  assert.equal(ranked[0].fp, 'fp-99999999', 'tie broken by ascending fp (9 < a)')
  assert.ok(ranked[0].score >= NEARBY_THRESHOLD)
  assert.deepEqual(rankNearby([], entries), [])
  assert.deepEqual(rankNearby(cand, []), [])
})

test('phaseFor: truth table (archived > active > dormant)', () => {
  assert.equal(phaseFor({ active: true, tier: 1 }, { accesses: 0 }), 'dormant')
  assert.equal(phaseFor({ active: true, tier: 1 }, { accesses: 3 }), 'active')
  assert.equal(phaseFor({ active: false, tier: 1 }, { accesses: 9 }), 'archived', 'deactivated wins regardless of accesses')
  assert.equal(phaseFor({ active: true, tier: 2 }, { accesses: 5 }), 'archived', 'tier-2 is a phase boundary')
  assert.equal(phaseFor(null), 'archived')
})

// ---------- shared store I/O ----------

const mkStore = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-'))
  return { dir, store: openMyceliumStore({ baseDir: dir }) }
}

/** fingerprint() yields { id, tokens }; store records take { fp, tokens, ... }. */
const publish = (store, dna, extra) => store.publishBlock({ fp: dna.id, tokens: dna.tokens, ...extra })

test('store: publish + search round-trip', () => {
  const { dir, store } = mkStore()
  try {
    const dna = fingerprint('build fix', 'sqlite lock timeout in ci')
    publish(store, dna, {
      sessionKey: 'agent-x',
      blockId: 'blk00001',
      tier: 1,
      topic: 'build fix',
      summary: 'sqlite lock timeout in ci',
      sourceRefs: ['m00001'],
      approxSummaryTokens: 42,
    })
    const r = store.searchBlocks('sqlite timeout build')
    assert.equal(r.hits.length, 1)
    assert.equal(r.hits[0].fp, dna.id)
    assert.equal(r.hits[0].sessionKey, 'agent-x')
    assert.equal(r.hits[0].topic, 'build fix')
    assert.ok(r.hits[0].score > 0)
    assert.ok(r.hits[0].phase === 'dormant', 'freshly published, untouched')
    assert.equal(r.skipped, 0)
    assert.equal(store.listBlocks().length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store: search on empty store is an honest empty result, not an error', () => {
  const { dir, store } = mkStore()
  try {
    const r = store.searchBlocks('anything at all')
    assert.deepEqual(r, { hits: [], skipped: 0, degraded: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store: corrupt token index degrades gracefully (skipped counts missing blocks)', () => {
  const { dir, store } = mkStore()
  try {
    const dna = fingerprint('postgres cutover', 'migration v2 verified green')
    publish(store, dna, { sessionKey: 's1', blockId: 'blk00001', tier: 1, topic: 'postgres cutover', summary: 'migration v2 verified green' })
    // corrupt the index entry for the query token 'cutover': point it at a missing fp
    writeFileSync(path.join(dir, 'tok', `${fnv('cutover')}.json`), JSON.stringify(['fp-deadbeef']), 'utf8')
    const r = store.searchBlocks('postgres cutover verified')
    assert.equal(r.skipped, 1, 'index pointed at a missing block file')
    assert.ok(!r.hits.some((h) => h.fp === 'fp-deadbeef'), 'the missing block never becomes a hit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store: bump increments accessCount and flips phase to active', () => {
  const { dir, store } = mkStore()
  try {
    const dna = fingerprint('flakes', '3 flaky tests retried and green')
    publish(store, dna, { sessionKey: 's1', blockId: 'blk00002', tier: 1, topic: 'flakes', summary: '3 flaky tests retried and green' })
    store.bump(dna.id)
    store.bump(dna.id)
    const r = store.searchBlocks('flaky tests retried')
    assert.equal(r.hits[0].accessCount, 2)
    assert.equal(r.hits[0].phase, 'active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store: rejects block ids outside the fp-<hex8> namespace (path confinement)', () => {
  const { dir, store } = mkStore()
  try {
    assert.throws(() => store.publishBlock({ fp: '../escape', topic: 'x', summary: 'y' }), (e) => e.code === 'store_invalid')
    assert.throws(() => store.bump('..'), (e) => e.code === 'store_invalid')
    const bad = dir.replace(/blocks$/, 'blocks/../evil')
    assert.ok(!readdirSync(dir).includes('evil'), 'no path escape materialized on disk')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store: a planted symlink where blocks/ should be is refused, never followed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-sym-'))
  const evil = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-sym-evil-'))
  try {
    // blocks/ does not exist yet; plant a symlink in its place
    symlinkSync(evil, path.join(dir, 'blocks'))
    let threw = null
    try {
      openMyceliumStore({ baseDir: dir })
    } catch (e) {
      threw = e
    }
    assert.ok(threw, 'opening a symlinked store must fail')
    assert.equal(threw.code, 'store_unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(evil, { recursive: true, force: true })
  }
})

test('store: baseDir must be absolute and writable', () => {
  assert.throws(() => openMyceliumStore({ baseDir: 'relative/path' }), (e) => e.code === 'store_unavailable')
  const nodir = path.join(tmpdir(), 'mcc-mycelium-node')
  writeFileSync(nodir, 'i am a file, not a directory')
  assert.throws(() => openMyceliumStore({ baseDir: nodir }), (e) => e.code === 'store_unavailable')
  rmSync(nodir, { force: true })
})

// ---------- tool integration ----------

function hostWithStore({ storeDir, publish }) {
  // Test-only isolation: the fold registry is process-wide in production
  // (shared by the tools and engine entries); each fixture call gets a
  // clean one so fold state never leaks between tests in this file.
  _resetRegistryForTests()
  const readMessages = async (key) => foldEvents[key] ?? []
  const sessionKeyFor = () => 'agent-a'
  const tools = createFoldTools({
    readMessages,
    sessionKeyFor,
    mycelium: storeDir ? { dir: storeDir, publish: !!publish, nearbyLimit: 3 } : undefined,
  })
  // DSH defs carry the full tool name; key the map by the short suffix
  const byName = {}
  for (const t of tools) byName[t.name.replace(/^mulqi_cc_/, '')] = t
  return { byName }
}

// Host readMessages returns DSH surface events, not flat messages.
// 8 events: with default recentZoneMessages=5 the recent zone starts at
// index 3, so m00002-m00003 (indices 1-2) are the compressible range.
// m00001 (first user message) and m00008 (last user message) stay protected.
const foldEvents = {
  'agent-a': [
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Fix the build and verify with pnpm test' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I will inspect the failing module output.' }] } } },
    { seq: 3, type: 'tool/result', data: { message: { toolName: 'bash', content: [{ type: 'text', text: 'sqlite lock timeout in ci, flake on the second run' }] } } },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Documented the lock timeout flake' }] } } },
    { seq: 5, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Now backfill the data' }] } },
    { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Writing the backfill script' }] } } },
    { seq: 7, type: 'tool/result', data: { message: { toolName: 'bash', content: [{ type: 'text', text: 'backfill script ran, 412 rows moved' }] } } },
    { seq: 8, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Verify the backfill' }] } },
  ],
}

test('tools: compress publishes into the store only when publish is on', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-off-'))
  try {
    const { byName } = hostWithStore({ storeDir: dir, publish: false })
    const out = await byName.compress.execute(
      { fromRef: 'm00002', toRef: 'm00003', topic: 'build fix', summary: 'sqlite lock timeout in ci, documented as flake' },
      {},
    )
    assert.equal(out.ok, true)
    assert.equal(out.mycelium, 'off', 'publish off: no store write, DTO says so')
    // the store may not even have been opened yet (lazy), so guard the scan
    const blocksDir = path.join(dir, 'blocks')
    const blockFiles = existsSync(blocksDir) ? readdirSync(blocksDir).filter((n) => n.endsWith('.json')) : []
    assert.equal(blockFiles.length, 0, 'nothing was written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tools: compress with publish on writes one block; store failure is surfaced, never swallowed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-on-'))
  try {
    const { byName } = hostWithStore({ storeDir: dir, publish: true })
    const out = await byName.compress.execute(
      { fromRef: 'm00002', toRef: 'm00003', topic: 'build fix', summary: 'sqlite lock timeout in ci, documented as flake' },
      {},
    )
    assert.equal(out.ok, true)
    assert.equal(out.mycelium, 'ok')
    assert.equal(readdirSync(path.join(dir, 'blocks')).filter((n) => n.endsWith('.json')).length, 1)

    // break the store in a root-safe way: swap the blocks dir for a plain
    // file. A fresh handle must refuse to open it, and the failure must be
    // surfaced in the DTO instead of hidden (chmod cannot block root).
    rmSync(path.join(dir, 'blocks'), { recursive: true, force: true })
    writeFileSync(path.join(dir, 'blocks'), 'not a directory')
    const broken = hostWithStore({ storeDir: dir, publish: true })
    const out2 = await broken.byName.compress.execute(
      { fromRef: 'm00002', toRef: 'm00003', topic: 'build fix', summary: 'sqlite lock timeout in ci, documented as flake' },
      {},
    )
    assert.equal(out2.ok, true, 'the engine compression still succeeds')
    assert.equal(out2.mycelium, 'failed', 'store failure is surfaced in the DTO')
    assert.ok(out2.myceliumError, 'and the reason is present')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tools: search scope=shared returns store hits with phase; local is the default', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-srch-'))
  try {
    const pubStore = openMyceliumStore({ baseDir: dir })
    const dna = fingerprint('build fix', 'sqlite lock timeout in ci')
    publish(pubStore, dna, { sessionKey: 'other-agent', blockId: 'blk00001', tier: 1, topic: 'build fix', summary: 'sqlite lock timeout in ci' })

    const { byName } = hostWithStore({ storeDir: dir, publish: false })
    const shared = await byName.search.execute({ query: 'sqlite lock timeout', scope: 'shared' }, {})
    assert.equal(shared.ok, true)
    assert.equal(shared.scope, 'shared')
    assert.equal(shared.hits.length, 1)
    assert.equal(shared.hits[0].sessionKey, 'other-agent', 'this is cross-session data')
    assert.equal(shared.hits[0].phase, 'dormant')
    assert.ok(typeof shared.hits[0].snippet === 'string')

    const local = await byName.search.execute({ query: 'backfill' }, {})
    assert.ok(!local.scope || local.scope === 'local', 'default scope is local')
    assert.ok(Array.isArray(local.hits))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tools: search scope=shared without a configured store is an honest failure', async () => {
  const { byName } = hostWithStore({ storeDir: undefined })
  const out = await byName.search.execute({ query: 'anything', scope: 'shared' }, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'mycelium_unavailable')
  assert.ok(out.detail.includes('no mycelium store configured'))
})

test('tools: status exposes nearby when the store holds related work, null when it does not', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-nb-'))
  try {
    const { byName } = hostWithStore({ storeDir: dir, publish: false })
    const empty = await byName.status.execute({}, {})
    assert.equal(empty.ok, true)
    assert.equal(empty.mycelium, 'ok', 'store is configured and open')
    assert.equal(empty.nearby, null, 'nothing related yet')

    const pubStore = openMyceliumStore({ baseDir: dir })
    const dna = fingerprint('build fix', 'sqlite lock timeout in ci')
    publish(pubStore, dna, { sessionKey: 'other-agent', blockId: 'blk00001', tier: 1, topic: 'build fix', summary: 'sqlite lock timeout in ci' })

    // Fold a related block into THIS session through the tool, so the
    // session's fold cache (the one status reads) has DNA to match against.
    const cmp = await byName.compress.execute(
      { fromRef: 'm00002', toRef: 'm00003', topic: 'build fix', summary: 'sqlite lock timeout in ci, documented as flake' },
      {},
    )
    assert.equal(cmp.ok, true)

    const withNear = await byName.status.execute({}, {})
    assert.ok(Array.isArray(withNear.nearby), 'nearby list appears once related work exists')
    assert.ok(withNear.nearby.length >= 1)
    assert.equal(withNear.nearby[0].topic, 'build fix')
    assert.equal(withNear.nearby[0].sessionKey, 'other-agent')
    // the local block list carries the fidelity phase
    assert.ok(withNear.blocks[0].phase === 'dormant' || withNear.blocks[0].phase === 'active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- engine: fidelity signal ----------

test('engine: decompressBlock bumps accessCount (fidelity signal for phase)', () => {
  const fold = createFold({ sessionKey: 'agent-a' })
  // 8 messages: with default recentZoneMessages=5 the zone starts at index 3,
  // so m00002-m00003 (indices 1-2) are compressible (m00001 stays protected).
  ingest(fold, [
    { seq: 1, role: 'user', text: 'Fix the build' },
    { seq: 2, role: 'assistant', text: 'Inspecting failing module' },
    { seq: 3, role: 'tool', text: 'sqlite lock timeout in ci' },
    { seq: 4, role: 'assistant', text: 'Documented the flake' },
    { seq: 5, role: 'user', text: 'Run the backfill' },
    { seq: 6, role: 'tool', text: '412 rows moved' },
    { seq: 7, role: 'assistant', text: 'Backfill complete' },
    { seq: 8, role: 'user', text: 'Verify it' },
  ])
  const out = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00003', topic: 'build fix', summary: 'sqlite lock timeout in ci, documented' })
  assert.equal(out.ok, true)
  const block = fold.byBlockId.get(out.blockId)
  assert.equal(block.accessCount, 0)
  const d1 = decompressBlock(fold, { blockId: out.blockId, fromRef: 'm00002', toRef: 'm00003' })
  assert.equal(d1.ok, true)
  assert.equal(block.accessCount, 1, 'a sub-range restore counts as a use')
})

// ---------- red team regressions (2026-11-10) ----------

const readText = (p) => readFileSync(p, 'utf8')

test('RT-1: a symlinked block file is skipped and counted, never followed', () => {
  const { dir, store } = mkStore()
  const evilDir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-evil-'))
  try {
    const dna = fingerprint('build fix', 'sqlite lock timeout in ci')
    publish(store, dna, { sessionKey: 's1', blockId: 'b1', tier: 1, topic: 'build fix', summary: 'sqlite lock timeout in ci' })
    const evilFile = path.join(evilDir, 'evil.json')
    writeFileSync(evilFile, JSON.stringify({
      fp: dna.id, sessionKey: 'evil', blockId: 'blkEVIL', tier: 1,
      topic: 'passwords', summary: 'LEAKED via symlink: db_admin password hunter2',
      tokens: dna.tokens, sourceRefs: [], approxSummaryTokens: 0, accessCount: 0,
    }))
    const slot = path.join(dir, 'blocks', `${dna.id}.json`)
    rmSync(slot)
    symlinkSync(evilFile, slot)
    const r = store.searchBlocks('sqlite lock timeout')
    assert.ok(!r.hits.some((h) => h.sessionKey === 'evil'), 'the attacker record must not be served')
    assert.equal(r.hits.length, 0, 'the real block was replaced by the symlink and is therefore gone')
    assert.ok(r.degraded >= 1, 'the swapped file is counted as degradation, not silently followed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(evilDir, { recursive: true, force: true })
  }
})

test('RT-1b: a planted block file whose tokens do not hash to its fp is rejected', () => {
  const { dir, store } = mkStore()
  try {
    // fp-67f63757 is the fingerprint of the token pair alpha+beta; a record
    // claiming that fp with different tokens is structurally impossible.
    writeFileSync(path.join(dir, 'blocks', 'fp-67f63757.json'), JSON.stringify({
      fp: 'fp-67f63757', sessionKey: 'evil', blockId: 'blkPLANT', tier: 1,
      topic: 'passwords', summary: 'planted plain file, not a symlink',
      tokens: ['gamma'], sourceRefs: [], approxSummaryTokens: 0, accessCount: 0,
    }))
    // index it under "gamma" so the read path is forced to load it
    writeFileSync(path.join(dir, 'tok', `${fnv('gamma')}.json`), 'fp-67f63757\n')
    const r = store.searchBlocks('gamma')
    assert.equal(r.hits.length, 0, 'content addressing rejects the planted record')
    assert.ok(r.degraded >= 1, 'the rejection is visible, not silent')
    assert.throws(
      () => publish(store, { id: 'fp-67f63757', tokens: ['gamma'] }, { sessionKey: 's', blockId: 'b', tier: 1, topic: 'x', summary: 'y' }),
      { code: 'store_invalid' },
      'publish enforces the same integrity check at the door',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RT-2: a corrupt index file is left untouched; reindex() is the explicit repair', () => {
  const { dir, store } = mkStore()
  try {
    publish(store, fingerprint('a one', 'sqlite lock timeout alpha'), { sessionKey: 's1', blockId: 'b1', tier: 1, topic: 'a one', summary: 'sqlite lock timeout alpha' })
    publish(store, fingerprint('b two', 'sqlite lock timeout beta'), { sessionKey: 's2', blockId: 'b2', tier: 1, topic: 'b two', summary: 'sqlite lock timeout beta' })
    const tokFile = path.join(dir, 'tok', `${fnv('sqlite')}.json`)
    writeFileSync(tokFile, '{"corrupt":true}')
    const pr = publish(store, fingerprint('c three', 'sqlite lock timeout gamma'), { sessionKey: 's3', blockId: 'b3', tier: 1, topic: 'c three', summary: 'sqlite lock timeout gamma' })
    assert.equal(pr.degradedTokens, 1, 'the corrupt token index is skipped, not overwritten')
    assert.equal(readText(tokFile), '{"corrupt":true}', 'the corrupt file is preserved for inspection')
    assert.equal(store.searchBlocks('sqlite').hits.length, 0, 'recall through the corrupt index is degraded but visible')
    const rep = store.reindex()
    assert.equal(rep.blocks, 3, 'reindex recovers all blocks from the block files')
    assert.equal(store.searchBlocks('sqlite').hits.length, 3, 'recall is restored after reindex')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RT-3: concurrent publishers lose no index entries (append-only index)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-conc-'))
  const storeUrl = pathToFileURL(fileURLToPath(new URL('../lib/store.js', import.meta.url))).href
  const mycUrl = pathToFileURL(fileURLToPath(new URL('../lib/mycelium.js', import.meta.url))).href
  try {
    const workers = []
    for (let w = 0; w < 4; w += 1) {
      workers.push(new Promise((res, rej) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', concScript], {
          env: { ...process.env, STORE_DIR: dir, STORE_URL: storeUrl, MYC_URL: mycUrl, WORKER: String(w) },
          stdio: 'pipe',
        })
        let err = ''
        p.stderr.on('data', (d) => { err += d })
        p.on('close', (code) => (code === 0 ? res() : rej(new Error(err))))
      }))
    }
    await Promise.all(workers)
    const idxFile = path.join(dir, 'tok', `${fnv('sharedtoken')}.json`)
    const lines = readText(idxFile).trim().split('\n').filter((l) => /^fp-[0-9a-f]{8}$/.test(l))
    assert.equal(new Set(lines).size, 100, '4 x 25 publishes lose no index entry under contention')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const concScript = `
  const { openMyceliumStore } = await import(process.env.STORE_URL)
  const { fingerprint } = await import(process.env.MYC_URL)
  const store = openMyceliumStore({ baseDir: process.env.STORE_DIR })
  const w = Number(process.env.WORKER)
  for (let i = 0; i < 25; i += 1) {
    const k = w * 25 + i
    // 4-char padded tag so every block has a distinct key-token set
    const tag = String(k).padStart(4, 'z')
    const topic = \`sharedtoken case \${tag}\`
    const summary = \`sharedtoken settled work \${tag}\`
    const dna = fingerprint(topic, summary)
    store.publishBlock({ fp: dna.id, tokens: dna.tokens, sessionKey: \`w\${w}\`, blockId: \`b\${k}\`, tier: 1, topic, summary })
  }
`

test('RT-4: shared recall with remember:true bumps the hit and advances its phase', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-rem-'))
  try {
    const pubStore = openMyceliumStore({ baseDir: dir })
    const dna = fingerprint('build fix', 'sqlite lock timeout in ci')
    publish(pubStore, dna, { sessionKey: 's1', blockId: 'b1', tier: 1, topic: 'build fix', summary: 'sqlite lock timeout in ci' })
    const { byName } = hostWithStore({ storeDir: dir, publish: false })
    const out = await byName.search.execute({ query: 'sqlite lock timeout', scope: 'shared', remember: true }, {})
    assert.equal(out.ok, true)
    assert.equal(out.remembered, 1, 'the hit is counted as a use')
    assert.equal(out.hits[0].accessCount, 0, 'the bump lands after the DTO is shaped, so the returned count is pre-bump')
    const after = openMyceliumStore({ baseDir: dir }).searchBlocks('sqlite lock timeout')
    assert.equal(after.hits[0].accessCount, 1, 'the stored access count advanced')
    assert.equal(after.hits[0].phase, 'active', 'and the fidelity phase moved dormant to active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RT-5: listBlocks respects its read cap; reindex drops orphaned index lines', () => {
  const { dir, store } = mkStore()
  try {
    // pad the index into a 4-char token so all 30 blocks get distinct fps
    // (1-3 char numbers are dropped by the key-token extractor)
    for (let i = 0; i < 30; i += 1) {
      const tag = String(i).padStart(4, 'x')
      publish(store, fingerprint(`topic ${tag}`, `summary case ${tag} unique`), { sessionKey: 's', blockId: `b${i}`, tier: 1, topic: `topic ${tag}`, summary: `summary case ${tag} unique` })
    }
    assert.equal(store.listBlocks().length, 30)
    assert.equal(store.listBlocks(10).length, 10, 'the bounded read loads at most the cap')
    const h = fnv('orphan')
    writeFileSync(path.join(dir, 'tok', `${h}.json`), 'fp-deadbeef\n')
    const rep = store.reindex()
    assert.equal(rep.blocks, 30)
    const orph = path.join(dir, 'tok', `${h}.json`)
    assert.ok(!existsSync(orph) || !readText(orph).includes('fp-deadbeef'), 'the orphan entry is dropped on reindex')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RT-6: a legacy v0.2.0 JSON-array index migrates to lines on first publish', () => {
  const { dir, store } = mkStore()
  try {
    const dna = fingerprint('build fix', 'sqlite lock timeout in ci')
    publish(store, dna, { sessionKey: 's1', blockId: 'b1', tier: 1, topic: 'build fix', summary: 'sqlite lock timeout in ci' })
    // forge the v0.2.0 legacy format back onto the "sqlite" index, then
    // publish a second block sharing that token: the legacy file must
    // migrate to lines and keep BOTH records
    writeFileSync(path.join(dir, 'tok', `${fnv('sqlite')}.json`), JSON.stringify([dna.id]))
    publish(store, fingerprint('c three', 'sqlite lock timeout gamma'), { sessionKey: 's3', blockId: 'b3', tier: 1, topic: 'c three', summary: 'sqlite lock timeout gamma' })
    const raw = readText(path.join(dir, 'tok', `${fnv('sqlite')}.json`))
    assert.ok(!raw.trimStart().startsWith('['), 'the legacy file was migrated to line format')
    const fps = raw.trim().split('\n').filter((l) => /^fp-[0-9a-f]{8}$/.test(l))
    assert.ok(fps.includes(dna.id), 'the legacy entry survives the migration')
    assert.equal(new Set(fps).size, 2, 'legacy and new records both indexed')
    assert.equal(store.searchBlocks('sqlite').hits.length, 2, 'recall spans both records')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RT-9: a status call with truncateTo reports the post-truncation composition', async () => {
  const { byName } = hostWithStore({ storeDir: undefined, publish: false })
  const out = await byName.status.execute({ truncateTo: 40 }, {})
  assert.equal(out.ok, true)
  assert.ok(out.truncation && Array.isArray(out.truncation.dropped), 'truncateTo must run the emergency cap')
  const dropped = out.truncation.dropped.length
  assert.ok(dropped > 0, 'the fixture must drop at least one message')
  assert.equal(out.composition.messages, 8 - dropped, 'composition must reflect the post-truncation state')
})

test('RT-10: a symlink planted at a foreign or legacy temp name is never followed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-tmp-'))
  try {
    const store = openMyceliumStore({ baseDir: dir })
    const dna = fingerprint('temp probe', 'victim must stay intact')
    const victim = path.join(dir, 'outside-victim.txt')
    writeFileSync(victim, 'ORIGINAL')
    // legacy fixed temp name (pre-v0.2.5): a per-operation unique temp
    // naming must leave a plant at the foreign name inert
    symlinkSync(victim, path.join(dir, 'blocks', `.${dna.id}.json.tmp`))
    try {
      store.publishBlock({ fp: dna.id, tokens: dna.tokens, sessionKey: 's', blockId: 'b', tier: 1, topic: 'temp probe', summary: 'victim must stay intact' })
    } catch {
      // a safe refusal of the whole publish is acceptable; writing THROUGH the plant is not
    }
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL', 'the victim file outside the store stays untouched')
    const blockFile = path.join(dir, 'blocks', dna.id + '.json')
    assert.ok(!existsSync(blockFile) || !lstatSync(blockFile).isSymbolicLink(), 'the block file must never be a symlink to the victim')
    // a fresh fingerprint (no plant on its temp names) must publish cleanly
    const dna2 = fingerprint('temp probe clean', 'second writer must land')
    store.publishBlock({ fp: dna2.id, tokens: dna2.tokens, sessionKey: 's', blockId: 'b2', tier: 1, topic: 'temp probe clean', summary: 'second writer must land' })
    assert.ok(existsSync(path.join(dir, 'blocks', dna2.id + '.json')), 'a clean publish must land on its own temp name')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const bumpScript = `
  const { openMyceliumStore } = await import(process.env.STORE_URL)
  const store = openMyceliumStore({ baseDir: process.env.STORE_DIR })
  for (let i = 0; i < 25; i += 1) store.bump(process.env.FP)
`

test('RT-11: concurrent bumps lose no increments (append-only counter)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-bump-'))
  const storeUrl = pathToFileURL(fileURLToPath(new URL('../lib/store.js', import.meta.url))).href
  try {
    const seed = openMyceliumStore({ baseDir: dir })
    const dna = fingerprint('bump probe', 'concurrent counter check')
    seed.publishBlock({ fp: dna.id, tokens: dna.tokens, sessionKey: 's0', blockId: 'b0', tier: 1, topic: 'bump probe', summary: 'concurrent counter check' })
    const workers = []
    for (let w = 0; w < 4; w += 1) {
      workers.push(new Promise((res, rej) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', bumpScript], {
          env: { ...process.env, STORE_DIR: dir, STORE_URL: storeUrl, FP: dna.id },
          stdio: 'pipe',
        })
        let err = ''
        p.stderr.on('data', (d) => { err += d })
        p.on('close', (code) => (code === 0 ? res() : rej(new Error(err))))
      }))
    }
    await Promise.all(workers)
    const out = openMyceliumStore({ baseDir: dir }).searchBlocks('bump')
    assert.equal(out.hits.length, 1)
    assert.equal(out.hits[0].accessCount, 100, '4 x 25 concurrent bumps must all land (no lost updates)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RT-12: pre-existing permissive store directories are secured to 0700 on open', () => {
  if (process.platform === 'win32') {
    console.log('skip RT-12: chmod mode bits are a no-op on win32')
    return
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-perm-'))
  try {
    const blocks = path.join(dir, 'blocks')
    mkdirSync(blocks, { mode: 0o777 })
    chmodSync(blocks, 0o777)
    chmodSync(dir, 0o777)
    openMyceliumStore({ baseDir: dir })
    assert.equal(lstatSync(blocks).mode & 0o777, 0o700, 'a world-readable blocks dir must be locked down')
    assert.equal(lstatSync(dir).mode & 0o777, 0o700, 'the store root itself must be locked down')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RT-13: a token index append never follows a symlink planted at the index path', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-idx-'))
  try {
    const store = openMyceliumStore({ baseDir: dir })
    const seed = fingerprint('idx probe', 'sqlite lock timeout in ci')
    store.publishBlock({ fp: seed.id, tokens: seed.tokens, sessionKey: 's1', blockId: 'b1', tier: 1, topic: 'idx probe', summary: 'sqlite lock timeout in ci' })
    assert.ok(existsSync(path.join(dir, 'tok', `${fnv('sqlite')}.json`)), 'the seed publish must create the token index')
    // plant a symlink at a token index that does not exist yet
    const victim = path.join(dir, 'outside-victim.txt')
    writeFileSync(victim, 'ORIGINAL')
    const planted = path.join(dir, 'tok', `${fnv('locked')}.json`)
    symlinkSync(victim, planted)
    const dna2 = fingerprint('idx probe two', 'locked table gamma')
    const rep = store.publishBlock({ fp: dna2.id, tokens: dna2.tokens, sessionKey: 's2', blockId: 'b2', tier: 1, topic: 'idx probe two', summary: 'locked table gamma' })
    assert.ok(rep.degradedTokens >= 1, 'the update aimed at the symlinked index must be skipped and reported')
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL', 'the victim behind the index symlink stays untouched')
    assert.ok(lstatSync(planted).isSymbolicLink(), 'the index path stays a symlink, never replaced by a regular file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RT-14: a counter append never follows a symlink planted at the counter path', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-cnt-'))
  try {
    const store = openMyceliumStore({ baseDir: dir })
    const dna = fingerprint('counter probe', 'symlink guard check')
    store.publishBlock({ fp: dna.id, tokens: dna.tokens, sessionKey: 's1', blockId: 'b1', tier: 1, topic: 'counter probe', summary: 'symlink guard check' })
    const victim = path.join(dir, 'outside-victim.txt')
    writeFileSync(victim, 'ORIGINAL')
    symlinkSync(victim, path.join(dir, 'count', dna.id))
    store.bump(dna.id)
    store.bump(dna.id)
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL', 'bumping through a planted counter symlink must not touch the victim')
    assert.ok(lstatSync(path.join(dir, 'count', dna.id)).isSymbolicLink(), 'the counter path stays a symlink')
    const out = openMyceliumStore({ baseDir: dir }).searchBlocks('counter')
    assert.equal(out.hits[0].accessCount, 0, 'refused counter appends add no uses')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RT-15: the decompress contract names the official sub-range behaviour (clamp, reject)', () => {
  const { byName } = hostWithStore({ storeDir: undefined, publish: false })
  const d = byName.decompress
  assert.match(d.description, /clamp/i, 'the description must state that resolvable out-of-block bounds clamp to the block span')
  assert.match(d.description, /reject/i, 'the description must state that unresolvable bounds are rejected')
})

const writeRaceScript = `
  const { openMyceliumStore } = await import(process.env.STORE_URL)
  const store = openMyceliumStore({ baseDir: process.env.STORE_DIR })
  const dna = JSON.parse(process.env.DNA)
  for (let i = 0; i < Number(process.env.ITER); i += 1) {
    const rep = store.publishBlock({ fp: dna.fp, tokens: dna.tokens, sessionKey: 's' + process.env.W, blockId: 'b' + i, tier: 1, topic: dna.topic, summary: dna.summary })
    if (rep.degradedTokens > 0) process.exit(3) // an index update was refused: the writer must not silently degrade
  }
`

test('RT-16: concurrent writers targeting the same block file all land without clobbering each other', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-race-'))
  const storeUrl = pathToFileURL(fileURLToPath(new URL('../lib/store.js', import.meta.url))).href
  try {
    const seed = openMyceliumStore({ baseDir: dir })
    const dna = fingerprint('race probe', 'two writer contention check')
    seed.publishBlock({ fp: dna.id, tokens: dna.tokens, sessionKey: 's0', blockId: 'b0', tier: 1, topic: 'race probe', summary: 'two writer contention check' })
    const N = 4
    const ITER = 30
    const workers = []
    for (let w = 0; w < N; w += 1) {
      workers.push(new Promise((res, rej) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', writeRaceScript], {
          env: {
            ...process.env,
            STORE_DIR: dir,
            STORE_URL: storeUrl,
            DNA: JSON.stringify({ fp: dna.id, tokens: dna.tokens, topic: 'race probe', summary: 'two writer contention check' }),
            W: String(w),
            ITER: String(ITER),
          },
          stdio: 'pipe',
        })
        let err = ''
        p.stderr.on('data', (d) => { err += d })
        p.on('close', (code) => (code === 0 ? res() : rej(new Error(`writer ${w} exit ${code}: ${err}`))))
      }))
    }
    await Promise.all(workers) // every writer must complete: a clobbered in-flight temp must surface, not hide
    const out = openMyceliumStore({ baseDir: dir }).searchBlocks('race')
    assert.equal(out.hits.length, 1, 'the store must hold the one block')
    assert.match(out.hits[0].sessionKey, /^s[0-3]$/, 'last-writer-wins: one of the four writers\' records is live')
    assert.ok(existsSync(path.join(dir, 'blocks', dna.id + '.json')), 'the block record file is present')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const gateScript = `
  const { openMyceliumStore } = await import(process.env.STORE_URL)
  const fs = await import('node:fs')
  const store = openMyceliumStore({ baseDir: process.env.STORE_DIR })
  while (!fs.existsSync(process.env.GATE)) await new Promise((r) => setTimeout(r, 10))
  const dna = JSON.parse(process.env.DNA)
  try {
    store.publishBlock({ fp: dna.fp, tokens: dna.tokens, sessionKey: 's', blockId: 'b', tier: 1, topic: dna.topic, summary: dna.summary })
  } catch { /* a safe refusal (ELOOP on our own temp) is the expected outcome */ }
`

test('RT-17: a symlink planted at this process own next temp name is refused, never followed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcc-mycelium-gate-'))
  const storeUrl = pathToFileURL(fileURLToPath(new URL('../lib/store.js', import.meta.url))).href
  try {
    const seed = openMyceliumStore({ baseDir: dir })
    const dna = fingerprint('gate probe', 'own temp symlink check')
    seed.publishBlock({ fp: dna.id, tokens: dna.tokens, sessionKey: 's0', blockId: 'b0', tier: 1, topic: 'gate probe', summary: 'own temp symlink check' })
    const gate = path.join(dir, 'gate')
    const p = spawn(process.execPath, ['--input-type=module', '-e', gateScript], {
      env: { ...process.env, STORE_DIR: dir, STORE_URL: storeUrl, GATE: gate, DNA: JSON.stringify({ fp: dna.id, tokens: dna.tokens, topic: 'gate probe', summary: 'own temp symlink check' }) },
      stdio: 'pipe',
    })
    // the child's first store write takes temp seq 1 attempt 0; plant our
    // symlink there while the child is still importing the module
    const victim = path.join(dir, 'outside-victim.txt')
    writeFileSync(victim, 'ORIGINAL')
    const planted = path.join(dir, 'blocks', `.${dna.id}.json.tmp-${p.pid}-1-0`)
    symlinkSync(victim, planted)
    writeFileSync(gate, 'go')
    await new Promise((res) => { p.on('close', res) })
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL', 'the victim behind our own temp symlink stays untouched')
    const blockFile = path.join(dir, 'blocks', dna.id + '.json')
    assert.ok(!existsSync(blockFile) || !lstatSync(blockFile).isSymbolicLink(), 'the block must never land as a symlink to the victim')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
