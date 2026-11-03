import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { waitForCircuit } from '../utils/blazor';
import { InvestigationPage, InvestigationTotals } from './InvestigationPage';

/**
 * The corporate summary strip, in its own words.
 *
 * It is not the Billing One strip relabelled. There is no "Sub total" and no
 * "Net payable": the bill runs Total(Tk) → Discountable(Tk) → discount →
 * G.Total(Tk) → Due amount, with "Corporate billing" above it carrying the
 * share the company is invoiced for rather than the patient.
 */
export type CorporateTotals = {
  /** The part billed to the company rather than collected at the counter. */
  corporateBilling: number;
  /** Total(Tk) — what the tests come to before any discount. */
  total: number;
  discountable: number;
  /** G.Total(Tk) — the grand total after the discount. */
  gTotal: number;
  due: number;
};

/**
 * OPD Investigation Entry, Corporate Patient tab (/diagnostic/investigation).
 *
 * The sixth counter on the screen, and the only one that bills a company. It is
 * the same form as the five billing tabs in most respects — same patient
 * lookup, same demographics, same test grid, same autocompletes — so it
 * subclasses `InvestigationPage` and changes only what actually differs.
 *
 * ## What differs
 *
 * | | Billing One … Five | Corporate Patient |
 * | --- | --- | --- |
 * | Corporate client | — | **required**, "Client search…" |
 * | Media | yes | — |
 * | D. Category | yes | — |
 * | Totals | Sub total → Net payable | Total(Tk) → G.Total(Tk) |
 * | Payment | cash, card, mobile | cash, card, mobile, **cheque, bank deposit, pay order** |
 * | Card types | Credit Card | VISA, MasterCard, Nexus Card, Credit Card |
 *
 * ## Why nearly every locator here is scoped to `.cor2`
 *
 * The six tabs are six panes of one document, and switching tab does not take
 * the previous pane out of it — it only hides it. Billing One's summary strip
 * is therefore still in the markup while the corporate tab is on screen,
 * carrying a `Payment (cash)` label of its own, and the base class finds its
 * payment box with an xpath that takes the *first* such label in document
 * order. On this tab that is Billing One's, and it is hidden: filling it puts
 * the money on the wrong bill and the corporate due amount never moves.
 *
 * So the corporate panel's own root — `.cor2`, matching Billing One's `.inv2` —
 * is what everything below hangs off. The same trap is why `fullName` and
 * `mobile` are re-pointed: Billing One's boxes carry the ids `#FullName` and
 * `#mobile`, and the corporate pane's carry per-circuit ids instead, so the
 * inherited locators would find nothing here at all.
 */
export class CorporatePatientPage extends InvestigationPage {
  /** The corporate pane's root. Billing One's is `.inv2`. */
  readonly panel: Locator;
  /** The company the bill is raised against. Required before POST. */
  readonly corporateClient: Locator;
  readonly chequePayment: Locator;
  readonly bankDepositPayment: Locator;
  readonly payOrderPayment: Locator;
  /** Reopens the demographics editor once a lookup has collapsed it. */
  readonly editSearchButton: Locator;
  /** Empties the patient out of the bar and brings the editor back. */
  readonly clearPatientButton: Locator;

  constructor(page: Page) {
    super(page);

    this.panel = page.locator('.cor2');

    // Everything below is the inherited locator, re-pointed inside this pane.
    // Scoping is not a tidiness measure here: with Billing One's pane still in
    // the markup, `input[placeholder="12-digit UHID"]` matches twice and the
    // hidden one comes first, so the unscoped locators fill the wrong form.
    this.uhid = this.panel.locator('input[placeholder="12-digit UHID"]');
    this.searchButton = this.panel.getByRole('button', { name: /^search$/i }).first();

    // `#FullName` and `#mobile` are Billing One's ids; this pane names its
    // boxes per circuit, so they are found by placeholder instead.
    this.fullName = this.panel.locator('input[placeholder="Patient name"]');
    // Two boxes carry this placeholder — the search bar's at the top of the
    // pane and the patient's in the demographics row. The second is the one.
    this.mobile = this.panel.locator('input[placeholder="Mobile No"]').nth(1);

    // `#ageyear` is an id this pane shares with Billing One's, which is invalid
    // markup and matches twice while both panes are in the document.
    this.ageYears = this.panel.locator('#ageyear');
    this.ageMonths = this.panel.locator('input[placeholder="M"]');
    this.ageDays = this.panel.locator('input[placeholder="D"]');
    this.title = this.panel.locator('select.form-select-sm').filter({ hasText: 'Miss' }).first();
    this.gender = this.panel.locator('select.form-select-sm').filter({ hasText: 'Female' }).first();
    this.dateOfBirth = this.panel.locator('input.input.form-control').first();

    this.doctorSearch = this.panel.locator('input[placeholder="Doctor search..."]');
    this.testSearch = this.panel.locator('input[placeholder="Search test by name or code..."]');
    this.packageSearch = this.panel.locator('input[placeholder="Search OPD package..."]');
    this.remarks = this.panel.locator('input[placeholder="Optional notes..."]');

    this.grid = this.panel.locator('table').first();
    this.postButton = this.panel.getByRole('button', { name: /^post$/i });
    this.printButton = this.panel.getByRole('button', { name: /print$/i }).first();

    this.corporateClient = this.panel.locator('input[placeholder="Client search..."]');

    // The base finds these two with an absolute xpath, which no amount of
    // scoping narrows; and "Disc(%)" is a column heading in the test grid as
    // well as a box on the strip, so the heading has to be left out. Both are
    // `div.cor2-fg > label + div.b-numeric > input`, which `labelled` handles.
    this.discountPercent = this.labelled('Disc(%)');
    this.discountTaka = this.labelled('Disc(Tk)');

    this.paymentAmount = this.labelled('Payment (cash)');
    this.chequePayment = this.labelled('Payment (Cheque)');
    this.bankDepositPayment = this.labelled('Payment (Bank Deposit)');
    this.payOrderPayment = this.labelled('Payment (Pay Order)');

    // The two buttons the collapsed patient bar offers.
    this.editSearchButton = this.panel
      .locator('button.cor2-bar-btn')
      .filter({ hasText: /edit/i })
      .first();
    this.clearPatientButton = this.panel.locator('button.cor2-bar-btn.danger').first();
  }

  /**
   * The input belonging to a label, looked for inside the corporate pane.
   *
   * Found by walking down from the label's own container rather than with an
   * xpath `following::` step. Two reasons: the pane lays its payment boxes out
   * two different ways — the three it adds are `div.form-group > label +
   * input`, while the cash box is `div.cor2-summary-row > span + div.b-numeric
   * > input` — and, more to the point, a `following::` axis walks out of the
   * subtree it was scoped to. Playwright then throws those matches away for
   * being outside `.cor2` and the locator resolves to nothing at all, which is
   * how this first went in reporting that the corporate tab had no cheque box.
   */
  private labelled(text: string): Locator {
    return this.panel
      .locator('.form-group, .cor2-summary-row, .cor2-fg')
      .filter({ has: this.page.getByText(text, { exact: true }) })
      .first()
      .locator('input')
      .first();
  }

  /**
   * Opens the screen and switches to the corporate counter.
   *
   * It cannot simply call the base and then switch: every locator on this class
   * hangs off `.cor2`, and `.cor2` is not in the document until the corporate
   * tab has been opened — so the base's own arrival check, which waits for
   * *this* class's UHID box, would wait for something that only appears once
   * the thing it is gating has already happened. The screen is therefore waited
   * for on Billing One's terms first, and on this pane's terms after the
   * switch.
   */
  async goto() {
    await this.page.goto(ROUTES.investigation);
    await expect(this.page).toHaveURL(new RegExp(ROUTES.investigation));

    // Billing One is what the screen opens on; this is it being ready.
    await expect(
      this.page.locator('input[placeholder="Search test by name or code..."]:visible').first(),
    ).toBeVisible({ timeout: 60_000 });
    // The fields are drawn before the circuit is up, and a form on a dead
    // circuit takes input without doing anything about it — see utils/blazor.
    await waitForCircuit(this.page);

    await this.selectTab('Corporate Patient');

    await expect(this.uhid).toBeVisible({ timeout: 60_000 });
    await expect(this.corporateClient).toBeVisible({ timeout: 60_000 });
  }

  /** Picks the company the bill is raised against, and returns its name. */
  async setCorporateClient(query: string, match?: RegExp): Promise<string> {
    return this.pickSuggestion(this.corporateClient, query, match);
  }

  /**
   * Whether the demographics editor has collapsed into the patient bar.
   *
   * It collapses the moment a UHID lookup succeeds — the form of fields is
   * replaced by a one-line summary with "Edit / Search" and "Clear" on the end
   * of it — so after a lookup there is no Patient name box, no Mobile No box,
   * no client box and no doctor box until the editor is opened again.
   */
  async isCollapsed(): Promise<boolean> {
    return (await this.fullName.count()) === 0 && (await this.editSearchButton.count()) > 0;
  }

  /**
   * Brings the demographics editor back, and does nothing if it is already up.
   *
   * The fields come back carrying what the lookup found, so this is also how
   * the patient's mobile number is read: the bar does not print it.
   */
  async expandEditor() {
    if (!(await this.isCollapsed())) return;

    await this.editSearchButton.click();
    await expect(this.fullName).toBeVisible({ timeout: 60_000 });
    await this.page.waitForTimeout(2_000);
  }

  /**
   * The collapsed bar, read apart.
   *
   * It prints "UHID … NAME … AGE … GENDER … CORPORATE … REF …" in that order,
   * with an em dash standing in for anything not set, and the company's
   * contract expiry tacked onto its name ("PRIME Bank Ltd. exp: 31/05/28").
   * Each field is taken up to the label that follows it, which is what keeps a
   * two-word patient name or a company name with spaces in one piece.
   */
  async patientBar(): Promise<{
    uhid: string;
    name: string;
    age: string;
    gender: string;
    corporate: string;
    referredBy: string;
  }> {
    const text = (await this.panel.innerText()).replace(/\s+/g, ' ').trim();
    const between = (from: string, to: string) =>
      (text.match(new RegExp(`${from}\\s+(.*?)\\s+${to}`, 'i'))?.[1] ?? '').trim();

    // An em dash is the bar's way of saying "nothing here".
    const unset = (value: string) => (/^[—–-]$/.test(value) ? '' : value);

    return {
      uhid: between('UHID', 'NAME'),
      name: between('NAME', 'AGE'),
      age: between('AGE', 'GENDER'),
      gender: between('GENDER', 'CORPORATE'),
      corporate: unset(between('CORPORATE', 'REF')),
      referredBy: unset(between('REF', 'Edit / Search')),
    };
  }

  /**
   * Loads a patient by UHID and returns the name the lookup found.
   *
   * Overridden because the base reads the name back out of the Patient name
   * box, and on this tab a successful lookup is exactly what takes that box
   * away — it collapses the editor into the patient bar. The base's wait would
   * sit on a field that the thing it is waiting for has just removed.
   *
   * Two things worth knowing about what the lookup does to the rest of the
   * form, both established against UHID 261000665802 on 2026-11-02: a
   * corporate client chosen beforehand **survives** it, and is shown in the bar
   * with its contract expiry; a referring doctor chosen beforehand **does
   * not** — the bar comes back reading "REF —" and the box is empty when the
   * editor is reopened. So the doctor is set after the lookup rather than
   * before it (see `TC-C03`, which pins that behaviour down).
   */
  async searchByUhid(uhid: string): Promise<string> {
    await this.uhid.fill(uhid);
    await this.searchButton.click();

    // The bar appearing is the lookup having landed.
    await expect(
      this.editSearchButton,
      `UHID ${uhid} did not load a patient — the corporate pane never collapsed into its patient bar`,
    ).toBeVisible({ timeout: 60_000 });
    await this.page.waitForTimeout(2_000);

    return (await this.patientBar()).name;
  }

  /** Whatever the client box is holding, for the record. */
  async selectedClient(): Promise<string> {
    return (await this.corporateClient.inputValue()).trim();
  }

  /**
   * What the screen makes of the client box: 'valid', 'invalid' or 'unknown'.
   *
   * Blazorise marks the autocomplete's wrapper `dropdown-invalid` while no
   * company has been chosen and `dropdown-valid` once one has. It is the only
   * thing the screen says about the field before POST — the button stays
   * enabled either way — so it is what a test can check without putting a bill
   * on the live ledger to find out.
   */
  async clientValidity(): Promise<'valid' | 'invalid' | 'unknown'> {
    const wrapper = this.panel
      .locator('.b-is-autocomplete')
      .filter({ has: this.page.locator('input[placeholder="Client search..."]') })
      .first();

    const classes = (await wrapper.getAttribute('class')) ?? '';
    if (/dropdown-invalid/.test(classes)) return 'invalid';
    if (/dropdown-valid/.test(classes)) return 'valid';
    return 'unknown';
  }

  /**
   * One figure off the corporate strip.
   *
   * Read out of `.cor2-summary-row` rather than scraped from the page text,
   * because "Total(Tk)" is a substring of "G.Total(Tk)" and a text match on the
   * first would happily return the second.
   */
  async corporateTotalsRow(label: RegExp): Promise<number> {
    const row = this.panel
      .locator('.cor2-summary-row')
      .filter({ has: this.page.locator('.cor2-summary-label').filter({ hasText: label }) })
      .first();

    const value = (await row.locator('.cor2-summary-val').first().innerText()).replace(/,/g, '').trim();
    return Number(value);
  }

  /** The corporate strip, in full. */
  async corporateTotals(): Promise<CorporateTotals> {
    // "Corporate billing" heads the panel rather than sitting in the strip, so
    // it is the one figure still read as text.
    const text = (await this.panel.innerText()).replace(/\s+/g, ' ');
    const billed = text.match(/Corporate billing\s+([\d.,]+)/i)?.[1] ?? '0';

    return {
      corporateBilling: Number(billed.replace(/,/g, '')),
      total: await this.corporateTotalsRow(/^Total\(Tk\)$/i),
      discountable: await this.corporateTotalsRow(/^Discountable\(Tk\)$/i),
      gTotal: await this.corporateTotalsRow(/^G\.Total\(Tk\)$/i),
      due: await this.corporateTotalsRow(/^Due amount$/i),
    };
  }

  /**
   * The corporate strip in the shape the base class speaks.
   *
   * Overridden rather than left inherited: the base reads "Sub total" and "Net
   * payable" out of the page text, and on this tab the only elements carrying
   * those words are Billing One's — hidden, and holding a different bill. It
   * would return figures, and they would be the wrong ones.
   *
   * `Total(Tk)` stands in for `subTotal` and `G.Total(Tk)` for `netPayable`,
   * which are the same positions in the sum. Mapping it this way is what lets
   * the inherited `settledTotals()` — the read-until-it-stops-moving helper
   * every totals assertion needs — work here unchanged.
   */
  async totals(): Promise<InvestigationTotals> {
    const corporate = await this.corporateTotals();

    return {
      subTotal: corporate.total,
      discountable: corporate.discountable,
      netPayable: corporate.gTotal,
      due: corporate.due,
    };
  }

  /**
   * Types an amount into one of the three payment boxes this tab adds.
   *
   * They are plain text inputs rather than the Blazorise numeric edit the cash
   * box is, but they bind the same way — on blur — so they are typed and
   * tabbed out of like `payCash` does.
   */
  async payInto(box: Locator, amount: number) {
    await box.scrollIntoViewIfNeeded();
    await box.click({ force: true });
    await box.press('ControlOrMeta+a');
    await box.pressSequentially(String(amount), { delay: 100 });
    await box.press('Tab');
    await this.page.waitForTimeout(2_000);
  }

  async payByCheque(amount: number) {
    await this.payInto(this.chequePayment, amount);
  }

  async payByBankDeposit(amount: number) {
    await this.payInto(this.bankDepositPayment, amount);
  }

  async payByPayOrder(amount: number) {
    await this.payInto(this.payOrderPayment, amount);
  }
}
