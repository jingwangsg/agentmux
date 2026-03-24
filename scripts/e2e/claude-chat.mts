import type { Page } from 'puppeteer-core';
import { setTimeout as sleep } from 'node:timers/promises';
import { assert, log, waitFor, waitForText, countElements, getText } from './helpers.mts';

export async function run(page: Page) {
  log('--- Claude Chat E2E ---');

  // Click "+ Claude" to create conversation
  const countBefore = await countElements(page, '.conversation-card');
  const buttons = await page.$$('.sidebar-actions button');
  if (buttons.length >= 2) {
    await buttons[1].click();
  } else {
    assert(false, 'Could not find "+ Claude" button');
    return;
  }
  await sleep(2000);
  const countAfter = await countElements(page, '.conversation-card');
  assert(countAfter > countBefore, `Created Claude conversation (${countBefore} → ${countAfter})`);

  // Verify header shows CLAUDE
  const headerText = await getText(page, '.main-header-meta');
  assert(headerText?.includes('CLAUDE') ?? false, `Header shows CLAUDE backend`);

  // Type a message
  const textarea = await page.$('.composer textarea');
  assert(textarea !== null, 'Composer textarea present');
  if (!textarea) return;

  await textarea.click();
  await textarea.type('What is 2 plus 2? Answer with just the number.');

  // Click Send
  const sendBtn = await page.$('.send-button');
  if (sendBtn) {
    await sendBtn.click();
  } else {
    assert(false, 'Send button not found');
    return;
  }

  // Wait for user message to appear
  const hasUserMsg = await waitFor(page, '.msg-user', 5000);
  assert(hasUserMsg, 'User message appears in timeline');

  // Wait for assistant response
  log('Waiting for Claude response (up to 60s)...');
  const hasAssistant = await waitForText(page, '4', 60000);
  assert(hasAssistant, 'Claude response contains expected answer');

  // Check that we have at least one assistant message
  const assistantMsgs = await countElements(page, '.msg-assistant');
  assert(assistantMsgs >= 1, `Assistant messages: ${assistantMsgs}`);

  // Test model pill
  const modelPill = await page.$('.model-pill');
  if (modelPill) {
    await modelPill.click();
    await sleep(500);
    const popover = await page.$('.selector-popover');
    assert(popover !== null, 'Model selector popover opens');
    await page.click('.main-panel');
    await sleep(300);
  }
}
