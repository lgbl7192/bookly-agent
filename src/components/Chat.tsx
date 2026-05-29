import { Bot, RotateCcw, SendHorizonal, ShieldCheck, User } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createLLMClassifier, deterministicClassifier } from '../agent/intentClassifier'
import { createInitialState, runAgentTurnAsync } from '../agent/orchestrator'
import { createLLMPolisher, deterministicPolisher } from '../agent/responsePolisher'
import type { AgentState, ChatMessage, Trace } from '../agent/types'
import { TracePanel } from './TracePanel'

const demos = [
  {
    label: 'Order status',
    message: "Where's my order?",
    detail: 'Clarifies missing ID',
  },
  {
    label: 'Eligible return',
    message: 'I want to return something from B1002',
    detail: 'Creates return after checks',
  },
  {
    label: 'Policy answer',
    message: 'What is your return policy?',
    detail: 'Grounded KB response',
  },
  {
    label: 'Ambiguous help',
    message: 'I need help with my order',
    detail: 'Clarifies intent first',
  },
  {
    label: 'Unknown order',
    message: 'Can you check B9999?',
    detail: 'Routes to human',
  },
  {
    label: 'Unsupported',
    message: 'Can you price match Amazon?',
    detail: 'Refuses unsafe scope',
  },
]

const welcomeMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Hi, I'm Bookly support. I can check order status, start eligible returns, or answer questions about our policies.",
}

const proxyBase = import.meta.env.VITE_POLISHER_URL ?? 'http://127.0.0.1:8787'

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage])
  const [input, setInput] = useState('')
  const [agentState, setAgentState] = useState<AgentState>(createInitialState())
  const [trace, setTrace] = useState<Trace>()
  // LLM mode is on by default — the agent gracefully falls back to deterministic behavior
  // if the proxy isn't running, so this is safe without an API key configured.
  const [useLLM, setUseLLM] = useState(true)
  const [isThinking, setIsThinking] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const conversationVersionRef = useRef(0)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  const canSend = input.trim().length > 0 && !isThinking
  const transcriptSummary = useMemo(
    () => `${messages.filter((message) => message.role === 'user').length} user turns`,
    [messages],
  )

  // Minor 12 fix: memoize so a new polisher/classifier closure isn't created on every send.
  const responsePolisher = useMemo(
    () => (useLLM ? createLLMPolisher(`${proxyBase}/api/polish`) : deterministicPolisher),
    [useLLM],
  )
  const intentClassifier = useMemo(
    () => (useLLM ? createLLMClassifier(proxyBase) : deterministicClassifier),
    [useLLM],
  )

  async function submitMessage(messageText = input) {
    const trimmed = messageText.trim()
    if (!trimmed || isThinking) return

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
    }
    setMessages((current) => [...current, userMessage])
    setInput('')
    setIsThinking(true)
    const conversationVersion = conversationVersionRef.current

    try {
      const turn = await runAgentTurnAsync(trimmed, agentState, responsePolisher, intentClassifier)
      if (conversationVersion !== conversationVersionRef.current) return

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: turn.response,
      }
      setMessages((current) => [...current, assistantMessage])
      setAgentState(turn.state)
      setTrace(turn.trace)
    } catch {
      if (conversationVersion !== conversationVersionRef.current) return

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Something went wrong. Please try again or choose a demo path.',
        },
      ])
    } finally {
      if (conversationVersion === conversationVersionRef.current) {
        setIsThinking(false)
      }
    }
  }

  function resetConversation() {
    conversationVersionRef.current += 1
    setMessages([welcomeMessage])
    setInput('')
    setAgentState(createInitialState())
    setTrace(undefined)
    setIsThinking(false)
  }

  return (
    <main className="app-shell">
      <section className="chat-workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Bookly CX Agent</p>
            <h1>Workflow-first customer support</h1>
          </div>
          <button
            aria-label="Reset conversation"
            className="icon-button"
            onClick={resetConversation}
            title="Reset conversation"
            type="button"
          >
            <RotateCcw size={18} />
          </button>
        </header>

        <div className="thesis-band">
          <div className="thesis-copy">
            <ShieldCheck size={18} />
            <p>
              Clarifies missing facts, uses trusted tools for customer data, grounds policy
              answers, and escalates instead of guessing.{' '}
              <strong>Every decision is explained in the trace panel</strong> — built so CX
              teams can audit any conversation without reading code.
            </p>
          </div>
          <span>{transcriptSummary}</span>
        </div>

        <div className="demo-row" aria-label="Demo prompts">
          {demos.map((demo) => (
            <button
              className="demo-chip"
              disabled={isThinking}
              key={demo.label}
              onClick={() => submitMessage(demo.message)}
              type="button"
            >
              <strong>{demo.label}</strong>
              <span>{demo.detail}</span>
            </button>
          ))}
        </div>

        <div className="mode-row">
          <label className="toggle">
            <input
              checked={useLLM}
              onChange={(event) => setUseLLM(event.target.checked)}
              type="checkbox"
            />
            <span>LLM mode</span>
          </label>
          <span className="mode-note">
            {useLLM
              ? 'LLM handles intent classification and response polishing via local proxy'
              : 'Deterministic mode — no API key needed'}
          </span>
        </div>

        <section className="message-list" aria-live="polite">
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <span>
                {message.role === 'assistant' ? <Bot size={13} /> : <User size={13} />}
                {message.role === 'assistant' ? 'Bookly' : 'You'}
              </span>
              <p>{message.content}</p>
            </article>
          ))}
          {isThinking && (
            <article className="message assistant">
              <span>
                <Bot size={13} />
                Bookly
              </span>
              <div className="typing-dots" aria-label="Bookly is thinking">
                <span /><span /><span />
              </div>
            </article>
          )}
          <div ref={messagesEndRef} />
        </section>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            submitMessage()
          }}
        >
          <input
            aria-label="Message Bookly support"
            onChange={(event) => setInput(event.target.value)}
            placeholder="Try: I want to return I-21 from B1002 because it was damaged"
            value={input}
          />
          <button aria-label="Send message" disabled={!canSend} type="submit">
            <SendHorizonal size={18} />
          </button>
        </form>
      </section>

      <TracePanel trace={trace} />
    </main>
  )
}
