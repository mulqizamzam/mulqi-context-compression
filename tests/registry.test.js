/**
 * Registry-layer tests: skill provider, frontmatter, tool-definition contract,
 * and apply() against a mock Cordis context. No host boot.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { BUNDLED_SKILL_RANK, makeProvider, parseFrontmatter, stripFrontmatter } from '../lib/provider.js'
import { createFoldTools } from '../lib/tools.js'
import * as pluginModule from '../index.js'

const SKILL_FILE = new URL('../skills/mulqi-context-compression/SKILL.md', import.meta.url)

test('SKILL.md frontmatter re-parses to the expected catalog fields', async () => {
  const raw = await readFile(SKILL_FILE, 'utf8')
  const parsed = parseFrontmatter(raw)
  assert.equal(parsed.name, 'mulqi-context-compression')
  assert.ok(typeof parsed.description === 'string', 'description parses')
  assert.ok(parsed.description.startsWith('Use when'), 'description is trigger-led')
  assert.ok(parsed.description.length <= 1024, `description fits the 1024-char catalog budget (${parsed.description.length})`)
  assert.ok(parsed.body.trimStart().startsWith('# '), 'body is the markdown after the fences')
  assert.ok(!parsed.body.includes('---\nname:'))
  const stripped = stripFrontmatter(raw)
  assert.equal(stripped, parsed.body)
})

test('provider.list returns one bundled candidate at the DSH bundled rank', async () => {
  const provider = makeProvider()
  const list = await provider.list()
  assert.equal(list.length, 1)
  const cand = list[0]
  assert.equal(cand.name, 'mulqi-context-compression')
  assert.equal(cand.provider, 'mulqi-context-compression')
  assert.equal(cand.source, 'bundled')
  assert.equal(cand.rank, BUNDLED_SKILL_RANK)
  assert.equal(cand.rank, 600)
  assert.ok(cand.invocation.modelInvocable === true)
  assert.ok(cand.invocation.userInvocable === true)
  assert.ok(cand.resourceBase.kind === 'directory')
  assert.ok(cand.description.length > 50)
})

test('provider.get returns the body without frontmatter', async () => {
  const provider = makeProvider()
  const [cand] = await provider.list()
  const full = await provider.get(cand, {})
  assert.equal(full.name, cand.name)
  assert.ok(full.content.length > 500, 'body loads')
  assert.ok(!full.content.startsWith('---'))
  assert.ok(full.content.includes('Core principle'))
  assert.ok(full.content.includes('mulqi_cc_compress'))
})

function toolDefs() {
  const defs = createFoldTools({ readMessages: async () => null })
  return defs
}

test('tool definitions satisfy the DSH ToolDefinition contract', () => {
  const defs = toolDefs()
  assert.equal(defs.length, 4)
  const names = defs.map((d) => d.name).sort()
  assert.deepEqual(names, ['mulqi_cc_compress', 'mulqi_cc_decompress', 'mulqi_cc_search', 'mulqi_cc_status'])
  for (const def of defs) {
    assert.equal(typeof def.name, 'string')
    assert.ok(def.description.length > 20)
    assert.equal(def.parameters.type, 'object', `${def.name}: parameters must be an object schema`)
    assert.ok(def.parameters.properties !== undefined, `${def.name}: parameters.properties present`)
    assert.equal(typeof def.output.schema, 'object', `${def.name}: output.schema required`)
    assert.equal(typeof def.execute, 'function')
    const blocks = def.output.render({}, { ok: true })
    assert.ok(Array.isArray(blocks) && blocks.length === 1)
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.includes('"ok"'))
  }
  const compress = defs.find((d) => d.name === 'mulqi_cc_compress')
  assert.deepEqual([...compress.parameters.required].sort(), ['fromRef', 'summary', 'toRef'])
})

/** Build a mock Cordis ctx capturing registrations. */
function mockCtx({ sessionQuery = null, agentId = 'session-test' } = {}) {
  const recorded = { providers: 0, tools: [] }
  const ctx = {
    skills: {
      registerProvider(fn) {
        recorded.providers += 1
        recorded.providerFactory = fn
        return () => {
          recorded.providers -= 1
        }
      },
    },
    tools: {
      register(def) {
        recorded.tools.push(def)
        return () => {
          recorded.tools.splice(recorded.tools.indexOf(def), 1)
        }
      },
    },
    agents: { currentInitiator: () => ({ id: agentId }) },
    get: (key) => (key === 'sessionQuery' ? sessionQuery : undefined),
  }
  return { ctx, recorded }
}

const fixtureEvents = [
  { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'build the thing and verify' }] } },
  ...Array.from({ length: 12 }, (_, i) => ({
    seq: 2 + i,
    type: 'tool/result',
    data: { message: { toolName: 'bash', content: [{ type: 'text', text: `step ${i} result: ok` }] } },
  })),
  { seq: 14, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'now the backfill' }] } },
]

test('apply() registers one provider and four tools; disposer runs them', () => {
  const { ctx, recorded } = mockCtx()
  const dispose = pluginModule.apply(ctx)
  assert.equal(typeof pluginModule.name, 'string')
  assert.deepEqual([...pluginModule.inject].sort(), ['agents', 'skills', 'tools'])
  assert.equal(recorded.providers, 1)
  assert.equal(recorded.tools.length, 4)
  dispose()
  assert.equal(recorded.providers, 0)
  assert.equal(recorded.tools.length, 0)
})

test('the tool stack degrades gracefully without sessionQuery', async () => {
  const { ctx, recorded } = mockCtx()
  const dispose = pluginModule.apply(ctx)
  try {
    const status = recorded.tools.find((d) => d.name === 'mulqi_cc_status')
    const out = await status.execute({}, { signal: new AbortController().signal })
    assert.ok(out.ok)
    assert.equal(out.composition.messages, 0, 'no host surface available → empty fold state')
  } finally {
    dispose()
  }
})

test('full tool round-trip against a host surface fixture', async () => {
  const sessionQuery = { readSurface: async () => ({ events: fixtureEvents }) }
  const { ctx, recorded } = mockCtx({ sessionQuery })
  const dispose = pluginModule.apply(ctx)
  try {
    const exec = (name, args) => {
      const def = recorded.tools.find((d) => d.name === name)
      return def.execute(args, { signal: new AbortController().signal })
    }
    const status = await exec('mulqi_cc_status', {})
    assert.ok(status.ok)
    assert.equal(status.composition.messages, 14)
    const range = status.composition.ranges.find((r) => r.messageCount >= 3)
    assert.ok(range, 'a compressible mid range exists')
    const comp = await exec('mulqi_cc_compress', {
      fromRef: range.fromRef,
      toRef: range.toRef,
      topic: 'build+verify steps',
      summary: 'steps settled; results recorded',
    })
    assert.ok(comp.ok, comp.detail ?? '')
    assert.equal(comp.blockId, 'blk00001')
    const found = await exec('mulqi_cc_search', { query: 'settled' })
    assert.ok(found.ok)
    assert.ok(found.hits.some((h) => h.kind === 'block'))
    const listed = await exec('mulqi_cc_decompress', { blockId: 'list' })
    assert.ok(listed.listed.length >= 1)
    const restored = await exec('mulqi_cc_decompress', { blockId: 'blk00001', fromRef: range.fromRef })
    assert.ok(restored.ok)
    assert.ok(restored.restoredRefs.length > 0)
  } finally {
    dispose()
  }
})

test('package manifest pins the exact host version and bundle patch', async () => {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const pkg = JSON.parse(raw)
  assert.equal(pkg.name, 'mulqi-context-compression')
  assert.equal(pkg.dsh.engines.dsh, '0.2.1-rc.2')
  assert.equal(pkg.dsh.bundle.patch, 'cordis.patch.yml')
  assert.ok(pkg.files.includes('index.js'))
  assert.ok(!pkg.files.some((f) => String(f).startsWith('work/')), 'private audit work/ is not packaged')
  void pathToFileURL
})

test('RT: a call without agent identity fails closed instead of sharing a default fold', async () => {
  const { ctx, recorded } = mockCtx()
  ctx.agents.currentInitiator = () => undefined
  const dispose = pluginModule.apply(ctx)
  try {
    const status = recorded.tools.find((d) => d.name === 'mulqi_cc_status')
    const out = await status.execute({}, {})
    assert.equal(out.ok, false)
    assert.equal(out.code, 'no_session_identity')
  } finally {
    dispose()
  }
})

test('RT: a failing host read is surfaced, never reported as an empty clean session', async () => {
  const sessionQuery = { readSurface: async () => { throw new Error('sessionQuery down') } }
  const { ctx, recorded } = mockCtx({ sessionQuery })
  const dispose = pluginModule.apply(ctx)
  try {
    const status = recorded.tools.find((d) => d.name === 'mulqi_cc_status')
    const out = await status.execute({}, {})
    assert.ok(out.ok)
    assert.equal(out.hostRead, 'failed')
    assert.match(out.hostReadError ?? '', /sessionQuery down/)
  } finally {
    dispose()
  }
})
