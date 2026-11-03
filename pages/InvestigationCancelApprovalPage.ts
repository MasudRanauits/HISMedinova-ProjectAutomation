import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { settledCount } from '../utils/blazor';
import { clearSnackbars, readSnackbars, recordSnackbars, waitForSnackbar } from '../utils/snackbars';

/** One requested item of the picked invoice, as the detail grid lists it. */
export type CancelApprovalRow = {
  invoiceNo: string;
  testCode: string;
  testName: string;
  rate: string;
  qty: string;
  total: string;
  /** The reason typed on Send Request for Cancel. */
  remarks: string;
  /** How far the sample had got by the time the cancellation was asked for. */
  sample: string;
  selected: boolean;
};

/**
 * Approve Cancel Request (/diagnostic/investigation-cancel).
 *
 * The second half of the two-step cancellation. The upper grid is the queue of
 * invoices with a request outstanding; picking one fills the lower grid with
 * the items that were asked for, each carrying the requester's remarks and a
 * **Reverse Cancel** button of its own.
 *
 * Two buttons, two very different weights:
 *
 * - **Cancel Item** grants the request. It takes the money off the bill and
 *   cannot be undone from this screen, so nothing in this suite presses it.
 * - **Reverse Cancel** sends one requested item back — the request is gone
 *   from the queue and the item is offered on Send Request for Cancel again.
 *   That is what the spec uses to put back what it raised.
 *
 * Total Tk, Disc Tk and Refund are disabled: the screen works them out from
 * the ticked items rather than taking an amount from the approver.
 */
export class InvestigationCancelApprovalPage {
  readonly page: Page;
  readonly queue: Locator;
  readonly detail: Locator;
  readonly search: Locator;
  readonly pageSize: Locator;
  readonly total: Locator;
  readonly discount: Locator;
  readonly refund: Locator;
  readonly cancelItem: Locator;

  constructor(page: Page) {
    this.page = page;

    // The detail grid carries a class of its own, which is what tells the two
    // apart: both are the same Blazorise table otherwise, and "TEST NAME" in
    // the detail headers matches any loose /name/ filter on the queue.
    this.detail = page.locator('table.investigation-cancel-detail-grid').first();
    this.queue = page.locator('table:not(.investigation-cancel-detail-grid)').first();

    this.search = page.getByPlaceholder('Search...');
    this.pageSize = page.locator('select[name="PaginationContext.CurrentPageSize"]');
    this.total = page.locator('input[name="ItemTotalAmount"]');
    this.discount = page.locator('input[name="ItemDiscount"]');
    this.refund = page.locator('input[name="Refund"]');
    this.cancelItem = page.getByRole('button', { name: /cancel item/i });
  }

  async goto() {
    await this.page.goto(ROUTES.investigationCancelApproval);
    await expect(this.queue).toBeVisible({ timeout: 60_000 });
    await expect(this.cancelItem).toBeVisible({ timeout: 60_000 });
  }

  async recordSnackbars() {
    await recordSnackbars(this.page);
  }

  async clearSnackbars() {
    await clearSnackbars(this.page);
  }

  async snackbars(): Promise<string[]> {
    return readSnackbars(this.page);
  }

  async waitForSnackbar(expected: RegExp, timeout = 20_000): Promise<string[]> {
    return waitForSnackbar(this.page, expected, timeout);
  }

  /** As on the request screen: the value label beside a bold caption. */
  headerValue(caption: string): Locator {
    return this.page
      .locator('div.col-auto')
      .filter({ has: this.page.locator('label').filter({ hasText: new RegExp(`^\\s*${caption}\\s*:`) }) })
      .locator('label')
      .nth(1);
  }

  /** Patient Name, Age, Entry Date, Entry User and Approve User. */
  async header(): Promise<Record<string, string>> {
    const captions = ['Patient Name', 'Age', 'Entry Date', 'Entry User', 'Approve User'];
    const out: Record<string, string> = {};

    for (const caption of captions) {
      const field = this.headerValue(caption);
      out[caption] = (await field.count()) ? (await field.innerText()).trim() : '';
    }

    return out;
  }

  get queueRows(): Locator {
    return this.queue.locator('tbody tr');
  }

  get detailRows(): Locator {
    return this.detail.locator('tbody tr');
  }

  /** The invoices with a request outstanding, as "<invoice no>\t<patient>". */
  async pending(): Promise<string[]> {
    const rows = await this.queueRows.allInnerTexts();
    return rows.map((r) => r.replace(/\s+/g, ' ').trim());
  }

  queueRow(invoiceNo: string): Locator {
    return this.queueRows.filter({ hasText: invoiceNo }).first();
  }

  /** Narrows the queue; it searches both the invoice number and the name. */
  async searchFor(text: string): Promise<number> {
    await this.search.fill(text);
    return settledCount(this.queueRows, { quiet: 1_800, timeout: 20_000 });
  }

  /**
   * Picks a queued request and waits for its items.
   *
   * Hands back false rather than asserting when the invoice is not queued at
   * all: a request that has already been granted or sent back is simply gone,
   * and the caller usually has something to say about which it was.
   */
  async open(invoiceNo: string): Promise<boolean> {
    const row = this.queueRow(invoiceNo);
    const found = await row
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!found) return false;

    await row.click();
    await settledCount(this.detailRows, { quiet: 1_800, timeout: 30_000 });
    return true;
  }

  async rowData(): Promise<CancelApprovalRow[]> {
    const out: CancelApprovalRow[] = [];

    for (let i = 0; i < (await this.detailRows.count()); i++) {
      const row = this.detailRows.nth(i);
      const cells = (await row.locator('td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      const [, invoiceNo, testCode, testName, rate, qty, total, remarks, sample] = cells;
      const box = row.locator('input[type="checkbox"]');

      out.push({
        invoiceNo,
        testCode,
        testName,
        rate,
        qty,
        total,
        remarks,
        sample,
        selected: (await box.count()) ? await box.isChecked() : false,
      });
    }

    return out;
  }

  detailRow(testName: string): Locator {
    return this.detailRows.filter({ hasText: testName }).first();
  }

  /** Ticks one requested item, which is what fills in the three amounts. */
  async select(testName: string) {
    await this.detailRow(testName).locator('input[type="checkbox"]').check();
    await this.page.waitForTimeout(2_000);
  }

  /** Total Tk, Disc Tk and Refund as the screen has worked them out. */
  async amounts(): Promise<{ total: string; discount: string; refund: string }> {
    return {
      total: await this.total.inputValue(),
      discount: await this.discount.inputValue(),
      refund: await this.refund.inputValue(),
    };
  }

  /**
   * Sends one requested item back, undoing the request without granting it.
   *
   * This is the only way back from Send Request for Cancel, and it is what
   * keeps the spec's own request off the live queue.
   */
  async reverse(testName: string): Promise<string[]> {
    await this.clearSnackbars();
    await this.detailRow(testName).getByRole('button', { name: /reverse cancel/i }).click();
    // Not /success/: the screen answers "Successful fetch!" while it reloads
    // the queue, a second or so before it says what it did with the request,
    // and a wait that stops on the first match reads the reload instead of the
    // outcome. The words below are the outcome's, whichever way it is worded.
    return this.waitForSnackbar(/approved|revers|withdraw|remove|cancel/i);
  }

  /** Presses Cancel Item and hands back what the screen said. See the note above. */
  async approve(expected = /success|select/i): Promise<string[]> {
    await this.clearSnackbars();
    await this.cancelItem.click();
    return this.waitForSnackbar(expected);
  }
}
