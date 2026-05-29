import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitialState, runAgentTurn, runAgentTurnAsync } from '../src/agent/orchestrator'
import { deterministicPolisher, type ResponsePolisher } from '../src/agent/responsePolisher'
import type { AgentState, AgentTurn } from '../src/agent/types'

function runConversation(messages: string[]) {
  let state: AgentState = createInitialState()
  const turns: AgentTurn[] = []

  for (const message of messages) {
    const turn = runAgentTurn(message, state)
    state = turn.state
    turns.push(turn)
  }

  return turns
}

test('order status asks for an ID before lookup and resolves it on the next turn', () => {
  const [first, second] = runConversation(["Where's my order?", 'B1001'])

  assert.equal(first.trace.decision, 'ask_clarifying_question')
  assert.deepEqual(first.trace.missingSlots, ['orderId'])
  assert.equal(second.trace.decision, 'answer_with_grounded_data')
  assert.match(second.response, /1Z-BOOKLY-1001/)
})

test('eligible return collects item and reason before creating the request', () => {
  const [first, second, third] = runConversation([
    'I want to return something from B1002',
    'I-21',
    'It was damaged',
  ])

  assert.deepEqual(first.trace.missingSlots, ['itemId'])
  assert.deepEqual(second.trace.missingSlots, ['returnReason'])
  assert.equal(third.trace.decision, 'create_return')
  assert.match(third.response, /R-B1002-I-21/)
})

test('unsupported requests do not inherit a completed workflow', () => {
  const [, cancellation] = runConversation(['Where is B1001?', 'Cancel my order'])

  assert.equal(cancellation.state.intent, 'unknown')
  assert.equal(cancellation.trace.decision, 'unsupported_request')
  assert.equal(cancellation.trace.toolCalls.length, 0)
})

test('account help does not reuse a stale policy topic', () => {
  const [, accountHelp] = runConversation([
    'What is your refund policy?',
    "I can't log in to my account",
  ])

  assert.equal(accountHelp.trace.intent, 'account_help')
  assert.match(accountHelp.response, /^Password reset:/)
})

test('changing orders clears stale email and return-item slots', () => {
  const [, newStatus] = runConversation([
    'Where is B1001? My email is mira@example.com',
    'Where is B1002?',
  ])
  assert.equal(newStatus.trace.decision, 'answer_with_grounded_data')
  assert.match(newStatus.response, /order B1002/)

  const [, newReturn] = runConversation([
    'Return I-21 from B1002 because it was damaged',
    'Return something from B1003 because it was damaged',
  ])
  assert.equal(newReturn.trace.decision, 'ask_clarifying_question')
  assert.deepEqual(newReturn.trace.missingSlots, ['itemId'])
  assert.equal(newReturn.state.slots.itemId, undefined)
})

test('a low-confidence classifier result cannot trigger tools', async () => {
  const turn = await runAgentTurnAsync(
    'Where is B1001?',
    createInitialState(),
    deterministicPolisher,
    () => ({ intent: 'order_status', confidence: 0.2 }),
  )

  assert.equal(turn.trace.intent, 'unknown')
  assert.equal(turn.trace.decision, 'unsupported_request')
  assert.equal(turn.trace.toolCalls.length, 0)
})

test('response polishing changes wording without changing workflow decisions', async () => {
  const polisher: ResponsePolisher = ({ draftResponse }) => ({
    response: `Friendly: ${draftResponse}`,
    metadata: { mode: 'llm_stub', changed: true, note: 'Test adapter.' },
  })
  const deterministic = runAgentTurn('Where is B1001?')
  const polished = await runAgentTurnAsync('Where is B1001?', createInitialState(), polisher)

  assert.equal(polished.trace.decision, deterministic.trace.decision)
  assert.deepEqual(polished.trace.toolCalls, deterministic.trace.toolCalls)
  assert.match(polished.response, /^Friendly:/)
})
