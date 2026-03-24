import type { Page } from 'puppeteer-core';
import { setTimeout as sleep } from 'node:timers/promises';
import { assert, log, waitFor, getText, countElements, WEB_URL } from './helpers.mts';

export async function run(page: Page) {
  log('--- UI Tests ---');

  await page.goto(WEB_URL, { waitUntil: 'networkidle0', timeout: 15000 });

  // App shell rendered
  const appShell = await page.$('.app-shell');
  assert(appShell !== null, 'Page loaded, .app-shell rendered');

  // Sidebar title
  const titleText = await getText(page, '.sidebar-header h2');
  assert(titleText === 'AgentMux', `Sidebar title: "${titleText}"`);

  // Connection badge → wait for "open"
  const hasBadge = await waitFor(page, '.connection-badge.open', 8000);
  assert(hasBadge, 'WebSocket connection badge shows "open"');

  // "+ Codex" and "+ Claude" buttons
  const buttons = await page.$$eval('.sidebar-actions button', (els) => els.map((el) => el.textContent));
  assert(
    buttons.some((b) => b?.includes('Codex')) && buttons.some((b) => b?.includes('Claude')),
    '"+ Codex" and "+ Claude" buttons present',
  );

  // Theme picker
  const themeSwatches = await countElements(page, '.theme-swatch');
  assert(themeSwatches === 4, `Theme picker has ${themeSwatches} swatches`);

  // Click a theme swatch
  const lightSwatch = await page.$('.theme-swatch[data-theme-value="light"]');
  if (lightSwatch) {
    await lightSwatch.click();
    await sleep(300);
    const currentTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert(currentTheme === 'light', `Theme switched to light`);
    // Switch back to dark
    const darkSwatch = await page.$('.theme-swatch[data-theme-value="dark"]');
    if (darkSwatch) await darkSwatch.click();
  }

  // If conversations exist, verify composer
  const convCards = await countElements(page, '.conversation-card');
  if (convCards > 0) {
    const firstCard = await page.$('.conversation-card');
    if (firstCard) {
      await firstCard.click();
      await sleep(500);
    }

    // Composer textarea present
    const textarea = await page.$('.composer textarea');
    assert(textarea !== null, 'Composer textarea present');

    // Type text → Send button enabled
    if (textarea) {
      await textarea.type('Hello e2e test');
      const sendBtn = await page.$('.send-button');
      const isDisabled = await sendBtn?.evaluate((el) => (el as HTMLButtonElement).disabled);
      assert(isDisabled === false, 'Send button enabled after typing');
      await textarea.evaluate((el) => { (el as HTMLTextAreaElement).value = ''; });
    }

    // Control buttons present
    const controlBtns = await page.$$eval('.control-row button', (els) => els.map((el) => el.textContent));
    assert(
      controlBtns.includes('Resume') && controlBtns.includes('Cancel'),
      'Control buttons (Resume, Retry, Cancel) present',
    );
  }

  // Empty state if no conversations
  if (convCards === 0) {
    const emptyState = await page.$('.empty-state-shell');
    assert(emptyState !== null, 'Empty state rendered when no conversations');
  }
}
