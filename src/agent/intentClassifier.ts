import type { Intent } from './types'

export type ClassifierInput = {
  message: string
  previousIntent: Intent
}

export type ClassifierResult = {
  intent: Intent
  confidence: number
}

export type IntentClassifier = (input: ClassifierInput) => ClassifierResult | Promise<ClassifierResult>

const VALID_INTENTS = new Set<Intent>([
  'order_status',
  'return_request',
  'ambiguous_order_help',
  'policy_question',
  'account_help',
  'unknown',
])

function isValidIntent(value: string): value is Intent {
  return VALID_INTENTS.has(value as Intent)
}

export const deterministicClassifier: IntentClassifier = ({ message, previousIntent }) =>
  detectIntent(message, previousIntent)

function detectIntent(message: string, previousIntent: Intent): ClassifierResult {
  const text = message.toLowerCase()

  if (isUnsupportedRequest(text)) return { intent: 'unknown', confidence: 0.44 }
  if (text.includes('policy') || /\breturn window\b/.test(text)) return { intent: 'policy_question', confidence: 0.9 }
  if (/\b(return|refund|send back|exchange)\b/.test(text)) return { intent: 'return_request', confidence: 0.92 }
  if (isAmbiguousOrderHelp(text)) return { intent: 'ambiguous_order_help', confidence: 0.64 }
  if (/\b(tracking|package|delivery|delivered|where|status|shipped|check)\b/.test(text)) return { intent: 'order_status', confidence: 0.88 }
  if (/\b(password|sign in|login|account)\b/.test(text)) return { intent: 'account_help', confidence: 0.86 }
  if (/\b(shipping|ship|eligible|window|final sale)\b/.test(text)) return { intent: 'policy_question', confidence: 0.82 }
  if (previousIntent !== 'unknown' && hasWorkflowSignal(message)) return { intent: previousIntent, confidence: 0.72 }

  return { intent: 'unknown', confidence: 0.35 }
}

function isUnsupportedRequest(text: string) {
  return /\b(price match|price-match|discount|coupon|cancel|change address|gift card|recommend|recommendation)\b/.test(
    text,
  )
}

function isAmbiguousOrderHelp(text: string) {
  return (
    /\b(help|problem|issue|question|something wrong)\b/.test(text) &&
    /\border\b/.test(text) &&
    !/\b(where|status|tracking|return|refund|cancel|delivered|shipped)\b/.test(text)
  )
}

// Bug 10 fix: removed `/@/.test(message)` — an email address is too weak a signal for
// intent continuity and caused false positives (e.g. "email me at X" inheriting prior intent).
function hasWorkflowSignal(message: string) {
  return (
    /\bB\d{4}\b/i.test(message) ||
    /\bI-\d{2}\b/i.test(message) ||
    /\b(damaged|wrong|changed my mind)\b/i.test(message)
  )
}

export function createLLMClassifier(proxyBase: string): IntentClassifier {
  return async ({ message, previousIntent }) => {
    try {
      const response = await fetch(`${proxyBase}/api/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, previousIntent }),
      })

      if (!response.ok) return deterministicClassifier({ message, previousIntent })

      const data = (await response.json()) as { intent?: string; confidence?: number }
      const intent = data.intent && isValidIntent(data.intent) ? data.intent : undefined
      const confidence =
        typeof data.confidence === 'number' &&
        Number.isFinite(data.confidence) &&
        data.confidence >= 0 &&
        data.confidence <= 1
          ? data.confidence
          : undefined

      if (!intent || confidence === undefined) return deterministicClassifier({ message, previousIntent })

      return { intent, confidence }
    } catch {
      return deterministicClassifier({ message, previousIntent })
    }
  }
}
