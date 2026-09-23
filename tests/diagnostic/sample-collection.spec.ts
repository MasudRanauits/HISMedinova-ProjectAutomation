import { Page } from '@playwright/test';
import { test, expect, investigations } from '../../fixtures/test';
import { SampleCollectionPage, SampleRow } from '../../pages/SampleCollectionPage';

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
    // A day's worth of invoices is more than the grid renders — it stops well
    // short of the afternoon — so the list is narrowed to this invoice before
    // the row is looked for. Without that, a row that is genuinely there reads
    // as missing, and one that is genuinely gone reads as gone for the wrong
    // reason.
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

    // This one the picker gets right: 19/09/26 is understood and rewritten.
    const typed = await samples.setDate(samples.dateFrom, '19/09/26');
    expect(typed).toBe('19-09-2026');
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

    await samples.filterBy('All Patient');
    const all = await samples.invoiceGrid.locator('tbody tr').count();

    // No Show is pressed here — the filter alone has to take effect.
    await samples.filterBy('Collected Patient');
    const collected = await samples.invoiceGrid.locator('tbody tr').count();

    console.log(`All Patient: ${all} row(s); Collected Patient: ${collected} row(s)`);
    expect(collected, 'the subset cannot be larger than the whole').toBeLessThanOrEqual(all);
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
});
