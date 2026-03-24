import type { StoredEvent as ConversationEvent } from '../lib/types';
import { extractToolLabel, readPayloadText, stringifyDetails, summarizeRuntimeState, type TimelineItem } from './shared';

export function buildClaudeTimeline(events: ConversationEvent[]): TimelineItem[] {
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

    flushAssistant(event.id);

    if (event.type === 'claude.step' || event.type === 'plan.message') {
      const stepType = typeof event.payload.stepType === 'string' ? event.payload.stepType : event.type === 'plan.message' ? 'plan' : 'step';
      items.push({
        id: event.id,
        kind: stepType === 'plan' ? 'plan' : stepType === 'permit' ? 'request' : 'tool',
        title: stepType.replace(/_/g, ' '),
        body: readPayloadText(event.payload) || undefined,
        details: stringifyDetails(event.payload),
        event,
        collapsed: stepType !== 'permit',
        actions: stepType === 'permit'
          ? [
              { key: 'approve', label: 'Approve', kind: 'approve' },
              { key: 'deny', label: 'Deny', kind: 'deny' },
            ]
          : undefined,
      });
      continue;
    }

    if (event.type === 'approval.request' || event.type === 'interactive.request') {
      items.push({
        id: event.id,
        kind: 'request',
        title: 'Action required',
        body: readPayloadText(event.payload) || undefined,
        details: stringifyDetails(event.payload),
        event,
        actions: [
          { key: 'approve', label: 'Approve', kind: 'approve' },
          { key: 'deny', label: 'Deny', kind: 'deny' },
        ],
      });
      continue;
    }

    if (event.type === 'tool.call' || event.type === 'tool.result') {
      const toolInfo = extractToolLabel(event.payload);
      const title = event.type === 'tool.call'
        ? `${toolInfo.label}${toolInfo.preview ? `: ${toolInfo.preview}` : ''}`
        : `${toolInfo.label} result`;
      items.push({ id: event.id, kind: 'tool', title, body: readPayloadText(event.payload) || undefined, details: stringifyDetails(event.payload), event, collapsed: true });
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
