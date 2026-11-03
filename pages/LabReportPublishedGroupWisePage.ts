import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { clearSnackbars, readSnackbars, recordSnackbars } from '../utils/snackbars';
import { asPickerDate } from './SampleDispatchPage';

/**
 * One row of the published grid.
 *
 * A row is an invoice *and a test group*, not an invoice — an invoice carrying
 * endocrinology and biochemistry work is two rows here, each listing only its
 * own group's tests. That is what "Group Wise" names, and it is why `testNames`
 * comes back as a list rather than a string: the column holds the group's tests
 * comma-separated.
 */
export type PublishedRow = {
  invoiceNo: string;
  patientName: string;
  entryDate: string;
  reportPrintTitle: string;
  testGroupName: string;
  /** The group's tests, split out of the comma-separated TESTNAMES cell. */
  testNames: string[];
  /** "Printed" or "Not Printed". */
  status: string;
  printTime: string;
  userName: string;
  previewBy: string;
};

/** The two radio buttons above the grid. */
export type PrintFilter = 'Not Printed' | 'Printed';

/**
 * Lab Report Published Group Wise (/diagnosis/lab-report-published2).
 *
 * Where a report that has been signed off is published for the counter to
 * print. The sidebar lists five "... Published" screens together; this is the
 * grouped one, and `/diagnosis/lab-report-published` beside it is a different
 * screen showing the same work ungrouped.
 *
 * One panel: a date range, a Search box, an invoice number box and a pair of
 * Not Printed / Printed radios over a grid of
 * INVOICENO | FULLNAME | ENTRY DATE | REPORT PRINT TITLE | TESTGROUPNAME |
 * TESTNAMES | STATUS | PRINT TIME | USER NAME | PREVIEW BY.
 *
 * ## Two buttons, and which one filters
 *
 * The screen carries a **Show** and a **Filter**, and they are not the same
 * thing: Show re-runs the date range, while the invoice number box is only
 * applied by **Filter**. Pressing Show with an invoice number typed in comes
 * back with the whole range — 250 rows where two were wanted — and nothing on
 * the screen says the number was ignored. `findInvoice` presses Filter for
 * exactly that reason.
 */
export class LabReportPublishedGroupWisePage {
  readonly page: Page;
  readonly startDate: Locator;
  readonly endDate: Locator;
  readonly invoiceNo: Locator;
  readonly search: Locator;
  readonly showButton: Locator;
  readonly filterButton: Locator;
  readonly grid: Locator;

  constructor(page: Page) {
    this.page = page;

    // flatpickr keeps a hidden original input beside the visible alternate one.
    this.startDate = page.locator('input.input.form-control[placeholder="Start Date"]').first();
    this.endDate = page.locator('input.input.form-control[placeholder="End Date"]').first();

    // The invoice box is named only by its example — "e.g 26050212002" — with
    // no id of its own and no label, so the placeholder is what addresses it.
    this.invoiceNo = page.locator('input[placeholder^="e.g"]').first();
    this.search = page.locator('input[placeholder="Search..."]').first();

    this.showButton = page.getByRole('button', { name: /^show$/i });
    this.filterButton = page.getByRole('button', { name: /^filter$/i });

    this.grid = page
      .locator('table:visible')
      .filter({ has: page.locator('th').filter({ hasText: /testgroupname/i }) })
      .first();
  }

  async goto() {
    await this.page.goto(ROUTES.labReportPublishedGroupWise);
    await expect(this.showButton).toBeVisible({ timeout: 60_000 });
    await expect(this.grid).toBeVisible({ timeout: 60_000 });
  }

  /** flatpickr only commits a typed date on Enter. */
  private async setDate(input: Locator, value: string) {
    await input.click();
    await input.fill('');
    await input.pressSequentially(value, { delay: 60 });
    await this.page.keyboard.press('Enter');
    // The screen redisplays what it was typed with its own separator, so only
    // the day, month and year are compared — as on Report Delivery.
    await expect(input).toHaveValue(new RegExp(`^${value.split(/[-/]/).join('[-/]')}$`));
  }

  async setDateRange(from: Date, to: Date) {
    await this.setDate(this.startDate, asPickerDate(from));
    await this.setDate(this.endDate, asPickerDate(to));
  }

  async show() {
    await this.showButton.click();
    await this.page.waitForTimeout(8_000);
  }

  /** Applies the invoice number box. Show does not — see the class note. */
  async filter() {
    await this.filterButton.click();
    await this.page.waitForTimeout(8_000);
  }

  /**
   * Narrows the grid to one invoice, and reports whether it came back.
   *
   * Reports rather than asserts: both the "it is published" and the "it is not
   * published yet" questions are asked of this screen, and only the caller
   * knows which answer it wanted.
   */
  async findInvoice(invoiceNo: string): Promise<boolean> {
    await this.invoiceNo.fill(invoiceNo);
    await this.invoiceNo.blur();
    await this.page.waitForTimeout(2_000);
    await this.filter();

    return (await this.rowsFor(invoiceNo)).length > 0;
  }

  /** The box under the buttons, which filters the grid already on screen. */
  async filterList(text: string) {
    await this.search.fill(text);
    await this.page.waitForTimeout(4_000);
  }

  async selectPrintFilter(mode: PrintFilter) {
    await this.page
      .locator('label.form-check-label')
      .filter({ hasText: new RegExp(`^\\s*${mode}\\s*$`) })
      .first()
      .click();
    await this.page.waitForTimeout(6_000);
  }

  get bodyRows(): Locator {
    return this.grid.locator('tbody tr');
  }

  /** The grid's header texts, lower-cased and squashed. */
  private async headers(): Promise<string[]> {
    return (await this.grid.locator('thead th').allInnerTexts()).map((h) =>
      h.replace(/\s+/g, ' ').trim().toLowerCase(),
    );
  }

  /**
   * Every row on screen.
   *
   * Cells are read against the header row rather than by position: the grid
   * carries an unnamed action column on the end, and reading by index would
   * silently slide every value along by one the day another is added.
   */
  async rows(): Promise<PublishedRow[]> {
    const headers = await this.headers();
    const at = (cells: string[], name: string) => {
      const index = headers.indexOf(name);
      return index < 0 ? '' : (cells[index] ?? '');
    };

    const rows = this.bodyRows;
    const out: PublishedRow[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const cells = (await rows.nth(i).locator('td').allInnerTexts()).map((c) =>
        c.replace(/\s+/g, ' ').trim(),
      );
      // An empty grid draws a single placeholder row with no cells in it.
      if (!cells.length) continue;

      const tests = at(cells, 'testnames');

      out.push({
        invoiceNo: at(cells, 'invoiceno'),
        patientName: at(cells, 'fullname'),
        entryDate: at(cells, 'entry date'),
        reportPrintTitle: at(cells, 'report print title'),
        testGroupName: at(cells, 'testgroupname'),
        testNames: tests
          ? tests
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        status: at(cells, 'status'),
        printTime: at(cells, 'print time'),
        userName: at(cells, 'user name'),
        previewBy: at(cells, 'preview by'),
      });
    }

    return out;
  }

  /** The rows belonging to one invoice — one per test group it carries. */
  async rowsFor(invoiceNo: string): Promise<PublishedRow[]> {
    return (await this.rows()).filter((r) => r.invoiceNo === invoiceNo);
  }

  /** Every test an invoice has published here, across all of its groups. */
  async publishedTests(invoiceNo: string): Promise<string[]> {
    return (await this.rowsFor(invoiceNo)).flatMap((r) => r.testNames);
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
