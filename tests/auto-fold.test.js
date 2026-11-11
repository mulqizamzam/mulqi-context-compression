/**
 * Auto fold: the registry's auto-block path and the cross-entry sharing
 * that makes engine-recorded blocks visible to the model-facing tools.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createFoldTools } from '../lib/tools.js'
import { foldRegistry, _resetRegistryForTests } from '../lib/fold-registry.js'

// Fixture sized so the recent zone's token floor (5K) stops at the filler
// boundary, leaving the auto spans compressible.
const HEAVY = 'payload '.repeat(150) // ~300 tokens each
const events = [
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'ship the fold engine' }] } },
  { seq: 2, type: 'tool/result', data: { message: { toolName: 'bash', content: [{ type: 'text', text: 'ok' }] } } },
  { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done, commit 7f3a1c2' }] } } },
  { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: 'publish it now' }] } },
  // Filler: heavy enough that the recent zone's 5K token floor stops here,
  // keeping the auto spans outside the protected suffix.
  ...Array.from({ length: 9 }, (_, i) => ({
    seq: 5 + i,
    type: 'tool/result',
    data: { message: { toolName: 'bash', content: [{ type: 'text', text: `filler step ${i} ${HEAVY}` }] } },
  })),
  { seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'all settled' }] } } },
]

function host(readEvents = events) {
  const readMessages = async (key) => (key === 'agent-z' ? { events: readEvents } : null)
  const sessionKeyFor = () => 'agent-z'
  const tools = createFoldTools({
    readMessages,
    sessionKeyFor,
    mycelium: undefined,
  })
  const byName = {}
  for (const t of tools) byName[t.name.replace(/^mulqi_cc_/, '')] = t
  return { byName }
}

test('recordAutoBlock records a restorable tier-1 block for a captured span', async () => {
  _resetRegistryForTests()
  try {
    host()
    const reg = foldRegistry()
    const fold = await reg.ensureFold('agent-z')
    assert.equal(fold.messages.length, 14, 'the ingest ran against the host surface')
    const out = reg.recordAutoBlock({ key: 'agent-z', startSeq: 2, endSeq: 3, digest: 'TASK AS OF THIS BLOCK: step settled' })
    assert.ok(out, 'the span recorded')
    assert.equal(out.blockId, 'blk00001')
    assert.equal(out.fromRef, 'm00002')
    assert.equal(out.toRef, 'm00003')
    assert.equal(out.truncated, false)
  } finally {
    _resetRegistryForTests()
  }
})

test('an auto block is visible to the model-facing tools (cross-entry sharing)', async () => {
  _resetRegistryForTests()
  try {
    host()
    const reg = foldRegistry()
    await reg.ensureFold('agent-z')
    const out = reg.recordAutoBlock({ key: 'agent-z', startSeq: 2, endSeq: 3, digest: 'settled: commit 7f3a1c2' })
    assert.ok(out)
    const { byName } = host()
    const status = await byName.status.execute({}, {})
    assert.equal(status.ok, true)
    assert.ok(status.blocks.some((b) => b.blockId === out.blockId), 'the engine block shows up in mulqi_cc_status')
    const search = await byName.search.execute({ query: '7f3a1c2' }, {})
    assert.ok(search.hits.some((h) => h.kind === 'block'), 'the engine block is searchable')
    const restored = await byName.decompress.execute({ blockId: out.blockId }, {})
    assert.equal(restored.ok, true)
    assert.ok(restored.text.includes('ok'), 'the original tool result is restorable')
  } finally {
    _resetRegistryForTests()
  }
})

test('recordAutoBlock is fail-open on every miss', async () => {
  _resetRegistryForTests()
  try {
    host()
    const reg = foldRegistry()
    await reg.ensureFold('agent-z')
    assert.equal(reg.recordAutoBlock({ key: 'agent-z', startSeq: 99, endSeq: 3, digest: 'x' }), null, 'unknown span edge')
    assert.equal(reg.recordAutoBlock({ key: 'agent-z', startSeq: 3, endSeq: 2, digest: 'x' }), null, 'reversed span')
    assert.equal(reg.recordAutoBlock({ key: 'agent-z', startSeq: 2, endSeq: 3, digest: '   ' }), null, 'empty digest')
    assert.equal(reg.recordAutoBlock({ key: 'nope', startSeq: 2, endSeq: 3, digest: 'x' }), null, 'unknown fold')
  } finally {
    _resetRegistryForTests()
  }
})

test('an over-cap auto digest is truncated, never rejected', async () => {
  _resetRegistryForTests()
  try {
    host()
    const reg = foldRegistry()
    await reg.ensureFold('agent-z')
    const out = reg.recordAutoBlock({
      key: 'agent-z',
      startSeq: 2,
      endSeq: 3,
      digest: 'z'.repeat(20_000),
      maxTokens: 2048,
    })
    assert.ok(out, 'the block still records')
    assert.equal(out.truncated, true)
    const rec = foldRegistry().folds.get('agent-z').byBlockId.get(out.blockId)
    assert.ok(rec.summary.includes('auto digest truncated to the tier-1 cap'))
  } finally {
    _resetRegistryForTests()
  }
})

test('a protected span is rejected by the engine and stays fail-open', async () => {
  _resetRegistryForTests()
  try {
    host()
    const reg = foldRegistry()
    await reg.ensureFold('agent-z')
    // seq 4 is the last user message (protected); a span touching it must not record
    const out = reg.recordAutoBlock({ key: 'agent-z', startSeq: 2, endSeq: 4, digest: 'x' })
    assert.equal(out, null)
  } finally {
    _resetRegistryForTests()
  }
})

test('publishAutoBlock reports off without a store and failed with a broken one', async () => {
  _resetRegistryForTests()
  try {
    host()
    const reg = foldRegistry()
    await reg.ensureFold('agent-z')
    const out = reg.recordAutoBlock({ key: 'agent-z', startSeq: 2, endSeq: 3, digest: 'd' })
    assert.ok(out)
    assert.deepEqual(reg.publishAutoBlock('agent-z', out.blockId), { status: 'off' }, 'no mycelium dir: off, not an error')

    // a broken store dir (a file, not a directory) must surface as failed, never throw
    const dir = path.join(tmpdir(), 'mulqi-cc-test-broken')
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'not a directory')
    reg.configure({ mycelium: { dir, publish: true, nearbyLimit: 3 } })
    const res = reg.publishAutoBlock('agent-z', out.blockId)
    assert.equal(res.status, 'failed')
    assert.ok(res.error.length > 0)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    _resetRegistryForTests()
  }
})

test('a healthy mycelium store receives the auto block when publish is enabled', async () => {
  _resetRegistryForTests()
  const dir = mkdtempSync(path.join(tmpdir(), 'mulqi-cc-test-myc-'))
  try {
    host()
    const reg = foldRegistry()
    reg.configure({ mycelium: { dir, publish: true, nearbyLimit: 3 } })
    await reg.ensureFold('agent-z')
    const out = reg.recordAutoBlock({ key: 'agent-z', startSeq: 2, endSeq: 3, digest: 'fold auto digest' })
    assert.ok(out)
    const res = reg.publishAutoBlock('agent-z', out.blockId)
    assert.equal(res.status, 'ok')
  } finally {
    _resetRegistryForTests()
    rmSync(dir, { recursive: true, force: true })
  }
})
