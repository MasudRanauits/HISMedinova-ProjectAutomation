import { Page } from '@playwright/test';
import { test, expect, investigations } from '../../fixtures/test';
import { Antibiotic, MicrobiologyReportPage, asPickerDate, seededRandom } from '../../pages/MicrobiologyReportPage';
import { ROUTES } from '../../utils/constants';
import { settledCount } from '../../utils/blazor';

const data = investigations.csReport;

/**
 * Microbiology Report — the culture and sensitivity report (/diagnostic/cs-report).
 *
 * One pass through the screen the way the lab works it: find the bill on the
 * Pending tab inside a date range, open it, pick the test, name the pathologist
 * and the technologist, record a growth with the organism isolated and its
 * colony counts, choose the C/S message, tick the media the plate was grown on,
 * fill the antibiogram, write the note, and then save, print and finalize.
 *
 * ## Why this spec does not take the chain's invoice
 *
 * The rest of tests/diagnostic hands one invoice down the chain, and this spec
 * joins in: `recordInvoiceNo` writes each new invoice into `csReport.invoiceNo`
 * alongside the sample specs. A bill reaches the Pending tab here once it
 * carries a culture test whose sample the lab has acknowledged — which the
 * chain's invoice does, through STOOL FOR CULTURE & SENSITIVITY — and it leaves
 * for good once its report is finalized.
 *
 * A configured bill is worked on or the test stops, saying which tab the bill
 * actually turned up on. It must not quietly fall back to whatever else is
 * pending: this spec signs a culture report off, and doing that to a patient
 * nobody asked for is worse than not running. Only with no bill configured at
 * all does it take the first the tab offers. `CS_REPORT_INVOICE` aims it
 * somewhere else for one run.
 *
 * ## The antibiogram is filled at random, reproducibly
 *
 * Ten of the grid's antibiotics get S, R or I at random — the point being that
 * any cell should take any of them. A failure against values nobody can
 * reproduce is a failure nobody can chase, so the generator is seeded and the
 * seed printed; `CS_REPORT_SEED=<n>` runs the same values again.
 *
 * ## Stopping short
 *
 * Saving files a clinical report against a real patient and finalizing signs it
 * off, and neither can be undone from the UI. `CS_REPORT_SAVE=0` fills the form
 * and stops; `CS_REPORT_FINALIZE=0` saves and prints but leaves the report
 * unsigned.
 */
const SHOULD_SAVE = process.env.CS_REPORT_SAVE !== '0';
const SHOULD_FINALIZE = process.env.CS_REPORT_FINALIZE !== '0';
const WANTED_INVOICE = process.env.CS_REPORT_INVOICE || data.invoiceNo;
const SEED = Number(process.env.CS_REPORT_SEED) || Date.now() % 100_000;

test.describe('Microbiology (C/S) report', () => {
  test('fills a culture report, saves it twice over, prints it and finalizes it', async ({ page }) => {
    // Forty-two antibiotics to read, ten autocompletes to drive, a PDF to print
    // and two guarded double-clicks, each a round trip over the Blazor circuit.
    test.setTimeout(900_000);

    const random = seededRandom(SEED);
    console.log(`antibiogram seed ${SEED} — rerun these values with CS_REPORT_SEED=${SEED}`);

    const cs = new MicrobiologyReportPage(page);
    await cs.gotoViaMenu();
    await cs.recordSnackbars();

    // --- find a bill on the Pending tab ---
    const from = new Date();
    from.setDate(from.getDate() - data.daysBack);
    await cs.setDateRange(from, new Date());

    await cs.selectTab('Pending');
    await cs.searchFor(WANTED_INVOICE);

    let billNo: string;

    if (WANTED_INVOICE) {
      // A named bill is worked on or the test stops. Quietly falling back to
      // whatever else is pending would file and sign off a culture report
      // against a patient nobody asked for.
      const listed = (await cs.bills()).includes(WANTED_INVOICE);
      if (!listed) {
        const found = await cs.locateBill(WANTED_INVOICE);
        expect(
          listed,
          found === 'Done'
            ? `bill ${WANTED_INVOICE} is not on the Pending tab — it is under Done, so its microbiology report ` +
              `has already been finalized, and a finalized report cannot be filled in again. Run the chain from ` +
              `1-register through 5-acknowledge for a bill carrying a fresh culture test.`
            : `bill ${WANTED_INVOICE} is on neither tab for the last ${data.daysBack} day(s). It only reaches ` +
              `this screen once it carries a culture test whose sample has been acknowledged in the lab, so run ` +
              `the chain through 5-acknowledge first — or widen csReport.daysBack if the bill is older than that.`,
        ).toBe(true);
      }
      billNo = WANTED_INVOICE;
      console.log(`working on bill ${billNo}, the one asked for`);
    } else {
      // Nothing configured: take whatever the tab is offering, and say so.
      await cs.searchFor('');
      const bills = await cs.bills();
      console.log(`Pending is listing ${bills.length} bill(s) over the last ${data.daysBack} day(s)`);
      expect(
        bills.length,
        `the Pending tab has no bills at all for the last ${data.daysBack} day(s). A bill only reaches this ` +
          `screen once it carries a culture test whose sample has been acknowledged in the lab — widen ` +
          `csReport.daysBack, or acknowledge a culture sample first.`,
      ).toBeGreaterThan(0);
      billNo = bills[0];
      console.log(`no bill configured; working on ${billNo}, the first Pending offers`);
    }

    await cs.openBill(billNo);

    const patient = await cs.patientHeader();
    console.log(`opened invoice ${patient.invoiceNo} — ${patient.name}`);
    expect(patient.invoiceNo, 'the form loaded a different bill from the row that was clicked').toBe(billNo);
    expect(patient.name, 'the report loaded without a patient on it').not.toBe('');

    // --- the test, and the two people who sign for it ---
    const testName = await cs.selectTest();
    console.log(`test: ${testName} (specimen "${(await cs.patientHeader()).specimen}")`);
    expect(testName, 'no test was taken off the Test Name list').not.toBe('');

    // The growth is recorded here rather than further down with the rest of it:
    // a report opens on whatever culture result its test defaults to — the stool
    // culture opens on NG — and the antibiogram everything below depends on is
    // only built for a growth.
    await cs.setCultureResult(data.cultureResult as 'G' | 'NG');
    console.log(`culture result: ${await cs.cultureResult()}`);
    await cs.waitForAntibiogram();

    const pathologist = await cs.selectPathologist();
    const technologist = await cs.selectTechnologist();
    console.log(`pathologist: ${pathologist}`);
    console.log(`technologist: ${technologist}`);
    expect(await cs.selected('Pathologist'), 'the pathologist did not stick').toContain(pathologist);
    expect(await cs.selected('Technologist'), 'the technologist did not stick').toContain(technologist);

    // --- what grew ---
    const organism = await cs.selectNamed('Organism Isolated A', random);
    console.log(`organism isolated A: ${organism}`);

    const colonyCount = await cs.selectNamed('Colony Count', random);
    const colonyCountB = await cs.selectNamed('Colony Count B', random);
    console.log(`colony count: ${colonyCount}`);
    console.log(`colony count B: ${colonyCountB}`);

    const message = await cs.pickCsMessage(data.csMessage.query, new RegExp(data.csMessage.match, 'i'));
    console.log(`C/S message: ${message}`);
    expect(await cs.csMessage(), 'the C/S message box is empty after picking one').not.toBe('');

    // --- the media the plate was grown on ---
    // Each is ticked, cleared and ticked again: a box that merely ends up ticked
    // may have arrived that way, and walking it through both states is what
    // shows the screen is recording the change rather than ignoring the click.
    const media = await cs.media();
    console.log(`culture media on offer: ${media.map((m) => m.name).join(', ')}`);
    expect(
      media.length,
      `ticking ${data.mediaCount} media needs at least that many on the form`,
    ).toBeGreaterThanOrEqual(data.mediaCount);

    for (let i = 0; i < data.mediaCount; i++) {
      const seen = await cs.retickMedium(i);
      console.log(`  ${media[i].name}: ticked ${seen[0]} -> cleared ${seen[1]} -> ticked ${seen[2]}`);
      expect(seen, `${media[i].name} did not follow the tick-clear-tick it was given`).toEqual([true, false, true]);
    }

    const afterMedia = await cs.media();
    expect(
      afterMedia.slice(0, data.mediaCount).map((m) => m.checked),
      'the first media should all be left ticked',
    ).toEqual(Array(data.mediaCount).fill(true));
    expect(
      afterMedia.slice(data.mediaCount).some((m) => m.checked),
      'a medium nobody touched has been ticked',
    ).toBe(false);

    // --- the antibiogram ---
    const grid = await cs.antibiotics();
    const enabled = grid.filter((a) => a.cells.A.id && !a.cells.A.disabled);
    console.log(
      `antibiogram: ${await cs.antibiogramRows.count()} row(s), ${grid.length} antibiotic(s), ` +
        `${enabled.length} with column A open`,
    );

    // What the grid held on arrival. A pending report is not necessarily blank —
    // the lab can record part of an antibiogram, save, and come back to it — so
    // "nothing else moved" has to be measured against this rather than against
    // an assumption that every other cell is empty.
    const before = await cs.sensitivities();
    const alreadyFilled = Object.entries(before).filter(([, value]) => value);
    console.log(`${alreadyFilled.length} cell(s) already carried a sensitivity before this run`);

    const entered = await cs.fillAntibiogram(data.antibioticCount, random);
    entered.forEach((e) => console.log(`  ${e.srl}. ${e.antibiotic} [${e.column}] = ${e.value}`));
    expect(entered, `${data.antibioticCount} antibiotics should have been filled`).toHaveLength(
      data.antibioticCount,
    );

    // Read the grid back in one pass: every value entered is there, and nothing
    // outside them has moved.
    const after = await cs.sensitivities();
    entered.forEach((e) =>
      expect(after[e.cellId], `${e.antibiotic} should read "${e.value}"`).toBe(e.value),
    );

    const filledIds = new Set(entered.map((e) => e.cellId));
    const moved = Object.entries(after)
      .filter(([id, value]) => !filledIds.has(id) && value !== before[id])
      .map(([id, value]) => `${id}: "${before[id]}" -> "${value}"`);
    expect(moved, 'cells this spec never touched have changed').toEqual([]);

    // --- the note ---
    const words = data.note.trim().split(/\s+/);
    expect(words, `the note should be twenty words; "${data.note}" has ${words.length}`).toHaveLength(20);
    await cs.setNote(data.note);
    console.log(`note (${words.length} words): ${data.note}`);

    await page.screenshot({ path: 'test-results/cs-report-filled.png', fullPage: true });

    test.skip(!SHOULD_SAVE, 'CS_REPORT_SAVE=0: stopping before the report is saved');

    // --- save, twice over in one gesture ---
    // A double-click is what an impatient operator gives a button that takes ten
    // seconds to answer. The screen may disable Save, may refuse the second
    // press, may do nothing at all — what it must not do is file two reports.
    await cs.clearSnackbars();
    await cs.save();

    const saved = await cs.snackbarsMatching(/save|success|update/i);
    saved.forEach((m) => console.log(`snackbar after the double-click on Save: ${m}`));
    expect(saved.join(' | '), 'the save was not acknowledged at all').toMatch(/save|success|update/i);

    const duplicates = saved.filter((m) => /save|success|update/i.test(m));
    console.log(`Save still enabled afterwards: ${await cs.saveButton.isEnabled().catch(() => false)}`);
    console.log(`success messages seen: ${duplicates.length}`);

    await page.screenshot({ path: 'test-results/cs-report-saved.png', fullPage: true });

    // --- print, and check what actually came out ---
    const popup = await cs.printReport();
    const url = await cs.printedUrl(popup);
    console.log(`print tab settled on ${url.slice(0, 60)}${url.length > 60 ? '…' : ''}`);

    await popup.waitForTimeout(3_000);
    await popup.screenshot({ path: 'test-results/cs-report-print-tab.png' }).catch(() => {});

    const printed = await cs.readPrinted(url);
    await cs.closePrintTab(popup);

    if (test.info().project.use.headless === true) {
      // Headless Chrome has no PDF viewer, so the tab never leaves about:blank
      // and there is no blob to read. Saying so beats asserting on nothing.
      console.log('headless run: no PDF viewer, so the printed report cannot be read back');
    } else {
      expect(url, 'the print tab should have been handed the report as a PDF').toMatch(/^blob:/);

      expect(printed, `the printed blob at ${url} could not be read back`).not.toBeNull();
      console.log(`printed PDF: ${printed!.size} bytes, header "${printed!.header}", type "${printed!.contentType}"`);
      expect(printed!.header, 'what printed is not a PDF').toBe('%PDF-');
      // A header and nothing behind it is a report that printed blank; a real
      // one-page memo off this app runs to tens of kilobytes.
      expect(printed!.size, 'the printed PDF is too small to be a report').toBeGreaterThan(5_000);
    }

    // The form is still the one that was printed — printing must not have
    // cleared or reloaded it.
    expect((await cs.patientHeader()).invoiceNo, 'printing moved the form off the bill').toBe(billNo);
    expect(await cs.note.inputValue(), 'printing cleared the note').toBe(data.note);

    test.skip(!SHOULD_FINALIZE, 'CS_REPORT_FINALIZE=0: stopping with the report saved but unsigned');

    // --- finalize, twice over in one gesture ---
    // Finalize is not on a loaded pending report at all; it comes back once the
    // report has been saved. If it is still missing, say so rather than time out
    // on a locator.
    const hasFinalize = await cs.finalizeButton
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    expect(
      hasFinalize,
      `the Finalize button is not on the saved report for ${billNo}. It is absent from a pending report and ` +
        `returns once the report is saved, so its absence here means the save did not take.`,
    ).toBe(true);

    await cs.clearSnackbars();
    await cs.finalize();

    const finalized = await cs.snackbarsMatching(/finali|success|already/i);
    finalized.forEach((m) => console.log(`snackbar after the double-click on Finalize: ${m}`));
    expect(finalized.join(' | '), 'the finalize was not acknowledged at all').toMatch(/finali|success|already/i);

    await page.screenshot({ path: 'test-results/cs-report-finalized.png', fullPage: true });

    // --- and it was filed once ---
    // A finalized report leaves Pending for Done. Two presses must not put it
    // there twice, and must not leave it on both tabs.
    // Both tabs are asked through the Search box rather than read off the grid:
    // Done runs to hundreds of bills and the grid only renders the stretch on
    // screen, so counting rendered rows would miss it.
    await cs.selectTab('Done');
    await cs.searchFor(billNo);
    const done = (await cs.bills()).filter((b) => b === billNo);
    console.log(`Done lists ${done.length} row(s) for ${billNo}`);

    await cs.selectTab('Pending');
    await cs.searchFor(billNo);
    const stillPending = (await cs.bills()).filter((b) => b === billNo);
    console.log(`Pending still lists ${stillPending.length} row(s) for ${billNo}`);

    expect(
      done.length,
      `double-clicking Finalize filed ${billNo} ${done.length} time(s); it should appear once under Done`,
    ).toBe(1);
    expect(
      stillPending.length,
      `${billNo} is finalized but still sitting on the Pending tab`,
    ).toBe(0);

    await page.screenshot({ path: 'test-results/cs-report-done.png', fullPage: true });
  });
});

// ---------------------------------------------------------------------------
// The rest of the screen.
//
// The suite above is the one pass a lab actually makes through this form, and
// it signs a report off at the end of it. What follows never saves anything:
// it works the controls, reads what they answer and puts them back, so it can
// be run against the same bill as often as you like.
//
// Two things to know before reading it.
//
// The first suite needs no bill at all — it is about the list, the date range,
// the search box and the three buttons on an empty shell. The second opens
// whatever report the Pending tab is offering, because by the time these run
// the suite above has usually finalized the chain's own bill and moved it to
// Done. Where Pending has nothing to offer, a test says so and skips rather
// than inventing work.
//
// And nothing here presses Save or Finalize on a loaded report. Save files a
// clinical result against a real patient; Finalize signs it. The one Save this
// file presses is on the empty shell, which is the question "does this screen
// file a report nobody filled in?" — worth asking exactly once.
// ---------------------------------------------------------------------------

/** A bill number no invoice carries, for the searches that should find nothing. */
const MISSING_INVOICE = '9999999999999';

const TODAY = asPickerDate(new Date());

/** Anything the server refused while a test was driving the screen. */
function watchForServerErrors(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  return failures;
}

/** The screen, open on Pending over the window `csReport.daysBack` sets. */
async function open(page: Page): Promise<MicrobiologyReportPage> {
  const cs = new MicrobiologyReportPage(page);
  await cs.goto();
  await cs.recordSnackbars();

  const from = new Date();
  from.setDate(from.getDate() - data.daysBack);
  await cs.setDateRange(from, new Date());

  await cs.selectTab('Pending');
  await cs.show();
  return cs;
}

/**
 * Opens whatever report Pending is offering, or skips for want of one.
 *
 * Deliberately not `csReport.invoiceNo`: that bill is usually finalized by the
 * time these run, and none of this writes anything, so any pending report
 * answers the question just as well.
 */
async function openAnyPendingReport(cs: MicrobiologyReportPage): Promise<string> {
  await cs.searchFor('');
  const bills = await cs.bills();
  test.skip(
    bills.length === 0,
    `the Pending tab is offering no bill over the last ${data.daysBack} day(s), so there is no report to ` +
      `read. A bill reaches it once the lab has acknowledged a culture sample, and leaves it once its report ` +
      `is finalized.`,
  );

  await cs.openBill(bills[0]);
  return bills[0];
}

test.describe('Microbiology (C/S) report — the list and the empty form', () => {
  // Every one of these opens the screen from scratch over a ten-day window, and
  // this screen answers slowly; the file's default of 90 seconds is not enough
  // to get a test as far as its own first assertion.
  test.describe.configure({ timeout: 300_000 });

  // --- landing ------------------------------------------------------------

  test('CS_N_01 the screen opens from the Diagnostic menu with both tabs and its grid', async ({ page }) => {
    const cs = new MicrobiologyReportPage(page);
    // Through the menu rather than the route: the sidebar is built from the
    // signed-in account's permissions, so arriving this way also says the
    // account can reach the screen at all.
    await cs.gotoViaMenu();

    await expect(page).toHaveURL(new RegExp(`${ROUTES.csReport}$`));
    for (const name of ['Pending', 'Done'] as const) {
      await expect(cs.tab(name), `the ${name} tab is not on the screen`).toBeVisible();
    }
    await expect(cs.startDate, 'the Start Date picker').toBeVisible();
    await expect(cs.endDate, 'the End Date picker').toBeVisible();
    await expect(cs.search, 'the Search box').toBeVisible();
    await expect(cs.showButton, 'the Show button').toBeEnabled();
    await expect(cs.grid, 'the bill grid').toBeVisible();

    const headers = (await cs.grid.locator('thead th').allInnerTexts()).map((h) =>
      h.replace(/\s+/g, ' ').trim(),
    );
    console.log(`the bill grid is headed: ${headers.join(' | ')}`);
    expect(headers.length, 'the bill grid arrived without column headings').toBeGreaterThan(0);

    console.log(`the screen opens on the "${await cs.activeTab()}" tab`);
    expect(await cs.activeTab(), 'the screen should open on the work still to do').toMatch(/^pending$/i);
  });

  test('CS_N_02 a bill is listed under one tab or the other, never both', async ({ page }) => {
    const cs = await open(page);

    for (const name of ['Pending', 'Done'] as const) {
      await cs.selectTab(name);
      expect(await cs.activeTab(), `clicking ${name} should select it`).toMatch(new RegExp(`^${name}$`, 'i'));
      await expect(cs.grid, `the ${name} tab should carry a grid of its own`).toBeVisible();
      console.log(`${name}: ${await cs.billRows.count()} row(s) rendered over the last ${data.daysBack} day(s)`);
    }

    await cs.selectTab('Pending');
    await cs.searchFor('');
    const pending = await cs.bills();

    if (!pending.length) {
      console.log('Pending is empty, so there is no bill to look for under Done');
      return;
    }

    // Pending and Done are two halves of one list: a report is either still to
    // be filled in or has been signed off, and it cannot be both.
    await cs.selectTab('Done');
    await cs.searchFor(pending[0]);
    const alsoDone = (await cs.bills()).filter((b) => b === pending[0]);
    console.log(`${pending[0]} is pending; Done lists it ${alsoDone.length} time(s)`);

    expect(alsoDone, `${pending[0]} is on the Pending tab and under Done at the same time`).toEqual([]);
  });

  // --- the date range -----------------------------------------------------

  test('CS_N_03 a future range returns an empty grid, not an exception', async ({ page }) => {
    const cs = await open(page);
    const failures = watchForServerErrors(page);

    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    await cs.typeDate(cs.startDate, asPickerDate(next));
    await cs.typeDate(cs.endDate, asPickerDate(next));
    await cs.show();

    await expect(cs.billRows, 'no bill has been acknowledged next month').toHaveCount(0);
    expect(failures, 'a future range must not produce a server error').toEqual([]);
  });

  test('CS_N_04 a six-year range answers instead of hanging', async ({ page }) => {
    test.setTimeout(420_000);
    const cs = await open(page);

    await cs.typeDate(cs.startDate, '01-01-2020');
    await cs.typeDate(cs.endDate, TODAY);

    const started = Date.now();
    await cs.showButton.click();
    // Rows arriving and the grid staying empty are both answers. A hang is not.
    await expect(cs.grid).toBeVisible({ timeout: 180_000 });
    await settledCount(cs.billRows, { quiet: 2_000, timeout: 180_000 });
    const elapsed = Date.now() - started;

    console.log(`01-01-2020..${TODAY} answered in ${elapsed}ms with ${await cs.billRows.count()} row(s) rendered`);
    expect(elapsed, 'a wide range should still answer inside three minutes').toBeLessThan(180_000);
  });

  /**
   * CS_B_01: a range the wrong way round is queried rather than refused, the
   * same way the collection and dispatch screens take theirs (SC_N_02,
   * SD_B_01). The empty grid that comes back reads as "no bills" rather than
   * "your dates are the wrong way round", and there is nothing on the screen to
   * tell the two apart.
   */
  test.fail('CS_B_01 a reversed date range is called out rather than queried', async ({ page }) => {
    const cs = await open(page);

    await cs.typeDate(cs.startDate, TODAY);
    await cs.typeDate(cs.endDate, '10-09-2020');
    await cs.show();

    // Matched on the complaint itself, never on the words "End Date": the
    // picker's own label carries those, and a locator loose enough to catch it
    // reports a validation message the screen never showed.
    const message = page.getByText(
      /date to.*(greater|after|>=)|(start|from).*date.*(less|before|<=)|invalid date range|range is invalid/i,
    );
    await expect(message, 'a reversed range should be refused before it is queried').toBeVisible({
      timeout: 10_000,
    });
  });

  /**
   * CS_B_02: 31 February does not exist, and the picker rolls it forward to
   * 03-03 under the operator's fingers rather than refusing it. The screen then
   * reports on a day nobody asked for — the same flatpickr behaviour SC_N_02
   * records on sample collection.
   */
  test.fail('CS_B_02 an impossible date is refused rather than rolled over', async ({ page }) => {
    const cs = await open(page);

    const held = await cs.typeDate(cs.startDate, '31-02-2026');
    console.log(`typed 31-02-2026, the Start Date picker holds "${held}"`);

    expect(
      held === '' || /invalid/i.test(held),
      `31 February does not exist; the picker should refuse it, but it holds "${held}"`,
    ).toBe(true);
  });

  /** CS_B_03: both pickers can be emptied and Show still fires on nothing. */
  test.fail('CS_B_03 a blank date range is required before Show will run', async ({ page }) => {
    const cs = await open(page);

    const start = await cs.typeDate(cs.startDate, '');
    const end = await cs.typeDate(cs.endDate, '');
    console.log(`cleared both pickers; Start holds "${start}", End holds "${end}"`);
    await cs.show();

    const message = page.getByText(/date is required|please select.*date/i);
    await expect(message, 'a query over no dates at all should be refused').toBeVisible({ timeout: 10_000 });
  });

  // --- the search box -----------------------------------------------------

  test('CS_N_05 a bill number nobody carries leaves the grid empty', async ({ page }) => {
    const cs = await open(page);
    const failures = watchForServerErrors(page);

    await cs.searchFor(MISSING_INVOICE);

    await expect(cs.billRows, `${MISSING_INVOICE} is not a bill`).toHaveCount(0);
    expect(failures, 'a bill that does not exist must not produce a server error').toEqual([]);
  });

  test('CS_N_06 a whitespace-only search behaves like an empty one', async ({ page }) => {
    const cs = await open(page);
    const failures = watchForServerErrors(page);

    await cs.searchFor('');
    const before = await cs.billRows.count();
    await cs.searchFor('   ');
    const after = await cs.billRows.count();

    console.log(`rows on an empty search: ${before}; on "   ": ${after}`);
    expect(failures, 'three spaces must not reach the database as a search term').toEqual([]);
    expect(after, 'a box holding nothing but spaces is a box holding nothing').toBe(before);
  });

  for (const [id, payload] of [
    ['CS_N_07', '!@#$%^&*()'],
    ['CS_N_08', "' OR 1=1--"],
    ['CS_N_09', '../../etc/passwd'],
  ] as const) {
    test(`${id} "${payload}" in the search box is handled without a server error`, async ({ page }) => {
      const cs = await open(page);
      const failures = watchForServerErrors(page);

      await cs.searchFor(payload);

      expect(failures, `"${payload}" must not reach the database unescaped`).toEqual([]);
      // An injection that worked would hand back bills it has no business
      // handing back — every one of these matches no bill number at all.
      await expect(cs.billRows).toHaveCount(0);
    });
  }

  test('CS_N_10 an XSS payload in the search box is text, never script', async ({ page }) => {
    const cs = await open(page);

    let dialog = false;
    page.on('dialog', async (d) => {
      dialog = true;
      await d.dismiss();
    });

    await cs.searchFor('<script>alert(1)</script>');

    expect(dialog, 'the payload must not execute').toBe(false);
    const planted = await page
      .locator('body script')
      .evaluateAll((els) => els.some((e) => /alert\(1\)/.test(e.textContent ?? '')));
    expect(planted, 'the payload must not be written into the page as markup').toBe(false);
  });

  // --- the three buttons, with nothing loaded -----------------------------

  /**
   * Save on the empty shell. The screen offers the button before a bill has
   * been opened, so the question is what it does with it: a culture report
   * filed against no patient, with no test, no pathologist and no antibiogram,
   * is a row in the database nobody can account for.
   */
  test('CS_N_11 Save with no report loaded files nothing and says so', async ({ page }) => {
    const cs = await open(page);
    const failures = watchForServerErrors(page);

    const enabled = await cs.saveButton.isEnabled().catch(() => false);
    console.log(`Save on the empty shell is ${enabled ? 'enabled' : 'disabled'}`);

    if (!enabled) {
      // A button that cannot be pressed is the right answer, and there is
      // nothing further to ask of it.
      expect(enabled).toBe(false);
      return;
    }

    await cs.clearSnackbars();
    await cs.saveButton.click();
    await page.waitForTimeout(8_000);

    const said = await cs.snackbars();
    said.forEach((m) => console.log(`snackbar after Save on an empty form: ${m}`));

    expect(
      said.join(' | '),
      'an empty form reported a saved report; there was no patient, no test and no result on it',
    ).not.toMatch(/success|saved|save finished/i);
    expect(failures, 'pressing Save on an empty form must not produce a server error').toEqual([]);
  });

  test('CS_N_12 Print with no report loaded produces no report', async ({ page }) => {
    const cs = await open(page);

    const enabled = await cs.printButton.isEnabled().catch(() => false);
    console.log(`Print on the empty shell is ${enabled ? 'enabled' : 'disabled'}`);
    if (!enabled) {
      expect(enabled).toBe(false);
      return;
    }

    const opening = page.waitForEvent('popup', { timeout: 20_000 }).catch(() => null);
    await cs.printButton.click();
    const popup = await opening;

    if (!popup) {
      console.log('no print tab opened, which is the right answer with nothing on the form');
      return;
    }

    const url = await cs.printedUrl(popup);
    const printed = await cs.readPrinted(url);
    console.log(`the print tab settled on ${url.slice(0, 60)}; ${printed ? `${printed.size} bytes` : 'nothing readable'}`);
    await cs.closePrintTab(popup);

    // A report of a patient who was never chosen is worse than no report. In a
    // headless run there is no PDF viewer and so nothing to read back, which
    // this reads as "nothing printed" rather than as a pass.
    expect(
      printed?.size ?? 0,
      'printing with no report on the form produced a document anyway',
    ).toBeLessThan(5_000);
  });

  test('CS_N_13 Finalize is not live until a report has been saved', async ({ page }) => {
    const cs = await open(page);

    const present = (await cs.finalizeButton.count()) > 0;
    const enabled = present ? await cs.finalizeButton.isEnabled() : false;
    console.log(
      `Finalize on the empty shell: ${present ? (enabled ? 'present and enabled' : 'present but disabled') : 'not on the page'}`,
    );

    expect(enabled, 'Finalize must not be live with no report on the screen to sign').toBe(false);
  });
});

test.describe('Microbiology (C/S) report — a report on the form', () => {
  // Each of these opens the screen, finds a bill and loads its report before it
  // can ask anything, and every step of that is a round trip over the circuit.
  test.describe.configure({ timeout: 420_000 });

  test('CS_N_14 opening a bill brings its patient and its invoice onto the form', async ({ page }) => {
    const cs = await open(page);
    const billNo = await openAnyPendingReport(cs);

    const patient = await cs.patientHeader();
    console.log(`${billNo} opened as ${patient.name} (invoice ${patient.invoiceNo})`);

    expect(patient.invoiceNo, 'the form loaded a different bill from the row that was clicked').toBe(billNo);
    expect(patient.name, 'the report loaded without a patient on it').not.toBe('');
  });

  test('CS_N_15 the Test Name list offers the bill\'s own culture tests', async ({ page }) => {
    const cs = await open(page);
    const billNo = await openAnyPendingReport(cs);

    const offered = await cs.dropdownRows('Test Name');
    console.log(`Test Name offers ${offered.length} row(s): ${offered.join(' | ')}`);
    expect(
      offered.length,
      `${billNo} is on the Pending tab, so it must carry at least one culture test to report on`,
    ).toBeGreaterThan(0);

    const taken = await cs.selectTest();
    console.log(`took "${taken}"; the specimen reads "${(await cs.patientHeader()).specimen}"`);

    expect(await cs.selected('Test Name'), 'the test did not stick').toContain(taken);
    expect(
      (await cs.patientHeader()).invoiceNo,
      'picking a test moved the form off the bill it was opened on',
    ).toBe(billNo);
  });

  test('CS_N_16 no growth builds no antibiogram, and a growth builds one', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);
    await cs.selectTest();

    // Nothing grew, so there is nothing to be sensitive to: the screen should
    // offer no sensitivity panel at all.
    await cs.setCultureResult('NG');
    await page.waitForTimeout(6_000);
    const underNg = await cs.antibiogramRows.count();
    console.log(`CULTURE RESULT NG: ${underNg} antibiogram row(s)`);

    await cs.setCultureResult('G');
    await cs.waitForAntibiogram();
    const underG = await cs.antibiogramRows.count();
    console.log(`CULTURE RESULT G: ${underG} antibiogram row(s)`);

    expect(underNg, 'an antibiogram under "no growth" is a sensitivity against nothing').toBe(0);
    expect(underG, 'a growth has to offer an antibiogram to record it on').toBeGreaterThan(0);
  });

  /**
   * A column of the antibiogram belongs to an organism, and it stays shut until
   * that organism has been isolated. This is the rule the whole grid rests on:
   * forty antibiotics appear as soon as a growth is recorded, and all three of
   * their columns are disabled — there is nothing yet for a sensitivity to be
   * against. Naming the organism in A opens A, and only A.
   */
  test('CS_N_17 an antibiogram column opens only once its organism is isolated', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);
    await cs.selectTest();
    await cs.setCultureResult('G');
    await cs.waitForAntibiogram();

    const openIn = (grid: Antibiotic[], column: 'A' | 'B' | 'C') =>
      grid.filter((a) => a.cells[column].id && !a.cells[column].disabled).length;

    const before = await cs.antibiotics();
    console.log(
      `${before.length} antibiotic(s) before an organism is named: ` +
        `A open on ${openIn(before, 'A')}, B on ${openIn(before, 'B')}, C on ${openIn(before, 'C')}`,
    );
    expect(
      openIn(before, 'A') + openIn(before, 'B') + openIn(before, 'C'),
      'a sensitivity can be recorded against an organism nobody has named',
    ).toBe(0);

    const organism = await cs.selectNamed('Organism Isolated A');
    const after = await cs.antibiotics();
    console.log(
      `after isolating "${organism}": A open on ${openIn(after, 'A')}, ` +
        `B on ${openIn(after, 'B')}, C on ${openIn(after, 'C')}`,
    );

    expect(
      openIn(after, 'A'),
      `"${organism}" was isolated in A, so column A has to open for its sensitivities`,
    ).toBe(after.length);
    expect(
      openIn(after, 'B') + openIn(after, 'C'),
      'B and C belong to a second and third organism, neither of which has been isolated',
    ).toBe(0);
  });

  test('CS_N_18 an antibiogram cell takes nothing but S, R and I', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);
    await cs.selectTest();
    await cs.setCultureResult('G');
    await cs.waitForAntibiogram();
    // The cells are disabled until the organism they are reporting on has been
    // named; see CS_N_17.
    await cs.selectNamed('Organism Isolated A');

    const cell = (await cs.antibiotics()).find((a) => a.cells.A.id && !a.cells.A.disabled);
    expect(cell, 'the antibiogram has no cell open to type into').toBeTruthy();

    const sensible = await cs.typeSensitivity(cell!.cells.A.id, 'S');
    console.log(`"S" at ${cell!.name} offered ${JSON.stringify(sensible.offered)}`);
    expect(sensible.offered, 'the cell should offer the sensitivity that was typed').toContain('S');

    const nonsense = await cs.typeSensitivity(cell!.cells.A.id, 'X');
    console.log(`"X" at ${cell!.name} offered ${JSON.stringify(nonsense.offered)}, cell holds "${nonsense.held}"`);

    expect(
      nonsense.offered.filter((o) => !/^[SRI]$/.test(o)),
      'a sensitivity is S, R or I; the cell offered something else',
    ).toEqual([]);
    expect(
      nonsense.held,
      'a letter typed and never chosen must not be left in the cell looking like a result',
    ).toBe('');
  });

  test('CS_N_19 closing the Pathologist list without choosing changes nothing', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);

    const before = await cs.selected('Pathologist');
    const rows = await cs.dropdownRows('Pathologist', 'ZZQXNOTAPATHOLOGIST');
    console.log(`the Pathologist list answers a name nobody has with ${rows.length} row(s): ${JSON.stringify(rows)}`);

    // Whatever the list offered, nothing was clicked, so nobody has been put
    // down as having signed this report. See CS_B_04 for what it offered.
    expect(
      await cs.selected('Pathologist'),
      'opening and closing the list without choosing anything changed who signs the report',
    ).toBe(before);
  });

  /**
   * CS_B_04: the Pathologist panel has a Search box, and it filters nothing.
   * "ZZQXNOTAPATHOLOGIST" comes back with all ten pathologists, and so does
   * "PROF." — the box takes what is typed and hands back the same list either
   * way.
   *
   * That is worse than a cosmetic fault on a panel whose rows are picked by
   * clicking the first one: `selectFromDropdown(label, match)` types `match`
   * into this box and then takes the top row, so a caller that asks for a
   * particular pathologist by name gets whoever happens to be listed first,
   * with nothing on screen to say so. The same box sits over the Technologist
   * and Test Name lists.
   */
  test.fail('CS_B_04 the Pathologist search box filters on what is typed into it', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);

    const all = await cs.dropdownRows('Pathologist');
    expect(all.length, 'the Pathologist list is empty, so there is nothing to filter').toBeGreaterThan(0);

    const none = await cs.dropdownRows('Pathologist', 'ZZQXNOTAPATHOLOGIST');
    console.log(`the list holds ${all.length} pathologist(s); a name nobody has returns ${none.length}`);

    expect(
      none.filter((r) => !/no record|no data|not found/i.test(r)),
      'a name nobody is on the list under should match nothing',
    ).toEqual([]);
  });

  test('CS_N_20 a C/S message typed and never chosen is not left in the box', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);

    const { offered, held } = await cs.csMessageSuggestions('ZZQXNOTAMESSAGE');
    console.log(`the C/S Message list offered ${offered.length} line(s); the box holds "${held}"`);

    // The report carries this line as written, so text nobody picked off the
    // list must not be left behind looking like a message that was chosen.
    expect(
      held,
      'text that matched no message was left in the box looking like a message somebody chose',
    ).toBe('');
  });

  /**
   * CS_B_05: the C/S Message autocomplete ignores what is typed into it. Ten
   * lines come back for "Salmonella", the same ten come back for
   * "ZZQXNOTAMESSAGE", and they are the same ten the empty box offers — the
   * first ten of the list, whatever was asked for.
   *
   * The line this box fills in is the report's conclusion, so a lab looking for
   * "no growth" has to read the whole list to find it, and
   * `pickCsMessage(query, match)` only works at all because it matches the
   * suggestion text itself rather than trusting the filtering.
   */
  test.fail('CS_B_05 the C/S Message list offers only messages matching what was typed', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);

    const nonsense = await cs.csMessageSuggestions('ZZQXNOTAMESSAGE');
    nonsense.offered.forEach((m) => console.log(`  offered for a phrase nobody wrote: ${m}`));

    expect(nonsense.offered, 'a message nobody wrote should match nothing').toEqual([]);
  });

  test('CS_N_21 the organism and colony lists offer real values and keep what they are given', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);
    await cs.selectTest();
    await cs.setCultureResult('G');
    await cs.waitForAntibiogram();

    for (const label of ['Organism Isolated A', 'Colony Count', 'Colony Count B']) {
      const options = await cs.namedOptions(label);
      const usable = options.filter((o) => !MicrobiologyReportPage.isPlaceholder(o.text));
      console.log(`${label}: ${options.length} option(s), ${usable.length} of them real`);

      expect(
        usable.length,
        `"${label}" offers nothing but placeholders: ${options.map((o) => `"${o.text}"`).join(', ')}`,
      ).toBeGreaterThan(0);

      const taken = await cs.selectNamed(label);
      expect(await cs.namedValue(label), `"${label}" did not keep "${taken}"`).toBe(taken);
    }
  });

  test('CS_N_22 a culture medium ticked by mistake can be cleared again', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);

    const media = await cs.media();
    console.log(`culture media on offer: ${media.map((m) => `${m.name}=${m.checked}`).join(', ')}`);
    expect(media.length, 'the form lists no media for a plate to be grown on').toBeGreaterThan(0);

    const was = media[0].checked;
    const seen = await cs.retickMedium(0);
    console.log(`${media[0].name}: ticked ${seen[0]} -> cleared ${seen[1]} -> ticked ${seen[2]}`);
    expect(seen, `${media[0].name} did not follow the tick-clear-tick it was given`).toEqual([true, false, true]);

    // Put it back as it was found; nothing here is saved, but the next test
    // reads the same form.
    await cs.setMedium(0, was);
    expect((await cs.media())[0].checked, `${media[0].name} was not left as it was found`).toBe(was);
  });

  test('CS_N_23 the note box holds what is typed into it, and empties again', async ({ page }) => {
    const cs = await open(page);
    await openAnyPendingReport(cs);

    const was = await cs.note.inputValue();
    const typed = 'Automation check of the note box; nothing typed here is saved.';

    await cs.setNote(typed);
    expect(await cs.note.inputValue(), 'the note box dropped what was typed into it').toBe(typed);

    await cs.setNote('');
    expect(await cs.note.inputValue(), 'the note box cannot be emptied again').toBe('');

    await cs.setNote(was);
    console.log(`the note box was left holding "${was}"`);
  });

  /**
   * How much the note box will take. It is a single-line input on a clinical
   * report, and whatever it accepts here is what a column somewhere has to
   * hold: a box with no limit at all is a truncation or a 500 waiting to
   * happen. This reports the limit rather than asserting one, and holds the
   * screen to surviving the paste.
   */
  test('CS_N_24 a note longer than the box should take is handled, not swallowed', async ({ page }) => {
    const cs = await open(page);
    const billNo = await openAnyPendingReport(cs);
    const failures = watchForServerErrors(page);

    const was = await cs.note.inputValue();
    await cs.note.fill('N'.repeat(2_000));
    await page.waitForTimeout(2_000);
    const held = (await cs.note.inputValue()).length;

    const declared = await cs.note.getAttribute('maxlength');
    console.log(`2000 characters pasted into the note; the box holds ${held} (maxlength=${declared ?? 'none'})`);

    expect(failures, 'a long note must not produce a server error').toEqual([]);
    expect(
      (await cs.patientHeader()).invoiceNo,
      'a long note knocked the form off the bill it was opened on',
    ).toBe(billNo);

    await cs.setNote(was);
  });

  test('CS_N_25 opening a second bill replaces the first one\'s report', async ({ page }) => {
    const cs = await open(page);
    await cs.searchFor('');
    const bills = await cs.bills();
    test.skip(
      bills.length < 2,
      `switching between bills needs two on the Pending tab; it is offering ${bills.length}`,
    );

    await cs.openBill(bills[0]);
    const first = await cs.patientHeader();
    const firstTest = await cs.selectTest();
    console.log(`${bills[0]}: ${first.name}, test "${firstTest}"`);

    await cs.openBill(bills[1]);
    const second = await cs.patientHeader();
    console.log(`${bills[1]}: ${second.name}, Test Name now reads "${await cs.selected('Test Name')}"`);

    expect(second.invoiceNo, 'the second bill did not load').toBe(bills[1]);
    expect(
      second.invoiceNo,
      `the form is still showing ${first.invoiceNo} after ${bills[1]} was opened`,
    ).not.toBe(first.invoiceNo);
    expect(second.name, 'the second bill loaded without a patient on it').not.toBe('');
  });

  test('CS_N_26 a bill under Done opens its report, already signed off', async ({ page }) => {
    const cs = await open(page);

    await cs.selectTab('Done');
    await cs.searchFor('');
    const bills = await cs.bills();
    test.skip(
      bills.length === 0,
      `no finalized report under Done over the last ${data.daysBack} day(s) to read`,
    );

    await cs.openBill(bills[0]);
    const patient = await cs.patientHeader();
    console.log(`Done bill ${bills[0]} opened as ${patient.name}`);
    expect(patient.invoiceNo, 'the form loaded a different bill from the row that was clicked').toBe(bills[0]);

    const present = (await cs.finalizeButton.count()) > 0;
    const enabled = present ? await cs.finalizeButton.isEnabled() : false;
    console.log(`Finalize on a report already signed off: ${enabled ? 'still live' : 'not offered'}`);

    expect(enabled, 'a report that has already been signed off must not offer to be signed off again').toBe(
      false,
    );
  });
});
