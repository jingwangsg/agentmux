import { nanoid } from 'nanoid';
import type { AgentMuxDatabase } from '../db/database.js';
import { getConversationConfigCandidates, normalizeConversationConfig } from './config.js';
import type {
  ControlInput,
  ConversationConfig,
  ConversationConfigCandidates,
  ConversationRecord,
  CreateConversationInput,
  StoredEvent,
} from '../types.js';
import type { RuntimeAdapter, RuntimeEventSink } from './adapter.js';

export class ConversationManager implements RuntimeEventSink {
  private readonly runtimeStates = new Map<string, { attached: boolean }>();

  public constructor(
    private readonly db: AgentMuxDatabase,
    private readonly adapters: Map<ConversationRecord['backend'], RuntimeAdapter>,
    private readonly onEvent: (event: StoredEvent) => void,
  ) {}

  public listConversations(): ConversationRecord[] {
    return this.db.listConversations();
  }

  public getConversation(id: string): ConversationRecord | null {
    return this.db.getConversation(id);
  }

  public getEvents(conversationId: string, cursor?: string): StoredEvent[] {
    return this.db.listEvents(conversationId, cursor);
  }

  public getConfigCandidates(backend: ConversationRecord['backend']): ConversationConfigCandidates {
    return getConversationConfigCandidates(backend);
  }

  public createConversation(input: CreateConversationInput): ConversationRecord {
    const now = new Date().toISOString();
    const conversation: ConversationRecord = {
      id: nanoid(),
      backend: input.backend,
      title: input.title?.trim() || `New ${input.backend === 'codex' ? 'Codex' : 'Claude'} Conversation`,
      runtimeState: 'idle',
      cwd: input.cwd ?? null,
      config: normalizeConversationConfig(input.backend, input.config),
      resumeHandle: { backend: input.backend },
      createdAt: now,
      updatedAt: now,
      lastRuntimeStartedAt: null,
      lastRuntimeStoppedAt: null,
    };

    this.db.createConversation(conversation);
    this.recordEvent({
      id: nanoid(),
      conversationId: conversation.id,
      type: 'conversation.created',
      payload: { conversation },
      createdAt: now,
    });
    return conversation;
  }

  public updateConversationConfig(conversationId: string, patch: Partial<ConversationConfig>): ConversationRecord {
    const conversation = this.requireConversation(conversationId);
    const now = new Date().toISOString();
    const updated: ConversationRecord = {
      ...conversation,
      config: normalizeConversationConfig(conversation.backend, {
        ...conversation.config,
        ...patch,
      }),
      updatedAt: now,
    };
    this.db.updateConversation(updated);
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'conversation.updated',
      payload: { action: 'config_updated', config: updated.config },
      createdAt: now,
    });
    return updated;
  }

  public async ensureRuntime(conversationId: string): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    const existing = this.runtimeStates.get(conversationId);
    if (existing?.attached) {
      return;
    }

    this.runtimeStates.set(conversationId, { attached: true });
    const adapter = this.adapters.get(conversation.backend);
    if (!adapter) {
      throw new Error(`No adapter for backend ${conversation.backend}`);
    }

    try {
      await adapter.resume(conversation, this);
    } catch (error) {
      this.setConversationState(conversationId, 'resume_failed');
      this.emitError(conversationId, error instanceof Error ? error.message : 'Resume failed');
    }
  }

  public async sendMessage(conversationId: string, content: string): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    await this.ensureRuntime(conversationId);

    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'message.user',
      payload: { content },
      createdAt: new Date().toISOString(),
    });

    const adapter = this.adapters.get(conversation.backend);
    if (!adapter) {
      throw new Error(`No adapter for backend ${conversation.backend}`);
    }

    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'run.started',
      payload: { content },
      createdAt: new Date().toISOString(),
    });

    this.setConversationState(conversationId, 'running', true);
    await adapter.sendMessage(this.requireConversation(conversationId), content, this);
  }

  public async control(conversationId: string, input: ControlInput): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    const adapter = this.adapters.get(conversation.backend);
    if (!adapter) {
      throw new Error(`No adapter for backend ${conversation.backend}`);
    }

    if (input.action === 'cancel') {
      await adapter.cancel(conversationId);
      this.recordEvent({
        id: nanoid(),
        conversationId,
        type: 'run.cancelled',
        payload: { by: 'user' },
        createdAt: new Date().toISOString(),
      });
      this.setConversationState(conversationId, 'stopped', false, true);
      return;
    }

    if (input.action === 'resume' || input.action === 'retry') {
      await this.ensureRuntime(conversationId);
    }
  }

  public async rewind(conversationId: string, payload: Record<string, unknown>): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    const adapter = this.adapters.get(conversation.backend);
    if (!adapter?.rewind) {
      throw new Error(`Rewind is not supported for backend ${conversation.backend}`);
    }

    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'conversation.updated',
      payload: { action: 'rewind_requested', rewind: payload },
      createdAt: new Date().toISOString(),
    });

    await adapter.rewind(conversation, payload, this);
  }

  public async respond(conversationId: string, payload: Record<string, unknown>): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    const adapter = this.adapters.get(conversation.backend);
    if (!adapter?.respond) {
      throw new Error(`Interactive responses are not supported for backend ${conversation.backend}`);
    }

    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'interactive.response',
      payload,
      createdAt: new Date().toISOString(),
    });
    await adapter.respond(conversationId, payload, this);
    this.setConversationState(conversationId, 'running');
  }

  public emitDelta(conversationId: string, content: string): void {
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'message.assistant.delta',
      payload: { content },
      createdAt: new Date().toISOString(),
    });
  }

  public emitFinal(conversationId: string, content: string): void {
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'message.assistant.final',
      payload: { content },
      createdAt: new Date().toISOString(),
    });
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'run.completed',
      payload: {},
      createdAt: new Date().toISOString(),
    });
  }

  public emitState(conversationId: string, state: ConversationRecord['runtimeState'], detail?: string): void {
    this.setConversationState(conversationId, state, state === 'running');
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'runtime.state',
      payload: { state, detail },
      createdAt: new Date().toISOString(),
    });
  }

  public emitInteractiveRequest(conversationId: string, payload: Record<string, unknown>): void {
    this.setConversationState(conversationId, 'waiting_input');
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'interactive.request',
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  public emitToolCall(conversationId: string, payload: Record<string, unknown>): void {
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'tool.call',
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  public emitToolOutput(conversationId: string, payload: Record<string, unknown>): void {
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'tool.output',
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  public emitApprovalRequest(conversationId: string, payload: Record<string, unknown>): void {
    this.setConversationState(conversationId, 'waiting_input');
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'approval.request',
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  public emitError(conversationId: string, message: string): void {
    this.setConversationState(conversationId, 'error');
    this.recordEvent({
      id: nanoid(),
      conversationId,
      type: 'error',
      payload: { message },
      createdAt: new Date().toISOString(),
    });
  }

  private setConversationState(
    conversationId: string,
    runtimeState: ConversationRecord['runtimeState'],
    started = false,
    stopped = false,
  ): void {
    const conversation = this.requireConversation(conversationId);
    const now = new Date().toISOString();
    const updated: ConversationRecord = {
      ...conversation,
      runtimeState,
      updatedAt: now,
      lastRuntimeStartedAt: started ? now : conversation.lastRuntimeStartedAt,
      lastRuntimeStoppedAt: stopped ? now : conversation.lastRuntimeStoppedAt,
    };
    this.db.updateConversation(updated);
  }

  private recordEvent(event: StoredEvent): void {
    this.db.appendEvent(event);
    this.onEvent(event);
  }

  private requireConversation(id: string): ConversationRecord {
    const conversation = this.db.getConversation(id);
    if (!conversation) {
      throw new Error(`Conversation not found: ${id}`);
    }
    return conversation;
  }
}
