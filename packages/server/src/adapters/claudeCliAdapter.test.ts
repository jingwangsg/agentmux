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
    expect(parseClaudeLine(JSON.stringify({ type: 'tool_result', result: 'ok' })).kind).toBe('tool_output');
    expect(parseClaudeLine(JSON.stringify({ type: 'permission_request', id: 'p1' })).kind).toBe('approval');
  });

  it('builds rewind request payload', () => {
    expect(buildClaudeRewindRequest({ userMessageId: 'm1', dryRun: true })).toEqual({
      type: 'rewind_code',
      userMessageId: 'm1',
      dryRun: true,
    });
  });
});
