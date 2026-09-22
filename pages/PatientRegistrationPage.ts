import { Locator, Page, expect } from '@playwright/test';
import { ROUTES } from '../utils/constants';

/**
 * A patient as the "Create Patient" form accepts it.
 *
 * The form marks `fullName`, `gender`, `mobile` and `district` required, and
 * rejects a save without `dateOfBirth`. Everything else is optional and is
 * skipped when left undefined.
 */
export type PatientData = {
  title?: string;
  fullName: string;
  givenName?: string;
  surname?: string;
  gender: string;
  /**
   * Typed into the flatpickr input, which expects DD-MM-YYYY; age is derived
   * from it. The form does not mark this required, but saving without it fails
   * on "Age cannot be zero", so every valid patient needs one.
   */
  dateOfBirth: string;
  maritalStatus?: string;
  religion?: string;
  bloodGroup?: string;
  fatherName?: string;
  motherName?: string;
  spouse?: string;
  mobile: string;
  email?: string;
  idType?: string;
  idNo?: string;
  occupation?: string;
  houseNo?: string;
  roadNo?: string;
  area?: string;
  village?: string;
  district: string;
  thana?: string;
  po?: string;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (value: string) => new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`, 'i');

/**
 * New patient registration (/hospital/patients/new).
 *
 * The page is MudBlazor, which generates a fresh element id per circuit, so
 * nothing here may key off an id. Every Mud field is reached through its
 * `.mud-input-control` wrapper, matched on the wrapper's own `<label>` — that
 * is the one piece of markup that stays put. The date of birth is a flatpickr
 * that sits outside the Mud controls and is matched on its class instead.
 */
export class PatientRegistrationPage {
  readonly page: Page;
  readonly dateOfBirth: Locator;
  readonly ageYears: Locator;
  readonly ageMonths: Locator;
  readonly ageDays: Locator;
  readonly confirmButton: Locator;
  readonly confirmDialog: Locator;

  constructor(page: Page) {
    this.page = page;

    // flatpickr renders a hidden original input plus this visible alternate one.
    this.dateOfBirth = page.locator('input.form-control.input');
    this.ageYears = page.locator('input[placeholder="Year"]');
    this.ageMonths = page.locator('input[placeholder="Month"]');
    this.ageDays = page.locator('input[placeholder="Day"]');

    // The app spells it "Confirm Registeration"; match loosely so a fix upstream
    // does not break the suite.
    this.confirmButton = page.getByRole('button', { name: /confirm\s+regist/i });
    this.confirmDialog = page.locator('.mud-dialog');
  }

  /** The MudBlazor wrapper whose own label is exactly `label`. */
  private control(label: string): Locator {
    return this.page
      .locator('.mud-input-control')
      .filter({ has: this.page.locator('label').filter({ hasText: exact(label) }) })
      .first();
  }

  /** The text input / textarea inside the field labelled `label`. */
  field(label: string): Locator {
    return this.control(label).locator('input, textarea').first();
  }

  async goto() {
    await this.page.goto(ROUTES.newPatient);
    await expect(this.page).toHaveURL(new RegExp(ROUTES.newPatient));
    await expect(this.confirmButton).toBeVisible({ timeout: 60_000 });
    await expect(this.field('Full Name')).toBeVisible({ timeout: 60_000 });
  }

  async fillPatient(data: PatientData) {
    // The date of birth goes in first, out of the order the form reads in,
    // because committing it blanks the identity row — Title, Full Name, Given
    // Name, Surname and Gender all come back empty. Filled last, as the layout
    // invites, it destroys the five fields above it; filled first, it has
    // nothing to destroy. `setDateOfBirth` then waits out the re-render that
    // does the blanking, so the fields below are typed after it has landed
    // rather than into its path. See README, "App quirks".
    await this.setDateOfBirth(data.dateOfBirth);

    await this.selectOption('Title', data.title);
    await this.fillField('Full Name', data.fullName);
    await this.fillField('Given Name', data.givenName);
    await this.fillField('Surname', data.surname);
    await this.selectOption('Gender', data.gender);

    await this.selectOption('Marital Status', data.maritalStatus);
    await this.selectOption('Religion', data.religion);
    await this.selectOption('Blood Group', data.bloodGroup);

    await this.fillField('Father Name', data.fatherName);
    await this.fillField('Mother Name', data.motherName);
    await this.fillField('Spouse', data.spouse);

    await this.fillField('Mobile No', data.mobile);
    await this.fillField('Email', data.email);
    await this.selectOption('ID Type', data.idType);
    await this.fillField('IDNo', data.idNo);
    await this.selectOption('Occupation', data.occupation);

    await this.fillField('House No', data.houseNo);
    await this.fillField('Road No', data.roadNo);
    await this.fillField('Area', data.area);
    await this.fillField('Village', data.village);
    await this.selectOption('District', data.district);
    // Thana options are loaded from the district, so it has to follow it.
    await this.selectOption('Thana', data.thana);
    await this.fillField('PO', data.po);
    // "Patient Address" is not filled: the app composes it from the fields above
    // and overwrites anything typed into it.
  }

  async fillField(label: string, value?: string) {
    if (value === undefined) return;
    const input = this.field(label);
    await input.scrollIntoViewIfNeeded();
    await input.fill(value);
  }

  /** Opens a MudSelect by its label and picks the entry whose text is exactly `value`. */
  async selectOption(label: string, value?: string) {
    if (value === undefined) return;

    const control = this.control(label);
    await control.scrollIntoViewIfNeeded();
    await control.locator('.mud-input').first().click();

    const popover = this.page.locator('.mud-popover-open');
    await popover.waitFor({ state: 'visible', timeout: 15_000 });

    // District and Thana list every upazila in the country behind a search box.
    const search = popover.locator('input[placeholder="Search..."]');
    if (await search.count()) {
      await search.fill(value);
    }

    await popover.locator('.mud-list-item').filter({ hasText: exact(value) }).first().click();
    await expect(popover).toBeHidden({ timeout: 15_000 });
  }

  /** flatpickr only commits a typed date on Enter; age is recalculated from it. */
  async setDateOfBirth(value: string) {
    await this.dateOfBirth.scrollIntoViewIfNeeded();
    await this.dateOfBirth.click();
    await this.dateOfBirth.fill('');
    await this.dateOfBirth.pressSequentially(value, { delay: 50 });
    await this.page.keyboard.press('Enter');
    await expect(this.dateOfBirth).toHaveValue(value);

    // Committing the date costs a round trip: the server works the age out and
    // re-renders with it, and that same render resets the identity row above to
    // empty. It lands about a second after the picker closes, which is long
    // enough for a caller to have typed a name into a field that is about to be
    // blanked — the cause of the intermittent "Full Name is empty" failure.
    // Waiting for the age to appear is waiting for that render, so callers that
    // set the date first find the row already reset and their typing sticks.
    // The suite registers adults, so a whole number of years is the signal; a
    // date inside the current year would need the months and days instead.
    await expect(this.ageYears).toHaveValue(/^[1-9]\d*$/, { timeout: 30_000 });
  }

  async confirmRegistration() {
    await this.confirmButton.scrollIntoViewIfNeeded();
    await this.confirmButton.click();
  }

  /**
   * Waits for the dialog the app raises on a successful save — "New Patient
   * SuccessFully Save, Patient ID 260900372802" — and returns that patient id.
   */
  async expectRegistered(): Promise<string> {
    const message = this.confirmDialog.getByText(/successfully save/i);
    await expect(message).toBeVisible({ timeout: 60_000 });

    const text = (await message.textContent()) ?? '';
    const patientId = text.match(/patient id\s*(\d+)/i)?.[1];
    expect(patientId, `no patient id in dialog text: "${text}"`).toBeTruthy();

    return patientId!;
  }

  /** Closes the success dialog. The patient is already saved by the time it shows. */
  async acknowledgeRegistration() {
    await this.confirmDialog.getByRole('button', { name: /^ok$/i }).click();
    await expect(this.confirmDialog).toBeHidden({ timeout: 30_000 });
  }
}
