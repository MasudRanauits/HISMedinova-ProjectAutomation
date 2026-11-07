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
type SnackbarWindow = Window & {
  __snackbars?: string[];
  __snackbarRecorder?: boolean;
  __snackbarGrab?: () => void;
};

/**
 * The recorder, written to be installed anywhere and more than once.
 *
 * It has to survive a reload, because the app answers a dropped circuit with
 * one (see `reconnectOverlay` in utils/blazor.ts) — and a recorder that went
 * down with the old document does not report that it is gone. It reports that
 * the screen said nothing, which is indistinguishable from a screen that
 * really did say nothing and reads as a defect in the app.
 *
 * So: guarded, so installing twice leaves one observer rather than two, and
 * patient about `document.body`, because as an init script it runs before
 * there is one.
 */
const install = () => {
  const w = window as Window & {
    __snackbars?: string[];
    __snackbarRecorder?: boolean;
    __snackbarGrab?: () => void;
  };
  if (w.__snackbarRecorder) return;
  w.__snackbarRecorder = true;
  w.__snackbars = w.__snackbars ?? [];

  const grab = () => {
    document.querySelectorAll('[class*="snackbar"]').forEach((el) => {
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (text && !w.__snackbars!.includes(text)) w.__snackbars!.push(text);
    });
  };
  w.__snackbarGrab = grab;

  const watch = () => {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', watch, { once: true });
      return;
    }
    new MutationObserver(grab).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    window.setInterval(grab, 150);
  };
  watch();
};

/** The pages an init script has already been registered on. */
const registered = new WeakSet<Page>();

/**
 * Puts the recorder in if it is not already there.
 *
 * Registered as an init script as well as run on the document in hand, so that
 * a reload brings the recorder back with it.
 */
async function ensureRecorder(page: Page) {
  if (!registered.has(page)) {
    await page.addInitScript(install);
    registered.add(page);
  }
  await page.evaluate(install);
}

/** Starts recording, from nothing. */
export async function recordSnackbars(page: Page) {
  await ensureRecorder(page);
  await page.evaluate(() => {
    (window as SnackbarWindow).__snackbars = [];
  });
}

/**
 * Everything `recordSnackbars` has seen since it was installed.
 *
 * Sweeps the page once more before answering, so a message on screen at the
 * moment of the read is caught even if nothing has woken the observer, and
 * puts the recorder back if it finds it gone.
 */
export async function readSnackbars(page: Page): Promise<string[]> {
  const seen = await page.evaluate(() => {
    const w = window as SnackbarWindow;
    w.__snackbarGrab?.();
    return { alive: w.__snackbarRecorder === true, messages: w.__snackbars ?? [] };
  });

  if (!seen.alive) await page.evaluate(install);
  return seen.messages;
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
  await recordSnackbars(page);
}
