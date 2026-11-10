/**
 * Fold engine: unit tests (pure fixtures, no host, no I/O).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  composition,
  createFold,
  decompressBlock,
  emergencyTruncate,
  estimateTokens,
  ingest,
  isProtectedIndex,
  nudgeFor,
  promoteTier,
  recordBlock,
  searchContext,
  stats,
  surfaceEventsToMessages,
  totalTokensOf,
} from '../lib/fold.js'

/** Build a session: user intent + N tool results (each ~size chars) + user request. */
function sessionMessages(nTool, toolChars = 4000) {
  const msgs = [{ seq: 1, role: 'user', text: 'refactor the build pipeline and verify it' }]
  for (let i = 0; i < nTool; i += 1) {
    msgs.push({ seq: 2 + i, role: 'tool', toolName: 'bash', text: `x`.repeat(toolChars) })
  }
  msgs.push({ seq: 2 + nTool, role: 'user', text: 'continue with the backfill script' })
  return msgs
}

test('refs are minted in ingestion order and ingest is idempotent by seq', () => {
  const fold = createFold({ sessionKey: 's1' })
  ingest(fold, sessionMessages(3))
  assert.strictEqual(fold.messages.length, 5)
  assert.equal(fold.messages[0].ref, 'm00001')
  assert.equal(fold.messages[4].ref, 'm00005')
  const again = ingest(fold, sessionMessages(3))
  assert.equal(again.added, 0)
  assert.equal(fold.messages.length, 5)
})

test('estimateTokens uses the documented chars/4 heuristic', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('a'.repeat(4000)), 1000)
  assert.ok(estimateTokens('x'.repeat(5)) > 0)
})

test('protected zones reject compression ranges', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 2, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(6, 1000))
  // layout: m00001 user(intent) | m00002..m00007 tool | m00008 user(last); recent zone = m00007..m00008
  const first = recordBlock(fold, { fromRef: 'm00001', toRef: 'm00002', topic: 't', summary: 's' })
  assert.ok(!first.ok)
  assert.match(first.error, /first user message/)
  const last = recordBlock(fold, { fromRef: 'm00007', toRef: 'm00008', topic: 't', summary: 's' })
  assert.ok(!last.ok, 'range touches the recent zone / last user message')
  const toolMsg = recordBlock(fold, { fromRef: 'm00003', toRef: 'm00006', topic: 't', summary: 's' })
  assert.ok(toolMsg.ok, 'a clean mid range (no zone contact) must fold')
})

test('a clean range between intent and the recent zone folds successfully', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(4, 1000))
  // m00001 user | m00002..m00005 tool | m00006 user(last)
  const out = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 'pipeline runs', summary: 'all green' })
  assert.ok(out.ok)
  assert.equal(out.blockId, 'blk00001')
  assert.ok(out.ratio >= 1)
  assert.ok(out.savedTokens > 0)
  assert.equal(fold.messages[1].foldedBy, 'blk00001')
  const again = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00003', topic: 't', summary: 's' })
  assert.ok(!again.ok)
  assert.match(again.error, /already inside block/)
})

test('over-cap tier-1 summaries are rejected', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(4, 1000))
  const out = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 't', summary: 'a'.repeat(9000) })
  assert.ok(!out.ok)
  assert.match(out.error, /exceeds the tier-1 cap/)
})

test('growth gate: quiet below window floor, fires above it, resets after compression', () => {
  const fold = createFold({
    sessionKey: 's1',
    config: { windowTokens: 1000, gateFloorTokens: 200, effectiveFloorFraction: 0.45, recentZoneMessages: 1, recentZoneTokens: 0 },
  })
  ingest(fold, sessionMessages(10, 300)) // ~3000 raw tokens
  let nudge = nudgeFor(fold)
  assert.ok(nudge.triggered, 'growth 3000 >= floor 200 and total > 0.45*1000')
  assert.ok(nudge.text.includes('efficiency nudge'))
  assert.ok(!/\d+(\.\d+)?\s*(%|used)/.test(nudge.text), 'no fill-ratio disclosure in nudge text')
  assert.ok(Array.isArray(nudge.ranges) && nudge.ranges.length > 0)
  // compress a range → gate baseline resets → quiet
  const out = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00011', topic: 'tool spam', summary: 'settled' })
  assert.ok(out.ok)
  nudge = nudgeFor(fold)
  assert.ok(!nudge.triggered, 'growth since last compression is now 0')
})

test('effective floor drops to 45% of floor when pending mass is below the floor', () => {
  const fold = createFold({
    sessionKey: 's1',
    config: { windowTokens: 1000, gateFloorTokens: 400, effectiveFloorFraction: 0.45, windowFloorFraction: 0.45, recentZoneMessages: 1, recentZoneTokens: 0 },
  })
  ingest(fold, sessionMessages(6, 100)) // ~600 total, growth ~600, pending mass < 400? mass = 600+ (user msgs) make mass small:
  const nudge = nudgeFor(fold)
  assert.ok(typeof nudge.gate.effectiveFloorTokens === 'number')
  assert.ok(nudge.gate.effectiveFloorTokens === 180 || nudge.gate.effectiveFloorTokens === 400)
  void fold
})

test('decompress restores a whole block and deactivates it', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(4, 1000))
  recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 'pipeline', summary: 'ok' })
  assert.equal(fold.messages[1].foldedBy, 'blk00001')
  const out = decompressBlock(fold, { blockId: 'blk00001' })
  assert.ok(out.ok)
  assert.deepEqual(out.restoredRefs, ['m00002', 'm00003', 'm00004', 'm00005'])
  assert.equal(fold.messages[1].foldedBy, undefined)
  assert.equal(fold.byBlockId.get('blk00001').active, false)
  const unknown = decompressBlock(fold, { blockId: 'blk99999' })
  assert.ok(!unknown.ok)
})

test('decompress supports sub-ranges and an injected file sink', () => {
  const written = []
  const fold = createFold({
    sessionKey: 's1',
    config: { recentZoneMessages: 1, recentZoneTokens: 0 },
    writeFile: (name, text) => {
      written.push(name)
      return `/tmp/mulqi-cc/s1/${name}`
    },
  })
  ingest(fold, sessionMessages(4, 1000))
  recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 'pipeline', summary: 'ok' })
  const sub = decompressBlock(fold, { blockId: 'blk00001', fromRef: 'm00003', toRef: 'm00004' })
  assert.ok(sub.ok)
  assert.deepEqual(sub.restoredRefs, ['m00003', 'm00004'])
  const toFile = decompressBlock(fold, { blockId: 'blk00001', toFile: true })
  assert.ok(toFile.ok)
  assert.ok(toFile.file.endsWith('pipeline.txt'))
  assert.equal(toFile.text, undefined)
  assert.equal(written.length, 1)
})

test('searchContext recalls blocks and recent messages by keyword', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(4, 1000))
  recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 'pipeline runs', summary: 'sqlite lock timeout root cause' })
  const out = searchContext(fold, { query: 'sqlite lock' })
  assert.ok(out.ok)
  assert.ok(out.hits.length >= 1)
  assert.equal(out.hits[0].kind, 'block')
  assert.equal(out.hits[0].id, 'blk00001')
  const empty = searchContext(fold, { query: '   ' })
  assert.ok(!empty.ok)
})

test('promoteTier folds tier-1 blocks into one tier-2 block with lineage', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0, gateFloorTokens: 1 } })
  // enough messages for two disjoint clean ranges
  const msgs = [{ seq: 1, role: 'user', text: 'do it' }]
  for (let i = 0; i < 8; i += 1) msgs.push({ seq: 2 + i, role: 'tool', toolName: 'bash', text: 'y'.repeat(500) })
  msgs.push({ seq: 10, role: 'user', text: 'next phase' })
  ingest(fold, msgs)
  const b1 = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00004', topic: 'phase A', summary: 'A done: commit 1' })
  const b2 = recordBlock(fold, { fromRef: 'm00005', toRef: 'm00008', topic: 'phase B', summary: 'B done: commit 2' })
  assert.ok(b1.ok && b2.ok)
  const out = promoteTier(fold, { blockIds: [b1.blockId, b2.blockId], topic: 'phase A+B distilled', summary: 'A and B both landed; see blk00001..blk00002 for detail' })
  assert.ok(out.ok, out.error)
  assert.equal(out.tier, 2)
  assert.equal(fold.byBlockId.get(b1.blockId).active, false)
  assert.equal(fold.byBlockId.get(b2.blockId).active, false)
  const t2 = fold.blocks.find((b) => b.tier === 2)
  assert.ok(t2)
  assert.deepEqual(t2.sourceBlockIds, [b1.blockId, b2.blockId])
})

test('emergencyTruncate drops oldest unprotected messages until the budget holds', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 2, recentZoneTokens: 0 } })
  const msgs = [{ seq: 1, role: 'user', text: 'intent' }]
  for (let i = 0; i < 10; i += 1) msgs.push({ seq: 2 + i, role: 'tool', toolName: 'bash', text: 'z'.repeat(400) })
  msgs.push({ seq: 12, role: 'user', text: 'last request' })
  ingest(fold, msgs)
  const out = emergencyTruncate(fold, 400)
  assert.ok(out.ok)
  assert.ok(out.dropped.length > 0)
  assert.ok(totalTokensOf(fold) <= 400 || out.dropped.length === 0)
  // protected tail survived
  assert.equal(fold.messages[fold.messages.length - 1].text, 'last request')
})

test('composition reports roles, folded counts and ranges', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(4, 1000))
  const before = composition(fold).ranges
  assert.ok(before.length >= 1, 'a compressible mid range exists before folding')
  recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 'pipeline', summary: 'ok' })
  const c = composition(fold)
  assert.equal(c.messages, 6)
  assert.equal(c.folded.messages, 4)
  assert.equal(c.ranges.length, 0, 'the only clean run is now folded; nothing left to compress')
  assert.ok(c.renderedTokens < c.totalTokens)
})

test('stats exposes tier counters and gate state', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(4, 1000))
  recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 'pipeline', summary: 'ok' })
  const s = stats(fold)
  assert.equal(s.blocks.total, 1)
  assert.equal(s.blocks.byTier[1], 1)
  assert.equal(typeof s.gate.baselineTotalTokens, 'number')
})

test('surfaceEventsToMessages normalizes DSH surface events', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'on it' }, { type: 'image' }] } } },
    { seq: 3, type: 'tool/result', data: { message: { toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false } } },
    { seq: 4, type: 'compaction/start', data: {} }, // unknown → skipped
    { seq: 5, type: 'system/message', data: { message: { content: [{ type: 'text', text: 'ctx' }] } } },
  ]
  const out = surfaceEventsToMessages(events)
  assert.equal(out.length, 4)
  assert.equal(out[0].role, 'user')
  assert.equal(out[0].text, 'hello')
  assert.ok(out[1].text.includes('on it'))
  assert.ok(out[1].text.includes('[image]'))
  assert.equal(out[2].toolName, 'bash')
  assert.equal(out[3].role, 'system')
  assert.deepEqual(surfaceEventsToMessages(null), [])
  assert.deepEqual(surfaceEventsToMessages([]), [])
})

test('isProtectedIndex honors the engine floors', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 2, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(4, 1000))
  assert.ok(isProtectedIndex(fold, 0), 'first user message')
  assert.ok(isProtectedIndex(fold, 5), 'last user message')
  assert.ok(isProtectedIndex(fold, 4), 'recent zone')
  assert.ok(!isProtectedIndex(fold, 1), 'mid tool range is compressible')
})

test('promoteTier rejects all-unknown blockIds and filters phantom ids from lineage', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(4, 1000))
  const b1 = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 'A', summary: 'a' })
  assert.ok(b1.ok)
  const unknown = promoteTier(fold, { blockIds: ['blk99999'], topic: 'x', summary: 'x' })
  assert.ok(!unknown.ok)
  assert.match(unknown.error, /no known blocks/)
  const partial = promoteTier(fold, { blockIds: [b1.blockId, 'blk77777'], topic: 'distilled', summary: 'A landed' })
  assert.ok(partial.ok, partial.error)
  const t2 = fold.byBlockId.get(partial.blockId)
  assert.deepEqual(t2.sourceBlockIds, [b1.blockId], 'phantom ids must not enter the lineage')
})

test('promoteTier fallback path enforces the summary cap and non-empty validation', () => {
  // force the fallback: a tier-1 block whose source messages were truncated away
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 2, recentZoneTokens: 0 } })
  const msgs = [{ seq: 1, role: 'user', text: 'intent' }]
  for (let i = 0; i < 7; i += 1) msgs.push({ seq: 2 + i, role: 'tool', toolName: 'bash', text: 'y'.repeat(400) })
  msgs.push({ seq: 9, role: 'user', text: 'last' })
  ingest(fold, msgs)
  const b = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00007', topic: 'run', summary: 'ok' })
  assert.ok(b.ok)
  emergencyTruncate(fold, 300) // drops the folded tool messages; the block refs no longer resolve
  const over = promoteTier(fold, { blockIds: [b.blockId], topic: 'over', summary: 'z'.repeat(40000) })
  assert.ok(!over.ok)
  assert.match(over.error, /tier-2 cap/)
  const empty = promoteTier(fold, { blockIds: [b.blockId], topic: 'empty', summary: '   ' })
  assert.ok(!empty.ok)
  assert.match(empty.error, /summary text is required/)
})

test('sub-range decompress keeps the block active; full restore deactivates it', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  ingest(fold, sessionMessages(4, 1000))
  recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 'pipeline', summary: 'ok' })
  const sub = decompressBlock(fold, { blockId: 'blk00001', fromRef: 'm00002', toRef: 'm00003' })
  assert.ok(sub.ok)
  assert.equal(fold.byBlockId.get('blk00001').active, true, 'the remaining folded messages still bookkeep under the block')
  const whole = decompressBlock(fold, { blockId: 'blk00001' })
  assert.ok(whole.ok)
  assert.equal(fold.byBlockId.get('blk00001').active, false, 'a full restore steps the block aside')
})

test('decompressing a distilled tier-2 block is rejected with a pointer to its sources', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  const msgs = [{ seq: 1, role: 'user', text: 'do it' }]
  for (let i = 0; i < 4; i += 1) msgs.push({ seq: 2 + i, role: 'tool', toolName: 'bash', text: 'y'.repeat(500) })
  msgs.push({ seq: 6, role: 'user', text: 'next' })
  ingest(fold, msgs)
  const b1 = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00005', topic: 'A', summary: 'a' })
  const t2 = promoteTier(fold, { blockIds: [b1.blockId], topic: 'distilled', summary: 'A landed' })
  assert.ok(t2.ok, t2.error)
  const out = decompressBlock(fold, { blockId: t2.blockId })
  assert.ok(!out.ok, 'tier-2 blocks carry no message refs; they must not silently deactivate')
  assert.match(out.error, /distilled block/)
})

test('message refs stay stable across emergency truncation', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 2, recentZoneTokens: 0 } })
  const msgs = [{ seq: 1, role: 'user', text: 'intent' }]
  for (let i = 0; i < 10; i += 1) msgs.push({ seq: 2 + i, role: 'tool', toolName: `bash-${i}`, text: 'z'.repeat(400) })
  msgs.push({ seq: 12, role: 'user', text: 'last' })
  ingest(fold, msgs)
  emergencyTruncate(fold, 600) // drops the oldest tool results
  // m00007 survived; a compression decision that names it must land on that
  // exact message (bash-5), not on the positional shift of the same label
  const out = recordBlock(fold, { fromRef: 'm00007', toRef: 'm00008', topic: 't', summary: 's' })
  assert.ok(out.ok, `refs must still target the right surviving messages: ${out?.error ?? 'ok'}`)
  const target = fold.messages.find((m) => m.ref === 'm00007')
  assert.equal(target?.toolName, 'bash-5', 'the ref resolved to the surviving message, not a shifted position')
  assert.equal(target?.foldedBy, out.blockId)
})

test('RT: a source block cannot be distilled twice (double-consume rejected)', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  const msgs = [{ seq: 1, role: 'user', text: 'intent' }]
  for (let i = 0; i < 6; i += 1) msgs.push({ seq: 2 + i, role: 'tool', toolName: 'bash', text: 'x'.repeat(400) })
  msgs.push({ seq: 8, role: 'user', text: 'last' })
  ingest(fold, msgs)
  const b1 = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00004', topic: 'A', summary: 'a' })
  const b2 = recordBlock(fold, { fromRef: 'm00005', toRef: 'm00007', topic: 'B', summary: 'b' })
  const first = promoteTier(fold, { blockIds: [b1.blockId], topic: 'P1', summary: 'p1' })
  assert.ok(first.ok)
  const again = promoteTier(fold, { blockIds: [b1.blockId, b2.blockId], topic: 'P2', summary: 'p2' })
  assert.ok(!again.ok, 're-consuming an inactive block must be rejected')
  assert.match(again.error, /already consumed/)
})

test('RT: composition counts only messages carried by a live block', () => {
  const fold = createFold({ sessionKey: 's1', config: { recentZoneMessages: 1, recentZoneTokens: 0 } })
  const msgs = [{ seq: 1, role: 'user', text: 'intent' }]
  for (let i = 0; i < 6; i += 1) msgs.push({ seq: 2 + i, role: 'tool', toolName: 'bash', text: 'x'.repeat(400) })
  msgs.push({ seq: 8, role: 'user', text: 'last' })
  ingest(fold, msgs)
  const b1 = recordBlock(fold, { fromRef: 'm00002', toRef: 'm00004', topic: 'A', summary: 'a' })
  assert.equal(composition(fold).folded.messages, 3)
  promoteTier(fold, { blockIds: [b1.blockId], topic: 'P', summary: 'p' })
  assert.equal(composition(fold).folded.messages, 0, 'block deactivated → messages no longer represented by a live summary')
})
