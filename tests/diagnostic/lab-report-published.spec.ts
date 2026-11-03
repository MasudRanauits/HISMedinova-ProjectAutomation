import { test, expect, investigations } from '../../fixtures/test';
import { LabReportPublishedGroupWisePage } from '../../pages/LabReportPublishedGroupWisePage';
import { ReportDeliveryPage } from '../../pages/ReportDeliveryPage';
import { asPickerDate } from '../../pages/SampleDispatchPage';

const data = investigations.labReportPublished;

/**
 * Where a finalized report goes.
 *
 * Signing a report off on Lab Result Finalization is supposed to be what
 * publishes it, and two screens are meant to pick it up from there: **Report
 * Delivery**, where the counter hands it to the patient, and **Lab Report
 * Published Group Wise**, where it is listed for printing one row per test
 * group rather than one per invoice.
 *
 * This spec reads both of them. It changes nothing: Report Delivery is only
 * looked at here — its stages are one-way and `10-report-delivery` is the spec
 * that walks them — so running this leaves that invoice exactly as it found it.
 *
 * The invoice is whichever one `8-finalize` signed off, which is whichever one
 * the investigation spec posted; see `recordInvoiceNo` in fixtures/test.ts.
 * `LAB_PUBLISHED_INVOICE` aims it at another for a single run.
 */
const INVOICE = process.env.LAB_PUBLISHED_INVOICE || data.invoiceNo;

/** The range the screens are asked to cover: `daysBack` ago .. today. */
const today = new Date();
const from = new Date(today.getTime() - data.daysBack * 24 * 60 * 60 * 1000);

test.describe('Published lab reports', () => {
  test('lists the finalized invoice group wise, a row per test group', async ({ page }) => {
    // Three Blazor round trips to reach the grid, each of them seconds long.
    test.setTimeout(240_000);

    const published = new LabReportPublishedGroupWisePage(page);
    await published.goto();
    await published.recordSnackbars();

    await published.setDateRange(from, today);
    console.log(`date range: ${asPickerDate(from)} .. ${asPickerDate(today)}`);

    // Filter, not Show: the invoice box is the Filter button's, and Show comes
    // back with the whole range as though nothing had been typed.
    const listed = await published.findInvoice(INVOICE);
    console.log(`invoice ${INVOICE} published: ${listed}`);
    expect(
      listed,
      `invoice ${INVOICE} is not listed on Lab Report Published Group Wise for the last ${data.daysBack} ` +
        `day(s). A report reaches this screen once it has been signed off on Lab Result Finalization, so run ` +
        `8-finalize first — or widen labReportPublished.daysBack if the invoice is older than that.`,
    ).toBe(true);

    const rows = await published.rowsFor(INVOICE);
    rows.forEach((r, i) =>
      console.log(
        `  ${i + 1}. ${r.testGroupName} | ${r.testNames.length} test(s): ${r.testNames.join(', ')} | ` +
          `status=${r.status || '-'} | printed=${r.printTime || '-'}`,
      ),
    );

    // --- it is grouped, and the grouping is by test group ---
    expect(rows.length, 'the invoice is listed but carries no rows').toBeGreaterThan(0);
    expect(rows.every((r) => r.invoiceNo === INVOICE)).toBe(true);

    const groups = rows.map((r) => r.testGroupName);
    expect(
      groups.filter((g) => !g),
      'every row on this screen belongs to a test group — that is what it groups by',
    ).toEqual([]);
    expect(
      groups,
      `the same test group is listed twice for ${INVOICE} (${groups.join(', ')}); group wise means one row each`,
    ).toHaveLength(new Set(groups).size);

    // --- and each row says which tests it covers ---
    rows.forEach((r) =>
      expect(r.testNames.length, `the ${r.testGroupName} row lists no tests`).toBeGreaterThan(0),
    );

    const tests = await published.publishedTests(INVOICE);
    console.log(`${rows.length} group(s), ${tests.length} test(s) published for ${INVOICE}`);

    // Nothing has been printed yet — the report has only just been published.
    expect(rows.every((r) => /printed/i.test(r.status))).toBe(true);

    await page.screenshot({ path: 'test-results/lab-report-published-groupwise.png', fullPage: true });
  });

  test('leaves the same invoice waiting at the delivery counter', async ({ page }) => {
    test.setTimeout(240_000);

    const delivery = new ReportDeliveryPage(page);
    await delivery.goto();
    await delivery.setDateRange(from, today);

    const found = await delivery.findInvoice(INVOICE);
    expect(
      found,
      `invoice ${INVOICE} is not on Report Delivery at all. The number is searched for on its own — the date ` +
        `range does not bound it — so this means no such invoice rather than one outside the range.`,
    ).toBe(true);

    // Only looked at. Acknowledging is one-way and belongs to
    // 10-report-delivery; doing it here would spend the invoice before that
    // stage ever saw it.
    await delivery.filterBy('Not Acknowledged');
    const opened = await delivery.selectInvoice(INVOICE);
    const waiting = opened ? await delivery.rows() : [];
    waiting.forEach((r, i) => console.log(`  ${i + 1}. ${r.testName} | sample=${r.sampleStatus || '-'}`));

    // An invoice whose reports have all been acknowledged is not absent from
    // the left-hand list — the list is of invoices, and that one still exists.
    // It is the grid beside it that comes back empty. So both halves are asked
    // about: the invoice being there is not the same as having anything left to
    // hand over, and reading only the first is what made this look like a
    // failure on an invoice the counter had simply already dealt with.
    test.skip(
      !opened || waiting.length === 0,
      `invoice ${INVOICE} has nothing under "Not Acknowledged" — its reports have already been acknowledged at ` +
        `the counter, which cannot be undone from that screen. Run the chain from 1-register for a fresh ` +
        `invoice, or point LAB_PUBLISHED_INVOICE at one whose reports are still waiting.`,
    );

    expect(waiting.every((r) => r.invoiceNo === INVOICE)).toBe(true);
    // Nothing has been handed over yet; that is what this stage means.
    expect(waiting.every((r) => r.receivedBy === '' && r.receivedAt === '')).toBe(true);

    await page.screenshot({ path: 'test-results/lab-report-published-delivery.png', fullPage: true });
  });

  /**
   * The SMS that goes out when a report is published should name whatever is
   * still pending on the same invoice, so a patient told one report is ready is
   * not left thinking the rest were forgotten. Lab Report Published Group Wise
   * is where that grouping is visible — one row per test group, each listing
   * its own tests — so the message for a group should carry the test names from
   * the invoice's other groups that have not been published yet.
   *
   * Nothing in this app shows what was sent. There is no SMS log, outbox,
   * message history or notification screen anywhere in it: every module the
   * administrator can open was walked on 2026-11-02 — Diagnostic,
   * Administrative, MIS and Registration — and none of them carries one, so a
   * UI test has nothing to read the message back from. Checking this needs
   * either the gateway's own logs or a look at the table the app queues
   * messages in, and this suite has neither.
   */
  test.skip('names the invoice\'s still-pending tests in the SMS', async () => {
    // Left deliberately unwritten — see the comment above. When the app grows a
    // screen that shows what was sent, this becomes: publish one group of a
    // multi-group invoice, read the message, and expect it to name the tests of
    // the groups still unpublished.
  });
});
