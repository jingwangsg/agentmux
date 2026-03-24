import type { BackendType, Conversation, ConversationConfig, ConversationConfigCandidates, ConversationEvent } from './types';

const baseUrl = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';
const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001/ws';

export async function listConversations(): Promise<Conversation[]> {
  const response = await fetch(`${baseUrl}/api/conversations`);
  const data = await response.json();
  return data.conversations;
}

export async function createConversation(backend: BackendType): Promise<Conversation> {
  const response = await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend }),
  });
  const data = await response.json();
  return data.conversation;
}

export async function getConfigOptions(backend: BackendType): Promise<ConversationConfigCandidates> {
  const response = await fetch(`${baseUrl}/api/backends/${backend}/config-options`);
  return response.json();
}

export async function updateConversationConfig(conversationId: string, config: Partial<ConversationConfig>): Promise<Conversation> {
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  });
  const data = await response.json();
  return data.conversation;
}

export async function renameConversation(conversationId: string, title: string): Promise<Conversation> {
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
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

export async function rewindConversation(conversationId: string, payload: { message?: string; userMessageId?: string; dryRun?: boolean; fork?: boolean; rewindCode?: boolean }): Promise<void> {
  await fetch(`${baseUrl}/api/conversations/${conversationId}/rewind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function createSocket(): WebSocket {
  return new WebSocket(wsUrl);
}

export function createReconnectingSocket(
  onMessage: (data: unknown) => void,
  onStateChange: (state: 'connecting' | 'open' | 'closed') => void,
): { getSocket: () => WebSocket | null; send: (data: string) => void; close: () => void } {
  let socket: WebSocket | null = null;
  let retryDelay = 1000;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    onStateChange('connecting');
    socket = new WebSocket(wsUrl);

    socket.addEventListener('open', () => {
      retryDelay = 1000;
      onStateChange('open');
    });

    socket.addEventListener('message', (event) => {
      onMessage(JSON.parse(event.data));
    });

    socket.addEventListener('close', () => {
      socket = null;
      if (closed) return;
      onStateChange('closed');
      retryTimer = setTimeout(() => {
        retryDelay = Math.min(retryDelay * 2, 30_000);
        connect();
      }, retryDelay);
    });

    socket.addEventListener('error', () => {
      // close event will fire after this
    });
  }

  connect();

  return {
    getSocket: () => socket,
    send: (data: string) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    },
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
  };
}

export function sendInteractiveResponse(socket: WebSocket, conversationId: string, payload: Record<string, unknown>): void {
  socket.send(JSON.stringify({
    type: 'interactive_response',
    conversationId,
    payload,
  }));
}
