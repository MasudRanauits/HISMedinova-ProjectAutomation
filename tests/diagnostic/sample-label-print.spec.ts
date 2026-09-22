import { test, expect, investigations } from '../../fixtures/test';
import { SampleCollectionPage } from '../../pages/SampleCollectionPage';

const data = investigations.partialSampleCollection;

/**
 * Reprints the labels for an invoice whose samples are already collected:
 * first one label at a time from each row's own print button, then the whole
 * invoice at once, then the patient token.
 *
 * Printing is repeatable — it neither collects a sample nor changes a status —
 * so unlike the collection spec this one can be run again against the same
 * invoice.
 */
test.describe('Sample label printing', () => {
  test('prints each label on its own, then all of them, then the token', async ({ page }) => {
    // Seven print round-trips plus reopening the invoice at the end runs well
    // past the 90s the rest of the suite gets.
    test.setTimeout(240_000);

    const samples = new SampleCollectionPage(page);

    // The app prints straight to a configured printer; a browser print dialog
    // or a popup would otherwise hang the run.
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('popup', (p) => p.close().catch(() => {}));

    await samples.goto();
    await samples.recordSnackbars();

    await samples.filterBy('All Patient');
    await samples.searchInvoice(data.invoiceNo);

    // selectInvoice does the waiting, and explains itself when the invoice is
    // not on the list; checking here first would only bury that with a bare
    // "element not found".
    await samples.selectInvoice(data.invoiceNo);
    console.log(
      `invoice row: ${(await samples.invoiceRow(data.invoiceNo).innerText()).replace(/\s+/g, ' ').trim()}`,
    );

    const rows = await samples.rows();
    console.log('--- tests on the invoice ---');
    rows.forEach((r) => console.log(`  ${r.labNo} | ${r.testName} | ${r.labelText} | ${r.status}`));
    expect(rows.length).toBe(data.firstBatch.length + data.secondBatch.length);

    // --- one label at a time ---
    for (const row of rows) {
      await expect(samples.rowPrintButton(row.testName)).toBeVisible();
      await samples.printRowLabel(row.testName);
      console.log(`printed label for ${row.labNo} — ${row.labelText}`);
    }

    // --- every label at once ---
    await samples.printAllLabels();
    console.log('printed all labels for the invoice');

    // --- the patient token ---
    await samples.printPatientToken();
    console.log('printed the patient token');

    (await samples.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/sample-label-print.png', fullPage: true });

    // Printing the token clears the grid, so the invoice has to be reopened to
    // confirm that printing left its tests alone.
    await samples.goto();
    await samples.filterBy('All Patient');
    await samples.searchInvoice(data.invoiceNo);
    await samples.selectInvoice(data.invoiceNo);

    const after = await samples.rows();
    console.log('--- after printing ---');
    after.forEach((r) => console.log(`  ${r.labNo} | ${r.testName} | ${r.status}`));

    // Printing changes nothing — not the rows, not their status. Which status
    // that is depends on how far the invoice has got: "Label Printed" while it
    // is still waiting to be dispatched, "Collected & Dispatched" once it has
    // been, "Dept. Acknowledge" after the lab receives it. So this compares the
    // statuses against what they were a moment ago rather than naming one.
    const signature = (r: { labNo: string; status: string }) => `${r.labNo}|${r.status}`;
    expect(after.map(signature).sort()).toEqual(rows.map(signature).sort());
  });
});
