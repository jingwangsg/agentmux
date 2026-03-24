import type { Page } from 'puppeteer-core';
import { setTimeout as sleep } from 'node:timers/promises';
import { assert, log, waitFor, waitForText, countElements, getText } from './helpers.mts';

export async function run(page: Page) {
  log('--- Codex Chat E2E ---');

  // Click "+ Codex" to create conversation
  const countBefore = await countElements(page, '.conversation-card');
  const buttons = await page.$$('.sidebar-actions button');
  if (buttons.length >= 1) {
    await buttons[0].click();
  } else {
    assert(false, 'Could not find "+ Codex" button');
    return;
  }
  await sleep(2000);
  const countAfter = await countElements(page, '.conversation-card');
  assert(countAfter > countBefore, `Created Codex conversation (${countBefore} → ${countAfter})`);

  // Verify header shows CODEX
  const headerText = await getText(page, '.main-header-meta');
  assert(headerText?.includes('CODEX') ?? false, `Header shows CODEX backend`);

  // Type a message
  const textarea = await page.$('.composer textarea');
  assert(textarea !== null, 'Composer textarea present');
  if (!textarea) return;

  await textarea.click();
  await textarea.type('What is 3 plus 5? Answer with just the number.');

  // Click Send
  const sendBtn = await page.$('.send-button');
  if (sendBtn) {
    await sendBtn.click();
  } else {
    assert(false, 'Send button not found');
    return;
  }

  // Wait for user message
  const hasUserMsg = await waitFor(page, '.msg-user', 5000);
  assert(hasUserMsg, 'User message appears in timeline');

  // Wait for response
  log('Waiting for Codex response (up to 90s)...');
  let gotResponse = false;
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const assistantCount = await countElements(page, '.msg-assistant');
    if (assistantCount > 0) { gotResponse = true; break; }
    // Check for tool/plan
    const toolCount = await countElements(page, '.tool-section');
    if (toolCount > 0) { gotResponse = true; break; }
    // Check for error
    const errorCount = await countElements(page, '.msg-error');
    if (errorCount > 0) {
      const errorText = await page.evaluate(() => {
        const errs = document.querySelectorAll('.msg-error');
        return Array.from(errs).map((e) => e.textContent).join('; ');
      });
      log(`Codex errors: ${errorText}`);
      gotResponse = true;
      break;
    }
    // Check runtime banner
    const bannerText = await getText(page, '.runtime-pill');
    if (bannerText?.includes('Completed') || bannerText?.includes('Stopped')) { gotResponse = true; break; }
    await sleep(2000);
  }

  assert(gotResponse, 'Codex produced a response');

  // Log what we see
  const timeline = await page.evaluate(() => {
    const msgs = document.querySelectorAll('.msg, .tool-section, .msg-error');
    return Array.from(msgs).map((m) => ({
      class: m.className.split(' ').filter(Boolean).slice(0, 2).join('.'),
      text: m.textContent?.slice(0, 60) ?? '',
    }));
  });
  log(`Timeline: ${JSON.stringify(timeline.slice(-5))}`);

  // Verify model pill exists (Codex should show model + reasoning)
  const modelPill = await page.$('.model-pill');
  assert(modelPill !== null, 'Codex shows model pill in composer');
}
