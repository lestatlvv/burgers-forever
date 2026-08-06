// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * QA automation: customer places 1 burger + 1 drink, opens cart,
 * finishes purchase, then soaks 10s for freezes / unexpected resets.
 *
 * Prerequisite: Demo Store on http://127.0.0.1:5500 (python http.server).
 */
test('customer order (1 burger + 1 drink) stays stable 10s after finish', async ({
  page
}) => {
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // --- Home: start order as customer ---
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('a.startorderbtn')).toBeVisible();
  await page.locator('a.startorderbtn').click();
  await expect(page).toHaveURL(/products\.html/);

  // Wait for demo catalog to hydrate product cards
  await expect(page.locator('.productcontainer[data-kb-item]').first()).toBeVisible();

  // --- Add one burger (Classic) ---
  const burgerCard = page
    .locator('.productcontainer[data-kb-item]')
    .filter({ has: page.locator('.productnaam', { hasText: 'Classic' }) })
    .first();
  await expect(burgerCard).toBeVisible();
  await burgerCard.locator('input.add-to-basket-large, a.add-to-basket').first().click();

  // --- Add one drink (Kellerbier under Beer) ---
  const drinkCard = page
    .locator('.productcontainer[data-kb-item]')
    .filter({ has: page.locator('.productnaam', { hasText: 'Kellerbier' }) })
    .first();
  await expect(drinkCard).toBeVisible();
  await drinkCard.locator('input.add-to-basket-large, a.add-to-basket').first().click();

  await expect
    .poll(async () => {
      return page.evaluate(() =>
        window.DemoStore ? window.DemoStore.cartCount() : 0
      );
    })
    .toBe(2);

  const cart = await page.evaluate(() =>
    window.DemoStore.getCart().map((i) => ({ name: i.name, qty: i.qty }))
  );
  expect(cart).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'Classic', qty: 1 }),
      expect.objectContaining({ name: 'Kellerbier', qty: 1 })
    ])
  );

  // --- Open cart menu ---
  await page.locator('a.cart-button').click();
  const cartWrapper = page.locator('.w-commerce-commercecartcontainerwrapper');
  await expect(cartWrapper).toBeVisible();
  await expect(page.locator('.demo-cart-line')).toHaveCount(2);

  // --- Finish order ---
  await page.locator('a.checkoutbtn').click();
  await expect(page).toHaveURL(/thank-you\.html/, { timeout: 20_000 });
  await expect(page.locator('a.startorderbtn')).toBeVisible();

  // --- Stability soak: 10 seconds, no freeze / unexpected early reset ---
  const thankYouUrl = page.url();
  const start = Date.now();
  const samples = [];
  let prematureReset = null;

  while (Date.now() - start < 10_000) {
    const t0 = Date.now();
    let probe;
    try {
      probe = await Promise.race([
        page.evaluate(() => ({
          href: location.href,
          title: document.title,
          ready: document.readyState,
          visible: document.visibilityState,
          hasButton: !!document.querySelector('a.startorderbtn')
        })),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('main-thread-unresponsive')), 3_000)
        )
      ]);
    } catch (err) {
      throw new Error(
        `Application froze during post-order soak at ${Date.now() - start}ms: ${err.message}`
      );
    }
    const latencyMs = Date.now() - t0;
    samples.push({ atMs: Date.now() - start, latencyMs, href: probe.href });

    if (latencyMs > 2_500) {
      throw new Error(
        `Application appeared frozen (evaluate took ${latencyMs}ms) at ${Date.now() - start}ms`
      );
    }

    // Designed thank-you idle redirect is ~10s; anything earlier is an unexpected reset.
    if (!/thank-you\.html/i.test(probe.href) && Date.now() - start < 9_500) {
      prematureReset = {
        atMs: Date.now() - start,
        from: thankYouUrl,
        to: probe.href
      };
      break;
    }

    await page.waitForTimeout(250);
  }

  expect(
    prematureReset,
    prematureReset
      ? `Unexpected reset at ${prematureReset.atMs}ms: ${prematureReset.from} → ${prematureReset.to}`
      : ''
  ).toBeNull();

  // Page must still be interactive at end of soak (thank-you or designed idle home redirect).
  const finalState = await page.evaluate(() => ({
    href: location.href,
    ready: document.readyState,
    interactive: document.readyState === 'complete' || document.readyState === 'interactive'
  }));
  expect(finalState.interactive).toBe(true);
  expect(finalState.ready).not.toBe('loading');

  // Soft console check: ignore expected missing print-server / asset noise.
  const critical = consoleErrors.filter(
    (e) =>
      !/print|8989|favicon|Failed to load resource|testtoolapi|Start it:/i.test(
        e
      ) && !/net::ERR_/i.test(e)
  );
  expect(critical, `Unexpected page errors:\n${critical.join('\n')}`).toEqual([]);

  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        soakMs: Date.now() - start,
        samples: samples.length,
        maxProbeLatencyMs: Math.max(...samples.map((s) => s.latencyMs)),
        finalUrl: finalState.href
      },
      null,
      2
    )
  );
});
