import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { clearSnackbars, readSnackbars, recordSnackbars } from '../utils/snackbars';
import { settledCount, settledValue } from '../utils/blazor';

/** One line of the Test List grid. */
export type BilledTest = {
  code: string;
  name: string;
  rate: number;
  qty: number;
  total: number;
  discountPercent: number;
  discount: number;
};

/** One line of the Transaction History grid. */
export type Transaction = {
  date: string;
  debit: number;
  credit: number;
  /** "Service Cost" for the bill itself, "DueCollection(Cash)" for a collection. */
  description: string;
  /** Card or wallet the money came in on; empty for cash. */
  instrument: string;
  user: string;
};

/** The right-hand money panel, read as numbers. */
export type DueTotals = {
  subTotal: number;
  discountPercent: number;
  discountTaka: number;
  netPayable: number;
  /** What the counter has already taken against this bill. */
  previousPaid: number;
  /** What is being collected now — zero on a bill just loaded. */
  payment: number;
  dueAmount: number;
};

/** Who the bill belongs to, as the four read-only boxes across the top say. */
export type DueBill = {
  billNo: string;
  patientName: string;
  entryDate: string;
  age: string;
  entryUser: string;
};

/** The Select Card options, as the dropdown writes them. */
export type CardType = 'VISA' | 'MasterCard' | 'Nexus Card' | 'Credit Card';

/** The Select Mobile options, as the dropdown writes them. */
export type MobileOperator = 'BKash' | 'Nagod';

/** Turns "1,290.00" into 1290. An empty box reads as 0, not NaN. */
const amount = (text: string): number => {
  const cleaned = (text ?? '').replace(/[^\d.-]/g, '');
  return cleaned === '' ? 0 : Number(cleaned);
};

/** Escapes a label so it can be anchored in a regular expression. */
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Due Collection (/diagnostic/due-collection).
 *
 * Where the counter takes the rest of the money on a bill that was posted with
 * a due. One bill at a time: the Bill No box is typed into and **Enter** is
 * what fetches it — the screen carries no search button of its own, and the
 * round arrow beside the title is a Back link that leaves the page.
 *
 * The bill arrives read-only apart from the money panel on the right: Sub
 * Total, the two discount boxes and a discount category, Net Payable, Previous
 * Paid, Payment (Cash), Due Amount, then Select Card and Select Mobile, a
 * Remarks box and Print and Save.
 *
 * ## The instrument dropdowns grow the form
 *
 * Choosing a card adds a **POS** dropdown and a **Payment(Card)** box to the
 * panel, and choosing a mobile operator adds a **Payment(Mobile)** box. None of
 * them exists until its dropdown is set, which is how the screen stops a card
 * or wallet payment being entered without saying which card or which wallet —
 * the same shape the OPD entry screen uses for its own card and mobile boxes.
 *
 * Which method the money came in on is recorded on the bill: the Transaction
 * History line reads "DueCollection(Cash)", "DueCollection(Card-EBL POS)" or
 * "DueCollection(Mobile-BKash)", so `transactions` is where a payment-method
 * test reads its result back.
 *
 * ## One counter at a time
 *
 * The screen takes a lock on the bill it loads. A second PC opening the same
 * bill is told "Due collection for this bill is open on another PC — <user>
 * (<address>) since <time>", and gets the whole panel disabled, Save included,
 * until the first one is done. `lockNotice` reads that banner, and a spec that
 * collects money should check it before it types anything: a run that silently
 * did nothing because another counter held the bill would otherwise look like a
 * pass.
 *
 * The lock belongs to the Blazor **circuit**, and outlives it by five or six
 * minutes. `goto` starts a fresh circuit, so coming back to this screen between
 * collections locks a spec out of its own bill; fetch it again with `load`
 * instead, which stays on the circuit that already holds it, and navigate away
 * once — deliberately — when the work is done.
 */
export class DueCollectionPage {
  readonly page: Page;
  readonly billNo: Locator;
  readonly patientName: Locator;
  readonly entryDate: Locator;
  readonly age: Locator;
  readonly entryUser: Locator;
  readonly subTotal: Locator;
  readonly discountPercent: Locator;
  readonly discountTaka: Locator;
  readonly discountCategory: Locator;
  readonly netPayable: Locator;
  readonly previousPaid: Locator;
  readonly cashPayment: Locator;
  readonly dueAmount: Locator;
  readonly cardType: Locator;
  readonly mobileOperator: Locator;
  readonly remarks: Locator;
  readonly saveButton: Locator;
  readonly printButton: Locator;
  readonly testGrid: Locator;
  readonly transactionGrid: Locator;
  readonly lockBanner: Locator;

  constructor(page: Page) {
    this.page = page;

    // The only box on the screen with a name of its own.
    this.billNo = page.locator('input[name="BillNo"]');

    this.patientName = this.field('Patient Name');
    this.entryDate = this.field('Entry Date');
    this.age = this.field('Age');
    this.entryUser = this.field('Entry User');

    this.subTotal = this.field('Sub Total');
    this.discountPercent = this.field('Disc(%)');
    this.discountTaka = this.field('Disc(Tk)');
    this.discountCategory = this.field('D.Category');
    this.netPayable = this.field('Net Payable');
    this.previousPaid = this.field('Previous Paid');
    this.cashPayment = this.field(/^payment\s*\(cash\)$/i);
    this.dueAmount = this.field('Due Amount');
    this.cardType = this.field('Select Card');
    this.mobileOperator = this.field('Select Mobile');
    this.remarks = this.field('Remarks');

    this.saveButton = page.getByRole('button', { name: /^save$/i }).first();
    this.printButton = page.getByRole('button', { name: /^print$/i }).first();

    this.testGrid = page
      .locator('table')
      .filter({ has: page.locator('th', { hasText: /test code/i }) })
      .first();
    this.transactionGrid = page
      .locator('table')
      .filter({ has: page.locator('th', { hasText: /debit/i }) })
      .first();

    this.lockBanner = page.locator('div').filter({ hasText: /open on another PC/i }).last();
  }

  /**
   * A box by the label above it.
   *
   * Every field on this screen is a `<label class="form-label">` and its input
   * inside one `.form-group`, and the ids are regenerated per circuit
   * ("0HNPOPT61CFLG"), so the label is the only stable handle. The pairing is
   * what keeps "Disc(%)" off the identically-titled column in the test grid:
   * that heading is a `<div>` in a `<th>`, not a label, and lives in no
   * form-group at all.
   *
   * A pattern is taken as well as a name, for the two boxes whose labels are
   * written inconsistently: the cash one reads "Payment (Cash)" with a space
   * and the other two "Payment(Card)" and "Payment(Mobile)" without one.
   */
  private field(label: string | RegExp): Locator {
    const name = typeof label === 'string' ? new RegExp(`^${esc(label)}$`, 'i') : label;
    return this.page
      .locator('.form-group')
      .filter({ has: this.page.locator('label.form-label').filter({ hasText: name }) })
      .locator('input, select')
      .first();
  }

  async goto() {
    await this.page.goto(ROUTES.dueCollection);
    await expect(this.billNo, 'the Bill No box').toBeVisible({ timeout: 60_000 });
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

  /**
   * Fetches a bill into the form.
   *
   * **Enter** is what sends it: the Bill No box has no search button beside it,
   * and the circular arrow at the top of the screen is a Back link — clicking
   * that leaves Due Collection altogether. The box is a number input, so the
   * bill is given by its digits: the dashboard prints MDH2611020200005 and this
   * screen is handed 2611020200005.
   *
   * Comes back `false` if nothing was found, which is how the screen says a
   * bill number does not exist — the boxes simply stay empty, with no message.
   *
   * ## Why the money panel is waited on separately
   *
   * Re-fetching a bill that is already on screen leaves the top boxes filled
   * throughout — the patient's name never blanks — so "the name is there" says
   * nothing about whether the new figures have arrived. Reading the panel
   * straight after Enter therefore hands back the *previous* fetch's numbers:
   * that is what made a run of this read Previous Paid 0 on a bill it had just
   * settled, with the screen showing 290 a second later. So the panel is waited
   * on until it stops moving rather than read at a fixed moment (utils/blazor).
   */
  async load(billNo: string): Promise<boolean> {
    const digits = billNo.replace(/\D/g, '');
    await expect(this.billNo, 'the Bill No box').toBeVisible({ timeout: 60_000 });
    await this.billNo.click();
    await this.billNo.fill(digits);
    await this.billNo.press('Enter');

    // One round trip over the circuit to fetch the bill, its tests and its
    // transactions; on a busy server that is several seconds.
    const loaded = await expect
      .poll(async () => (await this.patientName.inputValue()).trim(), {
        message: `bill ${digits} should have loaded a patient`,
        timeout: 45_000,
      })
      .not.toBe('')
      .then(() => true)
      .catch(() => false);

    if (!loaded) {
      console.log(`bill ${digits}: nothing loaded`);
      return false;
    }

    // The figures and the two grids are filled a beat after the name is, and on
    // a re-fetch they are replaced in place — see above.
    await settledValue(this.previousPaid, { quiet: 2_500, timeout: 45_000 });
    await settledValue(this.dueAmount, { quiet: 1_500, timeout: 45_000 });
    await settledCount(this.transactionGrid.locator('tbody tr'), { quiet: 1_500, timeout: 45_000 });

    return true;
  }

  /** The four read-only boxes across the top, plus the number asked for. */
  async details(): Promise<DueBill> {
    return {
      billNo: await this.billNo.inputValue(),
      patientName: (await this.patientName.inputValue()).trim(),
      entryDate: (await this.entryDate.inputValue()).trim(),
      age: (await this.age.inputValue()).trim(),
      entryUser: (await this.entryUser.inputValue()).trim(),
    };
  }

  /** The money panel on the right, as numbers. */
  async totals(): Promise<DueTotals> {
    return {
      subTotal: amount(await this.subTotal.inputValue()),
      discountPercent: amount(await this.discountPercent.inputValue()),
      discountTaka: amount(await this.discountTaka.inputValue()),
      netPayable: amount(await this.netPayable.inputValue()),
      previousPaid: amount(await this.previousPaid.inputValue()),
      payment: amount(await this.cashPayment.inputValue()),
      dueAmount: amount(await this.dueAmount.inputValue()),
    };
  }

  /** What the bill was raised for. */
  async tests(): Promise<BilledTest[]> {
    const rows = this.testGrid.locator('tbody tr');
    const out: BilledTest[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const cells = (await rows.nth(i).locator('td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      if (cells.length < 7) continue;
      const [code, name, rate, qty, total, discountPercent, discount] = cells;
      out.push({
        code,
        name,
        rate: amount(rate),
        qty: amount(qty),
        total: amount(total),
        discountPercent: amount(discountPercent),
        discount: amount(discount),
      });
    }

    return out;
  }

  /**
   * Every movement on the bill, oldest first.
   *
   * The bill itself is the first line — "Service Cost", debited — and each
   * collection lands under it as a credit, described as "DueCollection(Cash)"
   * and so on. This is the only place on the screen that says how a payment was
   * taken, so it is what a payment-method test reads.
   */
  async transactions(): Promise<Transaction[]> {
    const rows = this.transactionGrid.locator('tbody tr');
    const out: Transaction[] = [];

    for (let i = 0; i < (await rows.count()); i++) {
      const cells = (await rows.nth(i).locator('td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      if (cells.length < 6) continue;
      const [date, debit, credit, description, instrument, user] = cells;
      out.push({ date, debit: amount(debit), credit: amount(credit), description, instrument, user });
    }

    return out;
  }

  /**
   * The "open on another PC" banner, or '' when the bill is this counter's to
   * collect.
   *
   * Worth reading before anything is typed. The lock disables the whole money
   * panel, Save included, so a test that went ahead regardless would fill
   * nothing in, save nothing, and — if it only checked that no error appeared —
   * pass.
   */
  async lockNotice(): Promise<string> {
    if (!(await this.lockBanner.count())) return '';
    const text = (await this.lockBanner.first().innerText()).replace(/\s+/g, ' ').trim();
    return /open on another PC/i.test(text) ? text : '';
  }

  /** Whether the money panel can be used at all — see `lockNotice`. */
  async collectable(): Promise<boolean> {
    return !(await this.cashPayment.isDisabled());
  }

  /**
   * Types an amount into one of the payment boxes and waits for Due Amount to
   * catch up.
   *
   * Blazor re-renders the panel on every keystroke, so the box is typed into
   * rather than filled, and the due is polled rather than read once: the
   * subtraction is done on the server and arrives a round trip after the box
   * is blurred.
   */
  private async enterAmount(box: Locator, value: number) {
    await box.scrollIntoViewIfNeeded();
    await box.click({ force: true });
    await box.press('ControlOrMeta+a');
    await box.pressSequentially(String(value), { delay: 80 });
    await box.press('Tab');
    await this.page.waitForTimeout(2_000);
  }

  /** Collects in cash. */
  async payCash(value: number) {
    await this.enterAmount(this.cashPayment, value);
  }

  /**
   * Picks a card, then collects on it.
   *
   * Choosing the card is what grows the panel a **POS** dropdown and a card
   * payment box; neither exists before. The POS is taken as the first real
   * terminal on the list, since which one is irrelevant to the amount.
   */
  async payByCard(card: CardType, value: number) {
    await this.cardType.selectOption({ label: card });
    await this.page.waitForTimeout(3_000);

    const pos = this.field('POS');
    if (await pos.count()) {
      const options = await pos.locator('option').allInnerTexts();
      if (options.length > 1) {
        await pos.selectOption({ index: 1 });
        await this.page.waitForTimeout(2_000);
      }
    }

    await this.enterAmount(this.field(/^payment\s*\(card\)$/i), value);
  }

  /** Picks a wallet, then collects on it. The box only exists once it is picked. */
  async payByMobile(operator: MobileOperator, value: number) {
    await this.mobileOperator.selectOption({ label: operator });
    await this.page.waitForTimeout(3_000);
    await this.enterAmount(this.field(/^payment\s*\(mobile\)$/i), value);
  }

  async setRemarks(text: string) {
    await this.remarks.fill(text);
    await this.remarks.press('Tab');
  }

  /**
   * Whether Save is offered at all.
   *
   * Disabled before a bill is fetched, and left enabled on a bill settled in
   * full — where pressing it is refused all the same, with "Nothing to collect
   * -- enter a payment or a discount first." So this says what the screen
   * offers, not what it will accept.
   */
  async canSave(): Promise<boolean> {
    return this.saveButton.isEnabled();
  }

  /**
   * Commits the collection.
   *
   * The outcome is only ever reported in a snackbar, and it reads "Due
   * collected." rather than the "Successful Save!" the entry screen answers
   * with.
   */
  async save() {
    await this.saveButton.scrollIntoViewIfNeeded();
    await this.saveButton.click();
  }
}
