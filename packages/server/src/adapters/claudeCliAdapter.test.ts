import { describe, expect, it } from 'vitest';
import {
  buildClaudeRewindRequest,
  extractClaudeSubagentPayload,
  extractClaudeSubagentResultPayload,
  extractClaudeText,
  normalizeClaudeInteractivePayload,
  normalizeClaudeRequestKind,
  parseClaudeLine,
} from './claudeCliAdapter.js';

describe('Claude adapter helpers', () => {
  it('extracts text from arrays and objects', () => {
    expect(extractClaudeText('hello')).toBe('hello');
    expect(extractClaudeText([{ text: 'a' }, { text: 'b' }])).toBe('ab');
    expect(extractClaudeText({ text: 'solo' })).toBe('solo');
  });

  it('parses assistant final output', () => {
    const parsed = parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ text: 'done' }] } }));
    expect(parsed).toEqual({ kind: 'final', content: 'done' });
  });

  it('parses tool and approval events', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'tool_use', name: 'bash' })).kind).toBe('tool_call');
    expect(parseClaudeLine(JSON.stringify({ type: 'tool_result', result: 'ok' })).kind).toBe('tool_result');
    expect(parseClaudeLine(JSON.stringify({ type: 'permission_request', id: 'p1' })).kind).toBe('approval');
  });

  it('builds rewind request payload', () => {
    expect(buildClaudeRewindRequest({ userMessageId: 'm1', dryRun: true })).toEqual({
      type: 'rewind_code',
      userMessageId: 'm1',
      dryRun: true,
    });
  });

  it('parses control_request events', () => {
    const parsed = parseClaudeLine(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-1',
      tool_name: 'bash',
    }));
    expect(parsed.kind).toBe('control_request');
    if (parsed.kind === 'control_request') {
      expect(parsed.subtype).toBe('can_use_tool');
      expect(parsed.requestId).toBe('req-1');
    }
  });

  it('ignores keep_alive events', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'keep_alive' })).kind).toBe('ignore');
    expect(parseClaudeLine(JSON.stringify({ type: 'keepalive' })).kind).toBe('ignore');
  });

  it('extracts session_id from result events', () => {
    const parsed = parseClaudeLine(JSON.stringify({
      type: 'result',
      content: [{ text: 'Final answer' }],
      session_id: 'sess-abc',
    }));
    expect(parsed.kind).toBe('final');
    if (parsed.kind === 'final') {
      expect(parsed.content).toBe('Final answer');
      expect(parsed.sessionId).toBe('sess-abc');
    }
  });

  it('does not produce plan kind for messages containing plan keywords', () => {
    const assistantWithPlan = parseClaudeLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: 'I am now in plan mode and will create a plan' }] },
    }));
    expect(assistantWithPlan.kind).toBe('final');

    const resultWithPermit = parseClaudeLine(JSON.stringify({
      type: 'result',
      content: [{ text: 'permit to execute the changes' }],
      session_id: 'sess-1',
    }));
    expect(resultWithPermit.kind).toBe('final');

    const systemWithPlan = parseClaudeLine(JSON.stringify({
      type: 'system',
      subtype: 'plan_notification',
      content: 'plan mode active',
    }));
    expect(systemWithPlan.kind).toBe('ignore');

    const plainText = parseClaudeLine('permit to execute something');
    expect(plainText.kind).toBe('delta');
  });

  it('normalizes plan-exit requests from tool permissions', () => {
    expect(normalizeClaudeRequestKind('can_use_tool', { tool_name: 'ExitPlanMode' })).toBe('plan_exit');
    expect(normalizeClaudeInteractivePayload('can_use_tool', 'req-plan', {
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '1. Explore\n2. Write README' },
    })).toMatchObject({
      requestId: 'req-plan',
      requestKind: 'plan_exit',
      toolName: 'ExitPlanMode',
      message: '1. Explore\n2. Write README',
    });
  });

  it('normalizes question requests from elicitation payloads', () => {
    expect(normalizeClaudeRequestKind('elicitation', { message: 'Which directory should I inspect first?' })).toBe('question');
    expect(normalizeClaudeInteractivePayload('elicitation', 'req-q', {
      message: 'Which directory should I inspect first?',
    })).toMatchObject({
      requestId: 'req-q',
      requestKind: 'question',
      message: 'Which directory should I inspect first?',
    });
  });

  it('extracts subagent spawn payload from Task tool calls', () => {
    expect(extractClaudeSubagentPayload({
      name: 'Task',
      input: {
        prompt: 'Explore the backend and frontend in parallel',
        description: 'Multi-agent repo exploration',
        agents: [{ thread_id: 'thread-a' }, { thread_id: 'thread-b' }],
        model: 'claude-sonnet',
      },
    })).toMatchObject({
      tool: 'spawnAgent',
      status: 'inProgress',
      prompt: 'Explore the backend and frontend in parallel',
      description: 'Multi-agent repo exploration',
      receiverThreadIds: ['thread-a', 'thread-b'],
      model: 'claude-sonnet',
    });
  });

  it('extracts subagent completion payload from Task results', () => {
    expect(extractClaudeSubagentResultPayload({
      name: 'Task',
      result: {
        status: 'completed',
        description: 'Agents finished exploration',
        receiverThreadIds: ['thread-a', 'thread-b'],
      },
    })).toMatchObject({
      tool: 'spawnAgent',
      status: 'completed',
      description: 'Agents finished exploration',
      receiverThreadIds: ['thread-a', 'thread-b'],
    });
  });
});
