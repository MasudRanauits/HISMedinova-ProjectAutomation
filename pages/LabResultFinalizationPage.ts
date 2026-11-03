import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';
import { LabResultEntryPage } from './LabResultEntryPage';

export type { ResultField, ResultTab, EnteredResult } from './LabResultEntryPage';

/**
 * Lab Result Finalization (/diagnosis/pathology-result-finalized).
 *
 * The pathologist's screen: the same report LAB Result Entry writes, reopened
 * for the results to be checked and the report signed off. An invoice appears
 * on its Pending tab once its results have been saved on the entry screen, so
 * an invoice that has not been through result entry is never here.
 *
 * Because it is that screen twice over — same panels, same tabs, same report —
 * it subclasses `LabResultEntryPage` and changes only the things that actually
 * differ: the route, the prefix the app gives the filter boxes (`lrfp-` rather
 * than `prse-`), and the two buttons the entry screen has no use for —
 * Finalize and Undo. It also sits behind an account with a much shorter menu
 * than the administrator's — see `gotoViaMenu`.
 *
 * ## Finalize and Undo are one button's worth of state
 *
 * The buttons under the report say which side of sign-off it is on, and reading
 * them is the cheapest way to ask:
 *
 * | Report        | Save | Finalize | Undo     |
 * | ------------- | ---- | -------- | -------- |
 * | not finalized | yes  | **yes**  | disabled |
 * | finalized     | yes  | gone     | enabled  |
 *
 * So Finalize is not merely disabled once it has been pressed — it is no longer
 * drawn at all, and the Undo beside it comes alive in its place. `isFinalized`
 * asks exactly that question, and it is what the spec checks after pressing
 * Finalize rather than trusting the snackbar, which lasts about a second.
 */
export class LabResultFinalizationPage extends LabResultEntryPage {
  protected readonly route = ROUTES.labResultFinalization;
  readonly finalizeButton: Locator;
  readonly undoButton: Locator;
  readonly diagnosticMenu: Locator;
  readonly menuLink: Locator;

  constructor(page: Page) {
    super(page, 'lrfp');

    // The green button beside Save. Anchored, because "Finalize" is also a word
    // in the screen's own title ("Lab Result Finalization") and in the menu link
    // that reaches it.
    this.finalizeButton = page.getByRole('button', { name: /^finali[sz]e$/i });
    this.undoButton = page.getByRole('button', { name: /^undo$/i });
    this.diagnosticMenu = page.getByText(/^\s*diagnostic\s*$/i);
    this.menuLink = page.getByRole('link', { name: /lab result finalization/i });
  }

  /**
   * Opens the screen the way a person does — through the Diagnostic menu rather
   * than by typing the route.
   *
   * Worth doing at least once: the menu is built from the signed-in account's
   * permissions, so arriving this way proves the pathologist can actually reach
   * the screen, which `goto` on the route alone would not.
   */
  async gotoViaMenu() {
    await this.page.goto(ROUTES.home);
    await expect(this.diagnosticMenu.first()).toBeVisible({ timeout: 60_000 });
    await this.diagnosticMenu.first().click();

    await expect(this.menuLink.first()).toBeVisible({ timeout: 60_000 });
    await this.menuLink.first().click();

    await expect(this.page).toHaveURL(new RegExp(ROUTES.labResultFinalization), { timeout: 60_000 });
    await expect(this.invoiceNo).toBeVisible({ timeout: 60_000 });
    await expect(this.showButton).toBeVisible({ timeout: 60_000 });
  }

  /** The invoice number as the row itself prints it, for checking the match. */
  async listedInvoiceNo(invoiceNo: string): Promise<string> {
    const cell = await this.invoiceRow(invoiceNo).locator('td').first().innerText();
    return cell.replace(/\s+/g, ' ').trim();
  }

  /**
   * Whether the report on screen has been signed off.
   *
   * Read off the buttons rather than off any status text, because the screen
   * draws no status: a report still to be finalized offers Finalize with Undo
   * greyed beside it, and a finalized one drops Finalize entirely and lets Undo
   * work. Both halves are checked, so a build that merely disabled Finalize
   * instead of removing it would be reported rather than read as finalized.
   */
  async isFinalized(): Promise<boolean> {
    const offersFinalize = (await this.finalizeButton.count())
      ? await this.finalizeButton.first().isVisible()
      : false;
    const canUndo = (await this.undoButton.count())
      ? await this.undoButton.first().isEnabled()
      : false;

    return !offersFinalize && canUndo;
  }

  /**
   * The buttons drawn under the report, for the record.
   *
   * Worth logging around a finalize: which buttons the screen is offering is
   * the whole of what it says about the report's state, so a run that ends up
   * somewhere unexpected has the before and after in its output.
   */
  async reportActions(): Promise<string[]> {
    return this.page.evaluate(() =>
      Array.prototype.slice
        .call(document.querySelectorAll('button'))
        .filter((b: any) => {
          const box = b.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((b: any) => {
          const text = (b.innerText || '').replace(/\s+/g, ' ').trim();
          return b.disabled ? `${text} (disabled)` : text;
        })
        .filter((t: string) => /^(save|finali[sz]e|undo|clear form)\b/i.test(t)),
    );
  }

  /**
   * Signs the report off.
   *
   * Given the same eight seconds `save` takes: the press posts the whole report
   * and the screen redraws its buttons on the way back, and the caller's next
   * question is nearly always whether Finalize has gone — which it cannot
   * answer until that redraw has landed.
   */
  async finalize() {
    await expect(
      this.finalizeButton,
      'there is no Finalize button under this report. The screen draws one only while the report is still to ' +
        'be signed off, so this is a report that has already been finalized — reopen a pending one, or press ' +
        'Undo on this one first.',
    ).toBeVisible({ timeout: 30_000 });

    await this.finalizeButton.scrollIntoViewIfNeeded();
    await this.finalizeButton.click();
    await this.page.waitForTimeout(8_000);
  }

  /** Takes a finalized report back to pending, which is what Undo is for. */
  async undo() {
    await expect(this.undoButton, 'there is no Undo button under this report').toBeEnabled({
      timeout: 30_000,
    });

    await this.undoButton.scrollIntoViewIfNeeded();
    await this.undoButton.click();
    await this.page.waitForTimeout(8_000);
  }
}
