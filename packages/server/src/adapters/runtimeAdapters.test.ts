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
    emitApprovalRequest: (...args) => void calls.push({ kind: 'approval', args }),
    emitError: (...args) => void calls.push({ kind: 'error', args }),
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
  lastRuntimeStartedAt: null,
  lastRuntimeStoppedAt: null,
};

function autoReplyJsonRpc(child: MockChildProcess): string[] {
  const writes: string[] = [];
  child.stdin.on('data', (chunk) => {
    const line = String(chunk);
    writes.push(line);
    for (const rawLine of line.split('\n').filter(Boolean)) {
      const message = JSON.parse(rawLine) as { id?: number; method?: string };
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
    expect(writes.some((line) => line.includes('"content":"hello"'))).toBe(true);
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
  });

  it('Claude adapter propagates stdout/stderr/close and cancel', async () => {
    const child = new MockChildProcess();
    const spawnMock = vi.fn(() => child as unknown as never);
    const adapter = new ClaudeCliAdapter(spawnMock as never);
    const { sink, calls } = createSink();

    await adapter.resume(conversation, sink);
    child.stdout.write(JSON.stringify({ type: 'tool_use', name: 'bash' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'permission_request', id: 'p1' }) + '\n');
    child.stderr.write('stderr boom\n');
    await adapter.cancel(conversation.id);
    child.emit('close');

    expect(calls.some((call) => call.kind === 'tool_call')).toBe(true);
    expect(calls.some((call) => call.kind === 'approval')).toBe(true);
    expect(calls.some((call) => call.kind === 'error' && String(call.args[1]).includes('stderr boom'))).toBe(true);
    expect(child.killed).toBe(true);
    expect(calls.some((call) => call.kind === 'state' && call.args[1] === 'stopped')).toBe(true);
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
    child.stdout.write(JSON.stringify({ method: 'item/tool/requestUserInput', params: { requestId: 'r1' } }) + '\n');
    child.stdout.write(JSON.stringify({ method: 'item/fileChange/requestApproval', params: { requestId: 'r2' } }) + '\n');
    child.stdout.write(JSON.stringify({ method: 'item/mcpToolCall/progress', params: { message: 'working' } }) + '\n');
    await adapter.cancel(conversation.id);
    child.emit('close');

    expect(calls.some((call) => call.kind === 'interactive')).toBe(true);
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
  });
});
