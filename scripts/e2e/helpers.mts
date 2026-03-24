import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export const EDGE_PATH = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
export const DEBUG_PORT = 9222;
export const SERVER_URL = 'http://localhost:3001';
export const WEB_URL = 'http://localhost:5173';

export const log = (msg: string) => console.log(`[e2e] ${msg}`);
export const pass = (msg: string) => console.log(`[e2e] \u2713 ${msg}`);
export const fail = (msg: string) => console.log(`[e2e] \u2717 ${msg}`);

let passCount = 0;
let failCount = 0;

export function assert(condition: boolean, label: string) {
  if (condition) {
    pass(label);
    passCount++;
  } else {
    fail(label);
    failCount++;
  }
}

export function getResults() {
  return { passed: passCount, failed: failCount };
}

export async function preflight() {
  try {
    const res = await fetch(`${SERVER_URL}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch {
    console.error(`[e2e] ERROR: Backend not reachable at ${SERVER_URL}. Run "npm run dev" first.`);
    process.exit(1);
  }
  try {
    const res = await fetch(WEB_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch {
    console.error(`[e2e] ERROR: Frontend not reachable at ${WEB_URL}. Run "npm run dev" first.`);
    process.exit(1);
  }
}

export function launchEdge() {
  try {
    execSync(`lsof -ti:${DEBUG_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // ignore
  }

  log(`Launching Edge with remote debugging on port ${DEBUG_PORT}...`);
  const child = spawn(EDGE_PATH, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--user-data-dir=/tmp/edge-e2e-test',
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

export async function connectBrowser(): Promise<Browser> {
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(1000);
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
    } catch {
      // retry
    }
  }
  throw new Error('Could not connect to Edge CDP');
}

export function killEdge() {
  try {
    execSync(`lsof -ti:${DEBUG_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

/** Wait for a selector, return the element or null on timeout */
export async function waitFor(page: Page, selector: string, timeout = 10000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

/** Wait for text content to appear anywhere in the page */
export async function waitForText(page: Page, text: string, timeout = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await page.evaluate((t) => document.body.innerText.includes(t), text);
    if (found) return true;
    await sleep(500);
  }
  return false;
}

/** Count elements matching a selector */
export async function countElements(page: Page, selector: string): Promise<number> {
  return page.$$eval(selector, (els) => els.length);
}

/** Get text content of first matching element */
export async function getText(page: Page, selector: string): Promise<string | null> {
  return page.$eval(selector, (el) => el.textContent).catch(() => null);
}
