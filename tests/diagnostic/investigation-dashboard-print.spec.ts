import { test, expect } from '../../fixtures/test';
import { InvestigationDashboardPage, PaymentStatus, PostedBill } from '../../pages/InvestigationDashboardPage';

/**
 * Reprinting an invoice from the diagnostic dashboard, under each of the three
 * Filter Status buttons.
 *
 * Read-only from end to end: the range is widened to the last three days, the
 * strip is walked ALL -> PAID -> DUE, and one invoice is printed from each.
 * Printing raises no bill, settles nothing and changes no status — the app
 * renders the memo as a PDF and opens it in a second tab — so this spec is safe
 * to run again, and again, against the same data.
 *
 * The three days are the point of the range: on a quiet morning today alone can
 * hold nothing but PAID bills, and DUE would then have nothing to print. Two
 * days back is enough to have both kinds on the grid.
 */

/** "09/21/2026" as the grid writes it, in days, for comparing against a range. */
function gridDate(mmddyyyy: string): number {
  const [m, d, y] = mmddyyyy.split('/').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** "21-09-2026" as the pickers write it, in the same units. */
function pickerDate(ddmmyyyy: string): number {
  const [d, m, y] = ddmmyyyy.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

test.describe('Diagnostic dashboard — invoice printing', () => {
  test('prints one invoice under each of ALL, PAID and DUE over the last three days', async ({ page }) => {
    // Three status filters, each with its own round trip over the circuit, and
    // a PDF rendered and opened for each of them. Well past the 90s default.
    test.setTimeout(240_000);

    // Nothing in this spec expects a browser print dialog — the app writes the
    // memo into a tab of its own — but a dialog from anywhere else would hang
    // the run, so it is dismissed on sight.
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    const dashboard = new InvestigationDashboardPage(page);
    await dashboard.goto();

    // The server's today, not this machine's — see `appToday`.
    const today = await dashboard.appToday();
    const start = InvestigationDashboardPage.daysBefore(today, 2);
    console.log(`the server's today is ${today}; asking for ${start} onwards`);

    await dashboard.setDateRange(start, today);
    await dashboard.show();

    const from = pickerDate(start);
    const to = pickerDate(today);
    const printed: { status: PaymentStatus; bill: PostedBill; url: string }[] = [];
    const empty: PaymentStatus[] = [];

    for (const status of ['ALL', 'PAID', 'DUE'] as PaymentStatus[]) {
      console.log(`--- Filter Status: ${status} ---`);
      await dashboard.filterStatus(status);

      const bills = await dashboard.rows();
      bills.forEach((b) =>
        console.log(`  ${b.billNo} | ${b.entryDate} ${b.entryTime} | ${b.fullName} | ${b.mobile} | ${b.status}`),
      );
      console.log(`  ${bills.length} invoice(s) on this page under ${status}`);

      if (!bills.length) {
        // Not a defect: a filter can legitimately have nothing to show. It is
        // recorded and reported at the end rather than failing the run here.
        console.log(`  nothing to print under ${status} between ${start} and ${today}`);
        empty.push(status);
        continue;
      }

      // Every row has to fall inside the range that was asked for.
      for (const bill of bills) {
        const on = gridDate(bill.entryDate);
        expect(on, `${bill.billNo} is dated ${bill.entryDate}, outside ${start}..${today}`).toBeGreaterThanOrEqual(from);
        expect(on, `${bill.billNo} is dated ${bill.entryDate}, outside ${start}..${today}`).toBeLessThanOrEqual(to);
      }

      // And under PAID or DUE, every row has to carry that status. ALL is the
      // unfiltered view, so it is allowed to hold both.
      if (status !== 'ALL') {
        for (const bill of bills) {
          expect(bill.status.toUpperCase(), `${bill.billNo} should not be listed under ${status}`).toBe(status);
        }
      } else {
        expect(new Set(bills.map((b) => b.status.toUpperCase()))).not.toContain('');
      }

      // --- print the first invoice on the list ---
      const bill = bills[0];
      const popup = await dashboard.printInvoice(bill.billNo);
      console.log(`  printing ${bill.billNo} opened a second tab`);

      const url = await dashboard.closePrintTab(popup);
      console.log(`  the print tab held: ${url}`);

      // The memo is built in the browser and handed to the tab as a blob, so a
      // blob: URL is what a rendered invoice looks like. Headless Chrome ships
      // no PDF viewer and leaves the tab on about:blank however long it is
      // given, so the check is made only where it means something — the suite
      // runs headed (see playwright.config.ts).
      if (test.info().project.use.headless !== true) {
        expect(url, 'the print tab should have been handed the invoice PDF').toMatch(/^blob:/);
      } else {
        console.log('  running headless: no PDF viewer, so the tab stays blank — URL not checked');
      }

      printed.push({ status, bill, url });

      // Back on the dashboard, with the range and the filter as they were —
      // printing must not have reset the screen underneath it.
      await expect(page).toHaveURL(/investigation-dashboard/);
      await expect(dashboard.startDate).toHaveValue(start);
      await expect(dashboard.endDate).toHaveValue(today);
      await expect(dashboard.statusButton(status)).toHaveAttribute('aria-pressed', 'true');
      await expect(dashboard.row(bill.billNo), 'the invoice should still be on the grid').toBeVisible();
    }

    await page.screenshot({ path: 'test-results/investigation-dashboard-print.png', fullPage: true });

    console.log('--- printed ---');
    printed.forEach((p) => console.log(`  ${p.status}: ${p.bill.billNo} (${p.bill.fullName})`));
    if (empty.length) console.log(`--- nothing to print under: ${empty.join(', ')}`);

    // ALL is the unfiltered view of the range: if it is empty there are no
    // invoices to print at all and the run has proved nothing.
    expect(
      empty,
      `no invoices at all between ${start} and ${today} — widen the range or post one first`,
    ).not.toContain('ALL');
    expect(printed.length, 'an invoice should have been printed under each filter that had one').toBe(
      3 - empty.length,
    );
  });
});
