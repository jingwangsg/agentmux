import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RuntimeAdapter, RuntimeEventSink } from '../runtime/adapter.js';
import type { ConversationRecord } from '../types.js';
import { resolveConversationConfig } from '../runtime/config.js';

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
    return { kind: 'ignore' };
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
    return { kind: 'error', message: typeof message.error === 'string' ? message.error : 'Codex runtime error' };
  }

  return { kind: 'ignore' };
}

function buildCodexRuntimeConfig(conversation: ConversationRecord): {
  approvalPolicy: string;
  sandbox: string;
  collaborationMode: string | null;
  model: string | null;
  effort: string | null;
  config: Record<string, unknown>;
} {
  const resolved = resolveConversationConfig('codex', conversation.config);
  const isAutoAccept = resolved.mode === 'auto-accept';
  return {
    approvalPolicy: isAutoAccept ? 'never' : 'on-request',
    sandbox: isAutoAccept ? 'danger-full-access' : 'workspace-write',
    collaborationMode: resolved.mode === 'plan' ? 'plan' : null,
    model: resolved.model || null,
    effort: resolved.reasoningEffort || null,
    config: {
      model: resolved.model || null,
      reasoning_effort: resolved.reasoningEffort || null,
      mode: resolved.mode || null,
    },
  };
}

function looksLikeStructuredOutput(line: string): boolean {
  return line.startsWith('{') || line.startsWith('[') || /^\w+[/:.-]+\s*[{[]/.test(line) || line.startsWith('DEBUG') || line.startsWith('INFO') || line.startsWith('TRACE');
}

function looksLikeReadableAssistantText(line: string): boolean {
  if (!line.trim()) {
    return false;
  }
  if (looksLikeStructuredOutput(line)) {
    return false;
  }
  return /[A-Za-z\u4e00-\u9fff]/.test(line);
}

export function buildCodexTurnStartParams(conversation: ConversationRecord, content: string, threadId: string | null): Record<string, unknown> {
  const runtime = buildCodexRuntimeConfig(conversation);

  return {
    threadId,
    input: [{ type: 'text', text: content, text_elements: [] }],
    cwd: conversation.cwd ?? process.cwd(),
    approvalPolicy: runtime.approvalPolicy,
    approvalsReviewer: 'user',
    sandboxPolicy: runtime.sandbox,
    model: runtime.model,
    serviceTier: null,
    effort: runtime.effort,
    summary: 'none',
    personality: null,
    outputSchema: null,
    collaborationMode: runtime.collaborationMode,
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
    const result = response as { turn?: { id?: string } };
    handle.lastTurnId = result.turn?.id ?? handle.lastTurnId;
  }

  public async resume(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<void> {
    const handle = await this.ensureProcess(conversation, sink);
    if (!handle.threadId) {
      await this.startThread(conversation, handle);
      sink.emitState(conversation.id, 'idle', 'Codex thread started');
      return;
    }

    try {
      const runtime = buildCodexRuntimeConfig(conversation);
      const response = await this.sendRpc(handle, 'thread/attach', {
        threadId: handle.threadId,
        cwd: conversation.cwd ?? process.cwd(),
        approvalPolicy: runtime.approvalPolicy,
        sandbox: runtime.sandbox,
        config: runtime.config,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        persistExtendedHistory: false,
      });
      const result = response as { thread?: { id?: string; threadId?: string } };
      handle.threadId = result.thread?.id ?? result.thread?.threadId ?? handle.threadId;
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
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      if (/\b(error|failed|fatal|exception)\b/i.test(trimmed)) {
        sink.emitError(conversation.id, trimmed);
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
    const runtime = buildCodexRuntimeConfig(conversation);
    const response = await this.sendRpc(handle, 'thread/start', {
      cwd: conversation.cwd ?? process.cwd(),
      model: runtime.model,
      modelProvider: null,
      serviceTier: null,
      approvalsReviewer: 'user',
      config: runtime.config,
      approvalPolicy: runtime.approvalPolicy,
      baseInstructions: null,
      developerInstructions: null,
      sandbox: runtime.sandbox,
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
      if (looksLikeReadableAssistantText(trimmed)) {
        sink.emitDelta(conversationId, trimmed);
        return;
      }
      if (!looksLikeStructuredOutput(trimmed)) {
        sink.emitToolOutput(conversationId, { message: trimmed, source: 'codex.stdout' });
      }
    }
  }
}
