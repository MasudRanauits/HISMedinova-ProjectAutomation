import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { clearSnackbars, readSnackbars, recordSnackbars } from '../utils/snackbars';
import { asPickerDate } from './SampleDispatchPage';

/** One test row of the acknowledgement grid. */
export type AcknowledgementRow = {
  labNo: string;
  testName: string;
  qty: string;
  label: string;
  sampleStatus: string;
  collectedBy: string;
  collectedDate: string;
  carriedBy: string;
  carriedDate: string;
  receivedBy: string;
  receivedDate: string;
  selected: boolean;
};

export type AcknowledgementFilter = 'Not Acknowledged' | 'Partial Acknowledged' | 'Acknowledged';

/**
 * Sample acknowledgement (/diagnostic/sample-acknowledgement-lab).
 *
 * Where dispatch hands samples to a carrier, this is the lab receiving them.
 * Same shape as the dispatch screen — a date range, a status filter, an invoice
 * grid and a test grid — but with no carrier to choose: tick the tests and
 * press "Acknowledge Sample".
 */
export class SampleAcknowledgementPage {
  readonly page: Page;
  readonly startDate: Locator;
  readonly endDate: Locator;
  readonly showButton: Locator;
  readonly search: Locator;
  readonly acknowledgeButton: Locator;
  readonly rejectButton: Locator;
  readonly invoiceGrid: Locator;
  readonly testGrid: Locator;

  constructor(page: Page) {
    this.page = page;

    // flatpickr keeps a hidden original input beside the visible alternate one.
    this.startDate = page.locator('input.input.form-control[placeholder="Start Date"]');
    this.endDate = page.locator('input.input.form-control[placeholder="End Date"]');

    this.showButton = page.getByRole('button', { name: /^show$/i });
    this.search = page.locator('input[placeholder="Search"]');
    this.acknowledgeButton = page.getByRole('button', { name: /acknowledge sample/i });
    this.rejectButton = page.getByRole('button', { name: /reject sample/i });

    this.invoiceGrid = page
      .locator('table')
      .filter({ has: page.locator('th').filter({ hasText: /invoice\s*no/i }) })
      .first();
    this.testGrid = page
      .locator('table')
      .filter({ has: page.locator('th').filter({ hasText: /reject\s*remarks/i }) })
      .first();
  }

  async goto() {
    await this.page.goto(ROUTES.sampleAcknowledgementLab);
    await expect(this.acknowledgeButton).toBeVisible({ timeout: 60_000 });
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

  async show() {
    await this.showButton.click();
    await this.page.waitForTimeout(6_000);
  }

  /** The box filters the invoice grid as it is typed. */
  async searchInvoice(invoiceNo: string) {
    await this.search.fill(invoiceNo);
    await this.page.waitForTimeout(4_000);
  }

  async filterBy(filter: AcknowledgementFilter) {
    await this.page.getByText(filter, { exact: true }).click();
    await this.page.waitForTimeout(5_000);
  }

  invoiceRow(invoiceNo: string): Locator {
    return this.invoiceGrid.locator('tbody tr').filter({ hasText: invoiceNo }).first();
  }

  async selectInvoice(invoiceNo: string) {
    const row = this.invoiceRow(invoiceNo);

    // An acknowledged test leaves the "Not Acknowledged" list for good, so
    // pointing this screen at a spent invoice finds nothing at all. Say so,
    // rather than waiting out a minute on a row that is never going to appear.
    const found = await row
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    expect(
      found,
      `invoice ${invoiceNo} is not in the list on screen. If its samples have already been acknowledged it will not ` +
        `be, and this spec needs one that has not: run the investigation spec to raise a fresh invoice — it records ` +
        `the new number for the sample specs — or point partialSampleAcknowledgement.invoiceNo at one still pending.`,
    ).toBe(true);

    await row.click();
    await expect(this.testRows.first()).toBeVisible({ timeout: 60_000 });
    await this.page.waitForTimeout(3_000);
  }

  /** Test rows, without any department header row. */
  get testRows(): Locator {
    return this.testGrid.locator('tbody tr:not(.table-secondary)');
  }

  testRow(testName: string): Locator {
    return this.testRows.filter({ hasText: testName }).first();
  }

  async rows(): Promise<AcknowledgementRow[]> {
    const rows = this.testRows;
    const out: AcknowledgementRow[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const cells = (await row.locator('td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      const [
        labNo,
        testName,
        qty,
        label,
        sampleStatus,
        collectedBy,
        collectedDate,
        carriedBy,
        carriedDate,
        receivedBy,
        receivedDate,
      ] = cells;
      const box = row.locator('input[type="checkbox"]');
      out.push({
        labNo,
        testName,
        qty,
        label,
        sampleStatus,
        collectedBy,
        collectedDate,
        carriedBy,
        carriedDate,
        receivedBy,
        receivedDate,
        selected: (await box.count()) ? await box.isChecked() : false,
      });
    }

    return out;
  }

  /** Ticks exactly the tests named and clears the rest. */
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
        // Each tick round-trips over the circuit before the next one is read.
        await this.page.waitForTimeout(800);
        await expect(box).toBeChecked({ checked: wanted });
      }
    }
  }

  /**
   * Ticks every test still on screen.
   *
   * Under "Partial Acknowledged" the grid holds exactly what the lab has yet to
   * receive, so this is how the rest of an invoice is cleared without having to
   * name the tests — whatever is left is what gets acknowledged.
   */
  async selectAll() {
    const rows = this.testRows;

    for (let i = 0; i < (await rows.count()); i++) {
      const box = rows.nth(i).locator('input[type="checkbox"]');
      if (!(await box.count())) continue;
      if (await box.isChecked()) continue;

      await box.click({ force: true });
      // Each tick round-trips over the circuit before the next one is read.
      await this.page.waitForTimeout(800);
      await expect(box).toBeChecked();
    }
  }

  async acknowledge() {
    await this.acknowledgeButton.scrollIntoViewIfNeeded();
    await this.acknowledgeButton.click();
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
