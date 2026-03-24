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

const RPC_TIMEOUT_MS = 30_000;

interface CodexHandle {
  process: ChildProcessWithoutNullStreams;
  nextId: number;
  initialized: boolean;
  threadId: string | null;
  lastTurnId: string | null;
  isRunning: boolean;
  pendingRequestId: string | null;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void; timer?: ReturnType<typeof setTimeout>; method: string }>;
}

export type CodexParsedNotification =
  | { kind: 'state'; state: ConversationRecord['runtimeState']; detail?: string; threadId?: string; turnId?: string }
  | { kind: 'delta'; content: string }
  | { kind: 'final'; content: string }
  | { kind: 'tool_call'; payload: Record<string, unknown> }
  | { kind: 'tool_output'; payload: Record<string, unknown> }
  | { kind: 'tool_result'; payload: Record<string, unknown> }
  | { kind: 'interactive'; payload: Record<string, unknown> }
  | { kind: 'approval'; payload: Record<string, unknown> }
  | { kind: 'plan'; payload: Record<string, unknown> }
  | { kind: 'title_updated'; title: string }
  | { kind: 'token_usage'; payload: Record<string, unknown> }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readTextCandidate(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(readTextCandidate).join('');
  }
  const record = asRecord(value);
  for (const key of ['text', 'delta', 'content', 'message', 'summary']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  if (Array.isArray(record.parts)) {
    return record.parts.map(readTextCandidate).join('');
  }
  return '';
}

function looksLikePlanPayload(params: Record<string, unknown>): boolean {
  const kind = typeof params.kind === 'string' ? params.kind : '';
  const subtype = typeof params.subtype === 'string' ? params.subtype : '';
  const text = readTextCandidate(params).toLowerCase();
  return kind.includes('plan') || subtype.includes('plan') || text.includes('permit to execute') || text.includes('plan mode');
}

function safeWrite(handle: CodexHandle, data: string): boolean {
  try {
    if (handle.process.killed || !handle.process.stdin.writable) {
      return false;
    }
    handle.process.stdin.write(data);
    return true;
  } catch {
    return false;
  }
}

export function parseCodexNotification(message: Record<string, unknown>): CodexParsedNotification {
  const method = typeof message.method === 'string' ? message.method : '';
  const params = asRecord(message.params);

  if (method === 'thread/started') {
    return {
      kind: 'state',
      state: 'idle',
      detail: 'Codex thread started',
      threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
    };
  }

  if (method === 'turn/started') {
    const turn = asRecord(params.turn);
    return { kind: 'state', state: 'running', detail: 'Codex turn started', turnId: typeof turn.id === 'string' ? turn.id : undefined };
  }

  if (method === 'turn/completed') {
    const resultText = readTextCandidate(params.result) || readTextCandidate(params.turn) || readTextCandidate(params);
    if (resultText.trim()) {
      return { kind: 'final', content: resultText.trim() };
    }
    return { kind: 'state', state: 'completed', detail: 'Codex turn completed' };
  }

  if (method === 'turn/failed') {
    return { kind: 'error', message: readTextCandidate(params) || 'Codex turn failed' };
  }

  if (method === 'turn/cancelled' || method === 'turn/interrupted') {
    return { kind: 'state', state: 'stopped', detail: 'Codex turn interrupted' };
  }

  if (method === 'item/agentMessage/delta' || method === 'item/assistantMessage/delta' || method === 'item/message/delta') {
    const delta = readTextCandidate(params);
    return delta ? { kind: 'delta', content: delta } : { kind: 'ignore' };
  }

  if (method === 'item/agentMessage/completed' || method === 'item/assistantMessage/completed' || method === 'item/message/completed') {
    const content = readTextCandidate(params);
    return content ? { kind: 'final', content } : { kind: 'ignore' };
  }

  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    const content = readTextCandidate(params);
    return looksLikePlanPayload(params) && content ? { kind: 'plan', payload: { ...params, content } } : { kind: 'ignore' };
  }

  if (method === 'item/reasoning/completed' || method === 'item/plan/completed') {
    const content = readTextCandidate(params);
    return content ? { kind: 'plan', payload: { ...params, content } } : { kind: 'ignore' };
  }

  if (method === 'item/tool/call' || method === 'item/mcpToolCall/started' || method === 'item/commandExecution/started' || method === 'item/fileChange/started') {
    return { kind: 'tool_call', payload: params };
  }

  if (method === 'item/mcpToolCall/progress' || method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta' || method === 'item/tool/outputDelta') {
    return { kind: 'tool_output', payload: params };
  }

  if (method === 'item/mcpToolCall/completed' || method === 'item/commandExecution/completed' || method === 'item/fileChange/completed' || method === 'item/tool/completed') {
    return { kind: 'tool_result', payload: params };
  }

  if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request' || method === 'item/requestUserInput') {
    return { kind: 'interactive', payload: params };
  }

  if (method === 'item/fileChange/requestApproval' || method === 'item/commandExecution/requestApproval' || method === 'approval/requested') {
    return { kind: 'approval', payload: params };
  }

  // Thread title update
  if (method === 'thread/name/updated') {
    const name = typeof params.threadName === 'string' ? params.threadName : typeof params.name === 'string' ? params.name : '';
    return name ? { kind: 'title_updated', title: name } : { kind: 'ignore' };
  }

  // Token usage
  if (method === 'thread/tokenUsage/updated') {
    return { kind: 'token_usage', payload: params };
  }

  if (looksLikePlanPayload(params)) {
    return { kind: 'plan', payload: params };
  }

  if (method.includes('error')) {
    return { kind: 'error', message: readTextCandidate(message.error) || readTextCandidate(params) || 'Codex runtime error' };
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

export function buildCodexTurnStartParams(conversation: ConversationRecord, content: string, threadId: string | null): Record<string, unknown> {
  const runtime = buildCodexRuntimeConfig(conversation);

  return {
    threadId,
    input: [{ type: 'text', text: content, text_elements: [] }],
    cwd: conversation.cwd ?? process.cwd(),
    approvalPolicy: runtime.approvalPolicy,
    approvalsReviewer: 'user',
    model: runtime.model,
    serviceTier: null,
    effort: runtime.effort,
    summary: 'none',
    personality: null,
    outputSchema: null,
    collaborationMode: runtime.collaborationMode,
    config: runtime.config,
  };
}

export function buildCodexRewindSteps(conversation: ConversationRecord, threadId: string, payload: Record<string, unknown>): Array<{ method: string; params: Record<string, unknown> }> {
  const steps: Array<{ method: string; params: Record<string, unknown> }> = [
    { method: 'thread/rollback', params: { threadId, numTurns: 1 } },
  ];
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (message) {
    steps.push({ method: 'turn/start', params: buildCodexTurnStartParams(conversation, message, threadId) });
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

    // If a turn is already running, use steer instead of starting a new turn
    if (handle.isRunning && handle.lastTurnId) {
      try {
        await this.sendRpc(handle, 'turn/steer', {
          threadId: handle.threadId,
          expectedTurnId: handle.lastTurnId,
          text: content,
        });
        return;
      } catch (error) {
        // Steer conflict: extract new turnId from error and retry once
        const errRecord = asRecord(error);
        const newTurnId = typeof errRecord.turnId === 'string' ? errRecord.turnId : null;
        if (newTurnId) {
          handle.lastTurnId = newTurnId;
          await this.sendRpc(handle, 'turn/steer', {
            threadId: handle.threadId,
            expectedTurnId: newTurnId,
            text: content,
          }).catch(() => undefined);
          return;
        }
        // Fall through to start a new turn if steer fails
      }
    }

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
      isRunning: false,
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
      if (/ignoring extra certs|npm-bundle|node_modules/i.test(trimmed)) {
        return;
      }
      if (/\b(error|failed|fatal|exception)\b/i.test(trimmed)) {
        sink.emitError(conversation.id, trimmed);
      }
    });

    child.on('close', (code) => {
      // Reject all pending RPCs
      for (const [id, pending] of handle.pending.entries()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error('Process exited'));
        handle.pending.delete(id);
      }
      const detail = code != null && code !== 0 ? `Codex runtime exited with code ${code}` : 'Codex runtime exited';
      sink.emitState(conversation.id, 'stopped', detail);
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
      summarizer: null,
    });

    const result = response as { thread?: { id?: string; threadId?: string } };
    handle.threadId = result.thread?.id ?? result.thread?.threadId ?? handle.threadId;
  }

  private handleLine(conversationId: string, handle: CodexHandle, line: string, sink: RuntimeEventSink): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      sink.emitDelta(conversationId, trimmed);
      return;
    }

    if (typeof payload.id === 'number') {
      const pending = handle.pending.get(payload.id);
      if (!pending) {
        return;
      }
      if (pending.timer) clearTimeout(pending.timer);
      handle.pending.delete(payload.id);
      if ('error' in payload) {
        const errPayload = payload.error;
        const errMsg = typeof errPayload === 'string'
          ? errPayload
          : typeof errPayload === 'object' && errPayload !== null && 'message' in (errPayload as Record<string, unknown>)
            ? String((errPayload as Record<string, unknown>).message)
            : JSON.stringify(errPayload);
        pending.reject(new Error(`RPC ${pending.method} failed: ${errMsg}`));
      } else {
        pending.resolve(payload.result ?? {});
      }
      return;
    }

    const parsed = parseCodexNotification(payload);
    switch (parsed.kind) {
      case 'state':
        if (parsed.threadId) {
          handle.threadId = parsed.threadId;
        }
        if (parsed.turnId) {
          handle.lastTurnId = parsed.turnId;
        }
        // Track running state for steer support
        if (parsed.state === 'running') {
          handle.isRunning = true;
        } else if (parsed.state === 'completed' || parsed.state === 'stopped' || parsed.state === 'error') {
          handle.isRunning = false;
        }
        sink.emitState(conversationId, parsed.state, parsed.detail);
        break;
      case 'delta':
        sink.emitDelta(conversationId, parsed.content);
        break;
      case 'final':
        handle.isRunning = false;
        sink.emitFinal(conversationId, parsed.content);
        break;
      case 'tool_call':
        sink.emitToolCall(conversationId, parsed.payload);
        sink.emitCodexItem(conversationId, { stage: 'started', itemType: 'tool', ...parsed.payload });
        break;
      case 'tool_output':
        sink.emitToolOutput(conversationId, parsed.payload);
        sink.emitCodexItem(conversationId, { stage: 'updated', itemType: 'tool', ...parsed.payload });
        break;
      case 'tool_result':
        sink.emitToolResult(conversationId, parsed.payload);
        sink.emitCodexItem(conversationId, { stage: 'completed', itemType: 'tool', ...parsed.payload });
        break;
      case 'interactive':
        handle.pendingRequestId = typeof parsed.payload.requestId === 'string' ? parsed.payload.requestId : handle.pendingRequestId;
        sink.emitInteractiveRequest(conversationId, parsed.payload);
        sink.emitCodexRequest(conversationId, { requestType: 'interactive', ...parsed.payload });
        break;
      case 'approval':
        handle.pendingRequestId = typeof parsed.payload.requestId === 'string' ? parsed.payload.requestId : handle.pendingRequestId;
        sink.emitApprovalRequest(conversationId, parsed.payload);
        sink.emitCodexRequest(conversationId, { requestType: 'approval', ...parsed.payload });
        break;
      case 'plan':
        sink.emitPlanMessage(conversationId, parsed.payload);
        sink.emitCodexItem(conversationId, { stage: 'completed', itemType: 'reasoning', ...parsed.payload });
        break;
      case 'title_updated':
        sink.emitTitleUpdate(conversationId, parsed.title);
        break;
      case 'token_usage':
        sink.emitTokenUsage(conversationId, parsed.payload);
        break;
      case 'error':
        handle.isRunning = false;
        sink.emitError(conversationId, parsed.message);
        break;
      case 'ignore':
        break;
    }
  }

  private sendRpc(handle: CodexHandle, method: string, params?: Record<string, unknown>, forcedId?: number): Promise<unknown> {
    const id = forcedId ?? handle.nextId++;
    const request: JsonRpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${RPC_TIMEOUT_MS}ms)`));
      }, RPC_TIMEOUT_MS);

      handle.pending.set(id, { resolve, reject, timer, method });

      if (!safeWrite(handle, `${JSON.stringify(request)}\n`)) {
        clearTimeout(timer);
        handle.pending.delete(id);
        reject(new Error(`Failed to write RPC to Codex process (stdin closed): ${method}`));
      }
    });
  }
}
