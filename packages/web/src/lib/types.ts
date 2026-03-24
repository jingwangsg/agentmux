export type BackendType = 'codex' | 'claude';
export type RuntimeState = 'idle' | 'starting' | 'running' | 'waiting_input' | 'completed' | 'error' | 'stopped' | 'resume_failed';

export interface Conversation {
  id: string;
  backend: BackendType;
  title: string;
  runtimeState: RuntimeState;
  cwd: string | null;
  config: Record<string, unknown>;
  resumeHandle: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  lastRuntimeStartedAt: string | null;
  lastRuntimeStoppedAt: string | null;
}

export interface ConversationEvent {
  id: string;
  conversationId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
