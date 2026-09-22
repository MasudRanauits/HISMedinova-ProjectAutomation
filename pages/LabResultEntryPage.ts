import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { clearSnackbars, readSnackbars, recordSnackbars, waitForSnackbar } from '../utils/snackbars';

/** One result field on the report, as the form renders it. */
export type ResultField = {
  /** The field's own id — `edit-text-<guid>` for a typed result. */
  id: string;
  /** A typed result, or one picked from a fixed list. */
  kind: 'text' | 'select';
  department: string;
  /** The test the field belongs to, named as the report heads it, e.g.
   * "SERUM LIPID PROFILE (FASTING) - 165847". */
  test: string;
  value: string;
};

export type ResultTab = 'Pending' | 'Done';

/** A result as a spec entered it, kept so it can be checked again later. */
export type EnteredResult = ResultField;

const pad = (n: number) => String(n).padStart(2, '0');
/** The pickers on this screen read and write DD-MM-YYYY. */
export const asPickerDate = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

/**
 * Entries that fill a list but say nothing — a blank, an ellipsis, a "choose
 * one" prompt. Selecting one of these is worse than leaving the field alone:
 * it overwrites whatever the lab put there with a value that reads as unfilled.
 * The Occult Blood test lists open with "Not Done" and offer "..." straight
 * after it, which is exactly how a real result gets replaced by nothing.
 */
const PLACEHOLDER_OPTION = /^(|\.{2,}|-+|select( one)?\.*|choose.*|n\/?a)$/i;

/**
 * Entries that are a real state but not a finding. They are worth picking only
 * when a list offers nothing better, so that a test asked to record a result
 * records one rather than settling for "nothing was done".
 */
const NOT_A_FINDING = /^(not\s*done|nil|none)$/i;

/**
 * LAB Result Entry (/diagnosis/pathology-result-entry).
 *
 * The sidebar calls it "LAB Result Entry" while the route keeps an older
 * "pathology" name — they are the same screen. An invoice reaches the Pending
 * tab once its samples have been acknowledged in the lab, and leaves for Done
 * when its results are saved.
 *
 * ## Why Lab Result Finalization extends this
 *
 * The pathologist's screen is this screen twice over: the same two panels, the
 * same Pending/Done tabs, the same report. The two differ only in their route,
 * in the prefix the app gives the filter boxes (`prse-` here, `lrfp-` there),
 * and in what the buttons underneath the report do. So `LabResultFinalization`
 * subclasses this one and adds just those differences, rather than either
 * screen carrying its own copy of everything below.
 *
 * Two panels. On the left, a date range, an invoice box and a Show button feed
 * a Pending/Done pair of tabs, each holding a tree of invoices. Opening one
 * loads its whole report on the right: every test the invoice carries, laid out
 * department by department.
 *
 * ## Finding the fields of a department or a test
 *
 * The report is flat markup, not one container per section: a department is
 * announced by an `<h2>` inside a `<label class="form-label">`, a test by a
 * bare line of text reading "NAME - LABNO", and each simply runs until the next
 * one. Nothing wraps either, so their fields cannot be reached by descending
 * into them. They are found instead by reading the report in document order and
 * attributing each field to the last department and test seen above it — the
 * same thing a person does going down the page. The ids that come back are
 * ordinary ids, so everything after that is a plain locator with Playwright
 * doing its usual waiting.
 */
export class LabResultEntryPage {
  readonly page: Page;
  /** The screen's own route. Finalization points this at its own. */
  protected readonly route: string = ROUTES.labResultEntry;
  readonly search: Locator;
  readonly startDate: Locator;
  readonly endDate: Locator;
  readonly invoiceNo: Locator;
  readonly showButton: Locator;
  readonly groupSearch: Locator;
  readonly grid: Locator;
  readonly saveButton: Locator;
  readonly clearFormButton: Locator;

  /**
   * `idPrefix` names the filter boxes: the app calls them `prse-search` and
   * `prse-invoiceno` here, `lrfp-…` on finalization. Everything else on the two
   * screens is addressed the same way.
   */
  constructor(page: Page, idPrefix: string = 'prse') {
    this.page = page;

    this.search = page.locator(`#${idPrefix}-search`);
    this.invoiceNo = page.locator(`#${idPrefix}-invoiceno`);

    // flatpickr keeps a hidden original input beside the visible alternate one.
    this.startDate = page.locator('input.input.form-control[placeholder="Start Date"]');
    this.endDate = page.locator('input.input.form-control[placeholder="End Date"]');

    this.showButton = page.getByRole('button', { name: /^show$/i });
    this.groupSearch = page.locator('input[placeholder^="Search group"]');
    this.grid = page.locator('.sidebar-tabs table').first();

    this.saveButton = page.getByRole('button', { name: /^save$/i });
    this.clearFormButton = page.getByRole('button', { name: /clear form/i });
  }

  async goto() {
    await this.page.goto(this.route);
    await expect(this.invoiceNo).toBeVisible({ timeout: 60_000 });
    await expect(this.showButton).toBeVisible({ timeout: 60_000 });
  }

  /** flatpickr only commits a typed date on Enter. */
  private async setDate(input: Locator, value: string) {
    await input.click();
    await input.fill('');
    await input.pressSequentially(value, { delay: 60 });
    await this.page.keyboard.press('Enter');
    await expect(input).toHaveValue(value);
  }

  async setDateRange(from: Date, to: Date) {
    await this.setDate(this.startDate, asPickerDate(from));
    await this.setDate(this.endDate, asPickerDate(to));
  }

  tab(name: ResultTab): Locator {
    return this.page.locator('.sidebar-tabs a.nav-link').filter({ hasText: new RegExp(`^${name}`, 'i') }).first();
  }

  async selectTab(name: ResultTab) {
    await this.tab(name).click();
    await this.page.waitForTimeout(3_000);
  }

  /** The count in a tab's badge — how many invoices it is offering. */
  async tabCount(name: ResultTab): Promise<number> {
    const text = await this.tab(name).innerText();
    return Number(text.replace(/\D/g, '') || 0);
  }

  /** Puts an invoice number in the box and re-queries. */
  async searchByInvoice(invoiceNo: string) {
    await this.invoiceNo.fill(invoiceNo);
    await this.page.waitForTimeout(1_500);
    await this.showButton.click();
    await this.page.waitForTimeout(8_000);
  }

  invoiceRow(invoiceNo: string): Locator {
    return this.grid.locator('tbody tr').filter({ hasText: invoiceNo }).first();
  }

  /**
   * Which tab an invoice is listed under, or null if neither has it.
   *
   * Used to explain a missing row. An invoice absent from Pending has usually
   * been dealt with already rather than gone astray, and saying which list it
   * did turn up in is the difference between a puzzle and an answer. It leaves
   * the tab it found the invoice under selected.
   */
  async locateInvoice(invoiceNo: string): Promise<ResultTab | null> {
    for (const tab of ['Pending', 'Done'] as const) {
      await this.selectTab(tab);
      await this.searchByInvoice(invoiceNo);
      if (await this.invoiceRow(invoiceNo).isVisible()) return tab;
    }
    return null;
  }

  /** How many rows the current tab is showing for an invoice number. */
  async invoiceRowCount(invoiceNo: string): Promise<number> {
    return this.grid.locator('tbody tr').filter({ hasText: invoiceNo }).count();
  }

  /** The tab currently on show. */
  async activeTab(): Promise<string> {
    const text = await this.page.locator('.sidebar-tabs a.nav-link.active').first().innerText();
    return text.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Opens an invoice's report.
   *
   * The invoice number sits in a tree node rather than a plain cell, and it is
   * the node's own title that is clickable — the row around it does nothing.
   */
  async openInvoice(invoiceNo: string) {
    const row = this.invoiceRow(invoiceNo);

    const found = await row
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    expect(
      found,
      `invoice ${invoiceNo} is not in the ${await this.activeTab()} list for ` +
        `${await this.startDate.inputValue()}..${await this.endDate.inputValue()}. A result can only be entered ` +
        `once the invoice's samples have been acknowledged in the lab, so an invoice that has not been through ` +
        `sample collection, dispatch and acknowledgement never appears under Pending; one whose results have been ` +
        `saved has moved to Done.`,
    ).toBe(true);

    await row.locator('.b-tree-view-node-title span').first().click();

    // The report is built department by department over the circuit; the first
    // heading showing up is what says it has started arriving.
    await expect(this.departmentHeadings.first()).toBeVisible({ timeout: 90_000 });
    await this.page.waitForTimeout(4_000);
  }

  /** The department headings on the loaded report. */
  get departmentHeadings(): Locator {
    return this.page.locator('label.form-label h2');
  }

  async departments(): Promise<string[]> {
    return (await this.departmentHeadings.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  }

  /**
   * Every result field on the report, tagged with the department it falls under.
   *
   * Read in document order: a `<h2>` inside a `form-label` opens a department
   * and everything after it belongs to that department until the next one. The
   * page's own title is an `<h2>` as well, but it is not inside a `form-label`,
   * so the filter panel's inputs above the report are left unattributed and
   * dropped.
   */
  async fields(): Promise<ResultField[]> {
    return this.page.evaluate(() => {
      /** The text a node owns itself, ignoring anything its children carry. */
      const ownText = (el: Element) =>
        Array.prototype.slice
          .call(el.childNodes)
          .filter((n: any) => n.nodeType === 3)
          .map((n: any) => n.textContent.trim())
          .join(' ')
          .trim();

      const out: ResultField[] = [];
      let department = '';
      let currentTest = '';

      // One pass down the document: headings set the section, fields join it.
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      for (let node = walk.nextNode() as any; node; node = walk.nextNode() as any) {
        // Only a heading dressed as a field label opens a department; the page
        // title is an <h2> as well and must not be taken for one.
        if (node.tagName === 'H2' && node.closest('label.form-label')) {
          department = node.innerText.replace(/\s+/g, ' ').trim();
          continue;
        }

        // A test is headed by a bare "NAME - LABNO" line, not by any tag.
        const own = ownText(node);
        if (/^.+\s[-–]\s\d{5,}$/.test(own)) {
          currentTest = own;
          continue;
        }

        const isField =
          node.matches?.('input.form-control.form-control-sm') || node.matches?.('select.form-select');
        if (!isField || !department || !node.id) continue;

        out.push({
          id: node.id,
          kind: node.tagName === 'SELECT' ? 'select' : 'text',
          department,
          test: currentTest,
          value: node.value ?? '',
        });
      }

      return out;
    });
  }

  /** The fields of one test, matched on any part of its heading. */
  async fieldsOfTest(test: string): Promise<ResultField[]> {
    const wanted = test.toUpperCase();
    const matching = (await this.fields()).filter((f) => f.test.toUpperCase().includes(wanted));

    expect(
      matching.length,
      `the report carries no test matching "${test}". Tests on it: ` +
        `${(await this.testHeadings()).join(' | ') || '(none)'}`,
    ).toBeGreaterThan(0);

    return matching;
  }

  /** The fields of one department, matched on the heading, case-insensitively. */
  async fieldsOf(department: string): Promise<ResultField[]> {
    const wanted = department.toUpperCase();
    return (await this.fields()).filter((f) => f.department.toUpperCase() === wanted);
  }

  /**
   * One result field by id.
   *
   * Addressed by attribute rather than as `#id`: a typed result carries a tidy
   * `edit-text-<guid>`, but the fixed lists are named by the circuit and those
   * ids start with a digit — `#0HNON06J1OCVG` is not a selector CSS will parse.
   */
  field(id: string): Locator {
    return this.page.locator(`[id="${id}"]`);
  }

  /**
   * Types `values` into one department's typed fields, in the order they appear
   * on screen, and leaves every other department alone.
   *
   * Returns the ids written to. Fields offering a fixed list are skipped —
   * there is nothing to type into them — so a department of those comes back
   * empty rather than half-filled.
   */
  async fillDepartment(department: string, values: string[]): Promise<string[]> {
    const typed = (await this.fieldsOf(department)).filter((f) => f.kind === 'text');

    expect(
      typed.length,
      `the report has no typed result fields under "${department}". Departments on this report: ` +
        `${(await this.departments()).join(', ') || '(none)'}`,
    ).toBeGreaterThan(0);

    const written: string[] = [];

    for (let i = 0; i < typed.length && i < values.length; i++) {
      const input = this.field(typed[i].id);
      await input.scrollIntoViewIfNeeded();
      await input.fill(values[i]);
      // Each result round-trips over the circuit; let it land before the next.
      await this.page.waitForTimeout(400);
      await expect(input).toHaveValue(values[i]);
      written.push(typed[i].id);
    }

    return written;
  }

  /** `fillDepartment` with 1, 2, 3 … — one number per typed field. */
  async numberDepartment(department: string): Promise<string[]> {
    const typed = (await this.fieldsOf(department)).filter((f) => f.kind === 'text');
    return this.fillDepartment(
      department,
      Array.from({ length: typed.length }, (_, i) => String(i + 1)),
    );
  }

  /**
   * The name and lab number heading each test on the report, e.g.
   * "SERUM LIPID PROFILE (FASTING) - 165834".
   *
   * These are plain text, not a tagged element, so they are read as the text a
   * node owns itself rather than by selector.
   */
  async testHeadings(): Promise<string[]> {
    return this.page.evaluate(() => {
      const out: string[] = [];
      Array.prototype.slice.call(document.querySelectorAll('*')).forEach((el: any) => {
        const own = Array.prototype.slice
          .call(el.childNodes)
          .filter((n: any) => n.nodeType === 3)
          .map((n: any) => n.textContent.trim())
          .join(' ')
          .trim();
        if (/^.+\s[-–]\s\d{5,}$/.test(own) && !out.includes(own)) out.push(own);
      });
      return out;
    });
  }

  /**
   * Fills every result on the report: 1, 2, 3 … down the typed fields, and a
   * value chosen off the list for each of the rest.
   *
   * The numbering runs across the whole report rather than restarting per
   * department, so each field's number says where it sits overall and the same
   * values can be recognised again on the Done tab.
   */
  async fillEveryResult(): Promise<EnteredResult[]> {
    const fields = await this.fields();
    expect(fields.length, 'the report carries no result fields at all').toBeGreaterThan(0);

    const entered: EnteredResult[] = [];
    let n = 0;

    for (const field of fields) {
      const control = this.field(field.id);
      await control.scrollIntoViewIfNeeded();

      if (field.kind === 'text') {
        const value = String(++n);
        await control.fill(value);
        // Each result round-trips over the circuit; let it land before the next.
        await this.page.waitForTimeout(300);
        await expect(control).toHaveValue(value);
        entered.push({ ...field, value });
        continue;
      }

      const value = await this.chooseOption(field.id, field.value);
      entered.push({ ...field, value });
    }

    return entered;
  }

  /**
   * Picks a value off one of the fixed lists and returns it.
   *
   * Any of them will do, so this takes the first real option that is not what
   * the field already shows — which makes the choice visible rather than a
   * no-op that proves nothing. Some lists carry a blank entry; it is skipped,
   * since selecting it would clear the field instead of filling it. A list
   * offering nothing but its current value is left alone.
   */
  protected async chooseOption(id: string, current: string): Promise<string> {
    const select = this.field(id);

    const options = await select.locator('option').evaluateAll((els) =>
      els.map((o) => ({
        value: (o as HTMLOptionElement).value,
        text: ((o as HTMLElement).textContent ?? '').replace(/\s+/g, ' ').trim(),
      })),
    );

    // Anything that reads as unfilled is off the table entirely — picking it
    // would blank a result rather than record one.
    const usable = options
      .filter((o) => !PLACEHOLDER_OPTION.test(o.value) && !PLACEHOLDER_OPTION.test(o.text))
      .map((o) => o.value);

    // Prefer an actual finding, and fall back to the rest only if that is all
    // the list has.
    const findings = usable.filter((v) => !NOT_A_FINDING.test(v));
    const wanted =
      findings.find((v) => v !== current) ?? usable.find((v) => v !== current) ?? usable[0] ?? current;

    if (wanted === current || wanted === undefined) return current;

    await select.selectOption(wanted);
    await this.page.waitForTimeout(300);
    await expect(select).toHaveValue(wanted);
    return wanted;
  }

  /**
   * Gives a real result to every list still sitting on a placeholder.
   *
   * A list reading "..." has no result on it — the report looks filled while
   * saying nothing. This is the pathologist's repair: find those, put a genuine
   * finding on each, and report what moved. Lists that already hold a result
   * are left exactly as the lab set them.
   */
  async replacePlaceholderSelections(): Promise<{ id: string; test: string; from: string; to: string }[]> {
    const blank = (await this.fields()).filter(
      (f) => f.kind === 'select' && PLACEHOLDER_OPTION.test(f.value),
    );

    const changed: { id: string; test: string; from: string; to: string }[] = [];

    for (const field of blank) {
      const control = this.field(field.id);
      await control.scrollIntoViewIfNeeded();
      const to = await this.chooseOption(field.id, field.value);
      changed.push({ id: field.id, test: field.test, from: field.value, to });
    }

    return changed;
  }

  /** The "Any Comments (LabNo - …)" boxes, one per test on the report. */
  get commentBoxes(): Locator {
    return this.page.locator('textarea.form-control');
  }

  /** Each comment box with the test it belongs to, as its label names it. */
  async comments(): Promise<{ id: string; label: string; value: string }[]> {
    return this.page.evaluate(() =>
      Array.prototype.slice
        .call(document.querySelectorAll('textarea.form-control'))
        .filter((el: any) => el.getBoundingClientRect().width > 0)
        .map((el: any) => ({
          id: el.id,
          label: (el.closest('.form-group')?.querySelector('label')?.innerText ?? '')
            .replace(/\s+/g, ' ')
            .trim(),
          value: el.value ?? '',
        })),
    );
  }

  /** Writes the same remark into every comment box, and returns their ids. */
  async fillComments(text: string): Promise<string[]> {
    const boxes = await this.comments();
    expect(boxes.length, 'the report has no comment boxes').toBeGreaterThan(0);

    const written: string[] = [];

    for (const box of boxes) {
      const control = this.field(box.id);
      await control.scrollIntoViewIfNeeded();
      await control.fill(text);
      // Each remark round-trips over the circuit before the next is typed.
      await this.page.waitForTimeout(400);
      await expect(control).toHaveValue(text);
      written.push(box.id);
    }

    return written;
  }

  /** The Technologist picker — a Radzen dropdown, not a plain select. */
  get technologist(): Locator {
    return this.page
      .locator('div.form-group')
      .filter({ has: this.page.locator('label.form-label').filter({ hasText: /^Technologist$/ }) })
      .locator('.rz-dropdown')
      .first();
  }

  /** Whoever the Technologist box is showing, or '' while it is empty. */
  async selectedTechnologist(): Promise<string> {
    const label = await this.technologist.locator('label.rz-dropdown-label').first().innerText();
    return label.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Picks a technologist and returns the name taken.
   *
   * The dropdown opens a searchable grid rather than a list of options, so the
   * choice is a row click. `match` narrows it through the panel's own search
   * box; without one the first technologist offered is taken.
   */
  async selectTechnologist(match?: string): Promise<string> {
    const panel = await this.openTechnologistPanel(match);
    const rows = panel.locator('.rz-data-grid tbody tr');

    const chosen = await this.technologistName(rows.first());
    await this.takeTechnologist(panel, rows.first());
    return chosen;
  }

  /**
   * Swaps the Technologist for a different one and reports both names.
   *
   * `selectTechnologist` takes whoever heads the list, which is a no-op when
   * that is already the name in the box — it looks like a change and changes
   * nothing. This skips past the current holder instead, so the report really
   * does end up with someone else against it.
   */
  async changeTechnologist(): Promise<{ from: string; to: string }> {
    const from = await this.selectedTechnologist();

    const panel = await this.openTechnologistPanel();
    const rows = panel.locator('.rz-data-grid tbody tr');

    const offered: string[] = [];
    for (let i = 0; i < (await rows.count()); i++) {
      offered.push(await this.technologistName(rows.nth(i)));
    }

    const index = offered.findIndex((name) => name && name.toUpperCase() !== from.toUpperCase());
    expect(
      index,
      `no technologist on offer differs from the one already selected ("${from}"). The list holds: ` +
        `${offered.join(', ') || '(nobody)'}`,
    ).toBeGreaterThanOrEqual(0);

    const to = offered[index];
    await this.takeTechnologist(panel, rows.nth(index));

    expect(to.toUpperCase(), 'the technologist did not actually change').not.toEqual(from.toUpperCase());
    return { from, to };
  }

  /** Opens the Technologist panel, optionally narrowed by its search box. */
  protected async openTechnologistPanel(match?: string): Promise<Locator> {
    const id = await this.technologist.getAttribute('id');
    expect(id, 'the Technologist dropdown has no id to hang its panel off').toBeTruthy();

    await this.technologist.scrollIntoViewIfNeeded();
    await this.technologist.click();

    const panel = this.page.locator(`#popup-${id}`);
    await expect(panel).toBeVisible({ timeout: 30_000 });

    if (match) {
      await panel.locator('input[placeholder="Search..."]').fill(match);
      await this.page.waitForTimeout(3_000);
    }

    await expect(panel.locator('.rz-data-grid tbody tr').first()).toBeVisible({ timeout: 30_000 });
    return panel;
  }

  /** Each row reads "<guid><name><designation>"; the name is the second cell. */
  protected async technologistName(row: Locator): Promise<string> {
    return (await row.locator('td').nth(1).innerText()).replace(/\s+/g, ' ').trim();
  }

  protected async takeTechnologist(panel: Locator, row: Locator) {
    await row.click();
    await expect(panel).toBeHidden({ timeout: 30_000 });
    await this.page.waitForTimeout(1_500);
  }

  async save() {
    await this.saveButton.scrollIntoViewIfNeeded();
    await this.saveButton.click();
    await this.page.waitForTimeout(8_000);
  }

  async recordSnackbars() {
    await recordSnackbars(this.page);
  }

  async snackbars(): Promise<string[]> {
    return readSnackbars(this.page);
  }

  async snackbarsMatching(expected: RegExp, timeout?: number): Promise<string[]> {
    return waitForSnackbar(this.page, expected, timeout);
  }

  async clearSnackbars() {
    await clearSnackbars(this.page);
  }
}
