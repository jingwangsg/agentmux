import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCliAdapter } from './claudeCliAdapter.js';
import { CodexCliAdapter } from './codexCliAdapter.js';
import type { RuntimeEventSink } from '../runtime/adapter.js';
import type { ConversationRecord } from '../types.js';

class MockChildProcess extends EventEmitter {
  public stdin = new PassThrough();
  public stdout = new PassThrough();
  public stderr = new PassThrough();
  public killed = false;

  public kill(): void {
    this.killed = true;
  }
}

function createSink() {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const sink: RuntimeEventSink = {
    emitDelta: (...args) => void calls.push({ kind: 'delta', args }),
    emitFinal: (...args) => void calls.push({ kind: 'final', args }),
    emitState: (...args) => void calls.push({ kind: 'state', args }),
    emitInteractiveRequest: (...args) => void calls.push({ kind: 'interactive', args }),
    emitToolCall: (...args) => void calls.push({ kind: 'tool_call', args }),
    emitToolOutput: (...args) => void calls.push({ kind: 'tool_output', args }),
    emitToolResult: (...args) => void calls.push({ kind: 'tool_result', args }),
    emitPlanMessage: (...args) => void calls.push({ kind: 'plan', args }),
    emitCodexItem: (...args) => void calls.push({ kind: 'codex_item', args }),
    emitCodexRequest: (...args) => void calls.push({ kind: 'codex_request', args }),
    emitClaudeStep: (...args) => void calls.push({ kind: 'claude_step', args }),
    emitApprovalRequest: (...args) => void calls.push({ kind: 'approval', args }),
    emitPlanExitRequest: (...args) => void calls.push({ kind: 'plan_exit', args }),
    emitQuestionRequest: (...args) => void calls.push({ kind: 'question', args }),
    emitError: (...args) => void calls.push({ kind: 'error', args }),
    emitResumeHandle: (...args) => void calls.push({ kind: 'resume_handle', args }),
    emitTitleUpdate: (...args) => void calls.push({ kind: 'title_update', args }),
    emitTokenUsage: (...args) => void calls.push({ kind: 'token_usage', args }),
    emitSubagentEvent: (...args) => void calls.push({ kind: 'subagent_event', args }),
    emitSubagentThreadStarted: (...args) => void calls.push({ kind: 'subagent_thread', args }),
  };
  return { sink, calls };
}

const conversation: ConversationRecord = {
  id: 'conv-1',
  backend: 'claude',
  title: 'Test',
  runtimeState: 'idle',
  cwd: '/tmp/work',
  config: {},
  resumeHandle: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  parentConversationId: null,
  depth: 0,
  agentNickname: null,
  agentRole: null,
  lastRuntimeStartedAt: null,
  lastRuntimeStoppedAt: null,
};

function autoReplyJsonRpc(child: MockChildProcess): string[] {
  const writes: string[] = [];
  child.stdin.on('data', (chunk) => {
    const line = String(chunk);
    writes.push(line);
    for (const rawLine of line.split('\n').filter(Boolean)) {
      let message: { id?: number; method?: string; type?: string };
      try {
        message = JSON.parse(rawLine) as { id?: number; method?: string; type?: string };
      } catch {
        continue;
      }
      if (typeof message.id !== 'number') {
        continue;
      }
      if (message.method === 'thread/start' || message.method === 'thread/resume') {
        child.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' } } }) + '\n');
      } else if (message.method === 'turn/start') {
        child.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-2' } } }) + '\n');
      } else {
        child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
      }
    }
  });
  return writes;
}

describe('Runtime adapters with mocked processes', () => {
  it('Claude adapter writes messages and rewind requests to stdin', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink } = createSink();
    const writes = autoReplyJsonRpc(child);

    await adapter.resume(conversation, sink);
    await adapter.sendMessage(conversation, 'hello', sink);
    await adapter.rewind(conversation, { userMessageId: 'm1', dryRun: true }, sink);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Message format now uses structured content blocks
    expect(writes.some((line) => line.includes('"text":"hello"'))).toBe(true);
    expect(writes.some((line) => line.includes('"type":"rewind_code"'))).toBe(true);
  });

  it('Claude adapter passes configured model to process args', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink } = createSink();

    await adapter.resume({ ...conversation, config: { model: 'sonnet' } }, sink);

    const firstCall = spawnMock.mock.calls[0] as unknown[] | undefined;
    const args = (firstCall?.[1] ?? undefined) as string[] | undefined;
    expect(args).toBeDefined();
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    // New flags should be present
    expect(args).toContain('--input-format');
    expect(args).toContain('--thinking');
  });

  it('Claude adapter propagates stdout/stderr/close and cancel', async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    await adapter.resume(conversation, sink);
    child.stdout.write(JSON.stringify({ type: 'tool_use', name: 'bash' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'permission_request', id: 'p1' }) + '\n');
    child.stderr.write('Ignoring extra certs from /etc/ssl/certs/npm-bundle.crt, load failed\n');
    child.stderr.write('fatal stderr boom\n');
    await adapter.cancel(conversation.id);
    // Cancel now uses a delayed SIGINT — advance timers to trigger it
    vi.advanceTimersByTime(600);
    child.emit('close');

    expect(calls.some((call) => call.kind === 'tool_call')).toBe(true);
    expect(calls.some((call) => call.kind === 'approval')).toBe(true);
    expect(calls.some((call) => call.kind === 'error' && String(call.args[1]).includes('fatal stderr boom'))).toBe(true);
    // 'Ignoring extra certs' is now filtered out as noise — should NOT appear as error
    expect(calls.some((call) => call.kind === 'error' && String(call.args[1]).includes('Ignoring extra certs'))).toBe(false);
    expect(child.killed).toBe(true);
    expect(calls.some((call) => call.kind === 'state' && call.args[1] === 'stopped')).toBe(true);
    vi.useRealTimers();
  });

  it('Claude adapter routes ExitPlanMode control request to emitPlanExitRequest', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    await adapter.resume({ ...conversation, config: { mode: 'plan' } }, sink);
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-plan-1',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '## Step 1\nDo the thing\n## Step 2\nVerify' },
    }) + '\n');

    // Should emit plan_exit, not generic approval
    expect(calls.some((c) => c.kind === 'plan_exit')).toBe(true);
    expect(calls.some((c) => c.kind === 'approval' && JSON.stringify(c.args).includes('ExitPlanMode'))).toBe(false);

    // Check payload contains planContent
    const planCall = calls.find((c) => c.kind === 'plan_exit');
    const payload = (planCall?.args[1] ?? {}) as Record<string, unknown>;
    expect(payload.planContent).toBe('## Step 1\nDo the thing\n## Step 2\nVerify');
    expect(payload.requestId).toBe('req-plan-1');
    expect(payload.toolName).toBe('ExitPlanMode');

    // Duplicate claude_step no longer emitted for plan_exit (only the request event)
    const stepCall = calls.find((c) => c.kind === 'claude_step' && (c.args[1] as Record<string, unknown>).stepType === 'plan_exit');
    expect(stepCall).toBeUndefined();
  });

  it('Claude adapter routes AskUserQuestion control request to emitQuestionRequest', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    await adapter.resume(conversation, sink);
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-q-1',
      tool_name: 'AskUserQuestion',
      tool_input: { question: 'Which database should I use?' },
    }) + '\n');

    // Should emit question, not generic approval
    expect(calls.some((c) => c.kind === 'question')).toBe(true);
    expect(calls.some((c) => c.kind === 'approval' && JSON.stringify(c.args).includes('AskUserQuestion'))).toBe(false);

    // Check payload contains questionText
    const questionCall = calls.find((c) => c.kind === 'question');
    const payload = (questionCall?.args[1] ?? {}) as Record<string, unknown>;
    expect(payload.questionText).toBe('Which database should I use?');
    expect(payload.requestId).toBe('req-q-1');

    // Duplicate claude_step no longer emitted for question (only the request event)
    const stepCall = calls.find((c) => c.kind === 'claude_step' && (c.args[1] as Record<string, unknown>).stepType === 'question');
    expect(stepCall).toBeUndefined();
  });

  it('Claude adapter routes generic tool approval unchanged', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    await adapter.resume(conversation, sink);
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-tool-1',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/foo.txt', content: 'hello' },
    }) + '\n');

    // Should use generic approval, not plan_exit or question
    expect(calls.some((c) => c.kind === 'approval')).toBe(true);
    expect(calls.some((c) => c.kind === 'plan_exit')).toBe(false);
    expect(calls.some((c) => c.kind === 'question')).toBe(false);

    const approvalCall = calls.find((c) => c.kind === 'approval');
    const payload = (approvalCall?.args[1] ?? {}) as Record<string, unknown>;
    expect(payload.toolName).toBe('Write');
  });

  it('Codex adapter routes plan_exit without generic codex request duplication', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new CodexCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    autoReplyJsonRpc(child);
    await adapter.resume({ ...conversation, backend: 'codex' }, sink);

    child.stdout.write(JSON.stringify({
      method: 'item/tool/requestUserInput',
      params: { requestId: 'req-plan-1', requestKind: 'plan_exit', message: 'Approve this plan' },
    }) + '\n');

    expect(calls.some((c) => c.kind === 'plan_exit')).toBe(true);
    expect(calls.some((c) => c.kind === 'codex_request' && JSON.stringify(c.args).includes('req-plan-1'))).toBe(false);
  });

  it('Codex adapter keeps generic codex request for normal interactive questions', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new CodexCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    autoReplyJsonRpc(child);
    await adapter.resume({ ...conversation, backend: 'codex' }, sink);

    child.stdout.write(JSON.stringify({
      method: 'item/tool/requestUserInput',
      params: { requestId: 'req-q-1', requestKind: 'question', message: 'Need your input' },
    }) + '\n');

    expect(calls.some((c) => c.kind === 'question')).toBe(true);
    expect(calls.some((c) => c.kind === 'codex_request' && JSON.stringify(c.args).includes('req-q-1'))).toBe(false);
  });

  it('Codex adapter routes requestUserInput without plan hints as question request', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new CodexCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    autoReplyJsonRpc(child);
    await adapter.resume({ ...conversation, backend: 'codex' }, sink);

    child.stdout.write(JSON.stringify({
      method: 'item/tool/requestUserInput',
      params: { requestId: 'req-i-1', message: 'Need your confirmation before proceeding' },
    }) + '\n');

    expect(calls.some((c) => c.kind === 'question')).toBe(true);
    expect(calls.some((c) => c.kind === 'codex_request' && JSON.stringify(c.args).includes('req-i-1'))).toBe(false);
  });

  it('Claude adapter respond() sends correct payload for plan_exit approve', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink } = createSink();
    const writes: string[] = [];
    child.stdin.on('data', (chunk) => writes.push(String(chunk)));

    await adapter.resume({ ...conversation, config: { mode: 'plan' } }, sink);
    // Simulate a pending control request
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-plan-2',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'my plan' },
    }) + '\n');

    await adapter.respond(conversation.id, { action: 'approve', requestKind: 'plan_exit' }, sink);

    const responseLine = writes.find((w) => w.includes('control_response'));
    expect(responseLine).toBeDefined();
    const parsed = JSON.parse(responseLine!.trim()) as { response: { response: Record<string, unknown> } };
    expect(parsed.response.response).toEqual({ behavior: 'allow' });
  });


  it('Claude adapter auto-allows ExitPlanMode after approved plan mode exit', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink } = createSink();
    const writes: string[] = [];
    child.stdin.on('data', (chunk) => writes.push(String(chunk)));

    await adapter.resume({ ...conversation, config: { mode: 'plan' } }, sink);
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-plan-exit-1',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'step 1' },
    }) + '\n');

    await adapter.respond(conversation.id, { action: 'approve', requestKind: 'plan_exit' }, sink);

    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-plan-exit-2',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'step 2' },
    }) + '\n');

    const responseLines = writes.filter((w) => w.includes('control_response'));
    expect(responseLines).toHaveLength(2);

    const secondResponse = JSON.parse(responseLines[1].trim()) as { response: { request_id: string; response: Record<string, unknown> } };
    expect(secondResponse.response.request_id).toBe('req-plan-exit-2');
    expect(secondResponse.response.response).toEqual({ behavior: 'allow' });
  });

  it('Claude adapter ignores system events while waiting for input', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    await adapter.resume(conversation, sink);
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-wait-1',
      tool_name: 'AskUserQuestion',
      tool_input: { question: 'Need input' },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      type: 'system',
      subtype: 'status_update',
      content: 'still waiting',
    }) + '\n');

    const waitingCalls = calls.filter((call) => call.kind === 'state' && call.args[1] === 'waiting_input');
    expect(waitingCalls).toHaveLength(1);
    expect(calls.some((call) => call.kind === 'state' && call.args[1] === 'running' && call.args[2] === 'status_update')).toBe(false);
  });

  it('Claude adapter respond() sends deny message for plan_exit deny', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink } = createSink();
    const writes: string[] = [];
    child.stdin.on('data', (chunk) => writes.push(String(chunk)));

    await adapter.resume(conversation, sink);
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-plan-3',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'my plan' },
    }) + '\n');

    await adapter.respond(conversation.id, { action: 'deny', requestKind: 'plan_exit' }, sink);

    const responseLines = writes.filter((w) => w.includes('control_response'));
    expect(responseLines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(responseLines.at(-1)!.trim()) as { response: { response: Record<string, unknown> } };
    const body = parsed.response.response;
    expect(body.behavior).toBe('deny');
    expect(body.message).toBe('User chose to stay in plan mode and continue planning');
  });

  it('Claude adapter respond() sends updatedInput for question', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink } = createSink();
    const writes: string[] = [];
    child.stdin.on('data', (chunk) => writes.push(String(chunk)));

    await adapter.resume(conversation, sink);
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-q-2',
      tool_name: 'AskUserQuestion',
      tool_input: { question: 'Which DB?' },
    }) + '\n');

    await adapter.respond(conversation.id, {
      action: 'approve',
      requestKind: 'question',
      userAnswer: 'Use PostgreSQL',
      originalQuestion: 'Which DB?',
    }, sink);

    const responseLine = writes.find((w) => w.includes('control_response'));
    expect(responseLine).toBeDefined();
    const parsed = JSON.parse(responseLine!.trim()) as { response: { response: Record<string, unknown> } };
    const body = parsed.response.response;
    expect(body.behavior).toBe('allow');
    expect(body.updatedInput).toEqual({ question: 'Which DB?', answer: 'Use PostgreSQL' });
  });

  it('Claude adapter respond() sends plain allow/deny for generic approval', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink } = createSink();
    const writes: string[] = [];
    child.stdin.on('data', (chunk) => writes.push(String(chunk)));

    await adapter.resume(conversation, sink);
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-tool-2',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/foo.txt' },
    }) + '\n');

    await adapter.respond(conversation.id, { action: 'deny', requestKind: 'approval' }, sink);

    const responseLine = writes.find((w) => w.includes('control_response'));
    expect(responseLine).toBeDefined();
    const parsed = JSON.parse(responseLine!.trim()) as { response: { response: Record<string, unknown> } };
    expect(parsed.response.response).toEqual({ behavior: 'deny' });
  });

  it('Claude adapter extracts plan content from various field names', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    await adapter.resume({ ...conversation, config: { mode: 'plan' } }, sink);

    // Field: plan_content
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-pc-1',
      tool_name: 'ExitPlanMode',
      tool_input: { plan_content: 'plan via plan_content field' },
    }) + '\n');

    const planCall = calls.find((c) => c.kind === 'plan_exit');
    const payload = (planCall?.args[1] ?? {}) as Record<string, unknown>;
    expect(payload.planContent).toBe('plan via plan_content field');
  });

  it('Claude adapter extracts question text from text field fallback', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    await adapter.resume(conversation, sink);

    // Field: text (fallback when question is absent)
    child.stdout.write(JSON.stringify({
      type: 'control_request',
      subtype: 'can_use_tool',
      request_id: 'req-qt-1',
      tool_name: 'AskUserQuestion',
      tool_input: { text: 'question via text field' },
    }) + '\n');

    const qCall = calls.find((c) => c.kind === 'question');
    const payload = (qCall?.args[1] ?? {}) as Record<string, unknown>;
    expect(payload.questionText).toBe('question via text field');
  });

  it('Codex adapter initializes process and writes rollback/turn-start on rewind', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new CodexCliAdapter(spawnMock as never);
    const { sink } = createSink();
    const writes = autoReplyJsonRpc(child);

    await adapter.resume({ ...conversation, backend: 'codex' }, sink);
    await adapter.rewind({ ...conversation, backend: 'codex' }, { message: 'edited' }, sink);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(writes.some((line) => line.includes('"method":"initialize"'))).toBe(true);
    expect(writes.some((line) => line.includes('"method":"thread/rollback"'))).toBe(true);
    expect(writes.some((line) => line.includes('"method":"turn/start"'))).toBe(true);
  });

  it('Codex adapter dispatches notifications and cancel path', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new CodexCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();
    const writes = autoReplyJsonRpc(child);

    await adapter.resume({ ...conversation, backend: 'codex' }, sink);
    await adapter.sendMessage({ ...conversation, backend: 'codex' }, 'hello', sink);
    child.stdout.write(JSON.stringify({ method: 'item/tool/requestUserInput', params: { requestId: 'r1', message: 'Need your confirmation before proceeding' } }) + '\n');
    child.stdout.write(JSON.stringify({ method: 'item/fileChange/requestApproval', params: { requestId: 'r2' } }) + '\n');
    child.stdout.write(JSON.stringify({ method: 'item/mcpToolCall/progress', params: { message: 'working' } }) + '\n');
    await adapter.cancel(conversation.id);
    child.emit('close');

    expect(calls.some((call) => call.kind === 'question')).toBe(true);
    expect(calls.some((call) => call.kind === 'approval')).toBe(true);
    expect(calls.some((call) => call.kind === 'tool_output')).toBe(true);
    expect(calls.some((call) => call.kind === 'state' && call.args[1] === 'stopped')).toBe(true);
    expect(writes.some((line) => line.includes('\"method\":\"turn/interrupt\"'))).toBe(true);
  });

  it('Codex adapter applies config to turn/start params', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new CodexCliAdapter(spawnMock as never);
    const { sink } = createSink();
    const writes = autoReplyJsonRpc(child);

    await adapter.resume({
      ...conversation,
      backend: 'codex',
      config: { model: 'gpt-5.4-mini', reasoningEffort: 'high', mode: 'plan' },
    }, sink);
    await adapter.sendMessage({
      ...conversation,
      backend: 'codex',
      config: { model: 'gpt-5.4-mini', reasoningEffort: 'high', mode: 'plan' },
    }, 'hello', sink);

    const turnStart = writes.find((line) => line.includes('"method":"turn/start"')) ?? '';
    expect(turnStart).toContain('gpt-5.4-mini');
    expect(turnStart).toContain('high');
    expect(turnStart).toContain('plan');

    const parsed = JSON.parse(turnStart) as { params: { model: string | null; effort: string | null; collaborationMode: Record<string, unknown> } };
    expect(parsed.params.model).toBeNull();
    expect(parsed.params.effort).toBeNull();
    expect(parsed.params.collaborationMode).toMatchObject({
      mode: 'plan',
      settings: {
        model: 'gpt-5.4-mini',
        reasoning_effort: 'high',
        developer_instructions: null,
      },
    });
  });

  it('Codex adapter handles thread title and token usage notifications', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new CodexCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();
    autoReplyJsonRpc(child);

    await adapter.resume({ ...conversation, backend: 'codex' }, sink);
    child.stdout.write(JSON.stringify({ method: 'thread/name/updated', params: { threadName: 'My Chat' } }) + '\n');
    child.stdout.write(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { input: 100, output: 50 } }) + '\n');

    expect(calls.some((call) => call.kind === 'title_update' && call.args[1] === 'My Chat')).toBe(true);
    expect(calls.some((call) => call.kind === 'token_usage')).toBe(true);
  });
});
