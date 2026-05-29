import assert from 'node:assert/strict'
import test from 'node:test'
import { createLLMClassifier, deterministicClassifier } from '../src/agent/intentClassifier'

test('deterministic classifier distinguishes policy questions from return creation', async () => {
  assert.deepEqual(
    await deterministicClassifier({ message: 'What is your return window?', previousIntent: 'unknown' }),
    { intent: 'policy_question', confidence: 0.9 },
  )
  assert.deepEqual(
    await deterministicClassifier({ message: 'Return I-21 please', previousIntent: 'unknown' }),
    { intent: 'return_request', confidence: 0.92 },
  )
})

test('deterministic classifier rejects unsupported cancellation requests', async () => {
  assert.deepEqual(
    await deterministicClassifier({ message: 'Cancel order B1001', previousIntent: 'order_status' }),
    { intent: 'unknown', confidence: 0.44 },
  )
})

test('LLM classifier falls back when the proxy returns invalid confidence', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ intent: 'account_help', confidence: 9 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  try {
    const classifier = createLLMClassifier('http://proxy.test')
    assert.deepEqual(
      await classifier({ message: 'Where is B1001?', previousIntent: 'unknown' }),
      { intent: 'order_status', confidence: 0.88 },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
