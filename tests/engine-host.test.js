/**
 * Auto fold engine against the REAL host compaction backend.
 *
 * Host-gated: runs only when the DeepSeek Harness packages are resolvable
 * (default: /home/administrator/deepseek-harness, override with
 * MULQI_CC_HOST_MODULES). When they are absent the whole file skips, so
 * the hermetic suite stays zero-dependency.
 *
 * Run: MULQI_CC_HOST_MODULES=/home/administrator/deepseek-harness \
 *   node --test tests/engine-host.test.js
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const hostRoot = process.env.MULQI_CC_HOST_MODULES ?? '/home/administrator/deepseek-harness'
const basicPath = path.join(hostRoot, 'packages/compaction/compaction-basic/lib/index.js')

let engineModule = null
let BasicEngine = null
let skipReason = null

if (!existsSync(basicPath)) {
  skipReason = `host compaction backend not found at ${basicPath} (set MULQI_CC_HOST_MODULES)`
} else {
  try {
    process.env.MULQI_CC_AUTO_MODE = 'mechanical'
    process.env.MULQI_CC_ENGINE_BASE = pathToFileURL(basicPath).href
    engineModule = await import('../compaction-engine.js')
    const basicMod = await import(basicPath)
    BasicEngine = basicMod.default ?? basicMod.BasicCompactionEngine
  } catch (e) {
    skipReason = `host compaction backend not loadable: ${e?.message ?? e}`
  }
}

const events = [
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'migrate the storage layer' }] } },
  { seq: 2, type: 'tool/result', data: { message: { toolName: 'bash', content: [{ type: 'text', text: 'ok 412 tests pass' }] } } },
  { seq: 3, type: 'tool/result', data: { message: { toolName: 'bash', content: [{ type: 'text', text: 'ERROR: sqlite lock timeout' }] } } },
  { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'commit 7f3a1c2 pushed' }] } } },
  { seq: 5, type: 'tool/result', data: { message: { toolName: 'bash', content: [{ type: 'text', text: 'flake retried green' }] } } },
  { seq: 6, type: 'user/message', data: { content: [{ type: 'text', text: 'backfill next' }] } },
  // Filler: keep the span under test outside the protected recent zone,
  // mirroring a real long session.
  ...Array.from({ length: 20 }, (_, i) => ({
    seq: 7 + i,
    type: 'tool/result',
    data: { message: { toolName: 'bash', content: [{ type: 'text', text: `filler step ${i}` }] } },
  })),
  // The trailing five messages must exceed the recent zone's 5K token floor
  // so the zone stops exactly at index 22 (its count-based start).
  ...Array.from({ length: 5 }, (_, i) => ({
    seq: 27 + i,
    type: 'tool/result',
    data: { message: { toolName: 'bash', content: [{ type: 'text', text: `settled ${i} ` + 'payload '.repeat(240) }] } },
  })),
]

function fakeCtx() {
  const warns = []
  return {
    ctx: {
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
      on: () => {},
      get: (name) => (name === 'sessionQuery' ? { readSurface: async () => ({ events }) } : undefined),
      waterfall: () => false,
      // the CompactionEngine base registers itself as a Cordis service on
      // construction; the fake provides that seam as a no-op.
      reflect: { provide: () => () => {} },
    },
    warns,
  }
}

test('host-gated: the engine subclasses the real basic compaction backend', (t) => {
  if (skipReason) return t.skip(skipReason)
  const Engine = engineModule.default
  const { ctx } = fakeCtx()
  const engine = new Engine(ctx, { auto: false })
  assert.ok(engine instanceof BasicEngine, 'the fold engine is a real basic-compaction subclass')
  assert.equal(typeof engine.compactRegion, 'function', 'inherited host machinery is present')
})

test('host-gated: a mechanical auto summarize records a restorable block and appends the marker', async (t) => {
  if (skipReason) return t.skip(skipReason)
  const Engine = engineModule.default
  const { ctx } = fakeCtx()
  const engine = new Engine(ctx, { auto: false })
  const agent = { id: 'host-agent', session: { id: 'host-agent' } }

  // Simulate the host region flow: capture the span, then run the fold hook.
  engine._captureSpan(agent, 3, 5)
  const input = { messages: [{ role: 'user', content: 'migrate the storage layer' }] }
  const result = await engine.summarize(input, agent, undefined)

  assert.equal(result.provider, 'mulqi-cc')
  assert.equal(result.model, 'mulqi-cc-mechanical')
  assert.ok(result.summary.length >= 2, 'digest block plus marker block')
  const marker = result.summary[result.summary.length - 1].text
  assert.match(marker, /\[mulqi-fold: blk00001/, 'the marker names the recorded block')
  assert.match(marker, /m00003\.\.m00005/, 'the marker names the exact span refs')
  assert.match(marker, /mulqi_cc_decompress/, 'the marker tells the model how to restore')
  assert.equal(result.llmStreamCall, undefined, 'a mechanical digest is an unmarked result')

  // Cross-entry proof: the block the ENGINE recorded is visible to the
  // model-facing tools of the same process (shared fold registry).
  const { _resetRegistryForTests } = await import('../lib/fold-registry.js')
  const { createFoldTools } = await import('../lib/tools.js')
  const tools = createFoldTools({
    readMessages: async () => ({ events }),
    sessionKeyFor: () => 'host-agent',
  })
  const status = tools.find((d) => d.name === 'mulqi_cc_status')
  const out = await status.execute({}, {})
  assert.equal(out.ok, true)
  assert.ok(out.blocks.some((b) => b.blockId === 'blk00001'), 'the auto block is listed by mulqi_cc_status')
  const decompress = tools.find((d) => d.name === 'mulqi_cc_decompress')
  const restored = await decompress.execute({ blockId: 'blk00001' }, {})
  assert.equal(restored.ok, true)
  assert.ok(restored.text.includes('sqlite lock timeout'), 'the shadowed span is restorable')
  assert.ok(restored.text.includes('flake retried green'))
  _resetRegistryForTests()
})

test('host-gated: summarize without an in-flight span lands no marker', async (t) => {
  if (skipReason) return t.skip(skipReason)
  const Engine = engineModule.default
  const { ctx } = fakeCtx()
  const engine = new Engine(ctx, { auto: false })
  const agent = { id: 'host-agent-2', session: { id: 'host-agent-2' } }
  const result = await engine.summarize({ messages: [{ role: 'user', content: 'x' }] }, agent, undefined)
  assert.equal(result.provider, 'mulqi-cc')
  assert.equal(result.summary.length, 1, 'digest only, no marker block')
})
