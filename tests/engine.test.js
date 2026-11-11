/**
 * Auto fold engine entry: hermetic behavior (no host boot).
 *
 * In this test environment @deepseek-ai/dsh-compaction-basic is NOT
 * resolvable, so the entry deactivates itself (InactiveBase path): the
 * constructor must warn, register nothing, and never throw. The host-gated
 * engine tests live in engine-host.test.js.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import engineModule from '../compaction-engine.js'
import { agentSessionKey } from '../compaction-engine.js'

function mockCtx() {
  const warns = []
  return {
    ctx: {
      logger: { warn: (m) => warns.push(m), info: () => {}, error: () => {} },
      on: () => {},
      get: () => undefined,
      // the CompactionEngine base registers itself as a Cordis service on
      // construction; the fake provides that seam as a no-op.
      reflect: { provide: () => () => {} },
    },
    warns,
  }
}

test('the entry constructs without throwing in both base variants', async () => {
  const resolvable = await import('@deepseek-ai/dsh-compaction-basic')
    .then(() => true)
    .catch(() => false)
  const Engine = engineModule
  const { ctx, warns } = mockCtx()
  let instance = null
  assert.doesNotThrow(() => {
    instance = new Engine(ctx, { auto: false })
  }, 'the entry constructor must never break a profile boot')
  assert.ok(instance, 'an instance is still handed to the loader')
  if (!resolvable) {
    assert.ok(
      warns.some((w) => w.includes('not resolvable') || w.includes('inactive')),
      'the deactivation is surfaced as a visible warning',
    )
  }
})

test('agentSessionKey resolves the tools-entry session identity', () => {
  assert.equal(agentSessionKey({ id: 'agent-1' }), 'agent-1')
  assert.equal(agentSessionKey({ id: '', session: { id: 'agent-2' } }), 'agent-2')
  assert.equal(agentSessionKey({}), undefined)
  assert.equal(agentSessionKey(null), undefined)
  assert.equal(agentSessionKey(42), undefined)
})
