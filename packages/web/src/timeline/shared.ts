import type { StoredEvent as ConversationEvent } from '../lib/types';

export type TimelineActionKind = 'approve' | 'deny';

export type TimelineItem = {
  id: string;
  kind: string;
  title: string;
  body?: string;
  details?: string;
  event?: ConversationEvent;
  canRewind?: boolean;
  actions?: Array<{ key: string; label: string; kind: TimelineActionKind }>;
  hidden?: boolean;
  collapsed?: boolean;
};

export function tryParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function stringifyDetails(payload: Record<string, unknown>): string | undefined {
  const text = JSON.stringify(payload, null, 2);
  return text === '{}' ? undefined : text;
}

export function readPayloadText(payload: Record<string, unknown>): string {
  for (const key of ['content', 'message', 'output', 'status', 'summary', 'delta', 'text', 'command']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  const nested = typeof payload.message === 'string' ? tryParseJsonObject(payload.message) : null;
  if (nested) {
    return readPayloadText(nested);
  }
  return '';
}

export function summarizeRuntimeState(payload: Record<string, unknown>): string | null {
  const state = typeof payload.state === 'string' ? payload.state : '';
  const detail = typeof payload.detail === 'string' ? payload.detail : '';
  if (!state) {
    return null;
  }
  if (state === 'running') return detail ? `Running — ${detail}` : 'Running';
  if (state === 'waiting_input') return detail ? `Waiting for input — ${detail}` : 'Waiting for input';
  if (state === 'completed') return detail ? `Completed — ${detail}` : 'Completed';
  if (state === 'stopped') return detail ? `Stopped — ${detail}` : 'Stopped';
  if (state === 'idle') return detail ? `Ready — ${detail}` : 'Ready';
  if (state === 'error' || state === 'resume_failed') return detail ? `Error — ${detail}` : 'Error';
  return `${state}${detail ? ` — ${detail}` : ''}`;
}

export function deriveRuntimeBanner(events: ConversationEvent[]): { content: string; details?: string } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'runtime.state') continue;
    const summary = summarizeRuntimeState(event.payload);
    if (!summary) return null;
    return { content: summary, details: stringifyDetails(event.payload) };
  }
  return null;
}
