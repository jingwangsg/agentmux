import type { StoredEvent as ConversationEvent } from '../lib/types';
import { extractToolLabel, readPayloadText, stringifyDetails, summarizeRuntimeState, type TimelineItem } from './shared';

function requestActions(): TimelineItem['actions'] {
  return [
    { key: 'approve', label: 'Approve', kind: 'approve' },
    { key: 'deny', label: 'Deny', kind: 'deny' },
  ];
}

export function buildCodexTimeline(events: ConversationEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let bufferedAssistant = '';
  let lastUserMessageId: string | undefined;

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
      lastUserMessageId = event.id;
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
      items.push({
        id: event.id,
        kind: itemType === 'reasoning' ? 'plan' : 'tool',
        title,
        body: readPayloadText(event.payload) || undefined,
        details: stringifyDetails(event.payload),
        event,
        collapsed: true,
      });
      continue;
    }

    if (event.type === 'codex.request' || event.type === 'interactive.request' || event.type === 'approval.request') {
      const requestType = typeof event.payload.requestType === 'string' ? event.payload.requestType : event.type;
      items.push({
        id: event.id,
        kind: 'request',
        title: `${requestType} required`,
        body: readPayloadText(event.payload) || undefined,
        details: stringifyDetails(event.payload),
        event,
        actions: requestActions(),
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
        body: readPayloadText(event.payload) || undefined,
        details: stringifyDetails(event.payload),
        event,
        collapsed: true,
      });
      continue;
    }

    if (event.type === 'plan.message') {
      items.push({ id: event.id, kind: 'plan', title: 'Reasoning', body: readPayloadText(event.payload) || undefined, details: stringifyDetails(event.payload), event, collapsed: true });
      continue;
    }

    if (event.type === 'subagent.spawned' || event.type === 'subagent.status' || event.type === 'subagent.completed') {
      const tool = typeof event.payload.tool === 'string' ? event.payload.tool : 'subagent';
      const receiverIds = Array.isArray(event.payload.receiverThreadIds) ? event.payload.receiverThreadIds as string[] : [];
      const statusText = typeof event.payload.status === 'string' ? event.payload.status : '';
      items.push({
        id: event.id,
        kind: 'subagent',
        title: `${tool}${receiverIds.length > 0 ? ` (${receiverIds.length} agent${receiverIds.length !== 1 ? 's' : ''})` : ''}`,
        body: (typeof event.payload.prompt === 'string' ? event.payload.prompt : '') || statusText,
        details: stringifyDetails(event.payload),
        event,
        collapsed: tool !== 'spawnAgent',
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
