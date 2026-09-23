import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { clearSnackbars, readSnackbars, recordSnackbars } from '../utils/snackbars';
import { asPickerDate } from './SampleDispatchPage';

/**
 * One report row of the test grid.
 *
 * The grid is a different shape in each of the screen's three modes — "Not
 * Acknowledged" has nine columns, "Acknowledged" adds who received the report
 * and when, and "Delivery" drops the statuses for who delivered it — so the
 * cells are read against the header row rather than by position, and the
 * columns a mode does not carry come back empty.
 */
export type DeliveryRow = {
  invoiceNo: string;
  patientName: string;
  entryDate: string;
  testName: string;
  printStatus: string;
  sampleStatus: string;
  printedBy: string;
  paymentStatus: string;
  receivedBy: string;
  receivedAt: string;
  deliveredBy: string;
  deliveredAt: string;
  selected: boolean;
};

/** The three radio buttons above the grid. */
export type DeliveryMode = 'Not Acknowledged' | 'Acknowledged' | 'Delivery';

/**
 * Report Delivery (/diagnosis/report-delivery).
 *
 * The counter's last screen: a report that has been finalized is acknowledged
 * here as ready to hand over, then delivered to the patient and printed. The
 * three radio buttons are stages rather than filters — a report ticked and
 * acknowledged leaves "Not Acknowledged" for "Acknowledged", and one delivered
 * leaves that for "Delivery" — so each of them is a one-way trip.
 *
 * Laid out as two panels: a date range, an invoice number and a Show button on
 * the left, over a list of invoices; the tests of whichever invoice is picked on
 * the right.
 */
export class ReportDeliveryPage {
  readonly page: Page;
  readonly startDate: Locator;
  readonly endDate: Locator;
  readonly invoiceNo: Locator;
  readonly search: Locator;
  readonly showButton: Locator;
  readonly refreshButton: Locator;
  readonly acknowledgeButton: Locator;
  readonly deliveryButton: Locator;
  readonly printAllButton: Locator;
  readonly invoiceGrid: Locator;
  readonly testGrid: Locator;
  readonly modal: Locator;

  constructor(page: Page) {
    this.page = page;

    // flatpickr keeps a hidden original input beside the visible alternate one.
    // Both boxes are drawn with placeholder "Start Date" — the end one included,
    // which looks like a copy-and-paste slip in the markup — so they are told
    // apart by their order rather than by their placeholder.
    const dates = page.locator('input.input.form-control[placeholder="Start Date"]:visible');
    this.startDate = dates.nth(0);
    this.endDate = dates.nth(1);

    // The invoice number filter. It is one of the few things on this screen with
    // an id of its own rather than a per-circuit one, so it is matched on that.
    //
    // It used to be found by its position among the visible inputs that carried
    // neither a placeholder nor a label. The screen has since been redrawn with a
    // floating label, which gave the box a label, a placeholder of " " to float
    // it against, and `form-control` in place of `form-control-sm` — three
    // separate reasons that match stopped landing. Nothing said so: the fill
    // simply waited for an element that no longer existed in that shape.
    this.invoiceNo = page.locator('#report-delivery-invoice-no');

    this.search = page.locator('input[placeholder="Search..."]');
    this.showButton = page.getByRole('button', { name: /^show$/i });
    this.refreshButton = page.getByRole('button', { name: /^refresh$/i });

    // The green button is the same button throughout, relabelled for the mode:
    // "Acknowledge" over the pending list, "Delivery" over the acknowledged one.
    // (With no invoice open it reads "Not Acknowledge", which is why neither of
    // these is matched loosely.) The radio beside it is a label, not a button,
    // so "Delivery" is unambiguous here.
    this.acknowledgeButton = page.getByRole('button', { name: /^acknowledge$/i });
    this.deliveryButton = page.getByRole('button', { name: /^delivery$/i });
    // Not by role: the printer glyph beside the label is drawn by Font Awesome
    // as generated content, which Chromium folds into the button's accessible
    // name — so the name is not "Print All" and the role match never lands. The
    // text is matched against what the element actually holds instead.
    this.printAllButton = page
      .locator('button:visible')
      .filter({ hasText: /print\s*all/i })
      .first();

    this.invoiceGrid = page
      .locator('table:visible')
      .filter({ has: page.locator('th').filter({ hasText: /^\s*name\s*$/i }) })
      .first();
    this.testGrid = page
      .locator('table:visible')
      .filter({ has: page.locator('th').filter({ hasText: /patient\s*name/i }) })
      .first();

    this.modal = page.locator('.modal.show, .modal[style*="display: block"]');
  }

  async goto() {
    await this.page.goto(ROUTES.reportDelivery);
    await expect(this.showButton).toBeVisible({ timeout: 60_000 });
    await expect(this.invoiceGrid).toBeVisible({ timeout: 60_000 });
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

  /**
   * The invoice number to look for. Needs a Show after it.
   *
   * The box is bound on change, which for Blazor Server means a round trip that
   * starts when the box loses focus — so it is blurred here and given a moment
   * to land. Pressing Show while that is still in flight is what makes the first
   * press come back with the unfiltered list; `findInvoice` below presses again
   * for exactly that reason.
   */
  async searchInvoice(invoiceNo: string) {
    await this.invoiceNo.fill(invoiceNo);
    await this.invoiceNo.blur();
    await this.page.waitForTimeout(2_000);
    await expect(this.invoiceNo).toHaveValue(invoiceNo);
  }

  /**
   * Narrows the list to one invoice and reports whether it came back.
   *
   * Worth knowing about this box: the invoice number wins over the date range
   * rather than narrowing it. An invoice raised days before the range starts is
   * still found by number — so the range matters only when nothing is typed
   * here.
   */
  async findInvoice(invoiceNo: string, attempts = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.searchInvoice(invoiceNo);
      await this.show();

      if (await this.invoiceRow(invoiceNo).count()) return true;
      console.log(`Show came back without invoice ${invoiceNo} (attempt ${attempt} of ${attempts})`);
    }

    return false;
  }

  /** The box under the buttons, which filters the list already on screen. */
  async filterList(text: string) {
    await this.search.fill(text);
    await this.page.waitForTimeout(3_000);
  }

  async show() {
    await this.showButton.click();
    await this.page.waitForTimeout(8_000);
  }

  /**
   * Switches stage. The radio is clicked by its label, as the page draws it.
   *
   * The label carries the number of invoices in that stage — "Not Acknowledged
   * 0" — so it is matched on the words followed by that count rather than on the
   * words alone. The count is still anchored at both ends: "Acknowledged" that
   * way does not match "Not Acknowledged".
   */
  async filterBy(mode: DeliveryMode) {
    await this.page
      .locator('label.form-check-label')
      .filter({ hasText: new RegExp(`^\\s*${mode}\\s*\\d*\\s*$`) })
      .first()
      .click();
    await this.page.waitForTimeout(6_000);
  }

  invoiceRow(invoiceNo: string): Locator {
    return this.invoiceGrid.locator('tbody tr').filter({ hasText: invoiceNo }).first();
  }

  /**
   * Opens an invoice on the left list, and reports whether it was there at all.
   *
   * Every stage of this screen is one-way, so an invoice whose reports have
   * already been acknowledged is simply absent from the pending list rather than
   * shown as done. The caller decides what that means — for the acknowledging
   * test it is a spent invoice, for the delivery test it is nothing to deliver —
   * which is why this reports rather than asserts.
   */
  async selectInvoice(invoiceNo: string, timeout = 20_000): Promise<boolean> {
    const row = this.invoiceRow(invoiceNo);
    const found = await row
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
    if (!found) return false;

    await row.click();
    await this.page.waitForTimeout(5_000);
    return true;
  }

  /**
   * The patient whose invoice is open, for the record.
   *
   * The screen used to carry a strip beside the grid reading
   * "2609230200012/RAFIQUL ISLAM/Male/36Y 4M 9D /01702187281". The redraw that
   * gave the Invoice No box its floating label took that strip away, and the
   * name now comes from the grid's own PATIENT NAME column instead.
   *
   * It feeds a log line rather than an assertion, so it answers "" when there
   * is nothing on screen to read rather than waiting on a box that has gone.
   */
  async patient(): Promise<string> {
    if (!(await this.testRows.count())) return '';

    const column = (await this.headers()).indexOf('patient name');
    if (column < 0) return '';

    const cell = await this.testRows.first().locator('td').nth(column).innerText().catch(() => '');
    return cell.replace(/\s+/g, ' ').trim();
  }

  get testRows(): Locator {
    return this.testGrid.locator('tbody tr');
  }

  testRow(testName: string): Locator {
    return this.testRows.filter({ hasText: testName }).first();
  }

  /** The grid's header texts, lower-cased and squashed. */
  private async headers(): Promise<string[]> {
    return (await this.testGrid.locator('thead th').allInnerTexts()).map((h) =>
      h.replace(/\s+/g, ' ').trim().toLowerCase(),
    );
  }

  async rows(): Promise<DeliveryRow[]> {
    const headers = await this.headers();
    const at = (cells: string[], name: string) => {
      const index = headers.indexOf(name);
      return index < 0 ? '' : (cells[index] ?? '');
    };

    const rows = this.testRows;
    const out: DeliveryRow[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const cells = (await row.locator('td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      const box = row.locator('input[type="checkbox"]');

      out.push({
        invoiceNo: at(cells, 'invoice no'),
        patientName: at(cells, 'patient name'),
        entryDate: at(cells, 'entry date'),
        testName: at(cells, 'test name'),
        printStatus: at(cells, 'print status'),
        sampleStatus: at(cells, 'sample status'),
        printedBy: at(cells, 'printed by'),
        paymentStatus: at(cells, 'payment status'),
        receivedBy: at(cells, 'received by'),
        receivedAt: at(cells, 'received datetime'),
        deliveredBy: at(cells, 'delivered by'),
        deliveredAt: at(cells, 'delivery datetime'),
        selected: (await box.count()) ? await box.isChecked() : false,
      });
    }

    return out;
  }

  /**
   * Ticks every row on screen, top to bottom, one at a time.
   *
   * The header carries a tick-everything box of its own, but the point of doing
   * it a row at a time is that each tick round-trips over the circuit and is
   * read back before the next one — a row that refuses to stay ticked is caught
   * here rather than three steps later, when the button does nothing.
   *
   * Returns the test names ticked, in the order they were ticked in.
   */
  async tickAllInOrder(): Promise<string[]> {
    const rows = this.testRows;
    const ticked: string[] = [];
    const headers = await this.headers();
    const nameColumn = Math.max(headers.indexOf('test name'), 0);

    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const box = row.locator('input[type="checkbox"]');
      if (!(await box.count())) continue;

      const name = (await row.locator('td').nth(nameColumn).innerText()).replace(/\s+/g, ' ').trim();
      if (!(await box.isChecked())) {
        await box.click({ force: true });
        await this.page.waitForTimeout(800);
      }
      await expect(box, `row ${i + 1} (${name}) would not stay ticked`).toBeChecked();
      ticked.push(name);
    }

    return ticked;
  }

  /** The tick-everything box in the grid header. */
  async tickAllFromHeader() {
    const box = this.testGrid.locator('thead input[type="checkbox"]').first();
    await box.click({ force: true });
    await this.page.waitForTimeout(3_000);
  }

  /**
   * Presses one of the buttons under the grid.
   *
   * Each of them is drawn only in the mode it belongs to, and Print All only
   * while the grid it prints has rows at all — so a button that is not there is
   * said so plainly here, rather than left to swallow the test's whole timeout
   * waiting for something the screen is never going to draw.
   */
  private async press(button: Locator, name: string) {
    await expect(button, `there is no "${name}" button on screen`).toBeVisible({ timeout: 30_000 });
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await this.page.waitForTimeout(8_000);
  }

  async acknowledge() {
    await this.press(this.acknowledgeButton, 'Acknowledge');
  }

  async deliver() {
    await this.press(this.deliveryButton, 'Delivery');
  }

  /** Prints every report in the grid on screen. Needs a grid with rows in it. */
  async printAll() {
    await this.press(this.printAllButton, 'Print All');
  }

  /** The print button on a row of its own. */
  async printRow(testName: string) {
    const button = this.testRow(testName).locator('button.btn-print').first();
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await this.page.waitForTimeout(6_000);
  }

  /**
   * Clears the info dialog the screen sometimes answers with, and hands back
   * what it said. Empty when there was no dialog.
   */
  async dismissModal(): Promise<string> {
    const modal = this.modal.first();
    const shown = await modal
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) return '';

    const said = (await modal.locator('.modal-body').innerText()).replace(/\s+/g, ' ').trim();
    await modal.getByRole('button', { name: /^ok$/i }).click();
    await this.page.waitForTimeout(2_000);
    return said;
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
