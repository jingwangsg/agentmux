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
  if (condition) { pass(label); passed++; } else { fail(label); failed++; }
}

async function preflight() {
  try { const res = await fetch(`${SERVER_URL}/health`); if (!res.ok) throw new Error(); } catch { console.error(`[smoke] ERROR: Backend not reachable at ${SERVER_URL}.`); process.exit(1); }
  try { const res = await fetch(WEB_URL); if (!res.ok) throw new Error(); } catch { console.error(`[smoke] ERROR: Frontend not reachable at ${WEB_URL}.`); process.exit(1); }
}

function launchEdge() {
  try { execSync(`lsof -ti:${DEBUG_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  log(`Launching Edge on port ${DEBUG_PORT}...`);
  const child = spawn(EDGE_PATH, [`--remote-debugging-port=${DEBUG_PORT}`, '--user-data-dir=/tmp/edge-smoke-test', '--no-first-run', '--no-default-browser-check', '--disable-default-apps', 'about:blank'], { stdio: 'ignore', detached: true });
  child.unref();
  return child;
}

async function backendTests() {
  log('--- Backend Tests ---');
  { const res = await fetch(`${SERVER_URL}/health`); const body = await res.json(); assert(res.status === 200 && body.ok === true, `GET /health → ${res.status}`); }
  { const res = await fetch(`${SERVER_URL}/api/conversations`); const body = await res.json(); assert(res.status === 200 && Array.isArray(body.conversations), `GET /api/conversations → ${res.status}`); }
  let conversationId: string | undefined;
  { const res = await fetch(`${SERVER_URL}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: 'claude' }) }); const body = await res.json(); conversationId = body.conversation?.id; assert(res.status === 201 && typeof conversationId === 'string', `POST create → ${res.status}`); }
  if (conversationId) { const res = await fetch(`${SERVER_URL}/api/conversations/${conversationId}`); assert(res.status === 200, `GET conv → ${res.status}`); }
  if (conversationId) { const res = await fetch(`${SERVER_URL}/api/conversations/${conversationId}/events`); const body = await res.json(); assert(res.status === 200 && Array.isArray(body.events), `GET events → ${res.status}`); }
}

async function frontendTests(browser: puppeteer.Browser) {
  log('--- Frontend Tests ---');
  const page = await browser.newPage();
  await page.goto(WEB_URL, { waitUntil: 'networkidle0', timeout: 15000 });

  const appShell = await page.$('.app-shell');
  assert(appShell !== null, 'Page loaded, .app-shell rendered');

  const titleText = await page.$eval('.sidebar-header h2', (el) => el.textContent);
  assert(titleText === 'AgentMux', `Sidebar title "${titleText}"`);

  try { await page.waitForSelector('.connection-badge.open', { timeout: 8000 }); assert(true, 'WebSocket connection: open'); }
  catch { assert(false, 'WebSocket connection not open'); }

  const buttons = await page.$$eval('.sidebar-actions button', (els) => els.map((el) => el.textContent));
  assert(buttons.some((b) => b?.includes('Codex')) && buttons.some((b) => b?.includes('Claude')), 'New conversation buttons present');

  const countBefore = await page.$$eval('.conversation-card', (els) => els.length);
  const claudeButtons = await page.$$('.sidebar-actions button');
  if (claudeButtons.length >= 2) {
    await claudeButtons[1].click();
    await sleep(1500);
    const countAfter = await page.$$eval('.conversation-card', (els) => els.length);
    assert(countAfter > countBefore, `Created Claude conv (${countBefore} → ${countAfter})`);
  }

  const textarea = await page.$('.composer textarea');
  assert(textarea !== null, 'Composer textarea present');

  if (textarea) {
    await textarea.type('Hello smoke test');
    const sendBtn = await page.$('.send-button');
    const isDisabled = await sendBtn?.evaluate((el) => (el as HTMLButtonElement).disabled);
    assert(isDisabled === false, 'Send button enabled after typing');
  }

  await page.close();
}

async function main() {
  await preflight();
  const edgeProcess = launchEdge();
  let browser: puppeteer.Browser | null = null;
  for (let attempt = 0; attempt < 10; attempt++) { await sleep(1000); try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` }); break; } catch {} }
  if (!browser) { console.error('[smoke] Cannot connect to Edge'); edgeProcess.kill(); process.exit(1); }
  log('Connected to Edge via CDP');
  try { await backendTests(); await frontendTests(browser); } catch (err) { console.error('[smoke] Error:', err); failed++; }
  finally { browser.disconnect(); try { execSync(`lsof -ti:${DEBUG_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {} }
  log(`--- Result: ${passed}/${passed + failed} passed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
