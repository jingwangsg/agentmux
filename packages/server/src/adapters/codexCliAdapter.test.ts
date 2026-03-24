import { describe, expect, it } from 'vitest';
import { buildCodexRewindSteps, buildCodexTurnStartParams, parseCodexNotification } from './codexCliAdapter.js';
import type { ConversationRecord } from '../types.js';

const conversation: ConversationRecord = {
  id: 'c1',
  backend: 'codex',
  title: 'Test',
  runtimeState: 'idle',
  cwd: '/tmp/work',
  config: {},
  resumeHandle: null,
  parentConversationId: null,
  depth: 0,
  agentNickname: null,
  agentRole: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRuntimeStartedAt: null,
  lastRuntimeStoppedAt: null,
};

describe('Codex adapter helpers', () => {
  it('builds turn/start params', () => {
    const params = buildCodexTurnStartParams(conversation, 'hello', 'thread-1');
    expect(params.threadId).toBe('thread-1');
    expect(params.input).toEqual([{ type: 'text', text: 'hello', text_elements: [] }]);
    expect(params.cwd).toBe('/tmp/work');
    expect(params.summary).toBe('none');
  });

  it('builds rewind steps as rollback then restart', () => {
    const steps = buildCodexRewindSteps(conversation, 'thread-1', { message: 'edited prompt' });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ method: 'thread/rollback', params: { threadId: 'thread-1', numTurns: 1 } });
    expect(steps[1]).toMatchObject({ method: 'turn/start' });
  });

  it('builds rollback-only rewind when no message is supplied', () => {
    const steps = buildCodexRewindSteps(conversation, 'thread-1', {});
    expect(steps).toEqual([{ method: 'thread/rollback', params: { threadId: 'thread-1', numTurns: 1 } }]);
  });

  it('parses key notifications', () => {
    expect(parseCodexNotification({ method: 'thread/started', params: { threadId: 't1' } })).toMatchObject({ kind: 'state', threadId: 't1' });
    expect(parseCodexNotification({ method: 'turn/started', params: { turn: { id: 'x' } } })).toMatchObject({ kind: 'state', state: 'running' });
    expect(parseCodexNotification({ method: 'turn/completed', params: { turn: { id: 'x' } } })).toMatchObject({ kind: 'state', state: 'completed' });
    expect(parseCodexNotification({ method: 'item/agentMessage/delta', params: { delta: 'hello' } })).toEqual({ kind: 'delta', content: 'hello' });
    expect(parseCodexNotification({ method: 'item/tool/call', params: { tool: 'bash' } }).kind).toBe('tool_call');
    expect(parseCodexNotification({ method: 'item/tool/requestUserInput', params: { requestId: 'r1' } }).kind).toBe('interactive');
    expect(parseCodexNotification({ method: 'item/fileChange/requestApproval', params: { requestId: 'r2' } }).kind).toBe('approval');
  });
});
