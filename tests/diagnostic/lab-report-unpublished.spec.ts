import { test, expect, investigations } from '../../fixtures/test';
import { LabReportPublishedGroupWisePage } from '../../pages/LabReportPublishedGroupWisePage';
import { asPickerDate } from '../../pages/SampleDispatchPage';

const data = investigations.labReportPublished;

/**
 * Publishing should wait for the pathologist.
 *
 * A report nobody has signed off has not been checked by anybody, and the whole
 * point of putting Finalize on Lab Result Finalization is that it is the gate:
 * until it is pressed, the counter should have nothing to print.
 *
 * ## Why this is a stage of its own, between result entry and finalization
 *
 * The question needs an invoice that has results against it and has *not* been
 * finalized, and that is a state the chain passes through rather than one that
 * can be gone looking for. `7-result-entry` leaves the invoice exactly there,
 * and `8-finalize` is the next thing to touch it — so this sits between the
 * two, where the specimen is the chain's own invoice and no searching is
 * needed.
 *
 * Looking for one instead does not work. The finalization screen's Pending tab
 * is the list of reports still waiting for a pathologist, but it comes back
 * empty for the administrator — it is the pathologist's list — and this stage
 * cannot run as the pathologist, because signing that account in is what ends
 * the administrator's session on the server.
 *
 * ## It is marked `test.fail`
 *
 * This build does not gate publication. An invoice with results entered and
 * nobody signed off is already listed on Lab Report Published Group Wise, with
 * its tests and its "Not Printed" status, exactly as a finalized one is —
 * checked by hand on 2026-11-02 against 2610250200018, which was sitting on the
 * finalization screen's Pending tab at the time, and 2610260200001, which had
 * been finalized: both listed, two group rows each, indistinguishable.
 *
 * So it is marked `test.fail`, the way the collection spec's two known defects
 * are: it describes what the screen should do, and it will start failing the
 * build the day publication is gated behind Finalize — which is the point.
 * Convert it to an ordinary test then.
 */
const INVOICE = process.env.LAB_PUBLISHED_INVOICE || data.invoiceNo;

const today = new Date();
const from = new Date(today.getTime() - data.daysBack * 24 * 60 * 60 * 1000);

test.describe('Unpublished lab reports', () => {
  test.fail('does not publish a report before it has been finalized', async ({ page }) => {
    test.setTimeout(240_000);

    const published = new LabReportPublishedGroupWisePage(page);
    await published.goto();
    await published.setDateRange(from, today);
    console.log(`date range: ${asPickerDate(from)} .. ${asPickerDate(today)}`);

    const listed = await published.findInvoice(INVOICE);
    const rows = await published.rowsFor(INVOICE);
    rows.forEach((r) =>
      console.log(`  already published: ${r.testGroupName} — ${r.testNames.join(', ')} (${r.status})`),
    );

    await page.screenshot({ path: 'test-results/lab-report-unpublished.png', fullPage: true });

    expect(
      listed,
      `invoice ${INVOICE} has had its results entered but nobody has signed the report off yet — ` +
        `8-finalize has not run against it — and Lab Report Published Group Wise is already listing ` +
        `${rows.length} of its test group(s). Publishing should wait for the pathologist to finalize.`,
    ).toBe(false);
  });
});
