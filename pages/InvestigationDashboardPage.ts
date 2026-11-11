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
  /**
   * The second filter strip, which the screen grew beside the first.
   *
   * `Search` above sits with the date range and is applied by **Show**; these
   * two sit below it and are applied by **Filter**. They are not the same
   * control under another name: the generic box does not match a mobile number
   * at all, which is why a bill looked up by mobile through `filter()` comes
   * back as an empty grid rather than as the patient's bills. Use
   * `findByMobile` instead.
   *
   * Declared but not used by `filter()` or `show()`, so nothing that was
   * written against this page object behaves any differently for their being
   * here.
   */
  readonly invoiceSearch: Locator;
  readonly mobileSearch: Locator;
  readonly filterButton: Locator;

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
    this.invoiceSearch = page.getByLabel('Search (Invoice No)', { exact: true });
    this.mobileSearch = page.getByLabel('Search (Mobile No)', { exact: true });
    // Anchored at both ends on purpose: every column header carries an "Add
    // filter" button, and a loose match would take the first of those instead
    // of the one button that applies the two boxes above.
    this.filterButton = page.getByRole('button', { name: /^filter$/i }).first();
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
    const shown = await this.endDate.inputValue();
    expect(shown, 'End Date should open on the server\'s today').toMatch(
      /^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/,
    );

    const today = InvestigationDashboardPage.toDayFirst(shown);
    console.log(`End Date opened on "${shown}"`);
    return today;
  }

  /**
   * A date as one of this screen's boxes writes it, in the DD-MM-YYYY the rest
   * of the suite speaks.
   *
   * The pickers used to write "08-10-2026" and now write "08/10/2026": the
   * separator changed under a redraw, the order did not — both are the eighth
   * of October. Pinning the whole string, separator and all, is what broke
   * this spec, so the parts are read instead and the separator no longer
   * matters either way.
   *
   * The order is taken as day-first, which is what this screen has always
   * written and what every other screen in the suite writes too — but a part
   * over twelve settles it outright, so a box that did turn up in US order
   * would still be read correctly. It is the *second* part that settles it:
   * over twelve it can only be the day, which puts the month in front. A
   * first part over twelve says the same thing the other way round, and
   * reading it as the month — which is what this did until the 22nd of a
   * month first tried it — gives a month of 22 and a range a year out.
   * Nothing rests on the assumption for long:
   * `pickDate` compares what the calendar took back against the day it asked
   * for, so an order read the wrong way round fails there, saying so. That is
   * how the US reading this method first shipped with was caught.
   */
  static toDayFirst(shown: string): string {
    const parts = shown.trim().split(/[-/]/);
    expect(parts, `"${shown}" is not a date this screen writes`).toHaveLength(3);

    const [first, second, year] = parts.map(Number);
    const monthFirst = second > 12;
    const day = monthFirst ? second : first;
    const month = monthFirst ? first : second;

    // Said plainly here rather than left to surface downstream: a month of 22
    // reaches the calendar as `MONTHS[21]`, and the spec fails asking for
    // "undefined 2026" without ever naming the date it could not read.
    expect(month, `"${shown}" has no month this screen could have written`).toBeGreaterThanOrEqual(1);
    expect(month, `"${shown}" has no month this screen could have written`).toBeLessThanOrEqual(12);

    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(day)}-${pad(month)}-${year}`;
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

    // Compared as a date rather than as a string: the box writes whichever
    // order the app is configured for (see `toDayFirst`), and what matters is
    // that the day clicked is the day it now holds.
    await expect
      .poll(async () => InvestigationDashboardPage.toDayFirst(await field.inputValue()), {
        message: `${ddmmyyyy} should have been taken`,
        timeout: 15_000,
      })
      .toBe(ddmmyyyy);
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

  /**
   * Waits for whatever query is in flight to come back.
   *
   * This screen offers exactly one honest readiness signal, and the grid is
   * not it: the table is drawn with its headers before the query is even sent,
   * so `expect(grid).toBeVisible()` passes in a dozen milliseconds and says
   * nothing at all about whether the rows have landed. What the screen does do
   * is **disable Show and Filter while it is fetching** and enable them again
   * when the rows arrive, so that is what this waits on.
   *
   * The cost of not waiting, on 2026-11-09: an invoice that had just been
   * posted and acknowledged with "successful save" was looked up a second
   * later, read as 0-0 of 0, and reported as never having been written. The
   * grid was still loading — the screenshot taken beside the failure showed
   * both buttons greyed out.
   *
   * Nothing is thrown if the buttons never settle: the caller is asking about
   * rows, and should fail on the rows it did or did not find rather than on a
   * button.
   */
  async settle(timeout = 60_000) {
    const deadline = Date.now() + timeout;
    const busy = async (button: Locator) =>
      (await button.count()) > 0 && !(await button.isEnabled().catch(() => false));

    for (;;) {
      if (!(await busy(this.showButton)) && !(await busy(this.filterButton))) break;
      if (Date.now() >= deadline) break;
      await this.page.waitForTimeout(250);
    }

    // The buttons come back a beat before the last rows are painted.
    await this.page.waitForTimeout(1_000);
  }

  /**
   * A patient's bills, looked up by mobile number, waited for rather than
   * snatched at.
   *
   * Two things make this different from `filter()`. It uses the **Search
   * (Mobile No)** box and the **Filter** button beside it, which is the control
   * actually built for this — the generic Search box matches names and does not
   * match a mobile number at all. And it asks again rather than reading once:
   * posting a bill and looking it up a second later is a race against the
   * server, and a single reading taken in the middle of that race reports a
   * bill that exists as a bill that was never written.
   *
   * An empty answer at the end of `timeout` is a real answer — there is no such
   * bill — and is the caller's to report.
   */
  async findByMobile(mobile: string, timeout = 90_000): Promise<PostedBill[]> {
    const digits = (value: string) => value.replace(/\D/g, '');
    const wanted = digits(mobile);
    const deadline = Date.now() + timeout;
    const hasBox = (await this.mobileSearch.count()) > 0;

    if (!hasBox) {
      console.log('this build has no "Search (Mobile No)" box; falling back to the Search box');
    }

    for (let attempt = 1; ; attempt++) {
      if (hasBox) {
        await this.mobileSearch.fill(mobile);
        if (await this.filterButton.count()) {
          await this.filterButton.click().catch(() => {});
        }
      } else {
        await this.search.fill(mobile);
      }

      await this.settle(Math.max(5_000, deadline - Date.now()));

      // Compared on digits: the column is written as the patient typed it and
      // a stray space would otherwise lose the match.
      const bills = (await this.rows()).filter((b) => digits(b.mobile) === wanted);
      if (bills.length) {
        console.log(`found ${bills.length} bill(s) for ${mobile} on attempt ${attempt}`);
        return bills;
      }

      if (Date.now() >= deadline) return [];
      console.log(`no bill for ${mobile} on the grid yet (attempt ${attempt}); asking again`);
      await this.page.waitForTimeout(3_000);
    }
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
