import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { settledCount, settledValue } from '../utils/blazor';
import { clearSnackbars, readSnackbars, recordSnackbars } from '../utils/snackbars';

/** One test row of the dispatch grid. */
export type DispatchRow = {
  labNo: string;
  testName: string;
  qty: string;
  labelText: string;
  sampleStatus: string;
  collectedBy: string;
  collectedDate: string;
  carriedBy: string;
  carriedDate: string;
  selected: boolean;
};

export type DispatchFilter = 'Not Dispatched' | 'Partial Dispatched' | 'Dispatched';

/** The three dispatch states, in the order the screen draws them. */
export const DISPATCH_FILTERS: DispatchFilter[] = ['Not Dispatched', 'Partial Dispatched', 'Dispatched'];

const pad = (n: number) => String(n).padStart(2, '0');
/** A date in the form the pickers are typed in; they parse either separator. */
export const asPickerDate = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

/**
 * The same date written with either separator the app's pickers use.
 *
 * The screens are not consistent about which they display — this one and the
 * acknowledgement screen rewrite a typed dd-mm-yyyy as dd/mm/yyyy, the delivery
 * screen keeps the dashes — and the day, month and year are what the assertion
 * is actually after, so the separator is left open.
 */
export const eitherSeparator = (date: string) => new RegExp(`^${date.split(/[-/]/).join('[-/]')}$`);

/**
 * Sample dispatch — the second tab of /diagnostic/sample-collection.
 *
 * It shares the route with sample collection, so the collection tab's markup
 * stays in the DOM while hidden; anything matched loosely here has to be
 * narrowed to what is visible, which is why the search box is found among the
 * *visible* unlabelled inputs rather than by id (the ids are per-circuit).
 *
 * Dispatch hands samples to a carrier: tick the tests, pick a carrier, then
 * "Send to carrier".
 */
export class SampleDispatchPage {
  readonly page: Page;
  readonly tab: Locator;
  readonly startDate: Locator;
  readonly endDate: Locator;
  readonly showButton: Locator;
  readonly search: Locator;
  readonly carrierSearch: Locator;
  readonly sendToCarrier: Locator;
  readonly invoiceGrid: Locator;
  readonly testGrid: Locator;
  readonly suggestions: Locator;

  constructor(page: Page) {
    this.page = page;

    // The tab strip now carries a count badge inside each link — `Sample
    // Dispatch <span class="badge">2</span>` — so a name anchored at both ends
    // stopped matching anything at all. The name is anchored at the front
    // only, which still tells the three tabs apart and no longer rests on what
    // follows it.
    this.tab = page
      .locator('ul.nav-tabs a.nav-link')
      .filter({ hasText: /^\s*sample dispatch\b/i })
      .first();

    // flatpickr keeps a hidden original input beside the visible alternate one.
    //
    // These two are drawn with a "DD/MM/YYYY" placeholder rather than the
    // "Start Date" / "End Date" the acknowledgement and result screens use, so
    // neither can be named; and the collection tab keeps a pair of its own in
    // the DOM while hidden, so the match has to be narrowed to what is on
    // screen. That leaves their order among the visible pickers to tell them
    // apart, the way the delivery screen's pair are told apart.
    const dates = page.locator('input.input.form-control:visible');
    this.startDate = dates.nth(0);
    this.endDate = dates.nth(1);

    this.showButton = page.getByRole('button', { name: /^show$/i });
    this.search = page.locator('input.form-control:not([placeholder]):visible').first();
    this.carrierSearch = page.locator('input[placeholder="Carrier Search..."]');
    this.sendToCarrier = page.getByRole('button', { name: /send to carrier/i });

    // The collection tab keeps an INVOICE NO table of its own in the DOM while
    // hidden, so this has to be pinned to the visible one.
    this.invoiceGrid = page
      .locator('table:visible')
      .filter({ has: page.locator('th').filter({ hasText: /invoice\s*no/i }) })
      .first();
    this.testGrid = page
      .locator('table:visible')
      .filter({ has: page.locator('th').filter({ hasText: /carried\s*by/i }) })
      .first();

    this.suggestions = page.locator('.dropdown-menu.show a.dropdown-item.b-is-autocomplete-suggestion');
  }

  /** Opens the route and switches to the dispatch tab. */
  async goto() {
    await this.page.goto(ROUTES.sampleCollection);
    await expect(this.page.locator('#searchSample')).toBeVisible({ timeout: 60_000 });
    await this.tab.click();
    await expect(this.sendToCarrier).toBeVisible({ timeout: 60_000 });
  }

  /**
   * Types at a picker and hands back what it kept, asserting nothing.
   *
   * flatpickr only commits a typed date on Enter, and an emptied box commits on
   * blur instead — pressing Enter on an empty one reopens the calendar and puts
   * today back. The negative cases need the value the picker settled on rather
   * than the one that was typed, which is the whole of what they are asking
   * about, so the assertion lives in `setDate` below rather than here.
   */
  async typeDate(input: Locator, value: string): Promise<string> {
    await input.click();
    await input.fill('');
    if (value) {
      await input.pressSequentially(value, { delay: 60 });
      await this.page.keyboard.press('Enter');
    } else {
      await this.page.keyboard.press('Tab');
    }
    return settledValue(input);
  }

  /**
   * flatpickr only commits a typed date on Enter.
   *
   * The picker is asserted on afterwards, so a date it quietly declined does
   * not go unnoticed — but on its parts rather than on the exact string, since
   * it rewrites the dashes typed here as slashes.
   */
  private async setDate(input: Locator, value: string) {
    await this.typeDate(input, value);
    await expect(input).toHaveValue(eitherSeparator(value));
  }

  async setDateRange(from: Date, to: Date) {
    await this.setDate(this.startDate, asPickerDate(from));
    await this.setDate(this.endDate, asPickerDate(to));
  }

  /** The invoice grid's rows, whichever filter is on. */
  get invoiceRows(): Locator {
    return this.invoiceGrid.locator('tbody tr');
  }

  /**
   * Each of these three asks the server to rebuild the invoice grid, and each
   * used to sleep a flat few seconds waiting for it — fifteen seconds a pass,
   * and this spec makes two passes. That is both slower than it needs to be on
   * a quiet server and not long enough on a busy one, which is what ran the
   * second test out of its budget mid-screen. Waiting for the grid itself is
   * quicker when it is quick and patient when it is not.
   */
  async show() {
    // Unlike the collection tab beside it, this screen does say when it is
    // working: Show disables itself and spins while a query is in flight. A
    // date change is enough to start one, so a press that lands straight after
    // a range is typed finds the button disabled and spends its whole click
    // timeout there. Waiting for the button is waiting for the query before
    // this one.
    await expect(this.showButton, 'Show is still busy with the query before this one').toBeEnabled({
      timeout: 60_000,
    });
    await this.showButton.click();
    await settledCount(this.invoiceRows);
  }

  /** The box filters the invoice grid as it is typed; no Show is needed. */
  async searchInvoice(invoiceNo: string) {
    await this.search.fill(invoiceNo);
    // Settled means the row asked for is on screen — or, where it is not on the
    // list at all, that the grid has stopped changing without it. Both specs
    // expect the invoice to be there, so this nearly always takes the first.
    await this.invoiceRow(invoiceNo)
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    await settledCount(this.invoiceRows, { quiet: 1_000 });
  }

  /**
   * Narrows the invoice grid to one dispatch state.
   *
   * Clicked by its label, as the page draws it. The collection tab's own
   * filters stay in the DOM while hidden, so the match is narrowed to what is
   * on screen; and a count allowed after the words keeps this working when the
   * badges the collection filters now carry reach these three as well. Both
   * ends are still anchored, so "Dispatched" does not also match "Not
   * Dispatched".
   */
  filterLabel(filter: DispatchFilter): Locator {
    return this.page
      .locator('label.form-check-label:visible')
      .filter({ hasText: new RegExp(`^\\s*${filter}\\s*\\d*\\s*$`) })
      .first();
  }

  async filterBy(filter: DispatchFilter) {
    const label = this.filterLabel(filter);
    await expect(label, `there is no "${filter}" filter on this screen`).toBeVisible({ timeout: 30_000 });
    await label.click();
    await settledCount(this.invoiceRows);
  }

  invoiceRow(invoiceNo: string): Locator {
    return this.invoiceGrid.locator('tbody tr').filter({ hasText: invoiceNo }).first();
  }

  /**
   * Which of the three dispatch states are holding an invoice.
   *
   * Only ever called once a row has failed to turn up, and it leaves the screen
   * on the last filter it tried rather than on the one it was handed: the one
   * caller is on its way to failing, and a restore would only be another three
   * round trips before it does. An invoice can come back under more than one
   * state — SD_N_11 is the test that holds the app to one — so this answers
   * with every state that lists it rather than the first.
   */
  async whereIs(invoiceNo: string): Promise<DispatchFilter[]> {
    const found: DispatchFilter[] = [];
    for (const filter of DISPATCH_FILTERS) {
      const label = this.filterLabel(filter);
      if (!(await label.count())) continue;
      await label.click();
      await settledCount(this.invoiceRows);
      await this.searchInvoice(invoiceNo);
      if (await this.invoiceRow(invoiceNo).count()) found.push(filter);
    }
    return found;
  }

  async selectInvoice(invoiceNo: string) {
    const row = this.invoiceRow(invoiceNo);

    // A dispatched test leaves the "Not Dispatched" list for good, so pointing
    // this screen at a spent invoice finds nothing at all. Say so, rather than
    // waiting out a minute on a row that is never going to appear.
    const found = await row
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    // "Not in the list" on its own does not say whether the invoice is absent
    // from the screen or merely under one of the other two filters, and the two
    // want opposite answers: a fresh invoice for the first, a different filter
    // for the second. The other filters are only walked on the way to failing,
    // so this costs a passing run nothing.
    const elsewhere = found ? [] : await this.whereIs(invoiceNo);
    expect(
      found,
      elsewhere.length
        ? `invoice ${invoiceNo} is not under the filter this spec is on, but it is listed under ` +
          `"${elsewhere.join('" and "')}" — some of its samples have already been handed to a carrier. This spec ` +
          `needs an invoice with nothing dispatched: run the investigation spec to raise a fresh one — it records ` +
          `the new number for the sample specs — or point partialSampleDispatch.invoiceNo at one still pending.`
        : `invoice ${invoiceNo} is not in the list on screen under any of the three dispatch filters. Check the ` +
          `date range covers it, or run the investigation spec to raise a fresh invoice — it records the new ` +
          `number for the sample specs.`,
    ).toBe(true);

    await row.click();
    await expect(this.testRows.first()).toBeVisible({ timeout: 60_000 });
    // The tests arrive a row at a time; read once they have all landed.
    await settledCount(this.testRows);
  }

  /** Test rows, without any department header row. */
  get testRows(): Locator {
    return this.testGrid.locator('tbody tr:not(.table-secondary)');
  }

  testRow(testName: string): Locator {
    return this.testRows.filter({ hasText: testName }).first();
  }

  async rows(): Promise<DispatchRow[]> {
    const rows = this.testRows;
    const out: DispatchRow[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const cells = (await row.locator('td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      const [labNo, testName, qty, labelText, sampleStatus, collectedBy, collectedDate, carriedBy, carriedDate] =
        cells;
      const box = row.locator('input[type="checkbox"]');
      out.push({
        labNo,
        testName,
        qty,
        labelText,
        sampleStatus,
        collectedBy,
        collectedDate,
        carriedBy,
        carriedDate,
        selected: (await box.count()) ? await box.isChecked() : false,
      });
    }

    return out;
  }

  /**
   * Clicks a row's checkbox and reports whether the tick stuck.
   *
   * Without a carrier the app quietly refuses: the click goes through, the
   * circuit round-trips, and the row comes back unticked. Use this where the
   * refusal is the point; `selectOnly` insists instead.
   */
  async tryTick(testName: string): Promise<boolean> {
    const box = this.testRow(testName).locator('input[type="checkbox"]');
    await box.click({ force: true });
    await this.page.waitForTimeout(2_500);
    return box.isChecked();
  }

  /** Ticks exactly the tests named and clears the rest. Needs a carrier set. */
  async selectOnly(testNames: string[]) {
    const rows = this.testRows;

    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const name = (await row.locator('td').nth(1).innerText()).replace(/\s+/g, ' ').trim();
      const wanted = testNames.some((t) => name.toUpperCase().includes(t.toUpperCase()));
      const box = row.locator('input[type="checkbox"]');
      if (!(await box.count())) continue;

      if ((await box.isChecked()) !== wanted) {
        await box.click({ force: true });
        await this.page.waitForTimeout(800);
        await expect(box).toBeChecked({ checked: wanted });
      }
    }
  }

  /** Picks a carrier from the typeahead. Returns the suggestion taken. */
  async pickCarrier(query: string, match?: RegExp, attempts = 3): Promise<string> {
    let texts: string[] = [];

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.carrierSearch.scrollIntoViewIfNeeded();
      await this.carrierSearch.click({ force: true });
      await this.carrierSearch.fill('');
      await this.carrierSearch.pressSequentially(query, { delay: 110 });

      const appeared = await this.suggestions
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      if (!appeared) continue;

      await this.page.waitForTimeout(1_500);

      texts = [];
      for (let i = 0; i < (await this.suggestions.count()); i++) {
        texts.push((await this.suggestions.nth(i).innerText()).replace(/\s+/g, ' ').trim());
      }

      const index = match ? texts.findIndex((t) => match.test(t)) : 0;
      if (index < 0) break;

      const chosen = texts[index];
      await this.suggestions.nth(index).click();
      await expect(this.suggestions).toHaveCount(0, { timeout: 30_000 });
      return chosen;
    }

    throw new Error(
      `no carrier for "${query}" matched ${match} after ${attempts} attempts; last list:\n${texts.join('\n') || '(empty)'}`,
    );
  }

  /**
   * What the carrier typeahead offers for a query, without taking any of it.
   *
   * `pickCarrier` throws when nothing matches, which is the right answer where
   * a carrier is needed; the cases that ask what an unknown name does need the
   * empty list itself.
   */
  async carrierSuggestions(query: string): Promise<string[]> {
    await this.carrierSearch.scrollIntoViewIfNeeded();
    await this.carrierSearch.click({ force: true });
    await this.carrierSearch.fill('');
    await this.carrierSearch.pressSequentially(query, { delay: 110 });
    await this.suggestions
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    await settledCount(this.suggestions, { quiet: 1_200, timeout: 10_000 });

    const texts: string[] = [];
    for (let i = 0; i < (await this.suggestions.count()); i++) {
      texts.push((await this.suggestions.nth(i).innerText()).replace(/\s+/g, ' ').trim());
    }
    return texts;
  }

  /** Empties the carrier box the way a person would, and closes the list. */
  async clearCarrier() {
    await this.carrierSearch.click({ force: true });
    await this.carrierSearch.fill('');
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(1_500);
  }

  async selectedCarrier(): Promise<string> {
    return this.carrierSearch.inputValue();
  }

  async dispatch() {
    await this.sendToCarrier.scrollIntoViewIfNeeded();
    await this.sendToCarrier.click();
    await this.page.waitForTimeout(8_000);
  }

  async recordSnackbars() {
    await recordSnackbars(this.page);
  }

  async snackbars(): Promise<string[]> {
    return readSnackbars(this.page);
  }

  async clearSnackbars() {
    await clearSnackbars(this.page);
  }
}
