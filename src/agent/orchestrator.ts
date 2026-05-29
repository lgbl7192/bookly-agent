import {
  checkReturnEligibility,
  createReturnRequest,
  lookupOrder,
  searchPolicy,
} from '../tools/booklyTools'
import {
  deterministicClassifier,
  isCourtesyMessage,
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
  ResponseCode,
  ReturnSession,
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
  return { ...initialState, slots: {}, toolCalls: [], returnSession: undefined }
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

  // Preserve the prior workflow only when the message supplies a slot or names another item
  // in the current return order. Unknown messages must not replay a completed workflow.
  const workflowSlotKeys: SlotKey[] = ['orderId', 'itemId', 'returnReason']
  const returnSessionIsActive = isActiveReturnSession(previousState.returnSession)
  const continuationIntent =
    previousState.intent !== 'unknown'
      ? previousState.intent
      : returnSessionIsActive
        ? 'return_request'
        : 'unknown'
  const advancesWorkflow =
    continuationIntent !== 'unknown' &&
    workflowSlotKeys.some((k) => newSlots[k] !== undefined)
  const currentReturnItem = findCurrentReturnItem(userMessage, previousState)
  const continuesCurrentReturn =
    (previousState.intent === 'return_request' || returnSessionIsActive) &&
    Boolean(currentReturnItem)
  const effectiveIntent = isCourtesyMessage(userMessage)
    ? 'courtesy'
    : detected.intent === 'unknown' &&
    continuationIntent !== 'unknown' &&
    (advancesWorkflow || continuesCurrentReturn)
      ? continuationIntent
      : detected.confidence < 0.5
        ? 'unknown'
        : detected.intent
  const state: AgentState = {
    intent: effectiveIntent,
    slots: mergeGeneralSlots(previousState, newSlots, effectiveIntent),
    returnSession: previousState.returnSession
      ? { ...previousState.returnSession }
      : undefined,
    toolCalls: [],
  }
  if (effectiveIntent === 'return_request') {
    state.returnSession = prepareReturnSession(
      userMessage,
      previousState,
      newSlots,
      detected,
      Boolean(currentReturnItem),
    )
    syncReturnSlots(state)
  }

  let response: string
  let decision: Decision
  let responseCode: ResponseCode | undefined
  let rationale: string
  let missingSlots: SlotKey[] = []

  if (effectiveIntent === 'courtesy') {
    response = "You're welcome! Is there anything else I can help with?"
    decision = 'answer_conversationally'
    rationale = 'The customer expressed thanks, so the agent acknowledges it without using tools.'
  } else if (effectiveIntent === 'ambiguous_order_help') {
    const result = handleAmbiguousOrderHelp()
    response = result.response
    decision = result.decision
    rationale = result.rationale
    responseCode = result.responseCode
    missingSlots = result.missingSlots
  } else if (effectiveIntent === 'order_status') {
    const result = handleOrderStatus(userMessage, state)
    response = result.response
    decision = result.decision
    rationale = result.rationale
    responseCode = result.responseCode
    missingSlots = result.missingSlots
  } else if (effectiveIntent === 'return_request') {
    const result = handleReturnRequest(userMessage, state)
    response = result.response
    decision = result.decision
    rationale = result.rationale
    responseCode = result.responseCode
    missingSlots = result.missingSlots
  } else if (effectiveIntent === 'account_help') {
    // Bug 9 fix: account_help defaults to 'password reset', not 'shipping'.
    const result = handlePolicyQuestion(userMessage, state, 'password reset')
    response = result.response
    decision = result.decision
    rationale = result.rationale
    responseCode = result.responseCode
    missingSlots = result.missingSlots
  } else if (effectiveIntent === 'policy_question') {
    const result = handlePolicyQuestion(userMessage, state, 'shipping')
    response = result.response
    decision = result.decision
    rationale = result.rationale
    responseCode = result.responseCode
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
    returnSession: state.returnSession,
    missingSlots,
    toolCalls: state.toolCalls,
    decision,
    responseCode,
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

function mergeGeneralSlots(
  previousState: AgentState,
  newSlots: Slots,
  effectiveIntent: AgentState['intent'],
) {
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
    if (effectiveIntent === 'policy_question' && !newSlots.policyTopic) {
      delete slots.policyTopic
    }

    if (effectiveIntent === 'account_help') {
      slots.policyTopic = 'password reset'
    }
  }

  return slots
}

function prepareReturnSession(
  userMessage: string,
  previousState: AgentState,
  newSlots: Slots,
  detected: ClassifierResult,
  matchesCurrentItem: boolean,
): ReturnSession {
  const previousSession = previousState.returnSession
  const startsAnotherOrder = /\b(?:another|different|new)\s+order\b/i.test(userMessage)
  const startsAnotherItem = /\b(?:another|different|new)\s+(?:item|book|return)\b/i.test(userMessage)
  const terminalSession =
    previousSession?.phase === 'complete' || previousSession?.phase === 'declined'
  const restartsTerminalSession =
    terminalSession &&
    detected.intent === 'return_request' &&
    !matchesCurrentItem &&
    !newSlots.orderId &&
    !newSlots.itemId &&
    !newSlots.returnReason
  const startsFresh =
    !previousSession ||
    (previousState.intent !== 'return_request' && !isActiveReturnSession(previousSession)) ||
    startsAnotherOrder ||
    restartsTerminalSession
  const session: ReturnSession = startsFresh
    ? { phase: 'collect_order' }
    : { ...previousSession }

  if (startsAnotherItem) {
    delete session.itemId
    delete session.reason
    session.phase = session.orderId ? 'collect_item' : 'collect_order'
  }

  if (newSlots.orderId && newSlots.orderId !== session.orderId) {
    session.orderId = newSlots.orderId
    session.email = newSlots.email
    delete session.itemId
    delete session.reason
    session.phase = 'collect_item'
  } else if (newSlots.email) {
    session.email = newSlots.email
  }

  if (newSlots.itemId && newSlots.itemId !== session.itemId) {
    session.itemId = newSlots.itemId
    delete session.reason
    session.phase = 'collect_reason'
  }

  if (newSlots.returnReason) {
    session.reason = newSlots.returnReason
  }

  return session
}

function isActiveReturnSession(session: ReturnSession | undefined) {
  return (
    session?.phase === 'collect_order' ||
    session?.phase === 'collect_item' ||
    session?.phase === 'collect_reason'
  )
}

function syncReturnSlots(state: AgentState) {
  delete state.slots.orderId
  delete state.slots.email
  delete state.slots.itemId
  delete state.slots.returnReason

  const session = state.returnSession
  if (!session) return

  if (session.orderId) state.slots.orderId = session.orderId
  if (session.email) state.slots.email = session.email
  if (session.itemId) state.slots.itemId = session.itemId
  if (session.reason) state.slots.returnReason = session.reason
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
  const session = state.returnSession ?? { phase: 'collect_order' }
  state.returnSession = session

  if (!session.orderId) {
    session.phase = 'collect_order'
    const nearMiss = detectNearMissOrderId(userMessage)
    return buildReturnTurn(state, 'ASK_RETURN_ORDER_ID', { nearMiss }, {
      decision: 'ask_clarifying_question',
      rationale: nearMiss
        ? 'The provided string resembles an order ID but has the wrong format; the agent corrects it before retrying the tool.'
        : 'The agent needs an order before it can inspect items or eligibility.',
      missingSlots: ['orderId'],
    })
  }

  const orderResult = lookupOrder({
    orderId: session.orderId,
    email: session.email,
  })
  recordToolCall(
    state,
    'lookupOrder',
    { orderId: session.orderId, email: session.email },
    orderResult,
  )

  if (!orderResult.ok) {
    session.phase = 'collect_order'
    return buildReturnTurn(state, 'RETURN_ORDER_NOT_FOUND', {}, {
      decision: 'route_to_human',
      rationale: 'Return creation is blocked because the order lookup tool failed.',
      missingSlots: [],
    })
  }

  const matched = fuzzyMatchItem(userMessage, orderResult.data.items)
  if (matched && matched.id !== session.itemId) {
    const replacesSelectedItem = session.itemId !== undefined
    session.itemId = matched.id
    if (replacesSelectedItem) delete session.reason
  }

  if (!session.itemId) {
    if (matched) {
      session.itemId = matched.id
    } else if (orderResult.data.items.length === 1) {
      session.itemId = orderResult.data.items[0].id
    } else {
      const itemList = orderResult.data.items.map((item) => `${item.id}: ${item.title}`).join('; ')
      session.phase = 'collect_item'
      return buildReturnTurn(state, 'ASK_RETURN_ITEM', { itemList }, {
        decision: 'ask_clarifying_question',
        rationale:
          'The order contains item-level return decisions, so the agent asks before checking eligibility.',
        missingSlots: ['itemId'],
      })
    }
  }

  const orderId = session.orderId
  const itemId = session.itemId

  const eligibility = checkReturnEligibility({ orderId, itemId })
  recordToolCall(state, 'checkReturnEligibility', { orderId, itemId }, eligibility)

  if (!eligibility.ok) {
    session.phase = 'collect_item'
    return buildReturnTurn(state, 'RETURN_ITEM_NOT_FOUND', { error: eligibility.error }, {
      decision: 'route_to_human',
      rationale: 'The eligibility tool could not verify a safe automated return path.',
      missingSlots: [],
    })
  }

  if (!eligibility.data.eligible) {
    session.phase = 'declined'
    return buildReturnTurn(
      state,
      eligibility.data.reasonCode === 'not_delivered'
        ? 'RETURN_NOT_DELIVERED'
        : eligibility.data.reasonCode === 'final_sale'
          ? 'RETURN_FINAL_SALE'
          : eligibility.data.reasonCode === 'outside_window'
            ? 'RETURN_OUTSIDE_WINDOW'
            : 'RETURN_INELIGIBLE',
      { reason: eligibility.data.reason },
      {
      decision: 'decline_and_offer_escalation',
      rationale: 'The agent follows policy rather than overriding return eligibility.',
      missingSlots: [],
      },
    )
  }

  if (!session.reason) {
    session.phase = 'collect_reason'
    return buildReturnTurn(state, 'ASK_RETURN_REASON', {}, {
      decision: 'ask_clarifying_question',
      rationale: 'The return tool requires a reason before creating the request.',
      missingSlots: ['returnReason'],
    })
  }

  const returnRequest = createReturnRequest({
    orderId,
    itemId,
    reason: session.reason,
  })
  recordToolCall(
    state,
    'createReturnRequest',
    {
      orderId,
      itemId,
      reason: session.reason,
    },
    returnRequest,
  )

  if (!returnRequest.ok) {
    session.phase = 'declined'
    return buildReturnTurn(state, 'RETURN_CREATE_REJECTED', {}, {
      decision: 'decline_and_offer_escalation',
      rationale: 'The create-return tool rejected the request.',
      missingSlots: [],
    })
  }

  session.phase = 'complete'
  return buildReturnTurn(state, 'RETURN_CREATED', returnRequest.data, {
    decision: 'create_return',
    rationale: 'The agent only created the return after order lookup and eligibility checks succeeded.',
    missingSlots: [],
  })
}

function buildReturnTurn(
  state: AgentState,
  responseCode: ResponseCode,
  context: ReturnResponseContext,
  parts: Omit<TurnParts, 'response' | 'responseCode'>,
): TurnParts {
  syncReturnSlots(state)
  return {
    ...parts,
    responseCode,
    response: renderReturnResponse(responseCode, context),
  }
}

function renderReturnResponse(responseCode: ResponseCode, context: ReturnResponseContext) {
  if (responseCode === 'ASK_RETURN_ORDER_ID') {
    return context.nearMiss
      ? `I couldn't recognise "${context.nearMiss}" as a Bookly order ID — they're exactly 4 digits, for example B1002. Could you double-check?`
      : 'I can help start a return. First, what is the Bookly order ID? It should look like B1002.'
  }

  if (responseCode === 'RETURN_ORDER_NOT_FOUND') {
    return "I couldn't find that order, so I cannot create a return. Please verify the order ID or I can route this to a support specialist."
  }

  if (responseCode === 'ASK_RETURN_ITEM') {
    return `Which item do you want to return? I found ${context.itemList}.`
  }

  if (responseCode === 'RETURN_ITEM_NOT_FOUND') {
    return `${context.error} I can route this to a support specialist if you think the order details are wrong.`
  }

  if (responseCode === 'RETURN_NOT_DELIVERED') {
    return 'This item is still in transit, so I cannot process a return until it has been delivered. Is there anything else I can help with?'
  }

  if (responseCode === 'RETURN_FINAL_SALE') {
    return 'This item is marked final sale, so it is not eligible for return. Is there anything else I can help with?'
  }

  if (responseCode === 'RETURN_OUTSIDE_WINDOW') {
    return 'This order was delivered more than 30 days ago, so it is outside the return window. Is there anything else I can help with?'
  }

  if (responseCode === 'RETURN_INELIGIBLE') {
    return `${context.reason} Is there anything else I can help with?`
  }

  if (responseCode === 'ASK_RETURN_REASON') {
    return 'This item is eligible for return. What is the return reason: damaged, wrong item, or changed my mind?'
  }

  if (responseCode === 'RETURN_CREATE_REJECTED') {
    return 'I could not create this return automatically. I can escalate it for manual review.'
  }

  return `Done. I created return ${context.returnId}. ${context.labelStatus}`
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

function findCurrentReturnItem(message: string, state: AgentState) {
  if (!state.returnSession?.orderId) return undefined

  const orderResult = lookupOrder({
    orderId: state.returnSession.orderId,
    email: state.returnSession.email,
  })
  return orderResult.ok ? fuzzyMatchItem(message, orderResult.data.items) : undefined
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
  responseCode?: ResponseCode
}

type ReturnResponseContext = {
  nearMiss?: string
  itemList?: string
  error?: string
  reason?: string
  returnId?: string
  labelStatus?: string
}
