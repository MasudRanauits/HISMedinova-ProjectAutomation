import { Page } from '@playwright/test';
import { test, expect, investigations } from '../../fixtures/test';
import { ReportDeliveryPage, DeliveryMode, DeliveryRow } from '../../pages/ReportDeliveryPage';
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

test.describe('Report delivery', () => {
  // Only these two are a chain; the cases below them stand on their own.
  test.describe.configure({ mode: 'serial' });

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

/**
 * One positive case and one negative case, standing apart from the chain above.
 *
 * Neither commits anything. Nothing is ticked, and the Acknowledge and Delivery
 * buttons are never pressed — only Show, the invoice number box and the three
 * radio buttons — so unlike the two tests above these can be run as often as you
 * like, against the same invoice or any other.
 *
 * They prefer the chain's invoice but do not need it — that number is spent as
 * soon as the two tests above have been run against it, and these are worth
 * having on a server the chain has never touched — so they fall back to whatever
 * the screen is listing and skip only when the counter is holding nothing at
 * all. See `openReports` below.
 *
 * `RD_N_*` is what the screen gets right, `RD_B_*` the three defects found on
 * 2026-11-05, each written as the behaviour the screen ought to have and marked
 * `test.fail` — the house style of the collection, dispatch and cancellation
 * suites. A `test.fail` keeps the run green while the defect stands, and the day
 * it is fixed Playwright reports "expected to fail but passed", which is the
 * prompt to delete the marker.
 *
 * | Case | What it holds the screen to |
 * | --- | --- |
 * | `RD_N_01` | an invoice's reports are listed under one stage, all of them its own, stamped as that stage requires |
 * | `RD_N_02` | an invoice number no invoice will ever have empties both grids quietly — as `SC_N_05` and `SD_N_03` ask of the tabs before this one |
 * | `RD_N_03` | the strip over the grid names the patient those reports belong to, with the bill number, age, gender and mobile the counter checks at the window |
 * | `RD_N_04` | the number beside a stage counts the reports that stage is showing |
 * | `RD_N_05` | the header checkbox ticks every report and clears them again |
 * | `RD_N_06` | an unpaid bill is marked DUE on every report and offers Collect Due |
 * | `RD_B_01` | a report whose sample was never collected is still offered for delivery |
 * | `RD_B_02` | the three stages do not filter the invoice list they sit over |
 * | `RD_B_03` | the stage counts keep the dropped invoice's figures when the stage changes |
 *
 * One question these cannot answer: whether the screen should refuse to hand
 * over a report on an unpaid bill. Every row of 2611050200001 read DUE and
 * Acknowledge was offered regardless, but settling that would mean acknowledging
 * a bill for real, which nothing here does. `RD_N_06` pins down what the screen
 * tells the counter instead, and the rule itself is one for the hospital.
 */

/** A 13-digit number no invoice will ever have. */
const MISSING_INVOICE = '9999999999999';

/** The three radio buttons, in the order a report passes through them. */
const STAGES: DeliveryMode[] = ['Not Acknowledged', 'Acknowledged', 'Delivery'];

/**
 * How far back the cases below look.
 *
 * Wider than the chain's own `daysBack`, which only has to reach the invoice
 * the chain just raised. These read whatever the counter happens to be holding,
 * and a UAT server has quiet days — a suite that skips itself for want of data
 * is worth less than no suite at all. `REPORT_DELIVERY_DAYS` widens it further
 * on a quieter one.
 */
const WINDOW_DAYS = Number(process.env.REPORT_DELIVERY_DAYS ?? 10);
const WINDOW_FROM = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

/** Opens the screen on that window, with the snackbar recorder on. */
async function open(page: Page) {
  const delivery = new ReportDeliveryPage(page);
  await delivery.goto();
  await delivery.recordSnackbars();
  await delivery.setDateRange(WINDOW_FROM, today);
  return delivery;
}

/** Records any response the screen gets back with an error status. */
function watchForServerErrors(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  return failures;
}

/**
 * Opens an invoice that actually has reports, and says which stage it was under.
 *
 * The chain's invoice is preferred but not required: these cases read the screen
 * rather than drive the chain, the recorded number is spent as soon as the two
 * tests above have been run against it, and they are worth having on a server
 * the chain has never been run against at all. So when that number is not here,
 * whatever the screen is listing is read instead.
 *
 * A report sits under exactly one of the three stages and which one depends on
 * how far the chain has been run, so the stage is searched for rather than
 * assumed. Answers `undefined` when no invoice holds reports under any of them,
 * which is the caller's cue to skip.
 */
async function openReports(delivery: ReportDeliveryPage): Promise<DeliveryMode | undefined> {
  const named = await delivery.findInvoice(INVOICE);
  if (!named) {
    console.log(`invoice ${INVOICE} is not on this screen; reading whichever invoice it lists instead`);
    await delivery.searchInvoice('');
    await delivery.show();
  }

  for (const mode of STAGES) {
    await delivery.filterBy(mode);
    const opened = named
      ? await delivery.selectInvoice(INVOICE, 10_000)
      : await delivery.selectFirstInvoiceWithReports();
    if (opened && (await delivery.testRows.count())) return mode;
    console.log(`nothing to read under "${mode}"`);
  }

  return undefined;
}

/** The message a case stops with when the counter is holding nothing at all. */
const NOTHING_TO_READ =
  `no invoice holds reports under any of the three stages in the last ${WINDOW_DAYS} days. Widen ` +
  `REPORT_DELIVERY_DAYS, or run the chain from 1-register so there is a report at the counter.`;

test.describe('Report delivery — positive and negative', () => {
  test('RD_N_01 an invoice is listed under its stage with its own reports', async ({ page }) => {
    // Up to three stages are tried, each a filter and a click apart over the
    // circuit, and the invoice is searched for before any of them.
    test.setTimeout(240_000);

    const delivery = await open(page);
    const failures = watchForServerErrors(page);

    const stage = await openReports(delivery);
    test.skip(!stage, NOTHING_TO_READ);

    const rows = await delivery.rows();
    report(`under "${stage}"`, rows);
    expect(rows.length, 'opening an invoice should bring its reports up').toBeGreaterThan(0);

    const invoiceNo = rows[0].invoiceNo;
    console.log(`invoice ${invoiceNo} is under "${stage}", patient: ${await delivery.patient()}`);

    // --- the grid holds that invoice's reports and nobody else's -----------
    expect(
      rows.every((r) => r.invoiceNo === invoiceNo),
      'every row must belong to the invoice that was opened',
    ).toBe(true);
    expect(rows.every((r) => r.testName !== ''), 'a report with no test name is not identifiable').toBe(true);
    expect(
      new Set(rows.map((r) => r.patientName)).size,
      'one invoice is one patient; two names in the grid means rows from another bill',
    ).toBe(1);

    // --- and the stamps the stage is defined by are there -------------------
    if (stage === 'Not Acknowledged') {
      expect(
        rows.every((r) => r.receivedBy === '' && r.receivedAt === ''),
        'nothing under "Not Acknowledged" has been received by anybody yet',
      ).toBe(true);
    }
    // The screen stamps the time but leaves the name column beside it empty in
    // this build, so only the stamp is insisted on — as the chain above does.
    if (stage === 'Acknowledged') {
      expect(rows.every((r) => r.receivedAt !== ''), 'an acknowledged report carries the time it was received').toBe(
        true,
      );
    }
    if (stage === 'Delivery') {
      expect(rows.every((r) => r.deliveredAt !== ''), 'a delivered report carries the time it was handed over').toBe(
        true,
      );
    }

    expect(failures, 'reading an invoice must not produce a server error').toEqual([]);
  });

  test('RD_N_02 an invoice that does not exist leaves both grids empty', async ({ page }) => {
    const delivery = await open(page);
    const failures = watchForServerErrors(page);

    await delivery.searchInvoice(MISSING_INVOICE);
    await delivery.show();

    await expect(
      delivery.invoiceRow(MISSING_INVOICE),
      `${MISSING_INVOICE} is not an invoice; nothing should come back for it`,
    ).toHaveCount(0);
    await expect(
      delivery.testRows,
      'and with no invoice found there is nothing to list reports for',
    ).toHaveCount(0);

    // The invoice number wins over the date range rather than narrowing it (see
    // findInvoice), so a miss here is a miss outright — if the grid still holds
    // rows, they are some other bill's, which is the worst answer this box can
    // give: the counter would hand over the wrong patient's reports.
    expect(failures, 'an unknown invoice must not produce a server error').toEqual([]);
    (await delivery.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    console.log('note: the screen shows no "No data found" text for an empty result');
  });

  test('RD_N_03 the strip over the grid names the patient the open invoice belongs to', async ({ page }) => {
    test.setTimeout(240_000);

    const delivery = await open(page);
    const stage = await openReports(delivery);
    test.skip(!stage, NOTHING_TO_READ);

    const rows = await delivery.rows();
    const strip = (await delivery.patientBar.first().innerText()).replace(/\s+/g, ' ').trim();
    console.log(`strip: ${strip}`);

    // This strip, not the grid, is what the counter reads before handing
    // anything over: it is the only place the age, gender and mobile appear,
    // and it is what the person at the window is checked against. A strip left
    // on the previous patient while another invoice's reports are on screen is
    // how the wrong reports reach the wrong person, so it is pinned to the grid
    // beneath it rather than merely checked for being there.
    expect(
      (await delivery.patientBarName.first().innerText()).replace(/\s+/g, ' ').trim().toUpperCase(),
      'the strip must name the patient whose reports are in the grid',
    ).toBe(rows[0].patientName.toUpperCase());
    expect(
      (await delivery.patientBarInvoice.first().innerText()).replace(/\s+/g, ' ').trim(),
      'and carry the bill number those reports were billed on',
    ).toBe(rows[0].invoiceNo);
    expect(strip, 'with the age, gender and mobile the counter checks against').toMatch(
      /Age:\s*\S+.*Gender:\s*\S+.*Mobile:\s*\S+/i,
    );
  });

  test('RD_N_04 the number beside a stage counts the reports that stage is showing', async ({ page }) => {
    test.setTimeout(240_000);

    const delivery = await open(page);
    const stage = await openReports(delivery);
    test.skip(!stage, NOTHING_TO_READ);

    const rows = await delivery.rows();
    const counts: Record<string, number> = {};
    for (const mode of STAGES) counts[mode] = await delivery.stageCount(mode);
    console.log(`counts: ${JSON.stringify(counts)} against ${rows.length} row(s) under "${stage}"`);

    // The three numbers break the open invoice down by stage — four
    // unacknowledged tests read "Not Acknowledged 4" — which is how the counter
    // tells at a glance what is left to do on the bill in front of them. The
    // one for the stage on screen is the one the grid can be checked against.
    expect(
      counts[stage!],
      `"${stage}" says ${counts[stage!]} but the grid under it lists ${rows.length} report(s)`,
    ).toBe(rows.length);
    expect(
      Object.values(counts).every((n) => n >= 0),
      'each stage should carry a number; a label with none leaves the counter counting rows by hand',
    ).toBe(true);
  });

  test('RD_N_05 the header checkbox ticks every report and clears them again', async ({ page }) => {
    test.setTimeout(240_000);

    const delivery = await open(page);
    const stage = await openReports(delivery);
    test.skip(!stage, NOTHING_TO_READ);

    // Ticking commits nothing: acknowledging and delivering happen on the
    // buttons under the grid, and neither is pressed here, so this leaves the
    // invoice exactly as it found it.
    const before = await delivery.rows();
    expect(before.some((r) => r.selected), 'opening an invoice should leave its reports unticked').toBe(false);

    // Asserted on the boxes themselves rather than on a snapshot of them: each
    // tick lands over the circuit, and reading the grid the instant the click
    // returns catches a row the server has not answered for yet.
    //
    // A locked row is left out. The screen disables some checkboxes — the
    // culture test on 2610260200001 is one — and the header box rightly leaves
    // those alone, so it is held to the rows the counter can actually tick.
    const boxes = delivery.testRows.locator('input[type="checkbox"]');
    const count = await boxes.count();
    const tickable: number[] = [];
    for (let i = 0; i < count; i++) if (await boxes.nth(i).isEnabled()) tickable.push(i);

    console.log(`${tickable.length} of ${count} report(s) can be ticked`);
    test.skip(!tickable.length, 'every report on this invoice is locked; nothing for the header box to tick');

    await delivery.tickAllFromHeader();
    for (const i of tickable) {
      await expect(
        boxes.nth(i),
        `the header box is the counter's "all of them"; row ${i + 1} of ${count} did not tick`,
      ).toBeChecked({ timeout: 15_000 });
    }
    report('after the header box', await delivery.rows());

    await delivery.tickAllFromHeader();
    for (const i of tickable) {
      await expect(
        boxes.nth(i),
        `pressing it again must clear every one of them; row ${i + 1} of ${count} stayed ticked`,
      ).not.toBeChecked({ timeout: 15_000 });
    }
  });

  test('RD_N_06 an unpaid bill says so on every report and offers Collect Due', async ({ page }) => {
    test.setTimeout(240_000);

    const delivery = await open(page);
    await delivery.show();
    await delivery.filterBy('Not Acknowledged');

    // Most bills at the counter are settled, so the first invoice listed is
    // usually PAID and says nothing about what an unpaid one does. The list is
    // walked for one that still owes something instead.
    const listed = Math.min(await delivery.invoiceRows.count(), 8);
    let rows: DeliveryRow[] = [];
    for (let i = 0; i < listed; i++) {
      await delivery.invoiceRows.nth(i).click();
      await page.waitForTimeout(5_000);
      const current = await delivery.rows();
      if (!current.length) continue;

      console.log(
        `invoice ${current[0].invoiceNo}: ${JSON.stringify([...new Set(current.map((r) => r.paymentStatus))])}`,
      );
      expect(
        current.every((r) => r.paymentStatus !== ''),
        'every report must say where its bill stands; a blank payment status tells the counter nothing',
      ).toBe(true);

      rows = current;
      if (current.some((r) => /due/i.test(r.paymentStatus))) break;
    }

    test.skip(
      !rows.some((r) => /due/i.test(r.paymentStatus)),
      `none of the first ${listed} invoices under "Not Acknowledged" still owes anything; this case needs an ` +
        `unpaid bill to read`,
    );

    // Whether the screen should refuse to hand over an unpaid report is a
    // question for the hospital, and it cannot be asked from here without
    // acknowledging something for real. What can be checked is that the counter
    // is told and given somewhere to go: the DUE badge, and the button beside
    // the strip that settles the bill without leaving the screen.
    await expect(
      delivery.collectDueButton,
      'a bill with money owing must offer Collect Due at the counter',
    ).toBeVisible({ timeout: 15_000 });
  });

  /**
   * RD_B_01: a sample that was never collected cannot have been run, so there
   * is no result, no finalized report and nothing to hand to anybody — yet the
   * row is listed under "Not Acknowledged" with a live checkbox beside it.
   *
   * Seen on 2026-11-05 on 2611050200001, where SERUM ALBUMIN, SERUM CREATININE
   * read "Not Collected" and ticked as readily as the other three.
   *
   * It is not that the screen cannot lock a row: 2610260200001 carries four
   * reading "Not Collected", and the culture one among them *is* locked, with
   * its checkbox disabled, while the other three tick. So the mechanism is
   * there and the sample's own status is simply not among the things it is
   * driven by.
   */
  test.fail('RD_B_01 a report whose sample was never collected is not offered for delivery', async ({ page }) => {
    test.setTimeout(300_000);

    const delivery = await open(page);
    await delivery.show();
    await delivery.filterBy('Not Acknowledged');

    const listed = Math.min(await delivery.invoiceRows.count(), 8);
    let uncollected: DeliveryRow | undefined;
    for (let i = 0; i < listed && !uncollected; i++) {
      await delivery.invoiceRows.nth(i).click();
      await page.waitForTimeout(5_000);
      uncollected = (await delivery.rows()).find((r) => /not collected/i.test(r.sampleStatus));
    }
    test.skip(
      !uncollected,
      `none of the first ${listed} invoices under "Not Acknowledged" carries an uncollected sample to check`,
    );

    const row = uncollected!;
    console.log(`${row.testName} on ${row.invoiceNo} reads sample status "${row.sampleStatus}"`);

    const box = delivery.testRow(row.testName).locator('input[type="checkbox"]').first();
    expect(
      (await box.count()) === 0 || (await box.isDisabled()),
      `"${row.testName}" has no sample collected yet, so no report for it exists — the counter should not be ` +
        `able to tick it through to Acknowledged`,
    ).toBe(true);
  });

  /**
   * RD_B_02: the three radio buttons sit over the invoice list but do not
   * narrow it. Over ten days on 2026-11-05 the list held the same 36 invoices
   * under all three, and most of them came back with an empty grid — including
   * 2610260200001, which has five reports under "Not Acknowledged" and none
   * under "Acknowledged", yet is offered under both.
   *
   * The counter's job here is "whose reports are ready", and the screen answers
   * it by making them click every invoice in the range to find out. The same
   * shape as `SC_B_03` on the collection tab, where the collection-point filter
   * narrows nothing either.
   */
  test.fail('RD_B_02 the three stages filter the invoice list they sit over', async ({ page }) => {
    test.setTimeout(300_000);

    const delivery = await open(page);
    await delivery.show();
    await delivery.filterBy('Acknowledged');

    const listed = Math.min(await delivery.invoiceRows.count(), 6);
    test.skip(listed === 0, `no invoice listed in the last ${WINDOW_DAYS} days to check`);

    let empty = 0;
    for (let i = 0; i < listed; i++) {
      await delivery.invoiceRows.nth(i).click();
      await page.waitForTimeout(5_000);
      const rows = await delivery.testRows.count();
      if (!rows) empty++;
      console.log(`invoice ${i + 1} of ${listed} under "Acknowledged": ${rows} report row(s)`);
    }

    expect(
      empty,
      `${empty} of the first ${listed} invoices offered under "Acknowledged" hold nothing under it. A stage the ` +
        `list is not filtered by makes the counter open invoices one at a time to find the reports that are ready`,
    ).toBe(0);
  });

  /**
   * RD_B_03: the counts beside the radios describe whichever invoice is open —
   * open one with three delivered reports and they read "Delivery 3" — but they
   * are not cleared when the stage changes and the invoice is dropped. The
   * grid empties; the numbers stay.
   *
   * Seen on 2026-11-05: after reading 2610260200003 under "Delivery" the labels
   * read "Not Acknowledged 2, Acknowledged 0, Delivery 3", and switching to
   * "Not Acknowledged" left them saying exactly that over an empty grid.
   */
  test.fail('RD_B_03 the stage counts are cleared when the stage changes', async ({ page }) => {
    test.setTimeout(300_000);

    const delivery = await open(page);
    const stage = await openReports(delivery);
    test.skip(!stage, NOTHING_TO_READ);

    const opened: Record<string, number> = {};
    for (const mode of STAGES) opened[mode] = await delivery.stageCount(mode);
    console.log(`with an invoice open under "${stage}": ${JSON.stringify(opened)}`);

    const other = STAGES.find((m) => m !== stage)!;
    await delivery.filterBy(other);
    const onScreen = await delivery.testRows.count();

    const after: Record<string, number> = {};
    for (const mode of STAGES) after[mode] = await delivery.stageCount(mode);
    console.log(`after switching to "${other}" over ${onScreen} row(s): ${JSON.stringify(after)}`);

    // If the switch kept an invoice open, the counts have something to describe
    // and there is nothing to accuse the screen of.
    test.skip(onScreen > 0, `switching to "${other}" left ${onScreen} report(s) on screen`);

    expect(
      after,
      `the counts describe whichever invoice is open, so with none open they should read 0 — instead they still ` +
        `hold the figures for the invoice that was open under "${stage}"`,
    ).toEqual({ 'Not Acknowledged': 0, Acknowledged: 0, Delivery: 0 });
  });
});
