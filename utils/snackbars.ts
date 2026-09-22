import { Page } from '@playwright/test';

/**
 * The app reports the outcome of a save only through a `.snackbar` that shows
 * and hides again within about a second — too briefly to catch by polling from
 * the test, and with nothing left behind on the page afterwards. These install
 * a recorder in the page and read it back.
 *
 * Every screen that posts anything needs this, which is why it lives here
 * rather than in one page object.
 */
type SnackbarWindow = Window & { __snackbars?: string[] };

export async function recordSnackbars(page: Page) {
  await page.evaluate(() => {
    const w = window as SnackbarWindow;
    w.__snackbars = [];
    const grab = () => {
      document.querySelectorAll('[class*="snackbar"]').forEach((el) => {
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
        if (text && !w.__snackbars!.includes(text)) w.__snackbars!.push(text);
      });
    };
    new MutationObserver(grab).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    window.setInterval(grab, 150);
  });
}

/** Everything `recordSnackbars` has seen since it was installed. */
export async function readSnackbars(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as SnackbarWindow).__snackbars ?? []);
}

/**
 * Waits for a recorded snackbar to match `expected`, then hands back everything
 * recorded so far.
 *
 * `readSnackbars` reports only what the recorder has already seen, so reading it
 * the instant an action returns catches nothing when the message is still coming
 * back over the circuit — the test reads "" while the failure screenshot shows
 * the snackbar plainly. Anything asserting on a particular message should wait
 * for it here instead.
 *
 * A message that never arrives is not thrown on: the wait simply ends and the
 * caller asserts on what it got, which keeps the failure reading as "expected
 * /already added/, got ''" rather than as a timeout with nothing to show.
 */
export async function waitForSnackbar(page: Page, expected: RegExp, timeout = 15_000): Promise<string[]> {
  const deadline = Date.now() + timeout;

  for (;;) {
    const seen = await readSnackbars(page);
    if (seen.some((m) => expected.test(m)) || Date.now() >= deadline) return seen;
    await page.waitForTimeout(250);
  }
}

/** Forgets what has been recorded, so the next action is read on its own. */
export async function clearSnackbars(page: Page) {
  await page.evaluate(() => {
    (window as SnackbarWindow).__snackbars = [];
  });
}
