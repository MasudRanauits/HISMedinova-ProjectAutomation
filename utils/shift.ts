import { BrowserContext, Page } from '@playwright/test';

/**
 * The shift change notice, and why it has to be dismissed from inside the page.
 *
 * The app runs the counter in shifts. When one ends it puts a modal over
 * whatever the operator was doing — "Shift-1 has ended. You have been moved to
 * Shift-2" — with a single OK button. It is correct behaviour and a person
 * clicks through it without thinking, but to a test it is an overlay that
 * arrives unannounced, takes the clicks meant for the form underneath, and
 * closes any suggestion list that happened to be open. Whichever test is
 * running when the shift turns over fails, and it fails on something that has
 * nothing to do with what it was checking: the run that prompted this was
 * TC-06, which failed on the test autocomplete going empty mid-pick.
 *
 * Nothing in the test can predict when that happens, so it is not something a
 * particular spec can guard against. The watcher below lives in the page for
 * the whole run and clicks OK the moment such a dialog shows up — the way the
 * snackbar recorder lives there (utils/snackbars).
 *
 * It is deliberately narrow: only a dialog that says a shift has changed is
 * touched. Every other modal the app raises is left alone, because tests assert
 * on those (see `ReportDeliveryPage.dismissModal`).
 */
type ShiftWindow = Window & { __shiftNotices?: string[]; __shiftWatcherInstalled?: boolean };

/**
 * Runs in the page. Idempotent, so installing it twice is harmless — it is
 * installed both for every future navigation and in the document already open.
 */
function watchForShiftNotice() {
  const w = window as ShiftWindow;
  if (w.__shiftWatcherInstalled) return;
  w.__shiftWatcherInstalled = true;
  w.__shiftNotices = [];

  const NOTICE = /shift\s*changed|shift-\d+ has ended/i;

  const dismiss = () => {
    document.querySelectorAll('[role="dialog"], .mud-dialog, .modal').forEach((element) => {
      // A modal is positioned, so `offsetParent` is no use here; a box on the
      // page is what tells a shown dialog from a hidden one.
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return;

      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!NOTICE.test(text)) return;

      const ok = Array.from(element.querySelectorAll('button')).find((button) =>
        /^ok$/i.test((button.textContent ?? '').trim()),
      );
      if (!ok) return;

      w.__shiftNotices!.push(text.slice(0, 300));
      ok.click();
    });
  };

  // Polled rather than observed: the dialog is drawn over the circuit, and a
  // quarter of a second is far quicker than any test would notice.
  window.setInterval(dismiss, 250);
}

/**
 * Installs the watcher for every page the context opens, from the next
 * navigation onwards.
 */
export async function watchShiftNotices(context: BrowserContext) {
  await context.addInitScript(watchForShiftNotice);
}

/**
 * Installs it in a document that is already open.
 *
 * Best effort on purpose: `watchShiftNotices` is what actually carries the
 * watcher through the run, and this only covers the gap before the next
 * navigation. It is called from the `page` fixture, so a page caught mid
 * navigation must not be allowed to fail the test that was about to start.
 */
export async function watchShiftNoticesOnPage(page: Page) {
  await page.evaluate(watchForShiftNotice).catch(() => {});
}

/** The notices dismissed since the page last navigated, for the record. */
export async function shiftNotices(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as ShiftWindow).__shiftNotices ?? []);
}
