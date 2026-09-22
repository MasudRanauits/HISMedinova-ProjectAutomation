import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { clearSnackbars, readSnackbars, recordSnackbars, waitForSnackbar } from '../utils/snackbars';

/** A row of the test grid, as the page renders it. */
export type InvestigationTest = {
  /** What to type into the test search box. */
  query: string;
  /** Picks the suggestion to take when the query matches more than one. */
  match?: RegExp;
};

export type InvestigationTotals = {
  subTotal: number;
  discountable: number;
  netPayable: number;
  due: number;
};

/**
 * OPD Investigation Entry (/diagnostic/investigation).
 *
 * Unlike the MudBlazor screens, this one is Blazorise/Bootstrap: plain
 * `form-control` inputs plus `b-is-autocomplete` typeaheads. Element ids are
 * regenerated per circuit (`0HNOKJ91MR3LR` and friends), so every locator here
 * keys off a placeholder or a stable class instead.
 */
export class InvestigationPage {
  readonly page: Page;
  readonly uhid: Locator;
  readonly searchButton: Locator;
  readonly fullName: Locator;
  readonly ageYears: Locator;
  readonly ageMonths: Locator;
  readonly ageDays: Locator;
  readonly mobile: Locator;
  readonly title: Locator;
  readonly gender: Locator;
  readonly dateOfBirth: Locator;
  readonly doctorSearch: Locator;
  readonly testSearch: Locator;
  readonly packageSearch: Locator;
  readonly discountCategory: Locator;
  readonly discountPercent: Locator;
  readonly discountTaka: Locator;
  readonly resetButton: Locator;
  readonly cardType: Locator;
  readonly mobileOperator: Locator;
  readonly cardPayment: Locator;
  readonly mobilePayment: Locator;
  readonly remarks: Locator;
  readonly paymentAmount: Locator;
  readonly postButton: Locator;
  readonly printButton: Locator;
  readonly grid: Locator;
  /** The open suggestion list of whichever typeahead has focus. */
  readonly suggestions: Locator;

  constructor(page: Page) {
    this.page = page;

    this.uhid = page.locator('input[placeholder="12-digit UHID"]');
    this.searchButton = page.getByRole('button', { name: /^search$/i }).first();

    this.fullName = page.locator('#FullName');
    this.ageYears = page.locator('#ageyear');
    this.ageMonths = page.locator('input[placeholder="M"]');
    this.ageDays = page.locator('input[placeholder="D"]');
    this.mobile = page.locator('#mobile');

    // Four selects share the same class; these two are told apart by an option
    // only they carry, which survives the per-circuit ids.
    this.title = page.locator('select.form-select-sm').filter({ hasText: 'Miss' }).first();
    this.gender = page.locator('select.form-select-sm').filter({ hasText: 'Female' }).first();

    // flatpickr's visible alternate input; the hidden original sits beside it.
    this.dateOfBirth = page.locator('input.input.form-control').first();

    this.doctorSearch = page.locator('input[placeholder="Doctor search..."]');
    this.testSearch = page.locator('input[placeholder="Search test by name or code..."]');
    this.packageSearch = page.locator('input[placeholder="Search OPD package..."]');
    this.discountCategory = page.locator('input[placeholder="Discount category"]');
    this.remarks = page.locator('input[placeholder="Optional notes..."]');

    // Matched on its label: choosing a card type or a mobile operator adds a
    // second and third box with exactly the same markup as this one.
    this.paymentAmount = page.locator(
      'xpath=//*[contains(normalize-space(text()),"Payment (cash)")]/following::input[1]',
    );

    // The label text is "Disc(%)" in the markup, upper-cased by CSS. It also
    // heads a column in the test grid, so the table is excluded — what is
    // wanted is the pair of boxes in the summary panel.
    this.discountPercent = page.locator(
      'xpath=//*[normalize-space(text())="Disc(%)"][not(ancestor::table)]/following::input[1]',
    );
    this.discountTaka = page.locator(
      'xpath=//*[normalize-space(text())="Disc(Tk)"][not(ancestor::table)]/following::input[1]',
    );

    // The red button beside Search; it empties the form.
    this.resetButton = page.locator('button.btn-danger.btn-sm').first();

    // Card and mobile are chosen by their own options rather than by position,
    // because picking either one adds further fields and shifts the rest along.
    this.cardType = page.locator('select').filter({ hasText: 'Credit Card' }).first();
    this.mobileOperator = page.locator('select').filter({ hasText: 'BKash' }).first();

    // These two boxes do not exist until a card type or an operator is chosen —
    // which is how the screen stops a card payment being entered without one.
    this.cardPayment = page.locator(
      'xpath=//*[contains(normalize-space(text()),"Payment (card)")]/following::input[1]',
    );
    this.mobilePayment = page.locator(
      'xpath=//*[contains(normalize-space(text()),"Payment (mobile)")]/following::input[1]',
    );

    this.postButton = page.getByRole('button', { name: /^post$/i });
    // The button's accessible name carries its icon ligature, so it reads
    // " Print"; anchoring on the end keeps "Print RX" out.
    this.printButton = page.getByRole('button', { name: /print$/i }).first();

    // The headers are upper-cased by CSS but the markup says "Name", so the
    // match has to ignore case.
    this.grid = page
      .locator('table')
      .filter({ has: page.locator('th').filter({ hasText: /^name$/i }) })
      .first();

    this.suggestions = page.locator('.dropdown-menu.show a.dropdown-item.b-is-autocomplete-suggestion');
  }

  async goto() {
    await this.page.goto(ROUTES.investigation);
    await expect(this.page).toHaveURL(new RegExp(ROUTES.investigation));
    await expect(this.uhid).toBeVisible({ timeout: 60_000 });
    await expect(this.testSearch).toBeVisible({ timeout: 60_000 });
  }

  /** Loads a patient into the form by UHID and returns the name that came back. */
  async searchByUhid(uhid: string): Promise<string> {
    await this.uhid.fill(uhid);
    await this.searchButton.click();
    // The lookup round-trips over the circuit; the name lands when it returns.
    await expect(this.fullName).not.toHaveValue('', { timeout: 60_000 });
    return this.fullName.inputValue();
  }

  /**
   * Types into a `b-is-autocomplete` and clicks a suggestion.
   *
   * The suggestion list only appears after the server answers, and the whole
   * list is replaced on every keystroke, so the text is typed with a delay and
   * the list is read once it settles. Returns the suggestion that was taken.
   */
  async pickSuggestion(input: Locator, query: string, match?: RegExp, attempts = 3): Promise<string> {
    let texts: string[] = [];
    let stalled = '';

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await input.scrollIntoViewIfNeeded();
      // The sticky patient bar overlaps the lower fields, so the click is forced.
      await input.click({ force: true });
      await input.fill('');
      await input.pressSequentially(query, { delay: 110 });

      // The list occasionally never arrives — the server drops a keystroke and
      // the query is left waiting — so a silent round is simply retyped.
      const appeared = await this.suggestions
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);

      if (!appeared) {
        stalled = 'the list never appeared';
        continue;
      }

      // Let the last keystroke's round-trip replace the list before reading it.
      await this.page.waitForTimeout(1_500);

      let index = -1;
      try {
        // Read in one call rather than element by element: the list is rebuilt
        // on every keystroke, and a per-element read walks a list that may be
        // replaced underneath it.
        texts = (await this.suggestions.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());

        index = match ? texts.findIndex((t) => match.test(t)) : 0;
        // The list arrived and simply does not hold what was asked for. Retyping
        // the same query cannot change that, so stop and say so.
        if (index < 0) break;

        // Bounded on purpose. A click waits for the element to hold still, and a
        // list still being rebuilt never does — with no timeout that wait runs
        // until the whole test expires, which is how TC-65 once spent its full
        // 240s sitting on an open suggestion list. Bounded, a churning round is
        // just another round.
        await this.suggestions.nth(index).click({ timeout: 15_000 });
      } catch (error) {
        stalled = String(error).split('\n')[0];
        continue;
      }

      // Past the click the suggestion has been taken, so this is never retried:
      // typing the query again here would add a second copy of it to the bill.
      await expect(this.suggestions).toHaveCount(0, { timeout: 30_000 });
      return texts[index];
    }

    throw new Error(
      `no suggestion for "${query}" matched ${match} after ${attempts} attempts` +
        `${stalled ? ` (last round: ${stalled})` : ''}; last list:\n${texts.join('\n') || '(empty)'}`,
    );
  }

  async setReferredBy(query: string, match?: RegExp) {
    return this.pickSuggestion(this.doctorSearch, query, match);
  }

  /**
   * Adds one test to the grid and returns the suggestion that was taken.
   *
   * A single pick can produce more than one row — a microbiology test also
   * brings in its sample tube — so this only waits for the grid to grow.
   */
  async addTest(test: InvestigationTest): Promise<string> {
    const rows = this.grid.locator('tbody tr');
    const before = await rows.count();
    const chosen = await this.pickSuggestion(this.testSearch, test.query, test.match);
    await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(before);
    return chosen;
  }

  async addTests(tests: InvestigationTest[]): Promise<string[]> {
    const chosen: string[] = [];
    for (const test of tests) {
      chosen.push(await this.addTest(test));
    }
    return chosen;
  }

  async setDiscountCategory(query: string, match?: RegExp) {
    return this.pickSuggestion(this.discountCategory, query, match);
  }

  /**
   * Adds an OPD package, which drops its whole contents into the grid at once.
   *
   * Picking a second package replaces the first rather than adding to it, so
   * the bill holds one package at a time. The contents arrive a beat after the
   * suggestion list closes, so this waits for them rather than handing back a
   * grid that is still empty.
   */
  async addPackage(query: string, match?: RegExp): Promise<string> {
    const chosen = await this.pickSuggestion(this.packageSearch, query, match);
    await expect.poll(() => this.gridRows.count(), { timeout: 30_000 }).toBeGreaterThan(0);
    // A package arrives line by line; let it finish before the grid is read.
    await this.page.waitForTimeout(3_000);
    return chosen;
  }

  /** Lists whatever the package field offers for a query, without taking any. */
  async packageSuggestions(query: string): Promise<string[]> {
    await this.packageSearch.scrollIntoViewIfNeeded();
    await this.packageSearch.click({ force: true });
    await this.packageSearch.fill('');
    await this.packageSearch.pressSequentially(query, { delay: 110 });
    await this.page.waitForTimeout(4_000);

    const texts: string[] = [];
    for (let i = 0; i < (await this.suggestions.count()); i++) {
      texts.push((await this.suggestions.nth(i).innerText()).replace(/\s+/g, ' ').trim());
    }
    await this.page.keyboard.press('Escape');
    return texts;
  }

  get gridRows(): Locator {
    return this.grid.locator('tbody tr');
  }

  /** Deletes a line from the bill with the button at the end of its row. */
  async removeRow(index: number) {
    const rows = this.gridRows;
    const before = await rows.count();
    await rows.nth(index).locator('button').last().click();
    await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeLessThan(before);
  }

  /** The names in the grid, in the order they were added. */
  async testNames(): Promise<string[]> {
    const cells = this.grid.locator('tbody tr td:nth-child(2)');
    return (await cells.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  }

  /**
   * Reads the totals strip. The figures are rendered as loose text rather than
   * in fields, so they are scraped out of the summary card.
   */
  async totals(): Promise<InvestigationTotals> {
    const text = (await this.page.locator('body').innerText()).replace(/\s+/g, ' ');
    const grab = (label: RegExp) => {
      const value = text.match(label)?.[1];
      expect(value, `"${label}" not found in the totals strip`).toBeTruthy();
      return Number(value!.replace(/,/g, ''));
    };
    return {
      subTotal: grab(/Sub total\s+([\d.,]+)/i),
      discountable: grab(/Discountable\(Tk\)\s+([\d.,]+)/i),
      netPayable: grab(/Net payable\s+([\d.,]+)/i),
      due: grab(/Due amount\s+([\d.,]+)/i),
    };
  }

  /**
   * Reads the totals repeatedly until they stop moving.
   *
   * Picking a discount category, like adding a test, recalculates the strip
   * over the circuit, and the old figures stay on screen until the answer
   * lands — reading once straight after a change returns the pre-change
   * numbers. The strip is considered settled once `stableReads` consecutive
   * reads agree.
   */
  async settledTotals(stableReads = 3, interval = 1_000, timeout = 45_000): Promise<InvestigationTotals> {
    const deadline = Date.now() + timeout;
    let previous = await this.totals();
    let agreed = 1;

    while (Date.now() < deadline) {
      await this.page.waitForTimeout(interval);
      const current = await this.totals();
      const same =
        current.subTotal === previous.subTotal &&
        current.discountable === previous.discountable &&
        current.netPayable === previous.netPayable &&
        current.due === previous.due;

      agreed = same ? agreed + 1 : 1;
      previous = current;
      if (agreed >= stableReads) return current;
    }

    return previous;
  }

  /**
   * One figure from the totals strip, read on its own.
   *
   * `totals()` scrapes the whole strip out of the page text in one go, which is
   * no use when part of it is deliberately wrong — this reads a single labelled
   * row instead.
   */
  async totalsRow(label: RegExp): Promise<number> {
    const row = this.page
      .locator('.inv2-summary-row')
      .filter({ has: this.page.locator('.inv2-summary-label').filter({ hasText: label }) })
      .first();
    const value = (await row.locator('.inv2-summary-val').first().innerText()).replace(/,/g, '').trim();
    return Number(value);
  }

  /**
   * Types an amount into "Payment (cash)" and lets the due amount recalculate.
   *
   * It is a Blazorise numeric edit, which only pushes its value to the server
   * on real keystrokes followed by a blur — a plain `fill()` leaves the figure
   * on screen but the due amount never moves.
   */
  async payCash(amount: number) {
    await this.paymentAmount.scrollIntoViewIfNeeded();
    await this.paymentAmount.click({ force: true });
    await this.paymentAmount.press('ControlOrMeta+a');
    await this.paymentAmount.pressSequentially(String(amount), { delay: 100 });
    await this.paymentAmount.press('Tab');
    await expect(this.paymentAmount).toHaveValue(String(amount));
  }

  /**
   * Types into a demographic field and returns what it holds afterwards.
   *
   * These fields rewrite what they are given as it is typed — names are
   * upper-cased, a minus sign is dropped from an age, an out-of-range month
   * wraps — so the value that matters is the one the field keeps, not the one
   * that was sent to it.
   */
  async typeInto(field: Locator, value: string): Promise<string> {
    await field.scrollIntoViewIfNeeded();
    await field.click({ force: true });
    await field.fill('');
    if (value) await field.pressSequentially(value, { delay: 25 });
    await field.press('Tab');
    await this.page.waitForTimeout(1_200);
    return field.inputValue();
  }

  /** flatpickr only commits a typed date on Enter, and rewrites what it takes. */
  async setDateOfBirth(value: string): Promise<string> {
    await this.dateOfBirth.click();
    await this.dateOfBirth.fill('');
    await this.dateOfBirth.pressSequentially(value, { delay: 40 });
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(1_500);
    return this.dateOfBirth.inputValue();
  }

  async setRemarks(text: string) {
    await this.remarks.scrollIntoViewIfNeeded();
    await this.remarks.click({ force: true });
    await this.remarks.pressSequentially(text, { delay: 80 });
    await this.remarks.press('Tab');
    await expect(this.remarks).toHaveValue(text);
  }

  async recordSnackbars() {
    await recordSnackbars(this.page);
  }

  async snackbars(): Promise<string[]> {
    return readSnackbars(this.page);
  }

  /** Snackbars, once one of them matches — see `waitForSnackbar`. */
  async snackbarsMatching(expected: RegExp, timeout?: number): Promise<string[]> {
    return waitForSnackbar(this.page, expected, timeout);
  }

  async clearSnackbars() {
    await clearSnackbars(this.page);
  }

  async post() {
    await this.postButton.scrollIntoViewIfNeeded();
    await this.postButton.click();
  }
}
