import { BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect, users } from '../../fixtures/test';
import {
  e2e,
  UHID,
  nextPatient,
  invoiceNo,
  recordInvoiceNo,
  window as dateWindow,
  matcher,
} from './e2e-data';

import { LoginPage } from '../../pages/LoginPage';
import { InvestigationPage, InvestigationTest } from '../../pages/InvestigationPage';
import { InvestigationDashboardPage } from '../../pages/InvestigationDashboardPage';
import { SampleCollectionPage } from '../../pages/SampleCollectionPage';
import { SampleDispatchPage, asPickerDate } from '../../pages/SampleDispatchPage';
import { SampleAcknowledgementPage } from '../../pages/SampleAcknowledgementPage';
import { LabResultEntryPage } from '../../pages/LabResultEntryPage';
import { LabResultFinalizationPage } from '../../pages/LabResultFinalizationPage';
import { MicrobiologyReportPage, seededRandom } from '../../pages/MicrobiologyReportPage';
import { ReportDeliveryPage, DeliveryMode } from '../../pages/ReportDeliveryPage';
import { ADMIN_STORAGE_STATE, PATHOLOGIST_STORAGE_STATE } from '../../utils/constants';

/**
 * The diagnostic round trip, end to end, for one patient.
 *
 * Eight stages, in the order the hospital performs them:
 *
 * | # | Stage | Screen | Who |
 * | --- | --- | --- | --- |
 * | 01 | Investigation entry | OPD Investigation Entry | administrator |
 * | 02 | Sample collection | Sample Collection | administrator |
 * | 03 | Sample dispatch | Sample Collection ▸ Dispatch | administrator |
 * | 04 | Sample acknowledgement | Sample Acknowledgement (LAB) | administrator |
 * | 05 | Lab result entry | LAB Result Entry | administrator |
 * | 06 | Lab result finalization | Lab Result Finalization | **pathologist** |
 * | 07 | Microbiology report | Microbiology Report (C/S) | administrator |
 * | 08 | Report delivery | Report Delivery | administrator |
 *
 * ## How this differs from tests/diagnostic
 *
 * `tests/diagnostic` is the module's test suite: a dozen spec files, each
 * taking one screen apart — its happy path, its negative cases, its known
 * defects — wired into a chain of Playwright projects that hand one invoice
 * between them. It is left exactly as it was; nothing here reads or writes its
 * data (see tests/E2E/e2e-data.ts for why that matters).
 *
 * This file asks a different question: does one patient's work get all the way
 * from the counter to the counter? So it is one file, one patient, one invoice,
 * one browser tab, and it asserts the handover at each seam — that the invoice
 * the last stage finished turns up where the next stage expects it — rather
 * than every control on every screen.
 *
 * ## One patient, one invoice
 *
 * The patient is registered on the billing screen itself. OPD Investigation
 * Entry leaves its demographics row editable while no UHID has been searched,
 * so stage 01 types a name, an age, a gender and a mobile number and posts —
 * which is how the counter takes someone who has never been here before, and
 * makes the journey a true round trip rather than one that starts halfway.
 *
 * The name runs "Masud Rana-1", "Masud Rana-2" and on; the mobile number is
 * fixed, so that number on the end is the only thing telling one run's bill
 * from another's. `E2E_UHID` bills an existing patient instead.
 *
 * Stage 01 then reads the new invoice number back off the dashboard, because
 * the app never shows the number it has just written. That number is held in
 * this module and handed to the seven stages after it, and written to
 * test-data/e2e.json as well so a single stage can be re-run on its own.
 *
 * ## Serial, and why
 *
 * The stages are each other's setup — there is no sample to collect until a
 * bill has been raised, no result to enter until the lab has acknowledged the
 * sample — so the file is serial: they run in order, in one worker, on the tab
 * the shared context opens (fixtures/test.ts), and a stage that fails skips the
 * ones after it. A break therefore reads as one red stage at the seam it broke,
 * not as seven.
 *
 * ## The account switch in the middle
 *
 * Only the pathologist may sign a report off, so stage 06 signs the
 * administrator out through the header menu, signs Dr. Sazia Afreen in, does
 * its work, and hands the browser back — the switch a person makes at the
 * machine. Both sessions are saved to the files utils/constants names, so a
 * run of this suite leaves `playwright/.auth` in the state the other projects
 * expect rather than holding a cookie the server has already killed.
 *
 * ## This writes real data
 *
 * Every stage commits: a bill is posted, samples are collected and dispatched,
 * clinical results are filed and signed off, reports are handed over. None of
 * it can be undone from the UI, and most of it is one-way — a sample cannot be
 * un-collected, a delivered report cannot be un-delivered. So the suite raises
 * its own invoice at stage 01 rather than reusing one, and a re-run of the
 * whole file always works on a bill of its own.
 */

/**
 * What the app answers POST with when the save did not take and it wants
 * another go.
 *
 * Seen on 2026-11-08, after a POST that had every figure right:
 *
 * > Lab numbers could not be allocated, so nothing was saved. Please save
 * > again. (Execution Timeout Expired. The timeout period elapsed prior to
 * > completion of the operation or the server is not responding.)
 *
 * The bill is numbered by allocating a lab number per test, and on a busy
 * server that allocation can outrun the database's command timeout. The app
 * rolls the whole thing back and says so — nothing was written, the form is
 * left exactly as it was, and the message ends in an instruction. That is a
 * slow server, not a broken screen, and a suite that reports it as a failed
 * stage is reporting the wrong thing: the eight stages after it never run, and
 * the person reading the output goes looking for a defect that is not there.
 *
 * So `postUntilSaved` below heeds it. Retrying is safe precisely because of
 * the "nothing was saved" — there is no half-written bill to double up on.
 */
const SAVE_AGAIN = /could not be allocated|please save again|timeout expired/i;

/** Either outcome of a POST, so the wait ends on whichever arrives. */
const POST_ANSWERED = /successful save|could not be allocated|please save again|timeout expired/i;

/** How many times POST is pressed before the stage gives up on the server. */
const POST_ATTEMPTS = 3;

/**
 * How many times "Print Label" is pressed before the stage gives up collecting.
 *
 * The button collects the sample as a side effect of printing its label, and
 * the press does not always take — see E2E_B_07. Printing a label twice is a
 * reprint and changes nothing, so the extra passes are free.
 */
const COLLECT_PASSES = 3;

/**
 * How many times the Microbiology screen is asked for its bill.
 *
 * Each ask narrows the query to the bill number and waits ten seconds for the
 * grid, so this is thirty-odd seconds of patience before the stage concludes
 * the bill is not there.
 */
const CS_LOOKUP_ATTEMPTS = 3;

/**
 * How many rounds the counter is given to catch up with a signed-off report.
 *
 * Each round is `findInvoice`'s own three presses of Show — about thirty
 * seconds — and the rounds are twenty seconds apart, so this is a little over
 * three minutes of patience before the stage calls the reports missing.
 */
const DELIVERY_LOOKUP_ROUNDS = 4;

/** How long each stage may take. The screens are Blazor Server; nothing here is quick. */
const STAGE_TIMEOUT = {
  // Three POSTs at a minute each, on top of the form and the dashboard read.
  invoice: 420_000,
  collection: 300_000,
  dispatch: 300_000,
  acknowledgement: 300_000,
  resultEntry: 600_000,
  finalization: 1_200_000,
  microbiology: 900_000,
  // Three minutes of that is waiting for the counter to catch up with the
  // reports stage 07 signed off; see DELIVERY_LOOKUP_ROUNDS.
  delivery: 600_000,
};

/** What stage 01 learned about the patient, for the stages that report on it. */
let patient = { name: '', mobile: '' };

/**
 * The tests that reached the collection grid.
 *
 * Not every test on a bill takes a sample — the X-ray on this one does not —
 * so what stages 03 and 04 have to move is what stage 02 actually found, read
 * off the screen rather than named in the data file.
 */
let sampledTests: string[] = [];

/** The invoice under way, or a stop with the reason when stage 01 never got one. */
function billNo(): string {
  const value = invoiceNo();
  expect(
    value,
    'no invoice to work on. Stage 01 is what raises it and records it; run the whole file, or set ' +
      'E2E_INVOICE to a bill that has been through the stages before this one.',
  ).not.toEqual('');
  return value;
}

/**
 * Adds one test to the bill, retyping the query when the list that came back
 * belonged to something else.
 *
 * `pickSuggestion` retries a round that stalls, but not one where the list
 * arrived and simply did not hold the test asked for — on the reasoning that
 * retyping the same query cannot change what the catalogue contains. That
 * holds when the list really is this query's. It is not always: the box
 * answers every keystroke, and on a slow afternoon the answer to the first
 * letter can be the one sitting there when the reading is taken. On
 * 2026-11-09 a search for "STOOL" was handed the answer to "S" — forty-odd
 * SERUM tests, alphabetically, with no stool among them — and the stage died
 * on a catalogue that had the test all along.
 *
 * Retyping fixes exactly that, so it is done here rather than by changing the
 * page object: `pickSuggestion` belongs to every spec in tests/diagnostic,
 * several of which lean on that early exit to fail fast when a test genuinely
 * is not there.
 *
 * The retry is guarded on the grid not having grown. A round that threw after
 * the suggestion was taken has already put the test on the bill, and typing it
 * again would bill the patient for it twice.
 */
async function addTest(
  investigation: InvestigationPage,
  test: InvestigationTest,
  attempts = 3,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const before = await investigation.gridRows.count();

    try {
      return await investigation.addTest(test);
    } catch (error) {
      const after = await investigation.gridRows.count();
      if (after > before || attempt >= attempts) throw error;

      console.log(
        `"${test.query}" came back with the wrong suggestion list (attempt ${attempt} of ${attempts}); ` +
          `typing it again`,
      );
      await investigation.page.waitForTimeout(3_000);
    }
  }
}

/**
 * Answers the "Patients registered with …" picker, if it comes up.
 *
 * OPD Investigation Entry raises this modal when the mobile number typed into
 * the demographics row already has patients against it: a table of them, a
 * **Select** on each row, and a **New patient** button beneath. This suite is
 * registering someone new each run, so it presses New patient.
 *
 * The modal is not instant — it arrives a beat after the field is blurred, by
 * which time the test has usually moved on — so this waits a little for it and
 * returns quietly when nothing comes. The patients it lists are logged either
 * way: on a shared number that list is the evidence for E2E_B_08.
 */
async function answerPatientPicker(page: Page, mobile: string, timeout = 12_000) {
  const picker = page
    .locator('div[role="dialog"], .modal')
    .filter({ hasText: new RegExp(`Patients registered with\\s*${mobile}`, 'i') })
    .first();

  const shown = await picker
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);

  if (!shown) return false;

  const listed = await picker.locator('tbody tr').allInnerTexts();
  console.log(`the patient picker came up for ${mobile}, listing ${listed.length}:`);
  listed.forEach((row) => console.log(`  ${row.replace(/\s+/g, ' ').trim()}`));

  const asNew = picker.getByRole('button', { name: /^new patient$/i }).first();
  await expect(asNew, 'the picker offered no "New patient" button').toBeVisible({ timeout: 15_000 });
  await asNew.click();
  await expect(picker, 'the picker stayed up after "New patient" was pressed').toBeHidden({
    timeout: 30_000,
  });

  console.log('answered the picker with "New patient"');
  return true;
}

/**
 * Holds a screen to listing the invoice under a named filter, asking again
 * until it does.
 *
 * Each of the sample screens ends its stage the same way: re-open, narrow to
 * the invoice, switch to the filter the work should have moved it to, and look
 * for the row. Every one of those steps is a query the server rebuilds the grid
 * for, and `filterBy` and `searchInvoice` allow each a flat few seconds —
 * which on 2026-11-10 was not enough for the acknowledgement screen. The
 * samples had been acknowledged, the app had said so, and the row simply had
 * not arrived inside the minute the assertion waited.
 *
 * Waiting longer on the row would not have helped: the grid is only rebuilt
 * when something asks it to, so a reading taken after a query that came back
 * empty stays empty however long it is watched. What is needed is to ask
 * again, which is what this does. Nothing in `narrow` commits anything, so
 * repeating it is free.
 */
async function expectListedUnder(
  filter: string,
  invoice: string,
  narrow: () => Promise<void>,
  row: () => Locator,
  timeout = 180_000,
) {
  await expect(async () => {
    await narrow();
    await expect(row(), `invoice ${invoice} is not listed under "${filter}"`).toHaveCount(1, {
      timeout: 20_000,
    });
  }).toPass({ timeout, intervals: [5_000, 10_000, 15_000] });

  console.log(`invoice ${invoice} is listed under "${filter}"`);
}

/**
 * Switches Report Delivery to a stage and opens the invoice there, waiting for
 * the screen to catch up.
 *
 * Changing stage is a query like any other, and `filterBy` allows it a flat six
 * seconds. That is not always enough: on 2026-11-09 the X-ray was acknowledged,
 * the screen said so — "Report acknowledged." — and the switch to the
 * Acknowledged stage a moment later found no invoice to open at all. Nothing
 * here commits anything, so the pair is simply asked again until the invoice is
 * on screen.
 */
async function openAtStage(
  delivery: ReportDeliveryPage,
  mode: DeliveryMode,
  invoice: string,
  timeout = 180_000,
) {
  await expect(async () => {
    await delivery.filterBy(mode);
    expect(
      await delivery.selectInvoice(invoice, 20_000),
      `invoice ${invoice} is not under "${mode}"`,
    ).toBe(true);
  }).toPass({ timeout, intervals: [5_000, 10_000, 15_000] });
}

/**
 * Waits until the Blazor circuit is up and nothing is covering the page.
 *
 * `waitForCircuit` in utils/blazor.ts watches `#reconnect-modal`, the app's own
 * overlay. It is not the only one: Blazor ships its own,
 * `#components-reconnect-modal`, and that is the one which went up on
 * 2026-11-09 — the microbiology stage spent thirty seconds trying to open the
 * Pathologist list and was told, every retry, that
 * `<div id="components-reconnect-modal"></div> intercepts pointer events`. The
 * element is in the document from the start and hidden while the circuit holds,
 * so waiting for it to be hidden is safe on any screen and immediate on a
 * healthy one.
 *
 * Both are waited on here rather than one. The shared helper is left alone:
 * it belongs to tests/diagnostic as well, and widening what it waits for is a
 * change to make deliberately rather than in passing.
 */
async function waitForLiveCircuit(page: Page, timeout = 120_000) {
  for (const id of ['#reconnect-modal', '#components-reconnect-modal']) {
    const overlay = page.locator(id);
    if (!(await overlay.count())) continue;

    await expect(
      overlay,
      `the Blazor circuit is down — the page is showing ${id}, which swallows every click`,
    ).toBeHidden({ timeout });
  }
}

/**
 * Waits for a lab report to finish arriving, and answers how many tests it
 * ended up with.
 *
 * The report is built department by department over the circuit, and
 * `openInvoice` returns four seconds after the first heading appears. On a
 * quiet server that is the whole report; on a slow one it is the first
 * department of three. Reading it then is how the Done check came to report a
 * test it had itself just filled in as missing — and, worse, how a fill could
 * quietly cover part of a report and leave the rest blank, which nothing
 * downstream would notice until the counter handed over an empty page.
 *
 * So the headings are counted until the count stops moving. Nothing is thrown
 * if it never settles: the caller is going to assert on the report's contents
 * either way, and that assertion says far more than a timeout here would.
 */
async function settleReport(results: LabResultEntryPage, quiet = 4_000, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let seen = -1;
  let since = Date.now();

  while (Date.now() < deadline) {
    const count = (await results.testHeadings()).length;

    if (count !== seen) {
      seen = count;
      since = Date.now();
    } else if (count > 0 && Date.now() - since >= quiet) {
      return count;
    }

    await results.page.waitForTimeout(1_000);
  }

  return seen;
}

/**
 * Hands the browser from one account to another and saves the new session.
 *
 * Signing out ends the session on the *server*, not just in this browser, so
 * the file the account came from is left holding a dead cookie — which is why
 * each switch rewrites the file for the account it is switching *to*, and why
 * stage 06 switches back at the end rather than leaving the pathologist signed
 * in.
 */
async function switchTo(
  page: Page,
  context: BrowserContext,
  user: { username: string; password: string; role: string },
  storageState: string,
  attempts = 3,
): Promise<string> {
  const login = new LoginPage(page);
  const wanted = new RegExp(user.role, 'i');

  /** Who the header names, once the app has settled enough to draw one. */
  const whoIsSignedIn = async () => {
    await page.goto('/', { timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(5_000);
    return login.currentUser().catch(() => '');
  };

  for (let attempt = 1; ; attempt++) {
    try {
      const { from, to } = await login.switchTo(user.username, user.password);

      console.log(`signed out: ${from || '(nobody — the session had already lapsed)'}`);
      console.log(`now signed in as: ${to}`);
      expect(to, `the header should name the ${user.role}`).toMatch(wanted);

      await context.storageState({ path: storageState });
      console.log(`saved the ${user.role} session to ${storageState}`);
      return to;
    } catch (error) {
      // The sign-in POST may simply have outrun the minute `expectLoggedIn`
      // allows it. On 2026-11-09 — an afternoon where the setup project alone
      // took 53 seconds — the wait gave up with the URL still reading "",
      // mid-navigation, on a sign-in that was on its way. So before trying
      // again, ask the app who it thinks is signed in: if the switch landed
      // late, there is nothing left to do but save the session.
      const who = await whoIsSignedIn();

      if (wanted.test(who)) {
        console.log(`the sign-in landed after the wait gave up; the header names "${who}"`);
        await context.storageState({ path: storageState });
        console.log(`saved the ${user.role} session to ${storageState}`);
        return who;
      }

      if (attempt >= attempts) throw error;
      console.log(
        `signing the ${user.role} in did not land (attempt ${attempt} of ${attempts}); the header reads ` +
          `"${who || '(nobody)'}" — trying again`,
      );
    }
  }
}

/**
 * Makes sure the administrator has the browser, and does nothing if they
 * already do.
 *
 * Stage 06 hands it back itself; this is the belt to that braces. A stage that
 * quietly ran as the pathologist would fail on a menu that does not carry the
 * screen it wants, which says nothing about what actually went wrong.
 */
async function ensureAdministrator(page: Page, context: BrowserContext) {
  const login = new LoginPage(page);
  await page.goto('/');
  await page.waitForTimeout(5_000);

  const who = await login.currentUser();
  if (new RegExp(users.admin.role, 'i').test(who)) {
    console.log(`already signed in as the ${users.admin.role}`);
    return;
  }

  console.log(`the header reads "${who || '(nobody)'}" — signing the ${users.admin.role} back in`);
  await switchTo(page, context, users.admin, ADMIN_STORAGE_STATE);
}

test.describe('Diagnostic round trip, end to end', () => {
  // Each stage is the next one's setup, so they run in order and a failure
  // skips what follows rather than reporting seven breaks for one cause.
  test.describe.configure({ mode: 'serial' });

  // ---------------------------------------------------------------------
  // 01 — Investigation entry
  // ---------------------------------------------------------------------
  test('01 investigation entry — bills the patient and posts the invoice', async ({ page }) => {
    test.setTimeout(STAGE_TIMEOUT.invoice);

    // Posting renders the cash memo into a second tab, which would otherwise
    // sit in the shared context for the rest of the run — every stage after
    // this one inherits the context.
    page.on('popup', (p) => p.close().catch(() => {}));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    /**
     * The bills already on the dashboard for this mobile number, read before
     * anything is typed.
     *
     * This is how the stage knows which invoice it raised. The mobile number
     * never changes between runs, and the app writes every one of this
     * suite's bills under the same patient name whatever is typed (E2E_B_08),
     * so neither the number nor the name can single out this run's bill.
     * Being absent a minute ago can.
     *
     * Only possible when the suite is registering its own patient, because
     * then the mobile number is known before anything is typed. A run aimed at
     * an existing UHID learns the number from the lookup, by which point the
     * form is filled and the dashboard cannot be visited without losing it —
     * those runs fall back to taking the newest bill.
     */
    const knownBills = new Set<string>();

    if (!UHID) {
      await test.step('notes the bills this patient already has', async () => {
        const before = new InvestigationDashboardPage(page);
        await before.goto();
        await before.show();
        await before.settle();

        // An empty answer is the ordinary case for a mobile nobody has been
        // billed on yet, so this asks once rather than waiting one out.
        const existing = await before.findByMobile(e2e.patient.mobile, 20_000);
        existing.forEach((b) => knownBills.add(b.billNo.replace(/\D/g, '')));
        console.log(`${knownBills.size} bill(s) already on the dashboard for ${e2e.patient.mobile}`);
      });
    }

    const investigation = new InvestigationPage(page);
    await investigation.goto();
    await investigation.recordSnackbars();

    await test.step(UHID ? 'loads the patient by UHID' : 'registers the patient on the bill', async () => {
      if (UHID) {
        // Only when someone has asked for a particular patient. The journey
        // otherwise starts the way a counter starts with a stranger.
        patient.name = await investigation.searchByUhid(UHID);
        expect(patient.name, `no patient came back for UHID ${UHID}`).not.toEqual('');
        patient.mobile = await investigation.mobile.inputValue();
        console.log(`patient: ${patient.name} (UHID ${UHID}, mobile ${patient.mobile})`);
        return;
      }

      // The demographics row is editable while no UHID has been searched, and
      // posting the bill is what registers the patient — so this is both the
      // registration and the first half of the invoice, exactly as it is at
      // the window.
      const details = nextPatient();

      await investigation.title.selectOption({ label: details.title });
      const name = await investigation.typeInto(investigation.fullName, details.fullName);
      await investigation.gender.selectOption({ label: details.gender });
      const age = await investigation.typeInto(investigation.ageYears, details.ageYears);
      const mobile = await investigation.typeInto(investigation.mobile, details.mobile);

      // "Patients registered with 01784066929" — the picker, answered.
      //
      // Typing a mobile number somebody is already registered on raises a
      // modal listing them, with a **Select** against each and a **New
      // patient** button under the list. It is the right question to ask and
      // the counter should be asked it.
      //
      // Left unanswered it is worse than a nuisance. It arrives a beat after
      // the mobile is typed, so it lands on whatever the operator does next —
      // it swallowed a click on the referring-doctor list here — and the bill
      // posts against the patient already on that number whatever name is on
      // the form, which is E2E_B_08 and the whole of why six runs of this
      // suite were written down as MASUD RANA-1.
      //
      // This suite registers someone new every time, so it answers **New
      // patient**.
      await answerPatientPicker(page, details.mobile);

      // Read back rather than assumed. Every one of these fields round-trips
      // over the circuit and the server decides what it keeps — the name comes
      // back upper-cased, and the age box has been known to refuse what it was
      // given.
      console.log(
        `registering ${name} | ${details.title} | ${details.gender} | age ${age} | mobile ${mobile}`,
      );
      expect(name.toUpperCase(), 'the name did not stick').toContain(details.fullName.toUpperCase());
      expect(mobile, 'the mobile number did not stick').toBe(details.mobile);
      expect(age, 'an age of zero is refused on POST, so it has to be set').not.toMatch(/^0?$/);

      patient.name = name;
      patient.mobile = mobile;
    });

    await test.step('names the referring doctor and adds the tests', async () => {
      // Retried for the same reason the tests below are, and trivially safe to
      // retry: this one fills a field rather than appending to the bill, so a
      // second pick overwrites the first.
      const referrer = matcher(e2e.referredBy);
      let doctor = '';
      await expect(async () => {
        doctor = await investigation.setReferredBy(referrer.query, referrer.match);
      }).toPass({ timeout: 120_000, intervals: [3_000, 5_000, 10_000] });
      console.log(`referred by: ${doctor}`);

      // One at a time rather than `addTests`, so a query handed the wrong
      // suggestion list is retyped on its own — see `addTest` above.
      const added: string[] = [];
      for (const test of e2e.tests.map(matcher)) {
        added.push(await addTest(investigation, test));
      }
      added.forEach((t) => console.log(`test: ${t}`));

      // The grid can hold more rows than tests picked: a microbiology test
      // pulls its sample tube in as a line of its own.
      const rows = await investigation.testNames();
      rows.forEach((name, i) => console.log(`grid row ${i + 1}: ${name}`));
      expect(rows.length).toBeGreaterThanOrEqual(e2e.tests.length);
    });

    await test.step('settles the bill in full, in cash', async () => {
      await investigation.setRemarks(e2e.remarks);

      // Read until the strip stops moving: it is recalculated over the circuit
      // on every change, and a figure read mid-flight is the previous bill's.
      const totals = await investigation.settledTotals();
      console.log('bill:', totals);
      expect(totals.netPayable, 'the bill came to nothing').toBeGreaterThan(0);

      await investigation.payCash(totals.netPayable);

      const settled = await investigation.settledTotals();
      console.log('after payment:', settled);
      // Paid to the taka, which is the one shape of bill that posts without
      // being asked about: a bill left owing raises the due-bill modal, and a
      // discounted one is refused outright unless it is cleared.
      expect(settled.netPayable, 'the bill moved while the payment was being typed').toBe(
        totals.netPayable,
      );
      expect(settled.due, 'the bill should have nothing left owing on it').toBe(0);
    });

    await test.step('posts it', async () => {
      let said: string[] = [];

      for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
        await investigation.clearSnackbars();
        await investigation.post();

        // Waited for rather than slept through: a slow save is not a failed
        // one, and a message that never arrives still returns, so the
        // assertion below is what fails rather than a timeout with nothing in
        // it. The wait ends on either answer, so a refusal is not sat out for
        // the full minute.
        said = await investigation.snackbarsMatching(POST_ANSWERED, 60_000);
        said.forEach((m) => console.log(`snackbar (attempt ${attempt}): ${m}`));

        const answer = said.join(' | ');
        if (/successful save/i.test(answer)) break;

        // Anything else is a refusal the bill has earned — a due it will not
        // post, a discount it will not allow — and pressing POST again would
        // only earn it twice. Let the assertion below report what was said.
        if (!SAVE_AGAIN.test(answer)) break;

        expect(
          attempt,
          `the server could not allocate lab numbers ${POST_ATTEMPTS} times running, so the bill was never ` +
            `written. Nothing is wrong with the form — this is the database's command timeout being outrun. ` +
            `Try again when the server is quieter.`,
        ).toBeLessThan(POST_ATTEMPTS);

        console.log(
          `attempt ${attempt} of ${POST_ATTEMPTS}: the server allocated no lab numbers and saved nothing; ` +
            `posting again`,
        );

        // The app says the form is untouched; this is what holds it to that.
        // Re-posting a bill that has quietly changed shape would write the
        // wrong money, and that is not something to find out afterwards.
        await page.waitForTimeout(10_000);
        const stillThere = await investigation.settledTotals();
        console.log('the bill before posting again:', stillThere);
        expect(stillThere.due, 'the failed post left the bill owing something').toBe(0);
        expect(stillThere.netPayable, 'the failed post emptied the bill').toBeGreaterThan(0);
      }

      await page.waitForTimeout(5_000);
      await page.screenshot({ path: 'test-results/e2e-01-invoice-posted.png', fullPage: true });

      // A refusal is only ever reported in a snackbar — the form is left
      // exactly as it was — so the outcome has to be read out of the messages.
      expect(said.join(' | ')).toMatch(/successful save/i);
    });

    await test.step('reads the new invoice number off the dashboard', async () => {
      // The app never shows the number it just wrote, so this is both how the
      // number is learned and what proves the bill is real.
      const dashboard = new InvestigationDashboardPage(page);
      await dashboard.goto();
      await dashboard.show();
      // Show returns as soon as the table element is drawn, and the table is
      // drawn with its headers before the query is even sent — so without this
      // the grid is read while it is still empty.
      await dashboard.settle();

      // Through the Search (Mobile No) box and its Filter button, asked again
      // until the bill turns up: the bill was written moments ago and the
      // dashboard is a separate query against a server that has just proved
      // how slow it can be.
      let bills = await dashboard.findByMobile(patient.mobile);

      if (!bills.length) {
        // Older builds have no mobile box, and the generic Search matches the
        // name column. Worth one more go before calling the bill missing.
        console.log(`nothing under the mobile number; trying the name "${patient.name}"`);
        await dashboard.filter(patient.name);
        await dashboard.settle();
        bills = (await dashboard.rows()).filter(
          (b) => b.mobile.replace(/\D/g, '') === patient.mobile.replace(/\D/g, ''),
        );
      }

      bills.forEach((b) => console.log(`bill ${b.billNo} | ${b.entryDate} ${b.entryTime} | ${b.status}`));
      expect(
        bills,
        `the bill was posted — the screen answered "successful save" — but no invoice for ${patient.mobile} ` +
          `reached the dashboard within the wait. Either the save did not commit after all, or the grid is ` +
          `slower than the wait allows. Check the dashboard by hand for today before running this again: a ` +
          `bill that did land is a real one, and the next run will raise another beside it.`,
      ).not.toHaveLength(0);

      // The dashboard prints a bill as MDH2611080200002; every screen after
      // this one knows it by its digits alone, and those are issued in order
      // with the date at the front.
      const digits = (no: string) => no.replace(/\D/g, '');

      // Which of them is this run's.
      //
      // The mobile number is fixed, so every run's bill is listed here and the
      // name is no help in telling them apart (E2E_B_08). What does tell them
      // apart is that this one was not on the dashboard a minute ago:
      // `knownBills` was read before the form was filled.
      const newest = () =>
        bills.reduce((best, b) => (Number(digits(b.billNo)) > Number(digits(best.billNo)) ? b : best));

      let posted;
      if (UHID) {
        // The mobile was not known before the form was filled, so there is no
        // "before" to compare against; the numbers are issued in order, so the
        // newest is this run's.
        posted = newest();
      } else {
        const fresh = bills.filter((b) => !knownBills.has(digits(b.billNo)));
        fresh.forEach((b) => console.log(`new since this stage began: ${b.billNo}`));

        expect(
          fresh.length,
          fresh.length === 0
            ? `every bill the dashboard lists for ${patient.mobile} was already there before this stage ` +
              `posted, so the POST that answered "successful save" wrote nothing the dashboard can see.`
            : `posting once produced ${fresh.length} new bills for ${patient.mobile} — ${fresh
                .map((b) => b.billNo)
                .join(', ')}. One of them is a duplicate, and the journey must not guess which to follow.`,
        ).toBe(1);

        posted = fresh[0];
      }
      if (bills.length > 1) {
        console.log(
          `${bills.length} bills on the dashboard for this mobile; this run raised ${posted.billNo}`,
        );
      }
      // The name on the bill is reported, not asserted on.
      //
      // It cannot identify the bill any more. This suite registers its patient
      // with a mobile number the hospital gave it, which never changes, and
      // the app matches an existing patient on that number and keeps *their*
      // name — so a bill typed as "Masud Rana-2" is written as MASUD RANA-1,
      // and the dashboard lists both under the first name. That is E2E_B_08,
      // and the journey is unaffected by it: the invoice is real, it is this
      // run's, and every stage after this one works on the number.
      //
      // Failing here instead would block all eight stages until the app is
      // changed, which would cost far more than the defect does. What
      // identifies the bill is `knownBills` above: it is the one that was not
      // on the dashboard before this stage posted.
      if (!posted.fullName.toUpperCase().includes(patient.name.toUpperCase())) {
        console.log(
          `!! the bill was typed as "${patient.name}" and written as "${posted.fullName}" — the app matched ` +
            `the existing patient on mobile ${patient.mobile} and kept their name (E2E_B_08)`,
        );
      }

      const raised = digits(posted.billNo);
      expect(raised).not.toEqual('');
      recordInvoiceNo(raised);
      console.log(`\n=== the journey is invoice ${raised}, for ${patient.name} ===\n`);
    });
  });

  // ---------------------------------------------------------------------
  // 02 — Sample collection
  // ---------------------------------------------------------------------
  test('02 sample collection — collects every sample the invoice carries', async ({ page }) => {
    test.setTimeout(STAGE_TIMEOUT.collection);
    const invoice = billNo();

    const samples = new SampleCollectionPage(page);
    await samples.goto();
    await samples.recordSnackbars();

    const { from, to } = dateWindow();
    await samples.setDateRange(asPickerDate(from), asPickerDate(to));
    await samples.filterBy('New Patient');
    await samples.searchInvoice(invoice);

    // selectInvoice does the waiting and explains itself when the invoice is
    // not on the list; asking first would only bury that under a bare
    // "element not found". It ticks every row as a side effect.
    await samples.selectInvoice(invoice);

    const pending = await samples.rows();
    pending.forEach((r) => console.log(`  ${r.labNo} | ${r.testName} | ${r.status} | ticked=${r.selected}`));
    expect(pending.length, `invoice ${invoice} reached collection with no samples on it`).toBeGreaterThan(0);
    expect(pending.every((r) => /not collected/i.test(r.status))).toBe(true);
    expect(pending.every((r) => r.selected), 'opening the invoice should tick every row').toBe(true);

    // What this stage found is what the next two have to move. The X-ray on the
    // bill needs no sample and is not here, which is the point of reading the
    // grid rather than trusting the data file.
    sampledTests = pending.map((r) => r.testName);
    console.log(`${sampledTests.length} of the bill's tests take a sample`);

    // Pressed, then checked, then pressed again for whatever did not take.
    //
    // "Print Label" is what collects a sample on this screen, and it does not
    // always do it: the press goes through, the server answers, the grid
    // redraws — and every status is exactly as it was, with nothing said. The
    // suite has known about this since the collection spec was written; on
    // 2026-11-10 it took a whole invoice, all four samples still reading "Not
    // Collected" afterwards and not one snackbar between them. It is reported
    // as E2E_B_07 in bug-report/e2e-round-trip-findings.md.
    //
    // Pressing again is safe. Printing a label for a sample already collected
    // is a reprint and changes no status — which is why the suite can re-run
    // its label-printing stage freely — so a pass that re-prints a few labels
    // to collect the stragglers costs nothing.
    let stillPending: string[] = [];

    for (let pass = 1; pass <= COLLECT_PASSES; pass++) {
      await samples.clearSnackbars();
      await samples.collectSelected();
      const said = await samples.snackbars();
      said.forEach((m) => console.log(`snackbar: ${m}`));
      if (!said.length) console.log(`pass ${pass}: the screen said nothing about the collection`);

      // Read back through "All Patient": by now the invoice belongs to neither
      // of the lists this stage used, and the grid keeps only a screenful of
      // rows in the DOM, so the list is narrowed to this invoice first —
      // otherwise a row that is genuinely there reads as missing.
      await samples.goto();
      await samples.setDateRange(asPickerDate(from), asPickerDate(to));
      await samples.filterBy('All Patient');
      await samples.searchInvoice(invoice);
      await samples.selectInvoice(invoice);

      const rows = await samples.rows();
      rows.forEach((r) => console.log(`  ${r.labNo} | ${r.testName} | ${r.status}`));
      stillPending = rows.filter((r) => /not collected/i.test(r.status)).map((r) => r.testName);

      if (!stillPending.length) break;

      console.log(
        `pass ${pass} of ${COLLECT_PASSES}: ${stillPending.length} sample(s) are still waiting — ` +
          `${stillPending.join(', ')}`,
      );

      // Selecting the invoice ticks every row again, so the next press has
      // something to collect. The ones already collected lose their checkbox.
      if (pass < COLLECT_PASSES) await samples.selectInvoice(invoice);
    }

    await page.screenshot({ path: 'test-results/e2e-02-collected.png', fullPage: true });

    expect(
      stillPending,
      `these were ticked and printed ${COLLECT_PASSES} times over and are still waiting to be collected. ` +
        `"Print Label" is what collects on this screen and it does not always take — see E2E_B_07 in ` +
        `bug-report/e2e-round-trip-findings.md.`,
    ).toEqual([]);

    // --- and the invoice has reached the collected list ---
    await expectListedUnder(
      'Collected Patient',
      invoice,
      async () => {
        await samples.goto();
        await samples.setDateRange(asPickerDate(from), asPickerDate(to));
        await samples.filterBy('Collected Patient');
        await samples.searchInvoice(invoice);
      },
      () => samples.invoiceRow(invoice),
    );
  });

  // ---------------------------------------------------------------------
  // 03 — Sample dispatch
  // ---------------------------------------------------------------------
  test('03 sample dispatch — sends every collected sample to the carrier', async ({ page }) => {
    test.setTimeout(STAGE_TIMEOUT.dispatch);
    const invoice = billNo();

    const dispatch = new SampleDispatchPage(page);
    await dispatch.goto();
    await dispatch.recordSnackbars();

    const { from, to } = dateWindow();
    await dispatch.setDateRange(from, to);
    console.log(`date range: ${asPickerDate(from)} .. ${asPickerDate(to)}`);
    await dispatch.show();

    await dispatch.filterBy('Not Dispatched');
    await dispatch.searchInvoice(invoice);
    await dispatch.selectInvoice(invoice);

    const waiting = await dispatch.rows();
    waiting.forEach((r) => console.log(`  ${r.labNo} | ${r.testName} | ${r.sampleStatus}`));
    expect(waiting.length, 'nothing collected reached the dispatch tab').toBeGreaterThan(0);
    expect(waiting.every((r) => r.carriedBy === ''), 'nothing should be with a carrier yet').toBe(true);

    // Only a collected sample is offered here, so this is also the seam check:
    // what stage 02 collected is what this tab is holding. Skipped in a run of
    // this stage on its own, which never met stage 02 to know what it found.
    if (sampledTests.length) {
      expect(
        waiting.map((r) => r.testName).sort(),
        'the dispatch tab is not holding what sample collection collected',
      ).toEqual([...sampledTests].sort());
    }

    // The screen will not let a row be ticked until a carrier is named, and
    // picking one reloads the grid — so the invoice is reopened afterwards.
    const wanted = matcher(e2e.carrier);
    const carrier = await dispatch.pickCarrier(wanted.query, wanted.match);
    console.log(`carrier: ${carrier}`);
    expect(await dispatch.selectedCarrier()).toMatch(wanted.match);

    await dispatch.selectInvoice(invoice);

    // Retried for the same reason stage 04's ticking is, and safe for the same
    // reason: `selectOnly` only clicks a box whose state differs from the one
    // asked for, so a second pass touches only what did not take.
    await expect(async () => {
      await dispatch.selectOnly(waiting.map((r) => r.testName));
      expect((await dispatch.rows()).filter((r) => r.selected)).toHaveLength(waiting.length);
    }).toPass({ timeout: 150_000, intervals: [2_000, 5_000, 10_000] });

    await dispatch.clearSnackbars();
    await dispatch.dispatch();
    (await dispatch.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/e2e-03-dispatched.png', fullPage: true });

    // --- everything has gone to the carrier ---
    await expectListedUnder(
      'Dispatched',
      invoice,
      async () => {
        await dispatch.goto();
        await dispatch.setDateRange(from, to);
        await dispatch.show();
        await dispatch.filterBy('Dispatched');
        await dispatch.searchInvoice(invoice);
      },
      () => dispatch.invoiceRow(invoice),
    );

    await dispatch.selectInvoice(invoice);
    const sent = await dispatch.rows();
    sent.forEach((r) => console.log(`  ${r.testName} | carriedBy=${r.carriedBy}`));
    expect(sent.every((r) => r.carriedBy !== ''), 'a dispatched row should name its carrier').toBe(true);
  });

  // ---------------------------------------------------------------------
  // 04 — Sample acknowledgement
  // ---------------------------------------------------------------------
  test('04 sample acknowledgement — the lab receives every dispatched sample', async ({ page }) => {
    test.setTimeout(STAGE_TIMEOUT.acknowledgement);
    const invoice = billNo();

    const ack = new SampleAcknowledgementPage(page);
    await ack.goto();
    await ack.recordSnackbars();

    const { from, to } = dateWindow();
    await ack.setDateRange(from, to);
    await ack.searchInvoice(invoice);
    await ack.filterBy('Not Acknowledged');
    await ack.show();
    await ack.selectInvoice(invoice);

    const arriving = await ack.rows();
    arriving.forEach((r) => console.log(`  ${r.labNo} | ${r.testName} | ${r.sampleStatus}`));
    expect(arriving.length, 'nothing dispatched reached the lab').toBeGreaterThan(0);
    expect(arriving.every((r) => r.receivedBy === ''), 'the lab has received nothing yet').toBe(true);
    if (sampledTests.length) {
      expect(
        arriving.map((r) => r.testName).sort(),
        'the lab is not being offered what the carrier was given',
      ).toEqual([...sampledTests].sort());
    }

    // Ticked, and ticked again for anything that did not take.
    //
    // Each tick round-trips over the circuit, and the page object gives it
    // 800ms plus Playwright's five-second default to come back — which this
    // server does not always manage. On 2026-11-09 the very first row came
    // back unticked and the stage failed on a checkbox, four stages into a
    // journey that was otherwise fine.
    //
    // `selectAll` skips any box that is already ticked, so running it again
    // picks up only what is still outstanding. That is what makes this a retry
    // rather than a reason to widen a timeout inside a page object the
    // diagnostic suite shares.
    await expect(async () => {
      await ack.selectAll();
      expect((await ack.rows()).every((r) => r.selected)).toBe(true);
    }).toPass({ timeout: 150_000, intervals: [2_000, 5_000, 10_000] });

    await ack.clearSnackbars();
    await ack.acknowledge();
    (await ack.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/e2e-04-acknowledged.png', fullPage: true });

    // --- the lab has it all ---
    await expectListedUnder(
      'Acknowledged',
      invoice,
      async () => {
        await ack.goto();
        await ack.setDateRange(from, to);
        await ack.searchInvoice(invoice);
        await ack.filterBy('Acknowledged');
        await ack.show();
      },
      () => ack.invoiceRow(invoice),
    );

    await ack.selectInvoice(invoice);
    const received = await ack.rows();
    received.forEach((r) => console.log(`  ${r.testName} | receivedBy=${r.receivedBy}`));
    expect(received.length).toBe(arriving.length);
    expect(received.every((r) => r.receivedBy !== ''), 'an acknowledged row should name who received it').toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------
  // 05 — Lab result entry
  // ---------------------------------------------------------------------
  test('05 lab result entry — enters every result and files the report', async ({ page }) => {
    test.setTimeout(STAGE_TIMEOUT.resultEntry);
    const invoice = billNo();

    const results = new LabResultEntryPage(page);
    await results.goto();
    await results.recordSnackbars();

    const { from, to } = dateWindow();
    await results.setDateRange(from, to);

    await results.selectTab('Pending');
    await results.searchByInvoice(invoice);
    console.log(`pending ${await results.tabCount('Pending')}, done ${await results.tabCount('Done')}`);

    // An invoice only reaches this tab once the lab has acknowledged its
    // samples, so this is the seam between stage 04 and the lab's own work.
    await results.openInvoice(invoice);

    // Read only once the whole report is on screen. Filling a report that is
    // still arriving covers the departments that have landed and silently
    // leaves the rest blank — and nothing downstream would catch that until the
    // counter handed the patient an empty page.
    const onReport = await settleReport(results);
    console.log(`the report settled at ${onReport} test(s)`);
    expect(
      onReport,
      `the report for ${invoice} opened with no tests on it. The row was there to click, so this is a report ` +
        `the screen would not build rather than an invoice it does not have — usually a spent one, whose ` +
        `results have already been entered.`,
    ).toBeGreaterThan(0);

    const departments = await results.departments();
    const tests = await results.testHeadings();
    console.log(`departments: ${departments.join(', ')}`);
    tests.forEach((t) => console.log(`  test: ${t}`));
    expect(tests.length, 'the report names no tests').toBeGreaterThan(0);

    // 1, 2, 3 … down the typed fields, and a value off the list for each of the
    // rest. The numbering runs across the whole report, so the same values can
    // be recognised again further down the journey.
    const entered = await results.fillEveryResult();
    const typed = entered.filter((e) => e.kind === 'text');
    console.log(`filled ${typed.length} typed field(s) and chose ${entered.length - typed.length} from a list`);
    expect(entered.filter((e) => e.value === ''), 'nothing should be left blank').toEqual([]);

    const technologist = await results.selectTechnologist();
    console.log(`technologist: ${technologist}`);
    expect(technologist).not.toEqual('');

    await results.clearSnackbars();
    await results.save();
    // Given room to arrive, and logged rather than asserted on: the Done check
    // below is what proves the save, not the message. See stage 06 for why.
    (await results.snackbarsMatching(/save|success/i, 90_000)).forEach((m) =>
      console.log(`snackbar: ${m}`),
    );
    await page.screenshot({ path: 'test-results/e2e-05-results-saved.png', fullPage: true });

    // --- and the report is filed ---
    await results.selectTab('Done');
    await results.searchByInvoice(invoice);
    await results.openInvoice(invoice);

    // Read until the report has finished arriving, rather than once.
    //
    // The report is built department by department over the circuit, and
    // `openInvoice` returns four seconds after the *first* heading appears —
    // which on a slow afternoon is one department out of three. On 2026-11-09
    // the Done report read as carrying only SERUM LIPID PROFILE, the first of
    // the three, and the stage failed saying a test it had itself just filled
    // in was missing from it. The other two were on their way.
    //
    // Both halves are asked together: that every test came through, and that
    // the results came with them rather than just the headings.
    let filed: string[] = [];
    let saved: string[] = [];

    await expect(async () => {
      filed = await results.testHeadings();
      for (const name of tests) {
        expect(filed, `"${name}" is missing from the report under Done`).toContain(name);
      }

      saved = (await results.fields()).map((f) => f.value);
      for (const entry of typed) {
        expect(saved, `typed result "${entry.value}" is not on the saved report`).toContain(entry.value);
      }
    }).toPass({ timeout: 180_000, intervals: [3_000, 5_000, 10_000, 15_000] });

    filed.forEach((t) => console.log(`  done test: ${t}`));
    console.log(`the Done report carries ${saved.length} result(s)`);
  });

  // ---------------------------------------------------------------------
  // 06 — Lab result finalization, as the pathologist
  // ---------------------------------------------------------------------
  test('06 lab result finalization — the pathologist checks and signs the report off', async ({
    page,
    context,
  }) => {
    test.setTimeout(STAGE_TIMEOUT.finalization);
    const invoice = billNo();

    // --- the browser changes hands ---
    await test.step(`signs the ${users.pathologist.role} in`, async () => {
      await switchTo(page, context, users.pathologist, PATHOLOGIST_STORAGE_STATE);
    });

    const finalize = new LabResultFinalizationPage(page);
    // Reached through the Diagnostic menu rather than by its route: the menu is
    // built from the signed-in account's permissions, so arriving this way is
    // what proves this account can get to the screen at all.
    await finalize.gotoViaMenu();
    await finalize.recordSnackbars();

    const { from, to } = dateWindow();
    await finalize.setDateRange(from, to);

    await finalize.selectTab('Pending');

    // The box filters rather than selects, so a near miss would be opened
    // without anyone noticing. An invoice reaches this tab once its results
    // have been saved, which is the seam with stage 05.
    //
    // Asked more than once, like the microbiology lookup in stage 07 and for
    // the same reason: this grid does not always answer inside the wait, and a
    // single reading taken too early reports a report the screen is holding as
    // one it has never seen. On 2026-11-09 that produced a failure which
    // contradicted itself in a sentence — "not on the Pending tab — it was
    // listed under Pending" — the second half being the extra look the message
    // itself had triggered.
    // Each round also puts the screen back if it has gone. The Blazor circuit
    // can drop at any point, and the app answers that with a reload which lands
    // on the module selector — screen, tabs and Invoice No box all gone with
    // it. On 2026-11-09 the third round of this lookup spent thirty seconds
    // waiting for `#lrfp-invoiceno` on a page reading "Welcome back, Dr. Sazia
    // Afreen. Select a module to get started."
    let matches = 0;
    for (let attempt = 1; attempt <= CS_LOOKUP_ATTEMPTS && matches === 0; attempt++) {
      try {
        if (!(await finalize.invoiceNo.count())) {
          console.log('the finalization screen is no longer on the page; opening it again');
          await finalize.gotoViaMenu();
          await finalize.setDateRange(from, to);
          await finalize.selectTab('Pending');
        }

        await finalize.searchByInvoice(invoice);
        matches = await finalize.invoiceRowCount(invoice);
      } catch (error) {
        console.log(`the Pending lookup broke off: ${String(error).split('\n')[0]}`);
      }

      if (matches === 0) {
        console.log(`${invoice} not on Pending yet (attempt ${attempt} of ${CS_LOOKUP_ATTEMPTS})`);
      }
    }
    console.log(`pending ${await finalize.tabCount('Pending')}, done ${await finalize.tabCount('Done')}`);

    if (matches === 0) {
      // One more look, and this one says which tab it is actually on.
      const found = await finalize.locateInvoice(invoice);

      if (found === 'Pending') {
        // It was there all along and the grid was simply slow. `locateInvoice`
        // leaves that tab selected with the box still narrowed to the invoice,
        // so the screen is showing what this stage wanted.
        console.log(`${invoice} turned up on Pending on the extra look; carrying on`);
        matches = await finalize.invoiceRowCount(invoice);
      }

      expect(
        matches,
        found === 'Done'
          ? `invoice ${invoice} is under Done, so its report has already been signed off and cannot be ` +
            `finalized again. Run the whole file for a fresh invoice.`
          : found === 'Pending'
          ? `invoice ${invoice} is on the Pending tab but the grid would not list it.`
          : `invoice ${invoice} is on neither tab. A report reaches Pending once stage 05 has saved its ` +
            `results, and leaves it for good once it has been signed off.`,
      ).toBe(1);
    }
    console.log(`pending row reads "${await finalize.listedInvoiceNo(invoice)}"`);

    await finalize.openInvoice(invoice);

    // The report is built department by department; read it only once it has
    // all arrived, or the corrections below land on part of it.
    const onReport = await settleReport(finalize);
    console.log(`the report settled at ${onReport} test(s)`);
    expect(
      onReport,
      `the report for ${invoice} opened with no tests on it. The row was there and read "${invoice}", so the ` +
        `screen has the invoice and would not build its report — which is what a report already signed off ` +
        `looks like from the Pending side. Run the whole file for a fresh invoice.`,
    ).toBeGreaterThan(0);

    await test.step('corrects the first results', async () => {
      // Whichever test they fall under: the pathologist is correcting a report,
      // not a named test, and the bill's contents can change without this
      // having to.
      const typed = (await finalize.fields()).filter((f) => f.kind === 'text');
      expect(
        typed.length,
        `changing ${e2e.finalization.newResults.length} results needs at least that many on the report`,
      ).toBeGreaterThanOrEqual(e2e.finalization.newResults.length);

      for (let i = 0; i < e2e.finalization.newResults.length; i++) {
        const value = e2e.finalization.newResults[i];
        const field = finalize.field(typed[i].id);
        await field.scrollIntoViewIfNeeded();
        await field.fill(value);
        await page.waitForTimeout(400);
        await expect(field).toHaveValue(value);
        console.log(`  ${typed[i].test}: "${typed[i].value}" -> "${value}"`);
      }

      // A list left sitting on its placeholder is not a result, and the report
      // cannot be signed off carrying one.
      const repaired = await finalize.replacePlaceholderSelections();
      repaired.forEach((r) => console.log(`  placeholder on ${r.test}: "${r.from}" -> "${r.to}"`));

      const stillBlank = (await finalize.fields()).filter(
        (f) => f.kind === 'select' && /^(|\.{2,}|-+)$/.test(f.value),
      );
      expect(
        stillBlank.map((f) => `${f.test}:${f.id}`),
        'some lists are still on a placeholder instead of a result',
      ).toEqual([]);
    });

    await test.step('remarks on every test and names a different technologist', async () => {
      const commented = await finalize.fillComments(e2e.finalization.comment);
      console.log(`wrote the remark into ${commented.length} comment box(es)`);
      expect((await finalize.comments()).map((c) => c.value)).toEqual(
        commented.map(() => e2e.finalization.comment),
      );

      const technologist = await finalize.changeTechnologist();
      console.log(`technologist: "${technologist.from}" -> "${technologist.to}"`);
      expect(technologist.to.toUpperCase()).not.toEqual(technologist.from.toUpperCase());
    });

    await test.step('saves and signs it off', async () => {
      await finalize.clearSnackbars();
      await finalize.save();

      // Logged, not asserted on, and given a minute and a half to arrive.
      //
      // A snackbar is a transient thing — it shows and hides inside about a
      // second and leaves nothing behind, which is why utils/snackbars.ts
      // watches for it with a MutationObserver rather than polling. On a server
      // answering as slowly as this one it can land well outside the fifteen
      // seconds the default allows, and on 2026-11-09 the stage failed with
      // "the save was not acknowledged" on a report that had saved perfectly
      // well.
      //
      // Which is the point: the snackbar is the app clearing its throat, not
      // the record. What proves a save on this screen is the report having
      // moved to Done, and that is asserted below. A missing message is worth
      // seeing in the output, not worth failing a journey over.
      const said = await finalize.snackbarsMatching(/save|success/i, 90_000);
      said.forEach((m) => console.log(`snackbar: ${m}`));
      if (!said.length) console.log('the save went unacknowledged; the Done check below is what settles it');

      // Which of Save and Finalize performs the transition is the app's
      // business rather than this suite's: on this build Save already moves the
      // report to Done on its own. So Finalize is pressed while the screen is
      // still offering it, and the end state is asserted either way.
      console.log(`buttons before finalizing: ${(await finalize.reportActions()).join(', ')}`);
      const offersFinalize = (await finalize.finalizeButton.count())
        ? await finalize.finalizeButton.first().isVisible()
        : false;

      if (offersFinalize) {
        await finalize.clearSnackbars();
        await finalize.finalize();
        (await finalize.snackbarsMatching(/finali|success|publish/i, 15_000)).forEach((m) =>
          console.log(`snackbar: ${m}`),
        );
      } else {
        console.log('Finalize was no longer on offer — Save had signed the report off');
      }

      await page.screenshot({ path: 'test-results/e2e-06-finalized.png', fullPage: true });

      // The buttons under the report are logged and nothing is asked of them.
      //
      // They are not a signal on this build, and two runs an hour apart on
      // 2026-11-09 are what settled it. In the first, a report that finalized
      // came back with the whole strip dead:
      //
      //     Save (disabled), Finalize (disabled), Undo (disabled), Clear Form
      //
      // In the second, a report that finalized with the app saying so in as
      // many words — "Successfully finalized." — came back with the strip
      // completely unchanged, Save and Finalize both still live:
      //
      //     Save, Finalize, Undo (disabled), Clear Form
      //
      // Undo is disabled in both, before and after, so it says nothing either.
      // A check that passed on the first of those and failed on the second is
      // not a check, it is a coin toss, and asserting on it would make this
      // stage fail at random against an app that was working.
      //
      // `LabResultFinalizationPage.isFinalized()` reads those same buttons and
      // so cannot answer the question either. It is left exactly as it is: it
      // belongs to tests/diagnostic as much as to this file, and quietly
      // rewriting a shared assertion to get one suite green is how a screen
      // stops being watched.
      console.log(`buttons after finalizing: ${(await finalize.reportActions()).join(', ')}`);

      // What does answer it, in two parts.
      //
      // The report has left Pending for Done, exactly once — Save is
      // double-pressed above, so "exactly once" is a real question rather than
      // a formality. Asked more than once because this grid is slow.
      let filed = 0;
      for (let attempt = 1; attempt <= CS_LOOKUP_ATTEMPTS && filed === 0; attempt++) {
        await finalize.selectTab('Done');
        await finalize.searchByInvoice(invoice);
        filed = await finalize.invoiceRowCount(invoice);
        if (filed === 0) console.log(`${invoice} not under Done yet (attempt ${attempt})`);
      }
      expect(filed, `${invoice} should be filed exactly once under Done`).toBe(1);
      console.log(`invoice ${invoice} is filed under Done`);

      // And the second part is stage 08. Signing the report off is what puts it
      // in front of the counter, so an invoice that reaches Report Delivery
      // with its reports on it is the proof this screen will not give — which
      // is the whole point of running the journey rather than the screen.
    });

    // --- and the browser goes back to the counter ---
    await test.step(`hands the browser back to the ${users.admin.role}`, async () => {
      await switchTo(page, context, users.admin, ADMIN_STORAGE_STATE);
    });
  });

  // ---------------------------------------------------------------------
  // 07 — Microbiology report
  // ---------------------------------------------------------------------
  test('07 microbiology report — fills and signs off the culture report', async ({ page, context }) => {
    test.setTimeout(STAGE_TIMEOUT.microbiology);
    const invoice = billNo();

    // Stage 06 hands the browser back itself; this is the belt to that braces.
    await ensureAdministrator(page, context);

    // Ten cells of the antibiogram take S, R or I at random — the point being
    // that any cell should take any of them. A failure against values nobody
    // can reproduce is a failure nobody can chase, so the generator is seeded
    // and the seed printed.
    const seed = Number(process.env.E2E_CS_SEED) || Date.now() % 100_000;
    const random = seededRandom(seed);
    console.log(`antibiogram seed ${seed} — rerun these values with E2E_CS_SEED=${seed}`);

    const cs = new MicrobiologyReportPage(page);
    await cs.gotoViaMenu();
    await cs.recordSnackbars();

    const { from, to } = dateWindow();
    await cs.setDateRange(from, to);
    await cs.selectTab('Pending');

    // The bill reaches this screen because it carries a culture test whose
    // sample stage 04 acknowledged, and it leaves for good once this report is
    // signed off. The named bill is worked on or the stage stops: falling back
    // to whatever else is pending would sign a culture report off against a
    // patient nobody asked for.
    //
    // Asked more than once. `hasBill` narrows the query to the bill number and
    // waits a flat ten seconds for the grid, which this server does not always
    // answer in — and a single reading taken inside that window reports a bill
    // the screen is holding as a bill it has never heard of. On 2026-11-09
    // that produced a failure that contradicted itself in one sentence: "bill
    // 2611090200002 is not on the Pending tab — it was listed under Pending",
    // the second half being the extra look the message itself had triggered.
    let listed = false;
    for (let attempt = 1; attempt <= CS_LOOKUP_ATTEMPTS && !listed; attempt++) {
      try {
        // `hasBill` presses Show, and Show is disabled while a query is in
        // flight — the reload and the date range each set one off. Waiting for
        // the button to come back is cheaper than a thirty-second click
        // timeout, and a round that breaks off is just another round.
        await expect(cs.showButton).toBeEnabled({ timeout: 120_000 });
        listed = await cs.hasBill(invoice);
      } catch (error) {
        console.log(`the Pending lookup broke off: ${String(error).split('\n')[0]}`);
      }

      if (!listed) {
        console.log(`bill ${invoice} not on Pending yet (attempt ${attempt} of ${CS_LOOKUP_ATTEMPTS})`);
      }
    }

    if (!listed) {
      // One more look, and this one says which tab the bill is actually on.
      const found = await cs.locateBill(invoice);

      if (found === 'Pending') {
        // It was there all along and the grid was simply slow. `locateBill`
        // leaves that tab selected with the search box still narrowed to the
        // bill, so the screen is now showing exactly what the stage wanted —
        // there is nothing to fix and nothing to fail.
        console.log(`bill ${invoice} turned up on Pending on the extra look; carrying on`);
        listed = true;
      } else {
        expect(
          listed,
          found === 'Done'
            ? `bill ${invoice} is under Done, so its microbiology report has already been finalized, and a ` +
              `finalized report cannot be filled in again. Run the whole file for a fresh bill.`
            : `bill ${invoice} is on neither tab over the last ${e2e.daysBack} day(s). A bill reaches this ` +
              `screen once the lab has acknowledged a culture sample on it, so it needs a culture test on it ` +
              `and stages 02 to 04 behind it.`,
        ).toBe(true);
      }
    }

    await cs.openBill(invoice);
    await waitForLiveCircuit(page);

    const header = await cs.patientHeader();
    console.log(`opened invoice ${header.invoiceNo} — ${header.name}`);
    expect(header.invoiceNo, 'the form loaded a different bill from the row that was clicked').toBe(invoice);
    expect(header.name, 'the report loaded without a patient on it').not.toBe('');

    // The name is reported rather than asserted on, for the reason stage 01
    // gives at length: the app writes this suite's bills under the name of
    // whoever was first registered on the mobile number (E2E_B_08), so the
    // culture report names MASUD RANA-1 whatever was typed.
    //
    // This is worth seeing in the output because it is the same defect two
    // screens further on, and far more serious here than at the counter: it is
    // the clinical report that carries the wrong patient's name. The bill is
    // identified by its number, which is asserted above.
    if (patient.name && !header.name.toUpperCase().includes(patient.name.toUpperCase())) {
      console.log(
        `!! the culture report for ${invoice} names "${header.name}", and stage 01 billed ` +
          `"${patient.name}" — the wrong patient's name has followed the bill this far (E2E_B_08)`,
      );
    }

    await test.step('records what grew', async () => {
      // Every control below is a click, and a dropped circuit swallows all of them.
      await waitForLiveCircuit(page);

      const testName = await cs.selectTest();
      console.log(`test: ${testName} (specimen "${(await cs.patientHeader()).specimen}")`);
      expect(testName, 'no test was taken off the Test Name list').not.toBe('');

      // Set before anything else: a report opens on whatever its test defaults
      // to — the stool culture opens on NG — and the antibiogram everything
      // below depends on is only built for a growth.
      await cs.setCultureResult(e2e.microbiology.cultureResult as 'G' | 'NG');
      console.log(`culture result: ${await cs.cultureResult()}`);
      await cs.waitForAntibiogram();

      console.log(`pathologist: ${await cs.selectPathologist()}`);
      console.log(`technologist: ${await cs.selectTechnologist()}`);

      console.log(`organism isolated A: ${await cs.selectNamed('Organism Isolated A', random)}`);
      console.log(`colony count: ${await cs.selectNamed('Colony Count', random)}`);
      console.log(`colony count B: ${await cs.selectNamed('Colony Count B', random)}`);

      const message = await cs.pickCsMessage(
        matcher(e2e.microbiology.csMessage).query,
        matcher(e2e.microbiology.csMessage).match,
      );
      console.log(`C/S message: ${message}`);
      expect(await cs.csMessage(), 'the C/S message box is empty after picking one').not.toBe('');
    });

    await test.step('ticks the media and fills the antibiogram', async () => {
      await waitForLiveCircuit(page);

      const media = await cs.media();
      expect(
        media.length,
        `ticking ${e2e.microbiology.mediaCount} media needs at least that many on the form`,
      ).toBeGreaterThanOrEqual(e2e.microbiology.mediaCount);

      for (let i = 0; i < e2e.microbiology.mediaCount; i++) {
        await cs.setMedium(i, true);
        console.log(`  medium ticked: ${media[i].name}`);
      }

      // A pending report is not necessarily blank — the lab can record part of
      // an antibiogram, save, and come back to it — so "nothing else moved" is
      // measured against what was there on arrival.
      const before = await cs.sensitivities();
      const entered = await cs.fillAntibiogram(e2e.microbiology.antibioticCount, random);
      entered.forEach((e) => console.log(`  ${e.srl}. ${e.antibiotic} [${e.column}] = ${e.value}`));
      expect(entered).toHaveLength(e2e.microbiology.antibioticCount);

      const after = await cs.sensitivities();
      entered.forEach((e) =>
        expect(after[e.cellId], `${e.antibiotic} should read "${e.value}"`).toBe(e.value),
      );
      const filled = new Set(entered.map((e) => e.cellId));
      expect(
        Object.entries(after)
          .filter(([id, value]) => !filled.has(id) && value !== before[id])
          .map(([id, value]) => `${id}: "${before[id]}" -> "${value}"`),
        'cells this stage never touched have changed',
      ).toEqual([]);

      await cs.setNote(e2e.microbiology.note);
      console.log(`note: ${e2e.microbiology.note}`);
    });

    await test.step('saves and signs it off', async () => {
      await waitForLiveCircuit(page);
      await cs.clearSnackbars();
      await cs.save();
      const saved = await cs.snackbarsMatching(/save|success|update/i);
      saved.forEach((m) => console.log(`snackbar: ${m}`));
      expect(saved.join(' | '), 'the save was not acknowledged at all').toMatch(/save|success|update/i);
      await page.screenshot({ path: 'test-results/e2e-07-cs-saved.png', fullPage: true });

      // Finalize is absent from a loaded pending report and comes back once it
      // has been saved, so its absence here means the save did not take.
      const hasFinalize = await cs.finalizeButton
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      expect(hasFinalize, `the Finalize button is not on the saved report for ${invoice}`).toBe(true);

      await cs.clearSnackbars();
      await cs.finalize();
      (await cs.snackbarsMatching(/finali|success|already/i)).forEach((m) => console.log(`snackbar: ${m}`));
      await page.screenshot({ path: 'test-results/e2e-07-cs-finalized.png', fullPage: true });

      // --- and it was filed once ---
      //
      // A finalized report leaves Pending for Done, and both tabs are asked
      // through the search box rather than read off the grid: Done runs to
      // hundreds of bills and only the stretch on screen is rendered.
      //
      // The screen is **reloaded** before any of that. With a report still on
      // the form this build disables Show — the left panel cannot be
      // re-queried while the right half is holding a report — so asking the
      // tabs in place sat on a dead button for the full thirty seconds and
      // timed out, on a report that had finalized perfectly well. The app had
      // already said as much: "Report finalized. It is now in the Acknowledged
      // tab of Report Delivery."
      await cs.goto();
      await waitForLiveCircuit(page);
      await cs.setDateRange(from, to);

      // Show is disabled while a query is in flight, as well as while a report
      // is open — the same thing the investigation dashboard does with Show and
      // Filter. Reloading the screen deals with the open report; it does
      // nothing about the queries the reload, the date range and the tab switch
      // each set off, and clicking Show in the middle of those is how this
      // verification timed out a second time on a report that had finalized.
      // So each search waits for the button to come back to life first, and the
      // whole search is retried rather than pressed once and hoped for.
      const search = async (term: string) => {
        await expect(
          cs.showButton,
          'the Microbiology screen left Show disabled, so the grid could not be re-queried',
        ).toBeEnabled({ timeout: 120_000 });
        await cs.searchFor(term);
      };

      // Asked more than once, for the same reason the lookup at the top of this
      // stage is: ten seconds is not always enough for this grid.
      await cs.selectTab('Done');
      let done: string[] = [];
      for (let attempt = 1; attempt <= CS_LOOKUP_ATTEMPTS && !done.length; attempt++) {
        await search(invoice);
        done = (await cs.bills()).filter((b) => b === invoice);
        if (!done.length) console.log(`${invoice} not under Done yet (attempt ${attempt})`);
      }

      // Read once: that it has *left* Pending is already corroborated by its
      // turning up under Done, so a slow grid here costs nothing.
      await cs.selectTab('Pending');
      await search(invoice);
      const stillPending = (await cs.bills()).filter((b) => b === invoice);

      // Finalize is double-clicked, so this is a real question rather than a
      // formality: what the screen must not do is file the same report twice.
      expect(done.length, `${invoice} should appear once under Done`).toBe(1);
      expect(stillPending.length, `${invoice} is finalized but still sitting on Pending`).toBe(0);
      console.log(`the culture report for ${invoice} is signed off`);
    });
  });

  // ---------------------------------------------------------------------
  // 08 — Report delivery
  // ---------------------------------------------------------------------
  test('08 report delivery — acknowledges, hands over and prints the reports', async ({
    page,
    context,
  }) => {
    test.setTimeout(STAGE_TIMEOUT.delivery);
    const invoice = billNo();

    await ensureAdministrator(page, context);

    // Print All renders the reports and hands them to a printer; on this server
    // that opens a PDF tab, which would otherwise sit in the shared context.
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('popup', (p) => p.close().catch(() => {}));

    const delivery = new ReportDeliveryPage(page);
    await delivery.goto();
    await waitForLiveCircuit(page);
    await delivery.recordSnackbars();

    const { from, to } = dateWindow();
    await delivery.setDateRange(from, to);

    // The number is searched for on its own — the date range above it does not
    // bound it — so an invoice missing here is a missing invoice rather than
    // one outside the range.
    //
    // Waited for, though, rather than asked once. Signing a report off is not
    // the same instant as the counter being able to see it: on 2026-11-09 the
    // reports for 2611090200002 were finalized on both screens — the
    // microbiology one answering "Report finalized. It is now in the
    // Acknowledged tab of Report Delivery" — and this screen still had nothing
    // under any of its three stages half a minute later. Ten minutes on, with
    // nothing else touched, the invoice was sitting there under "Not
    // Acknowledged". So the counter's list lags publication, and the honest
    // thing is to give it time rather than to call the reports missing.
    //
    // `findInvoice` already presses Show three times over about thirty
    // seconds; this wraps that in a few rounds with a pause between, which is
    // the difference between thirty seconds of patience and three minutes of
    // it.
    let listed = false;
    for (let round = 1; round <= DELIVERY_LOOKUP_ROUNDS && !listed; round++) {
      listed = await delivery.findInvoice(invoice);
      if (!listed && round < DELIVERY_LOOKUP_ROUNDS) {
        console.log(
          `invoice ${invoice} has not reached the counter yet (round ${round} of ` +
            `${DELIVERY_LOOKUP_ROUNDS}); giving it a moment`,
        );
        await page.waitForTimeout(20_000);
      }
    }

    expect(
      listed,
      `invoice ${invoice} never reached the Report Delivery list, after ${DELIVERY_LOOKUP_ROUNDS} rounds of ` +
        `looking over about three minutes. Its reports have to be signed off first — stage 06 for the lab ` +
        `report and stage 07 for the culture one — and this screen lags that by a little, but not by this ` +
        `much.`,
    ).toBe(true);

    let handedOver: string[] = [];

    await test.step('acknowledges the finished reports', async () => {
      // An empty "Not Acknowledged" is a state, not a failure.
      //
      // The reports on one invoice do not all arrive at the same stage. The lab
      // and culture ones are put straight into "Acknowledged" when they are
      // signed off — the microbiology screen says as much on finalizing: "It is
      // now in the Acknowledged tab of Report Delivery" — while the radiology
      // one waits under "Not Acknowledged" for someone at the counter. So a
      // bill carrying no radiology test has nothing here to acknowledge at all,
      // and insisting on something to tick would fail a journey that is going
      // exactly as it should.
      //
      // What this stage is really for is the handover, and that is asserted in
      // the step below against everything the Acknowledged list holds.
      await delivery.filterBy('Not Acknowledged');
      const selected = await delivery.selectInvoice(invoice, 30_000);
      const pending = selected ? await delivery.rows() : [];

      // Asked of the reports rather than of the invoice. The invoice can still
      // be *listed* under a stage it has no reports left in — the counts beside
      // these radio buttons go stale, which the diagnostic suite records as
      // RD_B_03 — so clicking the row succeeds and the grid behind it comes up
      // empty, with the patient bar blank beside it.
      if (!pending.length) {
        console.log(
          `invoice ${invoice} has no reports under "Not Acknowledged" (row selectable: ${selected}) — they ` +
            `went straight to "Acknowledged" when they were signed off, which is where the next step picks ` +
            `them up`,
        );
        return;
      }

      console.log(`patient: ${await delivery.patient()}`);
      pending.forEach((r, i) => console.log(`  ${i + 1}. ${r.testName} | payment=${r.paymentStatus || '-'}`));
      expect(pending.every((r) => r.invoiceNo === invoice)).toBe(true);
      expect(pending.every((r) => r.receivedBy === '' && r.receivedAt === '')).toBe(true);

      // The button takes whatever is ticked and the grid is redrawn with what
      // is left, so it is pressed again for anything a pass did not carry
      // rather than once and hoped for. Two passes is already more than the
      // screen has ever needed; the third breaks the loop rather than being used.
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

      await page.screenshot({ path: 'test-results/e2e-08-acknowledged.png', fullPage: true });
      await expect(
        delivery.testRows,
        'every report that was ticked should have left "Not Acknowledged"',
      ).toHaveCount(0, { timeout: 30_000 });
    });

    await test.step('hands them to the patient', async () => {
      await openAtStage(delivery, 'Acknowledged', invoice);

      const ready = await delivery.rows();
      expect(ready.length).toBeGreaterThan(0);
      expect(ready.every((r) => r.receivedAt !== ''), 'an acknowledged report is stamped').toBe(true);

      const ticked = await delivery.tickAllInOrder();
      ticked.forEach((name, i) => console.log(`ticked ${i + 1}: ${name}`));
      expect(ticked).toHaveLength(ready.length);

      await delivery.clearSnackbars();
      await delivery.deliver();
      const said = await delivery.dismissModal();
      if (said) console.log(`dialog: ${said}`);
      (await delivery.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
      await page.screenshot({ path: 'test-results/e2e-08-delivered.png', fullPage: true });

      await openAtStage(delivery, 'Delivery', invoice);

      const delivered = await delivery.rows();
      delivered.forEach((r) => console.log(`  ${r.testName} | delivered=${r.deliveredAt}`));
      ticked.forEach((name) =>
        expect(
          delivered.some((r) => r.testName.toUpperCase() === name.toUpperCase()),
          `${name} was delivered but is not listed under "Delivery"`,
        ).toBe(true),
      );
      expect(delivered.every((r) => r.deliveredAt !== '')).toBe(true);
      handedOver = ticked;
    });

    await test.step('prints them', async () => {
      // Pressed on the delivered list rather than the one before it: Print All
      // is drawn beside the Delivery button only while the acknowledged grid
      // still has rows, and delivering is exactly what empties that grid.
      //
      // Printing is not asserted on beyond this. The app prints straight to a
      // configured printer, says nothing when it works, and sometimes answers
      // "Server returned an unexpected payload" when it does not — so anything
      // it says is logged, and the only thing held to is that printing changed
      // nothing about what was handed over.
      const before = await delivery.rows();

      await delivery.clearSnackbars();
      await delivery.printAll();
      const said = await delivery.dismissModal();
      if (said) console.log(`dialog: ${said}`);
      (await delivery.snackbars()).forEach((m) => console.log(`snackbar: ${m}`));
      await page.screenshot({ path: 'test-results/e2e-08-printed.png', fullPage: true });

      const after = await delivery.rows();
      expect(
        after.map((r) => `${r.testName}|${r.deliveredAt}`).sort(),
        'printing must not change what has been delivered',
      ).toEqual(before.map((r) => `${r.testName}|${r.deliveredAt}`).sort());

      console.log(
        `\n=== invoice ${invoice} for ${patient.name || 'the patient'} is complete: ` +
          `${handedOver.length} report(s) raised, sampled, resulted, signed off and handed over ===\n`,
      );
    });
  });
});
