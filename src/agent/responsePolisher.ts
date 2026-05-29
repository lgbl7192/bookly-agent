import type { Trace } from './types'

export type PolisherMode = 'deterministic' | 'llm_stub' | 'llm'

export type PolisherInput = {
  draftResponse: string
  trace: Trace
}

export type PolisherResult = {
  response: string
  metadata: {
    mode: PolisherMode
    changed: boolean
    note: string
  }
}

export type ResponsePolisher = (input: PolisherInput) => PolisherResult | Promise<PolisherResult>

export const deterministicPolisher: ResponsePolisher = ({ draftResponse }) => ({
  response: draftResponse,
  metadata: {
    mode: 'deterministic',
    changed: false,
    note: 'No-op fallback keeps demos and evals deterministic.',
  },
})

export const llmPolisherStub: ResponsePolisher = ({ draftResponse }) => ({
  response: draftResponse,
  metadata: {
    mode: 'llm_stub',
    changed: false,
    note:
      'Future adapter boundary: pass grounded facts to an LLM for tone only, then verify factual invariants before returning.',
  },
})

export function createLLMPolisher(endpoint: string): ResponsePolisher {
  return async ({ draftResponse, trace }) => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftResponse, trace }),
      })

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => undefined)) as
          | { error?: string; detail?: string }
          | undefined
        const detail = errorBody?.detail ?? errorBody?.error
        return {
          response: draftResponse,
          metadata: {
            mode: 'llm',
            changed: false,
            note: `LLM polisher unavailable (${response.status})${
              detail ? `: ${detail.slice(0, 180)}` : ''
            }; deterministic draft used.`,
          },
        }
      }

      const data = (await response.json()) as {
        response?: string
        model?: string
        provider?: string
        changed?: boolean
      }
      const polished = data.response?.trim() || draftResponse

      if (!preservesGroundedTokens(draftResponse, polished)) {
        return {
          response: draftResponse,
          metadata: {
            mode: 'llm',
            changed: false,
            note:
              'LLM rewrite was discarded because it changed grounded identifiers or dates; deterministic draft used.',
          },
        }
      }

      return {
        response: polished,
        metadata: {
          mode: 'llm',
          changed: Boolean(data.changed ?? polished !== draftResponse),
          note: `Response polished by ${data.provider ?? 'LLM'} ${data.model ?? ''} after workflow/tool decisions were finalized.`,
        },
      }
    } catch (error) {
      return {
        response: draftResponse,
        metadata: {
          mode: 'llm',
          changed: false,
          note:
            error instanceof Error
              ? `LLM polisher failed: ${error.message}`
              : 'LLM polisher failed; deterministic draft used.',
        },
      }
    }
  }
}

function preservesGroundedTokens(draftResponse: string, polishedResponse: string) {
  return JSON.stringify(extractGroundedTokens(polishedResponse)) === JSON.stringify(extractGroundedTokens(draftResponse))
}

function extractGroundedTokens(response: string) {
  const patterns = [
    /\b[A-Z]\d{4}\b/gi,
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/gi,
  ]

  return [...new Set(patterns.flatMap((pattern) => response.match(pattern) ?? []))].sort()
}
