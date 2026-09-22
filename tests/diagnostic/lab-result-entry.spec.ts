import { test, expect, investigations } from '../../fixtures/test';
import { LabResultEntryPage } from '../../pages/LabResultEntryPage';

const data = investigations.labResultEntry;

/**
 * LAB Result Entry — the results themselves.
 *
 * The invoice is found by number on the Pending tab and its report opened from
 * the tree. Every result on it is then filled: 1, 2, 3 … down the typed fields,
 * and a value off the list for each of the rest. A technologist is named, the
 * report is saved, and the invoice is looked up again on the Done tab to
 * confirm the tests came through with the results still on them.
 *
 * Saving writes a clinical record against a real patient and this screen offers
 * no way back, so `LAB_RESULT_SAVE=0` stops the run at the filled form. Without
 * the save there is nothing on the Done tab to check, and the second half of
 * the test is skipped with it.
 */
const SHOULD_SAVE = process.env.LAB_RESULT_SAVE !== '0';

test.describe('LAB result entry', () => {
  test('enters every result, names a technologist, saves, and finds it under Done', async ({ page }) => {
    // Forty-odd results, each its own round trip over the circuit, then the
    // whole report read back twice.
    test.setTimeout(600_000);

    const results = new LabResultEntryPage(page);
    await results.goto();
    await results.recordSnackbars();

    // A window wide enough to cover the invoice whenever it was raised.
    const from = new Date();
    from.setDate(from.getDate() - data.daysBack);
    await results.setDateRange(from, new Date());

    await results.selectTab('Pending');
    await results.searchByInvoice(data.invoiceNo);
    console.log(`pending ${await results.tabCount('Pending')}, done ${await results.tabCount('Done')}`);

    await results.openInvoice(data.invoiceNo);

    const departments = await results.departments();
    const tests = await results.testHeadings();
    console.log(`departments: ${departments.join(', ')}`);
    tests.forEach((t) => console.log(`  test: ${t}`));
    expect(tests.length, 'the report names no tests').toBeGreaterThan(0);

    // --- every result on the report ---
    const entered = await results.fillEveryResult();
    const typed = entered.filter((e) => e.kind === 'text');
    const picked = entered.filter((e) => e.kind === 'select');
    console.log(`filled ${typed.length} typed field(s) and chose ${picked.length} from a list`);
    departments.forEach((d) =>
      console.log(`  ${d}: ${entered.filter((e) => e.department === d).length} result(s)`),
    );

    // Typed results are 1, 2, 3 … across the whole report.
    expect(typed.map((e) => e.value)).toEqual(typed.map((_, i) => String(i + 1)));
    // Nothing was left blank.
    expect(entered.filter((e) => e.value === '')).toEqual([]);

    // --- the technologist ---
    const technologist = await results.selectTechnologist();
    console.log(`technologist: ${technologist}`);
    expect(technologist).not.toEqual('');
    expect(await results.selectedTechnologist()).toContain(technologist);

    await page.screenshot({ path: 'test-results/lab-result-entry-filled.png', fullPage: true });

    test.skip(!SHOULD_SAVE, 'LAB_RESULT_SAVE=0: stopping before the result is saved');

    // --- save ---
    await results.clearSnackbars();
    await results.save();
    const said = await results.snackbarsMatching(/save|success/i);
    said.forEach((m) => console.log(`snackbar: ${m}`));
    await page.screenshot({ path: 'test-results/lab-result-entry-saved.png', fullPage: true });

    // --- and again, under Done ---
    await results.selectTab('Done');
    await results.searchByInvoice(data.invoiceNo);
    console.log(`after saving: pending ${await results.tabCount('Pending')}, done ${await results.tabCount('Done')}`);

    await results.openInvoice(data.invoiceNo);

    const doneTests = await results.testHeadings();
    doneTests.forEach((t) => console.log(`  done test: ${t}`));

    // Every test that was given results is listed under Done.
    tests.forEach((name) =>
      expect(doneTests, `"${name}" is missing from the report under Done`).toContain(name),
    );

    // And the results themselves came through, not just the test names.
    const saved = await results.fields();
    const savedValues = saved.map((f) => f.value);
    typed.forEach((e) =>
      expect(savedValues, `typed result "${e.value}" is not on the saved report`).toContain(e.value),
    );
    console.log(`Done report carries ${saved.length} result(s) across ${(await results.departments()).length} department(s)`);

    await page.screenshot({ path: 'test-results/lab-result-entry-done.png', fullPage: true });
  });
});
