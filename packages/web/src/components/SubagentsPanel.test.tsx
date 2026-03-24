import { describe, expect, it } from 'vitest';
import { extractSubagents } from './SubagentsPanel';
import type { StoredEvent } from '../lib/types';

function makeEvent(type: StoredEvent['type'], payload: Record<string, unknown>): StoredEvent {
  return {
    id: `${type}-1`,
    conversationId: 'conv-1',
    type,
    payload,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('extractSubagents', () => {
  it('preserves thread-start metadata delivered via singular threadId', () => {
    const events: StoredEvent[] = [
      makeEvent('subagent.spawned', {
        receiverThreadIds: ['child-1'],
        agentsStates: { 'child-1': { status: 'pendingInit' } },
        tool: 'spawn_agent',
        prompt: 'Investigate bug',
      }),
      makeEvent('subagent.status', {
        threadId: 'child-1',
        status: 'running',
        agentNickname: 'Scout',
        agentRole: 'explorer',
        model: 'gpt-5.4-mini',
      }),
    ];

    expect(extractSubagents(events)).toEqual([
      expect.objectContaining({
        threadId: 'child-1',
        status: 'running',
        agentNickname: 'Scout',
        agentRole: 'explorer',
        model: 'gpt-5.4-mini',
        displayStatus: 'active',
      }),
    ]);
  });
});
