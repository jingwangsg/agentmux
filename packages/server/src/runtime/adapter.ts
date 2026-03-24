import type { BackendType, ConversationRecord } from '../types.js';

export interface RuntimeEventSink {
  emitDelta(conversationId: string, content: string): void;
  emitFinal(conversationId: string, content: string): void;
  emitState(conversationId: string, state: ConversationRecord['runtimeState'], detail?: string): void;
  emitInteractiveRequest(conversationId: string, payload: Record<string, unknown>): void;
  emitToolCall(conversationId: string, payload: Record<string, unknown>): void;
  emitToolOutput(conversationId: string, payload: Record<string, unknown>): void;
  emitToolResult(conversationId: string, payload: Record<string, unknown>): void;
  emitPlanMessage(conversationId: string, payload: Record<string, unknown>): void;
  emitCodexItem(conversationId: string, payload: Record<string, unknown>): void;
  emitCodexRequest(conversationId: string, payload: Record<string, unknown>): void;
  emitClaudeStep(conversationId: string, payload: Record<string, unknown>): void;
  emitApprovalRequest(conversationId: string, payload: Record<string, unknown>): void;
  emitPlanExitRequest(conversationId: string, payload: Record<string, unknown>): void;
  emitQuestionRequest(conversationId: string, payload: Record<string, unknown>): void;
  emitError(conversationId: string, message: string): void;
  emitResumeHandle(conversationId: string, handle: Record<string, unknown>): void;
  emitTitleUpdate(conversationId: string, title: string): void;
  emitTokenUsage(conversationId: string, payload: Record<string, unknown>): void;
  emitSubagentEvent(conversationId: string, payload: Record<string, unknown>): void;
  emitSubagentThreadStarted(conversationId: string, payload: Record<string, unknown>): void;
}

export interface RuntimeAdapter {
  readonly backend: BackendType;
  sendMessage(conversation: ConversationRecord, content: string, sink: RuntimeEventSink): Promise<void>;
  resume(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<void>;
  cancel(conversationId: string): Promise<void>;
  respond?(conversationId: string, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void>;
  rewind?(conversation: ConversationRecord, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void>;
}
