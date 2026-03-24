import type { Conversation, ConversationEvent } from './types';

const baseUrl = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';
const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001/ws';

export async function listConversations(): Promise<Conversation[]> {
  const response = await fetch(`${baseUrl}/api/conversations`);
  const data = await response.json();
  return data.conversations;
}

export async function createConversation(backend: 'codex' | 'claude'): Promise<Conversation> {
  const response = await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend }),
  });
  const data = await response.json();
  return data.conversation;
}

export async function listEvents(conversationId: string): Promise<ConversationEvent[]> {
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/events`);
  const data = await response.json();
  return data.events;
}

export async function sendMessage(conversationId: string, content: string): Promise<void> {
  await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

export async function controlConversation(conversationId: string, action: 'cancel' | 'resume' | 'retry'): Promise<void> {
  await fetch(`${baseUrl}/api/conversations/${conversationId}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

export async function rewindConversation(conversationId: string, payload: { message?: string; userMessageId?: string; dryRun?: boolean }): Promise<void> {
  await fetch(`${baseUrl}/api/conversations/${conversationId}/rewind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function createSocket(): WebSocket {
  return new WebSocket(wsUrl);
}

export function sendInteractiveResponse(socket: WebSocket, conversationId: string, payload: Record<string, unknown>): void {
  socket.send(JSON.stringify({
    type: 'interactive_response',
    conversationId,
    payload,
  }));
}
