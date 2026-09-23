import { test, expect, investigations } from '../../fixtures/test';
import { MicrobiologyReportPage, seededRandom } from '../../pages/MicrobiologyReportPage';

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
