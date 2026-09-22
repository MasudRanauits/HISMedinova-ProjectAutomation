/**
 * The defects to report, and how to photograph each one.
 *
 * Every entry drives the screen itself and takes its own screenshot, so the
 * evidence in the PDF is produced fresh each run rather than pasted in by hand
 * and left to go stale. Edit the wording here; `generate.js` does the rest.
 *
 * `capture(page, shot)` is handed a page already signed in and sitting on the
 * screen named by `screen`. Call `shot('caption', { mark, clip })` as many times
 * as the finding needs — each becomes a figure under it, with `mark` ringing
 * the offending control in red and `clip` cropping to what matters.
 *
 * Set `video: true` on a finding whose defect is a sequence rather than a
 * state — something that has to be watched happening. That finding is then
 * driven in its own recorded window and the .webm lands in `recordings/`.
 */

const patients = require('../test-data/investigations.json');

const SAMPLE_COLLECTION = {
  name: 'Sample Collection',
  url: '/diagnostic/sample-collection',
};

const INVESTIGATION = {
  name: 'OPD Investigation Entry',
  url: '/diagnostic/investigation',
};

/** A patient the chain has registered, used to put a bill on screen. */
const UHID = patients.staffDiscountInvoice.uhid;

// --- the investigation screen ------------------------------------------------
//
// Ids are regenerated per circuit, so everything here is found by placeholder,
// by a stable id the app sets itself, or by the label beside it.

const inv = {
  uhid: (page) => page.locator('input[placeholder="12-digit UHID"]'),
  searchButton: (page) => page.getByRole('button', { name: /^search$/i }).first(),
  fullName: (page) => page.locator('#FullName'),
  mobile: (page) => page.locator('#mobile'),
  ageYears: (page) => page.locator('#ageyear'),
  ageMonths: (page) => page.locator('input[placeholder="M"]'),
  ageDays: (page) => page.locator('input[placeholder="D"]'),
  gender: (page) => page.locator('select.form-select-sm').filter({ hasText: 'Female' }).first(),
  testSearch: (page) => page.locator('input[placeholder="Search test by name or code..."]'),
  packageSearch: (page) => page.locator('input[placeholder="Search OPD package..."]'),
  category: (page) => page.locator('input[placeholder="Discount category"]'),
  discPercent: (page) =>
    page.locator('xpath=//*[normalize-space(text())="Disc(%)"][not(ancestor::table)]/following::input[1]'),
  discTaka: (page) =>
    page.locator('xpath=//*[normalize-space(text())="Disc(Tk)"][not(ancestor::table)]/following::input[1]'),
  payment: (page) =>
    page.locator('xpath=//*[contains(normalize-space(text()),"Payment (cash)")]/following::input[1]'),
  summary: (page) => page.locator('.inv2-summary-row').first(),
  netPayableRow: (page) =>
    page
      .locator('.inv2-summary-row')
      .filter({ has: page.locator('.inv2-summary-label', { hasText: /^Net payable$/ }) })
      .first(),
  testGrid: (page) => page.locator('table').filter({ has: page.locator('th').filter({ hasText: /^name$/i }) }).first(),
  resetButton: (page) => page.locator('button.btn-danger.btn-sm').first(),
  suggestions: (page) => page.locator('.dropdown-menu.show a.dropdown-item.b-is-autocomplete-suggestion'),
};

/** Types at a field and returns what it kept — these fields rewrite input. */
async function typeInto(page, locator, value) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ force: true });
  await locator.fill('');
  if (value) await locator.pressSequentially(value, { delay: 60 });
  await locator.press('Tab');
  await page.waitForTimeout(1500);
  return locator.inputValue();
}

/** Picks from one of the Blazorise typeaheads. */
async function pick(page, locator, query, match) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ force: true });
  await locator.fill('');
  await locator.pressSequentially(query, { delay: 100 });
  await page.waitForTimeout(3500);

  const items = inv.suggestions(page);
  const texts = [];
  for (let i = 0; i < (await items.count()); i++) {
    texts.push((await items.nth(i).innerText()).replace(/\s+/g, ' ').trim());
  }
  const index = match ? texts.findIndex((t) => match.test(t)) : 0;
  if (index < 0) {
    await page.keyboard.press('Escape');
    return null;
  }
  await items.nth(index).click();
  await page.waitForTimeout(3500);
  return texts[index];
}

async function loadPatient(page) {
  await inv.uhid(page).fill(UHID);
  await inv.searchButton(page).click();
  await page.waitForTimeout(8000);
}

/** A bill with one discountable test on it. */
async function billOneTest(page) {
  await loadPatient(page);
  await pick(page, inv.testSearch(page), 'LIPID', /SERUM LIPID PROFILE \(FASTING\)/i);
  await page.waitForTimeout(2000);
}

async function setCategory(page, name) {
  return pick(page, inv.category(page), name, new RegExp(`^${name} Discount$`, 'i'));
}

/** The picker's own format. */
const TODAY = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
})();

const dateFrom = (page) => page.locator('input.input.form-control').first();
const dateTo = (page) => page.locator('input.input.form-control').nth(1);
const search = (page) => page.locator('#searchSample');
const showButton = (page) => page.getByRole('button', { name: /^show$/i });
const invoiceGrid = (page) =>
  page.locator('table').filter({ has: page.locator('th').filter({ hasText: /invoice\s*no/i }) }).first();
const printRow = (page) => page.getByRole('button', { name: /print token/i });

async function typeDate(page, input, value) {
  await input.click();
  await input.fill('');
  if (value) {
    await input.pressSequentially(value, { delay: 50 });
    await page.keyboard.press('Enter');
  } else {
    await page.keyboard.press('Tab');
  }
  await page.waitForTimeout(800);
  return input.inputValue();
}

/** Resets the screen to a sane date range between findings. */
async function reset(page) {
  await typeDate(page, dateFrom(page), TODAY);
  await typeDate(page, dateTo(page), TODAY);
  await search(page).fill('');
  await showButton(page).click();
  await page.waitForTimeout(4000);
}

module.exports = {
  title: 'Diagnostic module — defect report',
  subtitle:
    'Negative testing of OPD Investigation Entry and Sample Collection — 76 cases across billing, ' +
    'discounts, payment, patient details, packages and sample collection',
  system: 'HIS ERP — Medinova Medical Services Ltd.',

  /**
   * The common thread. Stated once at the top so each finding below can stay
   * short instead of repeating it seven times.
   */
  summary: [
    'The most serious findings share one cause. Several numeric fields — DISC(%), DISC(Tk), Payment (cash) and ' +
      'the age boxes — do not refuse input they cannot read. They strip the characters they do not understand and ' +
      'use whatever digits are left. A minus sign disappears, so -300 becomes a 300 taka discount. A decimal ' +
      'point disappears, so 33.33 becomes 3333, which is over the limit, so the screen grants the largest ' +
      'discount it can instead. In every case the mistake costs the hospital money, and in most of them nothing ' +
      'is said.',
    'The discount controls have no authorisation behind them. D. Category is an ordinary editable box: any ' +
      'operator can type any category for any patient, with no employee or corporate mapping required. One of ' +
      'those categories, Special Discount, grants a full 100%. Between them, any bill can be written off to zero ' +
      'unaided. Clearing the form then leaves the category reading "General Discount" rather than N/A, so the ' +
      'next patient starts out discounted.',
    'Neither screen tells the operator when nothing was found. A search that matched nothing, a date range that ' +
      'was never valid, and a genuinely empty day all look identical: a grid that silently goes blank.',
    'Much of the rest holds up well, and is listed as such. Payment (cash) refuses decimals, overpayments and ' +
      'absurd figures cleanly — the very inputs that wreck the discount boxes beside it, which suggests the right ' +
      'validation already exists in the codebase and simply has not been applied to them. Card and mobile ' +
      'payments cannot be entered without choosing a type first. A SQL injection string and a script tag were ' +
      'both handled safely. Net payable is calculated, never editable, and its arithmetic closed exactly in every ' +
      'combination tried.',
  ],

  findings: [
    {
      id: 'SC_N_01',
      title: 'A reversed date range is accepted in silence',
      severity: 'Medium',
      screen: SAMPLE_COLLECTION,
      // The silence is the point, and silence does not photograph.
      video: true,
      steps: [`Set Date From to ${TODAY}`, 'Set Date To to 10-09-2026 (earlier than From)', 'Press Show'],
      expected: 'The range is refused with a message such as "Date To must be on or after Date From", and no query is sent.',
      actual:
        'No message appears. The query runs and the grid empties, which reads to the operator as "there are no ' +
        'invoices today" rather than "your dates are the wrong way round".',
      async capture(page, shot) {
        await typeDate(page, dateFrom(page), TODAY);
        await typeDate(page, dateTo(page), '10-09-2026');
        await showButton(page).click();
        await page.waitForTimeout(5000);
        await shot(`Date From ${TODAY}, Date To 10-09-2026 — the grid is empty and nothing is said`, {
          mark: [dateFrom(page), dateTo(page)],
          clip: [dateFrom(page), invoiceGrid(page)],
        });
        await reset(page);
      },
    },
    {
      id: 'SC_N_02',
      title: 'An impossible date is silently changed to a different one',
      severity: 'High',
      screen: SAMPLE_COLLECTION,
      // The rewrite happens under the operator's fingers; the still only shows
      // where it landed, not that it moved.
      video: true,
      steps: ['Click Date From', 'Type 31-02-2026', 'Press Enter'],
      expected: 'The field refuses the date, or flags it — 31 February does not exist.',
      actual:
        'The picker rolls the date forward and the field ends up holding 03-03-2026. The operator is now ' +
        'looking at a different day from the one they typed, with nothing on screen to say so.',
      async capture(page, shot) {
        const held = await typeDate(page, dateFrom(page), '31-02-2026');
        await shot(`31-02-2026 was typed; the field holds ${held}`, {
          mark: [dateFrom(page)],
          clip: [dateFrom(page), dateTo(page)],
        });
        await reset(page);
      },
    },
    {
      id: 'SC_N_03',
      title: 'Both dates can be cleared and Show still runs',
      severity: 'Medium',
      screen: SAMPLE_COLLECTION,
      // Shows Show being pressed on an empty range and simply going through.
      video: true,
      steps: ['Clear Date From', 'Clear Date To', 'Press Show'],
      expected: 'A "date is required" message; Show does not fire.',
      actual: 'Both fields sit empty, Show fires anyway, and the grid comes back blank with no explanation.',
      async capture(page, shot) {
        await typeDate(page, dateFrom(page), '');
        await typeDate(page, dateTo(page), '');
        await showButton(page).click();
        await page.waitForTimeout(5000);
        await shot('Both date fields empty after pressing Show', {
          mark: [dateFrom(page), dateTo(page)],
          clip: [dateFrom(page), invoiceGrid(page)],
        });
        await reset(page);
      },
    },
    {
      id: 'SC_N_04 / SC_N_05',
      title: 'An empty result is never explained',
      severity: 'Low',
      screen: SAMPLE_COLLECTION,
      steps: ['Type 9999999999999 into the search box', 'Press Show'],
      expected: 'The grid shows "No record found" or similar.',
      actual:
        'Both grids simply go blank. The same blank grid appears for a future date range, for a reversed range ' +
        'and for a genuinely empty day, so it carries no information at all.',
      async capture(page, shot) {
        await search(page).fill('9999999999999');
        await showButton(page).click();
        await page.waitForTimeout(5000);
        await shot('An invoice number that cannot exist — both grids blank, no message', {
          mark: [invoiceGrid(page)],
          clip: [search(page), invoiceGrid(page)],
        });
        await reset(page);
      },
    },
    {
      id: 'SC_N_10',
      title: 'The search box has no maximum length',
      severity: 'Low',
      screen: SAMPLE_COLLECTION,
      steps: ['Paste 600 characters into the search box'],
      expected: 'The field caps the input at a sensible length — an invoice number is 13 digits.',
      actual:
        'All 600 characters are accepted and sent. No injection got through in testing, but a field with no ' +
        'ceiling is a payload surface that costs nothing to close.',
      async capture(page, shot) {
        await search(page).fill('A'.repeat(600));
        const held = (await search(page).inputValue()).length;
        await shot(`600 characters pasted; the field holds all ${held}`, {
          mark: [search(page)],
          clip: [search(page), showButton(page)],
        });
        await reset(page);
      },
    },
    // --- OPD Investigation Entry ---------------------------------------------

    {
      id: 'TC-52 / TC-53 / TC-69',
      title: 'A minus sign is dropped, turning an invalid entry into a real discount or payment',
      severity: 'High',
      screen: INVESTIGATION,
      video: true,
      steps: [
        `Load a patient (UHID ${UHID}) and add one chargeable test`,
        'Set D. Category to General Discount',
        'Type -300 into DISC(Tk)',
      ],
      expected: 'The entry is refused with a validation message; the bill is untouched.',
      actual:
        'The minus is discarded and the digits behind it are applied — -300 becomes a 300 taka discount, and the ' +
        'bill drops accordingly. No message is shown at all. The same happens in DISC(%) (-10 grants 10%) and in ' +
        'Payment (cash) (-500 records a 500 taka payment), so an operator who mistypes a sign hands out money.',
      async capture(page, shot) {
        await billOneTest(page);
        await setCategory(page, 'General');
        await page.waitForTimeout(2000);
        await shot('Before: no discount, the full amount is owed', {
          mark: [inv.discTaka(page)],
          clip: [inv.summary(page), inv.netPayableRow(page)],
        });

        const held = await typeInto(page, inv.discTaka(page), '-300');
        await page.waitForTimeout(3000);
        await shot(`After typing -300: the box holds ${held} and the discount has been applied`, {
          mark: [inv.discTaka(page)],
          clip: [inv.summary(page), inv.netPayableRow(page)],
        });
      },
    },
    {
      id: 'TC-55b / TC-56 / TC-63',
      title: 'A decimal point or comma is dropped, so a mistyped discount becomes the largest one allowed',
      severity: 'High',
      screen: INVESTIGATION,
      video: true,
      steps: [
        `Load a patient (UHID ${UHID}) and add one chargeable test`,
        'Set D. Category to General Discount',
        'Type 33.33 into DISC(%)',
      ],
      expected: 'Either the fractional percentage is applied, or the entry is refused as not a valid number.',
      actual:
        'The point is discarded, leaving 3333, which is over the category ceiling — so the screen grants the ' +
        'maximum instead, 50%. "1,000" and "10.5.5" do the same. A slip of the keyboard is the difference between ' +
        'no discount and the largest one the operator is allowed to give.',
      async capture(page, shot) {
        await billOneTest(page);
        await setCategory(page, 'General');
        await page.waitForTimeout(2000);
        await shot('Before: nothing discounted', {
          mark: [inv.discPercent(page)],
          clip: [inv.summary(page), inv.netPayableRow(page)],
        });

        const held = await typeInto(page, inv.discPercent(page), '33.33');
        await page.waitForTimeout(3000);
        await shot(`After typing 33.33: the box holds ${held} — the ceiling, not the figure asked for`, {
          mark: [inv.discPercent(page)],
          clip: [inv.summary(page), inv.netPayableRow(page)],
        });
      },
    },
    {
      id: 'TC-07 / TC-78',
      title: 'Any operator can pick any discount category, and one of them clears the bill entirely',
      severity: 'High',
      screen: INVESTIGATION,
      steps: [
        'Click the D. Category box (it reads N/A)',
        'Type a category name and take it from the list — no employee number or mapping is needed',
        'Choose Special Discount and set DISC(%) to 100',
      ],
      expected:
        'The category comes from the patient record — an employee or corporate mapping — and cannot be set by ' +
        'hand; a discount that clears a bill needs approval.',
      actual:
        'The box is an ordinary editable field: arbitrary text can be typed into it, and any of the four real ' +
        'categories can be chosen for a walk-in patient with no entitlement. Special Discount grants a full 100%, ' +
        'taking Net payable to zero. Together these let any operator write off any bill unaided. (Every Staff ' +
        'Discount invoice raised while testing went to a walk-in patient with no employee number.)',
      async capture(page, shot) {
        await billOneTest(page);
        const typed = await typeInto(page, inv.category(page), 'ZZZ NOT A CATEGORY');
        await shot(`Arbitrary text typed straight into the category box: "${typed}"`, {
          mark: [inv.category(page)],
        });

        await setCategory(page, 'Special');
        await page.waitForTimeout(2000);
        await typeInto(page, inv.discPercent(page), '100');
        await page.waitForTimeout(3000);
        await shot('Special Discount at 100% — Net payable is now zero', {
          mark: [inv.netPayableRow(page)],
          clip: [inv.summary(page), inv.netPayableRow(page)],
        });
      },
    },
    {
      id: 'TC-10',
      title: 'Clearing the form leaves a discount category behind for the next patient',
      severity: 'Medium',
      screen: INVESTIGATION,
      video: true,
      steps: [`Load a patient (UHID ${UHID}) and add a test`, 'Press the red ✕ beside Search to clear the form'],
      expected: 'Everything returns to its starting state, D. Category included — back to N/A.',
      actual:
        'The patient, the grid and the totals all clear properly, but D. Category comes back reading "General ' +
        'Discount" — the first entry in the list — instead of N/A. The next patient billed on that form starts ' +
        'out entitled to a discount nobody granted them, and nothing on screen says so.',
      async capture(page, shot) {
        await billOneTest(page);
        await shot('Before the reset: a patient is loaded and the category reads N/A', {
          mark: [inv.category(page)],
          clip: [inv.fullName(page), inv.category(page)],
        });

        await inv.resetButton(page).click();
        await page.waitForTimeout(7000);
        const category = await inv.category(page).inputValue();
        await shot(`After the reset: the patient is gone but the category reads "${category}"`, {
          mark: [inv.category(page)],
          clip: [inv.fullName(page), inv.category(page)],
        });
      },
    },
    {
      id: 'TC-18',
      title: 'Gender is drawn as a required field but never enforced',
      severity: 'Medium',
      screen: INVESTIGATION,
      steps: [
        'Open a fresh form and press POST',
        'Fill in the name, mobile number, age and referring doctor, leaving Gender on "Select"',
        'Press POST again',
      ],
      expected: 'POST is refused until a gender is chosen, as the red border implies.',
      actual:
        'Gender is given the red border of a missing mandatory field, but nothing checks it. POST works through ' +
        'name, mobile, age and doctor in turn and then asks for the test grid — it never once mentions gender, so ' +
        'an invoice can be raised for a patient with none recorded.',
      async capture(page, shot) {
        await typeInto(page, inv.fullName(page), 'TEST PATIENT');
        await typeInto(page, inv.mobile(page), '01700000001');
        await typeInto(page, inv.ageYears(page), '30');
        await pick(page, page.locator('input[placeholder="Doctor search..."]'), 'JESSY', /JESSY J ROZARIO/i);

        await page.getByRole('button', { name: /^post$/i }).click();
        await page.waitForTimeout(6000);
        await shot('Name, mobile and age all filled; Gender left on "Select" and POST went past it', {
          mark: [inv.gender(page)],
          clip: [inv.fullName(page), inv.gender(page), inv.mobile(page)],
        });
      },
    },
    {
      id: 'TC-16',
      title: 'The mobile number is never checked for shape',
      severity: 'Medium',
      screen: INVESTIGATION,
      steps: ['Enter a name', 'Type 12345 into Mobile No', 'Press POST'],
      expected: '"Invalid mobile number format" — a Bangladeshi mobile number is eleven digits.',
      actual:
        'Five digits are accepted, and so are fourteen. POST passes straight over the field and goes on to ask ' +
        'about the age instead, so a bill can be raised against a number nobody can be reached on.',
      async capture(page, shot) {
        await typeInto(page, inv.fullName(page), 'TEST PATIENT');
        const held = await typeInto(page, inv.mobile(page), '12345');
        await page.getByRole('button', { name: /^post$/i }).click();
        await page.waitForTimeout(6000);
        await shot(`Mobile No holds "${held}" and POST has moved on to its next complaint`, {
          mark: [inv.mobile(page)],
          clip: [inv.fullName(page), inv.mobile(page)],
        });
      },
    },
    {
      id: 'TC-19c / TC-20 / TC-21b',
      title: 'Age accepts impossible values and silently wraps others',
      severity: 'Medium',
      screen: INVESTIGATION,
      steps: ['Type 999 into the age Y box', 'Type 15 into M', 'Type 45 into D'],
      expected: 'Each is refused: nobody is 999 years old, months run 0–11 and days 0–30.',
      actual:
        '999 years is taken as it stands. 15 months silently becomes 3 and 45 days becomes 14 — the values wrap ' +
        'rather than being refused, so the record ends up holding an age nobody typed. Typing 2.5 gives 25, the ' +
        'same dropped-decimal behaviour as the discount boxes.',
      async capture(page, shot) {
        const years = await typeInto(page, inv.ageYears(page), '999');
        const months = await typeInto(page, inv.ageMonths(page), '15');
        const days = await typeInto(page, inv.ageDays(page), '45');
        await shot(`Typed 999 / 15 / 45 — the boxes hold ${years} / ${months} / ${days}`, {
          mark: [inv.ageYears(page), inv.ageMonths(page), inv.ageDays(page)],
        });
      },
    },
    {
      id: 'TC-13',
      title: 'The patient name field has no maximum length',
      severity: 'Low',
      screen: INVESTIGATION,
      steps: ['Paste 300 characters into Full Name'],
      expected: 'The field caps the input at a sensible length.',
      actual: 'All 300 characters are kept. The same gap exists in the search box on Sample Collection.',
      async capture(page, shot) {
        const held = await typeInto(page, inv.fullName(page), 'A'.repeat(300));
        await shot(`300 characters pasted; the field holds ${held.length}`, { mark: [inv.fullName(page)] });
      },
    },
    {
      id: 'TC-49',
      title: 'A package can be taken apart line by line',
      severity: 'Low',
      screen: INVESTIGATION,
      steps: ['Choose the OPD package "Hungary Medical"', 'Delete one of the lines it put on the bill'],
      expected: 'A component of a package cannot be removed on its own, or removing it is at least remarked on.',
      actual:
        'Any line can be deleted, package component or not, and the bill simply gets cheaper by that amount. ' +
        'Nothing in the grid marks a line as belonging to a package, so there is no way for an operator to tell ' +
        'which lines came as a set. Whether packages should be splittable at all is a product decision.',
      async capture(page, shot) {
        await loadPatient(page);
        await pick(page, inv.packageSearch(page), 'Hungary Medical', /Hungary Medical/i);
        await page.waitForTimeout(4000);
        await shot('The package on the bill', { clip: [inv.testGrid(page)] });

        const rows = inv.testGrid(page).locator('tbody tr');
        await rows.first().locator('button').last().click();
        await page.waitForTimeout(4000);
        await shot('One component deleted — the bill is simply smaller, with nothing said', {
          clip: [inv.summary(page), inv.netPayableRow(page)],
        });
      },
    },
  ],

  /**
   * Things met along the way that are outside the case lists but worth the
   * development team's time.
   */
  appendix: [
    {
      title: 'Two kinds of feedback, and one of them disappears',
      detail:
        'The print buttons on this screen put their refusal inline, beside the button, where it stays — which is ' +
        'the right way round. Most other outcomes across the diagnostic screens, though, are reported only through ' +
        'a snackbar that shows and hides again in about a second. A refused invoice post, for instance, answers ' +
        '"Staff Hospital discount: due amount must be fully paid." and then takes it away, leaving the form ' +
        'untouched; an operator who looked away sees a screen that simply did not respond. Automating those ' +
        'screens meant installing a recorder in the page to catch the messages at all. The inline style used by ' +
        'the print buttons would serve the rest of the application better.',
    },
    {
      title: 'Wording',
      detail:
        '"Succesfully Fetched!" (missing an s) appears on sample collection, and "Could not found printer." on ' +
        'both the investigation and sample screens. The second is also misleading: it is shown after a save that ' +
        'succeeded, so it reads as a failure when only the printing failed.',
    },
    {
      title: 'Server availability during testing',
      detail:
        'The application refused connections on port 1115 three times during one afternoon of testing, each ' +
        'outage lasting from a few minutes to over a quarter of an hour. Runs in progress failed with ' +
        'ERR_CONNECTION_REFUSED. Not a defect in the screen under test, but it made several results ' +
        'inconclusive and is worth looking into separately.',
    },
  ],

  /** Cases that could not be driven from an automated run against live data. */
  notCovered: [
    ['SC_N_14', 'Two operators collecting the same lab number at once — needs a second session collecting a live sample.'],
    ['SC_N_15', 'A role without permission — test-data holds a password only for the Administrator account.'],
    ['SC_N_16', 'Session timeout — the session runs about eight hours; needs a build with a shorter one.'],
    ['SC_N_17', 'Network loss mid-collection — would leave live data in a partial state.'],
    ['SC_N_20', 'Browser Back after a collection — needs a real collection to go back from.'],
    ['SC_N_23', 'A cancelled invoice — cancelling one needs a two-step approval and leaves a cancelled bill on the ledger.'],
    [
      'TC-09',
      'A patient arriving with a discount category already mapped — every patient this suite creates is a walk-in ' +
        'with no employee number, and the screen offers no way to find one that has a mapping.',
    ],
    [
      'TC-62 / TC-71 / TC-75 / TC-80',
      'Anything that needs a bill actually posted: editing a discount or payment afterwards, and whether a bill ' +
        'with nothing paid is refused. Each would put a real invoice on the live ledger. Worth running against a ' +
        'test database.',
    ],
    [
      'TC-02b',
      'Posting a bill with the total tampered in the DOM — same reason. TC-02 shows what can be established ' +
        'without it: there is no field behind the figure for a tamperer to submit.',
    ],
  ],

  /** Cases where the screen behaved correctly. */
  passed: [
    ['SC_N_02b', 'A loose date format (19/09/26) is understood and normalised to 19-09-2026.'],
    ['SC_N_11', 'Print Token with no invoice selected answers "Please select Investigation Invoice." and prints nothing.'],
    ['SC_N_12', 'Print Label with no invoice selected answers the same, and prints nothing.'],
    ['SC_N_06', 'A whitespace-only search is handled like an empty one; no error.'],
    ['SC_N_07', 'Special characters (!@#$%^&*()) are handled without a server error.'],
    ['SC_N_08', "A SQL injection string (' OR 1=1--) returns nothing and causes no database error."],
    ['SC_N_09', 'A script tag is rendered as text; it neither executes nor reaches the DOM as markup.'],
    [
      'SC_N_13',
      'A collected test cannot be collected again. It drops out of the "New Patient" list entirely, and though ' +
        'it keeps a checkbox under "Collected Patient", that one selects labels to reprint — ticking those rows ' +
        'and pressing Print Label leaves every status exactly as it was.',
    ],
    ['SC_N_18', 'Double-clicking Print Token leaves the screen working.'],
    ['SC_N_19', 'Changing the patient filter refreshes the grid without pressing Show.'],
    ['SC_N_21', 'A six-year date range answers rather than hanging.'],
    ['SC_N_22', 'Selecting a second patient clears the first one’s tests.'],
    ['SC_N_24', 'A test with no tube mapping renders a blank cell, not "null".'],
    ['TC-01 / TC-64', 'Sub total and Net payable are calculated spans, not fields; they cannot be typed into.'],
    ['TC-02', 'Rewriting Sub total in the DOM changes nothing — there is no field behind it to submit.'],
    ['TC-03 / TC-67', 'Emptying the grid takes the totals back to zero; removing a line recalculates at once.'],
    ['TC-04', 'Discountable never exceeds Sub total; a government-fixed-rate test is not discountable at all.'],
    ['TC-06', 'A large bill is shown in full, grouped with separators, and is not clipped by its column.'],
    ['TC-08', 'A discount is refused while D. Category is N/A, with a reason given.'],
    ['TC-11 / TC-14 / TC-15', 'A blank, whitespace-only or missing name and a blank mobile all stop the post.'],
    ['TC-12', 'A symbol in a patient name is called out, naming the character and the rule.'],
    ['TC-22 / TC-23', 'A future date of birth is refused, and date of birth and age stay in step with each other.'],
    ['TC-24', 'One press of POST flags every missing field at once.'],
    ['TC-46 / TC-48 / TC-50', 'A missing package offers nothing; a test already in the package is not charged twice; a second package replaces the first rather than stacking.'],
    ['TC-51 / TC-54 / TC-60 / TC-61', 'Discounts over the ceiling, over the bill, or against nothing discountable are all refused with a message.'],
    ['TC-57', 'Leading zeros are normalised — 0010 is read as ten.'],
    ['TC-58 / TC-66', 'The two discount boxes stay in step, and Net payable is exactly Sub total less the discount.'],
    ['TC-68 / TC-72 / TC-73 / TC-74', 'Payment refuses an overpayment, a payment against an empty bill, paisa, and an absurd figure.'],
    ['TC-76 / TC-77', 'Card and mobile amounts cannot be entered at all until a card type or an operator is chosen.'],
    ['TC-79', 'Cash and card together cannot overpay the bill.'],
  ],

  reset,
};
