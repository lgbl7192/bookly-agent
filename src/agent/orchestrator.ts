import {
  checkReturnEligibility,
  createReturnRequest,
  lookupOrder,
  searchPolicy,
} from '../tools/booklyTools'
import {
  deterministicClassifier,
  type ClassifierResult,
  type IntentClassifier,
} from './intentClassifier'
import {
  deterministicPolisher,
  type PolisherInput,
  type ResponsePolisher,
} from './responsePolisher'
import type {
  AgentState,
  AgentTurn,
  Decision,
  SlotKey,
  Slots,
  ToolCall,
  Trace,
} from './types'

const initialState: AgentState = {
  intent: 'unknown',
  slots: {},
  toolCalls: [],
}

export function createInitialState(): AgentState {
  return { ...initialState, slots: {}, toolCalls: [] }
}

export function runAgentTurn(
  userMessage: string,
  previousState: AgentState = createInitialState(),
): AgentTurn {
  const detected = deterministicClassifier({
    message: userMessage,
    previousIntent: previousState.intent,
  }) as ClassifierResult
  return buildAgentTurn(userMessage, previousState, deterministicPolisher, detected) as AgentTurn
}

// Design 7: intentClassifier is now an injectable dependency. When useLLM is on in the UI,
// createLLMClassifier is passed here so real language understanding replaces the regex path.
export async function runAgentTurnAsync(
  userMessage: string,
  previousState: AgentState = createInitialState(),
  responsePolisher: ResponsePolisher = deterministicPolisher,
  intentClassifier: IntentClassifier = deterministicClassifier,
): Promise<AgentTurn> {
  const detected = await Promise.resolve(
    intentClassifier({ message: userMessage, previousIntent: previousState.intent }),
  )
  return buildAgentTurn(userMessage, previousState, responsePolisher, detected)
}

function buildAgentTurn(
  userMessage: string,
  previousState: AgentState,
  responsePolisher: ResponsePolisher,
  detected: ClassifierResult,
): AgentTurn | Promise<AgentTurn> {
  const newSlots = extractSlots(userMessage)

  // Preserve the prior workflow intent when:
  // (a) detection is uncertain/unknown — the user is likely answering a slot question,
  //     not switching topics. Low confidence alone should not erase conversation context.
  // (b) the message contributed a workflow slot (order ID, item ID, return reason),
  //     meaning the user is clearly continuing the current flow.
  // The prior intent is only replaced when the classifier is confident about a NEW,
  // explicit intent (e.g. the customer pivots from a return to asking about shipping).
  const workflowSlotKeys: SlotKey[] = ['orderId', 'itemId', 'returnReason']
  const advancesWorkflow =
    previousState.intent !== 'unknown' &&
    workflowSlotKeys.some((k) => newSlots[k] !== undefined)
  const effectiveIntent =
    (detected.confidence < 0.5 || detected.intent === 'unknown' || advancesWorkflow) &&
    previousState.intent !== 'unknown'
      ? previousState.intent
      : detected.intent
  const slots = mergeSlots(previousState, newSlots, effectiveIntent)

  const state: AgentState = {
    intent: effectiveIntent,
    slots,
    toolCalls: [],
  }

  let response: string
  let decision: Decision
  let rationale: string
  let missingSlots: SlotKey[] = []

  if (effectiveIntent === 'ambiguous_order_help') {
    const result = handleAmbiguousOrderHelp()
    response = result.response
    decision = result.decision
    rationale = result.rationale
    missingSlots = result.missingSlots
  } else if (effectiveIntent === 'order_status') {
    const result = handleOrderStatus(userMessage, state)
    response = result.response
    decision = result.decision
    rationale = result.rationale
    missingSlots = result.missingSlots
  } else if (effectiveIntent === 'return_request') {
    const result = handleReturnRequest(userMessage, state)
    response = result.response
    decision = result.decision
    rationale = result.rationale
    missingSlots = result.missingSlots
  } else if (effectiveIntent === 'account_help') {
    // Bug 9 fix: account_help defaults to 'password reset', not 'shipping'.
    const result = handlePolicyQuestion(userMessage, state, 'password reset')
    response = result.response
    decision = result.decision
    rationale = result.rationale
    missingSlots = result.missingSlots
  } else if (effectiveIntent === 'policy_question') {
    const result = handlePolicyQuestion(userMessage, state, 'shipping')
    response = result.response
    decision = result.decision
    rationale = result.rationale
    missingSlots = result.missingSlots
  } else if (detected.confidence < 0.5) {
    const result = handleLowConfidence()
    response = result.response
    decision = result.decision
    rationale = result.rationale
    missingSlots = result.missingSlots
  } else {
    response =
      'I can help with order status, returns, refunds, shipping policy, or password resets. What would you like to do?'
    decision = 'ask_clarifying_question'
    rationale = 'The request did not map cleanly to a supported Bookly workflow.'
  }

  const draftTrace: Omit<Trace, 'responsePolishing'> = {
    intent: effectiveIntent,
    confidence: detected.confidence,
    slots: state.slots,
    missingSlots,
    toolCalls: state.toolCalls,
    decision,
    rationale,
  }
  const polisherInput: PolisherInput = {
    draftResponse: response,
    trace: {
      ...draftTrace,
      responsePolishing: {
        mode: 'deterministic',
        changed: false,
        note: 'Response polishing has not run yet.',
      },
    },
  }
  const polished = responsePolisher(polisherInput)

  if (polished instanceof Promise) {
    return polished.then((result) => finishTurn(result))
  }

  return finishTurn(polished)

  function finishTurn(polisherResult: Awaited<ReturnType<ResponsePolisher>>): AgentTurn {
    const trace: Trace = {
      ...draftTrace,
      responsePolishing: polisherResult.metadata,
    }
    return {
      response: polisherResult.response,
      state,
      trace,
    }
  }
}

function mergeSlots(previousState: AgentState, newSlots: Slots, effectiveIntent: AgentState['intent']) {
  const slots: Slots = {
    ...previousState.slots,
    ...newSlots,
  }
  const orderChanged =
    newSlots.orderId !== undefined && newSlots.orderId !== previousState.slots.orderId

  if (orderChanged) {
    if (!newSlots.email) delete slots.email
    if (!newSlots.itemId) delete slots.itemId
    if (!newSlots.returnReason) delete slots.returnReason
  }

  if (effectiveIntent !== previousState.intent) {
    if (effectiveIntent === 'return_request') {
      if (!newSlots.itemId) delete slots.itemId
      if (!newSlots.returnReason) delete slots.returnReason
    }

    if (effectiveIntent === 'policy_question' && !newSlots.policyTopic) {
      delete slots.policyTopic
    }

    if (effectiveIntent === 'account_help') {
      slots.policyTopic = 'password reset'
    }
  }

  return slots
}

function extractSlots(message: string): Slots {
  const orderId = message.match(/\bB\d{4}\b/i)?.[0].toUpperCase()
  const email = message.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0].toLowerCase()
  const itemId = message.match(/\bI-\d{2}\b/i)?.[0].toUpperCase()
  const slots: Slots = {}

  if (orderId) slots.orderId = orderId
  if (email) slots.email = email
  if (itemId) slots.itemId = itemId

  const lower = message.toLowerCase()
  if (lower.includes('damaged')) slots.returnReason = 'damaged'
  if (lower.includes('wrong')) slots.returnReason = 'wrong item'
  if (lower.includes('changed my mind')) slots.returnReason = 'changed mind'
  if (lower.includes('password')) slots.policyTopic = 'password reset'
  if (lower.includes('refund')) slots.policyTopic = 'refunds'
  if (lower.includes('return')) slots.policyTopic = 'returns'
  if (lower.includes('shipping') || lower.includes('ship')) slots.policyTopic = 'shipping'

  return slots
}

function handleOrderStatus(userMessage: string, state: AgentState): TurnParts {
  const missing = missingRequiredSlots(state.slots, ['orderId'])
  if (missing.length > 0) {
    const nearMiss = detectNearMissOrderId(userMessage)
    return {
      response: nearMiss
        ? `I couldn't recognise "${nearMiss}" as a Bookly order ID — they're exactly 4 digits, for example B1001. Could you double-check?`
        : 'I can check that. What is the Bookly order ID? It should look like B1001.',
      decision: 'ask_clarifying_question',
      rationale: nearMiss
        ? 'The provided string resembles an order ID but has the wrong format; the agent corrects it before retrying the tool.'
        : 'Order status needs a customer-specific identifier before the agent can use the order lookup tool.',
      missingSlots: missing,
    }
  }

  const result = lookupOrder({
    orderId: state.slots.orderId,
    email: state.slots.email,
  })
  recordToolCall(state, 'lookupOrder', state.slots, result)

  if (!result.ok) {
    return {
      response:
        "I couldn't find that order in Bookly's records. I do not want to guess, so I would hand this to a support specialist or ask you to verify the order ID and email.",
      decision: 'route_to_human',
      rationale: 'The source-of-truth order tool did not return a match.',
      missingSlots: [],
    }
  }

  const order = result.data
  const statusLine =
    order.status === 'delivered'
      ? `It was delivered on ${order.deliveredOn}.`
      : order.status === 'shipped'
        ? `It shipped via ${order.carrier} with tracking ${order.trackingNumber}. Estimated delivery is ${order.estimatedDelivery}.`
        : order.status === 'delayed'
          ? `It is delayed. The latest estimated delivery date is ${order.estimatedDelivery}.`
          : `It is still processing and has not shipped yet.`

  return {
    response: `I found order ${order.id} for ${order.customerName}. ${statusLine}`,
    decision: 'answer_with_grounded_data',
    rationale: 'The answer is grounded in the mocked Bookly order API result.',
    missingSlots: [],
  }
}

function handleAmbiguousOrderHelp(): TurnParts {
  return {
    response:
      'I can help with that. Are you trying to check order status, start a return/refund, or ask about a Bookly policy?',
    decision: 'ask_clarifying_question',
    rationale:
      'The message references an order, but the requested support workflow is ambiguous, so the agent clarifies before choosing tools.',
    missingSlots: [],
  }
}

function handleLowConfidence(): TurnParts {
  return {
    response:
      'I am not confident this is one of the automated Bookly workflows I can safely handle. I can help with order status, returns/refunds, shipping policy, or password resets; otherwise I would route this to a support specialist.',
    decision: 'unsupported_request',
    rationale:
      'The request fell below the confidence threshold for automated handling, so the agent avoids acting or fabricating an answer.',
    missingSlots: [],
  }
}

function handleReturnRequest(userMessage: string, state: AgentState): TurnParts {
  const missingOrderSlots = missingRequiredSlots(state.slots, ['orderId'])
  if (missingOrderSlots.length > 0) {
    const nearMiss = detectNearMissOrderId(userMessage)
    return {
      response: nearMiss
        ? `I couldn't recognise "${nearMiss}" as a Bookly order ID — they're exactly 4 digits, for example B1002. Could you double-check?`
        : 'I can help start a return. First, what is the Bookly order ID? It should look like B1002.',
      decision: 'ask_clarifying_question',
      rationale: nearMiss
        ? 'The provided string resembles an order ID but has the wrong format; the agent corrects it before retrying the tool.'
        : 'The agent needs an order before it can inspect items or eligibility.',
      missingSlots: missingOrderSlots,
    }
  }

  const orderResult = lookupOrder({
    orderId: state.slots.orderId,
    email: state.slots.email,
  })
  recordToolCall(
    state,
    'lookupOrder',
    { orderId: state.slots.orderId, email: state.slots.email },
    orderResult,
  )

  if (!orderResult.ok) {
    return {
      response:
        "I couldn't find that order, so I should not create a return. Please verify the order ID or I can route this to a support specialist.",
      decision: 'route_to_human',
      rationale: 'Return creation is blocked because the order lookup tool failed.',
      missingSlots: [],
    }
  }

  if (!state.slots.itemId) {
    const matched = fuzzyMatchItem(userMessage, orderResult.data.items)
    if (matched) {
      state.slots.itemId = matched.id
    } else {
      const itemList = orderResult.data.items.map((item) => `${item.id}: ${item.title}`).join('; ')
      return {
        response: `Which item do you want to return? I found ${itemList}.`,
        decision: 'ask_clarifying_question',
        rationale:
          'The order contains item-level return decisions, so the agent asks before checking eligibility.',
        missingSlots: ['itemId'],
      }
    }
  }

  // orderId and itemId are guaranteed set by the guards above.
  const orderId = state.slots.orderId!
  const itemId = state.slots.itemId!

  // Bug 2 fix: removed the unreachable `if (!orderId || !itemId)` guard that followed here.

  const eligibility = checkReturnEligibility({ orderId, itemId })
  recordToolCall(state, 'checkReturnEligibility', { orderId, itemId }, eligibility)

  if (!eligibility.ok) {
    return {
      response: `${eligibility.error} I can route this to a support specialist if you think the order details are wrong.`,
      decision: 'route_to_human',
      rationale: 'The eligibility tool could not verify a safe automated return path.',
      missingSlots: [],
    }
  }

  if (!eligibility.data.eligible) {
    return {
      response: `${eligibility.data.reason} I cannot create this return automatically, but I can escalate it for manual review.`,
      decision: 'decline_and_offer_escalation',
      rationale: 'The agent follows policy rather than overriding return eligibility.',
      missingSlots: [],
    }
  }

  if (!state.slots.returnReason) {
    return {
      response:
        'This item is eligible for return. What is the return reason: damaged, wrong item, or changed my mind?',
      decision: 'ask_clarifying_question',
      rationale: 'The return tool requires a reason before creating the request.',
      missingSlots: ['returnReason'],
    }
  }

  const returnRequest = createReturnRequest({
    orderId,
    itemId,
    reason: state.slots.returnReason,
  })
  recordToolCall(
    state,
    'createReturnRequest',
    {
      orderId: state.slots.orderId,
      itemId: state.slots.itemId,
      reason: state.slots.returnReason,
    },
    returnRequest,
  )

  if (!returnRequest.ok) {
    return {
      response: `${returnRequest.error} I can escalate this for manual review.`,
      decision: 'decline_and_offer_escalation',
      rationale: 'The create-return tool rejected the request.',
      missingSlots: [],
    }
  }

  return {
    response: `Done. I created return ${returnRequest.data.returnId}. ${returnRequest.data.labelStatus}`,
    decision: 'create_return',
    rationale: 'The agent only created the return after order lookup and eligibility checks succeeded.',
    missingSlots: [],
  }
}

// Bug 9 fix: `defaultTopic` lets account_help pass 'password reset' so an intent like
// "I can't log in" no longer falls back to the shipping policy.
function handlePolicyQuestion(message: string, state: AgentState, defaultTopic = 'shipping'): TurnParts {
  const topic =
    state.slots.policyTopic ??
    (message.toLowerCase().includes('password') ? 'password reset' : defaultTopic)
  const policy = searchPolicy({ topic })
  recordToolCall(state, 'searchPolicy', { topic }, policy)

  if (!policy.ok) {
    return {
      response:
        "I could not find a grounded policy article for that. I'd route this to a support specialist instead of guessing.",
      decision: 'route_to_human',
      rationale: 'Policy answers are constrained to the Bookly policy source.',
      missingSlots: [],
    }
  }

  return {
    response: `${policy.data.title}: ${policy.data.summary}`,
    decision: 'answer_with_grounded_data',
    rationale: 'The response uses the mocked Bookly policy knowledge base.',
    missingSlots: [],
  }
}

function missingRequiredSlots(slots: Slots, required: SlotKey[]) {
  return required.filter((slot) => !slots[slot])
}

function recordToolCall(
  state: AgentState,
  name: string,
  input: Record<string, unknown>,
  result: unknown,
) {
  const compactInput = Object.fromEntries(
    Object.entries(input).filter(([, value]) => Boolean(value)),
  )
  const toolCall: ToolCall = { name, input: compactInput, result }
  state.toolCalls.push(toolCall)
}

function fuzzyMatchItem(
  message: string,
  items: { id: string; title: string }[],
): { id: string; title: string } | undefined {
  const lower = message.toLowerCase()
  const stopwords = new Set(['the', 'and', 'from', 'that', 'this', 'with', 'one', 'want', 'item'])
  return items.find((item) => {
    const words = item.title
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !stopwords.has(w))
    return words.some((word) => lower.includes(word))
  })
}

// Returns the raw token (e.g. "B10002") if the message contains something that looks like a
// Bookly order ID but has the wrong number of digits, so handlers can surface a format hint
// instead of a generic "please provide your order ID" prompt.
function detectNearMissOrderId(message: string): string | undefined {
  const match = message.match(/\bB\d{3,6}\b/i)?.[0].toUpperCase()
  if (!match) return undefined
  // Exact 4-digit IDs are valid and would already be in slots — only flag the mismatches.
  return /^B\d{4}$/.test(match) ? undefined : match
}

type TurnParts = {
  response: string
  decision: Decision
  rationale: string
  missingSlots: SlotKey[]
}
