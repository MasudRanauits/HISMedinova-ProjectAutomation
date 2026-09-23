import { Page } from '@playwright/test';
import { test, expect, investigations, recordInvoiceNo } from '../../fixtures/test';
import { InvestigationPage } from '../../pages/InvestigationPage';
import { InvestigationDashboardPage } from '../../pages/InvestigationDashboardPage';

const data = investigations.staffDiscountInvoice;

/**
 * Posting writes a real invoice against live patient data, and nothing in the
 * app stops the same bill being raised twice — every run of this test bills the
 * patient again. Set `INVOICE_POST=0` to run everything up to POST and stop,
 * which is the right way to exercise the screen.
 */
const SHOULD_POST = process.env.INVOICE_POST !== '0';

test.describe('Diagnostic investigation invoice', () => {
  test('bills a staff-discounted investigation and settles it in cash', async ({
    investigationPage,
    page,
  }) => {
    // The heaviest test in the suite, and the only one the rest of the chain
    // depends on. It drives half a dozen autocompletes — each its own round trip
    // — waits fifteen seconds on the post, then goes to the dashboard to read
    // the new invoice number back, which lands it near the 90s default even on a
    // quiet server and over it on a busy one. Running out of time here is worse
    // than a red test: POST has already written a real invoice by then, so the
    // run ends with a bill on the system that `recordInvoiceNo` never got to
    // record, and the sample specs are left pointing at the previous run's
    // invoice. The negative tests below take 180s for far less work.
    test.setTimeout(180_000);

    // Posting renders the cash memo and opens it as a PDF in a second tab, which
    // then sits in the shared context for the rest of the run — every later spec
    // in the chain inherits it. Closed the same way the label spec closes its
    // print popups.
    page.on('popup', (p) => p.close().catch(() => {}));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    await investigationPage.recordSnackbars();

    const patientName = await investigationPage.searchByUhid(data.uhid);
    expect(patientName).not.toEqual('');
    // The registration spec gives each patient its own mobile number, which is
    // what makes this bill findable on the dashboard afterwards.
    const patientMobile = await investigationPage.mobile.inputValue();
    console.log(`patient: ${patientName} (UHID ${data.uhid}, mobile ${patientMobile})`);

    const doctor = await investigationPage.setReferredBy(
      data.referredBy.query,
      new RegExp(data.referredBy.match, 'i'),
    );
    console.log(`referred by: ${doctor}`);

    const added = await investigationPage.addTests(
      data.tests.map((t) => ({ query: t.query, match: new RegExp(t.match, 'i') })),
    );
    added.forEach((t) => console.log(`test: ${t}`));

    // The grid can hold more rows than tests picked: a microbiology test pulls
    // in its sample tube as a line of its own.
    const gridRows = await investigationPage.testNames();
    gridRows.forEach((name, i) => console.log(`grid row ${i + 1}: ${name}`));
    expect(gridRows.length).toBeGreaterThanOrEqual(data.tests.length);

    const beforeDiscount = await investigationPage.settledTotals();
    console.log('before discount:', beforeDiscount);
    expect(beforeDiscount.subTotal).toBeGreaterThan(0);

    const category = await investigationPage.setDiscountCategory(
      data.discountCategory.query,
      new RegExp(data.discountCategory.match, 'i'),
    );
    console.log(`discount category: ${category}`);

    // The category rebates the discountable part of the bill, and the strip
    // only catches up a beat later.
    const totals = await investigationPage.settledTotals();
    console.log('after discount:', totals);
    expect(totals.netPayable).toBeGreaterThan(0);
    expect(totals.netPayable).toBeLessThan(beforeDiscount.netPayable);

    // Rounded down so the payment never exceeds the bill. A staff-discounted
    // bill will only post at 100%: anything less is refused on POST with
    // "Staff Hospital discount: due amount must be fully paid." and no invoice
    // is written.
    const payment = Math.floor((totals.netPayable * data.paymentPercent) / 100);
    await investigationPage.payCash(payment);
    console.log(`paid ${payment} of ${totals.netPayable} (${data.paymentPercent}%)`);

    const afterPayment = await investigationPage.settledTotals();
    console.log('after payment:', afterPayment);
    expect(afterPayment.netPayable).toBe(totals.netPayable);
    expect(afterPayment.due).toBe(totals.netPayable - payment);

    await investigationPage.setRemarks(data.remarks);
    console.log(`remarks: ${data.remarks}`);

    test.skip(!SHOULD_POST, 'INVOICE_POST=0: stopping before the invoice is posted');

    await investigationPage.post();
    await page.waitForTimeout(15_000);

    const messages = await investigationPage.snackbars();
    messages.forEach((m) => console.log(`snackbar: ${m}`));

    await page.screenshot({ path: 'test-results/investigation-invoice-posted.png', fullPage: true });

    // A refusal is only ever reported in a snackbar — the form is left exactly
    // as it was — so the outcome has to be read out of the messages. Anything
    // the app says about printing is beside the point here: on this server it
    // renders the memo to a PDF tab (closed above) rather than to a printer.
    expect(messages.join(' | ')).toMatch(/successful save/i);

    // The invoice is only real if the dashboard lists it — and since the app
    // never shows the number it just wrote, this is also where it is read back.
    const dashboard = new InvestigationDashboardPage(page);
    await dashboard.goto();
    await dashboard.show();
    await dashboard.filter(patientMobile);

    let bills = await dashboard.rows();
    if (!bills.length) {
      // Older builds only search the name column.
      await dashboard.filter(patientName);
      bills = (await dashboard.rows()).filter((b) => b.mobile === patientMobile);
    }
    bills.forEach((b) => console.log(`bill ${b.billNo} | ${b.entryDate} ${b.entryTime} | ${b.fullName} | ${b.status}`));
    expect(bills, `no invoice on the dashboard for ${patientMobile}`).toHaveLength(1);
    expect(bills[0].fullName.toUpperCase()).toContain(patientName.toUpperCase());

    // The dashboard prints the bill as MDH2609190200003; the sample screens
    // know it by its digits alone.
    const invoiceNo = bills[0].billNo.replace(/\D/g, '');
    expect(invoiceNo).not.toEqual('');
    recordInvoiceNo(invoiceNo);
  });

  /**
   * Read-only: reports the invoices already on today's dashboard for the
   * patient. Safe to run on its own — it bills no one.
   */
  test('lists the patient\'s invoices on the diagnostic dashboard', async ({ page }) => {
    const dashboard = new InvestigationDashboardPage(page);
    await dashboard.goto();
    await dashboard.show();
    await dashboard.filter(data.patientSearch);

    const bills = await dashboard.rows();
    bills.forEach((b) =>
      console.log(`bill ${b.billNo} | ${b.entryDate} ${b.entryTime} | ${b.fullName} | ${b.mobile} | ${b.status}`),
    );
    console.log(`${bills.length} invoice(s) for "${data.patientSearch}" today`);
  });
});

/**
 * Negative tests for the patient demographics on OPD Investigation Entry,
 * TC-11 to TC-24.
 *
 * These work on a walk-in: with no UHID looked up, the demographic fields are
 * typed by hand, which is when their validation has anything to do. After a
 * lookup the same fields are disabled and filled from the patient record.
 *
 * None of these can raise an invoice. No test is ever added to the bill, and
 * the screen refuses to post without one — it answers "Please fill testitem
 * grid." — so POST is safe to press here as often as the cases need.
 *
 * Where the screen does not do what a case asks for, the test is marked
 * `test.fail()`: the run stays green, the gap stays on the record, and if it is
 * ever fixed Playwright reports "expected to fail but passed".
 *
 * POST checks one thing at a time, in this order: name, then mobile, then age,
 * then referring doctor, then the test grid. Several cases below rely on that —
 * to reach the complaint about mobile, the name has to be valid first.
 */
async function freshForm(page: Page) {
  const investigation = new InvestigationPage(page);
  await investigation.goto();
  await investigation.recordSnackbars();
  return investigation;
}

/** "23-09-2026" -> "24-09-2026". The pickers on this screen read DD-MM-YYYY. */
function dayAfter(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(next.getDate())}-${pad(next.getMonth() + 1)}-${next.getFullYear()}`;
}

/** Presses POST and hands back everything the screen said about it. */
async function postAndListen(investigation: InvestigationPage, page: Page): Promise<string> {
  await investigation.clearSnackbars();
  await investigation.post();
  await page.waitForTimeout(7_000);
  const said = (await investigation.snackbars()).join(' | ');
  console.log(`POST said: ${said || '(nothing)'}`);
  return said;
}

test.describe('Investigation entry — negative (demographics)', () => {
  test('TC-11 a blank Full Name stops the post', async ({ page }) => {
    const investigation = await freshForm(page);

    const said = await postAndListen(investigation, page);

    expect(said).toMatch(/fill name/i);
    await expect(investigation.fullName).toHaveClass(/is-invalid/);
  });

  test('TC-12 a symbol in the name is called out', async ({ page }) => {
    const investigation = await freshForm(page);

    const held = await investigation.typeInto(investigation.fullName, 'Rahim123@#');
    console.log(`typed "Rahim123@#", field holds "${held}"`);

    // Digits are allowed here by design — the rule the app states is letters,
    // digits and . - / ( ) — so it is the "@" that should be objected to.
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`the screen said: ${said}`);
    expect(said).toMatch(/not allowed in a patient name/i);
  });

  // TC-13: all 300 characters are kept; the field has no maximum length.
  test.fail('TC-13 the name field caps how much can be pasted into it', async ({ page }) => {
    const investigation = await freshForm(page);

    const held = await investigation.typeInto(investigation.fullName, 'A'.repeat(300));
    console.log(`300 characters pasted, the field holds ${held.length}`);

    expect(held.length, 'a name field with no ceiling is a needless payload surface').toBeLessThan(300);
  });

  test('TC-14 a name of nothing but spaces counts as blank', async ({ page }) => {
    const investigation = await freshForm(page);

    const held = await investigation.typeInto(investigation.fullName, '   ');
    expect(held, 'whitespace should not pass for a name').toBe('');

    const said = await postAndListen(investigation, page);
    expect(said).toMatch(/fill name/i);
  });

  test('TC-15 a blank Mobile No stops the post', async ({ page }) => {
    const investigation = await freshForm(page);

    await investigation.typeInto(investigation.fullName, 'TEST PATIENT');
    const said = await postAndListen(investigation, page);

    expect(said).toMatch(/fill mobileno/i);
    await expect(investigation.mobile).toHaveClass(/is-invalid/);
  });

  // TC-16: 12345 and a 14-digit number are both accepted; POST moves straight
  // on to complain about the age instead.
  test.fail('TC-16 a malformed mobile number is rejected', async ({ page }) => {
    const investigation = await freshForm(page);

    await investigation.typeInto(investigation.fullName, 'TEST PATIENT');
    const held = await investigation.typeInto(investigation.mobile, '12345');
    console.log(`typed 12345, the field holds "${held}"`);

    const said = await postAndListen(investigation, page);
    expect(said, 'a five-digit mobile number should not get past the form').toMatch(/mobile/i);
  });

  test('TC-17 Title is not mandatory on this screen', async ({ page }) => {
    const investigation = await freshForm(page);

    // The case allows for Title being optional, and here it is: with Title left
    // on "Select", POST never mentions it and gets all the way to the bill.
    await investigation.typeInto(investigation.fullName, 'TEST PATIENT');
    await investigation.typeInto(investigation.mobile, '01700000001');
    await investigation.typeInto(investigation.ageYears, '30');
    await investigation.setReferredBy(data.referredBy.query, new RegExp(data.referredBy.match, 'i'));

    expect(await investigation.title.inputValue()).toBe('0');
    const said = await postAndListen(investigation, page);

    expect(said, 'the post should have run out of complaints before the bill').toMatch(/testitem grid/i);
  });

  // TC-18: Gender is drawn with the red border of a required field, but nothing
  // enforces it — an invoice can be raised for a patient with no gender.
  test.fail('TC-18 a blank Gender stops the post', async ({ page }) => {
    const investigation = await freshForm(page);

    await investigation.typeInto(investigation.fullName, 'TEST PATIENT');
    await investigation.typeInto(investigation.mobile, '01700000001');
    await investigation.typeInto(investigation.ageYears, '30');
    await investigation.setReferredBy(data.referredBy.query, new RegExp(data.referredBy.match, 'i'));

    expect(await investigation.gender.inputValue()).toBe('0');
    const said = await postAndListen(investigation, page);

    expect(said, 'gender is marked invalid on screen but never blocks the post').toMatch(/gender/i);
  });

  test('TC-19a an age of zero is refused', async ({ page }) => {
    const investigation = await freshForm(page);

    await investigation.typeInto(investigation.fullName, 'TEST PATIENT');
    await investigation.typeInto(investigation.mobile, '01700000001');

    const said = await postAndListen(investigation, page);
    expect(said).toMatch(/age cannot be zero/i);
  });

  test('TC-19b a negative age cannot be typed', async ({ page }) => {
    const investigation = await freshForm(page);

    const held = await investigation.typeInto(investigation.ageYears, '-5');
    console.log(`typed -5, the field holds "${held}"`);
    expect(held.startsWith('-'), 'the minus sign should not survive').toBe(false);
  });

  // TC-19c: 999 years is accepted whole; nothing bounds the age from above.
  test.fail('TC-19c an impossible age is refused', async ({ page }) => {
    const investigation = await freshForm(page);

    const held = await investigation.typeInto(investigation.ageYears, '999');
    console.log(`typed 999, the field holds "${held}"`);

    expect(Number(held), 'no one is 999 years old').toBeLessThan(150);
  });

  // TC-20: the boxes wrap instead of refusing — 15 months becomes 3, 45 days
  // becomes 14, with nothing said.
  test.fail('TC-20 an out-of-range month or day is refused, not wrapped', async ({ page }) => {
    const investigation = await freshForm(page);

    const months = await investigation.typeInto(investigation.ageMonths, '15');
    const days = await investigation.typeInto(investigation.ageDays, '45');
    console.log(`typed 15 months and 45 days; the fields hold "${months}" and "${days}"`);

    expect(
      [months, days],
      'silently turning 15 months into 3 changes the record without telling anyone',
    ).toEqual(['', '']);
  });

  test('TC-21a letters cannot be typed into the age', async ({ page }) => {
    const investigation = await freshForm(page);

    const held = await investigation.typeInto(investigation.ageYears, 'ab');
    console.log(`typed "ab", the field holds "${held}"`);
    expect(held).toMatch(/^\d*$/);
  });

  // TC-21b: "2.5" comes out as "5" — the digits are kept but the wrong one wins.
  test.fail('TC-21b a decimal age is refused rather than mangled', async ({ page }) => {
    const investigation = await freshForm(page);

    const held = await investigation.typeInto(investigation.ageYears, '2.5');
    console.log(`typed "2.5", the field holds "${held}"`);

    expect(
      held === '' || held === '2',
      `"2.5" should be refused or read as 2, but the field holds "${held}"`,
    ).toBe(true);
  });

  test('TC-22 a date of birth in the future is not accepted', async ({ page }) => {
    // The picker is bounded by the server's today, and this server's clock runs
    // ahead of the machine running the tests: on the evening of 22-09 it was
    // already posting invoices dated 23-09. A "tomorrow" worked out from
    // `Date.now()` is therefore the app's *today*, which it rightly accepts —
    // and the test fails on a clock rather than on a defect.
    //
    // So the app is asked what today is before it is asked to refuse tomorrow.
    // A date far beyond any plausible skew clamps straight back to it.
    //
    // The probe gets a form of its own because setting a second date on a form
    // that has already had one is not judged the same way: on a fresh form
    // tomorrow clamps back to today, but on a form whose picker has already been
    // driven to its limit the same tomorrow is accepted and kept. That looks
    // like a defect in its own right — it is left out of this case, which is
    // about the boundary rather than about the picker's memory.
    const probe = await freshForm(page);
    const appToday = await probe.setDateOfBirth('01-01-2099');
    console.log(`a far-future date clamps to "${appToday}" — the app's today`);
    expect(appToday, 'the picker should have clamped 01-01-2099 back to today').toMatch(
      /^\d{2}-\d{2}-\d{4}$/,
    );
    expect(appToday).not.toBe('01-01-2099');

    const investigation = await freshForm(page);
    const typed = dayAfter(appToday);
    const held = await investigation.setDateOfBirth(typed);
    console.log(`typed the app's tomorrow (${typed}), the field holds "${held}"`);

    // The picker will not go past today; it clamps rather than complaining.
    expect(held).not.toBe(typed);
  });

  test('TC-23 date of birth and age stay in step with each other', async ({ page }) => {
    const investigation = await freshForm(page);

    const dob = await investigation.setDateOfBirth('01-01-2000');
    const derivedAge = await investigation.ageYears.inputValue();
    console.log(`DOB ${dob} gives age ${derivedAge}`);
    expect(Number(derivedAge)).toBeGreaterThan(20);

    // Overriding the age rewrites the date of birth to match, so the two can
    // never disagree in a saved record.
    await investigation.typeInto(investigation.ageYears, '10');
    const rewritten = await investigation.dateOfBirth.inputValue();
    console.log(`age forced to 10, DOB is now ${rewritten}`);
    expect(rewritten).not.toBe(dob);
  });

  test('TC-24 an untouched form marks every missing field at once', async ({ page }) => {
    const investigation = await freshForm(page);

    const said = await postAndListen(investigation, page);
    expect(said).toMatch(/fill name/i);

    // One message, but the red borders go on together — name, gender, mobile
    // and the referring doctor are all flagged from the single press.
    const flagged = await page.locator('.is-invalid:visible, .dropdown-invalid:visible').count();
    console.log(`${flagged} field(s) flagged by one press of POST`);
    expect(flagged).toBeGreaterThanOrEqual(3);
  });
});

/**
 * Negative tests for the totals panel on the same screen, TC-01 to TC-06
 * (your NP-01 to NP-06).
 *
 * Tests are put on the bill here so the figures have something to add up, but
 * POST is never pressed and the bill goes away with the page, so nothing is
 * invoiced.
 */
test.describe('Investigation entry — negative (totals panel)', () => {
  /** The panel's figures are spans, not fields; this is how they are read. */
  const summaryValues = (page: Page) => page.locator('span.inv2-summary-val');

  /**
   * The Sub total row on its own.
   *
   * The panel does hold one real field — Payment (cash) — so "no inputs in the
   * panel" would be the wrong thing to ask. The question is whether this
   * particular figure is one.
   */
  const subTotalRow = (page: Page) =>
    page
      .locator('.inv2-summary-row')
      .filter({ has: page.locator('.inv2-summary-label', { hasText: /^Sub total$/ }) })
      .first();

  test('TC-01 Sub total cannot be typed into', async ({ page }) => {
    const investigation = await freshForm(page);

    // The row is a label and a span — there is no field to put a caret in.
    const fields = await subTotalRow(page).locator('input').count();
    console.log(`fields inside the Sub total row: ${fields}`);
    expect(fields, 'a calculated figure should not be an input').toBe(0);

    const subTotal = summaryValues(page).first();
    await expect(subTotal).toHaveText('0');
    await subTotal.click({ force: true });
    await page.keyboard.type('12345');
    await page.waitForTimeout(1_000);
    await expect(subTotal, 'typing at the figure must not change it').toHaveText('0');
  });

  test('TC-02 a tampered Sub total is cosmetic and feeds nothing', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await freshForm(page);

    await investigation.addTest({ query: 'BLOOD FOR TC, DC', match: /TC, DC, HB% & ESR/i });
    const real = await investigation.settledTotals();
    console.log(`real sub total ${real.subTotal}, net payable ${real.netPayable}`);

    // Rewrite the figure in the page, the way dev tools would.
    await page.evaluate(() => {
      const el = document.querySelector('span.inv2-summary-val');
      if (el) el.textContent = '999999';
    });
    await expect(summaryValues(page).first()).toHaveText('999999');
    console.log('the displayed sub total has been tampered with');

    // There is nothing behind the figure to submit: no field, no bound value.
    expect(await subTotalRow(page).locator('input').count()).toBe(0);

    // And nothing downstream moves with it — what is owed is unchanged.
    const netPayable = await investigation.totalsRow(/Net payable/i);
    console.log(`net payable after the tamper: ${netPayable}`);
    expect(netPayable, 'the amount owed must not follow the tampered display').toBe(real.netPayable);

    // Worth recording: the edit stays on screen. Blazor does not repaint a
    // figure it believes it has already drawn, so the operator would go on
    // seeing 999999 until the page is reloaded — a display that has drifted
    // from the bill, even though the bill itself is untouched.
    await expect(summaryValues(page).first()).toHaveText('999999');
    console.log('note: the tampered figure stays on screen until the page reloads');
  });

  test('TC-02b posting a tampered bill is rejected by the server', async () => {
    test.skip(
      true,
      'The other half of the case needs a bill actually posted with the total tampered, which would put a real ' +
        'invoice on the live ledger. TC-02 covers what can be shown without that: the figure is a span with no ' +
        'field behind it, so there is nothing for a tamperer to submit. Worth confirming against a test database.',
    );
  });

  test('TC-03 deleting the last test takes Sub total back to zero', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await freshForm(page);

    await investigation.addTest({ query: 'BLOOD FOR TC, DC', match: /TC, DC, HB% & ESR/i });
    const withTest = await investigation.settledTotals();
    console.log(`with one test: sub total ${withTest.subTotal}`);
    expect(withTest.subTotal).toBeGreaterThan(0);

    // A test can bring consumables in with it, so clear the grid out entirely.
    while ((await investigation.gridRows.count()) > 0) {
      await investigation.removeRow((await investigation.gridRows.count()) - 1);
    }

    const empty = await investigation.settledTotals();
    console.log(`after clearing the grid: sub total ${empty.subTotal}, net payable ${empty.netPayable}`);
    expect(empty.subTotal, 'a stale total after the grid empties would be a defect').toBe(0);
    expect(empty.netPayable).toBe(0);
  });

  test('TC-04 Discountable never exceeds Sub total', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await freshForm(page);

    // A government-fixed-rate test carries no discount at all.
    await investigation.addTest({ query: 'CBC', match: /Govt\. Fixed Rate/i });
    const fixedOnly = await investigation.settledTotals();
    console.log(`government-rate test only: sub total ${fixedOnly.subTotal}, discountable ${fixedOnly.discountable}`);
    expect(fixedOnly.discountable, 'a fixed-rate test is not discountable').toBe(0);

    // And with ordinary tests alongside it the discountable part stays a part.
    await investigation.addTest({ query: 'LIPID', match: /SERUM LIPID PROFILE \(FASTING\)/i });
    const mixed = await investigation.settledTotals();
    console.log(`mixed bill: sub total ${mixed.subTotal}, discountable ${mixed.discountable}`);
    expect(mixed.discountable).toBeGreaterThan(0);
    expect(mixed.discountable, 'more can never be discountable than is owed').toBeLessThanOrEqual(mixed.subTotal);
  });

  test('TC-05 a fresh bill reads zero, not blank', async ({ page }) => {
    const investigation = await freshForm(page);

    expect(await investigation.gridRows.count()).toBe(0);

    const text = await summaryValues(page).allInnerTexts();
    console.log(`the panel reads: ${JSON.stringify(text)}`);
    expect(text.length).toBeGreaterThan(0);

    for (const value of text) {
      expect(value.trim(), 'an empty bill must still show a number').not.toBe('');
      expect(value).not.toMatch(/nan|undefined|null|-/i);
    }

    const totals = await investigation.settledTotals();
    expect(totals.subTotal).toBe(0);
    expect(totals.netPayable).toBe(0);
  });

  test('TC-06 a large bill is shown in full, without clipping', async ({ page }) => {
    test.setTimeout(240_000);
    const investigation = await freshForm(page);

    // The most expensive things this screen sells. A bill of 99,99,999 is not
    // reachable through the UI — quantities are fixed at one per line, so it
    // would take a thousand-odd lines — but these push it well past the point
    // where a thousands separator and the column width start to matter.
    for (const [query, match] of [
      ['GeneXpert', /GeneXpert/i],
      ['MRI OF BRAIN', /MRI OF BRAIN/i],
      ['CULTURE', /BLOOD CULTURE/i],
      ['LIPID', /SERUM LIPID PROFILE \(FASTING\)/i],
    ] as const) {
      await investigation.addTest({ query, match });
    }

    const totals = await investigation.settledTotals();
    console.log(`a bill of ${await investigation.gridRows.count()} line(s): sub total ${totals.subTotal}`);
    expect(totals.subTotal).toBeGreaterThan(10_000);

    // Read it as it is written, separators and all, and check nothing is lost.
    const shown = (await summaryValues(page).first().innerText()).trim();
    console.log(`the panel shows "${shown}"`);
    expect(Number(shown.replace(/,/g, '')), 'the figure on screen must match the one being charged').toBe(
      totals.subTotal,
    );
    expect(shown, 'a large figure should be grouped for reading').toMatch(/^\d{1,3}(,\d{3})*$/);

    // And the box it sits in has to be wide enough for it.
    const clipped = await summaryValues(page)
      .first()
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped, 'the figure must not be cut off by its own column').toBe(false);
  });
});

/**
 * Negative tests for the discount category on the same screen, TC-07 to TC-10
 * (your NP-07 to NP-10).
 *
 * Nothing is posted here either — a bill is built up so the discount has
 * something to bite on, and then abandoned.
 */
test.describe('Investigation entry — negative (discount category)', () => {
  /** A bill with one discountable test on it, for the discount to act on. */
  async function billWithOneTest(page: Page) {
    const investigation = await freshForm(page);
    await investigation.searchByUhid(investigations.staffDiscountInvoice.uhid);
    await investigation.addTest({ query: 'LIPID', match: /SERUM LIPID PROFILE \(FASTING\)/i });
    return investigation;
  }

  // TC-07: the field takes anything typed at it. Worse than that, a real
  // category can be picked for a patient with no entitlement to one — every
  // Staff Discount raised by the chain specs went to a walk-in patient with no
  // employee number.
  test.fail('TC-07 the D. Category field cannot be typed into', async ({ page }) => {
    const investigation = await freshForm(page);

    await expect(investigation.discountCategory).toHaveValue('N/A');
    expect(await investigation.discountCategory.isEditable()).toBe(true);

    const held = await investigation.typeInto(investigation.discountCategory, 'ZZZ NOT A CATEGORY');
    console.log(`typed "ZZZ NOT A CATEGORY", the field holds "${held}"`);

    expect(
      await investigation.discountCategory.isEditable(),
      'a category that comes from a mapping should not be typed by hand',
    ).toBe(false);
  });

  test('TC-08 a discount is refused while the category is N/A', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithOneTest(page);

    const before = await investigation.settledTotals();
    await expect(investigation.discountCategory).toHaveValue('N/A');
    console.log(`category N/A, net payable ${before.netPayable}`);

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountPercent, '50');

    const said = (await investigation.snackbars()).join(' | ');
    const after = await investigation.settledTotals();
    console.log(`the screen said: ${said || '(nothing)'}`);
    console.log(`DISC(%) now holds "${await investigation.discountPercent.inputValue()}"`);

    expect(said, 'the refusal should say why').toMatch(/not allowed|category/i);
    expect(await investigation.discountPercent.inputValue()).toBe('0');
    expect(after.netPayable, 'nothing may come off the bill').toBe(before.netPayable);
  });

  test('TC-09 an employee patient arrives with their category already set', async () => {
    test.skip(
      true,
      'Needs a patient mapped to a discount category — an employee, or someone on a corporate account. Every ' +
        'patient this suite creates is a walk-in with no employee number, and the screen offers no way to find ' +
        'one that has a mapping. Give it an employee number to search on and this becomes a real test.',
    );
  });

  // TC-10: clearing the form does not put the category back to N/A — it comes
  // back reading "General Discount", the first entry in the list. The next
  // patient billed on that form starts out entitled to a discount nobody
  // granted them. (The expected result was cut off in the case; taken to be
  // that the category returns to its unset state.)
  test.fail('TC-10 clearing the form puts the category back to N/A', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithOneTest(page);

    console.log(`before the reset: patient "${await investigation.fullName.inputValue()}", ` +
      `category "${await investigation.discountCategory.inputValue()}"`);

    await investigation.resetButton.click();
    await page.waitForTimeout(7_000);

    const patient = await investigation.fullName.inputValue();
    const category = await investigation.discountCategory.inputValue();
    const totals = await investigation.settledTotals();
    console.log(`after the reset: patient "${patient}", category "${category}", sub total ${totals.subTotal}`);

    // The rest of the form does clear properly.
    expect(patient).toBe('');
    expect(totals.subTotal).toBe(0);

    expect(category, 'a cleared form should not carry a discount category into the next patient').toBe('N/A');
  });
});

/**
 * Negative tests for the DISC(%) and DISC(Tk) boxes, TC-51 to TC-63.
 *
 * These are your NP-11 to NP-23. They are numbered from 51 here because
 * TC-11 to TC-24 are already taken by the demographics cases above; each title
 * carries its NP number so the two sheets still line up.
 *
 * A discount needs a category to work against — with D. Category on N/A every
 * value is refused, which is TC-08 — so these run against General Discount,
 * whose ceiling is 50%. POST is never pressed.
 *
 * The thread running through the failures: both boxes strip characters they do
 * not understand and then use whatever digits are left. A minus sign is dropped,
 * so -300 becomes a 300 taka discount; a decimal point is dropped, so 33.33
 * becomes 3333 and is clamped to the ceiling. Nothing is refused outright.
 */
test.describe('Investigation entry — negative (discount amounts)', () => {
  /** The ceiling General Discount allows, as the screen reports it. */
  const CEILING = 50;

  /** A discountable bill with a category that permits a discount. */
  async function billWithCategory(page: Page) {
    const investigation = await freshForm(page);
    await investigation.searchByUhid(investigations.staffDiscountInvoice.uhid);
    await investigation.addTest({ query: 'LIPID', match: /SERUM LIPID PROFILE \(FASTING\)/i });
    await investigation.setDiscountCategory('General', /^General Discount$/i);
    await investigation.settledTotals();
    return investigation;
  }

  test('TC-51 (NP-11) a percentage above 100 never applies', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountPercent, '150');

    const applied = Number(await investigation.discountPercent.inputValue());
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`typed 150, the box holds ${applied}; the screen said: ${said || '(nothing)'}`);

    expect(applied, 'a discount over 100% is meaningless').toBeLessThanOrEqual(100);
    expect(applied, 'and this category stops well before that').toBeLessThanOrEqual(CEILING);
    expect(said).toMatch(/not allowed/i);
  });

  // TC-52: the minus is dropped and what is left is applied — the operator
  // meant to enter something invalid and got a real 10% discount instead.
  test.fail('TC-52 (NP-12) a negative percentage is refused', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountPercent, '-10');

    const applied = Number(await investigation.discountPercent.inputValue());
    const after = await investigation.settledTotals();
    console.log(`typed -10, the box holds ${applied}; net payable ${before.netPayable} -> ${after.netPayable}`);

    expect(after.netPayable, 'a negative percentage must take nothing off the bill').toBe(before.netPayable);
  });

  // TC-53: the same again in taka — -300 comes out as a 300 taka discount, and
  // this time without even a message.
  test.fail('TC-53 (NP-13) a negative taka discount is refused', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountTaka, '-300');

    const applied = Number(await investigation.discountTaka.inputValue());
    const after = await investigation.settledTotals();
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`typed -300, the box holds ${applied}; net payable ${before.netPayable} -> ${after.netPayable}`);
    console.log(`the screen said: ${said || '(nothing)'}`);

    expect(after.netPayable, 'a negative amount must leave the bill alone').toBe(before.netPayable);
  });

  test('TC-54 (NP-14) a discount larger than the bill is refused', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountTaka, '99999');

    const after = await investigation.settledTotals();
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`typed 99999 against a bill of ${before.subTotal}; net payable ${after.netPayable}`);
    console.log(`the screen said: ${said || '(nothing)'}`);

    expect(said).toMatch(/not allowed/i);
    expect(Number(await investigation.discountTaka.inputValue())).toBe(0);
    expect(after.netPayable, 'what is owed must never go negative').toBe(before.netPayable);
    expect(after.netPayable).toBeGreaterThan(0);
  });

  test('TC-55a (NP-15) letters cannot be typed into a discount', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);
    const before = await investigation.settledTotals();

    await investigation.typeInto(investigation.discountPercent, 'abc');
    const after = await investigation.settledTotals();

    console.log(`typed "abc", the box holds "${await investigation.discountPercent.inputValue()}"`);
    expect(await investigation.discountPercent.inputValue()).toMatch(/^\d*$/);
    expect(after.netPayable).toBe(before.netPayable);
  });

  // TC-55b: "1,000" loses its comma, becomes 1000, and is clamped to the
  // ceiling — a slip of the keyboard hands out the largest discount going.
  test.fail('TC-55b (NP-15) a thousands separator is refused, not stripped', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountPercent, '1,000');

    const applied = Number(await investigation.discountPercent.inputValue());
    const after = await investigation.settledTotals();
    console.log(`typed "1,000", the box holds ${applied}; net payable ${before.netPayable} -> ${after.netPayable}`);

    expect(after.netPayable, 'a malformed number must not become the maximum discount').toBe(before.netPayable);
  });

  // TC-56: "10.5.5" loses both dots and is clamped to the ceiling.
  test.fail('TC-56 (NP-16) a number with two decimal points is refused', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountPercent, '10.5.5');

    const applied = Number(await investigation.discountPercent.inputValue());
    const after = await investigation.settledTotals();
    console.log(`typed "10.5.5", the box holds ${applied}; net payable ${before.netPayable} -> ${after.netPayable}`);

    expect(after.netPayable, 'nonsense must not become the maximum discount').toBe(before.netPayable);
  });

  test('TC-57 (NP-17) leading zeros are normalised', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);

    await investigation.typeInto(investigation.discountPercent, '0010');
    const applied = Number(await investigation.discountPercent.inputValue());
    console.log(`typed "0010", the box holds ${applied}`);

    expect(applied, '0010 is ten, not zero and not NaN').toBe(10);
  });

  test('TC-58 (NP-18) the two discount boxes stay in step', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);
    const start = await investigation.settledTotals();

    await investigation.typeInto(investigation.discountPercent, '10');
    const byPercent = await investigation.settledTotals();
    console.log(`10% -> DISC(Tk) ${await investigation.discountTaka.inputValue()}, net payable ${byPercent.netPayable}`);

    // Overwrite the taka side; the percentage has to follow it, not fight it.
    await investigation.typeInto(investigation.discountTaka, '500');
    const byTaka = await investigation.settledTotals();
    const percent = Number(await investigation.discountPercent.inputValue());
    const taka = Number(await investigation.discountTaka.inputValue());
    console.log(`then 500 Tk -> DISC(%) ${percent}, net payable ${byTaka.netPayable}`);

    expect(taka).toBe(500);
    expect(percent, 'the percentage must have been rewritten to match').not.toBe(10);
    // The taka figure is the one charged, and the arithmetic has to close.
    expect(byTaka.netPayable, 'net payable must be exactly sub total less the discount').toBe(
      start.subTotal - taka,
    );
  });

  test('TC-59 (NP-19) a discount on an empty bill leaves it at zero', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await freshForm(page);
    await investigation.setDiscountCategory('General', /^General Discount$/i);

    expect(await investigation.gridRows.count()).toBe(0);
    await investigation.typeInto(investigation.discountPercent, '20');

    const totals = await investigation.settledTotals();
    console.log(`20% on an empty bill: sub total ${totals.subTotal}, net payable ${totals.netPayable}`);
    expect(totals.netPayable).toBe(0);
    expect(totals.netPayable).toBeGreaterThanOrEqual(0);
  });

  test('TC-60 (NP-20) a discount beyond the ceiling is not applied silently', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountPercent, '90');

    const applied = Number(await investigation.discountPercent.inputValue());
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`asked for 90%, got ${applied}%; the screen said: ${said || '(nothing)'}`);

    // The ceiling here belongs to the category rather than the role, but it is
    // the same control: over the limit is refused, and said so.
    expect(said, 'going over the limit must be reported, not quietly trimmed').toMatch(/not allowed/i);
    expect(applied).toBeLessThanOrEqual(CEILING);
  });

  test('TC-61 (NP-21) a discount is refused when nothing is discountable', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await freshForm(page);
    await investigation.searchByUhid(investigations.staffDiscountInvoice.uhid);

    // A government-fixed-rate test carries no discountable value at all.
    await investigation.addTest({ query: 'CBC', match: /Govt\. Fixed Rate/i });
    await investigation.setDiscountCategory('General', /^General Discount$/i);

    const before = await investigation.settledTotals();
    expect(before.discountable).toBe(0);

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountTaka, '200');
    const after = await investigation.settledTotals();
    console.log(`discountable ${before.discountable}; asked for 200 Tk; net payable ${after.netPayable}`);

    expect(Number(await investigation.discountTaka.inputValue())).toBe(0);
    expect(after.netPayable, 'nothing can come off a bill with nothing discountable').toBe(before.netPayable);
  });

  test('TC-62 (NP-22) a posted bill cannot have its discount edited', async () => {
    test.skip(
      true,
      'Posting clears the form, so there is nothing left on this screen to edit — the discount on a posted bill ' +
        'lives behind Edit Invoice (/diagnosis/edit-investigation-invoice), a different screen with its own ' +
        'permissions. Testing it here would mean posting a real invoice first.',
    );
  });

  // TC-63: decimals are not supported at all. "33.33" loses its point, becomes
  // 3333, and is clamped to the ceiling — so the rounding the case asks about
  // never gets a chance to happen.
  test.fail('TC-63 (NP-23) a fractional percentage is applied and rounded cleanly', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billWithCategory(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.discountPercent, '33.33');

    const applied = Number(await investigation.discountPercent.inputValue());
    const taka = Number(await investigation.discountTaka.inputValue());
    const after = await investigation.settledTotals();
    console.log(`typed "33.33", the box holds ${applied}, discount ${taka} Tk`);
    console.log(`sub total ${after.subTotal}, net payable ${after.netPayable}`);

    // Whatever the rounding policy, the three figures have to agree exactly.
    expect(after.netPayable).toBe(after.subTotal - taka);
    expect(applied, '33.33 should be taken as about 33 per cent, not as 3,333').toBeLessThanOrEqual(34);
    expect(before.subTotal).toBe(after.subTotal);
  });
});

/**
 * Negative tests for Net payable, TC-64 to TC-67 (your NP-24 to NP-27).
 *
 * The screen comes out of these well: the figure is calculated, the arithmetic
 * closes exactly, and it keeps up with the grid. The two things worth knowing
 * are written down as notes rather than failures — the category ceilings make a
 * zero bill unreachable, so the floor at zero is never actually exercised; and
 * changing the grid throws the applied discount away without saying so.
 *
 * POST is never pressed.
 */
test.describe('Investigation entry — negative (net payable)', () => {
  /** A bill of two discountable tests with a category that allows a discount. */
  async function billWithDiscount(page: Page, percent: string) {
    const investigation = await freshForm(page);
    await investigation.searchByUhid(investigations.staffDiscountInvoice.uhid);
    await investigation.addTest({ query: 'LIPID', match: /SERUM LIPID PROFILE \(FASTING\)/i });
    await investigation.addTest({ query: 'MRI OF BRAIN', match: /MRI OF BRAIN/i });
    await investigation.setDiscountCategory('General', /^General Discount$/i);
    await investigation.settledTotals();
    await investigation.typeInto(investigation.discountPercent, percent);
    await investigation.settledTotals();
    return investigation;
  }

  test('TC-64 (NP-24) Net payable cannot be typed into', async ({ page }) => {
    const investigation = await freshForm(page);

    const row = page
      .locator('.inv2-summary-row')
      .filter({ has: page.locator('.inv2-summary-label', { hasText: /^Net payable$/ }) })
      .first();

    const fields = await row.locator('input').count();
    console.log(`fields inside the Net payable row: ${fields}`);
    expect(fields, 'a calculated figure should not be an input').toBe(0);

    const value = row.locator('.inv2-summary-val').first();
    await expect(value).toHaveText('0');
    await value.click({ force: true });
    await page.keyboard.type('12345');
    await page.waitForTimeout(1_000);
    await expect(value, 'typing at the figure must not change it').toHaveText('0');
  });

  test('TC-65 (NP-25) the largest discount available never drives it below zero', async ({ page }) => {
    test.setTimeout(240_000);
    // 90 is over the ceiling, so the screen trims it to the most it will allow.
    const investigation = await billWithDiscount(page, '90');

    const totals = await investigation.settledTotals();
    const percent = Number(await investigation.discountPercent.inputValue());
    const taka = Number(await investigation.discountTaka.inputValue());
    console.log(`the most this category allows is ${percent}% (${taka} Tk); net payable ${totals.netPayable}`);

    expect(totals.netPayable, 'what is owed can never be negative').toBeGreaterThanOrEqual(0);
    expect(totals.netPayable).toBe(totals.subTotal - taka);
    // Worth knowing: the ceiling means a bill can never be discounted to
    // nothing from here, so the floor at zero is not reachable through the UI.
    console.log('note: the category ceiling keeps net payable well above zero, so the floor is never tested');
  });

  test('TC-66 (NP-26) Net payable is exactly Sub total less the discount', async ({ page }) => {
    test.setTimeout(240_000);

    for (const percent of ['10', '25', '50']) {
      const investigation = await billWithDiscount(page, percent);
      const totals = await investigation.settledTotals();
      const taka = Number(await investigation.discountTaka.inputValue());

      console.log(
        `${await investigation.discountPercent.inputValue()}%: ${totals.subTotal} - ${taka} = ` +
          `${totals.subTotal - taka}, the screen says ${totals.netPayable}`,
      );
      expect(totals.netPayable, 'a penny out is a defect').toBe(totals.subTotal - taka);
    }
  });

  test('TC-67 (NP-27) removing a test recalculates the bill immediately', async ({ page }) => {
    test.setTimeout(240_000);
    const investigation = await billWithDiscount(page, '50');

    const before = await investigation.settledTotals();
    const discountBefore = Number(await investigation.discountTaka.inputValue());
    const rowsBefore = await investigation.gridRows.count();
    console.log(`before: ${rowsBefore} line(s), sub total ${before.subTotal}, ` +
      `discount ${discountBefore}, net payable ${before.netPayable}`);
    expect(discountBefore).toBeGreaterThan(0);

    await investigation.removeRow(0);
    const after = await investigation.settledTotals();
    const discountAfter = Number(await investigation.discountTaka.inputValue());
    console.log(`after: ${await investigation.gridRows.count()} line(s), sub total ${after.subTotal}, ` +
      `discount ${discountAfter}, net payable ${after.netPayable}`);

    // Nothing stale: the bill is smaller and the figures agree with each other.
    expect(after.subTotal).toBeLessThan(before.subTotal);
    expect(after.netPayable, 'the figures must still add up after the change').toBe(after.subTotal - discountAfter);
    expect(after.netPayable).not.toBe(before.netPayable);

    // Worth knowing: the discount itself is dropped rather than recalculated,
    // and nothing says so — the operator has to notice and apply it again.
    console.log(`note: the applied discount went from ${discountBefore} to ${discountAfter} without a word`);
  });
});

/**
 * Negative tests for the Payment (cash) box, TC-68 to TC-75 (your NP-28 to
 * NP-35).
 *
 * This box is guarded far better than the discount ones beside it: a decimal, a
 * currency sign, a figure larger than the bill and an absurd number are each
 * refused outright, reset to 0, and answered with "Please input correct value".
 * One hole is left — a minus sign is dropped and the digits behind it are taken
 * as a payment.
 *
 * POST is never pressed.
 */
test.describe('Investigation entry — negative (payment)', () => {
  /** A bill of one discountable test, with nothing paid yet. */
  async function billToPay(page: Page) {
    const investigation = await freshForm(page);
    await investigation.searchByUhid(investigations.staffDiscountInvoice.uhid);
    await investigation.addTest({ query: 'LIPID', match: /SERUM LIPID PROFILE \(FASTING\)/i });
    await investigation.settledTotals();
    return investigation;
  }

  test('TC-68 (NP-28) paying more than is owed is refused', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billToPay(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.paymentAmount, '99999');

    const after = await investigation.settledTotals();
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`owed ${before.netPayable}, offered 99999; the box holds ` +
      `"${await investigation.paymentAmount.inputValue()}", due ${after.due}`);
    console.log(`the screen said: ${said || '(nothing)'}`);

    expect(said).toMatch(/correct value/i);
    expect(await investigation.paymentAmount.inputValue()).toBe('0');
    expect(after.due, 'the due must never go negative').toBe(before.netPayable);
    expect(after.due).toBeGreaterThanOrEqual(0);
  });

  // TC-69: the minus is dropped and the rest is taken as a real payment — 500
  // comes off the due even though what was typed was never a valid amount.
  test.fail('TC-69 (NP-29) a negative payment is refused', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billToPay(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.paymentAmount, '-500');

    const after = await investigation.settledTotals();
    console.log(`typed -500, the box holds "${await investigation.paymentAmount.inputValue()}"; ` +
      `due ${before.due} -> ${after.due}`);

    expect(after.due, 'a negative payment must leave the due alone').toBe(before.due);
  });

  test('TC-70 (NP-30) letters and currency signs are refused', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billToPay(page);
    const before = await investigation.settledTotals();

    await investigation.typeInto(investigation.paymentAmount, 'abc');
    console.log(`typed "abc", the box holds "${await investigation.paymentAmount.inputValue()}"`);
    expect(await investigation.paymentAmount.inputValue()).toMatch(/^\d*$/);

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.paymentAmount, '$100');
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`typed "$100", the box holds "${await investigation.paymentAmount.inputValue()}"; ` +
      `the screen said: ${said || '(nothing)'}`);
    expect(await investigation.paymentAmount.inputValue()).toBe('0');

    const after = await investigation.settledTotals();
    expect(after.due).toBe(before.due);
  });

  test('TC-70b (NP-30) a thousands separator is read as the number meant', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billToPay(page);
    const before = await investigation.settledTotals();

    await investigation.typeInto(investigation.paymentAmount, '1,000');
    const held = await investigation.paymentAmount.inputValue();
    const after = await investigation.settledTotals();
    console.log(`typed "1,000", the box holds "${held}", due ${before.due} -> ${after.due}`);

    // The case asks for this to be blocked outright. The screen instead drops
    // the comma and takes 1000, which is what the operator meant and what is
    // charged — recorded here as read rather than as a defect, unlike the same
    // stripping in the discount boxes, where it hands out the largest discount
    // going (TC-55b).
    expect(Number(held)).toBe(1000);
    expect(after.due, 'the arithmetic still has to close').toBe(before.netPayable - 1000);
  });

  test('TC-71 (NP-31) a bill with nothing paid is refused', async () => {
    test.skip(
      true,
      'Needs a complete bill put through POST, which would raise a live invoice. What is already known: a due is ' +
        'perfectly normal here — there is a whole Due Collection screen for it — so payment is not required in ' +
        'general. It is required for one case, and that is covered: a Staff Discount bill is refused with "Staff ' +
        'Hospital discount: due amount must be fully paid." (see the first test in this file).',
    );
  });

  test('TC-72 (NP-32) paying against an empty bill is refused', async ({ page }) => {
    const investigation = await freshForm(page);

    expect(await investigation.gridRows.count()).toBe(0);
    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.paymentAmount, '500');

    const totals = await investigation.settledTotals();
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`500 offered against an empty bill; the box holds ` +
      `"${await investigation.paymentAmount.inputValue()}", due ${totals.due}`);
    console.log(`the screen said: ${said || '(nothing)'}`);

    expect(said).toMatch(/correct value/i);
    expect(await investigation.paymentAmount.inputValue()).toBe('0');
    expect(totals.due, 'no credit may be created out of nothing').toBe(0);
  });

  test('TC-73 (NP-33) paisa are refused rather than rounded', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billToPay(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.paymentAmount, '500.999');

    const held = await investigation.paymentAmount.inputValue();
    const after = await investigation.settledTotals();
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`typed "500.999", the box holds "${held}"; the screen said: ${said || '(nothing)'}`);

    // Refused outright, which is the cleaner of the two outcomes the case
    // allows — and notably better than the discount boxes, which would have
    // turned this into 500999 (TC-63).
    expect(said).toMatch(/correct value/i);
    expect(held).toBe('0');
    expect(after.due).toBe(before.due);
  });

  test('TC-74 (NP-34) an absurd payment is refused and breaks no layout', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billToPay(page);
    const before = await investigation.settledTotals();

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.paymentAmount, '999999999999');

    const said = (await investigation.snackbars()).join(' | ');
    const after = await investigation.settledTotals();
    console.log(`typed 999999999999, the box holds "${await investigation.paymentAmount.inputValue()}"`);
    console.log(`the screen said: ${said || '(nothing)'}`);

    expect(said).toMatch(/correct value/i);
    expect(await investigation.paymentAmount.inputValue()).toBe('0');
    expect(after.due).toBe(before.due);

    const clipped = await investigation.paymentAmount.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped, 'the box must not be burst by what was typed at it').toBe(false);
  });

  test('TC-75 (NP-35) a posted bill cannot have its payment changed here', async () => {
    test.skip(
      true,
      'Posting clears the form, so there is nothing left on this screen to change — a further payment against a ' +
        'posted bill is taken on Due Collection (/diagnostic/due-collection), a separate screen. Testing it here ' +
        'would mean posting a real invoice first.',
    );
  });
});

/**
 * Negative tests for card and mobile payment, TC-76 to TC-80.
 *
 * These are the new half of your second NP-24 to NP-30 sheet. Its NP-24 (a cash
 * payment over the total) and NP-25 (a negative cash payment) are already
 * covered above as TC-68 and TC-69 — the first passes, the second is the
 * minus-sign defect — so they are not repeated here.
 *
 * The screen keeps its payment methods behind their own selects: there is no
 * "Payment (card)" box on the page at all until a card type is chosen, and no
 * "Payment (mobile)" box until an operator is. That is what answers NP-26 and
 * NP-27 — the invalid state is not reachable rather than merely refused.
 *
 * POST is never pressed.
 */
test.describe('Investigation entry — negative (card and mobile payment)', () => {
  async function billToPay(page: Page) {
    const investigation = await freshForm(page);
    await investigation.searchByUhid(investigations.staffDiscountInvoice.uhid);
    await investigation.addTest({ query: 'LIPID', match: /SERUM LIPID PROFILE \(FASTING\)/i });
    await investigation.settledTotals();
    return investigation;
  }

  test('TC-76 (NP-26) a card payment cannot be entered without a card type', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billToPay(page);

    await expect(investigation.cardType).toHaveValue('0');
    expect(
      await investigation.cardPayment.count(),
      'with no card type chosen there should be nowhere to type a card amount',
    ).toBe(0);

    await investigation.cardType.selectOption({ label: 'Credit Card' });
    await page.waitForTimeout(4_000);

    await expect(investigation.cardPayment).toBeVisible();
    console.log('choosing Credit Card revealed the card amount box and a POS terminal select');
  });

  test('TC-77 (NP-27) a mobile payment cannot be entered without an operator', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await billToPay(page);

    await expect(investigation.mobileOperator).toHaveValue('0');
    expect(
      await investigation.mobilePayment.count(),
      'with no operator chosen there should be nowhere to type a mobile amount',
    ).toBe(0);

    await investigation.mobileOperator.selectOption({ label: 'BKash' });
    await page.waitForTimeout(4_000);

    await expect(investigation.mobilePayment).toBeVisible();
    console.log('choosing BKash revealed the mobile amount box');
  });

  test('TC-78 (NP-28) a payment is refused once a full discount has cleared the bill', async ({ page }) => {
    test.setTimeout(240_000);
    const investigation = await billToPay(page);

    // Each category has its own ceiling, and one of them has none worth the
    // name: Special Discount grants the full 100% and takes the bill to zero.
    // Worth knowing on its own — with the category field freely typable
    // (TC-07), any operator can clear any bill outright.
    const ceilings: Record<string, number> = {};
    for (const name of ['General', 'Staff', 'Special', 'Management']) {
      await investigation.setDiscountCategory(name, new RegExp(`^${name} Discount$`, 'i'));
      await investigation.settledTotals();
      await investigation.typeInto(investigation.discountPercent, '100');
      const granted = Number(await investigation.discountPercent.inputValue());
      const totals = await investigation.settledTotals();
      ceilings[name] = granted;
      console.log(`${name} Discount: asked 100%, granted ${granted}%, net payable ${totals.netPayable}`);
      expect(totals.netPayable, 'the bill can be reduced but never turned into a credit').toBeGreaterThanOrEqual(0);
    }
    console.log(`ceilings: ${JSON.stringify(ceilings)}`);

    // Leave the bill at zero, which is the state the case asks about.
    await investigation.setDiscountCategory('Special', /^Special Discount$/i);
    await investigation.settledTotals();
    await investigation.typeInto(investigation.discountPercent, '100');
    const cleared = await investigation.settledTotals();
    console.log(`bill cleared: net payable ${cleared.netPayable}`);
    expect(cleared.netPayable).toBe(0);

    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.paymentAmount, '200');

    const said = (await investigation.snackbars()).join(' | ');
    const after = await investigation.settledTotals();
    console.log(`200 offered against a cleared bill; the box holds ` +
      `"${await investigation.paymentAmount.inputValue()}", due ${after.due}`);
    console.log(`the screen said: ${said || '(nothing)'}`);

    expect(said, 'paying a bill that owes nothing should be refused').toMatch(/correct value/i);
    expect(after.due, 'no credit may be created').toBe(0);
  });

  test('TC-79 (NP-29) cash and card together cannot exceed the bill', async ({ page }) => {
    test.setTimeout(240_000);
    const investigation = await billToPay(page);

    const totals = await investigation.settledTotals();
    const owed = totals.netPayable;
    console.log(`owed ${owed}`);

    await investigation.cardType.selectOption({ label: 'Credit Card' });
    await page.waitForTimeout(4_000);

    // Pay nearly all of it in cash, leaving only 100 outstanding.
    await investigation.typeInto(investigation.paymentAmount, String(owed - 100));
    const afterCash = await investigation.settledTotals();
    console.log(`cash ${owed - 100} -> due ${afterCash.due}`);
    expect(afterCash.due).toBe(100);

    // Then offer far more than the 100 still due on the card.
    await investigation.clearSnackbars();
    await investigation.typeInto(investigation.cardPayment, '500');
    const afterCard = await investigation.settledTotals();
    const said = (await investigation.snackbars()).join(' | ');
    console.log(`card 500 against 100 still due; the card box holds ` +
      `"${await investigation.cardPayment.inputValue()}", due ${afterCard.due}`);
    console.log(`the screen said: ${said || '(nothing)'}`);

    expect(said).toMatch(/correct value/i);
    expect(afterCard.due, 'the two methods together must not overpay the bill').toBe(100);
    expect(afterCard.due).toBeGreaterThanOrEqual(0);
  });

  test('TC-80 (NP-30) a bill with nothing paid is refused where a due is not allowed', async () => {
    test.skip(
      true,
      'The same ground as TC-71: it needs a complete bill put through POST, which would raise a live invoice. ' +
        'A due is ordinary here — Due Collection exists for it — and the one category that forbids one is already ' +
        'covered: a Staff Discount bill is refused with "Staff Hospital discount: due amount must be fully paid."',
    );
  });
});

/**
 * Negative tests for the OPD package field on the same screen, TC-46 to TC-50.
 *
 * A package drops its whole contents into the bill in one go, which makes these
 * the only negative tests here that put anything on the grid. They still raise
 * nothing: POST is never pressed, and the bill is thrown away when the page is
 * left.
 *
 * Two real packages are used. Both have been on this system throughout testing;
 * if either is renamed, the constants below are the only thing to change.
 */
const PACKAGE = { first: 'Hungary Medical', second: 'Singapore Medical' };

/** Turns a grid line's name into something safe to match a suggestion on. */
const asPattern = (name: string) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

test.describe('Investigation entry — negative (OPD package)', () => {
  test('TC-46 a package that does not exist offers nothing and changes nothing', async ({ page }) => {
    const investigation = await freshForm(page);

    const before = await investigation.gridRows.count();
    const offered = await investigation.packageSuggestions('ZZZNOSUCHPACKAGE');

    console.log(`"ZZZNOSUCHPACKAGE" offered ${offered.length} package(s)`);
    expect(offered).toEqual([]);
    expect(await investigation.gridRows.count()).toBe(before);
    // As elsewhere on this screen, nothing is said — the list simply stays shut.
    console.log('note: no "No result found" message is shown');
  });

  test('TC-47 an expired package is refused', async () => {
    test.skip(
      true,
      'There is nothing to expire. The package list (/diagnostic/package-list) carries only a name and a price ' +
        'per package — no validity dates — so this build has no notion of a package going out of date.',
    );
  });

  test('TC-48 a test already inside the package is not added twice', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await freshForm(page);

    const taken = await investigation.addPackage(PACKAGE.first, asPattern(PACKAGE.first));
    console.log(`package: ${taken}`);

    const contents = await investigation.testNames();
    const totalsBefore = await investigation.settledTotals();
    console.log(`the package put ${contents.length} line(s) on the bill, sub total ${totalsBefore.subTotal}`);
    expect(contents.length).toBeGreaterThan(1);

    // Ask for one of its own tests a second time, through the test search.
    const already = contents[0];
    console.log(`adding "${already}" again`);
    await investigation.clearSnackbars();
    await investigation.pickSuggestion(investigation.testSearch, already.slice(0, 18), asPattern(already));

    // The refusal comes back over the circuit a moment after the pick returns,
    // so reading the recorder straight away sometimes catches nothing at all —
    // and the test then failed against an empty string while the screenshot
    // showed the snackbar. Wait for it rather than race it.
    const said = (await investigation.snackbarsMatching(/already added/i)).join(' | ');
    const totalsAfter = await investigation.settledTotals();
    console.log(`the screen said: ${said || '(nothing)'}`);
    console.log(`sub total ${totalsBefore.subTotal} -> ${totalsAfter.subTotal}`);

    expect(said).toMatch(/already added/i);
    expect(totalsAfter.subTotal, 'the patient must not be charged twice').toBe(totalsBefore.subTotal);
  });

  // TC-49: any line can be deleted, package component or not, and the bill just
  // gets cheaper. Whether a package should be splittable at all is a product
  // decision — but as it stands nothing marks these lines as belonging to one.
  test.fail('TC-49 a package component cannot be removed on its own', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await freshForm(page);

    await investigation.addPackage(PACKAGE.first, asPattern(PACKAGE.first));
    const before = await investigation.settledTotals();
    const rowsBefore = await investigation.gridRows.count();

    await investigation.clearSnackbars();
    await investigation.removeRow(0);
    const after = await investigation.settledTotals();
    const said = (await investigation.snackbars()).join(' | ');

    console.log(`rows ${rowsBefore} -> ${await investigation.gridRows.count()}`);
    console.log(`sub total ${before.subTotal} -> ${after.subTotal}; the screen said: ${said || '(nothing)'}`);

    expect(said, 'removing a package component should be refused, or at least remarked on').toMatch(
      /cannot remove|package/i,
    );
  });

  test('TC-50 a second package replaces the first instead of doubling the bill', async ({ page }) => {
    test.setTimeout(180_000);
    const investigation = await freshForm(page);

    await investigation.addPackage(PACKAGE.first, asPattern(PACKAGE.first));
    const first = await investigation.settledTotals();
    const firstContents = await investigation.testNames();
    console.log(`${PACKAGE.first}: ${firstContents.length} line(s), sub total ${first.subTotal}`);

    await investigation.addPackage(PACKAGE.second, asPattern(PACKAGE.second));
    const second = await investigation.settledTotals();
    const secondContents = await investigation.testNames();
    console.log(`after ${PACKAGE.second}: ${secondContents.length} line(s), sub total ${second.subTotal}`);

    // The bill holds one package, not both stacked on top of each other.
    expect(second.subTotal, 'two packages must not be summed').toBeLessThan(first.subTotal * 2);

    // Tests belonging only to the first package are gone, which is what keeps
    // the total honest — though the swap happens without a word.
    const droppedFromFirst = firstContents.filter((t) => !secondContents.includes(t));
    console.log(`lines dropped when the package was swapped: ${droppedFromFirst.length}`);
    expect(droppedFromFirst.length, 'the first package should not survive alongside the second').toBeGreaterThan(0);
    console.log('note: the swap is silent — nothing warns that the first package was replaced');
  });
});
