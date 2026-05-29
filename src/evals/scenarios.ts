import { createInitialState, runAgentTurn, runAgentTurnAsync } from '../agent/orchestrator'
import type { ResponsePolisher } from '../agent/responsePolisher'
import type { AgentState, AgentTurn } from '../agent/types'

type EvalCase = {
  name: string
  turns: string[]
  assert: (turns: AgentTurn[]) => string | undefined
}

const cases: EvalCase[] = [
  {
    name: 'asks for an order ID before checking status',
    turns: ["Where's my order?"],
    assert: ([turn]) =>
      turn.trace.decision === 'ask_clarifying_question' &&
      turn.trace.missingSlots.includes('orderId')
        ? undefined
        : 'Expected orderId clarification before tool use.',
  },
  {
    name: 'uses lookupOrder when order ID is present',
    turns: ['Can you check B1001?'],
    assert: ([turn]) =>
      turn.trace.toolCalls.some((call) => call.name === 'lookupOrder') &&
      turn.response.includes('1Z-BOOKLY-1001')
        ? undefined
        : 'Expected lookupOrder and grounded tracking response.',
  },
  {
    name: 'collects item ID before return eligibility',
    turns: ['I want to return something from B1002'],
    assert: ([turn]) =>
      turn.trace.missingSlots.includes('itemId') && turn.response.includes('I-21')
        ? undefined
        : 'Expected item-level clarification for return.',
  },
  {
    name: 'creates eligible return only after reason',
    turns: [
      'I want to return something from B1002',
      'I-21',
      'It was damaged',
    ],
    assert: (turns) => {
      const finalTurn = turns.at(-1)
      return finalTurn?.trace.decision === 'create_return' &&
        finalTurn.response.includes('R-B1002-I-21')
        ? undefined
        : 'Expected return creation after order lookup, eligibility, and reason.'
    },
  },
  {
    name: 'declines final-sale return',
    turns: ['I want to return I-22 from B1002 because I changed my mind'],
    assert: ([turn]) =>
      turn.trace.decision === 'decline_and_offer_escalation' &&
      turn.response.toLowerCase().includes('final sale')
        ? undefined
        : 'Expected final-sale guardrail.',
  },
  {
    name: 'grounds policy answers in policy tool',
    turns: ['What is your refund policy?'],
    assert: ([turn]) =>
      turn.trace.toolCalls.some((call) => call.name === 'searchPolicy') &&
      turn.response.includes('Refund timing')
        ? undefined
        : 'Expected policy search and refund answer.',
  },
  {
    name: 'clarifies ambiguous order help before tool use',
    turns: ['I need help with my order'],
    assert: ([turn]) =>
      turn.trace.intent === 'ambiguous_order_help' &&
      turn.trace.decision === 'ask_clarifying_question' &&
      turn.trace.toolCalls.length === 0
        ? undefined
        : 'Expected ambiguous order help clarification with no tool call.',
  },
  {
    name: 'routes unknown orders to human instead of guessing',
    turns: ['Can you check B9999?'],
    assert: ([turn]) =>
      turn.trace.decision === 'route_to_human' &&
      turn.trace.toolCalls.some((call) => call.name === 'lookupOrder') &&
      turn.response.toLowerCase().includes('support specialist')
        ? undefined
        : 'Expected lookup failure to route to human.',
  },
  {
    name: 'routes account_help to password reset policy by default',
    turns: ["I can't log in to my account"],
    assert: ([turn]) =>
      turn.trace.intent === 'account_help' &&
      turn.trace.decision === 'answer_with_grounded_data' &&
      turn.response.toLowerCase().includes('password reset')
        ? undefined
        : 'Expected password reset policy for account_help without password keyword in message.',
  },
  {
    name: 'does not automate unsupported price match requests',
    turns: ['Can you price match Amazon?'],
    assert: ([turn]) =>
      turn.trace.decision === 'unsupported_request' &&
      turn.trace.toolCalls.length === 0
        ? undefined
        : 'Expected unsupported request guardrail with no tool use.',
  },

  // --- Depth: Order Status ---

  {
    name: 'order status: multi-turn preserves intent across slot collection',
    turns: ['Track my package', 'B1001'],
    assert: (turns) => {
      const [first, second] = turns
      if (
        first.trace.decision !== 'ask_clarifying_question' ||
        !first.trace.missingSlots.includes('orderId')
      )
        return 'Expected first turn to ask for order ID.'
      if (
        second.trace.decision !== 'answer_with_grounded_data' ||
        !second.trace.toolCalls.some((c) => c.name === 'lookupOrder')
      )
        return 'Expected second turn to call lookupOrder with grounded response.'
      if (!second.response.includes('1Z-BOOKLY-1001'))
        return 'Expected tracking number in grounded response.'
      return undefined
    },
  },
  {
    name: 'order status: delivered order includes delivery date',
    turns: ['Check order B1002'],
    assert: ([turn]) =>
      turn.trace.decision === 'answer_with_grounded_data' &&
      turn.response.includes('2026-05-10')
        ? undefined
        : 'Expected delivered order response to include the delivery date.',
  },
  {
    name: 'order status: delayed order mentions delay status and updated ETA',
    turns: ['Where is B1004?'],
    assert: ([turn]) =>
      turn.trace.decision === 'answer_with_grounded_data' &&
      turn.response.toLowerCase().includes('delayed') &&
      turn.response.includes('2026-06-03')
        ? undefined
        : 'Expected delayed order to mention delay status and updated ETA.',
  },

  // --- Depth: Returns ---

  {
    name: 'return: blocked when order not yet delivered',
    turns: ['I want to return I-11 from B1001, it was damaged'],
    assert: ([turn]) =>
      turn.trace.decision === 'decline_and_offer_escalation' &&
      turn.response.toLowerCase().includes('delivery')
        ? undefined
        : 'Expected return to be blocked because the order has not been delivered yet.',
  },
  {
    name: 'return: blocked when outside 30-day return window',
    turns: ['I want to return I-31 from B1003, it was damaged'],
    assert: ([turn]) =>
      turn.trace.decision === 'decline_and_offer_escalation' &&
      turn.response.toLowerCase().includes('30 days')
        ? undefined
        : 'Expected return to be declined for being outside the 30-day window.',
  },
  {
    name: 'return: fuzzy item name match enables single-turn return creation',
    turns: ['return my data book from B1002 because it was damaged'],
    assert: ([turn]) =>
      turn.trace.decision === 'create_return' &&
      turn.response.includes('R-B1002-I-21')
        ? undefined
        : 'Expected fuzzy match on "data" to resolve I-21 and complete the return in one turn.',
  },

  // --- Depth: Policy ---

  {
    name: 'policy: shipping question grounds answer in policy tool',
    turns: ['How long does shipping take?'],
    assert: ([turn]) =>
      turn.trace.toolCalls.some((c) => c.name === 'searchPolicy') &&
      turn.response.includes('Shipping policy')
        ? undefined
        : 'Expected shipping policy to be retrieved and included in response.',
  },
  {
    name: 'policy: return window question should not start a return workflow',
    turns: ['What is your return window?'],
    assert: ([turn]) =>
      turn.trace.intent !== 'return_request'
        ? undefined
        : 'CLASSIFIER GAP: "return window" was misclassified as return_request; expected policy_question intent.',
  },
  {
    name: 'account help: explicit password keyword routes to password reset policy',
    turns: ['how do I reset my password'],
    assert: ([turn]) =>
      turn.trace.intent === 'account_help' &&
      turn.trace.decision === 'answer_with_grounded_data' &&
      turn.response.includes('Password reset')
        ? undefined
        : 'Expected account_help with password keyword to answer with the password reset policy.',
  },

  // --- Depth: Guardrails ---

  {
    name: 'guardrail: cancel order treated as unsupported request',
    turns: ['I need to cancel my order'],
    assert: ([turn]) =>
      turn.trace.decision === 'unsupported_request' && turn.trace.toolCalls.length === 0
        ? undefined
        : 'Expected cancel order to be flagged as unsupported with no tool use.',
  },
  {
    name: 'guardrail: off-topic request handled gracefully without tool use',
    turns: ["What's the weather today?"],
    assert: ([turn]) =>
      turn.trace.decision === 'unsupported_request' && turn.trace.toolCalls.length === 0
        ? undefined
        : 'Expected off-topic request to be handled gracefully with no tool use.',
  },

  // --- Near-miss order ID handling ---

  {
    name: 'near-miss order ID: order status gives format hint instead of generic prompt',
    turns: ['Where is B10002?'],
    assert: ([turn]) =>
      turn.trace.decision === 'ask_clarifying_question' &&
      turn.trace.missingSlots.includes('orderId') &&
      turn.response.includes('B10002') &&
      turn.response.toLowerCase().includes('4 digits')
        ? undefined
        : 'Expected a format-correction hint mentioning the bad ID and the 4-digit rule.',
  },
  {
    name: 'near-miss order ID: return workflow gives format hint instead of generic prompt',
    turns: ['I need to return something from B10002'],
    assert: ([turn]) =>
      turn.trace.decision === 'ask_clarifying_question' &&
      turn.trace.missingSlots.includes('orderId') &&
      turn.response.includes('B10002') &&
      turn.response.toLowerCase().includes('4 digits')
        ? undefined
        : 'Expected a format-correction hint mentioning the bad ID and the 4-digit rule.',
  },
  {
    name: 'near-miss order ID: corrected ID on follow-up completes the order status lookup',
    turns: ['Track my package', 'B10002', 'B1001'],
    assert: (turns) => {
      const [, hint, resolved] = turns
      if (!hint.response.includes('B10002') || !hint.response.toLowerCase().includes('4 digits'))
        return 'Expected second turn to give a format hint for B10002.'
      if (
        resolved.trace.decision !== 'answer_with_grounded_data' ||
        !resolved.trace.toolCalls.some((c) => c.name === 'lookupOrder') ||
        !resolved.response.includes('1Z-BOOKLY-1001')
      )
        return 'Expected third turn to resolve with grounded order data after corrected ID.'
      return undefined
    },
  },
]

const friendlyTestPolisher: ResponsePolisher = ({ draftResponse }) => ({
  response: `Thanks for checking in. ${draftResponse}`,
  metadata: {
    mode: 'llm_stub',
    changed: true,
    note: 'Test polisher changed wording only.',
  },
})

function runConversation(turns: string[]) {
  let state: AgentState = createInitialState()
  const results: AgentTurn[] = []

  for (const turn of turns) {
    const result = runAgentTurn(turn, state)
    state = result.state
    results.push(result)
  }

  return results
}

let failures = 0

for (const testCase of cases) {
  const turns = runConversation(testCase.turns)
  const error = testCase.assert(turns)
  if (error) {
    failures += 1
    console.error(`FAIL ${testCase.name}: ${error}`)
  } else {
    console.log(`PASS ${testCase.name}`)
  }
}

const unpolished = runAgentTurn('Can you check B1001?')
const polished = await runAgentTurnAsync(
  'Can you check B1001?',
  createInitialState(),
  friendlyTestPolisher,
)

if (
  polished.trace.decision !== unpolished.trace.decision ||
  JSON.stringify(polished.trace.toolCalls) !== JSON.stringify(unpolished.trace.toolCalls) ||
  !polished.response.startsWith('Thanks for checking in.')
) {
  failures += 1
  console.error(
    'FAIL response polishing preserves workflow invariants: Expected wording changes without decision or tool-call changes.',
  )
} else {
  console.log('PASS response polishing preserves workflow invariants')
}

if (failures > 0) {
  throw new Error(`${failures} eval scenario(s) failed.`)
}
