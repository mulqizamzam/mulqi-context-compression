/**
 * writeSink containment — regression tests.
 *
 * `mulqi_cc_decompress` with `toFile: true` writes under
 * `<tmpdir>/mulqi-cc/<sessionKey>/`. The session key comes from the host
 * agent identity and is not guaranteed to be a plain path segment, so
 * writeSink must confine every write to its base directory.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import * as pluginModule from '../index.js'

/**
 * One protected first user message, then enough tool results to push the
 * middle ones out of the default recent zone (5 messages / 5000 tokens),
 * then the protected last user message.
 */
const events = [
  { seq: 1, type: 'user/message', data: { content: 'task intent' } },
  ...Array.from({ length: 10 }, (_, i) => ({
    seq: 2 + i,
    type: 'tool/result',
    data: { message: { toolName: 'bash', content: `step ${i}: `.repeat(400) } },
  })),
  { seq: 12, type: 'user/message', data: { content: 'continue' } },
]

/** Mock Cordis ctx that also exposes the registered tool defs. */
function mockCtx(agentId) {
  const tools = []
  const ctx = {
    skills: { registerProvider: () => () => {} },
    tools: {
      register(def) {
        tools.push(def)
        return () => tools.splice(tools.indexOf(def), 1)
      },
    },
    agents: { currentInitiator: () => ({ id: agentId }) },
    get: () => ({ readSurface: async () => ({ events }) }),
  }
  return { ctx, tools }
}

/** Compress one range, then decompress it to a file. Returns the tool DTOs. */
async function compressAndDecompress(agentId) {
  const { ctx, tools } = mockCtx(agentId)
  const dispose = pluginModule.apply(ctx)
  try {
    const exec = (name, args) =>
      tools.find((d) => d.name === name).execute(args, { signal: new AbortController().signal })
    const comp = await exec('mulqi_cc_compress', {
      fromRef: 'm00002',
      toRef: 'm00003',
      topic: 'build',
      summary: 'steps settled',
    })
    assert.ok(comp.ok, comp.detail ?? 'compress failed')
    const dec = await exec('mulqi_cc_decompress', { blockId: comp.blockId, toFile: true })
    return dec
  } finally {
    dispose()
  }
}

test('writeSink confines a traversal session key to the base directory', async () => {
  const base = path.join(tmpdir(), 'mulqi-cc')
  const dec = await compressAndDecompress('../../mulqi-cc-escape')
  assert.ok(dec.ok, dec.detail ?? 'decompress failed')

  const resolved = path.resolve(dec.file)
  const resolvedBase = path.resolve(base)
  assert.ok(
    resolved === resolvedBase || resolved.startsWith(resolvedBase + path.sep),
    `file escaped the base directory: ${dec.file}`,
  )

  try {
    rmSync(path.dirname(resolved), { recursive: true, force: true })
  } catch {
    /* cleanup is best-effort */
  }
})

test('writeSink keeps a plain session key in its own subdirectory', async () => {
  const base = path.join(tmpdir(), 'mulqi-cc')
  const dec = await compressAndDecompress('safe-session-01')
  assert.ok(dec.ok, dec.detail ?? 'decompress failed')

  const resolved = path.resolve(dec.file)
  const expectedDir = path.resolve(base, 'safe-session-01')
  assert.ok(
    path.dirname(resolved) === expectedDir,
    `expected ${resolved} to sit in ${expectedDir}`,
  )
  assert.ok(existsSync(resolved), 'the restored file exists')

  try {
    rmSync(expectedDir, { recursive: true, force: true })
  } catch {
    /* cleanup is best-effort */
  }
})
