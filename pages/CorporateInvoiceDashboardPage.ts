import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';

/** A corporate bill, as the dashboard lists it. */
export type CorporateBill = {
  billNo: string;
  entryDate: string;
  entryTime: string;
  fullName: string;
  corporateClient: string;
  gender: string;
  mobile: string;
  username: string;
  /** "PAID" or "DUE" — a corporate bill is normally DUE, being the company's. */
  status: string;
};

/**
 * Corporate invoice dashboard (/marketing/corporate-invoice-dashboard).
 *
 * Where a bill raised on the Corporate Patient tab goes. It is **not** the
 * Diagnostic dashboard: a corporate invoice does not appear there at all — a
 * bill posted from that tab and confirmed with "Successful Save!" is absent
 * from /diagnostic/investigation-dashboard under every filter it offers, and
 * turns up here instead, under Corporate Management. That is why the corporate
 * test reads its invoice number back off this screen rather than the one the
 * Billing One test uses.
 *
 * The grid carries a CORPORATE CLIENT column the diagnostic one has no room
 * for, which is also the only place the company on a posted bill can be checked
 * from.
 */
export class CorporateInvoiceDashboardPage {
  readonly page: Page;
  readonly showButton: Locator;
  readonly search: Locator;
  readonly grid: Locator;

  constructor(page: Page) {
    this.page = page;

    this.showButton = page.getByRole('button', { name: /^show$/i }).first();
    // MudBlazor draws floating labels rather than placeholders, and the ids are
    // generated per render. `exact` matters: "Search (Invoice No)" and "Search
    // (Mobile No)" sit beside this box and a loose match would take all three.
    this.search = page.getByLabel('Search', { exact: true });
    this.grid = page
      .locator('table')
      .filter({ has: page.locator('th').filter({ hasText: /corporate\s*client/i }) })
      .first();
  }

  async goto() {
    await this.page.goto(ROUTES.corporateInvoiceDashboard);
    await expect(this.showButton).toBeVisible({ timeout: 60_000 });
    await expect(this.grid).toBeVisible({ timeout: 60_000 });
  }

  /** The grid is only filled once the range is submitted. */
  async show() {
    await this.showButton.click();
    await this.page.waitForTimeout(10_000);
    await expect(this.grid).toBeVisible({ timeout: 60_000 });
  }

  get bodyRows(): Locator {
    return this.grid.locator('tbody tr');
  }

  private async headers(): Promise<string[]> {
    return (await this.grid.locator('thead th').allInnerTexts()).map((h) =>
      h.replace(/\s+/g, ' ').trim().toLowerCase(),
    );
  }

  /**
   * Every bill on screen.
   *
   * Read against the header row rather than by position: the grid ends in an
   * unnamed action column, and reading by index would slide every value along
   * the day another is added.
   */
  async rows(): Promise<CorporateBill[]> {
    const headers = await this.headers();
    const at = (cells: string[], name: string) => {
      const index = headers.indexOf(name);
      return index < 0 ? '' : (cells[index] ?? '');
    };

    const rows = this.bodyRows;
    const out: CorporateBill[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const cells = (await rows.nth(i).locator('td').allInnerTexts()).map((c) =>
        c.replace(/\s+/g, ' ').trim(),
      );
      if (!cells.length) continue;

      out.push({
        billNo: at(cells, 'bill no'),
        entryDate: at(cells, 'entry date'),
        entryTime: at(cells, 'entry time'),
        fullName: at(cells, 'full name'),
        corporateClient: at(cells, 'corporate client'),
        gender: at(cells, 'gender'),
        mobile: at(cells, 'mobile no'),
        username: at(cells, 'username'),
        status: at(cells, 'status'),
      });
    }

    return out;
  }

  /**
   * The bills on screen for one mobile number, newest last.
   *
   * Filtered here rather than through the screen's own Search box, which on
   * this dashboard — as on the diagnostic one — leaves the grid where it is for
   * a mobile number. The range defaults to today, so this is a short list.
   */
  async billsFor(mobile: string): Promise<CorporateBill[]> {
    return (await this.rows()).filter((b) => b.mobile === mobile);
  }
}
