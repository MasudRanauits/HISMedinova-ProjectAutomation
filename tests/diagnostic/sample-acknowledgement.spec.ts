import { test, expect, investigations } from '../../fixtures/test';
import { SampleAcknowledgementPage, AcknowledgementRow } from '../../pages/SampleAcknowledgementPage';
import { asPickerDate } from '../../pages/SampleDispatchPage';

const data = investigations.partialSampleAcknowledgement;

/**
 * Acknowledging records that the lab has received the sample and cannot be
 * undone from this screen. Set `SAMPLE_ACK=0` to walk the grid and tick the
 * rows without acknowledging anything.
 *
 * The two tests run in order and are each other's setup: the first leaves the
 * invoice partially acknowledged, which is where the second picks it up. The
 * invoice is whichever one the investigation spec posted last; see
 * `recordInvoiceNo` in fixtures/test.ts.
 */
const SHOULD_ACKNOWLEDGE = process.env.SAMPLE_ACK !== '0';

const report = (label: string, rows: AcknowledgementRow[]) => {
  console.log(`--- ${label} ---`);
  rows.forEach((r) =>
    console.log(
      `  ${r.labNo} | ${r.testName} | ${r.sampleStatus} | receivedBy=${r.receivedBy || '-'} | ticked=${r.selected}`,
    ),
  );
};

const listed = (rows: AcknowledgementRow[], name: string) =>
  rows.some((r) => r.testName.toUpperCase().includes(name.toUpperCase()));

/** Yesterday .. today, the range the screen is asked to cover. */
const today = new Date();
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

test.describe.configure({ mode: 'serial' });

test.describe('Partial sample acknowledgement', () => {
  test('acknowledges the first two tests', async ({ page }) => {
    test.setTimeout(180_000);

    const ack = new SampleAcknowledgementPage(page);
    await ack.goto();
    await ack.recordSnackbars();

    await ack.setDateRange(yesterday, today);
    console.log(`date range: ${asPickerDate(yesterday)} .. ${asPickerDate(today)}`);

    await ack.searchInvoice(data.invoiceNo);
    await ack.filterBy('Not Acknowledged');
    await ack.show();

    // selectInvoice does the waiting, and explains itself when the invoice is
    // not on the list; checking here first would only bury that with a bare
    // "element not found".
    await ack.selectInvoice(data.invoiceNo);
    console.log(
      `invoice row: ${(await ack.invoiceRow(data.invoiceNo).innerText()).replace(/\s+/g, ' ').trim()}`,
    );
    const initial = await ack.rows();
    report('on opening the invoice (Not Acknowledged)', initial);
    expect(initial.length).toBe(data.firstBatch.length + data.secondBatch.length);
    // The lab has not received anything yet.
    expect(initial.every((r) => r.receivedBy === '')).toBe(true);

    await ack.selectOnly(data.firstBatch);
    const ticked = await ack.rows();
    report('ticked for the first batch', ticked);
    expect(ticked.filter((r) => r.selected)).toHaveLength(data.firstBatch.length);

    test.skip(!SHOULD_ACKNOWLEDGE, 'SAMPLE_ACK=0: stopping before anything is acknowledged');

    await ack.clearSnackbars();
    await ack.acknowledge();
    (await ack.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/sample-ack-first-batch.png', fullPage: true });

    // --- the invoice is now partially acknowledged ---
    await ack.goto();
    await ack.setDateRange(yesterday, today);
    await ack.searchInvoice(data.invoiceNo);
    await ack.filterBy('Partial Acknowledged');
    await ack.show();
    await expect(ack.invoiceRow(data.invoiceNo)).toBeVisible({ timeout: 60_000 });
    console.log(`invoice ${data.invoiceNo} is listed under "Partial Acknowledged"`);
  });

  test('acknowledges the remaining tests and lands under Acknowledged', async ({ page }) => {
    // Nothing was acknowledged by the first test, so there is no partial
    // invoice for this one to pick up.
    test.skip(!SHOULD_ACKNOWLEDGE, 'SAMPLE_ACK=0: the first test acknowledged nothing');
    test.setTimeout(180_000);

    const ack = new SampleAcknowledgementPage(page);
    await ack.goto();
    await ack.recordSnackbars();

    await ack.setDateRange(yesterday, today);
    await ack.searchInvoice(data.invoiceNo);
    await ack.filterBy('Partial Acknowledged');
    await ack.show();
    await ack.selectInvoice(data.invoiceNo);

    // Whatever is on screen here is what the lab has yet to receive, so the
    // rest of the invoice is cleared by ticking all of it rather than by naming
    // tests — the first batch is gone from this list already.
    const pending = await ack.rows();
    report('still pending', pending);
    expect(pending.length).toBeGreaterThan(0);
    data.firstBatch.forEach((name) => expect(listed(pending, name)).toBe(false));
    data.secondBatch.forEach((name) => expect(listed(pending, name)).toBe(true));

    await ack.selectAll();
    const ticked = await ack.rows();
    report('ticked for the second batch', ticked);
    expect(ticked.every((r) => r.selected)).toBe(true);

    test.skip(!SHOULD_ACKNOWLEDGE, 'SAMPLE_ACK=0: stopping before anything is acknowledged');

    await ack.clearSnackbars();
    await ack.acknowledge();
    (await ack.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/sample-ack-second-batch.png', fullPage: true });

    // --- everything is acknowledged ---
    await ack.goto();
    await ack.setDateRange(yesterday, today);
    await ack.searchInvoice(data.invoiceNo);
    await ack.filterBy('Acknowledged');
    await ack.show();
    await expect(ack.invoiceRow(data.invoiceNo)).toBeVisible({ timeout: 60_000 });
    console.log(`invoice ${data.invoiceNo} is listed under "Acknowledged"`);

    await ack.selectInvoice(data.invoiceNo);
    const final = await ack.rows();
    report('after acknowledging everything', final);
    expect(final.length).toBe(data.firstBatch.length + data.secondBatch.length);
    expect(final.every((r) => r.receivedBy !== '')).toBe(true);
  });
});
