import assert from 'node:assert/strict'
import test from 'node:test'
import { createLLMPolisher } from '../src/agent/responsePolisher'
import { createInitialState, runAgentTurnAsync } from '../src/agent/orchestrator'

test('LLM polisher discards rewrites that change grounded identifiers or dates', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        response: 'Your order B1001 was delivered on 2026-06-01.',
        provider: 'test',
        model: 'unsafe-rewrite',
        changed: true,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )

  try {
    const turn = await runAgentTurnAsync(
      'Where is B1001?',
      createInitialState(),
      createLLMPolisher('http://proxy.test/api/polish'),
    )

    assert.match(turn.response, /1Z-BOOKLY-1001/)
    assert.match(turn.response, /2026-05-31/)
    assert.doesNotMatch(turn.response, /2026-06-01/)
    assert.match(turn.trace.responsePolishing.note, /discarded/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
