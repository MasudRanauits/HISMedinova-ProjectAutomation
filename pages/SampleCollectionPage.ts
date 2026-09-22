import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
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
  }

  async goto() {
    await this.page.goto(ROUTES.sampleCollection);
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

  /** Re-queries the invoice grid for the current date range and filters. */
  async show() {
    await this.showButton.click();
    await this.page.waitForTimeout(6_000);
  }

  /** Narrows the invoice grid to one collection state. */
  async filterBy(filter: PatientFilter) {
    await this.page.getByText(filter, { exact: true }).click();
    await this.page.waitForTimeout(4_000);
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
   */
  async locateInvoice(invoiceNo: string): Promise<PatientFilter | null> {
    for (const filter of ['New Patient', 'Partial Collected', 'Collected Patient'] as const) {
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
        listedUnder
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
   * collection, unlike the row checkbox, which the app drops once a sample has
   * been collected.
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
      out.push({
        labNo,
        testName,
        qty,
        labelText,
        tubeName,
        status,
        sampleType,
        isUrgent,
        // A collected row has no checkbox left to read.
        selected: (await box.count()) ? await box.isChecked() : false,
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

  /** Commits the ticked rows. Returns once the app has answered. */
  async collectSelected() {
    await this.printLabel.scrollIntoViewIfNeeded();
    await this.printLabel.click();
    await this.page.waitForTimeout(10_000);
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
