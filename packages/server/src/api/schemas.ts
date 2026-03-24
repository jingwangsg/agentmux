import { z } from 'zod';

export const createConversationSchema = z.object({
  backend: z.enum(['codex', 'claude']),
  title: z.string().optional(),
  cwd: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});

export const updateConversationConfigSchema = z.object({
  config: z.object({
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
  }),
});

export const messageSchema = z.object({
  content: z.string().min(1),
});

export const controlSchema = z.object({
  action: z.enum(['cancel', 'resume', 'retry']),
});

export const rewindSchema = z.object({
  message: z.string().optional(),
  userMessageId: z.string().optional(),
  dryRun: z.boolean().optional(),
  fork: z.boolean().optional(),
  rewindCode: z.boolean().optional(),
});

export const wsMessageSchema = z.object({
  type: z.enum(['subscribe_conversation', 'unsubscribe_conversation', 'send_message', 'control', 'interactive_response']),
  conversationId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});
