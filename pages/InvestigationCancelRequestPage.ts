import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { settledCount, settledValue } from '../utils/blazor';
import { clearSnackbars, readSnackbars, recordSnackbars, waitForSnackbar } from '../utils/snackbars';

/** One billed item of the invoice, as the cancel request grid lists it. */
export type CancelRequestRow = {
  testCode: string;
  testName: string;
  rate: string;
  qty: string;
  total: string;
  /** First line of the SAMPLE STATUS cell, e.g. "Result Finalized", "No sample". */
  status: string;
  /** The rest of that cell — who received the sample and when, where it says so. */
  statusDetail: string;
  /** Whether the row can be put up for cancellation at all. */
  selectable: boolean;
  selected: boolean;
};

/**
 * Send Request for Cancel (/diagnostic/investigation-cancel-approval).
 *
 * The first half of the two-step cancellation: this screen raises the request,
 * and "Approve Cancel Request" — `InvestigationCancelApprovalPage` — is where
 * it is granted. Note the routes are the wrong way round; see `ROUTES` in
 * utils/constants.ts.
 *
 * There is no Search button. The invoice number box is bound on change, so the
 * lookup fires on Enter or on blur and on nothing else — `findInvoice` presses
 * Enter. The button that looks like a search control in the heading is the
 * app's back arrow, and clicking it leaves the screen.
 */
export class InvestigationCancelRequestPage {
  readonly page: Page;
  readonly invoiceNo: Locator;
  readonly remarks: Locator;
  readonly requestApproval: Locator;
  readonly grid: Locator;
  readonly selectAll: Locator;

  constructor(page: Page) {
    this.page = page;

    this.invoiceNo = page.locator('input[name="InvoiceNo"]');
    this.remarks = page.locator('input[name="_remarks"]');
    this.requestApproval = page.getByRole('button', { name: /request approval/i });
    this.grid = page
      .locator('table')
      .filter({ has: page.locator('th').filter({ hasText: /test\s*name/i }) })
      .first();
    this.selectAll = this.grid.locator('thead input[type="checkbox"]');
  }

  async goto() {
    await this.page.goto(ROUTES.investigationCancelRequest);
    await expect(this.grid).toBeVisible({ timeout: 60_000 });
    await expect(this.invoiceNo).toBeVisible({ timeout: 60_000 });
  }

  /** Starts recording the screen's snackbars; see utils/snackbars.ts. */
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

  /**
   * One of the labelled values above the grid — "Patient Name", "Age",
   * "Entry Date", "UserName".
   *
   * Each is a pair of labels in a `div.col-auto`: a bold one carrying the
   * caption and an empty one beside it holding the value, so the value is read
   * through the caption rather than by position.
   */
  headerValue(caption: string): Locator {
    return this.page
      .locator('div.col-auto')
      .filter({ has: this.page.locator('label').filter({ hasText: new RegExp(`^\\s*${caption}\\s*:`) }) })
      .locator('label')
      .nth(1);
  }

  /** Patient Name, Age, Entry Date and UserName as the screen is showing them. */
  async header(): Promise<Record<string, string>> {
    const captions = ['Patient Name', 'Age', 'Entry Date', 'UserName'];
    const out: Record<string, string> = {};

    for (const caption of captions) {
      const field = this.headerValue(caption);
      out[caption] = (await field.count()) ? (await field.innerText()).trim() : '';
    }

    return out;
  }

  get rows(): Locator {
    return this.grid.locator('tbody tr');
  }

  /** The "1 - 9 of 9 items" line under the grid, as the screen writes it. */
  async itemCount(): Promise<string> {
    const line = this.page.getByText(/\d+ - \d+ of \d+ items/).first();
    return (await line.count()) ? (await line.innerText()).trim() : '';
  }

  /**
   * Types an invoice number and waits for the grid to come to rest.
   *
   * The lookup is bound on change, so the Enter press is what fires it. A
   * number the app has never heard of answers with "InvestigationInvoice Not
   * Found!" and leaves the grid empty — which is a result, not a failure, so
   * this hands back the row count rather than asserting on it.
   *
   * Waiting for the count to settle is not enough on its own: the grid is
   * empty when the Enter is pressed and stays empty for the four or five
   * seconds the server takes, so a settle reads "nothing" and calls it rest.
   * The two real answers are a row and the refusal, and this waits for
   * whichever arrives.
   *
   * The number goes in with a single `fill` rather than keystroke by
   * keystroke, and that matters: the box is bound per keystroke, so a typed
   * thirteen-digit number asks the server about "2", then "26", then "261" on
   * the way past, and each of those comes back "InvestigationInvoice Not
   * Found!" in its own time. Those refusals arrive while this is waiting for
   * the real answer and are indistinguishable from it — which is how a lookup
   * that was about to return nine rows came back "nothing found" instead, on
   * roughly one run in three. One fill is one lookup.
   */
  async findInvoice(invoiceNo: string): Promise<number> {
    await this.invoiceNo.click();
    await this.invoiceNo.fill(invoiceNo);
    await this.page.keyboard.press('Enter');
    await this.clearSnackbars();

    const deadline = Date.now() + 45_000;
    for (;;) {
      if ((await this.rows.count()) > 0) break;
      if ((await this.snackbars()).some((m) => /not found/i.test(m))) break;
      if (Date.now() >= deadline) break;
      await this.page.waitForTimeout(250);
    }

    return settledCount(this.rows, { quiet: 1_500, timeout: 30_000 });
  }

  /** What the invoice box holds once the app has had its say about it. */
  async invoiceBoxValue(): Promise<string> {
    return settledValue(this.invoiceNo, { quiet: 1_000, timeout: 8_000 });
  }

  async rowData(): Promise<CancelRequestRow[]> {
    const out: CancelRequestRow[] = [];

    for (let i = 0; i < (await this.rows.count()); i++) {
      const row = this.rows.nth(i);
      const cells = await row.locator('td').allInnerTexts();
      const [, testCode, testName, rate, qty, total, statusCell] = cells.map((c) => c.trim());
      const [status, ...rest] = (statusCell ?? '').split('\n').map((line) => line.trim());
      const box = row.locator('input[type="checkbox"]');
      const present = (await box.count()) > 0;

      out.push({
        testCode,
        testName,
        rate,
        qty,
        total,
        status: status ?? '',
        statusDetail: rest.join(' ').trim(),
        selectable: present && (await box.isEnabled()),
        selected: present ? await box.isChecked() : false,
      });
    }

    return out;
  }

  row(testName: string): Locator {
    return this.rows.filter({ hasText: testName }).first();
  }

  /** Ticks one test. Each tick round-trips over the circuit before the next. */
  async select(testName: string) {
    await this.row(testName).locator('input[type="checkbox"]').check();
    await this.page.waitForTimeout(1_500);
  }

  async setRemarks(text: string) {
    await this.remarks.click();
    await this.remarks.fill(text);
    await this.page.keyboard.press('Tab');
    await this.page.waitForTimeout(1_000);
  }

  /**
   * Presses Request Approval and hands back what the screen said about it.
   *
   * Every outcome — the two validation refusals and the save itself — is
   * reported only through a snackbar, so the message is the result.
   */
  async submit(expected = /request sent|required|select at least one/i): Promise<string[]> {
    await this.clearSnackbars();
    await this.requestApproval.click();
    return this.waitForSnackbar(expected);
  }
}
