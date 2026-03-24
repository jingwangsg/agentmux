import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RuntimeAdapter, RuntimeEventSink } from '../runtime/adapter.js';
import { resolveConversationConfig } from '../runtime/config.js';
import type { ConversationRecord } from '../types.js';

export interface ClaudeSpawnProcess {
  (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }): ChildProcessWithoutNullStreams;
}

type ClaudePermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

interface ClaudeProcessHandle {
  process: ChildProcessWithoutNullStreams;
  ready: boolean;
  pendingRequestId: string | null;
  finalEmitted: boolean;
  permissionMode: ClaudePermissionMode;
}

export type ClaudeParsedEvent =
  | { kind: 'final'; content: string; sessionId?: string }
  | { kind: 'delta'; content: string }
  | { kind: 'state'; state: ConversationRecord['runtimeState']; detail?: string }
  | { kind: 'tool_call'; payload: Record<string, unknown> }
  | { kind: 'tool_output'; payload: Record<string, unknown> }
  | { kind: 'tool_result'; payload: Record<string, unknown> }
  | { kind: 'approval'; payload: Record<string, unknown> }
  | { kind: 'control_request'; subtype: string; requestId: string; payload: Record<string, unknown> }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

type ClaudeInteractiveKind = 'approval' | 'question' | 'plan_exit';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readTextCandidate(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(readTextCandidate).join('').trim();
  }
  const record = asRecord(value);
  for (const key of ['text', 'message', 'content', 'question', 'plan', 'prompt', 'description', 'result']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (Array.isArray(record.content)) {
    return readTextCandidate(record.content);
  }
  if (Array.isArray(record.parts)) {
    return readTextCandidate(record.parts);
  }
  return '';
}

function looksLikePlanText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('exit plan mode')
    || normalized.includes('approve this plan')
    || normalized.includes('permit to execute')
    || normalized.includes('leave plan mode')
    || normalized.includes('switch out of plan mode');
}

function normalizeClaudeToolName(payload: Record<string, unknown>): string {
  const raw = typeof payload.name === 'string'
    ? payload.name
    : typeof payload.tool_name === 'string'
      ? payload.tool_name
      : typeof payload.tool === 'string'
        ? payload.tool
        : '';
  return raw.trim();
}

export function normalizeClaudeRequestKind(subtype: string, payload: Record<string, unknown>): ClaudeInteractiveKind {
  if (subtype === 'can_use_tool') {
    const toolName = normalizeClaudeToolName(payload);
    if (toolName === 'ExitPlanMode') return 'plan_exit';
    if (toolName === 'AskUserQuestion') return 'question';
    return 'approval';
  }

  const requestKind = typeof payload.requestKind === 'string' ? payload.requestKind : '';
  if (requestKind === 'approval' || requestKind === 'question' || requestKind === 'plan_exit') {
    return requestKind;
  }

  const text = readTextCandidate(payload);
  if (looksLikePlanText(text)) {
    return 'plan_exit';
  }
  return 'question';
}

export function normalizeClaudeInteractivePayload(subtype: string, requestId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const toolInput = asRecord(payload.tool_input ?? payload.input ?? payload.arguments);
  const toolName = normalizeClaudeToolName(payload);
  const requestKind = normalizeClaudeRequestKind(subtype, payload);
  const message = readTextCandidate(toolInput) || readTextCandidate(payload);
  return {
    ...payload,
    requestId,
    requestKind,
    toolName,
    toolInput,
    message,
  };
}

export function extractClaudeSubagentPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const toolName = normalizeClaudeToolName(payload);
  if (!toolName || !['Task', 'Agent', 'spawn_agent', 'spawnAgent'].includes(toolName)) {
    return null;
  }

  const input = asRecord(payload.input ?? payload.tool_input ?? payload.arguments);
  const agents = Array.isArray(input.agents) ? input.agents : [];
  const receiverThreadIds = agents
    .map((agent) => asRecord(agent))
    .map((agent) => agent.thread_id)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  return {
    tool: 'spawnAgent',
    status: 'inProgress',
    prompt: typeof input.prompt === 'string' ? input.prompt : readTextCandidate(input),
    description: typeof input.description === 'string' ? input.description : toolName,
    model: typeof input.model === 'string' ? input.model : null,
    agentRole: typeof input.role === 'string' ? input.role : null,
    agentNickname: typeof input.name === 'string' ? input.name : null,
    receiverThreadIds,
    rawToolName: toolName,
    input,
  };
}

export function extractClaudeSubagentResultPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const toolName = normalizeClaudeToolName(payload);
  if (!toolName || !['Task', 'Agent', 'spawn_agent', 'spawnAgent'].includes(toolName)) {
    return null;
  }

  const result = asRecord(payload.result ?? payload.output ?? payload.content);
  const receiverThreadIds = Array.isArray(result.receiverThreadIds)
    ? result.receiverThreadIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];

  return {
    tool: 'spawnAgent',
    status: typeof result.status === 'string' ? result.status : 'completed',
    prompt: readTextCandidate(result) || readTextCandidate(payload),
    description: typeof result.description === 'string' ? result.description : toolName,
    receiverThreadIds,
    rawToolName: toolName,
    output: result,
  };
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
        return extractClaudeText(item);
      })
      .join('')
      .trim();
  }
  if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
    return value.text;
  }
  return '';
}

function safeWrite(handle: ClaudeProcessHandle, data: string): boolean {
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

export function parseClaudeLine(line: string): ClaudeParsedEvent {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: 'ignore' };
  }

  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const type = typeof data.type === 'string' ? data.type : '';
    const message = asRecord(data.message);
    const content = extractClaudeText(data.content) || extractClaudeText(message.content) || extractClaudeText(data.result);

    // Keep-alive: ignore
    if (type === 'keep_alive' || type === 'keepalive') {
      return { kind: 'ignore' };
    }

    // Control request from CLI (tool permissions, elicitation, hooks, MCP)
    if (type === 'control_request') {
      const subtype = typeof data.subtype === 'string' ? data.subtype : '';
      const requestId = typeof data.request_id === 'string' ? data.request_id : '';
      return { kind: 'control_request', subtype, requestId, payload: data };
    }

    if (type === 'assistant' || type === 'message') {
      return content ? { kind: 'final', content } : { kind: 'ignore' };
    }

    if (type === 'assistant_delta' || type === 'message_delta' || type === 'delta') {
      return content ? { kind: 'delta', content } : { kind: 'ignore' };
    }

    if (type === 'result') {
      const sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;
      return content
        ? { kind: 'final', content, sessionId }
        : { kind: 'state', state: 'completed' };
    }

    if (type === 'error') {
      return { kind: 'error', message: String(data.error ?? content ?? 'Claude error') };
    }

    if (type === 'system') {
      return { kind: 'ignore' };
    }

    if (type === 'tool_use') {
      return { kind: 'tool_call', payload: data };
    }

    if (type === 'tool_result') {
      return { kind: 'tool_result', payload: data };
    }

    if (type.includes('permission')) {
      return { kind: 'approval', payload: data };
    }

    return content ? { kind: 'delta', content } : { kind: 'ignore' };
  } catch {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return { kind: 'ignore' };
    }
    return { kind: 'delta', content: trimmed };
  }
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
    handle.finalEmitted = false;
    sink.emitState(conversation.id, 'running');
    const msg = {
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: content }] },
      parent_tool_use_id: null,
    };
    if (!safeWrite(handle, `${JSON.stringify(msg)}\n`)) {
      sink.emitError(conversation.id, 'Failed to write to Claude process (stdin closed)');
    }
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
    // Try graceful interrupt via stdin first
    safeWrite(handle, `${JSON.stringify({ type: 'control_request', subtype: 'interrupt' })}\n`);
    // Fallback to SIGINT after a short delay
    setTimeout(() => {
      if (!handle.process.killed) {
        handle.process.kill('SIGINT');
      }
    }, 500);
  }

  public async respond(conversationId: string, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void> {
    const handle = this.handles.get(conversationId);
    if (!handle) {
      throw new Error('Claude runtime is not attached');
    }

    const requestId = handle.pendingRequestId;
    const action = typeof payload.action === 'string' ? payload.action : 'approve';
    const requestKind = typeof payload.requestKind === 'string' ? payload.requestKind : 'approval';

    let responseBody: Record<string, unknown>;

    if (requestKind === 'plan_exit') {
      if (action === 'deny') {
        responseBody = { behavior: 'deny', message: 'User chose to stay in plan mode and continue planning' };
      } else {
        responseBody = { behavior: 'allow' };
        handle.permissionMode = 'acceptEdits';
      }
    } else if (requestKind === 'question') {
      const userAnswer = typeof payload.userAnswer === 'string' ? payload.userAnswer : '';
      const originalQuestion = typeof payload.originalQuestion === 'string' ? payload.originalQuestion : '';
      responseBody = {
        behavior: 'allow',
        updatedInput: {
          ...(originalQuestion ? { question: originalQuestion } : {}),
          answer: userAnswer,
        },
      };
    } else {
      responseBody = { behavior: action === 'deny' ? 'deny' : 'allow' };
    }

    const controlResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId ?? '',
        response: responseBody,
      },
    };

    if (!safeWrite(handle, `${JSON.stringify(controlResponse)}\n`)) {
      sink.emitError(conversationId, 'Failed to write response to Claude process');
      return;
    }
    handle.pendingRequestId = null;
    sink.emitState(conversationId, 'running', 'Interactive response sent to Claude');
  }

  public async rewind(conversation: ConversationRecord, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void> {
    const handle = await this.ensureProcess(conversation, sink);
    if (!safeWrite(handle, `${JSON.stringify(buildClaudeRewindRequest(payload))}\n`)) {
      sink.emitError(conversation.id, 'Failed to write rewind request to Claude process');
      return;
    }
    sink.emitState(conversation.id, 'running', 'Claude rewind requested');
  }

  private async ensureProcess(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<ClaudeProcessHandle> {
    const existing = this.handles.get(conversation.id);
    if (existing && !existing.process.killed) {
      return existing;
    }

    const executable = process.env.CLAUDE_APP_SERVER_EXECUTABLE ?? 'claude';
    const args = [
      process.env.CLAUDE_APP_SERVER_SUBCOMMAND ?? 'chat',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];

    // Reasoning effort → --thinking flag
    const resolved = resolveConversationConfig('claude', conversation.config);
    if (resolved.reasoningEffort === 'low') {
      args.push('--thinking', 'disabled');
    } else {
      args.push('--thinking', 'adaptive');
    }

    // Model
    if (typeof conversation.config.model === 'string' && conversation.config.model && conversation.config.model !== 'default') {
      args.push('--model', conversation.config.model);
    }

    // Permission mode from conversation config.mode
    const configuredMode = typeof conversation.config.mode === 'string' ? conversation.config.mode : '';
    const permissionMode: ClaudePermissionMode = configuredMode === 'plan'
      ? 'plan'
      : configuredMode === 'acceptEdits'
        ? 'acceptEdits'
        : configuredMode === 'bypassPermissions'
          ? 'bypassPermissions'
          : 'default';

    if (permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode);
    }

    // Working directory
    if (conversation.cwd) {
      args.push('--add-dir', conversation.cwd);
    }

    // Session resume
    const sessionId = conversation.resumeHandle?.sessionId;
    if (typeof sessionId === 'string' && sessionId) {
      args.push('--resume', '--session-id', sessionId);
    }

    const processHandle = this.spawnProcess(executable, args, {
      cwd: conversation.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const handle: ClaudeProcessHandle = {
      process: processHandle,
      ready: true,
      pendingRequestId: null,
      finalEmitted: false,
      permissionMode,
    };
    this.handles.set(conversation.id, handle);

    const stdout = createInterface({ input: processHandle.stdout });
    stdout.on('line', (line) => this.handleLine(conversation.id, handle, line, sink));

    const stderr = createInterface({ input: processHandle.stderr });
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

    processHandle.on('close', (code) => {
      const detail = code != null && code !== 0 ? `Claude runtime exited with code ${code}` : 'Claude runtime exited';
      sink.emitState(conversation.id, 'stopped', detail);
      this.handles.delete(conversation.id);
    });

    processHandle.on('error', (error) => sink.emitError(conversation.id, error.message));
    return handle;
  }

  private handleLine(conversationId: string, handle: ClaudeProcessHandle, line: string, sink: RuntimeEventSink): void {
    const parsed = parseClaudeLine(line);
    switch (parsed.kind) {
      case 'final':
        // Only emit one final per turn — Claude CLI may send both 'assistant' and 'result' events
        if (!handle.finalEmitted) {
          handle.finalEmitted = true;
          sink.emitFinal(conversationId, parsed.content);
          sink.emitState(conversationId, 'completed', 'Claude response completed');
        }
        // Always persist session ID (it comes in the 'result' event)
        if (parsed.sessionId) {
          sink.emitResumeHandle(conversationId, { sessionId: parsed.sessionId });
        }
        break;
      case 'delta':
        sink.emitDelta(conversationId, parsed.content);
        break;
      case 'state':
        sink.emitState(conversationId, parsed.state, parsed.detail);
        break;
      case 'control_request':
        this.handleControlRequest(conversationId, handle, parsed, sink);
        break;
      case 'tool_call':
        sink.emitToolCall(conversationId, parsed.payload);
        sink.emitClaudeStep(conversationId, { stepType: 'tool_use', stage: 'started', ...parsed.payload });
        {
          const subagentPayload = extractClaudeSubagentPayload(parsed.payload);
          if (subagentPayload) {
            sink.emitSubagentEvent(conversationId, subagentPayload);
          }
        }
        break;
      case 'tool_output':
        sink.emitToolOutput(conversationId, parsed.payload);
        break;
      case 'tool_result':
        sink.emitToolResult(conversationId, parsed.payload);
        sink.emitClaudeStep(conversationId, { stepType: 'tool_result', stage: 'completed', ...parsed.payload });
        {
          const subagentPayload = extractClaudeSubagentResultPayload(parsed.payload);
          if (subagentPayload) {
            sink.emitSubagentEvent(conversationId, subagentPayload);
          }
        }
        break;
      case 'approval':
        handle.pendingRequestId = typeof parsed.payload.request_id === 'string' ? parsed.payload.request_id : handle.pendingRequestId;
        sink.emitApprovalRequest(conversationId, parsed.payload);
        break;
      case 'error':
        sink.emitError(conversationId, parsed.message);
        break;
      case 'ignore':
        break;
    }
  }

  private handleControlRequest(
    conversationId: string,
    handle: ClaudeProcessHandle,
    parsed: { subtype: string; requestId: string; payload: Record<string, unknown> },
    sink: RuntimeEventSink,
  ): void {
    handle.pendingRequestId = parsed.requestId;
    const normalizedPayload = normalizeClaudeInteractivePayload(parsed.subtype, parsed.requestId, parsed.payload);
    const requestKind = normalizedPayload.requestKind;

    switch (parsed.subtype) {
      case 'can_use_tool': {
        const toolName = typeof normalizedPayload.toolName === 'string' ? normalizedPayload.toolName : '';
        const toolInput = asRecord(normalizedPayload.toolInput);

        if (toolName === 'ExitPlanMode' && handle.permissionMode !== 'plan') {
          const autoResponse = {
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: parsed.requestId,
              response: { behavior: 'allow' },
            },
          };
          safeWrite(handle, `${JSON.stringify(autoResponse)}\n`);
          handle.pendingRequestId = null;
          break;
        }

        if (requestKind === 'plan_exit') {
          const planContent = typeof toolInput.plan === 'string'
            ? toolInput.plan
            : typeof toolInput.plan_content === 'string'
              ? toolInput.plan_content
              : readTextCandidate(toolInput) || readTextCandidate(parsed.payload);
          sink.emitPlanExitRequest(conversationId, {
            ...normalizedPayload,
            planContent,
          });
          sink.emitState(conversationId, 'waiting_input', 'Plan review: ExitPlanMode');
          break;
        }

        if (requestKind === 'question') {
          const questionText = typeof toolInput.question === 'string'
            ? toolInput.question
            : typeof toolInput.text === 'string'
              ? toolInput.text
              : readTextCandidate(toolInput) || readTextCandidate(parsed.payload);
          sink.emitQuestionRequest(conversationId, {
            ...normalizedPayload,
            questionText,
          });
          sink.emitState(conversationId, 'waiting_input', 'Question from Claude');
          break;
        }

        sink.emitApprovalRequest(conversationId, normalizedPayload);
        sink.emitState(conversationId, 'waiting_input', `Tool permission: ${toolName}`);
        break;
      }
      case 'elicitation': {
        if (requestKind === 'plan_exit') {
          sink.emitPlanExitRequest(conversationId, normalizedPayload);
        } else if (requestKind === 'question') {
          sink.emitQuestionRequest(conversationId, {
            ...normalizedPayload,
            questionText: normalizedPayload.message,
          });
        } else {
          sink.emitInteractiveRequest(conversationId, normalizedPayload);
        }
        sink.emitState(conversationId, 'waiting_input', 'Elicitation request');
        break;
      }
      case 'hook_callback':
      case 'mcp_message': {
        // Auto-respond — no VS Code hooks or managed MCP servers in our context
        const autoResponse = {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: parsed.requestId,
            response: parsed.subtype === 'hook_callback' ? {} : { mcp_response: { jsonrpc: '2.0', result: {}, id: 0 } },
          },
        };
        safeWrite(handle, `${JSON.stringify(autoResponse)}\n`);
        handle.pendingRequestId = null;
        break;
      }
      default: {
        // Unknown control request — auto-respond to not block the CLI
        const fallback = {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: parsed.requestId,
            response: {},
          },
        };
        safeWrite(handle, `${JSON.stringify(fallback)}\n`);
        handle.pendingRequestId = null;
        break;
      }
    }
  }
}
