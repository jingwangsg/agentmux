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
  pendingRequestId: string | null;
  finalEmitted: boolean;
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
  | { kind: 'plan'; payload: Record<string, unknown> }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

function looksLikePlanEvent(data: Record<string, unknown>, content: string): boolean {
  const type = typeof data.type === 'string' ? data.type : '';
  const subtype = typeof data.subtype === 'string' ? data.subtype : '';
  const lower = content.toLowerCase();
  return type.includes('plan') || subtype.includes('plan') || lower.includes('permit to execute') || lower.includes('plan mode');
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
      if (looksLikePlanEvent(data, content) && content) {
        return { kind: 'plan', payload: { ...data, content } };
      }
      return content ? { kind: 'final', content } : { kind: 'ignore' };
    }

    if (type === 'assistant_delta' || type === 'message_delta' || type === 'delta') {
      return content ? { kind: 'delta', content } : { kind: 'ignore' };
    }

    if (type === 'result') {
      const sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;
      if (looksLikePlanEvent(data, content) && content) {
        return { kind: 'plan', payload: { ...data, content } };
      }
      return content
        ? { kind: 'final', content, sessionId }
        : { kind: 'state', state: 'completed' };
    }

    if (type === 'error') {
      return { kind: 'error', message: String(data.error ?? content ?? 'Claude error') };
    }

    if (type === 'system') {
      if (looksLikePlanEvent(data, content) && content) {
        return { kind: 'plan', payload: { ...data, content } };
      }
      return { kind: 'state', state: 'waiting_input', detail: String(data.subtype ?? 'system') };
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

    if (looksLikePlanEvent(data, content) && content) {
      return { kind: 'plan', payload: { ...data, content } };
    }

    return content ? { kind: 'delta', content } : { kind: 'ignore' };
  } catch {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return { kind: 'ignore' };
    }
    return trimmed.toLowerCase().includes('permit to execute')
      ? { kind: 'plan', payload: { content: trimmed, raw: trimmed } }
      : { kind: 'delta', content: trimmed };
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
    const behavior = action === 'deny' ? 'deny' : 'allow';

    // Send as control_response matching the extension's protocol
    const controlResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId ?? '',
        response: { behavior, ...payload },
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
      '--thinking', 'adaptive',
    ];

    // Model
    if (typeof conversation.config.model === 'string' && conversation.config.model && conversation.config.model !== 'default') {
      args.push('--model', conversation.config.model);
    }

    // Permission mode from conversation config.mode
    const mode = typeof conversation.config.mode === 'string' ? conversation.config.mode : '';
    if (mode === 'plan') {
      args.push('--permission-mode', 'plan');
    } else if (mode === 'acceptEdits') {
      args.push('--permission-mode', 'acceptEdits');
    } else if (mode === 'bypassPermissions') {
      args.push('--permission-mode', 'bypassPermissions');
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
        break;
      case 'tool_output':
        sink.emitToolOutput(conversationId, parsed.payload);
        break;
      case 'tool_result':
        sink.emitToolResult(conversationId, parsed.payload);
        sink.emitClaudeStep(conversationId, { stepType: 'tool_result', stage: 'completed', ...parsed.payload });
        break;
      case 'approval':
        handle.pendingRequestId = typeof parsed.payload.request_id === 'string' ? parsed.payload.request_id : handle.pendingRequestId;
        sink.emitApprovalRequest(conversationId, parsed.payload);
        sink.emitClaudeStep(conversationId, { stepType: 'permit', stage: 'waiting', ...parsed.payload });
        break;
      case 'plan':
        sink.emitPlanMessage(conversationId, parsed.payload);
        sink.emitClaudeStep(conversationId, { stepType: 'plan', stage: 'completed', ...parsed.payload });
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

    switch (parsed.subtype) {
      case 'can_use_tool': {
        // Surface as approval request for the UI to approve/deny
        const toolName = typeof parsed.payload.tool_name === 'string' ? parsed.payload.tool_name : '';
        const toolInput = asRecord(parsed.payload.tool_input ?? parsed.payload.input);
        sink.emitApprovalRequest(conversationId, {
          requestId: parsed.requestId,
          toolName,
          toolInput,
          ...parsed.payload,
        });
        sink.emitClaudeStep(conversationId, {
          stepType: 'permit',
          stage: 'waiting',
          toolName,
          requestId: parsed.requestId,
        });
        sink.emitState(conversationId, 'waiting_input', `Tool permission: ${toolName}`);
        break;
      }
      case 'elicitation': {
        // Surface as interactive request for the UI
        sink.emitInteractiveRequest(conversationId, {
          requestId: parsed.requestId,
          ...parsed.payload,
        });
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
