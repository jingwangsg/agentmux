import { useEffect, useMemo, useRef, useState } from 'react';
import {
  controlConversation,
  createConversation,
  createSocket,
  listConversations,
  listEvents,
  rewindConversation,
  sendInteractiveResponse,
  sendMessage,
} from './lib/api';
import type { Conversation, ConversationEvent } from './lib/types';

type Theme = 'light' | 'dark' | 'dusk' | 'sand';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'dusk', label: 'Dusk' },
  { value: 'sand', label: 'Sand' },
];

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('agentmux-theme');
  if (stored && THEMES.some((t) => t.value === stored)) {
    return stored as Theme;
  }
  return 'light';
}

function ThemePicker({ current, onChange }: { current: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="theme-picker">
      <span className="theme-picker-label">Theme</span>
      {THEMES.map((t) => (
        <button
          key={t.value}
          className={`theme-swatch ${t.value === current ? 'active' : ''}`}
          data-theme-value={t.value}
          onClick={() => onChange(t.value)}
          title={t.label}
          aria-label={`Switch to ${t.label} theme`}
        />
      ))}
    </div>
  );
}

type UiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'status' | 'error' | 'tool' | 'request';
  content: string;
  event?: ConversationEvent;
  canRewind?: boolean;
};

function deriveMessages(events: ConversationEvent[]): UiMessage[] {
  const messages: UiMessage[] = [];
  let liveAssistant = '';
  let lastUserMessageId: string | null = null;

  for (const event of events) {
    if (event.type === 'message.user') {
      messages.push({ id: event.id, role: 'user', content: String(event.payload.content ?? ''), event });
      lastUserMessageId = event.id;
    }
    if (event.type === 'message.assistant.delta') {
      liveAssistant += String(event.payload.content ?? '');
    }
    if (event.type === 'message.assistant.final') {
      messages.push({ id: event.id, role: 'assistant', content: String(event.payload.content ?? liveAssistant), event });
      liveAssistant = '';
    }
    if (event.type === 'runtime.state') {
      messages.push({
        id: event.id,
        role: 'status',
        content: `State: ${String(event.payload.state ?? '')}${event.payload.detail ? ` — ${String(event.payload.detail)}` : ''}`,
        event,
      });
    }
    if (event.type === 'tool.call') {
      messages.push({ id: event.id, role: 'tool', content: `Tool call: ${JSON.stringify(event.payload)}`, event });
    }
    if (event.type === 'tool.output') {
      messages.push({ id: event.id, role: 'tool', content: `Tool output: ${JSON.stringify(event.payload)}`, event });
    }
    if (event.type === 'interactive.request' || event.type === 'approval.request') {
      messages.push({ id: event.id, role: 'request', content: `Action needed: ${JSON.stringify(event.payload)}`, event });
    }
    if (event.type === 'error') {
      messages.push({ id: event.id, role: 'error', content: String(event.payload.message ?? 'Unknown error'), event });
    }
  }

  if (liveAssistant) {
    messages.push({ id: 'live-assistant', role: 'assistant', content: liveAssistant });
  }

  return messages.map((message) => ({
    ...message,
    canRewind: message.role === 'user' && message.id === lastUserMessageId,
  }));
}

function EmptyState({ onCreate }: { onCreate: (backend: 'codex' | 'claude') => void }) {
  return (
    <div className="empty-state-shell">
      <div className="empty-state-card">
        <div className="empty-state-badge">AgentMux</div>
        <h3>No conversations yet</h3>
        <p>
          Create a Codex or Claude conversation to start. The server keeps conversations and agent runtimes alive
          independently from the browser UI.
        </p>
        <div className="empty-state-actions">
          <button onClick={() => onCreate('codex')}>New Codex</button>
          <button className="secondary" onClick={() => onCreate('claude')}>New Claude</button>
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="empty-state-shell">
      <div className="empty-state-card loading-card">
        <div className="skeleton skeleton-pill" />
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </div>
    </div>
  );
}

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('agentmux-theme', theme);
  }, [theme]);

  useEffect(() => {
    setIsLoadingConversations(true);
    void listConversations()
      .then((items) => {
        setConversations(items);
        setActiveId((current) => current ?? items[0]?.id ?? null);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'Failed to load conversations');
      })
      .finally(() => setIsLoadingConversations(false));
  }, []);

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;
    setConnectionStatus('connecting');

    socket.onopen = () => {
      setConnectionStatus('open');
      if (activeId) {
        socket.send(JSON.stringify({ type: 'subscribe_conversation', conversationId: activeId }));
        subscribedRef.current = activeId;
      }
    };

    socket.onmessage = (message) => {
      const data = JSON.parse(message.data) as { type: string; conversationId?: string; payload?: unknown };
      if (data.type === 'conversation.event' && data.conversationId === activeId) {
        setEvents((current) => [...current, data.payload as ConversationEvent]);
      }
      if (data.type === 'conversation.snapshot' && data.conversationId === activeId) {
        const payload = data.payload as { events: ConversationEvent[] };
        setEvents(payload.events);
      }
    };

    socket.onerror = () => {
      setConnectionStatus('closed');
    };

    socket.onclose = () => {
      setConnectionStatus('closed');
      subscribedRef.current = null;
    };

    return () => socket.close();
  }, [activeId]);

  useEffect(() => {
    if (!activeId) {
      setEvents([]);
      return;
    }

    setIsLoadingEvents(true);
    void listEvents(activeId)
      .then((items) => {
        setEvents(items);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'Failed to load conversation events');
      })
      .finally(() => setIsLoadingEvents(false));

    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      if (subscribedRef.current && subscribedRef.current !== activeId) {
        socket.send(JSON.stringify({ type: 'unsubscribe_conversation', conversationId: subscribedRef.current }));
      }
      socket.send(JSON.stringify({ type: 'subscribe_conversation', conversationId: activeId }));
      subscribedRef.current = activeId;
    }
  }, [activeId]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  );
  const messages = useMemo(() => deriveMessages(events), [events]);

  async function refreshConversations() {
    const refreshed = await listConversations();
    setConversations(refreshed);
  }

  async function handleCreate(backend: 'codex' | 'claude') {
    const conversation = await createConversation(backend);
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setSidebarOpen(false);
  }

  async function handleSend() {
    if (!activeId || !draft.trim()) {
      return;
    }
    const content = draft.trim();
    setDraft('');
    await sendMessage(activeId, content);
    await refreshConversations();
  }

  async function handleControl(action: 'cancel' | 'resume' | 'retry') {
    if (!activeId) {
      return;
    }
    await controlConversation(activeId, action);
    await refreshConversations();
  }

  async function handleRewind(message: UiMessage) {
    if (!activeId || !message.event) {
      return;
    }
    const nextMessage = window.prompt('Edit and rewind from this message:', message.content);
    if (nextMessage == null) {
      return;
    }
    await rewindConversation(activeId, {
      message: nextMessage,
      userMessageId: message.event.id,
    });
    await refreshConversations();
  }

  function handleRequestResponse(kind: 'approval' | 'input', decision: 'approve' | 'deny', event?: ConversationEvent) {
    if (!activeId || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN || !event) {
      return;
    }
    sendInteractiveResponse(socketRef.current, activeId, {
      kind,
      decision,
      requestId: event.payload.requestId ?? null,
      eventType: event.type,
    });
  }

  const showEmptyState = !isLoadingConversations && conversations.length === 0;

  return (
    <div className="app-shell agentmux-like-shell">
      <div
        className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div>
            <h1>AgentMux</h1>
            <p>Server-owned conversations</p>
            <div className="status-row">
              <span className={`connection-badge ${connectionStatus}`}>{connectionStatus}</span>
              {loadError ? <span className="error-inline">{loadError}</span> : null}
            </div>
          </div>
          <div className="sidebar-actions">
            <button onClick={() => void handleCreate('codex')}>New Codex</button>
            <button className="secondary" onClick={() => void handleCreate('claude')}>New Claude</button>
          </div>
        </div>

        <div className="conversation-list">
          {isLoadingConversations ? (
            <div className="sidebar-loading">Loading conversations…</div>
          ) : conversations.length === 0 ? (
            <div className="sidebar-empty">No conversations yet.</div>
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={`conversation-item ${conversation.id === activeId ? 'active' : ''}`}
                onClick={() => { setActiveId(conversation.id); setSidebarOpen(false); }}
              >
                <div className="conversation-title-row">
                  <span className={`backend-pill ${conversation.backend}`}>{conversation.backend}</span>
                  <span className={`state-pill ${conversation.runtimeState}`}>{conversation.runtimeState}</span>
                </div>
                <strong>{conversation.title}</strong>
                <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
              </button>
            ))
          )}
        </div>
        <ThemePicker current={theme} onChange={setTheme} />
      </aside>

      <main className="chat-pane">
        {isLoadingConversations ? (
          <LoadingState />
        ) : showEmptyState ? (
          <EmptyState onCreate={(backend) => void handleCreate(backend)} />
        ) : (
          <>
            <header className="chat-header">
              <button
                className="sidebar-toggle"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open sidebar"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 5h14M3 10h14M3 15h14" />
                </svg>
              </button>
              <div>
                <h2>{activeConversation?.title ?? 'No conversation selected'}</h2>
                <p>{activeConversation ? `${activeConversation.backend} · ${activeConversation.runtimeState}` : 'Create a conversation to begin'}</p>
              </div>
              <div className="control-row">
                <button disabled={!activeId} onClick={() => void handleControl('resume')}>Resume</button>
                <button disabled={!activeId} onClick={() => void handleControl('retry')}>Retry</button>
                <button disabled={!activeId} onClick={() => void handleControl('cancel')}>Cancel</button>
              </div>
            </header>

            <section className="messages">
              {isLoadingEvents ? <div className="messages-loading">Loading messages…</div> : null}
              {!isLoadingEvents && messages.length === 0 ? (
                <div className="messages-empty">No messages yet. Send the first message to this conversation.</div>
              ) : null}
              {messages.map((message) => (
                <article key={message.id} className={`message-card ${message.role}`}>
                  <div className="message-role">{message.role}</div>
                  <div className="message-content">{message.content}</div>
                  {message.canRewind ? (
                    <div className="message-actions">
                      <button onClick={() => void handleRewind(message)}>Rewind From Here</button>
                    </div>
                  ) : null}
                  {message.role === 'request' ? (
                    <div className="message-actions">
                      <button onClick={() => handleRequestResponse('approval', 'approve', message.event)}>Approve</button>
                      <button onClick={() => handleRequestResponse('approval', 'deny', message.event)}>Deny</button>
                    </div>
                  ) : null}
                </article>
              ))}
            </section>

            <footer className="composer">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Message the server-managed agent..."
              />
              <button disabled={!activeId || !draft.trim()} onClick={() => void handleSend()}>Send</button>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
