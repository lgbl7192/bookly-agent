import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

loadLocalEnv()

const port = Number(process.env.POLISHER_PORT ?? 8787)
// Minor 11 fix: configurable CORS origin so the proxy works if Vite binds to localhost or a
// different port. Defaults to the standard Vite dev server address.
const corsOrigin = process.env.POLISHER_CORS_ORIGIN ?? 'http://127.0.0.1:5173'
const openAIModel = process.env.OPENAI_POLISHER_MODEL ?? 'gpt-4.1-mini'
const anthropicModel = process.env.ANTHROPIC_POLISHER_MODEL ?? 'claude-sonnet-4-6'
const openAIKey = process.env.OPENAI_API_KEY
const anthropicKey = process.env.ANTHROPIC_API_KEY
const provider = resolveProvider()

type PolishRequest = {
  draftResponse?: string
  trace?: unknown
}

const server = createServer(async (req, res) => {
  setCorsHeaders(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.url === '/health') {
    const activeKey = getActiveApiKey()
    sendJson(res, 200, {
      ok: Boolean(activeKey),
      provider,
      model: getActiveModel(),
      message: activeKey
        ? `${provider} polisher is configured.`
        : `${getActiveKeyName()} is not set.`,
    })
    return
  }

  if (req.url === '/api/polish' && req.method === 'POST') {
    if (!getActiveApiKey()) {
      sendJson(res, 503, {
        error: `${getActiveKeyName()} is not set. Using deterministic response instead.`,
      })
      return
    }

    try {
      const payload = (await readJson(req)) as PolishRequest
      const draftResponse = payload.draftResponse?.trim()

      if (!draftResponse) {
        sendJson(res, 400, { error: 'draftResponse is required.' })
        return
      }

      const result =
        provider === 'anthropic'
          ? await polishWithAnthropic(draftResponse, payload.trace)
          : await polishWithOpenAI(draftResponse, payload.trace)

      if (!result.ok) {
        sendJson(res, result.status, {
          error: `${provider} request failed.`,
          detail: result.detail,
        })
        return
      }

      sendJson(res, 200, {
        response: result.response,
        provider,
        model: getActiveModel(),
        changed: result.response !== draftResponse,
      })
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : 'Unexpected server error.',
      })
    }
    return
  }

  // Design 7: intent classification endpoint so the UI can use real language understanding
  // instead of the regex path when LLM tone polishing is enabled.
  if (req.url === '/api/classify' && req.method === 'POST') {
    if (!getActiveApiKey()) {
      sendJson(res, 503, { error: `${getActiveKeyName()} is not set.` })
      return
    }

    try {
      const payload = (await readJson(req)) as { message?: string; previousIntent?: string }
      const message = payload.message?.trim()

      if (!message) {
        sendJson(res, 400, { error: 'message is required.' })
        return
      }

      const previousIntent = payload.previousIntent ?? 'unknown'
      const result =
        provider === 'anthropic'
          ? await classifyWithAnthropic(message, previousIntent)
          : await classifyWithOpenAI(message, previousIntent)

      if (!result.ok) {
        sendJson(res, result.status, {
          error: `${provider} classification request failed.`,
          detail: result.detail,
        })
        return
      }

      sendJson(res, 200, result.data)
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : 'Unexpected server error.',
      })
    }
    return
  }

  sendJson(res, 404, { error: 'Not found' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`LLM polisher proxy listening on http://127.0.0.1:${port}`)
  console.log(
    getActiveApiKey()
      ? `Using ${provider} model ${getActiveModel()}`
      : `${getActiveKeyName()} is not set; /api/polish will return 503.`,
  )
})

async function polishWithOpenAI(draftResponse: string, trace: unknown): Promise<ProviderResult> {
  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAIKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openAIModel,
      instructions: toneInstructions,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: buildPolishingPrompt(draftResponse, trace),
            },
          ],
        },
      ],
      max_output_tokens: 220,
    }),
  })

  if (!openaiResponse.ok) {
    const errorText = await openaiResponse.text()
    return {
      ok: false,
      status: openaiResponse.status,
      detail: errorText.slice(0, 500),
    }
  }

  const data = await openaiResponse.json()
  return {
    ok: true,
    response: sanitizePlainText(extractOpenAIOutputText(data) || draftResponse),
  }
}

async function polishWithAnthropic(draftResponse: string, trace: unknown): Promise<ProviderResult> {
  const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey ?? '',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: anthropicModel,
      max_tokens: 220,
      system: toneInstructions,
      messages: [
        {
          role: 'user',
          content: buildPolishingPrompt(draftResponse, trace),
        },
      ],
    }),
  })

  if (!anthropicResponse.ok) {
    const errorText = await anthropicResponse.text()
    return {
      ok: false,
      status: anthropicResponse.status,
      detail: errorText.slice(0, 500),
    }
  }

  const data = await anthropicResponse.json()
  return {
    ok: true,
    response: sanitizePlainText(extractAnthropicOutputText(data) || draftResponse),
  }
}

const classifySystemPrompt =
  'You are an intent classifier for Bookly, an online bookstore\'s customer support system. ' +
  'Classify the customer message into exactly one intent:\n' +
  '- "order_status": checking order location, tracking, or delivery status\n' +
  '- "return_request": wanting to return an item or get a refund\n' +
  '- "ambiguous_order_help": mentions an order but the specific need is unclear\n' +
  '- "policy_question": asking about shipping, return, or refund policies\n' +
  '- "account_help": account access, password reset, or login issues\n' +
  '- "unknown": anything outside the above\n' +
  'Respond ONLY with valid JSON: {"intent": "<intent>", "confidence": <0.0-1.0>}'

async function classifyWithAnthropic(message: string, previousIntent: string): Promise<ClassifyResult> {
  const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey ?? '',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: anthropicModel,
      max_tokens: 100,
      system: classifySystemPrompt,
      messages: [
        {
          role: 'user',
          content: `Previous intent: ${previousIntent}\nCustomer message: ${message}`,
        },
      ],
    }),
  })

  if (!anthropicResponse.ok) {
    const errorText = await anthropicResponse.text()
    return { ok: false, status: anthropicResponse.status, detail: errorText.slice(0, 500) }
  }

  const data = await anthropicResponse.json()
  const parsed = parseClassifyJson(extractAnthropicOutputText(data) ?? '')
  if (!parsed) return { ok: false, status: 500, detail: 'Failed to parse classification response.' }
  return { ok: true, data: parsed }
}

async function classifyWithOpenAI(message: string, previousIntent: string): Promise<ClassifyResult> {
  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAIKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openAIModel,
      instructions: classifySystemPrompt,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Previous intent: ${previousIntent}\nCustomer message: ${message}`,
            },
          ],
        },
      ],
      max_output_tokens: 100,
    }),
  })

  if (!openaiResponse.ok) {
    const errorText = await openaiResponse.text()
    return { ok: false, status: openaiResponse.status, detail: errorText.slice(0, 500) }
  }

  const data = await openaiResponse.json()
  const parsed = parseClassifyJson(extractOpenAIOutputText(data) ?? '')
  if (!parsed) return { ok: false, status: 500, detail: 'Failed to parse classification response.' }
  return { ok: true, data: parsed }
}

function parseClassifyJson(text: string): { intent: string; confidence: number } | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  const jsonText = codeBlockMatch ? codeBlockMatch[1] : text.trim()
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    if (typeof parsed.intent === 'string' && typeof parsed.confidence === 'number') {
      return {
        intent: parsed.intent,
        confidence: Math.min(1, Math.max(0, parsed.confidence)),
      }
    }
  } catch {
    // fall through to null
  }
  return null
}

const toneInstructions =
  'You rewrite customer support messages for Bookly. Keep the response concise, warm, and human. Return plain text only: no Markdown, no bold, no bullets, no headings, no code formatting. Do not add facts, promises, policy claims, IDs, dates, statuses, discounts, or actions not present in the draft. Preserve any order IDs, return IDs, item IDs, tracking numbers, dates, and policy constraints exactly.'

function buildPolishingPrompt(draftResponse: string, trace: unknown) {
  return JSON.stringify(
    {
      task: 'Polish wording only. Return only the rewritten customer-facing response as plain text with no Markdown formatting.',
      draftResponse,
      trace,
    },
    null,
    2,
  )
}

function sanitizePlainText(text: string) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function readJson(req: IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function extractOpenAIOutputText(data: unknown) {
  if (
    data &&
    typeof data === 'object' &&
    'output_text' in data &&
    typeof data.output_text === 'string'
  ) {
    return data.output_text.trim()
  }

  if (!data || typeof data !== 'object' || !('output' in data) || !Array.isArray(data.output)) {
    return undefined
  }

  for (const item of data.output) {
    if (!item || typeof item !== 'object' || !('content' in item) || !Array.isArray(item.content)) {
      continue
    }

    for (const content of item.content) {
      if (
        content &&
        typeof content === 'object' &&
        'type' in content &&
        content.type === 'output_text' &&
        'text' in content &&
        typeof content.text === 'string'
      ) {
        return content.text.trim()
      }
    }
  }

  return undefined
}

function extractAnthropicOutputText(data: unknown) {
  if (!data || typeof data !== 'object' || !('content' in data) || !Array.isArray(data.content)) {
    return undefined
  }

  for (const content of data.content) {
    if (
      content &&
      typeof content === 'object' &&
      'type' in content &&
      content.type === 'text' &&
      'text' in content &&
      typeof content.text === 'string'
    ) {
      return content.text.trim()
    }
  }

  return undefined
}

function resolveProvider(): Provider {
  const configured = process.env.POLISHER_PROVIDER?.toLowerCase()
  if (configured === 'openai' || configured === 'anthropic') return configured
  if (anthropicKey) return 'anthropic'
  return 'openai'
}

function getActiveApiKey() {
  return provider === 'anthropic' ? anthropicKey : openAIKey
}

function getActiveKeyName() {
  return provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
}

function getActiveModel() {
  return provider === 'anthropic' ? anthropicModel : openAIModel
}

type Provider = 'openai' | 'anthropic'

type ClassifyResult =
  | { ok: true; data: { intent: string; confidence: number } }
  | { ok: false; status: number; detail: string }

type ProviderResult =
  | {
      ok: true
      response: string
    }
  | {
      ok: false
      status: number
      detail: string
    }

function loadLocalEnv() {
  for (const path of ['.env.local', '.env']) {
    if (!existsSync(path)) continue

    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue

      const [rawKey, ...rawValueParts] = trimmed.split('=')
      const key = rawKey.trim()
      const value = rawValueParts
        .join('=')
        .trim()
        .replace(/^['"]|['"]$/g, '')

      if (!process.env[key]) {
        process.env[key] = value
      }
    }
  }
}
