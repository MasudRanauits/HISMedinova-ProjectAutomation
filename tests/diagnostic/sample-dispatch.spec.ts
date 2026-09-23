import { test, expect, investigations } from '../../fixtures/test';
import { SampleDispatchPage, DispatchRow, asPickerDate } from '../../pages/SampleDispatchPage';

const data = investigations.partialSampleDispatch;

/**
 * Dispatching hands the sample to a carrier and cannot be undone from this
 * screen. Set `SAMPLE_DISPATCH=0` to walk the grid, try the carrier-less
 * dispatch and tick the rows without sending anything.
 *
 * The two tests run in order and are each other's setup: the first leaves the
 * invoice partially dispatched, which is where the second picks it up. The
 * invoice is whichever one the investigation spec posted last; see
 * `recordInvoiceNo` in fixtures/test.ts.
 */
const SHOULD_DISPATCH = process.env.SAMPLE_DISPATCH !== '0';

const report = (label: string, rows: DispatchRow[]) => {
  console.log(`--- ${label} ---`);
  rows.forEach((r) =>
    console.log(`  ${r.labNo} | ${r.testName} | ${r.sampleStatus} | carriedBy=${r.carriedBy || '-'} | ticked=${r.selected}`),
  );
};

const listed = (rows: DispatchRow[], name: string) =>
  rows.some((r) => r.testName.toUpperCase().includes(name.toUpperCase()));

/** Yesterday .. today, the range the screen is asked to cover. */
const today = new Date();
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

test.describe.configure({ mode: 'serial' });

test.describe('Partial sample dispatch', () => {
  test('refuses a dispatch with no carrier, then sends the first two tests', async ({ page }) => {
    // Two full passes of the screen, a carrier-less refusal, a carrier picked
    // and a dispatch sent — a dozen round trips over the circuit, each of them
    // a grid the server rebuilds. Three minutes covered that on a quiet server
    // and not on a busy one, and running out of time here is worse than a red
    // test: the samples may already have been handed to the carrier by then,
    // leaving the invoice part dispatched with nothing said about it.
    test.setTimeout(300_000);

    const dispatch = new SampleDispatchPage(page);
    await dispatch.goto();
    await dispatch.recordSnackbars();

    await dispatch.setDateRange(yesterday, today);
    console.log(`date range: ${asPickerDate(yesterday)} .. ${asPickerDate(today)}`);
    await dispatch.show();

    await dispatch.filterBy('Not Dispatched');
    await dispatch.searchInvoice(data.invoiceNo);

    // selectInvoice does the waiting, and explains itself when the invoice is
    // not on the list; checking here first would only bury that with a bare
    // "element not found".
    await dispatch.selectInvoice(data.invoiceNo);
    console.log(
      `invoice row: ${(await dispatch.invoiceRow(data.invoiceNo).innerText()).replace(/\s+/g, ' ').trim()}`,
    );
    const initial = await dispatch.rows();
    report('on opening the invoice (Not Dispatched)', initial);
    expect(initial.length).toBe(data.firstBatch.length + data.secondBatch.length);
    // Nothing has been handed to a carrier yet, and unlike the collection tab
    // this grid starts with nothing ticked.
    expect(initial.every((r) => r.carriedBy === '')).toBe(true);

    // --- trying to dispatch without a carrier ---
    expect(await dispatch.selectedCarrier()).toBe('');

    // The screen will not even let a test be ticked until a carrier is set:
    // the click goes through and the row comes back unticked.
    const stuck = await dispatch.tryTick(data.firstBatch[0]);
    console.log(`ticking "${data.firstBatch[0]}" with no carrier -> ${stuck ? 'ticked' : 'refused'}`);
    expect(stuck).toBe(false);

    await dispatch.clearSnackbars();
    await dispatch.dispatch();
    const refusal = await dispatch.snackbars();
    refusal.forEach((m) => console.log(`snackbar (no carrier): ${m}`));
    expect(refusal.join(' | ')).toMatch(/select sample carrier/i);

    const afterAttempt = await dispatch.rows();
    report('after the carrier-less attempt', afterAttempt);
    expect(afterAttempt.every((r) => r.carriedBy === '')).toBe(true);
    console.log('nothing was dispatched without a carrier');

    // --- with a carrier ---
    const carrier = await dispatch.pickCarrier(data.carrier.query, new RegExp(data.carrier.match, 'i'));
    console.log(`carrier: ${carrier}`);
    expect(await dispatch.selectedCarrier()).toMatch(new RegExp(data.carrier.match, 'i'));

    // Picking the carrier reloads the grid, so the invoice is reopened.
    await dispatch.selectInvoice(data.invoiceNo);
    await dispatch.selectOnly(data.firstBatch);
    const ticked = await dispatch.rows();
    report('ticked for the first batch', ticked);
    expect(ticked.filter((r) => r.selected)).toHaveLength(data.firstBatch.length);

    test.skip(!SHOULD_DISPATCH, 'SAMPLE_DISPATCH=0: stopping before anything is dispatched');

    await dispatch.clearSnackbars();
    await dispatch.dispatch();
    (await dispatch.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/sample-dispatch-first-batch.png', fullPage: true });

    // --- the invoice is now partially dispatched ---
    await dispatch.goto();
    await dispatch.setDateRange(yesterday, today);
    await dispatch.show();
    await dispatch.filterBy('Partial Dispatched');
    await dispatch.searchInvoice(data.invoiceNo);
    await expect(dispatch.invoiceRow(data.invoiceNo)).toBeVisible({ timeout: 60_000 });
    console.log(`invoice ${data.invoiceNo} is listed under "Partial Dispatched"`);
  });

  test('dispatches the remaining tests', async ({ page }) => {
    // Nothing was dispatched by the first test, so there is no partial invoice
    // for this one to pick up.
    test.skip(!SHOULD_DISPATCH, 'SAMPLE_DISPATCH=0: the first test dispatched nothing');
    // The same work again, and then the whole screen a third time to see the
    // invoice under "Dispatched" — which is exactly where the three-minute
    // budget ran out, on a grid that was filling normally.
    test.setTimeout(300_000);

    const dispatch = new SampleDispatchPage(page);
    await dispatch.goto();
    await dispatch.recordSnackbars();

    await dispatch.setDateRange(yesterday, today);
    await dispatch.show();
    await dispatch.filterBy('Partial Dispatched');
    await dispatch.searchInvoice(data.invoiceNo);
    await dispatch.selectInvoice(data.invoiceNo);

    const pending = await dispatch.rows();
    report('still pending', pending);
    data.secondBatch.forEach((name) => expect(listed(pending, name)).toBe(true));

    // The carrier has to be in place before a row will tick.
    const carrier = await dispatch.pickCarrier(data.carrier.query, new RegExp(data.carrier.match, 'i'));
    console.log(`carrier: ${carrier}`);

    await dispatch.selectInvoice(data.invoiceNo);
    await dispatch.selectOnly(data.secondBatch);
    report('ticked for the second batch', await dispatch.rows());

    test.skip(!SHOULD_DISPATCH, 'SAMPLE_DISPATCH=0: stopping before anything is dispatched');

    await dispatch.clearSnackbars();
    await dispatch.dispatch();
    (await dispatch.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/sample-dispatch-second-batch.png', fullPage: true });

    // --- everything is dispatched ---
    await dispatch.goto();
    await dispatch.setDateRange(yesterday, today);
    await dispatch.show();
    await dispatch.filterBy('Dispatched');
    await dispatch.searchInvoice(data.invoiceNo);
    await expect(dispatch.invoiceRow(data.invoiceNo)).toBeVisible({ timeout: 60_000 });
    console.log(`invoice ${data.invoiceNo} is listed under "Dispatched"`);

    await dispatch.selectInvoice(data.invoiceNo);
    const final = await dispatch.rows();
    report('after dispatching everything', final);
    expect(final.every((r) => r.carriedBy !== '')).toBe(true);
  });
});
