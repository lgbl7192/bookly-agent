import { Activity, CheckCircle2, CircleHelp, ListChecks, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Trace } from '../agent/types'

type TracePanelProps = {
  trace?: Trace
}

export function TracePanel({ trace }: TracePanelProps) {
  if (!trace) {
    return (
      <aside className="trace-panel">
        <PanelHeader />
        <div className="empty-trace">
          <CircleHelp size={24} />
          <p>
            Send a message to see how the agent thinks — intent, confidence, data it looked
            up, and why it made each decision.
          </p>
        </div>
      </aside>
    )
  }

  return (
    <aside className="trace-panel">
      <PanelHeader />
      <div className="trace-grid">
        <TraceMetric label="Intent" value={trace.intent} icon={<Activity size={14} />} />
        <TraceMetric
          label="Confidence"
          value={`${Math.round(trace.confidence * 100)}%`}
          icon={<CheckCircle2 size={14} />}
          variant={trace.confidence >= 0.7 ? 'high' : trace.confidence >= 0.5 ? 'medium' : 'low'}
        />
        <TraceMetric label="Decision" value={trace.decision} icon={<ListChecks size={14} />} />
      </div>

      <section className="trace-section">
        <h3>Slots</h3>
        <pre>{JSON.stringify(trace.slots, null, 2)}</pre>
      </section>

      <section className="trace-section">
        <h3>Missing</h3>
        {trace.missingSlots.length > 0 ? (
          <div className="pill-row">
            {trace.missingSlots.map((slot) => (
              <span className="pill warn" key={slot}>
                {slot}
              </span>
            ))}
          </div>
        ) : (
          <span className="pill">none</span>
        )}
      </section>

      <section className="trace-section">
        <h3>Tool Calls</h3>
        {trace.toolCalls.length > 0 ? (
          trace.toolCalls.map((toolCall, index) => (
            <details className="tool-call" open key={`${toolCall.name}-${index}`}>
              <summary>
                <Wrench size={14} />
                {toolCall.name}
              </summary>
              <pre>{JSON.stringify(toolCall, null, 2)}</pre>
            </details>
          ))
        ) : (
          <span className="pill">no tool call</span>
        )}
      </section>

      <section className="trace-section">
        <h3>Rationale</h3>
        <p>{trace.rationale}</p>
      </section>

      <section className="trace-section">
        <h3>Response Polishing</h3>
        <pre>{JSON.stringify(trace.responsePolishing, null, 2)}</pre>
      </section>
    </aside>
  )
}

function PanelHeader() {
  return (
    <div className="panel-header">
      <div>
        <p className="eyebrow">Agent Trace</p>
        <h2>Workflow inspection</h2>
      </div>
    </div>
  )
}

function TraceMetric({
  label,
  value,
  icon,
  variant,
}: {
  label: string
  value: string
  icon: ReactNode
  variant?: 'high' | 'medium' | 'low'
}) {
  return (
    <div className={`trace-metric${variant ? ` metric-${variant}` : ''}`}>
      <span>
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  )
}
