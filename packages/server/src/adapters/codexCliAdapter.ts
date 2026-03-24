import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RuntimeAdapter, RuntimeEventSink } from '../runtime/adapter.js';
import type { ConversationRecord } from '../types.js';

export interface CodexSpawnProcess {
  (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }): ChildProcessWithoutNullStreams;
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface CodexHandle {
  process: ChildProcessWithoutNullStreams;
  nextId: number;
  initialized: boolean;
  threadId: string | null;
  lastTurnId: string | null;
  pendingRequestId: string | null;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>;
}

export type CodexParsedNotification =
  | { kind: 'state'; state: ConversationRecord['runtimeState']; detail?: string; threadId?: string }
  | { kind: 'delta'; content: string }
  | { kind: 'tool_call'; payload: Record<string, unknown> }
  | { kind: 'tool_output'; payload: Record<string, unknown> }
  | { kind: 'interactive'; payload: Record<string, unknown> }
  | { kind: 'approval'; payload: Record<string, unknown> }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

export function parseCodexNotification(message: Record<string, unknown>): CodexParsedNotification {
  const method = typeof message.method === 'string' ? message.method : '';

  if (method === 'thread/started') {
    const params = message.params as Record<string, unknown> | undefined;
    return {
      kind: 'state',
      state: 'idle',
      detail: 'Codex thread started',
      threadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
    };
  }

  if (method === 'turn/started') {
    return { kind: 'state', state: 'running', detail: 'Codex turn started' };
  }

  if (method === 'turn/completed') {
    return { kind: 'state', state: 'completed', detail: 'Codex turn completed' };
  }

  if (method === 'item/agentMessage/delta') {
    const params = message.params as Record<string, unknown> | undefined;
    const delta = typeof params?.delta === 'string' ? params.delta : '';
    return delta ? { kind: 'delta', content: delta } : { kind: 'ignore' };
  }

  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    const params = message.params as Record<string, unknown> | undefined;
    const delta = typeof params?.delta === 'string' ? params.delta : JSON.stringify(params ?? {});
    return { kind: 'delta', content: delta };
  }

  if (method === 'item/tool/call') {
    return { kind: 'tool_call', payload: (message.params as Record<string, unknown> | undefined) ?? {} };
  }

  if (method === 'item/mcpToolCall/progress' || method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
    return { kind: 'tool_output', payload: (message.params as Record<string, unknown> | undefined) ?? {} };
  }

  if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
    return { kind: 'interactive', payload: (message.params as Record<string, unknown> | undefined) ?? {} };
  }

  if (method === 'item/fileChange/requestApproval' || method === 'item/commandExecution/requestApproval') {
    return { kind: 'approval', payload: (message.params as Record<string, unknown> | undefined) ?? {} };
  }

  if (method.includes('error')) {
    return { kind: 'error', message: JSON.stringify(message) };
  }

  return { kind: 'delta', content: JSON.stringify(message) };
}

export function buildCodexTurnStartParams(conversation: ConversationRecord, content: string, threadId: string | null): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: 'text', text: content, text_elements: [] }],
    cwd: conversation.cwd ?? process.cwd(),
    approvalPolicy: null,
    approvalsReviewer: 'user',
    sandboxPolicy: null,
    model: null,
    serviceTier: null,
    effort: null,
    summary: 'none',
    personality: null,
    outputSchema: null,
    collaborationMode: null,
    attachments: [],
  };
}

export function buildCodexRewindSteps(
  conversation: ConversationRecord,
  threadId: string,
  payload: Record<string, unknown>,
): Array<{ method: string; params: Record<string, unknown> }> {
  const steps: Array<{ method: string; params: Record<string, unknown> }> = [
    { method: 'thread/rollback', params: { threadId, numTurns: 1 } },
  ];

  if (typeof payload.message === 'string' && payload.message.trim()) {
    steps.push({
      method: 'turn/start',
      params: buildCodexTurnStartParams(conversation, payload.message, threadId),
    });
  }

  return steps;
}

export class CodexCliAdapter implements RuntimeAdapter {
  public readonly backend = 'codex' as const;
  private readonly handles = new Map<string, CodexHandle>();

  public constructor(private readonly spawnProcess: CodexSpawnProcess = spawn) {}

  public async sendMessage(conversation: ConversationRecord, content: string, sink: RuntimeEventSink): Promise<void> {
    const handle = await this.ensureProcess(conversation, sink);
    if (!handle.threadId) {
      await this.startThread(conversation, handle);
    }

    sink.emitState(conversation.id, 'running');
    const response = await this.sendRpc(handle, 'turn/start', buildCodexTurnStartParams(conversation, content, handle.threadId));
    const result = response as { turn?: { id?: string }; output?: string; message?: string };
    handle.lastTurnId = result.turn?.id ?? handle.lastTurnId;
    const finalText = result.output ?? result.message ?? `Codex turn started for ${conversation.id}`;
    sink.emitFinal(conversation.id, finalText);
    sink.emitState(conversation.id, 'completed');
  }

  public async resume(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<void> {
    const handle = await this.ensureProcess(conversation, sink);
    try {
      const response = await this.sendRpc(handle, 'thread/resume', {
        threadId: conversation.id,
        history: null,
        path: null,
        model: null,
        modelProvider: null,
        serviceTier: null,
        cwd: conversation.cwd ?? process.cwd(),
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: {},
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        persistExtendedHistory: false,
      });
      const result = response as { thread?: { id?: string; threadId?: string } };
      handle.threadId = result.thread?.id ?? result.thread?.threadId ?? conversation.id;
      sink.emitState(conversation.id, 'idle', 'Codex runtime attached');
    } catch {
      await this.startThread(conversation, handle);
      sink.emitState(conversation.id, 'idle', 'Codex thread started');
    }
  }

  public async cancel(conversationId: string): Promise<void> {
    const handle = this.handles.get(conversationId);
    if (!handle || !handle.threadId || !handle.lastTurnId) {
      return;
    }
    await this.sendRpc(handle, 'turn/interrupt', { threadId: handle.threadId, turnId: handle.lastTurnId }).catch(() => undefined);
  }

  public async respond(conversationId: string, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void> {
    const handle = this.handles.get(conversationId);
    if (!handle || !handle.threadId) {
      throw new Error('Codex runtime is not attached');
    }

    const method = typeof payload.kind === 'string' && payload.kind === 'approval' ? 'approval/response' : 'response';
    await this.sendRpc(handle, method, {
      threadId: handle.threadId,
      requestId: handle.pendingRequestId,
      ...payload,
    }).catch(() => undefined);
    sink.emitState(conversationId, 'running', 'Interactive response sent to Codex');
  }

  public async rewind(conversation: ConversationRecord, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void> {
    const handle = await this.ensureProcess(conversation, sink);
    if (!handle.threadId) {
      await this.startThread(conversation, handle);
    }

    const steps = buildCodexRewindSteps(conversation, handle.threadId ?? conversation.id, payload);
    for (const step of steps) {
      await this.sendRpc(handle, step.method, step.params).catch(() => undefined);
    }
    sink.emitState(conversation.id, 'running', 'Codex rewind requested');
  }

  private async ensureProcess(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<CodexHandle> {
    const existing = this.handles.get(conversation.id);
    if (existing && !existing.process.killed) {
      return existing;
    }

    const executable = process.env.CODEX_APP_SERVER_EXECUTABLE ?? 'codex';
    const args = [process.env.CODEX_APP_SERVER_SUBCOMMAND ?? 'app-server', '--analytics-default-enabled'];
    const child = this.spawnProcess(executable, args, {
      cwd: conversation.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const handle: CodexHandle = {
      process: child,
      nextId: 2,
      initialized: false,
      threadId: null,
      lastTurnId: null,
      pendingRequestId: null,
      pending: new Map(),
    };
    this.handles.set(conversation.id, handle);

    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => this.handleLine(conversation.id, handle, line, sink));

    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line) => {
      if (line.trim()) {
        sink.emitError(conversation.id, line.trim());
      }
    });

    child.on('close', () => {
      sink.emitState(conversation.id, 'stopped', 'Codex runtime exited');
      this.handles.delete(conversation.id);
    });

    child.on('error', (error) => sink.emitError(conversation.id, error.message));

    await this.sendRpc(handle, 'initialize', {
      clientInfo: { name: 'agentmux-v2', title: 'AgentMux v2', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, 1);
    handle.initialized = true;
    return handle;
  }

  private async startThread(conversation: ConversationRecord, handle: CodexHandle): Promise<void> {
    const response = await this.sendRpc(handle, 'thread/start', {
      cwd: conversation.cwd ?? process.cwd(),
      model: null,
      modelProvider: null,
      serviceTier: null,
      approvalsReviewer: 'user',
      config: {},
      approvalPolicy: 'on-request',
      baseInstructions: null,
      developerInstructions: null,
      sandbox: 'workspace-write',
      personality: null,
      ephemeral: null,
      mockExperimentalField: null,
      experimentalRawEvents: false,
      dynamicTools: null,
      persistExtendedHistory: false,
    });

    const result = response as { thread?: { id?: string; threadId?: string } };
    handle.threadId = result.thread?.id ?? result.thread?.threadId ?? conversation.id;
  }

  private sendRpc(handle: CodexHandle, method: string, params: Record<string, unknown>, forcedId?: number): Promise<unknown> {
    const id = forcedId ?? handle.nextId++;
    const payload: JsonRpcRequest & { jsonrpc: '2.0' } = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      handle.pending.set(id, { resolve, reject });
      handle.process.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private handleLine(conversationId: string, handle: CodexHandle, line: string, sink: RuntimeEventSink): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const message = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof message.id === 'number') {
        const pending = handle.pending.get(message.id);
        if (pending) {
          handle.pending.delete(message.id);
          if ('error' in message && message.error) {
            pending.reject(new Error(JSON.stringify(message.error)));
          } else {
            pending.resolve(message.result);
          }
        }
        return;
      }

      const parsed = parseCodexNotification(message);
      switch (parsed.kind) {
        case 'state':
          if (parsed.threadId) {
            handle.threadId = parsed.threadId;
          }
          sink.emitState(conversationId, parsed.state, parsed.detail);
          return;
        case 'delta':
          sink.emitDelta(conversationId, parsed.content);
          return;
        case 'tool_call':
          sink.emitToolCall(conversationId, parsed.payload);
          return;
        case 'tool_output':
          sink.emitToolOutput(conversationId, parsed.payload);
          return;
        case 'interactive':
          handle.pendingRequestId = typeof parsed.payload.requestId === 'string' ? parsed.payload.requestId : handle.pendingRequestId;
          sink.emitInteractiveRequest(conversationId, parsed.payload);
          return;
        case 'approval':
          handle.pendingRequestId = typeof parsed.payload.requestId === 'string' ? parsed.payload.requestId : handle.pendingRequestId;
          sink.emitApprovalRequest(conversationId, parsed.payload);
          return;
        case 'error':
          sink.emitError(conversationId, parsed.message);
          return;
        case 'ignore':
          return;
      }
    } catch {
      sink.emitDelta(conversationId, trimmed);
    }
  }
}
