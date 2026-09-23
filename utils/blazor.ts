import { Locator, Page, expect } from '@playwright/test';

/**
 * Two things about a Blazor Server screen that a test has to allow for, and
 * that nothing in Playwright allows for on its own.
 *
 * The first is that a field does not correct itself: the keystrokes go to the
 * server, the server decides what the value should be, and the corrected value
 * comes back over the circuit a round trip later. On this app the name field is
 * corrected on blur — three spaces stay three spaces until Tab, and clear about
 * a quarter of a second after it. Reading the field at a fixed instant after
 * typing is therefore a race with the network: it is won nearly every time and
 * lost when the server is busy, which is exactly the shape of a test that fails
 * once a fortnight for no reason anyone can reproduce.
 *
 * The second is that when the circuit drops, the page keeps its markup and
 * loses its behaviour. Fields still take text and nothing rewrites it — the age
 * box, whose letter filter runs in the browser, will quietly hold "ab" — so a
 * test driving a disconnected form does not fail on the disconnection. It fails
 * on the assertion, several steps later, having reported nothing about the
 * circuit at all.
 */

/**
 * The app's reconnect overlay.
 *
 * `<div id="reconnect-modal">` sits empty and hidden in the body while the
 * circuit is up; the app's JavaScript fills and shows it on a disconnection.
 */
export function reconnectOverlay(page: Page): Locator {
  return page.locator('#reconnect-modal');
}

/**
 * Waits until the circuit is up.
 *
 * Passes immediately on a page that has no such overlay, so it is safe to call
 * from any screen.
 */
export async function waitForCircuit(page: Page, timeout = 60_000) {
  await expect(
    reconnectOverlay(page),
    'the Blazor circuit is down — the page is showing its reconnect overlay',
  ).toBeHidden({ timeout });
}

/**
 * The value a field comes to rest on, rather than the one it happens to hold.
 *
 * Polls until the value has stopped changing for `quiet` — long enough that a
 * correction still in flight is waited for rather than read past — and gives up
 * at `timeout`, handing back whatever is there. Giving up quietly is deliberate:
 * the caller is usually asserting on the value, and "expected '', got '   '"
 * says more about the screen than a timeout would.
 */
export async function settledValue(
  field: Locator,
  { quiet = 1_200, timeout = 10_000 }: { quiet?: number; timeout?: number } = {},
): Promise<string> {
  const page = field.page();
  const deadline = Date.now() + timeout;

  let value = await field.inputValue();
  let unchangedSince = Date.now();

  for (;;) {
    if (Date.now() >= deadline) return value;
    await page.waitForTimeout(150);

    const now = await field.inputValue();
    if (now !== value) {
      value = now;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= quiet) {
      return value;
    }
  }
}
