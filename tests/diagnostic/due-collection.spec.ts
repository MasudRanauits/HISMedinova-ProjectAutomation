import { test, expect, investigations } from '../../fixtures/test';
import { DueCollectionPage } from '../../pages/DueCollectionPage';
import { InvestigationPage } from '../../pages/InvestigationPage';
import { InvestigationDashboardPage } from '../../pages/InvestigationDashboardPage';
import { CorporateInvoiceDashboardPage } from '../../pages/CorporateInvoiceDashboardPage';

const data = investigations.dueCollection;

/**
 * Due Collection, and the four shapes of bill that reach it.
 *
 * The screen takes the rest of the money on a bill that was posted owing
 * something. What it shows depends on how much of that bill the counter has
 * already had, and this file walks one bill through every one of those states
 * in order:
 *
 * - **due** — posted with nothing paid, so the whole bill is outstanding;
 * - **partly paid** — some of it collected, Previous Paid carrying what was
 *   taken and Due Amount what is left;
 * - **paid** — nothing left, the money panel dead and Save not offered;
 * - **corporate** — a due that is the company's share rather than the
 *   patient's. That one is read and not collected: settling it would move a
 *   real company's balance, so the spec finds a corporate bill that is already
 *   outstanding rather than clearing one.
 *
 * Along the way it hands the money over by each of the three methods the
 * screen offers — cash, a card, a mobile wallet — one per instalment, so the
 * Transaction History ends up naming all three.
 *
 * ## The bill is raised here, not inherited from the chain
 *
 * Every other diagnostic spec works on the invoice `2-invoice` posted, and
 * that one is no use here: it is a Staff Discount bill, and the app refuses to
 * post one of those owing anything ("Staff Hospital discount: due amount must
 * be fully paid."). So the first test raises a plain bill of its own, against
 * the patient the chain registered, and pays nothing at all against it.
 *
 * ## One circuit, start to finish
 *
 * The screen locks the bill it has open, and the lock outlives the Blazor
 * circuit that took it by several minutes. Coming back to Due Collection
 * starts a *new* circuit, so a test that re-opened the screen between
 * instalments would be locked out by its own previous visit — the panel dead,
 * and nothing but the banner to say why. The tests below therefore open the
 * screen once and re-fetch the bill with `load`, which stays on the circuit
 * that already holds it.
 */
test.describe.serial('Due collection', () => {
  /** The bill the first test raises; every test after it works on that one. */
  let billNo = '';
  /** What that bill came to, before a taka of it had been collected. */
  let billTotal = 0;

  test('raises a bill with nothing paid and finds all of it outstanding here', async ({ page }) => {
    // Posting drives half a dozen round trips, answers a confirmation modal,
    // then goes to the dashboard to read the new number back.
    test.setTimeout(240_000);

    page.on('popup', (p) => p.close().catch(() => {}));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    const investigation = new InvestigationPage(page);
    await investigation.goto();
    await investigation.recordSnackbars();

    const patientName = await investigation.searchByUhid(data.uhid);
    expect(patientName, `no patient for UHID ${data.uhid}`).not.toEqual('');
    const patientMobile = await investigation.mobile.inputValue();
    console.log(`patient: ${patientName} (UHID ${data.uhid}, mobile ${patientMobile})`);

    const doctor = await investigation.setReferredBy(
      data.referredBy.query,
      new RegExp(data.referredBy.match, 'i'),
    );
    console.log(`referred by: ${doctor}`);

    const added = await investigation.addTests(
      data.tests.map((t) => ({ query: t.query, match: new RegExp(t.match, 'i') })),
    );
    added.forEach((t) => console.log(`test: ${t}`));

    const totals = await investigation.settledTotals();
    console.log('bill:', totals);
    expect(totals.netPayable).toBeGreaterThan(0);
    // Nothing is paid, which is the whole point of this bill: the due is the
    // bill.
    expect(totals.due).toBe(totals.netPayable);
    billTotal = totals.netPayable;

    await investigation.setRemarks(data.remarks);
    await investigation.post();

    // POST on an unpaid bill does not save it — it asks first.
    const asked = await investigation.confirmDueBill();
    console.log(`due bill modal: ${asked || '(none)'}`);
    expect(
      asked,
      'POST on a bill with nothing paid should ask before writing it as a due bill',
    ).toMatch(/post it as a due bill/i);
    expect(asked, 'and the modal should name the due the screen is showing').toContain(String(billTotal));

    await page.waitForTimeout(15_000);
    const messages = await investigation.snackbars();
    messages.forEach((m) => console.log(`snackbar: ${m}`));
    expect(messages.join(' | ')).toMatch(/successful save/i);

    // The app never shows the number it just wrote, so it is read back off the
    // dashboard — which is also what proves the bill is real.
    const dashboard = new InvestigationDashboardPage(page);
    await dashboard.goto();
    await dashboard.show();
    await dashboard.filter(patientMobile);

    const bills = await dashboard.rows();
    bills.forEach((b) =>
      console.log(`bill ${b.billNo} | ${b.entryDate} ${b.entryTime} | ${b.fullName} | ${b.status}`),
    );
    const owing = bills.filter((b) => /due/i.test(b.status));
    expect(
      owing,
      `no DUE bill on the dashboard for ${patientMobile} — the post did not land as a due bill`,
    ).not.toHaveLength(0);

    billNo = owing[owing.length - 1].billNo.replace(/\D/g, '');
    console.log(`collecting against bill ${billNo}, ${billTotal} Tk outstanding`);

    // --- and now the screen itself ---
    const due = new DueCollectionPage(page);
    await due.goto();
    await due.recordSnackbars();

    expect(await due.load(billNo), `bill ${billNo} should load on Due Collection`).toBe(true);
    expect(await due.lockNotice(), 'a bill just raised cannot be open anywhere else').toBe('');

    const details = await due.details();
    console.log('bill details:', details);
    expect(details.patientName.toUpperCase()).toContain(patientName.toUpperCase());

    const billed = await due.tests();
    billed.forEach((t) => console.log(`  ${t.code} | ${t.name} | ${t.total}`));
    expect(billed.length, 'the bill should list what it was raised for').toBeGreaterThan(0);

    const money = await due.totals();
    console.log('money panel:', money);
    expect(money.subTotal).toBe(billTotal);
    expect(money.previousPaid, 'nothing was paid at the counter').toBe(0);
    expect(money.dueAmount, 'so the whole bill is outstanding').toBe(billTotal);
    // Net Payable on this screen is what is still payable rather than what the
    // bill came to; on an untouched bill the two are the same number.
    expect(money.netPayable).toBe(money.dueAmount);

    const ledger = await due.transactions();
    ledger.forEach((t) => console.log(`  ${t.date} | dr ${t.debit} | cr ${t.credit} | ${t.description}`));
    expect(ledger, 'a bill nobody has paid against has one line, the bill itself').toHaveLength(1);
    expect(ledger[0].description).toMatch(/service cost/i);
    expect(ledger[0].debit).toBe(billTotal);
    expect(ledger[0].credit).toBe(0);

    expect(await due.collectable(), 'the money panel should be live on a bill with a due').toBe(true);
    expect(await due.canSave(), 'and Save offered').toBe(true);
  });

  test('refuses the bill to a second counter while this one has it open', async ({ page, browser }) => {
    test.setTimeout(180_000);
    test.skip(!billNo, 'no bill was raised');

    // This page still has the bill open from the test above, which is what the
    // second counter is about to run into.
    const due = new DueCollectionPage(page);
    expect(await due.lockNotice(), 'this counter is the one holding the bill').toBe('');

    const other = await browser.newContext({
      storageState: test.info().project.use.storageState,
      ignoreHTTPSErrors: true,
      viewport: null,
    });
    const otherPage = await other.newPage();

    try {
      const second = new DueCollectionPage(otherPage);
      await second.goto();
      await second.load(billNo);

      const notice = await second.lockNotice();
      console.log(`second counter saw: ${notice || '(nothing)'}`);
      expect(
        notice,
        'two counters collecting the same bill at once would take the money twice',
      ).toMatch(/open on another PC/i);
      expect(await second.collectable(), 'and the money panel should be dead there').toBe(false);
      expect(await second.canSave(), 'Save included').toBe(false);

      await otherPage.screenshot({ path: 'test-results/due-collection-locked.png', fullPage: true });
    } finally {
      await other.close();
    }
  });

  test('takes part of the due in cash and leaves the rest owing', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(!billNo, 'no bill was raised');

    const due = new DueCollectionPage(page);
    const before = await due.totals();

    await due.payCash(data.instalments.cash);
    const typed = await due.totals();
    console.log(`cash ${data.instalments.cash}:`, typed);
    expect(typed.payment).toBe(data.instalments.cash);
    expect(typed.dueAmount, 'the due should come down as the money is counted').toBe(
      before.dueAmount - data.instalments.cash,
    );

    await due.setRemarks(data.remarks);
    await due.clearSnackbars();
    await due.save();
    await page.waitForTimeout(12_000);
    const said = (await due.snackbars()).join(' | ');
    console.log(`snackbar: ${said || '(none)'}`);
    // "Due collected." — not the "Successful Save!" the entry screen answers
    // with, and the only thing the app says about it either way.
    expect(said, 'the collection is only ever reported in a snackbar').toMatch(/due collected/i);

    await due.load(billNo);
    const after = await due.totals();
    console.log('after the cash instalment:', after);
    expect(after.previousPaid, 'what was handed over is now on the bill').toBe(data.instalments.cash);
    expect(after.dueAmount, 'and the rest is still owing').toBe(billTotal - data.instalments.cash);
    expect(after.dueAmount).toBeGreaterThan(0);
    expect(await due.canSave(), 'a part-paid bill can still be collected against').toBe(true);

    const collected = (await due.transactions()).filter((t) => /duecollection/i.test(t.description));
    collected.forEach((t) => console.log(`  ${t.description} | ${t.instrument || '-'} | cr ${t.credit}`));
    expect(collected, 'the collection should be on the ledger').toHaveLength(1);
    expect(collected[0].description, 'named as cash').toMatch(/cash/i);
    expect(collected[0].credit).toBe(data.instalments.cash);
  });

  test('takes the next instalment on a card', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(!billNo, 'no bill was raised');

    const due = new DueCollectionPage(page);
    const before = await due.totals();

    await due.payByCard(data.card as 'VISA', data.instalments.card);
    console.log(`card ${data.card} ${data.instalments.card}:`, await due.totals());

    await due.setRemarks(data.remarks);
    await due.clearSnackbars();
    await due.save();
    await page.waitForTimeout(12_000);
    const said = (await due.snackbars()).join(' | ');
    console.log(`snackbar: ${said || '(none)'}`);
    expect(said).toMatch(/due collected/i);

    await due.load(billNo);
    const after = await due.totals();
    console.log('after the card instalment:', after);
    expect(after.previousPaid).toBe(before.previousPaid + data.instalments.card);
    expect(after.dueAmount).toBe(before.dueAmount - data.instalments.card);

    const ledger = await due.transactions();
    ledger.forEach((t) => console.log(`  ${t.description} | ${t.instrument || '-'} | cr ${t.credit}`));
    const onCard = ledger.filter((t) => /card/i.test(`${t.description} ${t.instrument}`));
    expect(onCard, 'the card collection should say it was taken on a card').not.toHaveLength(0);
    expect(onCard[onCard.length - 1].credit).toBe(data.instalments.card);
  });

  test('clears the rest on a mobile wallet, and the bill is then paid', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(!billNo, 'no bill was raised');

    const due = new DueCollectionPage(page);
    const before = await due.totals();
    expect(before.dueAmount, 'there should still be something to clear').toBeGreaterThan(0);

    await due.payByMobile(data.mobile as 'BKash', before.dueAmount);
    await due.setRemarks(data.remarks);
    await due.clearSnackbars();
    await due.save();
    await page.waitForTimeout(12_000);
    const said = (await due.snackbars()).join(' | ');
    console.log(`snackbar: ${said || '(none)'}`);
    expect(said).toMatch(/due collected/i);

    await due.load(billNo);
    const after = await due.totals();
    console.log('after the wallet instalment:', after);

    // --- the paid patient ---
    expect(after.dueAmount, 'the bill is settled').toBe(0);
    expect(after.previousPaid, 'and everything it came to has been collected').toBe(billTotal);
    expect(after.netPayable, 'with nothing left payable').toBe(0);

    const ledger = await due.transactions();
    ledger.forEach((t) =>
      console.log(`  ${t.date} | cr ${t.credit} | ${t.description} | ${t.instrument || '-'}`),
    );
    const collected = ledger.filter((t) => /duecollection/i.test(t.description));
    expect(collected, 'three instalments, one per payment method').toHaveLength(3);
    expect(
      collected.reduce((sum, t) => sum + t.credit, 0),
      'and they should add up to the bill',
    ).toBe(billTotal);

    // The ledger is the only place the screen says how a payment was taken —
    // "DueCollection(Cash)", "DueCollection(Card-EBL POS)",
    // "DueCollection(Mobile-BKash)" — so each instalment is checked against the
    // method it was handed over on.
    expect(collected[0].description, 'the first instalment was cash').toMatch(/cash/i);
    expect(collected[1].description, 'the second was on a card').toMatch(/card/i);
    expect(collected[2].description, `the third was on ${data.mobile}`).toMatch(
      new RegExp(`mobile.*${data.mobile}`, 'i'),
    );

    await page.screenshot({ path: 'test-results/due-collection-settled.png', fullPage: true });
  });

  /**
   * Nothing owing means nothing to collect, and the screen says so.
   *
   * The bill above has just been settled to the taka — Due Amount 0, Net
   * Payable 0, every instalment on the ledger — and the panel is left looking
   * usable all the same: Payment (Cash) enabled and **Save** offered, where
   * before any bill is fetched both are disabled.
   *
   * That is cosmetic, and this test is what establishes it rather than
   * assuming either way: **Save is actually pressed**, twice. With nothing
   * typed the screen answers "Nothing to collect -- enter a payment or a
   * discount first."; with an amount typed against a bill that owes nothing the
   * box refuses it outright ("Please input correct value") and Save answers the
   * same way again. Neither press writes a line to the ledger, so a counter who
   * fetched an already-paid bill and pressed Save cannot take money for it.
   */
  test('refuses a collection against a bill that owes nothing', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(!billNo, 'no bill was raised');

    const due = new DueCollectionPage(page);
    const settled = await due.totals();
    expect(settled.dueAmount, 'this test is about a bill with nothing left owing').toBe(0);
    const before = await due.transactions();

    // The buttons are left looking live even though there is nothing to do.
    console.log(
      `on a settled bill — payment box: ${(await due.collectable()) ? 'live' : 'dead'}, ` +
        `save: ${await due.canSave()}`,
    );

    // --- Save with nothing typed ---
    await due.clearSnackbars();
    await due.save();
    await page.waitForTimeout(12_000);
    const onEmptySave = (await due.snackbars()).join(' | ');
    console.log(`save with nothing typed: ${onEmptySave || '(nothing said)'}`);
    expect(
      onEmptySave,
      'pressing Save on a bill that owes nothing should be refused, and said so',
    ).toMatch(/nothing to collect/i);

    // --- and with an amount typed against it ---
    await due.payCash(50);
    const typed = await due.totals();
    console.log('50 Tk typed against a bill that owes nothing:', typed);
    expect(typed.payment, 'the box should not even hold the amount').toBe(0);

    await due.clearSnackbars();
    await due.save();
    await page.waitForTimeout(12_000);
    const onOverpay = (await due.snackbars()).join(' | ');
    console.log(`save with 50 typed: ${onOverpay || '(nothing said)'}`);
    expect(onOverpay).toMatch(/correct value|nothing to collect/i);

    // --- and the bill is where it was ---
    await due.load(billNo);
    const after = await due.totals();
    console.log('after both refused saves:', after);
    expect(after.previousPaid, 'nothing was taken').toBe(settled.previousPaid);
    expect(after.dueAmount, 'and the bill is still settled').toBe(0);
    expect(
      await due.transactions(),
      'a refused save must leave no line on the ledger',
    ).toHaveLength(before.length);

    // Leave the screen, so the lock on this bill is given up rather than left
    // to time out on the server.
    await page.goto('/diagnostic/investigation-dashboard');
  });

  /**
   * The fourth shape: a due that is a company's, not a patient's.
   *
   * A corporate bill is settled in two parts. The counter takes its share in
   * cash when the bill is raised on the CORPORATE PATIENT tab, and the company
   * is invoiced for the balance — which is why one lands as **DUE** rather than
   * half-finished. That balance is collected on this same screen, with no
   * corporate handling of its own: the counter fetches it by bill number like
   * any other.
   *
   * So this test reads one, checks the arithmetic closes against what the
   * company was invoiced for, then **clears the balance in cash** and checks
   * the bill leaves the outstanding list on the corporate dashboard.
   *
   * It spends the bill it works on, the way `10-report-delivery` spends its
   * invoice: a corporate bill cleared here is PAID for good. A fresh one comes
   * from the corporate half of `2-invoice` on each run of the chain, and the
   * test skips with a note if none is outstanding.
   */
  test('clears a corporate bill of the share owed by the company', async ({ page }) => {
    test.setTimeout(300_000);

    // A corporate bill is not on the diagnostic dashboard at all — it is filed
    // under Corporate Management — so that is where one is found.
    const corporate = new CorporateInvoiceDashboardPage(page);
    await corporate.goto();
    await corporate.show();

    const owing = (await corporate.rows()).filter((b) => /due/i.test(b.status));
    owing.forEach((b) =>
      console.log(`corporate bill ${b.billNo} | ${b.fullName} | ${b.corporateClient} | ${b.status}`),
    );
    test.skip(
      owing.length === 0,
      'no corporate bill is outstanding today. One is raised by the CORPORATE PATIENT half of 2-invoice, ' +
        'which settles part of it in cash at the counter and leaves the company the rest; run that first.',
    );

    const bill = owing[owing.length - 1];
    const billDigits = bill.billNo.replace(/\D/g, '');

    const due = new DueCollectionPage(page);
    await due.goto();
    await due.recordSnackbars();
    expect(
      await due.load(billDigits),
      `corporate bill ${bill.billNo} should load on Due Collection — the counter settles the company's ` +
        `share on the same screen as a patient's`,
    ).toBe(true);
    expect(await due.lockNotice()).toBe('');

    const money = await due.totals();
    const ledger = await due.transactions();
    console.log(`corporate bill ${billDigits} for ${bill.corporateClient}:`, money);
    ledger.forEach((t) => console.log(`  dr ${t.debit} | cr ${t.credit} | ${t.description}`));

    // What the counter already took, and what the company was left with.
    const credited = ledger.reduce((sum, t) => sum + t.credit, 0);
    const paid = ledger
      .filter((t) => /payment|duecollection/i.test(t.description))
      .reduce((sum, t) => sum + t.credit, 0);

    expect(paid, 'part of a corporate bill is settled in cash at the counter').toBeGreaterThan(0);
    expect(money.previousPaid, 'and that is what Previous Paid carries').toBe(paid);
    expect(money.dueAmount, "the company's share is still outstanding").toBeGreaterThan(0);
    expect(
      money.previousPaid + money.dueAmount + (credited - paid),
      'the bill, the discount on it and everything paid against it have to add up',
    ).toBe(money.subTotal);
    expect(money.netPayable, 'Net Payable on this screen is what is left to pay').toBe(money.dueAmount);
    expect(
      await due.canSave(),
      'the counter takes a corporate due here the same as any other',
    ).toBe(true);

    // --- and now settle the company's share ---
    await due.payCash(money.dueAmount);
    expect((await due.totals()).dueAmount, 'the balance should be covered in full').toBe(0);

    await due.setRemarks(data.remarks);
    await due.clearSnackbars();
    await due.save();
    await page.waitForTimeout(12_000);
    const said = (await due.snackbars()).join(' | ');
    console.log(`snackbar: ${said || '(none)'}`);
    expect(said).toMatch(/due collected/i);

    await due.load(billDigits);
    const settled = await due.totals();
    console.log('corporate bill after the balance was taken:', settled);
    expect(settled.dueAmount, 'the company owes nothing further').toBe(0);
    expect(settled.previousPaid, 'and the bill is paid down to its discount').toBe(
      money.subTotal - (credited - paid),
    );

    const closing = await due.transactions();
    closing.forEach((t) => console.log(`  cr ${t.credit} | ${t.description}`));
    const taken = closing.filter((t) => /duecollection/i.test(t.description));
    expect(taken, "the counter's collection should be on the company's bill").toHaveLength(1);
    expect(taken[0].credit).toBe(money.dueAmount);
    expect(taken[0].description, 'taken in cash').toMatch(/cash/i);

    await page.screenshot({ path: 'test-results/due-collection-corporate.png', fullPage: true });

    // --- and it is no longer outstanding where it is filed ---
    await page.goto('/marketing/corporate-invoice-dashboard');
    await corporate.show();
    const now = (await corporate.rows()).find((b) => b.billNo === bill.billNo);
    console.log(`${bill.billNo} on the corporate dashboard: ${now?.status ?? '(gone)'}`);
    expect(now?.status, `${bill.billNo} should read PAID now that its balance has been taken`).toMatch(
      /paid/i,
    );
  });
});
