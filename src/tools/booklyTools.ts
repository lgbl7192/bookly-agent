import { orders, type Order } from '../data/orders'
import { policies, type PolicyTopic } from '../data/policies'

const msPerDay = 24 * 60 * 60 * 1000
// Hardcoded so demo return-window calculations stay consistent regardless of when the app runs.
const demoNow = new Date('2026-05-29T12:00:00Z')

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; escalationRecommended?: boolean }

export function lookupOrder(input: {
  orderId?: string
  email?: string
}): ToolResult<Order> {
  const normalizedId = input.orderId?.trim().toUpperCase()
  const normalizedEmail = input.email?.trim().toLowerCase()

  // Bug 1 fix: require at least one identifier — without it, find() returns the first order.
  if (!normalizedId && !normalizedEmail) {
    return {
      ok: false,
      error: 'An order ID or email is required to look up an order.',
    }
  }

  const order = orders.find((candidate) => {
    const idMatches = normalizedId ? candidate.id === normalizedId : true
    const emailMatches = normalizedEmail ? candidate.email === normalizedEmail : true
    return idMatches && emailMatches
  })

  if (!order) {
    return {
      ok: false,
      error: 'No matching order was found. The agent should not invent order details.',
      escalationRecommended: true,
    }
  }

  return { ok: true, data: order }
}

export function checkReturnEligibility(input: {
  orderId: string
  itemId: string
}): ToolResult<{
  eligible: boolean
  reason: string
}> {
  const orderResult = lookupOrder({ orderId: input.orderId })
  if (!orderResult.ok) return orderResult

  const item = orderResult.data.items.find((candidate) => candidate.id === input.itemId)
  if (!item) {
    return {
      ok: false,
      error: 'That item is not part of the order.',
      escalationRecommended: true,
    }
  }

  if (item.finalSale) {
    return {
      ok: true,
      data: {
        eligible: false,
        reason:
          'This item is marked final sale under Bookly policy, so the agent should not create a return automatically.',
      },
    }
  }

  if (!orderResult.data.deliveredOn) {
    return {
      ok: true,
      data: {
        eligible: false,
        reason:
          'Returns can only be started after delivery. The agent should offer to check order status instead.',
      },
    }
  }

  const deliveredAt = new Date(`${orderResult.data.deliveredOn}T12:00:00Z`)
  const daysSinceDelivery = Math.floor(
    (demoNow.getTime() - deliveredAt.getTime()) / msPerDay,
  )

  if (daysSinceDelivery > 30) {
    return {
      ok: true,
      data: {
        eligible: false,
        reason:
          'The order was delivered more than 30 days ago, which is outside Bookly return policy.',
      },
    }
  }

  return {
    ok: true,
    data: {
      eligible: true,
      reason: 'The item is within the 30-day return window and is not final sale.',
    },
  }
}

export function createReturnRequest(input: {
  orderId: string
  itemId: string
  reason: string
}): ToolResult<{
  returnId: string
  labelStatus: string
}> {
  const orderId = input.orderId.trim().toUpperCase()
  const itemId = input.itemId.trim().toUpperCase()
  const reason = input.reason.trim()

  if (!reason) {
    return {
      ok: false,
      error: 'A return reason is required before creating a return.',
    }
  }

  // Enforce eligibility at the mutation boundary too. The orchestrator checks earlier so it can
  // explain ineligible returns before asking for a reason, but callers must not be able to bypass
  // the policy by invoking this exported tool directly.
  const eligibility = checkReturnEligibility({ orderId, itemId })
  if (!eligibility.ok) return eligibility
  if (!eligibility.data.eligible) {
    return {
      ok: false,
      error: eligibility.data.reason,
      escalationRecommended: true,
    }
  }

  return {
    ok: true,
    data: {
      returnId: `R-${orderId}-${itemId}`,
      labelStatus: 'Return label emailed to the customer account address.',
    },
  }
}

// Bug 8 fix: removed the silent fallback to 'shipping' for unmatched topics. An unrecognized
// topic now returns ok:false so the orchestrator routes to human instead of answering wrong.
export function searchPolicy(input: {
  topic: string
}): ToolResult<{
  title: string
  summary: string
}> {
  const normalizedTopic = input.topic.toLowerCase()

  let topic: PolicyTopic | undefined
  if (normalizedTopic.includes('password') || normalizedTopic.includes('login') || normalizedTopic.includes('account')) {
    topic = 'password_reset'
  } else if (normalizedTopic.includes('refund')) {
    topic = 'refunds'
  } else if (normalizedTopic.includes('return')) {
    topic = 'returns'
  } else if (normalizedTopic.includes('ship')) {
    topic = 'shipping'
  }

  if (!topic) {
    return {
      ok: false,
      error: 'No matching policy article was found.',
      escalationRecommended: true,
    }
  }

  const policy = policies.find((candidate) => candidate.topic === topic)
  if (!policy) {
    return {
      ok: false,
      error: 'No matching policy article was found.',
      escalationRecommended: true,
    }
  }

  return { ok: true, data: policy }
}
