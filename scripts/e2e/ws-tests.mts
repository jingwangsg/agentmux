import { setTimeout as sleep } from 'node:timers/promises';
import { assert, log, SERVER_URL } from './helpers.mts';

export async function run() {
  log('--- WebSocket Tests ---');

  // Create a conversation via API
  const createRes = await fetch(`${SERVER_URL}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend: 'claude' }),
  });
  const { conversation } = await createRes.json() as { conversation: { id: string } };
  const conversationId = conversation.id;
  assert(typeof conversationId === 'string', `Created conversation for WS test`);

  // Connect WebSocket
  const ws = new WebSocket('ws://localhost:3001/ws');
  const messages: Array<{ type: string; [key: string]: unknown }> = [];

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS connect failed'));
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data as string) as { type: string };
    messages.push(data);
  };

  // Should receive server.ready
  await sleep(500);
  assert(messages.some((m) => m.type === 'server.ready'), 'Received server.ready');

  // Subscribe
  ws.send(JSON.stringify({ type: 'subscribe_conversation', conversationId }));
  await sleep(500);
  assert(messages.some((m) => m.type === 'conversation.snapshot'), 'Received conversation.snapshot on subscribe');

  // Send message via HTTP and verify events arrive via WS
  messages.length = 0;
  await fetch(`${SERVER_URL}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'ws test hello' }),
  });

  // Wait for events to stream through
  await sleep(5000);
  const hasConvEvent = messages.some((m) => m.type === 'conversation.event');
  assert(hasConvEvent, 'Received conversation.event via WS after HTTP message');

  // Unsubscribe
  ws.send(JSON.stringify({ type: 'unsubscribe_conversation', conversationId }));
  await sleep(500);
  const countBefore = messages.length;

  // Send another control via HTTP — should NOT produce WS events for us
  await fetch(`${SERVER_URL}/api/conversations/${conversationId}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cancel' }),
  });
  await sleep(1000);
  // After unsubscribe, we should get no new conversation.event messages
  const newEvents = messages.slice(countBefore).filter((m) => m.type === 'conversation.event');
  assert(newEvents.length === 0, 'No events received after unsubscribe');

  ws.close();
}
