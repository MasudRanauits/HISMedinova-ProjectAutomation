import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { settledCount, settledTexts } from '../utils/blazor';
import { clearSnackbars, readSnackbars, recordSnackbars } from '../utils/snackbars';

/** One collectable test on the invoice. */
export type SampleRow = {
  labNo: string;
  testName: string;
  qty: string;
  labelText: string;
  tubeName: string;
  status: string;
  sampleType: string;
  isUrgent: string;
  selected: boolean;
  /** Ticked and beyond the operator's reach — the row has already been collected. */
  locked: boolean;
};

/** The patient filters above the invoice grid. */
export type PatientFilter = 'New Patient' | 'Collected Patient' | 'Partial Collected' | 'All Patient';

/**
 * Sample collection (/diagnostic/sample-collection).
 *
 * Picking an invoice fills the lower grid with its collectable tests, grouped
 * by department — the group headers are rows of their own (`.table-secondary`)
 * with no checkbox, so every row lookup here goes through `testRows`, which
 * keeps only the rows that carry one. Selecting the invoice ticks every test;
 * a partial collection is made by clearing the ones being left behind.
 *
 * There is no separate "collect" button: "Print Label" is what commits the
 * ticked rows.
 */
export class SampleCollectionPage {
  readonly page: Page;
  readonly invoiceGrid: Locator;
  readonly testGrid: Locator;
  readonly search: Locator;
  readonly dateFrom: Locator;
  readonly dateTo: Locator;
  readonly showButton: Locator;
  readonly printLabel: Locator;
  readonly printToken: Locator;
  readonly selectAll: Locator;
  readonly collectionAt: Locator;

  constructor(page: Page) {
    this.page = page;

    // The unlabelled box above the date range; it filters the invoice grid.
    this.search = page.locator('#searchSample');

    // Both pickers carry the same "DD-MM-YYYY" placeholder and the ids change
    // per circuit, so they are told apart by their order on the page. These are
    // flatpickr's visible alternate inputs; the hidden originals sit beside
    // them and are not what a person types into.
    this.dateFrom = page.locator('input.input.form-control').first();
    this.dateTo = page.locator('input.input.form-control').nth(1);

    this.invoiceGrid = page
      .locator('table')
      .filter({ has: page.locator('th').filter({ hasText: /invoice\s*no/i }) })
      .first();
    this.testGrid = page
      .locator('table')
      .filter({ has: page.locator('th').filter({ hasText: /test\s*name/i }) })
      .first();

    this.showButton = page.getByRole('button', { name: /^show$/i });
    this.printLabel = page.getByRole('button', { name: /print label/i });
    this.printToken = page.getByRole('button', { name: /print token/i });
    this.selectAll = this.testGrid.locator('thead input[type="checkbox"]');

    // "Sample collection at" — HUB, Home Collection, B2B, Outside Collection.
    // The only select on the screen; matched on one of its own options rather
    // than on an id, which changes per circuit like every other id here.
    this.collectionAt = page
      .locator('select')
      .filter({ has: page.locator('option', { hasText: /home collection/i }) })
      .first();
  }

  /**
   * Opens the screen.
   *
   * Two departures from a bare `goto`, both of them about how long this screen
   * takes to answer — and it is the slowest in the suite, opened afresh by
   * nearly every test in the file.
   *
   * It settles for `domcontentloaded` rather than Playwright's default `load`.
   * The load event waits on every last request the document started, and a
   * Blazor Server page is in no hurry to finish those; the grid has been on
   * screen and ready to drive for half a minute by the time it fires, and
   * waiting for it has timed the navigation out on a page that was perfectly
   * usable. What readiness actually means here is the grid being drawn, which
   * is waited for on the next line and was always the real gate.
   *
   * And the navigation is given a minute and a half rather than the default
   * thirty seconds, because the document itself has taken past half a minute
   * to arrive on a busy afternoon. Slow is not the same as broken, and the
   * test has the budget to wait.
   */
  async goto() {
    await this.page.goto(ROUTES.sampleCollection, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await expect(this.invoiceGrid).toBeVisible({ timeout: 60_000 });
  }

  /**
   * Types a date into one of the pickers and returns what the field holds
   * afterwards.
   *
   * flatpickr only commits on Enter, and it rewrites whatever it is given into
   * its own format — which is why this hands back the resulting value instead
   * of asserting: a date it dislikes comes back changed rather than refused.
   */
  async setDate(input: Locator, value: string): Promise<string> {
    await input.click();
    await input.fill('');
    if (value) {
      await input.pressSequentially(value, { delay: 50 });
      await this.page.keyboard.press('Enter');
    } else {
      await this.page.keyboard.press('Tab');
    }
    await this.page.waitForTimeout(800);
    return input.inputValue();
  }

  async setDateRange(from: string, to: string) {
    await this.setDate(this.dateFrom, from);
    await this.setDate(this.dateTo, to);
  }

  /** The invoice grid's rows, whichever filter is on. */
  get invoiceRows(): Locator {
    return this.invoiceGrid.locator('tbody tr');
  }

  /**
   * Both of these ask the server to rebuild the invoice grid, and each used to
   * sleep a flat few seconds waiting for it.
   *
   * The grid does not change in place: it empties, and the new rows arrive a
   * round trip later — a tenth of a second apart on a quiet server, and long
   * enough apart on a busy one to read past the sleep. A reading taken in that
   * gap is either nothing at all or the *previous* filter's rows, which is how
   * SC_N_19 came to see "All Patient" hold no rows and "Collected Patient"
   * hold six. Waiting for the count to come to rest covers both, and the quiet
   * window is set wide enough to sit through the empty moment rather than
   * settle on it.
   *
   * There is nothing better to wait on: the screen draws no busy indicator,
   * and the Blazor circuit carries a keepalive every second, so it never falls
   * quiet to mark the end of a round trip.
   */
  private async gridRebuilt() {
    await settledCount(this.invoiceRows, { quiet: 2_500, timeout: 30_000 });
  }

  /** Re-queries the invoice grid for the current date range and filters. */
  async show() {
    await this.showButton.click();
    await this.gridRebuilt();
  }

  /**
   * The label of one of the patient filters, as the page draws it.
   *
   * The filters are radios, and the app now writes the number of invoices in
   * each state into the label beside the words — `New Patient<span
   * class="badge">2</span>` — so the label reads "New Patient2" and the words
   * on their own match nothing at all. They are matched with that count
   * allowed after them and anchored at both ends, which still tells
   * "Collected Patient" from "Partial Collected".
   *
   * The dispatch tab beside this one keeps filters of its own in the DOM while
   * hidden, so the match is narrowed to what is on screen.
   */
  filterLabel(filter: PatientFilter): Locator {
    return this.page
      .locator('label.form-check-label:visible')
      .filter({ hasText: new RegExp(`^\\s*${filter}\\s*\\d*\\s*$`) })
      .first();
  }

  /** Narrows the invoice grid to one collection state. */
  async filterBy(filter: PatientFilter) {
    const label = this.filterLabel(filter);
    await expect(label, `there is no "${filter}" filter on this screen`).toBeVisible({ timeout: 30_000 });
    await label.click();
    await this.gridRebuilt();
  }

  /**
   * The number the app writes into a filter's label, or null where it writes
   * none.
   *
   * This is the screen's own count of the invoices in a state, and it is not
   * the same thing as the number of rows on screen: the invoice grid sits in a
   * 216-pixel scroller and keeps only the two dozen rows around the scroll
   * position in the DOM, so a count of `invoiceRows` is a count of what has
   * been rendered, never of what the filter matched. Anything comparing one
   * list against another has to compare these.
   */
  async filterCount(filter: PatientFilter): Promise<number | null> {
    const text = (await this.filterLabel(filter).innerText()).replace(/\s+/g, ' ').trim();
    const digits = text.match(/(\d+)\s*$/);
    return digits ? Number(digits[1]) : null;
  }

  /** A column header, by the words on it. */
  header(grid: Locator, name: RegExp): Locator {
    return grid.locator('thead th').filter({ hasText: name }).first();
  }

  /** Where a column sits in a grid, or -1 if it has no such column. */
  private async columnIndex(grid: Locator, name: RegExp): Promise<number> {
    const headers = (await grid.locator('thead th').allInnerTexts()).map((h) => h.replace(/\s+/g, ' ').trim());
    return headers.findIndex((h) => name.test(h));
  }

  /** Every value in one column of a grid, top to bottom. */
  async column(grid: Locator, name: RegExp): Promise<string[]> {
    const index = await this.columnIndex(grid, name);
    expect(index, `this grid has no column matching ${name}`).toBeGreaterThan(-1);

    const cells = grid.locator(`tbody tr:not(.table-secondary) td:nth-child(${index + 1})`);
    return (await cells.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  }

  /**
   * Clicks a column header and waits for the rows to come to rest under it.
   *
   * `gridRebuilt` is no help here: a sort returns the same rows in a different
   * order, so the count never moves and a reading taken too early is the old
   * order read with a straight face.
   */
  async sortBy(grid: Locator, name: RegExp) {
    await this.header(grid, name).click();
    await settledTexts(grid.locator('tbody tr'), { quiet: 2_000, timeout: 30_000 });
  }

  invoiceRow(invoiceNo: string): Locator {
    return this.invoiceGrid.locator('tbody tr').filter({ hasText: invoiceNo }).first();
  }

  /**
   * Which patient filter an invoice is listed under, or null if the screen has
   * not heard of it at all in the current date range.
   *
   * Used to explain a missing row: an invoice absent from "New Patient" has
   * almost always been collected already rather than gone missing, and saying
   * which list it did turn up in is the difference between a puzzle and an
   * answer. It leaves the filter it found the invoice under selected.
   *
   * "All Patient" is searched last and means something weaker than the other
   * three: it holds every invoice, so finding one only there says the screen
   * has heard of the invoice but has not put it on any of its working lists.
   * Worth saying all the same — it is the difference between an invoice that
   * has moved on and one the screen has lost track of.
   */
  async locateInvoice(invoiceNo: string): Promise<PatientFilter | null> {
    for (const filter of ['New Patient', 'Partial Collected', 'Collected Patient', 'All Patient'] as const) {
      await this.filterBy(filter);
      if (await this.invoiceRow(invoiceNo).isVisible()) return filter;
    }
    return null;
  }

  /** Loads an invoice's tests. Every test is ticked as a side effect. */
  async selectInvoice(invoiceNo: string) {
    const row = this.invoiceRow(invoiceNo);

    // A collected test leaves the "New Patient" list for good, so pointing this
    // screen at a spent invoice finds nothing at all. Say so, rather than
    // waiting out a minute on a row that is never going to appear.
    const found = await row
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    if (!found) {
      // Worth the extra half minute: this is the end of the test either way, and
      // the two cases want different things done about them.
      const range = `${await this.dateFrom.inputValue()}..${await this.dateTo.inputValue()}`;
      const listedUnder = await this.locateInvoice(invoiceNo);
      expect(
        found,
        listedUnder === 'All Patient'
          ? `invoice ${invoiceNo} is not in the list this spec is working from, and "All Patient" is the only ` +
            `one holding it — the screen knows the invoice but has put it on none of its working lists. Reach ` +
            `it through "All Patient", or run the chain from 1-register for an invoice with nothing collected ` +
            `yet.`
          : listedUnder
          ? `invoice ${invoiceNo} is not in the list this spec is working from — it is listed under ` +
            `"${listedUnder}", so its samples have already been collected, and a collected invoice cannot be ` +
            `collected again. Run the chain from 1-register for a fresh one; note that INVOICE_POST=0 posts no ` +
            `invoice and so leaves the previous number in test-data/investigations.json, which is how a spent ` +
            `invoice ends up here.`
          : `invoice ${invoiceNo} is on none of this screen's lists for ${range}. Either it was never posted — ` +
            `INVOICE_POST=0 stops short of posting and leaves the previous number in ` +
            `test-data/investigations.json — or it falls outside that date range.`,
      ).toBe(true);
    }

    await row.click();
    await expect(this.testRows.first()).toBeVisible({ timeout: 60_000 });
    // The grid is filled a row at a time; let it finish before it is read.
    await this.page.waitForTimeout(3_000);
  }

  /**
   * The test rows, without the department headers.
   *
   * The headers are the `.table-secondary` rows — the one marker that survives
   * collection, unlike the row checkbox, which the app either drops or disables
   * once a sample has been collected.
   */
  get testRows(): Locator {
    return this.testGrid.locator('tbody tr:not(.table-secondary)');
  }

  /** The row for a test, matched on its name. */
  testRow(testName: string): Locator {
    return this.testRows.filter({ hasText: testName }).first();
  }

  async rows(): Promise<SampleRow[]> {
    const rows = this.testRows;
    const out: SampleRow[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const cells = (await row.locator('td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      const [labNo, testName, qty, labelText, tubeName, status, sampleType, isUrgent] = cells;
      const box = row.locator('input[type="checkbox"]');
      const hasBox = (await box.count()) > 0;
      out.push({
        labNo,
        testName,
        qty,
        labelText,
        tubeName,
        status,
        sampleType,
        isUrgent,
        // A collected row either loses its checkbox altogether or keeps it
        // ticked and disabled, depending on how far along the sample is.
        selected: hasBox ? await box.isChecked() : false,
        locked: hasBox ? !(await box.isEnabled()) : true,
      });
    }

    return out;
  }

  /**
   * Ticks exactly the tests named and clears the rest.
   *
   * Selecting an invoice ticks everything, so a partial collection is a matter
   * of clearing what is not being collected yet.
   */
  async selectOnly(testNames: string[]) {
    const rows = this.testRows;

    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const name = (await row.locator('td').nth(1).innerText()).replace(/\s+/g, ' ').trim();
      const wanted = testNames.some((t) => name.toUpperCase().includes(t.toUpperCase()));
      const box = row.locator('input[type="checkbox"]');

      if ((await box.isChecked()) !== wanted) {
        await box.click({ force: true });
        // Each tick round-trips over the circuit before the next one is read.
        await this.page.waitForTimeout(800);
        await expect(box).toBeChecked({ checked: wanted });
      }
    }
  }

  /** Filters the invoice grid. The box filters as it is typed; Show re-queries. */
  async searchInvoice(invoiceNo: string) {
    await this.search.fill(invoiceNo);
    await this.page.waitForTimeout(2_000);
    await this.showButton.click();
    await this.page.waitForTimeout(5_000);
  }

  /**
   * Commits the ticked rows. Returns once the app has answered.
   *
   * The answer takes its time and arrives in pieces: the grid empties, the
   * statuses come back one round trip later, and on a busy server the rows can
   * still be reading "Not Collected" well after the ten flat seconds this used
   * to sleep. Returning inside that window hands the caller the screen as it
   * was before the collection — which is how the first test came to walk on
   * and ask for an invoice the server had not finished making partial yet, and
   * then spend its remaining minute waiting for a row that was on its way. So
   * the grid is waited on until it stops changing instead, with the quiet
   * window wide enough to sit through the empty moment rather than settle on
   * it.
   */
  async collectSelected() {
    await this.printLabel.scrollIntoViewIfNeeded();
    await this.printLabel.click();
    await settledTexts(this.testRows, { quiet: 4_000, timeout: 60_000 });
  }

  /** The print button in a test row's PRINT column — one label, that test only. */
  rowPrintButton(testName: string): Locator {
    return this.testRow(testName).locator('button.btn-print');
  }

  /** Prints the label for a single test. */
  async printRowLabel(testName: string) {
    const button = this.rowPrintButton(testName);
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await this.page.waitForTimeout(5_000);
  }

  /** Prints the labels for the whole invoice. */
  async printAllLabels() {
    await this.printLabel.scrollIntoViewIfNeeded();
    await this.printLabel.click();
    await this.page.waitForTimeout(8_000);
  }

  async printPatientToken() {
    await this.printToken.scrollIntoViewIfNeeded();
    await this.printToken.click();
    await this.page.waitForTimeout(8_000);
  }

  async recordSnackbars() {
    await recordSnackbars(this.page);
  }

  async snackbars(): Promise<string[]> {
    return readSnackbars(this.page);
  }

  async clearSnackbars() {
    await clearSnackbars(this.page);
  }
}
