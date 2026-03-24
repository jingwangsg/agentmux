import { describe, expect, it } from 'vitest';
import type { BackendType, EventType, RuntimeState } from './types.js';

describe('types sanity', () => {
  it('accepts expected backend literals', () => {
    const backends: BackendType[] = ['codex', 'claude'];
    expect(backends).toEqual(['codex', 'claude']);
  });

  it('accepts expected runtime states and event types', () => {
    const states: RuntimeState[] = ['idle', 'running', 'waiting_input', 'completed', 'error', 'stopped', 'resume_failed', 'starting'];
    const eventTypes: EventType[] = [
      'conversation.created',
      'conversation.updated',
      'runtime.state',
      'message.user',
      'message.assistant.delta',
      'message.assistant.final',
      'run.started',
      'run.completed',
      'run.cancelled',
      'interactive.request',
      'interactive.response',
      'tool.call',
      'tool.output',
      'approval.request',
      'error',
    ];
    expect(states).toContain('running');
    expect(eventTypes).toContain('tool.call');
  });
});
