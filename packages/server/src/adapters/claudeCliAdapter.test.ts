import { describe, expect, it } from 'vitest';
import { buildClaudeRewindRequest, extractClaudeText, parseClaudeLine } from './claudeCliAdapter.js';

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
});
