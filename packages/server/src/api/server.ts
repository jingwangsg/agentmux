import http from 'node:http';
import express from 'express';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import { createConversationSchema, controlSchema, messageSchema, rewindSchema, wsMessageSchema } from './schemas.js';
import type { ConversationManager } from '../runtime/manager.js';
import type { StoredEvent } from '../types.js';

export function createServer(conversationManager: ConversationManager) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/conversations', (_req, res) => {
    res.json({ conversations: conversationManager.listConversations() });
  });

  app.post('/api/conversations', (req, res) => {
    const parsed = createConversationSchema.parse(req.body);
    const conversation = conversationManager.createConversation(parsed);
    res.status(201).json({ conversation });
  });

  app.get('/api/conversations/:id', (req, res) => {
    const conversation = conversationManager.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ conversation });
  });

  app.get('/api/conversations/:id/events', (req, res) => {
    const conversation = conversationManager.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    res.json({ events: conversationManager.getEvents(req.params.id, cursor) });
  });

  app.post('/api/conversations/:id/messages', async (req, res, next) => {
    try {
      const parsed = messageSchema.parse(req.body);
      await conversationManager.sendMessage(req.params.id, parsed.content);
      res.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });


  app.post('/api/conversations/:id/rewind', async (req, res, next) => {
    try {
      const parsed = rewindSchema.parse(req.body);
      await conversationManager.rewind(req.params.id, parsed);
      res.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:id/control', async (req, res, next) => {
    try {
      const parsed = controlSchema.parse(req.body);
      await conversationManager.control(req.params.id, parsed);
      res.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const subscriptions = new Map<WebSocket, Set<string>>();

  wss.on('connection', (socket) => {
    subscriptions.set(socket, new Set());
    socket.send(JSON.stringify({ type: 'server.ready' }));

    socket.on('message', async (buffer) => {
      try {
        const message = wsMessageSchema.parse(JSON.parse(buffer.toString()));
        const conversationId = message.conversationId;
        const set = subscriptions.get(socket);
        if (!set) {
          return;
        }

        if (message.type === 'subscribe_conversation' && conversationId) {
          set.add(conversationId);
          const events = conversationManager.getEvents(conversationId);
          socket.send(JSON.stringify({ type: 'conversation.snapshot', conversationId, payload: { events } }));
          return;
        }

        if (message.type === 'unsubscribe_conversation' && conversationId) {
          set.delete(conversationId);
          return;
        }

        if (message.type === 'send_message' && conversationId) {
          const content = typeof message.payload?.content === 'string' ? message.payload.content : '';
          await conversationManager.sendMessage(conversationId, content);
          return;
        }

        if (message.type === 'control' && conversationId) {
          const action = message.payload?.action;
          if (action === 'cancel' || action === 'resume' || action === 'retry') {
            await conversationManager.control(conversationId, { action });
          }
          return;
        }

        if (message.type === 'interactive_response' && conversationId) {
          await conversationManager.respond(conversationId, message.payload ?? {});
          return;
        }
      } catch (error) {
        socket.send(JSON.stringify({ type: 'error', payload: { message: error instanceof Error ? error.message : 'Invalid WS message' } }));
      }
    });

    socket.on('close', () => {
      subscriptions.delete(socket);
    });
  });

  const broadcastEvent = (event: StoredEvent): void => {
    for (const [socket, ids] of subscriptions.entries()) {
      if (socket.readyState === socket.OPEN && ids.has(event.conversationId)) {
        socket.send(JSON.stringify({ type: 'conversation.event', conversationId: event.conversationId, payload: event }));
      }
    }
  };

  return { app, server, broadcastEvent };
}
