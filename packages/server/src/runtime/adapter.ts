import type { BackendType, ConversationRecord } from '../types.js';

export interface RuntimeEventSink {
  emitDelta(conversationId: string, content: string): void;
  emitFinal(conversationId: string, content: string): void;
  emitState(conversationId: string, state: ConversationRecord['runtimeState'], detail?: string): void;
  emitInteractiveRequest(conversationId: string, payload: Record<string, unknown>): void;
  emitToolCall(conversationId: string, payload: Record<string, unknown>): void;
  emitToolOutput(conversationId: string, payload: Record<string, unknown>): void;
  emitApprovalRequest(conversationId: string, payload: Record<string, unknown>): void;
  emitError(conversationId: string, message: string): void;
}

export interface RuntimeAdapter {
  readonly backend: BackendType;
  sendMessage(conversation: ConversationRecord, content: string, sink: RuntimeEventSink): Promise<void>;
  resume(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<void>;
  cancel(conversationId: string): Promise<void>;
  respond?(conversationId: string, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void>;
  rewind?(conversation: ConversationRecord, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void>;
}
