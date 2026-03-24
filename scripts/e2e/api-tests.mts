import { assert, log, SERVER_URL } from './helpers.mts';

export async function run() {
  log('--- API Tests ---');

  // GET /health
  {
    const res = await fetch(`${SERVER_URL}/health`);
    const body = await res.json() as { ok: boolean };
    assert(res.status === 200 && body.ok === true, `GET /health → 200`);
  }

  // GET /api/conversations
  {
    const res = await fetch(`${SERVER_URL}/api/conversations`);
    const body = await res.json() as { conversations: unknown[] };
    assert(res.status === 200 && Array.isArray(body.conversations), `GET /api/conversations → 200`);
  }

  // POST /api/conversations (create claude)
  let claudeId: string | undefined;
  {
    const res = await fetch(`${SERVER_URL}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'claude' }),
    });
    const body = await res.json() as { conversation?: { id: string } };
    claudeId = body.conversation?.id;
    assert(res.status === 201 && typeof claudeId === 'string', `POST create claude → 201`);
  }

  // POST /api/conversations (create codex)
  let codexId: string | undefined;
  {
    const res = await fetch(`${SERVER_URL}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'codex' }),
    });
    const body = await res.json() as { conversation?: { id: string } };
    codexId = body.conversation?.id;
    assert(res.status === 201 && typeof codexId === 'string', `POST create codex → 201`);
  }

  // GET /api/conversations/:id
  if (claudeId) {
    const res = await fetch(`${SERVER_URL}/api/conversations/${claudeId}`);
    const body = await res.json() as { conversation?: { backend: string } };
    assert(res.status === 200 && body.conversation?.backend === 'claude', `GET conversation → claude`);
  }

  // GET /api/conversations/:id/events
  if (claudeId) {
    const res = await fetch(`${SERVER_URL}/api/conversations/${claudeId}/events`);
    const body = await res.json() as { events: unknown[] };
    assert(res.status === 200 && Array.isArray(body.events), `GET events → 200`);
  }

  // GET /api/backends/:backend/config-options
  for (const backend of ['claude', 'codex']) {
    const res = await fetch(`${SERVER_URL}/api/backends/${backend}/config-options`);
    const body = await res.json() as { backend?: string; candidates?: Record<string, unknown> };
    assert(res.status === 200 && body.backend === backend, `GET config-options/${backend} → 200`);
  }

  // PATCH /api/conversations/:id/config
  if (claudeId) {
    const res = await fetch(`${SERVER_URL}/api/conversations/${claudeId}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { mode: 'plan' } }),
    });
    const body = await res.json() as { conversation?: { config: { mode: string } } };
    assert(res.status === 200 && body.conversation?.config.mode === 'plan', `PATCH config → mode=plan`);
  }

  // PATCH /api/conversations/:id (rename)
  if (claudeId) {
    const res = await fetch(`${SERVER_URL}/api/conversations/${claudeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'API Test Conv' }),
    });
    const body = await res.json() as { conversation?: { title: string } };
    assert(res.status === 200 && body.conversation?.title === 'API Test Conv', `PATCH rename → title updated`);
  }

  // 404 for missing conversation
  {
    const res = await fetch(`${SERVER_URL}/api/conversations/nonexistent`);
    assert(res.status === 404, `GET missing conversation → 404`);
  }

  // 400 for invalid payload
  {
    const res = await fetch(`${SERVER_URL}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'invalid' }),
    });
    assert(res.status === 400, `POST invalid backend → 400`);
  }
}
