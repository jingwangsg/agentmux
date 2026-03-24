import { describe, expect, it } from 'vitest';
import { buildCodexRewindSteps, buildCodexTurnStartParams, parseCodexNotification, resolveCodexSubagentEventModel } from './codexCliAdapter.js';
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

  it('passes provider-qualified model through turn/start params', () => {
    const params = buildCodexTurnStartParams(
      {
        ...conversation,
        config: {
          model: 'openai/openai/gpt-5.4',
          reasoningEffort: 'xhigh',
        },
      },
      'hello',
      'thread-1',
    );

    expect(params.model).toBe('openai/openai/gpt-5.4');
    expect(params.config).toMatchObject({
      model: 'openai/openai/gpt-5.4',
      reasoning_effort: 'xhigh',
    });
  });

  it('encodes plan mode as structured collaborationMode params', () => {
    const params = buildCodexTurnStartParams(
      {
        ...conversation,
        config: {
          mode: 'plan',
          model: 'openai/openai/gpt-5.4',
          reasoningEffort: 'high',
        },
      },
      'hello',
      'thread-1',
    );

    expect(params.model).toBeNull();
    expect(params.effort).toBeNull();
    expect(params.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'openai/openai/gpt-5.4',
        reasoning_effort: 'high',
        developer_instructions: null,
      },
    });
  });

  it('builds rewind steps as rollback then restart', () => {
    const steps = buildCodexRewindSteps(
      {
        ...conversation,
        config: { mode: 'plan', model: 'gpt-5.4', reasoningEffort: 'medium' },
      },
      'thread-1',
      { message: 'edited prompt' },
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ method: 'thread/rollback', params: { threadId: 'thread-1', numTurns: 1 } });
    expect(steps[1]).toMatchObject({
      method: 'turn/start',
      params: {
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.4',
            reasoning_effort: 'medium',
            developer_instructions: null,
          },
        },
      },
    });
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
    expect(parseCodexNotification({ method: 'item/tool/requestUserInput', params: { requestId: 'r1' } })).toMatchObject({ kind: 'interactive', payload: { requestKind: 'question', requestId: 'r1' } });
    expect(parseCodexNotification({ method: 'item/fileChange/requestApproval', params: { requestId: 'r2' } })).toMatchObject({ kind: 'approval', payload: { requestKind: 'approval', requestId: 'r2' } });
  });

  it('parses plan exit interactive requests from structured request kind', () => {
    expect(parseCodexNotification({
      method: 'item/tool/requestUserInput',
      params: { requestId: 'r3', requestKind: 'plan_exit', message: 'Approve this plan' },
    })).toMatchObject({
      kind: 'interactive',
      payload: { requestKind: 'plan_exit', requestId: 'r3', message: 'Approve this plan' },
    });
  });

  it('falls back plan exit detection from payload text heuristics', () => {
    expect(parseCodexNotification({
      method: 'item/tool/requestUserInput',
      params: { requestId: 'r4', message: 'Permit to execute this plan mode proposal?' },
    })).toMatchObject({
      kind: 'interactive',
      payload: { requestKind: 'plan_exit', requestId: 'r4' },
    });
  });

  it('maps reasoning summary deltas into compact plan payloads', () => {
    expect(parseCodexNotification({ method: 'item/reasoning/summaryTextDelta', params: { text: 'brief summary' } })).toMatchObject({
      kind: 'plan',
      payload: { content: 'brief summary', summary: 'brief summary', summaryOnly: true },
    });
  });

  it('falls back subagent mini model to parent provider-qualified model', () => {
    const result = resolveCodexSubagentEventModel(
      {
        ...conversation,
        config: { model: 'openai/openai/gpt-5.4' },
      },
      'gpt-5.4-mini',
    );

    expect(result).toBe('openai/openai/gpt-5.4');
  });

  it('uses parent provider-qualified model when subagent model is omitted', () => {
    const result = resolveCodexSubagentEventModel(
      {
        ...conversation,
        config: { model: 'openai/openai/gpt-5.4' },
      },
      null,
    );

    expect(result).toBe('openai/openai/gpt-5.4');
  });
});
