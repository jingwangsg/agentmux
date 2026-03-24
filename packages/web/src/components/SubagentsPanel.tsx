import { useMemo, useState } from 'react';
import type { StoredEvent as ConversationEvent } from '../lib/types';

interface SubagentInfo {
  threadId: string;
  tool: string;
  status: string;
  agentNickname: string | null;
  agentRole: string | null;
  prompt: string | null;
  model: string | null;
  displayStatus: 'active' | 'waiting' | 'done' | 'hidden';
}

function mapAgentStatus(status: string): SubagentInfo['displayStatus'] {
  switch (status) {
    case 'pendingInit': return 'waiting';
    case 'running': return 'active';
    case 'completed': return 'done';
    case 'interrupted':
    case 'errored':
    case 'shutdown':
    case 'notFound':
      return 'hidden';
    default: return 'waiting';
  }
}

function extractSubagents(events: ConversationEvent[]): SubagentInfo[] {
  const agentMap = new Map<string, SubagentInfo>();

  for (const event of events) {
    if (event.type !== 'subagent.spawned' && event.type !== 'subagent.status' && event.type !== 'subagent.completed') continue;

    const payload = event.payload;
    const tool = typeof payload.tool === 'string' ? payload.tool : '';
    const receiverIds = Array.isArray(payload.receiverThreadIds) ? payload.receiverThreadIds as string[] : [];
    const agentsStates = typeof payload.agentsStates === 'object' && payload.agentsStates ? payload.agentsStates as Record<string, { status?: string; message?: string }> : {};

    for (const threadId of receiverIds) {
      const existing = agentMap.get(threadId);
      const agentState = agentsStates[threadId];
      const rawStatus = typeof agentState?.status === 'string' ? agentState.status : existing?.status ?? 'pendingInit';

      agentMap.set(threadId, {
        threadId,
        tool: tool || existing?.tool || 'spawnAgent',
        status: rawStatus,
        agentNickname: existing?.agentNickname ?? null,
        agentRole: existing?.agentRole ?? null,
        prompt: typeof payload.prompt === 'string' ? payload.prompt : existing?.prompt ?? null,
        model: typeof payload.model === 'string' ? payload.model : existing?.model ?? null,
        displayStatus: mapAgentStatus(rawStatus),
      });
    }
  }

  return Array.from(agentMap.values()).filter((a) => a.displayStatus !== 'hidden');
}

interface SubagentsPanelProps {
  events: ConversationEvent[];
  onOpenChild?: (threadId: string) => void;
}

export default function SubagentsPanel({ events, onOpenChild }: SubagentsPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const agents = useMemo(() => extractSubagents(events), [events]);

  if (agents.length === 0) return null;

  const activeCount = agents.filter((a) => a.displayStatus === 'active').length;
  const label = `${agents.length} background agent${agents.length !== 1 ? 's' : ''}${activeCount > 0 ? ` (${activeCount} active)` : ''}`;

  return (
    <div className="subagents-panel">
      <button className="subagents-panel-header" onClick={() => setExpanded(!expanded)}>
        <span className="subagents-panel-arrow">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span>{label}</span>
      </button>
      {expanded ? (
        <div className="subagents-panel-list">
          {agents.map((agent) => (
            <div key={agent.threadId} className="subagent-row" onClick={() => onOpenChild?.(agent.threadId)}>
              <span className={`subagent-badge ${agent.displayStatus}`} />
              <div className="subagent-info">
                <span className="subagent-name">{agent.agentNickname || agent.agentRole || 'Agent'}</span>
                <span className="subagent-status-text">
                  {agent.displayStatus === 'active' ? 'is working' : agent.displayStatus === 'waiting' ? 'is awaiting instruction' : 'is done'}
                </span>
              </div>
              {agent.prompt ? <span className="subagent-summary">{agent.prompt.slice(0, 60)}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
