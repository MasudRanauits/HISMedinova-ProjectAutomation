import fs from 'fs';
import path from 'path';
import { BrowserContext, test as base } from '@playwright/test';
import { PatientRegistrationPage } from '../pages/PatientRegistrationPage';
import { InvestigationPage } from '../pages/InvestigationPage';
import { watchShiftNotices, watchShiftNoticesOnPage } from '../utils/shift';
import { keepPrintedBlobs, keepPrintedBlobsOnPage } from '../utils/printing';
import users from '../test-data/users.json';
import patients from '../test-data/patients.json';
import investigations from '../test-data/investigations.json';

type Fixtures = {
  /** Lands on the new patient registration form. Requires a signed-in session. */
  registrationPage: PatientRegistrationPage;
  /** Lands on OPD Investigation Entry. Requires a signed-in session. */
  investigationPage: InvestigationPage;
};

type WorkerFixtures = {
  /** The one browser context every test in the run shares. */
  sharedContext: BrowserContext;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
  /**
   * Playwright gives each test its own context and tab by default, so a run
   * flickers through a window per test and nothing carries over. These specs
   * describe one person working through the screens in order — register, bill,
   * collect, dispatch, acknowledge — so they share a single context, opened
   * once per worker, and with `workers: 1` that means a single tab for the
   * whole run.
   *
   * The signed-in session comes from the project's own `storageState`, so this
   * behaves exactly as the built-in fixture would, minus the churn.
   */
  sharedContext: [
    async ({ browser }, use, workerInfo) => {
      const { storageState, ignoreHTTPSErrors, viewport } = workerInfo.project.use;
      const context = await browser.newContext({ storageState, ignoreHTTPSErrors, viewport });
      // The counter's shift can turn over in the middle of any test, putting a
      // modal over the form; this clicks it away wherever it appears (utils/shift).
      await watchShiftNotices(context);
      // Printing hands the browser a blob that cannot be fetched back out of it;
      // this keeps the object itself so a test can read what printed.
      await keepPrintedBlobs(context);
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],

  // Overriding these without asking for the built-in ones is what keeps the
  // second context — and its window — from ever being opened.
  context: async ({ sharedContext }, use) => {
    await use(sharedContext);
  },

  page: async ({ sharedContext }, use) => {
    const page = sharedContext.pages()[0] ?? (await sharedContext.newPage());
    // `addInitScript` only takes at the next navigation, and this page is handed
    // from test to test without one; this covers the document already open.
    await watchShiftNoticesOnPage(page);
    await keepPrintedBlobsOnPage(page);
    await use(page);
  },

  registrationPage: async ({ page }, use) => {
    const registrationPage = new PatientRegistrationPage(page);
    await registrationPage.goto();
    await use(registrationPage);
  },

  investigationPage: async ({ page }, use) => {
    const investigationPage = new InvestigationPage(page);
    await investigationPage.goto();
    await use(investigationPage);
  },
});

const INVESTIGATIONS_FILE = path.join(__dirname, '..', 'test-data', 'investigations.json');
const PATIENTS_FILE = path.join(__dirname, '..', 'test-data', 'patients.json');

/**
 * The next name in the series — "Masud Rana-1", "Masud Rana-2", and so on.
 *
 * The form writes to live data, so registering the same name every run piles
 * up patients that cannot be told apart on the screens that follow. The base
 * name lives in test-data/patients.json and the number after it is kept there
 * too, in `nameSequence`, bumped and written back on every call. Digits and a
 * hyphen are both allowed in a patient name by the app's own rule (letters,
 * digits and . - / ( )), so the suffix goes in as typed.
 */
export function nextPatientName() {
  const data = JSON.parse(fs.readFileSync(PATIENTS_FILE, 'utf8'));
  const sequence = (data.nameSequence ?? 0) + 1;

  data.nameSequence = sequence;
  fs.writeFileSync(PATIENTS_FILE, `${JSON.stringify(data, null, 2)}\n`);

  return `${data.valid.fullName}-${sequence}`;
}

/**
 * Hands the identifiers a run produces to the runs that follow it.
 *
 * The screens form a chain — register a patient, bill them, then collect,
 * dispatch and acknowledge that bill's samples — but each step lives in its own
 * spec file, and Playwright gives spec files no shared memory. So the UHID and
 * the invoice number are written straight back into test-data/investigations.json,
 * which is where every later spec already reads them from. Registering a patient
 * therefore points the invoice spec at the new UHID, and posting that invoice
 * points the three sample specs at the new invoice number, with nothing edited
 * by hand in between.
 *
 * `paths` are dotted keys into the file, e.g. "staffDiscountInvoice.uhid".
 */
function record(values: Record<string, string>) {
  const data = JSON.parse(fs.readFileSync(INVESTIGATIONS_FILE, 'utf8'));

  for (const [dotted, value] of Object.entries(values)) {
    const keys = dotted.split('.');
    const leaf = keys.pop()!;
    let node = data;
    for (const key of keys) {
      if (node[key] === undefined) node[key] = {};
      node = node[key];
    }
    node[leaf] = value;
  }

  fs.writeFileSync(INVESTIGATIONS_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Points the invoice spec at a freshly registered patient. The name goes with
 * the UHID so the dashboard listing filters on the patient just registered
 * rather than on whoever the file named before.
 */
export function recordUhid(uhid: string, fullName?: string) {
  const values: Record<string, string> = { 'staffDiscountInvoice.uhid': uhid };
  if (fullName) values['staffDiscountInvoice.patientSearch'] = fullName.toUpperCase();

  record(values);
  console.log(`recorded UHID ${uhid}${fullName ? ` (${fullName})` : ''} for the invoice spec`);
}

/** Points the sample specs, and result entry after them, at a new invoice. */
export function recordInvoiceNo(invoiceNo: string) {
  record({
    'partialSampleCollection.invoiceNo': invoiceNo,
    'partialSampleDispatch.invoiceNo': invoiceNo,
    'partialSampleAcknowledgement.invoiceNo': invoiceNo,
    'labResultEntry.invoiceNo': invoiceNo,
    'labResultFinalization.invoiceNo': invoiceNo,
    // The microbiology report works off the same invoice, once the lab has
    // acknowledged its culture sample.
    'csReport.invoiceNo': invoiceNo,
    // And the counter hands that invoice's reports over at the end of it all.
    'reportDelivery.invoiceNo': invoiceNo,
  });
  console.log(`recorded invoice ${invoiceNo} for the sample specs`);
}

export { expect } from '@playwright/test';
export { users, patients, investigations };
