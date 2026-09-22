import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';

/** The three buttons on the Filter Status strip, as the screen labels them. */
export type PaymentStatus = 'ALL' | 'PAID' | 'DUE';

/** How the calendar header writes its month, e.g. "September 2026". */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type PostedBill = {
  billNo: string;
  entryDate: string;
  entryTime: string;
  fullName: string;
  gender: string;
  mobile: string;
  username: string;
  status: string;
};

/**
 * Diagnostic dashboard (/diagnostic/investigation-dashboard).
 *
 * Lists the invoices posted in a date range. Unlike the entry screen this one
 * is MudBlazor, so the date range and the search box are Mud inputs; the grid
 * itself stays a plain table.
 */
export class InvestigationDashboardPage {
  readonly page: Page;
  readonly showButton: Locator;
  readonly search: Locator;
  readonly grid: Locator;
  readonly startDate: Locator;
  readonly endDate: Locator;

  constructor(page: Page) {
    this.page = page;
    this.showButton = page.getByRole('button', { name: /^show$/i }).first();
    // Both date boxes are MudDatePickers, and both are readonly — the value can
    // only be changed through the calendar, never typed. Same story as the
    // Search box below: no placeholder, a generated id, so the floating label is
    // the handle.
    this.startDate = page.getByLabel('Start Date', { exact: true });
    this.endDate = page.getByLabel('End Date', { exact: true });
    // MudBlazor draws a floating <label> rather than a placeholder — no input on
    // this screen carries a placeholder attribute at all, and the ids are
    // generated per render ("mudinputzhm6hd8a"), so the label is the only stable
    // handle. `exact` matters: the screen has since grown "Search (Invoice No)"
    // and "Search (Mobile No)" beside this box, and a loose match would take all
    // three.
    this.search = page.getByLabel('Search', { exact: true });
    // Each header also carries a filter button, so the match cannot be anchored.
    this.grid = page
      .locator('table')
      .filter({ has: page.locator('th').filter({ hasText: /bill\s*no/i }) })
      .first();
  }

  async goto() {
    await this.page.goto(ROUTES.investigationDashboard);
    await expect(this.showButton).toBeVisible({ timeout: 60_000 });
  }

  /** The grid stays empty until the range is submitted. */
  async show() {
    await this.showButton.click();
    await expect(this.grid).toBeVisible({ timeout: 60_000 });
  }

  async filter(term: string) {
    // `fill` carries no timeout of its own, so a box it cannot find is waited on
    // until the whole test expires — which is how a renamed field once cost the
    // invoice spec its full 180s and reported nothing but "Test timeout
    // exceeded". Asserting first fails in 30s and names what is missing.
    await expect(this.search, 'the dashboard Search box').toBeVisible({ timeout: 30_000 });
    await this.search.fill(term);
    // Filtering round-trips over the circuit before the rows are replaced.
    await this.page.waitForTimeout(4_000);
  }

  /**
   * The date this server thinks it is, as "DD-MM-YYYY".
   *
   * Taken from End Date, which the screen opens on today. Worth taking from the
   * app rather than from `Date.now()`: this server's clock runs ahead of the
   * machine the tests run on — on the evening of 22-09 it was already dating
   * invoices 23-09 — so a range worked out locally can miss a whole day's bills.
   */
  async appToday(): Promise<string> {
    await expect(this.endDate, 'the End Date box').toBeVisible({ timeout: 30_000 });
    const today = await this.endDate.inputValue();
    expect(today, 'End Date should open on the server\'s today').toMatch(/^\d{2}-\d{2}-\d{4}$/);
    return today;
  }

  /** "23-09-2026" less two days -> "21-09-2026". Rolls back over month ends. */
  static daysBefore(ddmmyyyy: string, days: number): string {
    const [d, m, y] = ddmmyyyy.split('-').map(Number);
    const then = new Date(y, m - 1, d - days);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(then.getDate())}-${pad(then.getMonth() + 1)}-${then.getFullYear()}`;
  }

  /**
   * Drives one of the two date pickers to a given day.
   *
   * The input is readonly, so `fill` is not an option — the calendar is walked
   * to the right month and the day is clicked, which is also what commits the
   * value: the picker has no OK button and closes on the click.
   */
  private async pickDate(field: Locator, ddmmyyyy: string) {
    const [day, month, year] = ddmmyyyy.split('-').map(Number);
    const wanted = year * 12 + (month - 1);

    await expect(field).toBeVisible({ timeout: 30_000 });
    await field.click();

    // Scoped to the open popover: the two pickers are separate components and a
    // bare `.mud-picker-calendar-day` would match a stale one still fading out.
    const calendar = this.page.locator('.mud-picker-popover.mud-popover-open').last();
    await expect(calendar, 'the calendar popover').toBeVisible({ timeout: 30_000 });

    const header = calendar.locator('.mud-button-month p').first();
    // Twelve steps covers a year either way; the ranges this screen is used for
    // are days wide, so this is a guard rather than a loop that does any work.
    for (let i = 0; i < 24; i++) {
      const [shownMonth, shownYear] = (await header.innerText()).trim().split(/\s+/);
      const shown = Number(shownYear) * 12 + MONTHS.indexOf(shownMonth);
      if (shown === wanted) break;
      const arrow = shown > wanted ? '.mud-picker-nav-button-prev' : '.mud-picker-nav-button-next';
      await calendar.locator(arrow).first().click();
      // The slide between months is animated, and the old grid is still in the
      // DOM while it runs.
      await this.page.waitForTimeout(800);
    }
    await expect(header, `the calendar should be on ${MONTHS[month - 1]} ${year}`).toHaveText(
      `${MONTHS[month - 1]} ${year}`,
    );

    // The grid pads both ends with the neighbouring months' days, hidden rather
    // than removed — so "1" matches three cells and only one of them is real.
    await calendar
      .locator('.mud-picker-calendar-day:not(.mud-hidden)')
      .filter({ has: this.page.locator('p', { hasText: new RegExp(`^${day}$`) }) })
      .first()
      .click();

    await expect(field, `${ddmmyyyy} should have been taken`).toHaveValue(ddmmyyyy, { timeout: 15_000 });
  }

  /**
   * Sets the range the grid reports on, then submits it.
   *
   * Nothing moves until Show is pressed — the pickers only change what will be
   * asked for.
   */
  async setDateRange(start: string, end: string) {
    await this.pickDate(this.startDate, start);
    await this.pickDate(this.endDate, end);
    console.log(`date range: ${start} to ${end}`);
  }

  /** One of ALL / PAID / DUE on the Filter Status strip. */
  statusButton(status: PaymentStatus): Locator {
    return this.page.getByRole('button', { name: status, exact: true });
  }

  /**
   * Presses a Filter Status button and waits for the grid to come back.
   *
   * The strip is a segmented control: pressing one releases the other two, and
   * `aria-pressed` is how it says so.
   */
  async filterStatus(status: PaymentStatus) {
    const button = this.statusButton(status);
    await expect(button, `the ${status} filter button`).toBeVisible({ timeout: 30_000 });
    await button.click();
    // Filtering round-trips over the circuit before the rows are replaced.
    await this.page.waitForTimeout(4_000);

    await expect(button, `${status} should be the one selected`).toHaveAttribute('aria-pressed', 'true');
    for (const other of ['ALL', 'PAID', 'DUE'] as PaymentStatus[]) {
      if (other === status) continue;
      await expect(this.statusButton(other), `${other} should have been released`).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
  }

  /** The row for a bill number, by its Bill No cell. */
  row(billNo: string): Locator {
    return this.grid.locator('tbody tr').filter({ hasText: billNo }).first();
  }

  /** The printer icon at the end of a row. */
  printButton(billNo: string): Locator {
    return this.row(billNo).getByRole('button', { name: 'Print invoice' });
  }

  /**
   * Prints one invoice and hands back the tab it opens.
   *
   * The app builds the memo as a PDF and opens it in a second tab — the window
   * is opened blank first and the blob is navigated to a moment later, so the
   * popup arrives with `about:blank` on it and fills in afterwards. Closing it
   * is the caller's job: see `closePrintTab`.
   */
  async printInvoice(billNo: string): Promise<Page> {
    const button = this.printButton(billNo);
    await expect(button, `the print button on row ${billNo}`).toBeVisible({ timeout: 30_000 });

    const [popup] = await Promise.all([
      this.page.waitForEvent('popup', { timeout: 60_000 }),
      button.click(),
    ]);
    return popup;
  }

  /**
   * Waits for the print tab to hold something, closes it, and returns the URL
   * it settled on.
   *
   * Headless Chrome has no PDF viewer, so there the tab stays on `about:blank`
   * however long it is given; that is reported rather than waited out.
   */
  async closePrintTab(popup: Page): Promise<string> {
    await popup
      .waitForURL((url) => url.toString() !== 'about:blank', { timeout: 20_000 })
      .catch(() => {});
    const url = popup.url();
    await popup.close().catch(() => {});
    // The dashboard is never navigated away from — the print tab is opened
    // beside it — so getting back to it is a matter of bringing it forward.
    await this.page.bringToFront();
    await expect(this.grid, 'the dashboard should still be on screen').toBeVisible({ timeout: 30_000 });
    return url;
  }

  async rows(): Promise<PostedBill[]> {
    const rows = this.grid.locator('tbody tr');
    const out: PostedBill[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const cells = await rows.nth(i).locator('td').allInnerTexts();
      const [billNo, entryDate, entryTime, fullName, gender, mobile, username, status] = cells.map((c) =>
        c.replace(/\s+/g, ' ').trim(),
      );
      out.push({ billNo, entryDate, entryTime, fullName, gender, mobile, username, status });
    }

    return out;
  }
}
