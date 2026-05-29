# Bookly CX Agent

A workflow-first customer support agent prototype for Bookly, a fictional online bookstore.

## Thesis

A great customer support agent should behave less like a free-form chatbot and more like a reliable workflow operator. Free-form LLM agents are powerful but they hallucinate order details, invent policy language, and take unsafe actions when they shouldn't. For a support use case, that's worse than no agent at all — a wrong refund or a fabricated tracking number erodes customer trust immediately.

This agent flips the default: the LLM is not in charge of decisions. A structured orchestrator controls intent, slots, workflow branching, and tool calls. The LLM is an optional enhancer that improves the *language* of a response after the *facts* are already grounded. The result is an agent that is auditable (every decision is traced), guardrailed (it cannot invent data), and reliable under adversarial inputs.

## What the prototype demonstrates

- Multi-turn clarification for missing order IDs, item IDs, and return reasons.
- Tool use through mocked Bookly business APIs (`lookupOrder`, `checkReturnEligibility`, `createReturnRequest`, `searchPolicy`).
- Guardrails for unknown orders, final-sale items, expired return windows, and out-of-scope requests.
- A visible trace panel showing intent, confidence, slots, tool calls, decision, and rationale — designed to make the agent's reasoning legible to both technical and non-technical audiences.
- Optional LLM mode that enables real language understanding for intent classification and natural-sounding responses, without giving the LLM control over workflow decisions or tool results.
- An eval suite that proves the core workflow behaviors hold regardless of whether LLM mode is on.

## Supported flows

### Order status

The agent collects an order ID, calls `lookupOrder`, and answers only with data from the tool.

```text
Where's my order?
B1001
```

### Returns and refunds

The agent collects order and item context, checks eligibility, and creates a return only after the eligibility tool approves.

```text
I want to return something from B1002
I-21
It was damaged
```

### Policy questions

The agent uses the `searchPolicy` tool for shipping, return, refund, and password reset answers.

```text
What is your refund policy?
I can't log in to my account
```

## Architecture

```text
User message
  -> intent classification (deterministic regex OR LLM via proxy)
  -> slot extraction and conversation state
  -> workflow-specific planner
  -> mocked Bookly tools
  -> grounded draft response
  -> optional LLM response polisher (via same proxy)
  -> trace panel
```

Key files:

- `src/agent/intentClassifier.ts` — deterministic and LLM-backed intent classifiers. Injectable dependency so evals always use the deterministic path.
- `src/agent/orchestrator.ts` — structured workflow logic. Controls all branching, tool calls, and decisions.
- `src/agent/responsePolisher.ts` — safe boundary for LLM tone polishing. Receives grounded facts; cannot mutate decisions.
- `src/tools/booklyTools.ts` — mocked source-of-truth business tools.
- `src/data/orders.ts` — demo order data.
- `src/data/policies.ts` — grounded policy snippets.
- `src/evals/scenarios.ts` — workflow evals that run against the deterministic path.
- `scripts/openai-polisher-server.ts` — local LLM proxy for both intent classification (`/api/classify`) and response polishing (`/api/polish`).

## Technical decisions

### Structured orchestration over free-form autonomy

The agent uses explicit intent detection, slot filling, workflow branching, and typed tool calls. This is less general than a free-form agent loop, but it matches customer support: reliability and auditability matter more than breadth. Every turn produces a trace that shows exactly what the agent decided and why — which is what you need when a support action creates a return or routes to a human.

### LLM is injectable, not required

Intent classification and response polishing are both injectable dependencies with deterministic defaults. The `runAgentTurnAsync` signature accepts an `IntentClassifier` and a `ResponsePolisher`; the defaults are regex and no-op respectively. When the LLM proxy is running, both can be swapped for LLM-backed versions at runtime via the UI toggle — without changing any workflow logic. This means the demo and evals are always stable, and adding a real LLM integration is one parameter swap, not a rewrite.

### Tools are the only source of truth

The model layer does not invent order status, eligibility, return IDs, or policy language. Those facts come from `lookupOrder`, `checkReturnEligibility`, `createReturnRequest`, and `searchPolicy`. The response polisher receives the grounded draft and can only change wording — evals verify that tool calls and decisions are identical before and after polishing.

### Clarification is a product behavior

The agent asks for missing identifiers before taking action. This creates a small amount of friction, but prevents confident wrong answers and unsafe actions. The return flow in particular has three explicit gates: order lookup, eligibility check, and return reason — each one a separate clarifying turn if needed.

## Run locally

```bash
npm install
npm run dev
```

Run the workflow evals:

```bash
npm run eval
```

Build for production:

```bash
npm run build
```

### Optional: LLM mode

Enable real language understanding and natural response phrasing:

```bash
cp .env.example .env.local
# Edit .env.local and set ANTHROPIC_API_KEY (or OPENAI_API_KEY)
npm run polisher
npm run dev
```

Then turn on **LLM mode** in the UI. The browser calls the local proxy at `http://127.0.0.1:8787`; the API key stays server-side. The proxy exposes two endpoints:

- `POST /api/classify` — LLM intent classification. Returns `{ intent, confidence }`.
- `POST /api/polish` — LLM tone polishing. Returns `{ response, changed, model, provider }`.

Override the proxy URL with:

```bash
VITE_POLISHER_URL=http://127.0.0.1:8787 npm run dev
```

## What I would improve in production

- **Replace mocked tools with real integrations.** Order, returns, CRM, and policy services would authenticate via OAuth or service tokens. The tool interface is already clean — swapping the mock body for a real API call is the only change.
- **Add an LLM reasoning layer for complex edge cases.** The deterministic classifier handles common intents well, but natural language is messy. A hybrid approach — structured orchestration for known paths, LLM escalation for ambiguous ones — would cover the long tail without sacrificing guardrails on the happy path.
- **Structured evaluation with golden transcripts and adversarial prompts.** The current evals test the deterministic path. Production evals would also cover LLM output variance, injection attempts, and multi-intent messages.
- **Human handoff, observability, and admin tooling.** Real support agents need a live handoff queue, conversation analytics, and a way for ops teams to update policy without a code deploy.
