import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE_PATH = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const DEBUG_PORT = 9222;
const SERVER_URL = 'http://localhost:3001';
const WEB_URL = 'http://localhost:5173';

const log = (msg: string) => console.log(`[smoke] ${msg}`);
const pass = (msg: string) => console.log(`[smoke] \u2713 ${msg}`);
const fail = (msg: string) => console.log(`[smoke] \u2717 ${msg}`);

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    pass(label);
    passed++;
  } else {
    fail(label);
    failed++;
  }
}

// --- Pre-flight: check servers are running ---
async function preflight() {
  try {
    const res = await fetch(`${SERVER_URL}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch {
    console.error(`[smoke] ERROR: Backend not reachable at ${SERVER_URL}. Run "npm run dev" first.`);
    process.exit(1);
  }
  try {
    const res = await fetch(WEB_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch {
    console.error(`[smoke] ERROR: Frontend not reachable at ${WEB_URL}. Run "npm run dev" first.`);
    process.exit(1);
  }
}

// --- Launch Edge ---
function launchEdge() {
  // Kill any existing Edge debug instances on this port
  try {
    execSync(`lsof -ti:${DEBUG_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // ignore
  }

  log(`Launching Edge with remote debugging on port ${DEBUG_PORT}...`);
  const child = spawn(EDGE_PATH, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--user-data-dir=/tmp/edge-smoke-test',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    'about:blank',
  ], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

// --- Backend smoke tests ---
async function backendTests() {
  log('--- Backend Tests ---');

  // GET /health
  {
    const res = await fetch(`${SERVER_URL}/health`);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true, `GET /health → ${res.status}`);
  }

  // GET /api/conversations
  {
    const res = await fetch(`${SERVER_URL}/api/conversations`);
    const body = await res.json();
    assert(res.status === 200 && Array.isArray(body.conversations), `GET /api/conversations → ${res.status}`);
  }

  // POST /api/conversations (create claude conversation)
  let conversationId: string | undefined;
  {
    const res = await fetch(`${SERVER_URL}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'claude' }),
    });
    const body = await res.json();
    conversationId = body.conversation?.id;
    assert(res.status === 201 && typeof conversationId === 'string', `POST /api/conversations → ${res.status}`);
  }

  // GET /api/conversations/:id
  if (conversationId) {
    const res = await fetch(`${SERVER_URL}/api/conversations/${conversationId}`);
    assert(res.status === 200, `GET /api/conversations/${conversationId} → ${res.status}`);
  }

  // GET /api/conversations/:id/events
  if (conversationId) {
    const res = await fetch(`${SERVER_URL}/api/conversations/${conversationId}/events`);
    const body = await res.json();
    assert(res.status === 200 && Array.isArray(body.events), `GET /api/conversations/${conversationId}/events → ${res.status}`);
  }
}

// --- Frontend smoke tests ---
async function frontendTests(browser: puppeteer.Browser) {
  log('--- Frontend Tests ---');

  const page = await browser.newPage();
  await page.goto(WEB_URL, { waitUntil: 'networkidle0', timeout: 15000 });

  // .app-shell rendered
  const appShell = await page.$('.app-shell');
  assert(appShell !== null, 'Page loaded, .app-shell rendered');

  // Sidebar title
  const titleText = await page.$eval('.sidebar-header h1', (el) => el.textContent);
  assert(titleText === 'AgentMux v2', `Sidebar title "${titleText}" visible`);

  // WebSocket connection badge → wait for "open"
  try {
    await page.waitForSelector('.connection-badge.open', { timeout: 5000 });
    assert(true, 'WebSocket connection status: open');
  } catch {
    const badgeText = await page.$eval('.connection-badge', (el) => el.textContent).catch(() => 'N/A');
    assert(false, `WebSocket connection status: ${badgeText} (expected open)`);
  }

  // "New Codex" and "New Claude" buttons
  const buttons = await page.$$eval('.sidebar-actions button', (els) => els.map((el) => el.textContent));
  assert(
    buttons.some((b) => b?.includes('Codex')) && buttons.some((b) => b?.includes('Claude')),
    '"New Codex" and "New Claude" buttons present',
  );

  // Click "New Claude" → conversation appears in list
  const countBefore = await page.$$eval('.conversation-item', (els) => els.length);
  const newClaudeBtn = await page.$('.sidebar-actions button.secondary');
  if (newClaudeBtn) {
    await newClaudeBtn.click();
    await sleep(1500); // wait for API round-trip
    const countAfter = await page.$$eval('.conversation-item', (els) => els.length);
    assert(countAfter > countBefore, `Created new Claude conversation (${countBefore} → ${countAfter})`);
  } else {
    assert(false, 'Could not find "New Claude" button to click');
  }

  // Composer textarea present
  const textarea = await page.$('.composer textarea');
  assert(textarea !== null, 'Composer textarea present');

  // Type text → Send button enabled
  if (textarea) {
    await textarea.type('Hello smoke test');
    const sendBtn = await page.$('.composer button');
    const isDisabled = await sendBtn?.evaluate((el) => (el as HTMLButtonElement).disabled);
    assert(isDisabled === false, 'Send button enabled after typing');
  }

  await page.close();
}

// --- Main ---
async function main() {
  await preflight();

  const edgeProcess = launchEdge();

  // Wait for Edge CDP to be ready
  let browser: puppeteer.Browser | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(1000);
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
      });
      break;
    } catch {
      // retry
    }
  }

  if (!browser) {
    console.error('[smoke] ERROR: Could not connect to Edge CDP. Is Edge installed?');
    edgeProcess.kill();
    process.exit(1);
  }

  log('Connected to Edge via CDP');

  try {
    await backendTests();
    await frontendTests(browser);
  } catch (err) {
    console.error('[smoke] Unexpected error:', err);
    failed++;
  } finally {
    browser.disconnect();
    // Kill Edge process
    try {
      execSync(`lsof -ti:${DEBUG_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }

  log(`--- Result: ${passed}/${passed + failed} passed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
