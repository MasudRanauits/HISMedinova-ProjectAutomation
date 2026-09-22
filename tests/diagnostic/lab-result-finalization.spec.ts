import { test, expect, investigations } from '../../fixtures/test';
import { LabResultFinalizationPage } from '../../pages/LabResultFinalizationPage';

const data = investigations.labResultFinalization;

/**
 * Lab Result Finalization, as the pathologist.
 *
 * Reached through the Diagnostic menu rather than by its route, because the
 * menu is built from the signed-in account's permissions and arriving that way
 * is what proves this account can get to the screen at all.
 *
 * The invoice is then found on the Pending tab inside a date range and checked
 * to be the one asked for — the box filters rather than selects, so a near miss
 * would otherwise be opened without anyone noticing. Two of one test's results
 * are corrected, any list left without a result is given one, a remark goes
 * against every test, the technologist is changed, and the report is saved.
 *
 * `LAB_FINALIZE_SAVE=0` stops before the save.
 */
const SHOULD_SAVE = process.env.LAB_FINALIZE_SAVE !== '0';

test.describe('Lab result finalization', () => {
  test('corrects results, remarks on every test, changes the technologist, and saves once', async ({
    page,
  }) => {
    // The report is forty-odd results plus a remark per test, each its own round
    // trip, and reading it back is a walk of the whole document. Ten minutes was
    // not enough to reach the save.
    test.setTimeout(1_200_000);

    const finalize = new LabResultFinalizationPage(page);
    await finalize.gotoViaMenu();
    await finalize.recordSnackbars();

    const from = new Date();
    from.setDate(from.getDate() - data.daysBack);
    await finalize.setDateRange(from, new Date());

    await finalize.selectTab('Pending');
    await finalize.searchByInvoice(data.invoiceNo);
    console.log(`pending ${await finalize.tabCount('Pending')}, done ${await finalize.tabCount('Done')}`);

    // --- it is the invoice that was asked for, and only it ---
    const matches = await finalize.invoiceRowCount(data.invoiceNo);
    if (matches !== 1) {
      // Worth the extra look: a finalized invoice leaves Pending for good, so
      // this is nearly always a spent invoice rather than a missing one.
      const listedUnder = await finalize.locateInvoice(data.invoiceNo);
      expect(
        matches,
        listedUnder === 'Done'
          ? `invoice ${data.invoiceNo} is not on the Pending tab — it is under Done, so its report has already ` +
            `been finalized, and a finalized report cannot be finalized again. Run the chain from 1-register for ` +
            `a fresh invoice, then 7-result-entry to give it results.`
          : `invoice ${data.invoiceNo} is on neither tab for the last ${data.daysBack} day(s). It only reaches ` +
            `this screen once its results have been saved on LAB Result Entry, so run 7-result-entry first — or ` +
            `widen labResultFinalization.daysBack if the invoice is older than that.`,
      ).toBe(1);
    }
    const listed = await finalize.listedInvoiceNo(data.invoiceNo);
    expect(listed, 'the row on screen is not the invoice that was searched for').toContain(data.invoiceNo);
    console.log(`pending row reads "${listed}"`);

    await finalize.openInvoice(data.invoiceNo);

    // --- two of this test's results ---
    const before = await finalize.fieldsOfTest(data.test);
    const typed = before.filter((f) => f.kind === 'text');
    console.log(`${typed[0].test}: ${typed.length} typed result(s), currently ${typed.map((f) => `"${f.value}"`).join(', ')}`);
    expect(
      typed.length,
      `changing ${data.newResults.length} results needs at least that many on "${data.test}"`,
    ).toBeGreaterThanOrEqual(data.newResults.length);

    for (let i = 0; i < data.newResults.length; i++) {
      const field = finalize.field(typed[i].id);
      await field.scrollIntoViewIfNeeded();
      await field.fill(data.newResults[i]);
      await page.waitForTimeout(400);
      await expect(field).toHaveValue(data.newResults[i]);
      console.log(`  result ${i + 1}: "${typed[i].value}" -> "${data.newResults[i]}"`);
    }

    // --- lists left without a result ---
    const repaired = await finalize.replacePlaceholderSelections();
    repaired.forEach((r) => console.log(`  placeholder on ${r.test}: "${r.from}" -> "${r.to}"`));
    console.log(`gave a result to ${repaired.length} list(s) that had none`);

    // One read of the report answers both questions: nothing is left reading as
    // unfilled, and nothing outside the two results changed. Reading it is a
    // walk of the whole document, so it is done once rather than per check.
    const after = await finalize.fields();

    const stillBlank = after.filter((f) => f.kind === 'select' && /^(|\.{2,}|-+)$/.test(f.value));
    expect(
      stillBlank.map((f) => `${f.test}:${f.id}`),
      'some lists are still sitting on a placeholder instead of a result',
    ).toEqual([]);

    // The rest of that test is left alone — bar any list this spec has just
    // given a result to.
    const repairedIds = repaired.map((r) => r.id);
    before
      .slice(data.newResults.length)
      .filter((f) => !repairedIds.includes(f.id))
      .forEach((f) =>
        expect(
          after.find((a) => a.id === f.id)?.value,
          `result ${f.id} was not being changed but has moved`,
        ).toBe(f.value),
      );

    // --- a remark against every test ---
    const words = data.comment.trim().split(/\s+/);
    expect(words, `the comment should be ten words; "${data.comment}" has ${words.length}`).toHaveLength(10);

    const commented = await finalize.fillComments(data.comment);
    console.log(`wrote the remark into ${commented.length} comment box(es): "${data.comment}"`);

    const remarks = await finalize.comments();
    remarks.forEach((c) => console.log(`  ${c.label}: "${c.value}"`));
    expect(remarks.map((c) => c.value)).toEqual(remarks.map(() => data.comment));

    // --- a different technologist ---
    const technologist = await finalize.changeTechnologist();
    console.log(`technologist: "${technologist.from}" -> "${technologist.to}"`);
    expect(technologist.to).not.toEqual('');
    expect(technologist.to.toUpperCase()).not.toEqual(technologist.from.toUpperCase());
    expect(await finalize.selectedTechnologist()).toContain(technologist.to);

    await page.screenshot({ path: 'test-results/lab-result-finalization-edited.png', fullPage: true });

    test.skip(!SHOULD_SAVE, 'LAB_FINALIZE_SAVE=0: stopping before the report is saved');

    // --- save, and make sure a second press cannot save it twice ---
    await finalize.clearSnackbars();
    await finalize.save();
    const firstSaid = await finalize.snackbarsMatching(/save|success/i);
    firstSaid.forEach((m) => console.log(`snackbar after the first save: ${m}`));
    expect(firstSaid.join(' | '), 'the first save was not acknowledged').toMatch(/save|success/i);

    await page.screenshot({ path: 'test-results/lab-result-finalization-saved.png', fullPage: true });

    // Press it again straight away. A screen that guards against a double save
    // either disables the button once the report is in, or refuses the second
    // press; what it must not do is file the same report twice.
    const stillEnabled = await finalize.saveButton.isEnabled().catch(() => false);
    console.log(`Save still enabled after saving: ${stillEnabled}`);

    await finalize.clearSnackbars();
    if (stillEnabled) {
      await finalize.save();
      const secondSaid = await finalize.snackbarsMatching(/save|success|already|cannot/i, 10_000);
      secondSaid.forEach((m) => console.log(`snackbar after the second save: ${m}`));
    }

    // The report must be filed once, whatever the button allowed.
    await finalize.selectTab('Done');
    await finalize.searchByInvoice(data.invoiceNo);
    const doneRows = await finalize.invoiceRowCount(data.invoiceNo);
    console.log(`Done tab lists ${doneRows} row(s) for ${data.invoiceNo}`);
    expect(
      doneRows,
      `pressing Save twice filed ${data.invoiceNo} ${doneRows} times; it should appear once under Done`,
    ).toBe(1);

    await page.screenshot({ path: 'test-results/lab-result-finalization-done.png', fullPage: true });
  });
});
