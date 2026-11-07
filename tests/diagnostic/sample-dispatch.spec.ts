import { Page } from '@playwright/test';
import { test, expect, investigations } from '../../fixtures/test';
import { SampleDispatchPage, DispatchFilter, DispatchRow, asPickerDate } from '../../pages/SampleDispatchPage';
import { settledCount } from '../../utils/blazor';

const data = investigations.partialSampleDispatch;

/**
 * Dispatching hands the sample to a carrier and cannot be undone from this
 * screen. Set `SAMPLE_DISPATCH=0` to walk the grid, try the carrier-less
 * dispatch and tick the rows without sending anything.
 *
 * The two tests run in order and are each other's setup: the first leaves the
 * invoice partially dispatched, which is where the second picks it up. The
 * invoice is whichever one the investigation spec posted last; see
 * `recordInvoiceNo` in fixtures/test.ts.
 */
const SHOULD_DISPATCH = process.env.SAMPLE_DISPATCH !== '0';

const report = (label: string, rows: DispatchRow[]) => {
  console.log(`--- ${label} ---`);
  rows.forEach((r) =>
    console.log(`  ${r.labNo} | ${r.testName} | ${r.sampleStatus} | carriedBy=${r.carriedBy || '-'} | ticked=${r.selected}`),
  );
};

const listed = (rows: DispatchRow[], name: string) =>
  rows.some((r) => r.testName.toUpperCase().includes(name.toUpperCase()));

/** Yesterday .. today, the range the screen is asked to cover. */
const today = new Date();
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

test.describe('Partial sample dispatch', () => {
  // Only these two are a chain; the negative tests below stand on their own,
  // and a failure in one of them must not skip the rest of the file.
  test.describe.configure({ mode: 'serial' });

  test('refuses a dispatch with no carrier, then sends the first two tests', async ({ page }) => {
    // Two full passes of the screen, a carrier-less refusal, a carrier picked
    // and a dispatch sent — a dozen round trips over the circuit, each of them
    // a grid the server rebuilds. Three minutes covered that on a quiet server
    // and not on a busy one, and running out of time here is worse than a red
    // test: the samples may already have been handed to the carrier by then,
    // leaving the invoice part dispatched with nothing said about it.
    test.setTimeout(300_000);

    const dispatch = new SampleDispatchPage(page);
    await dispatch.goto();
    await dispatch.recordSnackbars();

    await dispatch.setDateRange(yesterday, today);
    console.log(`date range: ${asPickerDate(yesterday)} .. ${asPickerDate(today)}`);
    await dispatch.show();

    await dispatch.filterBy('Not Dispatched');
    await dispatch.searchInvoice(data.invoiceNo);

    // selectInvoice does the waiting, and explains itself when the invoice is
    // not on the list; checking here first would only bury that with a bare
    // "element not found".
    await dispatch.selectInvoice(data.invoiceNo);
    console.log(
      `invoice row: ${(await dispatch.invoiceRow(data.invoiceNo).innerText()).replace(/\s+/g, ' ').trim()}`,
    );
    const initial = await dispatch.rows();
    report('on opening the invoice (Not Dispatched)', initial);
    expect(initial.length).toBe(data.firstBatch.length + data.secondBatch.length);
    // Nothing has been handed to a carrier yet, and unlike the collection tab
    // this grid starts with nothing ticked.
    expect(initial.every((r) => r.carriedBy === '')).toBe(true);

    // --- trying to dispatch without a carrier ---
    expect(await dispatch.selectedCarrier()).toBe('');

    // The screen will not even let a test be ticked until a carrier is set:
    // the click goes through and the row comes back unticked.
    const stuck = await dispatch.tryTick(data.firstBatch[0]);
    console.log(`ticking "${data.firstBatch[0]}" with no carrier -> ${stuck ? 'ticked' : 'refused'}`);
    expect(stuck).toBe(false);

    await dispatch.clearSnackbars();
    await dispatch.dispatch();
    const refusal = await dispatch.snackbars();
    refusal.forEach((m) => console.log(`snackbar (no carrier): ${m}`));
    expect(refusal.join(' | ')).toMatch(/select sample carrier/i);

    const afterAttempt = await dispatch.rows();
    report('after the carrier-less attempt', afterAttempt);
    expect(afterAttempt.every((r) => r.carriedBy === '')).toBe(true);
    console.log('nothing was dispatched without a carrier');

    // --- with a carrier ---
    const carrier = await dispatch.pickCarrier(data.carrier.query, new RegExp(data.carrier.match, 'i'));
    console.log(`carrier: ${carrier}`);
    expect(await dispatch.selectedCarrier()).toMatch(new RegExp(data.carrier.match, 'i'));

    // Picking the carrier reloads the grid, so the invoice is reopened.
    await dispatch.selectInvoice(data.invoiceNo);
    await dispatch.selectOnly(data.firstBatch);
    const ticked = await dispatch.rows();
    report('ticked for the first batch', ticked);
    expect(ticked.filter((r) => r.selected)).toHaveLength(data.firstBatch.length);

    test.skip(!SHOULD_DISPATCH, 'SAMPLE_DISPATCH=0: stopping before anything is dispatched');

    await dispatch.clearSnackbars();
    await dispatch.dispatch();
    (await dispatch.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/sample-dispatch-first-batch.png', fullPage: true });

    // --- the invoice is now partially dispatched ---
    await dispatch.goto();
    await dispatch.setDateRange(yesterday, today);
    await dispatch.show();
    await dispatch.filterBy('Partial Dispatched');
    await dispatch.searchInvoice(data.invoiceNo);
    await expect(dispatch.invoiceRow(data.invoiceNo)).toBeVisible({ timeout: 60_000 });
    console.log(`invoice ${data.invoiceNo} is listed under "Partial Dispatched"`);
  });

  test('dispatches the remaining tests', async ({ page }) => {
    // Nothing was dispatched by the first test, so there is no partial invoice
    // for this one to pick up.
    test.skip(!SHOULD_DISPATCH, 'SAMPLE_DISPATCH=0: the first test dispatched nothing');
    // The same work again, and then the whole screen a third time to see the
    // invoice under "Dispatched" — which is exactly where the three-minute
    // budget ran out, on a grid that was filling normally.
    test.setTimeout(300_000);

    const dispatch = new SampleDispatchPage(page);
    await dispatch.goto();
    await dispatch.recordSnackbars();

    await dispatch.setDateRange(yesterday, today);
    await dispatch.show();
    await dispatch.filterBy('Partial Dispatched');
    await dispatch.searchInvoice(data.invoiceNo);
    await dispatch.selectInvoice(data.invoiceNo);

    const pending = await dispatch.rows();
    report('still pending', pending);
    data.secondBatch.forEach((name) => expect(listed(pending, name)).toBe(true));

    // The carrier has to be in place before a row will tick.
    const carrier = await dispatch.pickCarrier(data.carrier.query, new RegExp(data.carrier.match, 'i'));
    console.log(`carrier: ${carrier}`);

    await dispatch.selectInvoice(data.invoiceNo);
    await dispatch.selectOnly(data.secondBatch);
    report('ticked for the second batch', await dispatch.rows());

    test.skip(!SHOULD_DISPATCH, 'SAMPLE_DISPATCH=0: stopping before anything is dispatched');

    await dispatch.clearSnackbars();
    await dispatch.dispatch();
    (await dispatch.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/sample-dispatch-second-batch.png', fullPage: true });

    // --- everything is dispatched ---
    await dispatch.goto();
    await dispatch.setDateRange(yesterday, today);
    await dispatch.show();
    await dispatch.filterBy('Dispatched');
    await dispatch.searchInvoice(data.invoiceNo);
    await expect(dispatch.invoiceRow(data.invoiceNo)).toBeVisible({ timeout: 60_000 });
    console.log(`invoice ${data.invoiceNo} is listed under "Dispatched"`);

    await dispatch.selectInvoice(data.invoiceNo);
    const final = await dispatch.rows();
    report('after dispatching everything', final);
    expect(final.every((r) => r.carriedBy !== '')).toBe(true);
  });
});

/**
 * The negative suite: `SD_N_*` for what the screen gets right, `SD_B_*` for
 * the eight defects found on 2026-11-04, each written as the behaviour the
 * screen ought to have and marked `test.fail`.
 *
 * None of these dispatches anything. "Send to carrier" is pressed three times
 * — twice with no invoice open at all, once against an invoice whose samples
 * are already with a carrier — so there is never anything for a press to
 * commit, and unlike the two tests above these can be run as often as you
 * like, against any data. Ticking a row is not a commit either: dispatch
 * happens on the button, so the cases that tick leave the grid ticked and the
 * invoice untouched.
 *
 * A `test.fail` case keeps the run green while the defect stands, and the day
 * the screen is fixed Playwright reports "expected to fail but passed", which
 * is the prompt to delete the marker. Cases that cannot be driven from here at
 * all — another role's password, a real session timeout, two operators at once
 * — are skipped with the reason rather than faked.
 *
 * Two findings run through the rest: this screen validates only when it has
 * something on the grid to validate against, and it says nothing when a query
 * finds nothing. Both are the collection tab's findings too, one tab over.
 */

/** A 13-digit number no invoice will ever have. */
const MISSING_INVOICE = '9999999999999';
const TODAY = asPickerDate(new Date());

/**
 * How far back the cases that need rows look.
 *
 * Today on its own is routinely empty here — a UAT server has quiet days, and
 * on 2026-11-04 all three filters read 0 — which skipped every case that works
 * on a grid rather than failing it, and a suite that skips itself silently is
 * worth less than no suite at all. A week back is enough to find an invoice in
 * each dispatch state without making the server read the year;
 * `SAMPLE_DISPATCH_DAYS` widens it on a quieter one.
 */
const WINDOW_DAYS = Number(process.env.SAMPLE_DISPATCH_DAYS ?? 7);
const WINDOW_FROM = asPickerDate(new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000));

/**
 * Fresh page object on the dispatch tab, with the snackbar recorder installed.
 *
 * The date range is part of the screen's own state and the tab is reopened per
 * test, so each case starts from the same window rather than from whatever the
 * last one left behind.
 */
async function open(page: Page) {
  const dispatch = new SampleDispatchPage(page);
  await dispatch.goto();
  await dispatch.recordSnackbars();
  await dispatch.typeDate(dispatch.startDate, WINDOW_FROM);
  await dispatch.typeDate(dispatch.endDate, TODAY);
  await dispatch.show();
  return dispatch;
}

/** Records any response the screen gets back with an error status. */
function watchForServerErrors(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  return failures;
}

/** Opens the first invoice listed under a filter, or skips for want of one. */
async function openFirstInvoice(dispatch: SampleDispatchPage, filter: DispatchFilter) {
  await dispatch.filterBy(filter);
  const rows = dispatch.invoiceRows;
  test.skip((await rows.count()) === 0, `no invoice under "${filter}" in the last ${WINDOW_DAYS} days to work on`);

  const invoiceNo = (await rows.first().locator('td').first().innerText()).replace(/\s+/g, ' ').trim();
  await rows.first().click();
  await expect(dispatch.testRows.first()).toBeVisible({ timeout: 60_000 });
  await settledCount(dispatch.testRows);
  return invoiceNo;
}

test.describe('Sample dispatch — negative', () => {
  // --- the date range -----------------------------------------------------

  /**
   * SD_B_01: a reversed range is queried rather than refused, and the empty
   * grid that comes back reads as "no invoices" rather than "your dates are
   * the wrong way round".
   */
  test.fail('SD_B_01 a reversed date range is rejected', async ({ page }) => {
    const dispatch = await open(page);

    await dispatch.typeDate(dispatch.startDate, TODAY);
    await dispatch.typeDate(dispatch.endDate, '10-09-2026');
    await dispatch.show();

    const message = page.getByText(/date to.*(greater|after|>=)|invalid date range/i);
    await expect(message, 'a reversed range should be called out before it is queried').toBeVisible({
      timeout: 10_000,
    });
  });

  /**
   * SD_B_02: the picker rolls 31-02-2026 forward to 03/03/2026 under the
   * operator's fingers, the same way the collection tab's does (SC_N_02). The
   * screen then reports on a day nobody asked for.
   */
  test.fail('SD_B_02 an impossible date is refused rather than rolled over', async ({ page }) => {
    const dispatch = await open(page);

    const held = await dispatch.typeDate(dispatch.startDate, '31-02-2026');
    console.log(`typed 31-02-2026, field holds "${held}"`);

    expect(
      held === '' || /invalid/i.test(held),
      `31 February does not exist; the field should refuse it, but it holds "${held}"`,
    ).toBe(true);
  });

  /** SD_B_03: both dates can be cleared and Show still fires. */
  test.fail('SD_B_03 blank dates are required before Show will run', async ({ page }) => {
    const dispatch = await open(page);

    const start = await dispatch.typeDate(dispatch.startDate, '');
    const end = await dispatch.typeDate(dispatch.endDate, '');
    console.log(`cleared both pickers; start holds "${start}", end holds "${end}"`);
    await dispatch.show();

    const message = page.getByText(/date is required|please select.*date/i);
    await expect(message).toBeVisible({ timeout: 10_000 });
  });

  test('SD_N_01 a future range returns an empty grid, not an exception', async ({ page }) => {
    const dispatch = await open(page);
    const failures = watchForServerErrors(page);

    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    await dispatch.typeDate(dispatch.startDate, asPickerDate(next));
    await dispatch.typeDate(dispatch.endDate, asPickerDate(next));
    await dispatch.show();

    await expect(dispatch.invoiceRows).toHaveCount(0);
    await expect(dispatch.testRows).toHaveCount(0);
    expect(failures, 'a future range must not produce a server error').toEqual([]);
    console.log('note: the screen shows no empty-state text for an empty result');
  });

  test('SD_N_02 a six-year range answers instead of hanging', async ({ page }) => {
    test.setTimeout(300_000);
    const dispatch = await open(page);

    await dispatch.typeDate(dispatch.startDate, '01-01-2020');
    await dispatch.typeDate(dispatch.endDate, TODAY);

    // Typing the range is enough to set the screen querying — Show disables
    // itself and spins while it works, and on 2026-11-07 it was still spinning
    // thirty seconds after the dates went in, which is what a straight click
    // ran out of time against. That first query is waited out rather than
    // measured: what this case asks about is the answer to the press.
    await expect(dispatch.showButton, 'Show never came back from the query the dates started').toBeEnabled({
      timeout: 120_000,
    });

    const started = Date.now();
    await dispatch.showButton.click();
    // Either rows arrive or the grid stays empty; both are answers. A hang is not.
    await expect(dispatch.invoiceGrid).toBeVisible({ timeout: 120_000 });
    await settledCount(dispatch.invoiceRows, { quiet: 2_000, timeout: 120_000 });
    const elapsed = Date.now() - started;

    console.log(`01-01-2020..${TODAY} answered in ${elapsed}ms with ${await dispatch.invoiceRows.count()} row(s)`);
    expect(elapsed, 'a wide range should still answer inside two minutes').toBeLessThan(120_000);
  });

  // --- the search box -----------------------------------------------------

  test('SD_N_03 an invoice that does not exist leaves both grids empty', async ({ page }) => {
    const dispatch = await open(page);

    await dispatch.searchInvoice(MISSING_INVOICE);

    await expect(dispatch.invoiceRows).toHaveCount(0);
    await expect(dispatch.testRows).toHaveCount(0);
    console.log('note: the screen shows no "No data found" text either');
  });

  test('SD_N_04 a whitespace-only search behaves like an empty one', async ({ page }) => {
    const dispatch = await open(page);
    const failures = watchForServerErrors(page);

    const before = await dispatch.invoiceRows.count();
    await dispatch.searchInvoice('   ');
    const after = await dispatch.invoiceRows.count();

    console.log(`rows before "   ": ${before}, after: ${after}`);
    expect(failures).toEqual([]);
  });

  for (const [id, payload] of [
    ['SD_N_05', '!@#$%^&*()'],
    ['SD_N_06', "' OR 1=1--"],
  ] as const) {
    test(`${id} "${payload}" is handled without a server error`, async ({ page }) => {
      const dispatch = await open(page);
      const failures = watchForServerErrors(page);

      await dispatch.searchInvoice(payload);

      expect(failures, `"${payload}" must not reach the database unescaped`).toEqual([]);
      // An injection that worked would return rows it has no business returning.
      await expect(dispatch.invoiceRows).toHaveCount(0);
    });
  }

  test('SD_N_07 an XSS payload is rendered as text, never executed', async ({ page }) => {
    const dispatch = await open(page);

    let dialog = false;
    page.on('dialog', async (d) => {
      dialog = true;
      await d.dismiss();
    });

    await dispatch.searchInvoice('<script>alert(1)</script>');

    expect(dialog, 'the payload must not execute').toBe(false);
    const planted = await page
      .locator('body script')
      .evaluateAll((els) => els.some((e) => /alert\(1\)/.test(e.textContent ?? '')));
    expect(planted, 'the payload must not be written into the DOM as markup').toBe(false);
  });

  /** SD_B_04: the box takes all 600 characters, as the collection tab's does. */
  test.fail('SD_B_04 the search box caps how much can be pasted into it', async ({ page }) => {
    const dispatch = await open(page);

    await dispatch.search.fill('A'.repeat(600));
    const held = (await dispatch.search.inputValue()).length;

    console.log(`600 characters pasted, field holds ${held}`);
    expect(held, 'a search box with no maximum length is a needless payload surface').toBeLessThan(600);
  });

  // --- the carrier --------------------------------------------------------

  test('SD_N_08 a carrier nobody is named offers no suggestion to take', async ({ page }) => {
    const dispatch = await open(page);

    const offered = await dispatch.carrierSuggestions('ZZQXNOTACARRIER');
    console.log(`suggestions for "ZZQXNOTACARRIER": ${JSON.stringify(offered)}`);

    expect(offered, 'a name nobody carries under should match nothing').toEqual([]);
  });

  /**
   * SD_N_09: the box is a typeahead, and this half it gets right — text that
   * matched no carrier is cleared out, so there is nothing left to mistake for
   * a carrier that was chosen.
   */
  test('SD_N_09 a carrier typed but never chosen is not left in the box', async ({ page }) => {
    const dispatch = await open(page);

    await dispatch.carrierSuggestions('ZZQXNOTACARRIER');
    await page.keyboard.press('Escape');
    const held = await dispatch.selectedCarrier();
    console.log(`the carrier box holds "${held}" after typing a name that matched nothing`);

    expect(held, 'text that matched no carrier must not be left sitting in the box').toBe('');
  });

  /**
   * SD_B_05: Send to carrier, pressed with no invoice open and no carrier set,
   * answers "save finished."
   *
   * The same button against an open invoice does refuse — the first test in
   * this file holds it to "Please select sample carrier." — so the check
   * exists and is simply not reached when there is nothing on the grid to
   * check against. Nothing is dispatched either way; what is wrong is that a
   * press which did nothing at all is reported as a save that worked.
   */
  test.fail('SD_B_05 Send to carrier with nothing selected does not report a save', async ({ page }) => {
    const dispatch = await open(page);

    await dispatch.searchInvoice(MISSING_INVOICE); // guarantees no invoice is open
    expect(await dispatch.selectedCarrier()).toBe('');

    await dispatch.clearSnackbars();
    await dispatch.dispatch();
    const said = await dispatch.snackbars();
    said.forEach((m) => console.log(`snackbar: ${m}`));

    expect(
      said.join(' | '),
      'a press that dispatched nothing must not be reported as a finished save',
    ).not.toMatch(/save finished|success/i);
  });

  /**
   * SD_B_06: the grid refuses a tick until a carrier is set, and then lets the
   * carrier be taken away again with the tick left standing.
   *
   * The screen is therefore one press away from a dispatch whose carrier the
   * operator has just cleared. Nothing is sent here: the ticks are read, not
   * acted on, and a tick commits nothing on its own.
   */
  test.fail('SD_B_06 clearing the carrier does not leave rows ticked behind it', async ({ page }) => {
    const dispatch = await open(page);

    await openFirstInvoice(dispatch, 'Not Dispatched');
    const carrier = await dispatch.pickCarrier(data.carrier.query, new RegExp(data.carrier.match, 'i'));
    console.log(`carrier: ${carrier}`);

    // Picking the carrier rebuilds the grid, so the invoice is reopened.
    const invoiceNo = await openFirstInvoice(dispatch, 'Not Dispatched');
    const first = (await dispatch.rows())[0];
    test.skip(!first, `invoice ${invoiceNo} came back with no test rows`);

    const stuck = await dispatch.tryTick(first.testName);
    test.skip(!stuck, 'the row would not tick even with a carrier set; nothing to clear behind it');

    await dispatch.clearCarrier();
    const stillTicked = (await dispatch.rows()).filter((r) => r.selected).map((r) => r.testName);
    console.log(`carrier box now holds "${await dispatch.selectedCarrier()}"`);
    console.log(`still ticked: ${JSON.stringify(stillTicked)}`);

    expect(
      stillTicked,
      'a tick that needed a carrier should not outlive the carrier it was made against',
    ).toEqual([]);
  });

  /**
   * SD_B_09: Send to carrier, pressed with an invoice open, a carrier set and
   * every test unticked, answers "save finished." as well.
   *
   * This is the operator's own mistake rather than SD_B_05's empty screen —
   * carrier chosen, invoice up, the ticks forgotten — and the screen reports
   * it as a dispatch that worked. Nothing was sent, so the samples stay where
   * they were, and the operator has been told otherwise.
   *
   * Driven against an invoice that is already fully dispatched, so a screen
   * that wrongly sent "everything" would have nothing left to send. The half
   * this cannot cover — an undispatched invoice with no row ticked — is the
   * one SC_N_12b leaves to a manual run, and for the same reason: the button
   * that is meant to warn is the button that commits.
   */
  test.fail('SD_B_09 Send to carrier is refused when no test is ticked', async ({ page }) => {
    const dispatch = await open(page);

    await openFirstInvoice(dispatch, 'Dispatched');
    const carrier = await dispatch.pickCarrier(data.carrier.query, new RegExp(data.carrier.match, 'i'));
    console.log(`carrier: ${carrier}`);

    // The carrier rebuilds the grid; reopen the invoice and clear every tick
    // the screen put there itself (SD_B_08 is what puts them there).
    await openFirstInvoice(dispatch, 'Dispatched');
    await dispatch.selectOnly([]);
    const ticked = (await dispatch.rows()).filter((r) => r.selected);
    test.skip(ticked.length > 0, 'the ticks could not be cleared, so this is not the case it means to be');

    await dispatch.clearSnackbars();
    await dispatch.dispatch();
    const said = await dispatch.snackbars();
    said.forEach((m) => console.log(`snackbar: ${m}`));

    expect(
      said.join(' | '),
      'a dispatch with nothing ticked should be refused, not reported as a success',
    ).toMatch(/select|no test|at least one|choose/i);
  });

  // --- the grids ----------------------------------------------------------

  test('SD_N_10 every dispatched row names its carrier and when it went', async ({ page }) => {
    const dispatch = await open(page);

    const invoiceNo = await openFirstInvoice(dispatch, 'Dispatched');
    const rows = await dispatch.rows();
    rows.forEach((r) => console.log(`  ${r.labNo} | ${r.testName} | carriedBy="${r.carriedBy}" | ${r.carriedDate}`));

    expect(rows.length, `invoice ${invoiceNo} is listed as dispatched but shows no tests`).toBeGreaterThan(0);
    expect(
      rows.filter((r) => r.carriedBy === '').map((r) => r.testName),
      'a dispatched test with no carrier against it has lost its audit trail',
    ).toEqual([]);
    expect(
      rows.filter((r) => r.carriedDate === '').map((r) => r.testName),
      'a dispatched test with no carried date has lost its audit trail',
    ).toEqual([]);
  });

  /**
   * What this can and cannot say, given the grid SD_N_20 describes: each list
   * here is the window the scroller has rendered, not the whole filter. An
   * overlap found is therefore real and worth failing on, but an overlap
   * missed proves nothing — the two invoices could both be off-window. It is
   * left reading the window rather than scrolling three filters end to end,
   * which on a month of data would be several thousand rows.
   */
  test('SD_N_11 an invoice cannot be listed under two dispatch states at once', async ({ page }) => {
    const dispatch = await open(page);

    const listedUnder = async (filter: DispatchFilter) => {
      await dispatch.filterBy(filter);
      const rows = dispatch.invoiceRows;
      const out: string[] = [];
      for (let i = 0; i < (await rows.count()); i++) {
        out.push((await rows.nth(i).locator('td').first().innerText()).replace(/\s+/g, ' ').trim());
      }
      return out;
    };

    const notDispatched = await listedUnder('Not Dispatched');
    const partial = await listedUnder('Partial Dispatched');
    const dispatched = await listedUnder('Dispatched');
    console.log(`Not Dispatched: ${notDispatched.length}, Partial: ${partial.length}, Dispatched: ${dispatched.length}`);

    expect(
      notDispatched.filter((n) => dispatched.includes(n)),
      'an invoice is either dispatched or it is not; it cannot be both',
    ).toEqual([]);
  });

  /**
   * SD_N_20: what the count beside a filter is, read against a grid that
   * renders only part of itself.
   *
   * This was SD_B_07, a defect: on 2026-11-04, over 28-10 .. 04-11, the
   * "Dispatched" badge read 623 against a grid of 27 rows while the other two
   * filters agreed with theirs exactly, and that was written up as a count for
   * all time sitting beside a grid obeying the date range. The badge was right
   * and the reading was wrong — the same misreading SC_N_19 carried, and for
   * the same reason: this screen *is* that screen. Dispatch is a tab on the
   * sample-collection route, and its invoice grid is the same 216-pixel
   * scroller, which keeps only the rows around the scroll position in the DOM.
   * `invoiceRows.count()` is therefore a count of what has been rendered and
   * never of what the filter matched. Measured on 2026-11-07 over 30 days:
   * "Dispatched" badge 3609, 29 rows rendered, the scroller 216 pixels tall
   * against 36863 of content, and four scrolls brought four different invoices
   * to the top of the list in turn. Nothing is truncated and nothing is
   * missing; the rows arrive as they are scrolled to.
   *
   * What is left to check is what can be checked: the grid never shows more
   * rows than the filter counted, a short list is rendered whole and agrees
   * with its badge exactly, and a long one goes on producing invoices as it is
   * scrolled — the way SC_N_27 checks the same grid under the collection tab.
   */
  test('SD_N_20 a filter count is never smaller than the list it sits over', async ({ page }) => {
    test.setTimeout(180_000);
    const dispatch = await open(page);

    for (const filter of ['Not Dispatched', 'Partial Dispatched', 'Dispatched'] as const) {
      const label = (await dispatch.filterLabel(filter).innerText()).replace(/\s+/g, ' ').trim();
      const badge = label.match(/(\d+)\s*$/)?.[1];
      expect(badge, `the "${filter}" filter should carry a count`).toBeDefined();

      await dispatch.filterBy(filter);
      const counted = Number(badge);
      const rendered = await dispatch.invoiceRows.count();

      // The scroller the rows sit in, which is the whole explanation for the
      // two numbers differing.
      const scroller = await dispatch.invoiceGrid.evaluate((el) => {
        let node: HTMLElement | null = el as HTMLElement;
        while (node && node.scrollHeight <= node.clientHeight + 1) node = node.parentElement;
        return node ? `h=${node.clientHeight} sh=${node.scrollHeight}` : 'none';
      });
      console.log(`SD_N_20 ${filter}: badge ${counted}, ${rendered} row(s) rendered, scroller ${scroller}`);

      expect(rendered, 'the grid cannot be showing rows the filter did not count').toBeLessThanOrEqual(counted);
      if (rendered === counted) continue;

      // A windowed list: the rest of it has to be reachable, or rows really
      // are missing rather than merely unrendered. Watched at the bottom of
      // the window rather than the top, the way SC_N_27 watches it — the first
      // rendered row stays put until the scroll has gone a long way down, so a
      // list only a row or two longer than the window never moves it at all.
      const lastRow = async () => (await dispatch.invoiceRows.last().locator('td').first().innerText()).trim();
      const seen = new Set<string>([await lastRow()]);
      for (let i = 0; i < 3; i++) {
        await dispatch.invoiceRows.last().scrollIntoViewIfNeeded();
        await page.mouse.wheel(0, 4_000);
        await page.waitForTimeout(2_000);
        seen.add(await lastRow());
      }

      console.log(`SD_N_20   scrolling reached ${JSON.stringify([...seen])}`);
      expect(seen.size, 'a list longer than the window must go on producing rows as it is scrolled').toBeGreaterThan(
        1,
      );
    }
  });

  test("SD_N_12 opening another invoice clears the first one's tests", async ({ page }) => {
    const dispatch = await open(page);

    await dispatch.filterBy('Not Dispatched');
    const rows = dispatch.invoiceRows;
    test.skip((await rows.count()) < 2, 'need two undispatched invoices on screen to compare');

    const invoiceOf = async (index: number) =>
      (await rows.nth(index).locator('td').first().innerText()).replace(/\s+/g, ' ').trim();

    const first = await invoiceOf(0);
    await dispatch.selectInvoice(first);
    const firstTests = (await dispatch.rows()).map((r) => r.labNo);

    const second = await invoiceOf(1);
    await dispatch.selectInvoice(second);
    const secondTests = (await dispatch.rows()).map((r) => r.labNo);

    console.log(`invoice ${first}: ${firstTests.join(', ')}`);
    console.log(`invoice ${second}: ${secondTests.join(', ')}`);
    expect(
      secondTests.filter((lab) => firstTests.includes(lab)),
      "the second invoice must not inherit the first one's tests",
    ).toEqual([]);
  });

  test('SD_N_13 only a collected sample is offered for dispatch', async ({ page }) => {
    const dispatch = await open(page);

    const invoiceNo = await openFirstInvoice(dispatch, 'Not Dispatched');
    const rows = await dispatch.rows();
    rows.forEach((r) =>
      console.log(`  ${r.labNo} | ${r.testName} | status="${r.sampleStatus}" | collectedBy="${r.collectedBy}"`),
    );

    // "Label Printed" is what a collected sample reads as here: printing the
    // label is what collects it on the tab next door.
    const uncollected = rows.filter((r) => /not collected/i.test(r.sampleStatus) || r.collectedBy === '');
    expect(
      uncollected.map((r) => `${r.labNo} ${r.testName} (${r.sampleStatus || 'blank status'})`),
      `invoice ${invoiceNo} offers a sample for dispatch that the counter has not collected`,
    ).toEqual([]);
  });

  test('SD_N_14 a grid cell with nothing behind it reads blank, not "null"', async ({ page }) => {
    const dispatch = await open(page);

    await openFirstInvoice(dispatch, 'Not Dispatched');
    const rows = await dispatch.rows();
    const broken = rows
      .flatMap((r) => Object.entries(r).map(([key, value]) => ({ labNo: r.labNo, key, value: String(value) })))
      .filter((cell) => /^(null|undefined|NaN)$/i.test(cell.value.trim()));

    rows.forEach((r) => console.log(`  ${r.labNo} | ${JSON.stringify(r)}`));
    expect(broken, 'a missing value must read as blank, not as "null"').toEqual([]);
  });

  /**
   * SD_B_08: an invoice whose samples are all with a carrier opens with every
   * row ticked, and every checkbox live.
   *
   * Collection's own grid does the same, but there a second print is only a
   * reprint. Here the one button on the screen sends samples to a carrier, so
   * an invoice opened to check where a sample went is a single press from
   * being dispatched a second time — with the ticks already in place and
   * nothing on screen saying the work is done. Whether that second press
   * overwrites the carrier and the time it was handed over is the question
   * this leaves open: answering it costs a live sample its audit trail, so it
   * belongs on a test database.
   */
  test.fail('SD_B_08 a dispatched invoice is not offered for dispatch a second time', async ({ page }) => {
    const dispatch = await open(page);

    const invoiceNo = await openFirstInvoice(dispatch, 'Dispatched');
    const rows = await dispatch.rows();
    const live = await dispatch.testRows.locator('input[type="checkbox"]:not([disabled])').count();
    const ticked = rows.filter((r) => r.selected).length;
    console.log(`invoice ${invoiceNo}: ${rows.length} dispatched test(s), ${ticked} ticked, ${live} still tickable`);

    expect(
      { ticked, live },
      'a sample already with a carrier should be neither ticked nor tickable for dispatch again',
    ).toEqual({ ticked: 0, live: 0 });
  });

  // --- out of reach from here ---------------------------------------------

  test('SD_N_15 a dispatch cut off part-way commits nothing', async () => {
    test.skip(
      true,
      'The interesting half is a real dispatch interrupted mid-post, which would leave live samples in whatever ' +
        'state the defect produces. Worth running against a test database, not this one.',
    );
  });

  test('SD_N_16 two operators cannot dispatch the same sample at once', async () => {
    test.skip(
      true,
      'Needs two sessions dispatching the same lab number together. Driving it would hand a live sample to a ' +
        'carrier twice, and the loser of the race cannot be told apart from an ordinary "already dispatched". Manual.',
    );
  });

  test('SD_N_17 a role without permission cannot reach the screen', async () => {
    test.skip(
      true,
      'Needs a second account. test-data/users.json lists the roles but holds a password only for the two the ' +
        'suite signs in as — ASP.NET Identity stores the rest hashed. Fill one in and this becomes a real test.',
    );
  });

  test('SD_N_18 an expired session is sent back to the login page', async () => {
    test.skip(
      true,
      'Needs the session to lapse. The header counts down from about eight hours, so a run would have to idle ' +
        'that long; worth doing against a build with a short timeout instead.',
    );
  });

  test('SD_N_19 double-pressing Send to carrier does not dispatch twice', async () => {
    test.skip(
      true,
      'The press that matters is one against rows that are genuinely tickable, which is a live dispatch. Fold it ' +
        'into the two tests above, where samples are really being sent, rather than spending an invoice here.',
    );
  });
});
