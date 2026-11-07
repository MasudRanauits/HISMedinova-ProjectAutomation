import { Locator, Page } from '@playwright/test';
import { test, expect, investigations } from '../../fixtures/test';
import { PatientFilter, SampleCollectionPage, SampleRow } from '../../pages/SampleCollectionPage';

const data = investigations.partialSampleCollection;

/**
 * Printing a label collects the sample for real, and a sample cannot be
 * un-collected from this screen. Set `SAMPLE_COLLECT=0` to walk the grid and
 * tick the rows without committing anything.
 *
 * The two tests run in order and are each other's setup: the first leaves the
 * invoice partially collected, which is where the second picks it up. Neither
 * can be repeated against the same invoice — a collected test drops out of the
 * grid altogether, so a second run has nothing to work with. The invoice to
 * work on is whichever one the investigation spec posted last; see
 * `recordInvoiceNo` in fixtures/test.ts.
 */
const SHOULD_COLLECT = process.env.SAMPLE_COLLECT !== '0';

const report = (label: string, rows: SampleRow[]) => {
  console.log(`--- ${label} ---`);
  rows.forEach((r) => console.log(`  ${r.labNo} | ${r.testName} | ${r.status} | ticked=${r.selected}`));
};

const names = (rows: SampleRow[]) => rows.map((r) => r.testName.toUpperCase());
const listed = (rows: SampleRow[], name: string) => names(rows).some((n) => n.includes(name.toUpperCase()));

test.describe('Partial sample collection', () => {
  // Only these two are a chain; the negative tests below stand on their own.
  test.describe.configure({ mode: 'serial' });

  test('collects the first batch and leaves the rest pending', async ({ page }) => {
    const samples = new SampleCollectionPage(page);
    await samples.goto();
    await samples.recordSnackbars();

    await samples.selectInvoice(data.invoiceNo);

    const initial = await samples.rows();
    report('on opening the invoice', initial);
    expect(initial.length).toBe(data.firstBatch.length + data.secondBatch.length);
    // Selecting the invoice ticks every row, and none is collected yet.
    expect(initial.every((r) => /not collected/i.test(r.status))).toBe(true);
    expect(initial.every((r) => r.selected)).toBe(true);

    await samples.selectOnly(data.firstBatch);
    const ticked = await samples.rows();
    report('ticked for the first batch', ticked);
    expect(ticked.filter((r) => r.selected).map((r) => r.testName)).toHaveLength(data.firstBatch.length);
    data.firstBatch.forEach((name) =>
      expect(ticked.find((r) => r.testName.toUpperCase().includes(name.toUpperCase()))?.selected).toBe(true),
    );

    test.skip(!SHOULD_COLLECT, 'SAMPLE_COLLECT=0: stopping before anything is collected');

    await samples.collectSelected();
    (await samples.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/sample-collection-first-batch.png', fullPage: true });

    await samples.goto();
    await samples.filterBy('Partial Collected');
    // The grid keeps only a screenful of rows in the DOM at a time (SC_N_27),
    // so an invoice raised in the afternoon is reachable but not present until
    // it is scrolled to. The list is narrowed to this invoice first instead:
    // without that, a row that is genuinely there reads as missing, and one
    // that is genuinely gone reads as gone for the wrong reason.
    await samples.searchInvoice(data.invoiceNo);
    await expect(samples.invoiceRow(data.invoiceNo)).toBeVisible({ timeout: 60_000 });
    console.log(`invoice ${data.invoiceNo} is listed under "Partial Collected"`);
  });

  test('collects the remaining samples', async ({ page }) => {
    // Nothing was collected by the first test, so there is no partial invoice
    // for this one to pick up.
    test.skip(!SHOULD_COLLECT, 'SAMPLE_COLLECT=0: the first test collected nothing');

    const samples = new SampleCollectionPage(page);
    await samples.goto();
    await samples.recordSnackbars();

    await samples.filterBy('Partial Collected');
    await samples.searchInvoice(data.invoiceNo);
    await samples.selectInvoice(data.invoiceNo);

    // A collected test leaves the grid, so what is left is what is still due.
    const pending = await samples.rows();
    report('still pending', pending);
    expect(pending.length).toBe(data.secondBatch.length);
    data.secondBatch.forEach((name) => expect(listed(pending, name)).toBe(true));
    data.firstBatch.forEach((name) => expect(listed(pending, name)).toBe(false));

    await samples.selectOnly(data.secondBatch);
    expect((await samples.rows()).every((r) => r.selected)).toBe(true);

    test.skip(!SHOULD_COLLECT, 'SAMPLE_COLLECT=0: stopping before anything is collected');

    await samples.collectSelected();
    (await samples.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/sample-collection-second-batch.png', fullPage: true });

    await samples.goto();
    await samples.filterBy('Collected Patient');
    await samples.searchInvoice(data.invoiceNo);
    await expect(samples.invoiceRow(data.invoiceNo)).toBeVisible({ timeout: 60_000 });
    console.log(`invoice ${data.invoiceNo} is listed under "Collected Patient"`);

    // And it is no longer waiting on anything. The search matters more here
    // than anywhere else: an unnarrowed grid would satisfy toBeHidden simply by
    // never having rendered the row.
    await samples.goto();
    await samples.filterBy('Partial Collected');
    await samples.searchInvoice(data.invoiceNo);
    await expect(samples.invoiceRow(data.invoiceNo)).toBeHidden({ timeout: 30_000 });
    console.log(`invoice ${data.invoiceNo} has left "Partial Collected"`);
  });
});

/**
 * Negative tests, SC_N_01 to SC_N_24.
 *
 * None of these collects a sample. The only buttons pressed are Show and the
 * two print buttons — printing is repeatable and changes no status — so unlike
 * the two tests above they can be run as often as you like, against any data.
 *
 * Where the screen does not do what a case asks for, the test is marked
 * `test.fail()`: the run stays green, the gap stays on the record, and if the
 * screen is ever fixed Playwright reports "expected to fail but passed", which
 * is the prompt to delete the marker. Cases that cannot be driven from here at
 * all — another role's password, a real session timeout, two operators at once
 * — are skipped with the reason rather than faked.
 *
 * The recurring finding: this screen has no client-side validation and no
 * empty-state text. Bad input is accepted, the grid quietly empties, and
 * nothing is said either way.
 */

/** A 13-digit number no invoice will ever have. */
const MISSING_INVOICE = '9999999999999';

const pad = (n: number) => String(n).padStart(2, '0');
const asPickerDate = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
const TODAY = asPickerDate(new Date());

/**
 * Fresh page object on the screen, with the snackbar recorder installed.
 *
 * The date range is part of the screen's own state, so a case that leaves it
 * blank or reversed would otherwise hand the next one an empty grid; each test
 * starts from today.
 */
async function open(page: Page) {
  const samples = new SampleCollectionPage(page);
  await samples.goto();
  await samples.recordSnackbars();
  await samples.setDateRange(TODAY, TODAY);
  await samples.show();
  return samples;
}

/** Records any response the screen gets back with an error status. */
function watchForServerErrors(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  return failures;
}

test.describe('Sample collection — negative', () => {
  // --- date range ---------------------------------------------------------

  // SC_N_01: the screen shows no message at all; it just empties the grid.
  test.fail('SC_N_01 a reversed date range is rejected', async ({ page }) => {
    const samples = await open(page);

    await samples.setDateRange(TODAY, '10-09-2026');
    await samples.show();

    const message = page.getByText(/date to.*(greater|after|>=)|invalid date range/i);
    await expect(message, 'a reversed range should be called out before it is queried').toBeVisible({
      timeout: 10_000,
    });
  });

  // SC_N_02: the picker silently rolls 31-02-2026 forward to 03-03-2026.
  test.fail('SC_N_02 an impossible date is refused rather than rolled over', async ({ page }) => {
    const samples = await open(page);

    const typed = await samples.setDate(samples.dateFrom, '31-02-2026');
    console.log(`typed 31-02-2026, field holds "${typed}"`);

    expect(
      typed === '' || /invalid/i.test(typed),
      `31 February does not exist; the field should refuse it, but it holds "${typed}"`,
    ).toBe(true);
  });

  test('SC_N_02b a loose format is normalised, not mangled', async ({ page }) => {
    const samples = await open(page);

    // This one the picker gets right: 19/09/26 is understood as 19 September
    // 2026 and the year is widened, rather than rolled over the way SC_N_02 is.
    // The separators are the screen's own, not the ones typed — this picker
    // displays dd/mm/yyyy whatever it is given (SC_N_02 types dashes and gets
    // 03/03/2026 back), as does the dispatch tab beside it, while the delivery
    // screen keeps the dashes `asPickerDate` writes. That inconsistency is the
    // app's, not this date's, so the parts are compared on their own.
    const typed = await samples.setDate(samples.dateFrom, '19/09/26');
    console.log(`typed 19/09/26, field holds "${typed}"`);

    expect(typed.split(/[-/]/)).toEqual(['19', '09', '2026']);
  });

  // SC_N_03: both dates can be cleared and Show still fires.
  test.fail('SC_N_03 blank dates are required before Show will run', async ({ page }) => {
    const samples = await open(page);

    await samples.setDateRange('', '');
    expect(await samples.dateFrom.inputValue()).toBe('');

    await samples.show();

    const message = page.getByText(/date is required|please select.*date/i);
    await expect(message).toBeVisible({ timeout: 10_000 });
  });

  test('SC_N_04 a future range returns an empty grid, not an exception', async ({ page }) => {
    const samples = await open(page);
    const failures = watchForServerErrors(page);

    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    await samples.setDateRange(asPickerDate(next), asPickerDate(next));
    await samples.show();

    await expect(samples.invoiceGrid.locator('tbody tr')).toHaveCount(0);
    expect(failures, 'a future range must not produce a server error').toEqual([]);
    // Worth knowing: the grid simply goes blank — there is no "No record found".
    console.log('note: the screen shows no empty-state text for an empty result');
  });

  test('SC_N_21 a six-year range answers instead of hanging', async ({ page }) => {
    test.setTimeout(240_000);
    const samples = await open(page);

    await samples.setDateRange('01-01-2020', TODAY);
    const started = Date.now();
    await samples.showButton.click();
    // Either rows arrive or the grid stays empty; both are answers. A hang is not.
    await expect(samples.invoiceGrid).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(5_000);
    const elapsed = Date.now() - started;

    console.log(`01-01-2020..${TODAY} answered in ${elapsed}ms`);
    expect(elapsed, 'a wide range should still answer inside two minutes').toBeLessThan(120_000);
  });

  // --- the search box -----------------------------------------------------

  test('SC_N_05 an invoice that does not exist leaves both grids empty', async ({ page }) => {
    const samples = await open(page);

    await samples.searchInvoice(MISSING_INVOICE);

    await expect(samples.invoiceGrid.locator('tbody tr')).toHaveCount(0);
    await expect(samples.testRows).toHaveCount(0);
    console.log('note: the screen shows no "No data found" text either');
  });

  test('SC_N_06 a whitespace-only search behaves like an empty one', async ({ page }) => {
    const samples = await open(page);
    const failures = watchForServerErrors(page);

    const before = await samples.invoiceGrid.locator('tbody tr').count();
    await samples.searchInvoice('   ');
    const after = await samples.invoiceGrid.locator('tbody tr').count();

    console.log(`rows before "   ": ${before}, after: ${after}`);
    expect(failures).toEqual([]);
  });

  for (const [id, payload] of [
    ['SC_N_07', '!@#$%^&*()'],
    ['SC_N_08', "' OR 1=1--"],
  ] as const) {
    test(`${id} "${payload}" is handled without a server error`, async ({ page }) => {
      const samples = await open(page);
      const failures = watchForServerErrors(page);

      await samples.searchInvoice(payload);

      expect(failures, `"${payload}" must not reach the database unescaped`).toEqual([]);
      // An injection that worked would return rows it has no business returning.
      await expect(samples.invoiceGrid.locator('tbody tr')).toHaveCount(0);
    });
  }

  test('SC_N_09 an XSS payload is rendered as text, never executed', async ({ page }) => {
    const samples = await open(page);

    let dialog = false;
    page.on('dialog', async (d) => {
      dialog = true;
      await d.dismiss();
    });

    await samples.searchInvoice('<script>alert(1)</script>');

    expect(dialog, 'the payload must not execute').toBe(false);
    // And it must not have been planted in the page either.
    const planted = await page
      .locator('body script')
      .evaluateAll((els) => els.some((e) => /alert\(1\)/.test(e.textContent ?? '')));
    expect(planted, 'the payload must not be written into the DOM as markup').toBe(false);
  });

  // SC_N_10: the box takes all 600 characters; there is no cap.
  test.fail('SC_N_10 the search box caps how much can be pasted into it', async ({ page }) => {
    const samples = await open(page);

    await samples.search.fill('A'.repeat(600));
    const held = (await samples.search.inputValue()).length;

    console.log(`600 characters pasted, field holds ${held}`);
    expect(held, 'a search box with no maximum length is a needless payload surface').toBeLessThan(600);
  });

  // --- printing with nothing chosen ---------------------------------------

  /**
   * The refusal is an inline message beside the buttons, not a snackbar — which
   * is why an earlier pass that only watched the snackbars concluded, wrongly,
   * that these two buttons were silent.
   */
  const pleaseSelect = (page: Page) => page.getByText(/please select investigation invoice/i);

  test('SC_N_11 Print Token warns when no patient is selected', async ({ page }) => {
    const samples = await open(page);

    await samples.searchInvoice(MISSING_INVOICE); // guarantees no row is selected
    await samples.printToken.click();

    await expect(pleaseSelect(page)).toBeVisible({ timeout: 15_000 });
  });

  test('SC_N_12 Print Label warns when no invoice is selected', async ({ page }) => {
    const samples = await open(page);

    await samples.searchInvoice(MISSING_INVOICE);
    await samples.printLabel.click();

    await expect(pleaseSelect(page)).toBeVisible({ timeout: 15_000 });
  });

  test('SC_N_12b Print Label with an invoice open but no test ticked', async () => {
    test.skip(
      true,
      'The case asks for an invoice selected with every checkbox cleared. Print Label is also the button that ' +
        'commits a collection, so pressing it against a live uncollected invoice risks collecting the very ' +
        'samples the chain specs need. SC_N_12 above covers the no-invoice half; this half is worth doing by ' +
        'hand, or against a test database.',
    );
  });

  // --- the grids ----------------------------------------------------------

  test('SC_N_13 a collected sample cannot be collected again', async ({ page }) => {
    const samples = await open(page);

    // "Collected Patient" holds invoices whose samples are already in.
    await samples.filterBy('Collected Patient');
    const rows = samples.invoiceGrid.locator('tbody tr');
    test.skip((await rows.count()) === 0, 'no collected invoice on screen to check');

    await rows.first().click();
    await expect(samples.testRows.first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2_000);

    const collected = await samples.rows();
    collected.forEach((r) => console.log(`  ${r.labNo} | ${r.testName} | ${r.status}`));

    // Every test on this invoice is already in, and the screen says so. It does
    // still offer a checkbox, but that is for choosing which labels to reprint,
    // not for collecting again: sample-label-print.spec.ts ticks these same
    // rows, presses Print Label, and shows every status coming back unchanged.
    expect(collected.length).toBeGreaterThan(0);
    expect(
      collected.filter((r) => /not collected/i.test(r.status)),
      'nothing on a collected invoice should still read as uncollected',
    ).toEqual([]);
  });

  test('SC_N_19 changing a filter refreshes the grid rather than leaving it stale', async ({ page }) => {
    const samples = await open(page);

    // Counted, not rendered. The grid sits in a 216-pixel scroller and keeps
    // only the two dozen rows around the scroll position in the DOM, so an
    // earlier version of this test compared one capped count against another
    // and could not have failed whatever the screen did; see SC_N_27.
    await samples.filterBy('All Patient');
    const all = await samples.filterCount('All Patient');

    // No Show is pressed here — the filter alone has to take effect.
    await samples.filterBy('Collected Patient');
    const collected = await samples.filterCount('Collected Patient');

    console.log(`All Patient: ${all} invoice(s); Collected Patient: ${collected} invoice(s)`);
    expect(collected, 'the subset cannot be larger than the whole').toBeLessThanOrEqual(all ?? 0);
  });

  test('SC_N_22 selecting another patient clears the first patient\'s tests', async ({ page }) => {
    const samples = await open(page);

    await samples.filterBy('All Patient');
    const rows = samples.invoiceGrid.locator('tbody tr');
    test.skip((await rows.count()) < 2, 'need two invoices on screen to compare');

    const invoiceOf = async (index: number) =>
      (await rows.nth(index).locator('td').first().innerText()).replace(/\s+/g, ' ').trim();

    const first = await invoiceOf(0);
    await samples.selectInvoice(first);
    const firstTests = (await samples.rows()).map((r) => r.labNo);

    const second = await invoiceOf(1);
    await samples.selectInvoice(second);
    const secondTests = (await samples.rows()).map((r) => r.labNo);

    console.log(`invoice ${first}: ${firstTests.join(', ')}`);
    console.log(`invoice ${second}: ${secondTests.join(', ')}`);
    expect(
      secondTests.filter((lab) => firstTests.includes(lab)),
      'the second patient must not inherit the first patient\'s tests',
    ).toEqual([]);
  });

  test('SC_N_24 a test with no tube mapping renders a blank cell', async ({ page }) => {
    const samples = await open(page);

    await samples.filterBy('All Patient');
    const rows = samples.invoiceGrid.locator('tbody tr');
    test.skip((await rows.count()) === 0, 'no invoice on screen to inspect');

    await rows.first().click();
    await expect(samples.testRows.first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2_000);

    const tubes = (await samples.rows()).map((r) => ({ labNo: r.labNo, tube: r.tubeName }));
    tubes.forEach((t) => console.log(`  ${t.labNo} | tube: "${t.tube}"`));

    const broken = tubes.filter((t) => /null|undefined|NaN/i.test(t.tube));
    expect(broken, 'a missing tube must read as blank, not as "null"').toEqual([]);
  });

  test('SC_N_18 double-clicking Print Token does not break the screen', async ({ page }) => {
    const samples = await open(page);

    await samples.filterBy('All Patient');
    const rows = samples.invoiceGrid.locator('tbody tr');
    test.skip((await rows.count()) === 0, 'no invoice on screen to print for');

    const invoiceNo = (await rows.first().locator('td').first().innerText()).trim();
    await samples.selectInvoice(invoiceNo);

    await samples.clearSnackbars();
    await samples.printToken.dblclick();
    await page.waitForTimeout(8_000);

    console.log(`double-click said: ${JSON.stringify(await samples.snackbars())}`);
    // Whether a second token was written is a database question the UI cannot
    // answer; what this checks is that the screen survives the double press.
    await expect(samples.printToken).toBeEnabled();
    await expect(samples.invoiceGrid).toBeVisible();
  });

  // --- out of reach from here ---------------------------------------------

  test('SC_N_14 a second operator cannot collect the same lab number', async () => {
    test.skip(
      true,
      'Needs two operators collecting the same sample at once. Driving it would collect a live sample, and the ' +
        'loser of the race cannot be told apart from an ordinary "already collected" from outside. Manual.',
    );
  });

  test('SC_N_15 a role without permission cannot reach the screen', async () => {
    test.skip(
      true,
      'Needs a second account. test-data/users.json lists 36 roles but holds a password only for Admin02 — ' +
        'ASP.NET Identity stores the rest hashed. Fill in one restricted account and this becomes a real test.',
    );
  });

  test('SC_N_16 an expired session is sent back to the login page', async () => {
    test.skip(
      true,
      'Needs the session to lapse. The header counts down from about eight hours, so a run would have to idle ' +
        'that long; worth doing against a build with a short timeout instead.',
    );
  });

  test('SC_N_17 losing the network mid-collection commits nothing', async () => {
    test.skip(
      true,
      'The interesting half is a real collection cut off part-way, which would leave live data in whatever state ' +
        'the defect produces. Worth running against a test database, not this one.',
    );
  });

  test('SC_N_20 going back after a collection does not re-offer it', async () => {
    test.skip(
      true,
      'Needs a collection to go back from, and these tests collect nothing. Fold it into the two tests above ' +
        'instead, where a sample is genuinely being collected.',
    );
  });

  test('SC_N_23 a cancelled invoice is not collectable', async () => {
    test.skip(
      true,
      'Needs an invoice cancelled after billing. Cancelling one is a two-step approval on another screen ' +
        '(Send Request for Cancel, then Approve Cancel Request) and leaves a cancelled bill on the live ledger.',
    );
  });

  // --- what the screen gets right ------------------------------------------

  /**
   * Worth pinning down as much as the defects are: these are the parts of the
   * screen the cases above lean on, and a change to any of them would be felt
   * across the whole chain.
   */

  test('SC_N_25 the three collection states add up to "All Patient"', async ({ page }) => {
    const samples = await open(page);

    const counts: Partial<Record<PatientFilter, number>> = {};
    for (const filter of ['New Patient', 'Collected Patient', 'Partial Collected', 'All Patient'] as const) {
      const count = await samples.filterCount(filter);
      expect(count, `the "${filter}" filter should carry a count`).not.toBeNull();
      counts[filter] = count ?? 0;
    }

    console.log(`SC_N_25 ${JSON.stringify(counts)}`);
    expect(
      counts['New Patient']! + counts['Collected Patient']! + counts['Partial Collected']!,
      'every invoice is in exactly one of the three states, so they have to sum to the fourth',
    ).toBe(counts['All Patient']);
  });

  test('SC_N_26 the header checkbox clears and ticks every test row', async ({ page }) => {
    const samples = await open(page);
    await samples.filterBy('All Patient');
    test.skip((await samples.invoiceRows.count()) === 0, 'no invoice on screen to open');

    await samples.invoiceRows.first().click();
    await expect(samples.testRows.first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3_000);

    // A partly collected invoice carries rows whose box is ticked and disabled:
    // the sample is already in, and no header press can untick it. Those rows
    // are not the header checkbox's to move, so they are read out and set aside
    // rather than counted against it.
    const tickable = (rows: SampleRow[]) => rows.filter((r) => !r.locked);
    const start = await samples.rows();
    const locked = start.filter((r) => r.locked);
    if (locked.length) report('already collected, so beyond the header box', locked);
    test.skip(
      tickable(start).length === 0,
      'every test on this invoice is already collected — nothing left to tick',
    );

    // Selecting an invoice ticks everything, so the first press is the one
    // that clears. Nothing is committed either way: Print Label is not pressed.
    await expect(samples.selectAll, 'opening an invoice should leave every test ticked').toBeChecked();

    await samples.selectAll.click({ force: true });
    await page.waitForTimeout(2_500);
    expect(tickable(await samples.rows()).every((r) => !r.selected), 'one press should clear every row').toBe(true);

    await samples.selectAll.click({ force: true });
    await page.waitForTimeout(2_500);
    expect(tickable(await samples.rows()).every((r) => r.selected), 'a second press should tick them all again').toBe(
      true,
    );
  });

  test('SC_N_27 the rest of the list is reachable, a screenful at a time', async ({ page }) => {
    test.setTimeout(180_000);
    const samples = await openWeek(page);

    const counted = (await samples.filterCount('All Patient')) ?? 0;
    const rendered = await samples.invoiceRows.count();
    test.skip(counted <= rendered, 'the whole list fits on screen — there is nothing to scroll to');

    // The grid lives in a 216-pixel scroller and keeps only the rows around the
    // scroll position in the DOM. That is why `invoiceRows.count()` is never
    // the size of the result, and why the specs narrow the list with
    // `searchInvoice` before looking for a row rather than scrolling for it.
    const lastOnScreen = async () => (await samples.invoiceRows.last().locator('td').first().innerText()).trim();
    const seen = new Set<string>([await lastOnScreen()]);

    for (let i = 0; i < 3; i++) {
      await samples.invoiceRows.last().scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, 4_000);
      await page.waitForTimeout(3_000);
      seen.add(await lastOnScreen());
    }

    console.log(
      `SC_N_27 ${counted} invoice(s) counted, ${rendered} in the DOM at a time; ` +
        `scrolling reached ${JSON.stringify([...seen])}`,
    );
    expect(seen.size, 'scrolling must bring invoices the first screenful did not hold').toBeGreaterThan(1);
  });
});

/**
 * Defects, SC_B_01 onwards — found on 2026-11-04 against the live screen.
 *
 * Written the way investigation-cancel.spec.ts writes its own: each case says
 * what the screen ought to do and is marked `test.fail`, so the run stays green
 * while the defect stands and reports "expected to fail but passed" the day it
 * is fixed. None of them collects a sample — the only things pressed are Show,
 * the collection-point dropdown and the column headers.
 *
 * - **SC_B_01 — three of the invoice grid's four sortable columns do nothing.**
 *   Invoice No, Name, Date and Time are all drawn with a pointer cursor and a
 *   sort icon. Only Invoice No sorts: one click gives 2610280200001 upwards,
 *   another gives 2611040200002 downwards. Name, Date and Time leave the order
 *   exactly as it was, both before and after two clicks — so the operator
 *   cannot have the list in the order they are actually working in, which is
 *   time of arrival.
 *
 * - **SC_B_02 — Test Name moves the test grid's rows into no order at all.**
 *   Lab No beside it sorts and reverses properly. Test Name does shuffle the
 *   rows — so it is not simply dead — but neither press leaves them in name
 *   order: one click on a six-test invoice gave IMMUNOGLOBULIN -IGE, URINE
 *   ANALYSIS R/M/E, HBSAG-ELISA METHOD, VDRL-QUALITATIVE TEST, CBC With ESR*,
 *   ICT FOR TB. Looking a test up by name on a long invoice is no easier after
 *   the press than before it. (Read on 2026-11-05; until then the header looked
 *   dead, because the case only asked whether the rows moved.)
 *
 * - **SC_B_03 — "Sample collection at" filters nothing.** HUB, Home Collection,
 *   B2B and Outside Collection each return the same 657 invoices, in the same
 *   order, with the same four counts beside them. The empty "Select one" can be
 *   chosen as well, and changes nothing either. Whether the choice is recorded
 *   against the collection is a database question this screen cannot answer;
 *   what it plainly does not do is narrow the list to a collection point.
 *
 * - **SC_B_04 — a query still running looks exactly like a settled answer.**
 *   Over a 30-day range, "Collected Patient" took 20.1 seconds to fill,
 *   "All Patient" 10.1 and "Partial Collected" 5.0. For all of that time there
 *   is no spinner, no disabled control and no "loading" anywhere on the
 *   screen, and the grid holds one of two things: nothing at all, or the rows
 *   the previous query left behind. Both turned up on 2026-11-05 — an empty
 *   grid at second three with 2 beside the filter, and on another press the
 *   previous 27 rows still listed with the same 2 beside them; the answer
 *   landed at 10.9 seconds. An operator who looks at second five is reading
 *   either a confidently empty day or somebody else's invoices. SC_N_04 and
 *   SC_N_05 record that an empty result is never explained; this is the same
 *   silence doing real damage, because here there is something to find and the
 *   screen says otherwise.
 */

const WEEK_AGO = asPickerDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

/**
 * A week of invoices, under "All Patient".
 *
 * The grid cases need more than one day's worth: a column sort cannot be told
 * from a no-op on a list of one, and today's list is routinely that short.
 */
async function openWeek(page: Page) {
  const samples = new SampleCollectionPage(page);
  await samples.goto();
  await samples.recordSnackbars();
  await samples.setDateRange(WEEK_AGO, TODAY);
  await samples.show();
  await samples.filterBy('All Patient');
  return samples;
}

/**
 * What a header does, judged by the column either side of two clicks.
 *
 * There is no way to check a sort against the *right* order without knowing
 * what the right order is, so this watches the column move instead. A working
 * header reverses on the second click; one that leaves the column exactly as
 * it found it, twice over, did nothing at all. The two have to be told apart —
 * reading only "did the two clicks differ" would call a header that sorts once
 * and then sticks dead, and reading only "did the first click change
 * anything" would call a column that was already in the right order dead.
 */
type SortBehaviour = 'sorts' | 'sorts once, never reverses' | 'does nothing';

async function headerBehaviour(
  samples: SampleCollectionPage,
  grid: Locator,
  column: RegExp,
): Promise<{ behaviour: SortBehaviour; before: string[]; once: string[]; twice: string[] }> {
  const before = await samples.column(grid, column);
  await samples.sortBy(grid, column);
  const once = await samples.column(grid, column);
  await samples.sortBy(grid, column);
  const twice = await samples.column(grid, column);

  const moved = (a: string[], b: string[]) => a.join(' | ') !== b.join(' | ');
  const behaviour: SortBehaviour = moved(once, twice)
    ? 'sorts'
    : moved(before, once)
      ? 'sorts once, never reverses'
      : 'does nothing';
  return { behaviour, before, once, twice };
}

/**
 * Which way a column reads, judged on the values themselves.
 *
 * `headerBehaviour` can only see that a column moved, which is all there is to
 * go on when the right order is unknowable. Where it *is* knowable — a lab
 * number counts, a test name is alphabetical — "it moved" is too generous a
 * reading: a grid that reshuffles the rows into no order at all would pass it
 * while failing the only thing the header promises.
 */
type SortDirection = 'ascending' | 'descending' | 'neither';

function readsInOrder(values: string[]): SortDirection {
  const numeric = values.length > 0 && values.every((v) => /^\d+$/.test(v));
  const cmp = (a: string, b: string) =>
    numeric ? Number(a) - Number(b) : a.toUpperCase().localeCompare(b.toUpperCase());
  const steps = values.slice(1).map((v, i) => cmp(values[i], v));

  if (steps.every((d) => d <= 0)) return 'ascending';
  if (steps.every((d) => d >= 0)) return 'descending';
  return 'neither';
}

test.describe('Sample collection — defects', () => {
  test.fail('SC_B_01 every column the invoice grid draws as sortable sorts', async ({ page }) => {
    test.setTimeout(240_000);
    const samples = await openWeek(page);
    test.skip((await samples.invoiceRows.count()) < 3, 'need a few invoices on screen to tell a sort from a no-op');

    const broken: string[] = [];
    for (const [label, column] of [
      ['Invoice No', /invoice\s*no/i],
      ['Name', /^\s*name\s*$/i],
      ['Date', /^\s*date\s*$/i],
      ['Time', /^\s*time\s*$/i],
    ] as const) {
      const { behaviour, before, once, twice } = await headerBehaviour(samples, samples.invoiceGrid, column);
      if (behaviour !== 'sorts') broken.push(`${label} (${behaviour})`);
      console.log(`SC_B_01 ${label}: ${behaviour}`);
      console.log(`SC_B_01   before:           ${before.join(' | ').slice(0, 150)}`);
      console.log(`SC_B_01   after one click:  ${once.join(' | ').slice(0, 150)}`);
      console.log(`SC_B_01   after two clicks: ${twice.join(' | ').slice(0, 150)}`);
    }

    expect(broken, 'these headers are drawn sortable — pointer cursor, sort icon — and do not sort').toEqual([]);
  });

  test.fail('SC_B_02 the test grid sorts by Test Name as well as by Lab No', async ({ page }) => {
    test.setTimeout(240_000);
    const samples = await openWeek(page);
    test.skip((await samples.invoiceRows.count()) === 0, 'no invoice on screen to open');

    // Any invoice with a few tests on it will do; a single-test bill cannot
    // show a sort either way.
    for (let i = 0; i < (await samples.invoiceRows.count()); i++) {
      await samples.invoiceRows.nth(i).click();
      await page.waitForTimeout(4_000);
      if ((await samples.testRows.count()) >= 3) break;
    }
    test.skip((await samples.testRows.count()) < 3, 'no invoice on screen carries enough tests to sort');

    const broken: string[] = [];
    for (const [label, column] of [
      ['Lab No', /lab\s*no/i],
      ['Test Name', /test\s*name/i],
    ] as const) {
      const { behaviour, once, twice } = await headerBehaviour(samples, samples.testGrid, column);
      const [first, second] = [readsInOrder(once), readsInOrder(twice)];

      // Both columns have a knowable right order, so movement alone is not
      // enough: one click has to leave the column reading one way and the next
      // the other.
      const reverses =
        (first === 'ascending' && second === 'descending') || (first === 'descending' && second === 'ascending');
      if (!reverses) broken.push(`${label} (${behaviour}, reads ${first} then ${second})`);

      console.log(`SC_B_02 ${label}: ${behaviour}, reads ${first} then ${second}`);
      console.log(`SC_B_02   after one click:  ${once.join(' | ').slice(0, 150)}`);
      console.log(`SC_B_02   after two clicks: ${twice.join(' | ').slice(0, 150)}`);
    }

    expect(broken, 'the test grid draws this sortable too, and it puts the rows in no order').toEqual([]);
  });

  test.fail('SC_B_03 "Sample collection at" narrows the list to that collection point', async ({ page }) => {
    test.setTimeout(240_000);
    const samples = await openWeek(page);

    const readings = new Map<string, string>();
    for (const point of ['HUB', 'Home Collection', 'B2B', 'Outside Collection']) {
      await samples.collectionAt.selectOption({ label: point });
      await samples.show();

      const first = (await samples.invoiceRows.count())
        ? (await samples.invoiceRows.first().locator('td').first().innerText()).trim()
        : '—';
      const reading = `${await samples.filterCount('All Patient')} invoice(s), first ${first}`;
      readings.set(point, reading);
      console.log(`SC_B_03 ${point}: ${reading}`);
    }

    expect(
      new Set(readings.values()).size,
      'four collection points cannot all be holding the same invoices in the same order',
    ).toBeGreaterThan(1);
  });

  test.fail('SC_B_04 a query still running is told apart from an empty result', async ({ page }) => {
    test.setTimeout(300_000);

    const samples = new SampleCollectionPage(page);
    await samples.goto();
    await samples.recordSnackbars();

    // A month is enough to make the wait visible; a day answers too quickly
    // for there to be anything to see.
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    await samples.setDateRange(asPickerDate(monthAgo), TODAY);
    await samples.show();

    // What the grid holds before the press. The press replaces it with another
    // query's answer, and the gap between the two is the whole of this case —
    // so every reading below has to be able to tell the one from the other.
    const gridNow = async () => (await samples.invoiceRows.allInnerTexts()).join('|');
    const previous = await gridNow();

    const busyNow = () =>
      page
        .locator('[role="progressbar"], .spinner-border, .spinner-grow, [class*="spinner"]')
        .first()
        .isVisible()
        .catch(() => false);
    const saysLoading = () =>
      page
        .getByText(/loading|please wait|fetching/i)
        .first()
        .isVisible()
        .catch(() => false);

    // The slowest of the four, and the one an operator reaches for most.
    await samples.filterLabel('Collected Patient').click();
    const started = Date.now();

    /*
     * Watched from the press rather than read once at a fixed moment.
     *
     * A single reading three seconds in answers the wrong question twice over:
     * on a quick day the query is already back and the screen is blamed for a
     * wait nobody sat through, and on a slow one a spinner that came and went
     * before the reading would go unseen. So this follows the wait the whole
     * way, keeps every state the screen passes through, and asks only whether
     * the screen ever admitted to being busy.
     *
     * The answer has landed when the grid holds rows that are not the ones the
     * last query left — it empties on its way between the two, and an empty
     * grid is not an answer.
     */
    const readings: string[] = [];
    let answered = -1;
    let everSaidSo = false;
    let alreadyThere = false;
    let last = '';

    for (let look = 0; Date.now() - started < 80_000; look++) {
      const at = Date.now() - started;
      const shown = await gridNow();
      const rows = await samples.invoiceRows.count();
      const busy = await busyNow();
      const said = await saysLoading();
      const landed = shown !== previous && rows > 0;

      if (busy || said) everSaidSo = true;
      if (look === 0) alreadyThere = landed;

      const holding =
        rows === 0
          ? 'an empty grid'
          : shown === previous
            ? `the previous query's ${rows} row(s)`
            : `${rows} row(s) of its own`;
      const reading =
        `${holding}, badge says ${await samples.filterCount('Collected Patient')}, ` +
        `busy indicator: ${busy}, "loading" anywhere: ${said}`;
      if (reading !== last) {
        readings.push(`${at}ms — ${reading}`);
        last = reading;
      }

      if (landed) {
        answered = at;
        break;
      }
      await page.waitForTimeout(500);
    }

    // Worth measuring either way: the number is the finding.
    console.log(`SC_B_04 the answer landed after ${answered < 0 ? 'over 80 seconds' : `${answered}ms`}`);
    readings.forEach((r) => console.log(`SC_B_04   ${r}`));

    test.skip(
      alreadyThere,
      '"Collected Patient" was already on screen at the first look — there was no wait to watch',
    );

    expect(
      everSaidSo,
      'while the grid is being fetched the screen has to say so somewhere — what it holds in the meantime is ' +
        'either the previous query\'s rows or an empty grid with a count beside it, and neither can be told ' +
        'from an answer that has arrived',
    ).toBe(true);
  });
});
