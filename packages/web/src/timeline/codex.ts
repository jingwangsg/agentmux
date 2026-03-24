import type { StoredEvent as ConversationEvent } from '../lib/types';
import { extractToolLabel, readPayloadText, readVisibleText, stringifyDetails, summarizeForPreview, summarizeRuntimeState, type TimelineItem } from './shared';

function requestActions(requestKind: TimelineItem['requestKind']): TimelineItem['actions'] {
  if (requestKind === 'plan_exit') {
    return [
      { key: 'approve', label: 'Continue', kind: 'approve' },
      { key: 'deny', label: 'Stay In Plan Mode', kind: 'deny' },
    ];
  }

  if (requestKind === 'question') {
    return [{ key: 'approve', label: 'Send', kind: 'approve' }];
  }

  return [
    { key: 'approve', label: 'Approve', kind: 'approve' },
    { key: 'deny', label: 'Deny', kind: 'deny' },
  ];
}

function resolveRequestKind(event: ConversationEvent): TimelineItem['requestKind'] {
  const requestKind = typeof event.payload.requestKind === 'string' ? event.payload.requestKind : '';
  if (requestKind === 'approval' || requestKind === 'question' || requestKind === 'plan_exit') return requestKind;
  if (event.type === 'approval.request') return 'approval';
  if (event.type === 'question.request') return 'question';
  if (event.type === 'plan_exit.request') return 'plan_exit';
  return 'approval';
}

function formatModelLabel(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  return trimmed;
}

export function buildCodexTimeline(events: ConversationEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let bufferedAssistant = '';
  const flushAssistant = (eventId: string): void => {
    const content = bufferedAssistant.trim();
    if (!content) return;
    items.push({ id: `assistant-${eventId}`, kind: 'assistant', title: 'Assistant', body: content });
    bufferedAssistant = '';
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.type === 'message.user') {
      flushAssistant(event.id);
      items.push({ id: event.id, kind: 'user', title: 'You', body: String(event.payload.content ?? ''), event });
      continue;
    }
    if (event.type === 'message.assistant.delta') {
      bufferedAssistant += String(event.payload.content ?? '');
      continue;
    }
    if (event.type === 'message.assistant.final') {
      const content = String(event.payload.content ?? '').trim() || bufferedAssistant.trim();
      if (content) items.push({ id: event.id, kind: 'assistant', title: 'Assistant', body: content, details: stringifyDetails(event.payload), event });
      bufferedAssistant = '';
      continue;
    }

    // Defensive: skip agent_message codex.items BEFORE flushing to prevent delta fragmentation
    if (event.type === 'codex.item') {
      const itemType = typeof event.payload.itemType === 'string' ? event.payload.itemType : 'item';
      const stage = typeof event.payload.stage === 'string' ? event.payload.stage : 'updated';
      if (itemType === 'agent_message' && (stage === 'updated' || stage === 'completed')) continue;
    }

    flushAssistant(event.id);

    if (event.type === 'codex.item') {
      const itemType = typeof event.payload.itemType === 'string' ? event.payload.itemType : 'item';
      const stage = typeof event.payload.stage === 'string' ? event.payload.stage : 'updated';
      const toolInfo = extractToolLabel(event.payload);
      const title = toolInfo.label !== 'Tool'
        ? `${toolInfo.label}${toolInfo.preview ? `: ${toolInfo.preview}` : ''}`
        : `${itemType.replace(/_/g, ' ')} · ${stage}`;
      const body = itemType === 'reasoning'
        ? (typeof event.payload.summary === 'string' ? event.payload.summary : undefined) ?? summarizeForPreview(event.payload)
        : summarizeForPreview(event.payload);
      items.push({
        id: event.id,
        kind: itemType === 'reasoning' ? 'plan' : 'tool',
        title,
        body,
        details: stringifyDetails(event.payload),
        event,
        collapsed: true,
      });
      continue;
    }

    if (event.type === 'interactive.request' || event.type === 'approval.request' || event.type === 'question.request' || event.type === 'plan_exit.request') {
      const requestKind = resolveRequestKind(event);
      const title = requestKind === 'approval'
        ? 'Approval required'
        : requestKind === 'question'
          ? 'Question'
          : 'Plan mode decision';
      items.push({
        id: event.id,
        kind: requestKind === 'question' ? 'question' : requestKind === 'plan_exit' ? 'plan_exit' : 'request',
        requestKind,
        title,
        body: readVisibleText(event.payload) || undefined,
        details: stringifyDetails(event.payload),
        event,
        actions: requestActions(requestKind),
      });
      continue;
    }

    if (event.type === 'tool.call' || event.type === 'tool.output' || event.type === 'tool.result') {
      const toolInfo = extractToolLabel(event.payload);
      const title = event.type === 'tool.call'
        ? `${toolInfo.label}${toolInfo.preview ? `: ${toolInfo.preview}` : ''}`
        : event.type === 'tool.result' ? `${toolInfo.label} result` : `${toolInfo.label} output`;
      items.push({
        id: event.id,
        kind: 'tool',
        title,
        body: summarizeForPreview(event.payload),
        details: stringifyDetails(event.payload),
        event,
        collapsed: true,
      });
      continue;
    }

    if (event.type === 'plan.message') {
      items.push({ id: event.id, kind: 'plan', title: 'Reasoning', body: summarizeForPreview(event.payload), details: stringifyDetails(event.payload), event, collapsed: true });
      continue;
    }

    if (event.type === 'subagent.spawned' || event.type === 'subagent.status' || event.type === 'subagent.completed') {
      const tool = typeof event.payload.tool === 'string' ? event.payload.tool : 'subagent';
      const statusText = typeof event.payload.status === 'string' ? event.payload.status : '';
      const prompt = typeof event.payload.prompt === 'string' ? event.payload.prompt : '';
      const description = typeof event.payload.description === 'string' ? event.payload.description : '';
      const agentStatus = event.type === 'subagent.completed' ? 'done' as const
        : statusText === 'running' ? 'active' as const
        : statusText === 'pendingInit' || statusText === 'inProgress' ? 'waiting' as const
        : statusText === 'completed' ? 'done' as const
        : 'waiting' as const;
      items.push({
        id: event.id,
        kind: 'agent',
        title: description || tool,
        body: prompt || statusText || undefined,
        details: stringifyDetails(event.payload),
        event,
        collapsed: false,
        agentStatus,
      });
      continue;
    }

    if (event.type === 'error') {
      items.push({ id: event.id, kind: 'error', title: 'Error', body: readPayloadText(event.payload) || String(event.payload.message ?? 'Unknown error'), details: stringifyDetails(event.payload), event });
      continue;
    }

    if (event.type === 'runtime.state') {
      const next = i + 1 < events.length ? events[i + 1] : null;
      if (next?.type === 'runtime.state') continue;
      const state = typeof event.payload.state === 'string' ? event.payload.state : '';
      if (state === 'running' && next?.type === 'message.assistant.delta') continue;
      const summary = summarizeRuntimeState(event.payload);
      if (summary) items.push({ id: event.id, kind: 'status', title: 'Runtime', body: summary, details: stringifyDetails(event.payload), event, hidden: true });
    }
  }

  flushAssistant('final');
  return items.map((item) => ({ ...item, canRewind: item.kind === 'user' }));
}
