export type Intent =
  | 'order_status'
  | 'return_request'
  | 'ambiguous_order_help'
  | 'policy_question'
  | 'account_help'
  | 'unknown'

export type Decision =
  | 'ask_clarifying_question'
  | 'call_tool'
  | 'answer_with_grounded_data'
  | 'create_return'
  | 'decline_and_offer_escalation'
  | 'route_to_human'
  | 'unsupported_request'

export type SlotKey = 'orderId' | 'email' | 'itemId' | 'returnReason' | 'policyTopic'

export type Slots = Partial<Record<SlotKey, string>>

export type Role = 'user' | 'assistant'

export type ChatMessage = {
  id: string
  role: Role
  content: string
}

export type ToolCall = {
  name: string
  input: Record<string, unknown>
  result: unknown
}

export type Trace = {
  intent: Intent
  confidence: number
  slots: Slots
  missingSlots: SlotKey[]
  toolCalls: ToolCall[]
  decision: Decision
  rationale: string
  responsePolishing: {
    mode: 'deterministic' | 'llm_stub' | 'llm'
    changed: boolean
    note: string
  }
}

export type AgentState = {
  intent: Intent
  slots: Slots
  toolCalls: ToolCall[]
}

export type AgentTurn = {
  response: string
  state: AgentState
  trace: Trace
}
