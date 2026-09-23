import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { clearSnackbars, readSnackbars, recordSnackbars, waitForSnackbar } from '../utils/snackbars';

/** The two lists the screen files its invoices under. */
export type CsTab = 'Pending' | 'Done';

/** The three result columns of the antibiogram, one per organism isolated. */
export type AntibiogramColumn = 'A' | 'B' | 'C';

/** One antibiotic on the antibiogram, with the cell ids of its three columns. */
export type Antibiotic = {
  /** The row's Srl.No, which all three of its antibiotics share. */
  srl: string;
  /** Which of the row's three groups this one sits in, 1-3. */
  group: number;
  name: string;
  /** Cell input ids by column, and whether the app has that column switched on. */
  cells: Record<AntibiogramColumn, { id: string; disabled: boolean }>;
};

/** A sensitivity as this spec entered it, kept so it can be checked again. */
export type AntibiogramEntry = {
  srl: string;
  antibiotic: string;
  column: AntibiogramColumn;
  /** The cell's own input id, so it can be read back without matching on names. */
  cellId: string;
  value: string;
};

/** What a printed report turned out to be, read back out of the blob. */
export type PrintedReport = {
  url: string;
  /** Bytes the browser actually holds, or -1 when the blob could not be read. */
  size: number;
  /** The file's first five bytes — "%PDF-" for a PDF. */
  header: string;
  contentType: string;
};

const pad = (n: number) => String(n).padStart(2, '0');
/** The pickers on this screen read and write DD-MM-YYYY. */
export const asPickerDate = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

/**
 * Entries that fill a list but record nothing — a blank, or the "Select..."
 * prompt every organism list opens on. Choosing one of these looks like a
 * choice and leaves the field unfilled.
 */
const PLACEHOLDER_OPTION = /^(|\.{2,}|-+|select\.*|choose.*|n\/?a)$/i;

/**
 * A small seeded generator, so a run that picks values at random can be run
 * again and pick the same ones.
 *
 * The antibiogram is filled with random sensitivities, which is the point — the
 * screen should take any of S, R and I in any cell. But a failure against
 * values nobody can reproduce is a failure nobody can chase, so the seed is
 * printed by the spec and can be handed back to it.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Microbiology Report — the C/S report (/diagnostic/cs-report).
 *
 * The sidebar calls it "Microbiology Report"; the route keeps the older "cs"
 * (culture and sensitivity) name. Two panels, like the two result screens: on
 * the left a date range, a search box and a Show button feed Pending/Done tabs
 * holding a grid of bills; clicking a bill loads that patient's culture report
 * on the right.
 *
 * ## What only exists once something is selected
 *
 * The screen renders in three stages, and locators written against the wrong
 * one find nothing:
 *
 * - **On arrival** the form is a shell. Print, Save and Finalize are all there
 *   but disabled, the culture media list is an empty flex box, and the
 *   antibiogram grid has a header and no rows.
 * - **Once a bill is clicked** the patient details fill in and the five culture
 *   media checkboxes appear. The antibiogram is still empty.
 * - **Once a test is picked** off the Test Name dropdown the antibiogram fills —
 *   fourteen rows of three antibiotics each — the pathologist and technologist
 *   default themselves, and Print and Save come alive.
 *
 * Finalize is the odd one out: it is on the shell, disabled, and gone from a
 * loaded pending report altogether. It comes back once the report is saved, so
 * `finalizeButton` is looked up afresh rather than held from the constructor.
 *
 * ## The three kinds of control on the form
 *
 * - **Radzen dropdowns** (Test Name, Pathologist, Technologist) open a
 *   searchable grid rather than a list, so a choice is a row click. Their ids
 *   are generated per render, so they are found through their label.
 * - **Plain `<select>`s** (Organism Isolated A/B/C, Growth Type, Incubation,
 *   Colony Count, Colony Count B) are ordinary, bar the placeholder each opens
 *   on.
 * - **Blazorise autocompletes** (C/S Message, and every antibiogram cell) are an
 *   `input[type=search]` beside a `.dropdown-menu` that fills in as you type.
 *   The antibiogram's offer exactly three suggestions: S, R and I.
 */
export class MicrobiologyReportPage {
  readonly page: Page;
  readonly search: Locator;
  readonly startDate: Locator;
  readonly endDate: Locator;
  readonly showButton: Locator;
  readonly printButton: Locator;
  readonly saveButton: Locator;

  constructor(page: Page) {
    this.page = page;

    this.search = page.locator('#csre-search');

    // flatpickr keeps a hidden original input beside the visible alternate one.
    this.startDate = page.locator('input.input.form-control[placeholder="Start Date"]');
    this.endDate = page.locator('input.input.form-control[placeholder="End Date"]');

    this.showButton = page.getByRole('button', { name: /^show$/i }).first();
    this.printButton = page.getByRole('button', { name: /^print$/i }).first();
    this.saveButton = page.getByRole('button', { name: /^save$/i }).first();
  }

  async goto() {
    await this.page.goto(ROUTES.csReport);
    await expect(this.showButton).toBeVisible({ timeout: 60_000 });
    await expect(this.grid).toBeVisible({ timeout: 60_000 });
  }

  /**
   * Opens the screen through the Diagnostic menu, the way a person does.
   *
   * The menu is built from the signed-in account's permissions, so arriving
   * this way proves the account can actually reach the screen — which going
   * straight to the route would not.
   */
  async gotoViaMenu() {
    await this.page.goto(ROUTES.home);

    const diagnostic = this.page.getByText(/^\s*diagnostic\s*$/i).first();
    await expect(diagnostic).toBeVisible({ timeout: 60_000 });
    await diagnostic.click();

    // "Microbiology Report" and "Microbiology Report Dashboard" both match a
    // loose name, and they are different screens; the href is what separates
    // them.
    const link = this.page.locator(`a[href="${ROUTES.csReport}"]`).first();
    await expect(link).toBeVisible({ timeout: 60_000 });
    await link.click();

    await expect(this.page).toHaveURL(new RegExp(`${ROUTES.csReport}$`), { timeout: 60_000 });
    await expect(this.showButton).toBeVisible({ timeout: 60_000 });
    await expect(this.grid).toBeVisible({ timeout: 60_000 });
  }

  // --- the left panel -------------------------------------------------------

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

  tab(name: CsTab): Locator {
    return this.page
      .locator('ul.nav-tabs a.nav-link')
      .filter({ hasText: new RegExp(`^${name}$`, 'i') })
      .first();
  }

  async selectTab(name: CsTab) {
    await this.tab(name).click();
    await this.page.waitForTimeout(3_000);
  }

  /** The tab currently on show. */
  async activeTab(): Promise<string> {
    const text = await this.page.locator('ul.nav-tabs a.nav-link.active').first().innerText();
    return text.replace(/\s+/g, ' ').trim();
  }

  /** The bill grid of whichever tab is open. */
  get grid(): Locator {
    return this.page.locator('.tab-content .tab-pane.active table.b-datagrid').first();
  }

  get billRows(): Locator {
    return this.grid.locator('tbody tr.table-row-selectable');
  }

  async show() {
    await this.showButton.click();
    await this.page.waitForTimeout(10_000);
  }

  /** Narrows the grid through the panel's own Search box, then re-queries. */
  async searchFor(term: string) {
    await this.search.fill(term);
    await this.page.waitForTimeout(1_500);
    await this.show();
  }

  /**
   * Every bill number the open tab has **rendered**, in the order shown.
   *
   * Not every bill it holds: the grid is virtualised, so a tab listing hundreds
   * puts only the visible stretch in the DOM. Use `locateBill` to look one up
   * rather than searching this for it — a bill missing from here has very often
   * simply not been scrolled to.
   */
  async bills(): Promise<string[]> {
    const rows = this.billRows;
    const out: string[] = [];
    for (let i = 0; i < (await rows.count()); i++) {
      out.push((await rows.nth(i).locator('td').first().innerText()).replace(/\s+/g, ' ').trim());
    }
    return out;
  }

  billRow(billNo: string): Locator {
    return this.billRows.filter({ hasText: billNo }).first();
  }

  /**
   * Narrows the open tab to one bill and says whether it is there.
   *
   * The Search box filters the query rather than the rendered rows, which is
   * what makes it the only reliable way to ask after a particular bill: the
   * grid is virtualised, so a bill the tab holds may simply not be in the DOM.
   */
  async hasBill(billNo: string): Promise<boolean> {
    await this.searchFor(billNo);
    return (await this.bills()).includes(billNo);
  }

  /**
   * Which tab a bill is filed under, or null if neither has it.
   *
   * Used to explain a bill that is not where it was expected. One missing from
   * Pending has usually been finalized already rather than gone astray, and
   * saying which list it did turn up in is the difference between a puzzle and
   * an answer. It leaves the tab it found the bill under selected, and the
   * search box holding the bill number.
   */
  async locateBill(billNo: string): Promise<CsTab | null> {
    for (const tab of ['Pending', 'Done'] as const) {
      await this.selectTab(tab);
      if (await this.hasBill(billNo)) return tab;
    }
    return null;
  }

  /**
   * Opens a bill's report and waits for the form to have filled in.
   *
   * The patient's name arriving is what says the click landed: the row itself
   * gives no feedback, and the antibiogram stays empty until a test is picked,
   * so neither can be waited on here.
   */
  async openBill(billNo: string) {
    const row = this.billRow(billNo);
    await expect(
      row,
      `bill ${billNo} is not on the ${await this.activeTab()} tab for ` +
        `${await this.startDate.inputValue()}..${await this.endDate.inputValue()}. A bill only reaches this ` +
        `screen once it carries a culture test whose sample has been acknowledged in the lab, and it leaves ` +
        `Pending once its report is finalized.`,
    ).toBeVisible({ timeout: 30_000 });

    await row.click();
    await expect(this.patientName).not.toHaveValue('', { timeout: 60_000 });
    await this.page.waitForTimeout(4_000);
  }

  // --- the patient header ---------------------------------------------------

  get patientName(): Locator {
    return this.page.locator('input[name="InvoiceRecordItem.FullName"]').first();
  }

  get invoiceNoField(): Locator {
    return this.page.locator('input[name="InvoiceNo"]').first();
  }

  get specimen(): Locator {
    return this.page.locator('input[name="SelectedTestItem.Specimen"]').first();
  }

  /** The patient the loaded report belongs to, as the form shows them. */
  async patientHeader(): Promise<{ invoiceNo: string; name: string; specimen: string }> {
    return {
      invoiceNo: (await this.invoiceNoField.inputValue()).trim(),
      name: (await this.patientName.inputValue()).trim(),
      specimen: (await this.specimen.inputValue()).trim(),
    };
  }

  // --- finding a control by the label above it ------------------------------

  /**
   * The form group headed by `label`.
   *
   * `.last()` rather than `.first()`: a group nests inside the rows and columns
   * around it, and an ancestor carrying the same label comes first in document
   * order, so the last match is the group itself. Every label reached this way
   * appears once on the form.
   */
  private group(label: string): Locator {
    return this.page
      .locator('div.form-group')
      .filter({
        has: this.page.locator('label.form-label').filter({ hasText: new RegExp(`^${label}$`) }),
      })
      .last();
  }

  /** The Radzen dropdown under a label — Test Name, Pathologist, Technologist. */
  dropdown(label: string): Locator {
    return this.group(label).locator('.rz-dropdown').first();
  }

  /** Whoever, or whatever, a Radzen dropdown is currently showing. */
  async selected(label: string): Promise<string> {
    const text = await this.dropdown(label).locator('label.rz-dropdown-label').first().innerText();
    return text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Picks a value off a Radzen dropdown and returns what was taken.
   *
   * These open a searchable grid rather than a list of options, so the choice
   * is a row click and the name wanted is in the row's first cell. `match`
   * narrows the panel through its own search box; without one the first entry
   * offered is taken.
   */
  async selectFromDropdown(label: string, match?: string): Promise<string> {
    const dropdown = this.dropdown(label);
    const id = await dropdown.getAttribute('id');
    expect(id, `the ${label} dropdown has no id to hang its panel off`).toBeTruthy();

    await dropdown.scrollIntoViewIfNeeded();
    await dropdown.click();

    const panel = this.page.locator(`#popup-${id}`);
    await expect(panel, `the ${label} panel did not open`).toBeVisible({ timeout: 30_000 });

    if (match) {
      await panel.locator('input[placeholder="Search..."]').fill(match);
      await this.page.waitForTimeout(3_000);
    }

    const rows = panel.locator('.rz-data-grid tbody tr');
    await expect(
      rows.first(),
      `the ${label} dropdown offered nothing${match ? ` for "${match}"` : ''}`,
    ).toBeVisible({ timeout: 30_000 });

    const chosen = (await rows.first().locator('td').first().innerText()).replace(/\s+/g, ' ').trim();
    await rows.first().click();
    await expect(panel).toBeHidden({ timeout: 30_000 });
    await this.page.waitForTimeout(2_000);

    return chosen;
  }

  /**
   * Picks a test, and says which one was taken.
   *
   * A bill can carry the same test against more than one specimen, so the two
   * entries read alike bar the specimen; either will do.
   *
   * The antibiogram is not waited on here. Picking the test is only half of
   * what builds it: a report opens on whatever CULTURE RESULT its test defaults
   * to, and STOOL FOR CULTURE & SENSITIVITY opens on NG with the no-growth
   * comment already written, under which there is no sensitivity panel to fill.
   * `waitForAntibiogram` is called once the growth has been recorded.
   */
  async selectTest(match?: string): Promise<string> {
    const chosen = await this.selectFromDropdown('Test Name', match);
    await this.page.waitForTimeout(4_000);
    return chosen;
  }

  /**
   * Waits for the antibiogram to be built, and explains an empty one.
   *
   * Called after the test and the culture result are both set, since the grid
   * needs both. An empty grid past that point is a configuration gap rather
   * than a slow screen, and the message says so rather than reading as a
   * timeout on a locator.
   */
  async waitForAntibiogram(timeout = 90_000) {
    const built = await this.antibiogramRows
      .first()
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);

    if (!built) {
      const [test, result] = [await this.selected('Test Name'), await this.cultureResult()];
      expect(
        built,
        `the antibiogram was not built for "${test}" with CULTURE RESULT "${result}". It needs both: a test ` +
          `picked, and a growth recorded — under NG the screen builds no sensitivity panel. With the result ` +
          `reading G, an empty grid means this test has no antibiotics mapped to it, which is a gap in the ` +
          `master data (Diagnostic > Antibiotics (CS)) and not a fault in this screen.`,
      ).toBe(true);
    }

    await this.page.waitForTimeout(4_000);
  }

  async selectPathologist(match?: string): Promise<string> {
    return this.selectFromDropdown('Pathologist', match);
  }

  async selectTechnologist(match?: string): Promise<string> {
    return this.selectFromDropdown('Technologist', match);
  }

  // --- culture result -------------------------------------------------------

  /**
   * Sets CULTURE RESULT to G (growth) or NG (no growth).
   *
   * The radio carries no value and no name, so it is reached through its own
   * label — which is what a person clicks anyway.
   */
  async setCultureResult(value: 'G' | 'NG') {
    const label = this.page
      .locator('label.form-check-label')
      .filter({ hasText: new RegExp(`^${value}$`) })
      .first();
    await expect(label, `there is no "${value}" option under CULTURE RESULT`).toBeVisible({ timeout: 30_000 });

    const id = await label.getAttribute('for');
    expect(id, `the "${value}" label points at no radio`).toBeTruthy();

    await label.scrollIntoViewIfNeeded();
    await label.click();
    await this.page.waitForTimeout(1_500);
    await expect(
      this.page.locator(`[id="${id}"]`),
      `CULTURE RESULT did not take "${value}"`,
    ).toBeChecked({ timeout: 15_000 });
  }

  async cultureResult(): Promise<string> {
    const checked = this.page.locator('input.form-check-input[type="radio"]:checked').first();
    if (!(await checked.count())) return '';
    const id = await checked.getAttribute('id');
    return (await this.page.locator(`label[for="${id}"]`).first().innerText()).trim();
  }

  // --- the plain lists ------------------------------------------------------

  /** The `<select>` under a label — Organism Isolated A, Colony Count, and so on. */
  namedSelect(label: string): Locator {
    return this.group(label).locator('select.form-select').first();
  }

  /**
   * Picks a value off one of the plain lists and returns it.
   *
   * `rng` chooses among everything the list really offers; the placeholder it
   * opens on is dropped first, since selecting that would leave the field
   * reading as unfilled. Without an `rng` the first real option is taken.
   */
  async selectNamed(label: string, rng?: () => number): Promise<string> {
    const select = this.namedSelect(label);
    await expect(select, `there is no "${label}" list on the form`).toBeVisible({ timeout: 30_000 });
    await select.scrollIntoViewIfNeeded();

    const options = await select.locator('option').evaluateAll((els) =>
      els.map((o) => ({
        value: (o as HTMLOptionElement).value,
        text: ((o as HTMLElement).textContent ?? '').replace(/\s+/g, ' ').trim(),
      })),
    );

    const usable = options.filter((o) => !PLACEHOLDER_OPTION.test(o.text) && !PLACEHOLDER_OPTION.test(o.value));
    expect(
      usable.length,
      `the "${label}" list offers nothing but placeholders: ${options.map((o) => `"${o.text}"`).join(', ')}`,
    ).toBeGreaterThan(0);

    const wanted = usable[rng ? Math.floor(rng() * usable.length) : 0];
    await select.selectOption(wanted.value);
    await this.page.waitForTimeout(1_500);
    await expect(select, `"${label}" did not take "${wanted.text}"`).toHaveValue(wanted.value);

    return wanted.text;
  }

  // --- the autocompletes ----------------------------------------------------

  /**
   * Types into a Blazorise autocomplete and takes one of its suggestions.
   *
   * These only offer anything once something has been typed, and the menu is a
   * sibling of the input inside the same `.dropdown`, so both are scoped to the
   * cell or group the field sits in. `match` picks a particular suggestion;
   * without one the first is taken. Returns the suggestion's text.
   */
  private async pickSuggestion(scope: Locator, query: string, match?: RegExp): Promise<string> {
    const input = scope.locator('input[type="search"]').first();
    await input.scrollIntoViewIfNeeded();
    await input.click();
    await input.fill('');
    await input.pressSequentially(query, { delay: 120 });

    const suggestions = scope.locator('.dropdown-menu a.b-is-autocomplete-suggestion');
    await expect(
      suggestions.first(),
      `typing "${query}" offered no suggestions`,
    ).toBeVisible({ timeout: 30_000 });
    await this.page.waitForTimeout(1_000);

    const wanted = match ? suggestions.filter({ hasText: match }).first() : suggestions.first();
    const count = await wanted.count();
    if (!count) {
      const offered = await suggestions.allInnerTexts();
      expect(
        count,
        `nothing matching ${match} was offered for "${query}". On offer: ` +
          `${offered.map((t) => `"${t.replace(/\s+/g, ' ').trim()}"`).join(', ')}`,
      ).toBeGreaterThan(0);
    }

    const text = (await wanted.innerText()).replace(/\s+/g, ' ').trim();
    await wanted.click();
    await this.page.waitForTimeout(1_500);

    return text;
  }

  /** Searches the C/S Message list and takes a line off it. */
  async pickCsMessage(query: string, match?: RegExp): Promise<string> {
    return this.pickSuggestion(this.group('C/S Message'), query, match);
  }

  async csMessage(): Promise<string> {
    return (await this.group('C/S Message').locator('input[type="search"]').first().inputValue()).trim();
  }

  // --- culture media --------------------------------------------------------

  /** The five media checkboxes, in the order the form lists them. */
  get mediaCheckboxes(): Locator {
    return this.group('CULTURE MEDIA USED').locator('input[type="checkbox"]');
  }

  /** Each medium's name and whether it is currently ticked. */
  async media(): Promise<{ id: string; name: string; checked: boolean }[]> {
    const boxes = this.mediaCheckboxes;
    const out: { id: string; name: string; checked: boolean }[] = [];
    for (let i = 0; i < (await boxes.count()); i++) {
      const box = boxes.nth(i);
      const id = (await box.getAttribute('id')) ?? '';
      out.push({
        id,
        name: (await this.page.locator(`label[for="${id}"]`).first().innerText()).trim(),
        checked: await box.isChecked(),
      });
    }
    return out;
  }

  /**
   * Ticks or clears one medium and waits for the circuit to agree.
   *
   * `check()` on its own is a no-op when the box already holds the wanted
   * state, which is exactly what a check-clear-check sequence must not do, so
   * the state is read first and the box clicked only when it has to move.
   */
  async setMedium(index: number, wanted: boolean) {
    const box = this.mediaCheckboxes.nth(index);
    await box.scrollIntoViewIfNeeded();

    if ((await box.isChecked()) !== wanted) {
      await box.click();
      await this.page.waitForTimeout(1_200);
    }

    await expect(
      box,
      `culture medium ${index + 1} did not end up ${wanted ? 'ticked' : 'cleared'}`,
    ).toBeChecked({ checked: wanted, timeout: 15_000 });
  }

  /**
   * Ticks a medium, clears it, and ticks it again.
   *
   * A box that ends up ticked proves nothing on its own — it may simply have
   * arrived that way. Walking it through both states and back is what shows the
   * screen really is recording the change each time, and it is the sequence the
   * lab goes through when a medium is entered by mistake and put back.
   */
  async retickMedium(index: number): Promise<boolean[]> {
    const seen: boolean[] = [];

    for (const wanted of [true, false, true]) {
      await this.setMedium(index, wanted);
      seen.push(await this.mediaCheckboxes.nth(index).isChecked());
    }

    return seen;
  }

  // --- the antibiogram ------------------------------------------------------

  /** The antibiogram grid — the one grid on the form headed by Srl.No. */
  get antibiogram(): Locator {
    return this.page
      .locator('table.b-datagrid')
      .filter({ has: this.page.locator('thead', { hasText: /Srl\.No/i }) })
      .first();
  }

  get antibiogramRows(): Locator {
    return this.antibiogram.locator('tbody tr.table-row-selectable');
  }

  /**
   * Every antibiotic on the grid, in the order it is read on screen.
   *
   * The grid is three antibiotics wide: each row is a Srl.No cell followed by
   * three groups of four cells — the antibiotic's name, then its A, B and C
   * results. The name is the value of a readonly input rather than cell text,
   * and B and C arrive disabled, since a second and third organism have not
   * been isolated. Read in one pass, because forty-two antibiotics read one
   * locator at a time is forty-two round trips over the circuit.
   */
  async antibiotics(): Promise<Antibiotic[]> {
    return this.antibiogram.evaluate((table) => {
      const out: Antibiotic[] = [];

      table.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = Array.prototype.slice.call(tr.children) as HTMLTableCellElement[];
        if (!cells.length) return;

        const srl = (cells[0].textContent ?? '').replace(/\s+/g, ' ').trim();

        // One group per four cells after Srl.No: name, A, B, C.
        for (let i = 1, group = 1; i + 3 < cells.length + 1; i += 4, group++) {
          const nameInput = cells[i]?.querySelector('input') as HTMLInputElement | null;
          if (!nameInput || !nameInput.value.trim()) continue;

          const cellOf = (td: HTMLTableCellElement | undefined) => {
            const input = td?.querySelector('input[type="search"]') as HTMLInputElement | null;
            return { id: input?.id ?? '', disabled: input ? input.disabled : true };
          };

          out.push({
            srl,
            group,
            name: nameInput.value.replace(/\s+/g, ' ').trim(),
            cells: { A: cellOf(cells[i + 1]), B: cellOf(cells[i + 2]), C: cellOf(cells[i + 3]) },
          });
        }
      });

      return out;
    });
  }

  /** The `.dropdown` wrapping one antibiogram cell's input. */
  private antibiogramCell(id: string): Locator {
    return this.page.locator(`div.dropdown:has(input[id="${id}"])`).first();
  }

  /**
   * Records one sensitivity — S, R or I — in an antibiogram cell.
   *
   * The cell is an autocomplete offering exactly those three, so the wanted
   * letter is typed and the suggestion reading exactly that is taken. The list
   * is not always filtered down to what was typed, which is why the suggestion
   * is matched rather than the first one clicked.
   */
  async setSensitivity(cellId: string, value: string): Promise<string> {
    const cell = this.antibiogramCell(cellId);
    const taken = await this.pickSuggestion(cell, value, new RegExp(`^${value}$`));
    await expect(
      this.page.locator(`[id="${cellId}"]`),
      `the antibiogram cell did not take "${value}"`,
    ).toHaveValue(value, { timeout: 15_000 });
    return taken;
  }

  /**
   * Gives the first `count` antibiotics a sensitivity picked at random.
   *
   * Only column A is filled: B and C belong to a second and third organism, and
   * the app leaves their cells disabled until those are isolated.
   */
  async fillAntibiogram(count: number, rng: () => number): Promise<AntibiogramEntry[]> {
    const choices = ['S', 'R', 'I'];
    const all = await this.antibiotics();
    const usable = all.filter((a) => a.cells.A.id && !a.cells.A.disabled);

    expect(
      usable.length,
      `filling ${count} antibiotic(s) needs at least that many with column A enabled; the grid offers ` +
        `${usable.length} of ${all.length}`,
    ).toBeGreaterThanOrEqual(count);

    const entered: AntibiogramEntry[] = [];

    for (const antibiotic of usable.slice(0, count)) {
      const value = choices[Math.floor(rng() * choices.length)];
      await this.setSensitivity(antibiotic.cells.A.id, value);
      entered.push({
        srl: antibiotic.srl,
        antibiotic: antibiotic.name,
        column: 'A',
        cellId: antibiotic.cells.A.id,
        value,
      });
    }

    return entered;
  }

  /**
   * What every antibiogram cell holds now, keyed by its input id.
   *
   * A cell nobody has filled holds a single space rather than an empty string,
   * so the values are trimmed: otherwise every untouched cell on the grid reads
   * as carrying a result.
   */
  async sensitivities(): Promise<Record<string, string>> {
    return this.antibiogram.evaluate((table) => {
      const out: Record<string, string> = {};
      table.querySelectorAll('input[type="search"]').forEach((el) => {
        const input = el as HTMLInputElement;
        if (input.id) out[input.id] = (input.value ?? '').trim();
      });
      return out;
    });
  }

  // --- the note -------------------------------------------------------------

  get note(): Locator {
    return this.page.locator('input[name="otherModel.Note"]').first();
  }

  async setNote(text: string) {
    await this.note.scrollIntoViewIfNeeded();
    await this.note.fill(text);
    await this.page.waitForTimeout(1_000);
    await expect(this.note).toHaveValue(text);
  }

  // --- saving, printing, finalizing ----------------------------------------

  /**
   * Finalize is not on a loaded pending report — it is on the empty shell,
   * disabled, and comes back once the report has been saved — so it is looked
   * up when it is wanted rather than held from the constructor.
   */
  get finalizeButton(): Locator {
    return this.page.getByRole('button', { name: /^finali[sz]e$/i }).first();
  }

  /** Double-clicks Save, which is what the screen has to survive doing once. */
  async save() {
    await this.saveButton.scrollIntoViewIfNeeded();
    await this.saveButton.dblclick();
    await this.page.waitForTimeout(10_000);
  }

  async finalize() {
    await this.finalizeButton.scrollIntoViewIfNeeded();
    await this.finalizeButton.dblclick();
    await this.page.waitForTimeout(10_000);
  }

  /**
   * Prints the report and hands back the tab it opens.
   *
   * The app builds the report as a PDF and opens it in a second tab — blank
   * first, with the blob navigated to a moment later — so the popup arrives on
   * `about:blank` and fills in afterwards. Closing it is the caller's job: see
   * `closePrintTab`.
   */
  async printReport(): Promise<Page> {
    await this.printButton.scrollIntoViewIfNeeded();
    await expect(this.printButton, 'the Print button').toBeEnabled({ timeout: 30_000 });

    const [popup] = await Promise.all([
      this.page.waitForEvent('popup', { timeout: 60_000 }),
      this.printButton.click(),
    ]);
    return popup;
  }

  /**
   * Waits for the print tab to hold something and returns the URL it settled
   * on, leaving the tab open so its contents can still be read.
   *
   * Headless Chrome has no PDF viewer, so there the tab stays on `about:blank`
   * however long it is given; that is reported rather than waited out.
   */
  async printedUrl(popup: Page): Promise<string> {
    await popup
      .waitForURL((url) => url.toString() !== 'about:blank', { timeout: 30_000 })
      .catch(() => {});
    return popup.url();
  }

  /**
   * Reads the printed PDF back out of the browser.
   *
   * A `blob:` URL belongs to the origin that created it — this page, not the
   * print tab — so fetching it from here is what gets at the actual bytes. That
   * turns "a tab opened" into a real check: a PDF starts `%PDF-`, and an empty
   * or truncated one is a report that printed nothing.
   *
   * Returns null when the blob cannot be read at all, which is the honest
   * answer in headless runs, where no blob is ever navigated to.
   */
  async readPrinted(url: string): Promise<PrintedReport | null> {
    if (!url.startsWith('blob:')) return null;

    return this.page.evaluate(async (blobUrl) => {
      try {
        const response = await fetch(blobUrl);
        const buffer = await response.arrayBuffer();
        return {
          url: blobUrl,
          size: buffer.byteLength,
          header: new TextDecoder().decode(new Uint8Array(buffer.slice(0, 5))),
          contentType: response.headers.get('content-type') ?? '',
        };
      } catch {
        return null;
      }
    }, url);
  }

  /** Closes the print tab and brings the report back to the front. */
  async closePrintTab(popup: Page) {
    await popup.close().catch(() => {});
    await this.page.bringToFront();
    await expect(this.grid, 'the report screen should still be on show').toBeVisible({ timeout: 30_000 });
  }

  // --- snackbars ------------------------------------------------------------

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
