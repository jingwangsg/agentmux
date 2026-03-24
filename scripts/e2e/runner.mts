import { setTimeout as sleep } from 'node:timers/promises';
import { preflight, launchEdge, connectBrowser, killEdge, log, getResults, WEB_URL } from './helpers.mts';
import { run as apiTests } from './api-tests.mts';
import { run as wsTests } from './ws-tests.mts';
import { run as uiTests } from './ui-tests.mts';
import { run as claudeChat } from './claude-chat.mts';
import { run as codexChat } from './codex-chat.mts';

async function main() {
  log('=== AgentMux v2 E2E Test Suite ===');

  await preflight();
  const edgeProcess = launchEdge();

  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    console.error('[e2e] ERROR: Could not connect to Edge CDP. Is Edge installed?');
    edgeProcess.kill();
    process.exit(1);
  }

  log('Connected to Edge via CDP');

  try {
    // Phase 1: API tests (no browser needed)
    await apiTests();

    // Phase 2: WebSocket tests (no browser needed)
    await wsTests();

    // Phase 3: UI tests (browser)
    const uiPage = await browser.newPage();
    await uiPage.goto(WEB_URL, { waitUntil: 'networkidle0', timeout: 15000 });
    await uiTests(uiPage);
    await uiPage.close();

    // Phase 4: Claude chat flow (browser)
    const claudePage = await browser.newPage();
    await claudePage.goto(WEB_URL, { waitUntil: 'networkidle0', timeout: 15000 });
    await sleep(1000); // wait for WS connect
    await claudeChat(claudePage);
    await claudePage.close();

    // Phase 5: Codex chat flow (browser)
    const codexPage = await browser.newPage();
    await codexPage.goto(WEB_URL, { waitUntil: 'networkidle0', timeout: 15000 });
    await sleep(1000);
    await codexChat(codexPage);
    await codexPage.close();

  } catch (err) {
    console.error('[e2e] Unexpected error:', err);
  } finally {
    browser.disconnect();
    killEdge();
  }

  const { passed, failed } = getResults();
  log(`=== Result: ${passed}/${passed + failed} passed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
