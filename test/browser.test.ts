import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import type { FrameLocator } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { startHarness } from './harness.ts';
import { SECRET } from './fixture.ts';
import { BOARDING_MS, timeTo, crashPoint, COOLDOWN_MS } from '../src/rules.ts';

test(
  'two browser pilots share a flight, cash out manually and automatically, recover on reload and verify its record',
  { timeout: 60_000 },
  async t => {
    const host = await startHarness({ secret: SECRET, clock: () => 1_000_000 });
    t.after(() => host.close());
    const browser = await chromium.launch({ channel: 'chrome' });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    const alice = await context.newPage(),
      bob = await context.newPage(),
      errors: string[] = [];
    for (const page of [alice, bob]) page.on('pageerror', error => errors.push(error.message));
    // The second pilot's browser has no Web Audio: sound decorates the game, and it plays on without it.
    await bob.addInitScript('delete window.AudioContext');
    await Promise.all([alice.goto(host.url), bob.goto(host.url)]);
    const a = alice.frameLocator('iframe'),
      b = bob.frameLocator('iframe');
    /** A pilot's seat, and what its page says if the seat never comes. */
    const aboard = (pilot: FrameLocator) =>
      pilot
        .locator('#seat-indicator', { hasText: 'ABOARD' })
        .waitFor()
        .catch(async error => {
          const says = await Promise.all(['#status', '#action-label'].map(id => pilot.locator(id).textContent()));
          throw new Error(
            `${error.message}\nThe page says: ${says.join(' · ')}\nPage errors: ${errors.join('; ') || 'none'}`,
          );
        });
    await a.locator('#action:not([disabled])').waitFor();
    await b.locator('#action:not([disabled])').waitFor();
    await a.locator('#auto-enabled').uncheck();
    await a.locator('#action').click();
    await aboard(a);
    await b.locator('#action').click();
    await aboard(b);
    await a.locator('#crew-count', { hasText: /^2$/ }).waitFor();
    assert.equal(await a.locator('#flight-id').textContent(), await b.locator('#flight-id').textContent());
    await mkdir('test-results', { recursive: true });
    await alice.screenshot({ path: 'test-results/desktop.png' });
    await host.advance(BOARDING_MS + 500);
    await a.locator('#action[data-escape=true]:not([disabled])').waitFor();
    let releaseCashout!: () => void;
    const cashoutReply = new Promise<void>(resolve => {
      releaseCashout = resolve;
    });
    await alice.route('**/api/cashout?*', async route => {
      const response = await route.fetch();
      await cashoutReply;
      await route.fulfill({ response });
    });
    await a.locator('#action').click();
    await a.locator('#status', { hasText: /received in your wallet/ }).waitFor();
    releaseCashout();
    await a.locator('#action-label', { hasText: /^Escaped ✓$/ }).waitFor();
    assert.match((await a.locator('#status').textContent()) ?? '', /received in your wallet/);
    // The second page reloads while its preset is still active. The same saved bet and escape key are recovered.
    await bob.reload();
    await aboard(b);
    await host.advance(timeTo(200));
    await b.locator('#status', { hasText: /Escaped at 2.00×/ }).waitFor();
    await a.locator('#escaped-count', { hasText: /^2$/ }).waitFor();
    await host.advance(timeTo(crashPoint(SECRET)) + COOLDOWN_MS);
    await a.locator('#history button').first().waitFor();
    await a.locator('#history button').first().click();
    await a.locator('#proof-status[data-valid=true]').waitFor();
    assert.match((await a.locator('#proof-status').textContent()) ?? '', /Commitment matches/);
    await a.locator('#close-proof').click();
    // Keyboard focus and the mobile grid remain usable without horizontal scrolling.
    await alice.setViewportSize({ width: 390, height: 844 });
    const metrics = await a.locator('body').evaluate(body => ({ page: body.scrollWidth, viewport: window.innerWidth }));
    assert.ok(metrics.page <= metrics.viewport, `${metrics.page} overflows ${metrics.viewport}`);
    await alice.screenshot({ path: 'test-results/mobile.png' });
    assert.deepEqual(errors, []);
    assert.equal((await host.room.view()).history.length, 1);
  },
);
