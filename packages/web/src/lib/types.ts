export type BackendType = 'codex' | 'claude';

export type RuntimeState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'error'
  | 'stopped'
  | 'resume_failed';

export type EventType =
  | 'conversation.created'
  | 'conversation.updated'
  | 'runtime.state'
  | 'message.user'
  | 'message.assistant.delta'
  | 'message.assistant.final'
  | 'run.started'
  | 'run.completed'
  | 'run.cancelled'
  | 'interactive.request'
  | 'interactive.response'
  | 'tool.call'
  | 'tool.output'
  | 'tool.result'
  | 'plan.message'
  | 'codex.item'
  | 'codex.request'
  | 'claude.step'
  | 'approval.request'
  | 'token_usage'
  | 'error';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ConversationMode = 'default' | 'plan' | 'auto-accept';

export interface ConversationConfig {
  model?: string;
  reasoningEffort?: ReasoningEffort | string;
  mode?: ConversationMode | string;
  [key: string]: unknown;
}

export interface ConfigCandidate {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  badge?: string;
}

export interface ConversationConfigCandidates {
  backend: BackendType;
  defaults: Required<Pick<ConversationConfig, 'model' | 'reasoningEffort' | 'mode'>>;
  candidates: {
    model: ConfigCandidate[];
    reasoningEffort: ConfigCandidate[];
    mode: ConfigCandidate[];
  };
}

export interface ConversationRecord {
  id: string;
  backend: BackendType;
  title: string;
  runtimeState: RuntimeState;
  cwd: string | null;
  config: ConversationConfig;
  resumeHandle: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  lastRuntimeStartedAt: string | null;
  lastRuntimeStoppedAt: string | null;
}

export interface StoredEvent<T = Record<string, unknown>> {
  id: string;
  conversationId: string;
  type: EventType;
  payload: T;
  createdAt: string;
}

export interface ConversationDetails extends ConversationRecord {
  events: StoredEvent[];
}

export interface CreateConversationInput {
  backend: BackendType;
  title?: string;
  cwd?: string;
  config?: ConversationConfig;
}

export interface UpdateConversationConfigInput {
  config: Partial<ConversationConfig>;
}

export interface MessageInput {
  content: string;
}

export interface ControlInput {
  action: 'cancel' | 'resume' | 'retry';
}

export interface WsClientMessage {
  type: 'subscribe_conversation' | 'unsubscribe_conversation' | 'send_message' | 'control' | 'interactive_response';
  conversationId?: string;
  payload?: Record<string, unknown>;
}

export type Conversation = ConversationRecord;
export type ConversationEvent = StoredEvent;
