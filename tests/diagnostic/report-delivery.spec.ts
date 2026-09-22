import { test, expect, investigations } from '../../fixtures/test';
import { ReportDeliveryPage, DeliveryRow } from '../../pages/ReportDeliveryPage';
import { asPickerDate } from '../../pages/SampleDispatchPage';

const data = investigations.reportDelivery;

/**
 * Report Delivery, the counter's last screen: the invoice is found by date range
 * and number, its finished reports are acknowledged as ready to hand over, then
 * delivered to the patient and printed.
 *
 * Every stage of the screen is one-way — acknowledging takes a report out of the
 * pending list for good, delivering takes it out of the acknowledged one — so
 * neither test can be run twice against the same invoice. A second run finds the
 * list empty and stops with a note saying so rather than failing. Set
 * `REPORT_DELIVERY=0` to walk the screen and tick the rows without acknowledging
 * or delivering anything, which is the safe way to exercise it.
 *
 * The two tests run in order and are each other's setup: the first leaves the
 * invoice's reports acknowledged, which is where the second picks them up. The
 * invoice is whichever one the investigation spec posted last; see
 * `recordInvoiceNo` in fixtures/test.ts.
 */
const SHOULD_DELIVER = process.env.REPORT_DELIVERY !== '0';

/**
 * The invoice worked on. `REPORT_DELIVERY_INVOICE` aims the spec at a particular
 * one for a single run — useful precisely because the screen is one-way, so the
 * recorded invoice is spent as soon as this has been run against it once.
 */
const INVOICE = process.env.REPORT_DELIVERY_INVOICE || investigations.reportDelivery.invoiceNo;

/** The range the screen is asked to cover: `daysBack` ago .. today. */
const today = new Date();
const from = new Date(today.getTime() - data.daysBack * 24 * 60 * 60 * 1000);

const report = (label: string, rows: DeliveryRow[]) => {
  console.log(`--- ${label} ---`);
  rows.forEach((r, i) =>
    console.log(
      `  ${i + 1}. ${r.testName} | print=${r.printStatus || '-'} | sample=${r.sampleStatus || '-'} | ` +
        `payment=${r.paymentStatus || '-'} | received=${r.receivedBy || r.receivedAt || '-'} | ` +
        `delivered=${r.deliveredBy || r.deliveredAt || '-'} | ticked=${r.selected}`,
    ),
  );
};

/** Opens the screen on one invoice, narrowed by date range and invoice number. */
async function findInvoice(delivery: ReportDeliveryPage) {
  await delivery.goto();
  await delivery.recordSnackbars();

  await delivery.setDateRange(from, today);
  console.log(`date range: ${asPickerDate(from)} .. ${asPickerDate(today)}`);

  const listed = await delivery.findInvoice(INVOICE);
  console.log(`invoice ${INVOICE} in the list after Show: ${listed}`);
  expect(
    listed,
    `invoice ${INVOICE} is not in the list. The number is searched for on its own — the date range above it does ` +
      `not bound it — so this means no such invoice, rather than one outside the range: run the investigation spec ` +
      `to raise a fresh one, which records the new number for this spec too.`,
  ).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test.describe('Report delivery', () => {
  test('acknowledges the invoice\'s pending reports', async ({ page }) => {
    // The screen is reloaded, filtered and shown twice over, and every tick
    // round-trips over the circuit, which runs well past the 90s default.
    test.setTimeout(240_000);

    const delivery = new ReportDeliveryPage(page);
    await findInvoice(delivery);

    await delivery.filterBy('Not Acknowledged');
    const opened = await delivery.selectInvoice(INVOICE);
    test.skip(
      !opened,
      `invoice ${INVOICE} has nothing left under "Not Acknowledged" — its reports have already been ` +
        `acknowledged, and acknowledging cannot be undone from this screen. Run the chain from 1-register for a ` +
        `fresh invoice, or point reportDelivery.invoiceNo at one whose reports are still pending.`,
    );

    console.log(`patient: ${await delivery.patient()}`);
    const pending = await delivery.rows();
    report('pending acknowledgement', pending);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((r) => r.invoiceNo === INVOICE)).toBe(true);
    // Nothing here has been received by anyone yet — that is what this stage is.
    expect(pending.every((r) => r.receivedBy === '' && r.receivedAt === '')).toBe(true);

    const ticked = await delivery.tickAllInOrder();
    ticked.forEach((name, i) => console.log(`ticked ${i + 1}: ${name}`));
    expect(ticked).toHaveLength(pending.length);
    expect((await delivery.rows()).every((r) => r.selected)).toBe(true);

    test.skip(!SHOULD_DELIVER, 'REPORT_DELIVERY=0: stopping before anything is acknowledged');

    // The button takes whatever is ticked, and the grid is redrawn with what is
    // left — so it is pressed again for anything a pass did not carry, rather
    // than once and hoped for. Two passes is already more than the screen has
    // ever needed; the third is there to break the loop rather than to be used.
    for (let pass = 1; pass <= 3; pass++) {
      const left = await delivery.testRows.count();
      if (!left) break;

      console.log(`pass ${pass}: ${left} report(s) still pending`);
      await delivery.tickAllInOrder();
      await delivery.clearSnackbars();
      await delivery.acknowledge();

      const said = await delivery.dismissModal();
      if (said) console.log(`dialog: ${said}`);
      (await delivery.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    }

    await page.screenshot({ path: 'test-results/report-delivery-acknowledged.png', fullPage: true });

    // --- the reports have left the pending list ---
    await expect(
      delivery.testRows,
      'every report that was ticked should have left "Not Acknowledged"',
    ).toHaveCount(0, { timeout: 30_000 });

    await delivery.filterBy('Acknowledged');
    expect(await delivery.selectInvoice(INVOICE), 'the invoice should now be under "Acknowledged"').toBe(
      true,
    );

    const acknowledged = await delivery.rows();
    report('after acknowledging', acknowledged);
    // The screen stamps the time it was received; the name column it draws
    // beside it is left empty by this build, so only the stamp is insisted on.
    const justAcknowledged = acknowledged.filter((r) =>
      ticked.some((t) => r.testName.toUpperCase() === t.toUpperCase()),
    );
    expect(justAcknowledged.length).toBe(ticked.length);
    expect(justAcknowledged.every((r) => r.receivedAt !== '')).toBe(true);
  });

  test('delivers the acknowledged reports and prints them', async ({ page }) => {
    test.skip(!SHOULD_DELIVER, 'REPORT_DELIVERY=0: the first test acknowledged nothing to deliver');
    test.setTimeout(240_000);

    // Print All renders the reports and hands them to a printer; on this server
    // that opens a PDF tab, which would otherwise sit in the shared context for
    // the rest of the run. Closed the same way the label spec closes its popups.
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('popup', (p) => p.close().catch(() => {}));

    const delivery = new ReportDeliveryPage(page);
    await findInvoice(delivery);

    await delivery.filterBy('Acknowledged');
    const opened = await delivery.selectInvoice(INVOICE);
    test.skip(
      !opened,
      `invoice ${INVOICE} has nothing under "Acknowledged" — its reports have already been delivered, and ` +
        `delivering cannot be undone from this screen. Run the chain from 1-register for a fresh invoice.`,
    );

    console.log(`patient: ${await delivery.patient()}`);
    const ready = await delivery.rows();
    report('ready to deliver', ready);
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.every((r) => r.receivedAt !== '')).toBe(true);

    // Ticked one at a time, top to bottom, in the order the rows are numbered
    // on screen.
    const ticked = await delivery.tickAllInOrder();
    ticked.forEach((name, i) => console.log(`ticked ${i + 1}: ${name}`));
    expect(ticked).toHaveLength(ready.length);
    expect((await delivery.rows()).every((r) => r.selected)).toBe(true);

    await delivery.clearSnackbars();
    await delivery.deliver();
    const saidOnDelivery = await delivery.dismissModal();
    if (saidOnDelivery) console.log(`dialog: ${saidOnDelivery}`);
    (await delivery.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/report-delivery-delivered.png', fullPage: true });

    // --- the reports have moved on to the delivered list ---
    await delivery.filterBy('Delivery');
    expect(await delivery.selectInvoice(INVOICE), 'the invoice should now be under "Delivery"').toBe(true);

    const delivered = await delivery.rows();
    report('after delivering', delivered);
    ticked.forEach((name) =>
      expect(
        delivered.some((r) => r.testName.toUpperCase() === name.toUpperCase()),
        `${name} was delivered but is not listed under "Delivery"`,
      ).toBe(true),
    );
    expect(delivered.every((r) => r.deliveredAt !== '')).toBe(true);

    // Print All is pressed after the delivery, as the counter works through the
    // screen — but on this list rather than the one before it. The button is
    // drawn beside the Delivery button only while the acknowledged grid still
    // has rows, and delivering is exactly what empties that grid, so pressing it
    // there prints nothing and there is nothing left to press. Here it prints
    // the reports that were just handed over, which is what it was for.
    await delivery.clearSnackbars();
    await delivery.printAll();
    const saidOnPrint = await delivery.dismissModal();
    if (saidOnPrint) console.log(`dialog: ${saidOnPrint}`);
    (await delivery.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/report-delivery-printed.png', fullPage: true });

    // Printing a delivered report changes nothing, so the row's own print button
    // is exercised here rather than against a report still to be handed over.
    //
    // Printing is not asserted on beyond that. The app prints straight to a
    // configured printer and says nothing when it works, and it sometimes
    // answers "Server returned an unexpected payload" when it does not — seen on
    // one run of the row reprint and not on the next, against the same report.
    // Anything it says is logged, so an unexpected payload in the output is the
    // app's complaint rather than the test's.
    await delivery.printRow(ticked[0]);
    console.log(`reprinted ${ticked[0]} from its own row`);
    (await delivery.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));

    const after = await delivery.rows();
    expect(
      after.map((r) => `${r.testName}|${r.deliveredAt}`).sort(),
      'printing must not change what has been delivered',
    ).toEqual(delivered.map((r) => `${r.testName}|${r.deliveredAt}`).sort());
  });
});
