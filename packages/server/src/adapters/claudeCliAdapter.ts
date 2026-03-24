import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RuntimeAdapter, RuntimeEventSink } from '../runtime/adapter.js';
import type { ConversationRecord } from '../types.js';

export interface ClaudeSpawnProcess {
  (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }): ChildProcessWithoutNullStreams;
}

interface ClaudeProcessHandle {
  process: ChildProcessWithoutNullStreams;
  ready: boolean;
  pendingRequests: Array<Record<string, unknown>>;
}

export type ClaudeParsedEvent =
  | { kind: 'final'; content: string }
  | { kind: 'delta'; content: string }
  | { kind: 'state'; state: ConversationRecord['runtimeState']; detail?: string }
  | { kind: 'tool_call'; payload: Record<string, unknown> }
  | { kind: 'tool_output'; payload: Record<string, unknown> }
  | { kind: 'approval'; payload: Record<string, unknown> }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

export function parseClaudeLine(line: string): ClaudeParsedEvent {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: 'ignore' };
  }

  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const type = typeof data.type === 'string' ? data.type : '';

    if (type === 'assistant' || type === 'message') {
      const message = data.message as Record<string, unknown> | undefined;
      const content = extractClaudeText(message?.content);
      return content ? { kind: 'final', content } : { kind: 'ignore' };
    }

    if (type === 'result') {
      const result = typeof data.result === 'string' ? data.result : '';
      return result ? { kind: 'final', content: result } : { kind: 'state', state: 'completed' };
    }

    if (type === 'error') {
      return { kind: 'error', message: String(data.error ?? 'Claude error') };
    }

    if (type === 'system') {
      return { kind: 'state', state: 'waiting_input', detail: String(data.subtype ?? 'system') };
    }

    if (type === 'tool_use') {
      return { kind: 'tool_call', payload: data };
    }

    if (type === 'tool_result') {
      return { kind: 'tool_output', payload: data };
    }

    if (type.includes('permission')) {
      return { kind: 'approval', payload: data };
    }

    const fallback = extractClaudeText(data.content);
    return fallback ? { kind: 'delta', content: fallback } : { kind: 'delta', content: trimmed };
  } catch {
    return { kind: 'delta', content: trimmed };
  }
}

export function extractClaudeText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
    return value.text;
  }
  return '';
}

export function buildClaudeRewindRequest(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'rewind_code',
    ...payload,
  };
}

export class ClaudeCliAdapter implements RuntimeAdapter {
  public readonly backend = 'claude' as const;
  private readonly handles = new Map<string, ClaudeProcessHandle>();

  public constructor(private readonly spawnProcess: ClaudeSpawnProcess = spawn) {}

  public async sendMessage(conversation: ConversationRecord, content: string, sink: RuntimeEventSink): Promise<void> {
    const handle = await this.ensureProcess(conversation, sink);
    sink.emitState(conversation.id, 'running');
    handle.process.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  }

  public async resume(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<void> {
    await this.ensureProcess(conversation, sink);
    sink.emitState(conversation.id, 'idle', 'Claude runtime attached');
  }

  public async cancel(conversationId: string): Promise<void> {
    const handle = this.handles.get(conversationId);
    if (!handle || handle.process.killed) {
      return;
    }
    handle.process.kill('SIGINT');
  }

  public async respond(conversationId: string, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void> {
    const handle = this.handles.get(conversationId);
    if (!handle) {
      throw new Error('Claude runtime is not attached');
    }
    handle.process.stdin.write(`${JSON.stringify({ type: 'user', message: payload })}\n`);
    sink.emitState(conversationId, 'running', 'Interactive response sent to Claude');
  }

  public async rewind(conversation: ConversationRecord, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void> {
    const handle = await this.ensureProcess(conversation, sink);
    handle.process.stdin.write(`${JSON.stringify(buildClaudeRewindRequest(payload))}\n`);
    sink.emitState(conversation.id, 'running', 'Claude rewind requested');
  }

  private async ensureProcess(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<ClaudeProcessHandle> {
    const existing = this.handles.get(conversation.id);
    if (existing && !existing.process.killed) {
      return existing;
    }

    const executable = process.env.CLAUDE_CODE_EXECUTABLE ?? 'claude';
    const args = ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
    if (conversation.cwd) {
      args.push('--add-dir', conversation.cwd);
    }

    const processHandle = this.spawnProcess(executable, args, {
      cwd: conversation.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const handle: ClaudeProcessHandle = {
      process: processHandle,
      ready: true,
      pendingRequests: [],
    };
    this.handles.set(conversation.id, handle);

    const stdout = createInterface({ input: processHandle.stdout });
    stdout.on('line', (line) => this.handleLine(conversation.id, line, sink));

    const stderr = createInterface({ input: processHandle.stderr });
    stderr.on('line', (line) => sink.emitError(conversation.id, line));

    processHandle.on('close', () => {
      sink.emitState(conversation.id, 'stopped', 'Claude runtime exited');
      this.handles.delete(conversation.id);
    });

    processHandle.on('error', (error) => sink.emitError(conversation.id, error.message));
    return handle;
  }

  private handleLine(conversationId: string, line: string, sink: RuntimeEventSink): void {
    const parsed = parseClaudeLine(line);
    switch (parsed.kind) {
      case 'final':
        sink.emitFinal(conversationId, parsed.content);
        return;
      case 'delta':
        sink.emitDelta(conversationId, parsed.content);
        return;
      case 'state':
        sink.emitState(conversationId, parsed.state, parsed.detail);
        return;
      case 'tool_call':
        sink.emitToolCall(conversationId, parsed.payload);
        return;
      case 'tool_output':
        sink.emitToolOutput(conversationId, parsed.payload);
        return;
      case 'approval':
        sink.emitApprovalRequest(conversationId, parsed.payload);
        return;
      case 'error':
        sink.emitError(conversationId, parsed.message);
        return;
      case 'ignore':
        return;
    }
  }
}
