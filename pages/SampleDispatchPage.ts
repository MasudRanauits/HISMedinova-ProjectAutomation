import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { settledCount } from '../utils/blazor';
import { clearSnackbars, readSnackbars, recordSnackbars } from '../utils/snackbars';

/** One test row of the dispatch grid. */
export type DispatchRow = {
  labNo: string;
  testName: string;
  qty: string;
  labelText: string;
  sampleStatus: string;
  collectedBy: string;
  collectedDate: string;
  carriedBy: string;
  carriedDate: string;
  selected: boolean;
};

export type DispatchFilter = 'Not Dispatched' | 'Partial Dispatched' | 'Dispatched';

const pad = (n: number) => String(n).padStart(2, '0');
/** The pickers on this screen read and write DD-MM-YYYY. */
export const asPickerDate = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

/**
 * Sample dispatch — the second tab of /diagnostic/sample-collection.
 *
 * It shares the route with sample collection, so the collection tab's markup
 * stays in the DOM while hidden; anything matched loosely here has to be
 * narrowed to what is visible, which is why the search box is found among the
 * *visible* unlabelled inputs rather than by id (the ids are per-circuit).
 *
 * Dispatch hands samples to a carrier: tick the tests, pick a carrier, then
 * "Send to carrier".
 */
export class SampleDispatchPage {
  readonly page: Page;
  readonly tab: Locator;
  readonly startDate: Locator;
  readonly endDate: Locator;
  readonly showButton: Locator;
  readonly search: Locator;
  readonly carrierSearch: Locator;
  readonly sendToCarrier: Locator;
  readonly invoiceGrid: Locator;
  readonly testGrid: Locator;
  readonly suggestions: Locator;

  constructor(page: Page) {
    this.page = page;

    this.tab = page.getByText(/^\s*sample dispatch\s*$/i).first();

    // flatpickr keeps a hidden original input beside the visible alternate one.
    this.startDate = page.locator('input.input.form-control[placeholder="Start Date"]');
    this.endDate = page.locator('input.input.form-control[placeholder="End Date"]');

    this.showButton = page.getByRole('button', { name: /^show$/i });
    this.search = page.locator('input.form-control:not([placeholder]):visible').first();
    this.carrierSearch = page.locator('input[placeholder="Carrier Search..."]');
    this.sendToCarrier = page.getByRole('button', { name: /send to carrier/i });

    // The collection tab keeps an INVOICE NO table of its own in the DOM while
    // hidden, so this has to be pinned to the visible one.
    this.invoiceGrid = page
      .locator('table:visible')
      .filter({ has: page.locator('th').filter({ hasText: /invoice\s*no/i }) })
      .first();
    this.testGrid = page
      .locator('table:visible')
      .filter({ has: page.locator('th').filter({ hasText: /carried\s*by/i }) })
      .first();

    this.suggestions = page.locator('.dropdown-menu.show a.dropdown-item.b-is-autocomplete-suggestion');
  }

  /** Opens the route and switches to the dispatch tab. */
  async goto() {
    await this.page.goto(ROUTES.sampleCollection);
    await expect(this.page.locator('#searchSample')).toBeVisible({ timeout: 60_000 });
    await this.tab.click();
    await expect(this.sendToCarrier).toBeVisible({ timeout: 60_000 });
  }

  /** flatpickr only commits a typed date on Enter. */
  private async setDate(input: Locator, value: string) {
    await input.click();
    await input.fill('');
    await input.pressSequentially(value, { delay: 60 });
    await this.page.keyboard.press('Enter');
    await expect(input).toHaveValue(value);
  }

  async setDateRange(from: Date, to: Date) {
    await this.setDate(this.startDate, asPickerDate(from));
    await this.setDate(this.endDate, asPickerDate(to));
  }

  /** The invoice grid's rows, whichever filter is on. */
  get invoiceRows(): Locator {
    return this.invoiceGrid.locator('tbody tr');
  }

  /**
   * Each of these three asks the server to rebuild the invoice grid, and each
   * used to sleep a flat few seconds waiting for it — fifteen seconds a pass,
   * and this spec makes two passes. That is both slower than it needs to be on
   * a quiet server and not long enough on a busy one, which is what ran the
   * second test out of its budget mid-screen. Waiting for the grid itself is
   * quicker when it is quick and patient when it is not.
   */
  async show() {
    await this.showButton.click();
    await settledCount(this.invoiceRows);
  }

  /** The box filters the invoice grid as it is typed; no Show is needed. */
  async searchInvoice(invoiceNo: string) {
    await this.search.fill(invoiceNo);
    // Settled means the row asked for is on screen — or, where it is not on the
    // list at all, that the grid has stopped changing without it. Both specs
    // expect the invoice to be there, so this nearly always takes the first.
    await this.invoiceRow(invoiceNo)
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    await settledCount(this.invoiceRows, { quiet: 1_000 });
  }

  async filterBy(filter: DispatchFilter) {
    await this.page.getByText(filter, { exact: true }).click();
    await settledCount(this.invoiceRows);
  }

  invoiceRow(invoiceNo: string): Locator {
    return this.invoiceGrid.locator('tbody tr').filter({ hasText: invoiceNo }).first();
  }

  async selectInvoice(invoiceNo: string) {
    const row = this.invoiceRow(invoiceNo);

    // A dispatched test leaves the "Not Dispatched" list for good, so pointing
    // this screen at a spent invoice finds nothing at all. Say so, rather than
    // waiting out a minute on a row that is never going to appear.
    const found = await row
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    expect(
      found,
      `invoice ${invoiceNo} is not in the list on screen. If its samples have already been dispatched it will not be, ` +
        `and this spec needs one that has not: run the investigation spec to raise a fresh invoice — it records the ` +
        `new number for the sample specs — or point partialSampleDispatch.invoiceNo at one still pending.`,
    ).toBe(true);

    await row.click();
    await expect(this.testRows.first()).toBeVisible({ timeout: 60_000 });
    // The tests arrive a row at a time; read once they have all landed.
    await settledCount(this.testRows);
  }

  /** Test rows, without any department header row. */
  get testRows(): Locator {
    return this.testGrid.locator('tbody tr:not(.table-secondary)');
  }

  testRow(testName: string): Locator {
    return this.testRows.filter({ hasText: testName }).first();
  }

  async rows(): Promise<DispatchRow[]> {
    const rows = this.testRows;
    const out: DispatchRow[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const cells = (await row.locator('td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      const [labNo, testName, qty, labelText, sampleStatus, collectedBy, collectedDate, carriedBy, carriedDate] =
        cells;
      const box = row.locator('input[type="checkbox"]');
      out.push({
        labNo,
        testName,
        qty,
        labelText,
        sampleStatus,
        collectedBy,
        collectedDate,
        carriedBy,
        carriedDate,
        selected: (await box.count()) ? await box.isChecked() : false,
      });
    }

    return out;
  }

  /**
   * Clicks a row's checkbox and reports whether the tick stuck.
   *
   * Without a carrier the app quietly refuses: the click goes through, the
   * circuit round-trips, and the row comes back unticked. Use this where the
   * refusal is the point; `selectOnly` insists instead.
   */
  async tryTick(testName: string): Promise<boolean> {
    const box = this.testRow(testName).locator('input[type="checkbox"]');
    await box.click({ force: true });
    await this.page.waitForTimeout(2_500);
    return box.isChecked();
  }

  /** Ticks exactly the tests named and clears the rest. Needs a carrier set. */
  async selectOnly(testNames: string[]) {
    const rows = this.testRows;

    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const name = (await row.locator('td').nth(1).innerText()).replace(/\s+/g, ' ').trim();
      const wanted = testNames.some((t) => name.toUpperCase().includes(t.toUpperCase()));
      const box = row.locator('input[type="checkbox"]');
      if (!(await box.count())) continue;

      if ((await box.isChecked()) !== wanted) {
        await box.click({ force: true });
        await this.page.waitForTimeout(800);
        await expect(box).toBeChecked({ checked: wanted });
      }
    }
  }

  /** Picks a carrier from the typeahead. Returns the suggestion taken. */
  async pickCarrier(query: string, match?: RegExp, attempts = 3): Promise<string> {
    let texts: string[] = [];

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.carrierSearch.scrollIntoViewIfNeeded();
      await this.carrierSearch.click({ force: true });
      await this.carrierSearch.fill('');
      await this.carrierSearch.pressSequentially(query, { delay: 110 });

      const appeared = await this.suggestions
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      if (!appeared) continue;

      await this.page.waitForTimeout(1_500);

      texts = [];
      for (let i = 0; i < (await this.suggestions.count()); i++) {
        texts.push((await this.suggestions.nth(i).innerText()).replace(/\s+/g, ' ').trim());
      }

      const index = match ? texts.findIndex((t) => match.test(t)) : 0;
      if (index < 0) break;

      const chosen = texts[index];
      await this.suggestions.nth(index).click();
      await expect(this.suggestions).toHaveCount(0, { timeout: 30_000 });
      return chosen;
    }

    throw new Error(
      `no carrier for "${query}" matched ${match} after ${attempts} attempts; last list:\n${texts.join('\n') || '(empty)'}`,
    );
  }

  async selectedCarrier(): Promise<string> {
    return this.carrierSearch.inputValue();
  }

  async dispatch() {
    await this.sendToCarrier.scrollIntoViewIfNeeded();
    await this.sendToCarrier.click();
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
