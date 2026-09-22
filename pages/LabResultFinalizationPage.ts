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
 * it subclasses `LabResultEntryPage` and changes only the three things that
 * actually differ: the route, the prefix the app gives the filter boxes
 * (`lrfp-` rather than `prse-`), and an Undo button the entry screen has no use
 * for. It also sits behind an account with a much shorter menu than the
 * administrator's — see `gotoViaMenu`.
 */
export class LabResultFinalizationPage extends LabResultEntryPage {
  protected readonly route = ROUTES.labResultFinalization;
  readonly undoButton: Locator;
  readonly diagnosticMenu: Locator;
  readonly menuLink: Locator;

  constructor(page: Page) {
    super(page, 'lrfp');

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
}
