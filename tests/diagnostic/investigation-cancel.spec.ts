import { Page } from '@playwright/test';
import { test, expect, investigations, users } from '../../fixtures/test';
import { CancelRequestRow, InvestigationCancelRequestPage } from '../../pages/InvestigationCancelRequestPage';
import { InvestigationCancelApprovalPage } from '../../pages/InvestigationCancelApprovalPage';
import { LabReportPublishedGroupWisePage } from '../../pages/LabReportPublishedGroupWisePage';
import { ROUTES } from '../../utils/constants';

const data = investigations.investigationCancel;

/**
 * Cancelling a billed test, which is two screens and two people.
 *
 * "Send Request for Cancel" takes an invoice number, lists what was billed on
 * it and sends the ticked items up for approval with a reason. "Approve Cancel
 * Request" queues those requests, and granting one with **Cancel Item** takes
 * the money off the bill. The second screen also carries a **Reverse Cancel**
 * button per item, which sends a request back without granting it — the only
 * way back, and what makes this spec repeatable.
 *
 * ## What this spec presses, and what that costs
 *
 * The target is a UAT server, so the full two-step is driven here rather than
 * described: IC_01 raises a request and sends it straight back with Reverse
 * Cancel, leaving the bill as it found it, and IC_02 raises another and
 * **grants** it, which takes the item and its money off the bill for good —
 * Reverse Cancel withdraws a pending request, it does not undo a granted one.
 * IC_02 therefore spends the cheapest unreported item on the invoice, and the
 * invoice it works on is the one recorded in test data, which the chain
 * rewrites every time it posts a new bill.
 *
 * - `CANCEL_REQUEST=0` — raise nothing; the read-only checks only.
 * - `CANCEL_APPROVE=0` — raise, but grant nothing. Set this before pointing
 *   BASE_URL at anything that is not UAT.
 * - `CANCEL_FINALIZED=1` — also run IC_03, which grants a cancellation
 *   against a test whose report is signed off and published. Off by default
 *   even here: it is the destructive half of IC_B_01 and costs the invoice a
 *   finalized test for good.
 *
 * ## The defects this found, 2026-11-02, build at 202.4.101.118:1115
 *
 * Each is a `test.fail` below, written as the behaviour the screen ought to
 * have: the run stays green, the gap stays on the record, and the day one is
 * fixed Playwright reports "expected to fail but passed", which is the prompt
 * to delete the marker.
 *
 * - **IC_B_01 — a finalized report can be put up for cancellation.** Every row
 *   of an invoice is offered, including tests whose results are signed off and
 *   whose reports have been published and handed over. Checked against
 *   2610260200001, nine rows, five of them "Result Finalized": all nine
 *   tickable, the header checkbox ticks the lot, and a request for one of the
 *   finalized ones came back "Request Sent successfully." and sat in the
 *   approval queue showing SAMPLE "Result Finalized". Nothing warns the
 *   requester, and nothing on the approval screen marks the request as one
 *   that should not be granted.
 * - **IC_B_02 — "Entry User" names the biller, not the requester.** The
 *   request raised here as Admin02 was queued as "Entry User : Ripon02", the
 *   counter clerk who raised the *invoice* back on 26/10. The approver cannot
 *   see who asked for the cancellation.
 * - **IC_B_03 — "Approve User" names somebody before anybody has approved.**
 *   It shows the requester on a request still waiting in the queue, so the
 *   field reads as a decision that has not been taken.
 * - **IC_B_04 — sending a request back reports "Successful Approved."**
 *   Reverse Cancel withdraws the request — correctly — and then says the
 *   opposite of what it did, on a screen whose other red button really does
 *   approve. There is no confirmation step either.
 * - **IC_B_05 — clearing the invoice number leaves the last patient on
 *   screen.** Empty the box and tab out and the previous patient's name, age,
 *   entry date and every one of their tests stay in the grid, still tickable,
 *   with the box reading 0.
 * - **IC_B_06 — the two routes are swapped.** The sidebar's "Send Request for
 *   Cancel" is served from /diagnostic/investigation-cancel-approval and
 *   "Approve Cancel Request" from /diagnostic/investigation-cancel.
 * - **IC_B_07 — one account can raise a request and grant it.** Admin02 raised
 *   one and pressed Cancel Item on it in the same session, with nothing in the
 *   way. Two screens and an Entry User / Approve User pair say this is meant to
 *   be maker-checker; nothing enforces it.
 *
 * What the screens get right, and what the IC_N_* cases below pin down: both
 * validate before they post, the amounts on the approval screen are computed
 * and disabled rather than typed, an item already awaiting approval is not
 * offered for a second request, and a number the app has never heard of is
 * refused by name instead of emptying the grid in silence.
 */
const INVOICE = process.env.CANCEL_INVOICE || data.invoiceNo;
const SHOULD_REQUEST = process.env.CANCEL_REQUEST !== '0';

/**
 * Whether to grant a cancellation as well as raise one.
 *
 * Cancel Item takes the money off the bill and the screen offers no way back —
 * Reverse Cancel withdraws a *pending* request, it does not undo a granted
 * one — so this is the one flag in the suite that spends something it cannot
 * put back. It is on by default because the target is a UAT server; point
 * BASE_URL at anything else and set `CANCEL_APPROVE=0`.
 *
 * `CANCEL_FINALIZED=1` goes further and grants a cancellation against a test
 * whose report is already signed off and published (IC_03). That is off by
 * default even here: it is the destructive half of IC_B_01, and a run of it
 * costs the invoice one finalized test for good.
 */
const SHOULD_APPROVE = process.env.CANCEL_APPROVE !== '0';
const SHOULD_CANCEL_FINALIZED = process.env.CANCEL_FINALIZED === '1';

/** A 13-digit number no invoice will ever have. */
const MISSING_INVOICE = '9999999999999';

/** A row this spec is willing to raise a request against. */
const SETTLED = /finali[sz]ed|published|delivered|result/i;

const REASON = 'Automation check: raised and withdrawn by investigation-cancel.spec.ts';

/** How far back the published screen's date range reaches, for IC_03. */
const PUBLISHED_DAYS_BACK = investigations.labReportPublished.daysBack;

const report = (label: string, rows: CancelRequestRow[]) => {
  console.log(`--- ${label} ---`);
  rows.forEach((r) =>
    console.log(`  ${r.testCode} | ${r.testName} | ${r.total} | ${r.status} | tickable=${r.selectable}`),
  );
};

/** Fresh page object on the request screen, with the snackbar recorder on. */
async function openRequest(page: Page) {
  const cancel = new InvestigationCancelRequestPage(page);
  await cancel.goto();
  await cancel.recordSnackbars();
  return cancel;
}

async function openApproval(page: Page) {
  const approval = new InvestigationCancelApprovalPage(page);
  await approval.goto();
  await approval.recordSnackbars();
  return approval;
}

/** Records any response the screen gets back with an error status. */
function watchForServerErrors(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  return failures;
}

/**
 * What the round trip below saw, for the three cases that assert on it.
 *
 * The request has to be raised, read and withdrawn inside a single test so the
 * withdrawal can sit in a `finally` and run whatever else goes wrong — a
 * serial describe would skip it the moment an assertion failed and leave a
 * live request in the queue. The observations are left here for the defect
 * cases after it, which assert on them rather than raising requests of their
 * own.
 */
const seen: {
  raised?: string[];
  entryUser?: string;
  approveUser?: string;
  queuedSample?: string;
  withdrawn?: string[];
  /** Set by IC_02 when one account both raised and granted the cancellation. */
  selfApproved?: boolean;
} = {};

test.describe('Investigation cancellation', () => {
  test.describe.configure({ mode: 'serial' });

  test('IC_01 raises a cancel request and sends it back, leaving the bill untouched', async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!SHOULD_REQUEST, 'CANCEL_REQUEST=0 — the read-only checks only');

    const cancel = await openRequest(page);
    await cancel.findInvoice(INVOICE);
    const rows = await cancel.rowData();
    report(`invoice ${INVOICE}`, rows);

    expect(rows.length, `invoice ${INVOICE} has nothing left to cancel, or was not found`).toBeGreaterThan(0);

    // Anything already reported on is left alone: raising a request against it
    // is IC_B_01's business, and this test has to put back whatever it takes.
    const target = rows.find((r) => r.selectable && !SETTLED.test(r.status));
    test.skip(
      !target,
      `every item on ${INVOICE} has been reported on already; this test needs one that has not, ` +
        'so point CANCEL_INVOICE at a fresher bill',
    );
    const name = target!.testName;
    console.log(`raising a request against ${target!.testCode} ${name} (${target!.status})`);

    await cancel.select(name);
    await cancel.setRemarks(REASON);
    seen.raised = await cancel.submit();
    console.log(`Request Approval said: ${JSON.stringify(seen.raised)}`);

    const approval = await openApproval(page);
    let queued = false;

    try {
      queued = await approval.open(INVOICE);
      expect(queued, `the request just raised is not in the approval queue: ${await approval.pending()}`).toBe(true);

      const header = await approval.header();
      const items = await approval.rowData();
      const mine = items.find((i) => i.testName.toUpperCase().includes(name.toUpperCase()));

      seen.entryUser = header['Entry User'];
      seen.approveUser = header['Approve User'];
      seen.queuedSample = mine?.sample ?? '';
      console.log(`queued as: ${JSON.stringify(header)}`);
      console.log(`queued item: ${JSON.stringify(mine)}`);

      expect(mine, `the queued request does not list ${name}`).toBeTruthy();
      expect(mine!.remarks, 'the reason typed on the request screen should travel with it').toContain('Automation');
    } finally {
      if (queued) {
        seen.withdrawn = await approval.reverse(name);
        console.log(`Reverse Cancel said: ${JSON.stringify(seen.withdrawn)}`);
      }
    }

    // Back as it was: nothing of ours left in the queue, and the item on offer
    // again on the request screen.
    await approval.goto();
    expect(await approval.pending(), 'the withdrawn request should be off the queue').not.toEqual(
      expect.arrayContaining([expect.stringContaining(INVOICE)]),
    );

    const after = await openRequest(page);
    await after.findInvoice(INVOICE);
    const restored = await after.rowData();
    expect(
      restored.map((r) => r.testName),
      'the withdrawn item should be offered for cancellation again',
    ).toContain(name);
  });

  // IC_B_02: queued as "Entry User : Ripon02" — whoever raised the invoice —
  // for a request raised by Admin02.
  test.fail('IC_B_02 the approval queue names whoever asked for the cancellation', async () => {
    test.skip(!seen.entryUser, 'no request was raised in this run');

    expect(
      seen.entryUser,
      `the request was raised by ${users.admin.username}, and the approver is shown "${seen.entryUser}" — ` +
        'that is the user who billed the invoice, so there is nothing on screen saying who wants it cancelled',
    ).toBe(users.admin.username);
  });

  // IC_B_03: the field is filled in on a request nobody has acted on.
  test.fail('IC_B_03 "Approve User" is blank until someone approves', async () => {
    test.skip(seen.approveUser === undefined, 'no request was raised in this run');

    expect(
      seen.approveUser,
      `nobody has approved this request — it was still in the queue — yet the screen names ` +
        `"${seen.approveUser}" as its Approve User`,
    ).toBe('');
  });

  // IC_B_04: the withdrawal works and then reports "Successful Approved.".
  test.fail('IC_B_04 sending a request back does not report it as approved', async () => {
    test.skip(!seen.withdrawn, 'no request was withdrawn in this run');

    const said = seen.withdrawn!.join(' | ');
    expect(
      /approved/i.test(said),
      `Reverse Cancel withdrew the request and said "${said}". On a screen whose other red button grants ` +
        'the cancellation, a withdrawal reported as an approval is the wrong message to leave on screen.',
    ).toBe(false);
  });

  test('IC_02 grants a cancellation, and the item and its money leave the bill', async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(!SHOULD_APPROVE, 'CANCEL_APPROVE=0 — nothing is granted');

    const cancel = await openRequest(page);
    await cancel.findInvoice(INVOICE);
    const before = await cancel.rowData();
    report(`invoice ${INVOICE} before the cancellation`, before);

    // The cheapest thing on the bill that has not been reported on: this test
    // cannot put back what it spends, so it spends as little as possible.
    const candidates = before
      .filter((r) => r.selectable && !SETTLED.test(r.status))
      .sort((a, b) => Number(a.total) - Number(b.total));
    test.skip(
      candidates.length === 0,
      `every item on ${INVOICE} has been reported on already; granting a cancellation against one of ` +
        'those is IC_03, which is opt-in. Point CANCEL_INVOICE at a fresher bill',
    );

    const target = candidates[0];
    console.log(`cancelling ${target.testCode} ${target.testName}, ${target.total} Tk (${target.status})`);

    await cancel.select(target.testName);
    await cancel.setRemarks(REASON);
    expect((await cancel.submit()).join(' | ')).toMatch(/request sent successfully/i);

    const approval = await openApproval(page);
    expect(await approval.open(INVOICE), 'the request should be queued for approval').toBe(true);

    await approval.select(target.testName);
    const amounts = await approval.amounts();
    console.log(`amounts on approval: ${JSON.stringify(amounts)}`);

    expect(Number(amounts.total), 'the screen should be about to refund this item and nothing else').toBe(
      Number(target.total),
    );
    expect(Number(amounts.refund), 'and the refund is the item less the discount it carried').toBeCloseTo(
      Number(amounts.total) - Number(amounts.discount),
      2,
    );

    const granted = await approval.approve(/cancel|success/i);
    console.log(`Cancel Item said: ${JSON.stringify(granted)}`);
    seen.selfApproved = /success/i.test(granted.join(' '));
    expect(granted.join(' | ')).toMatch(/successful cancel/i);

    // Gone from the queue, gone from the bill.
    await approval.goto();
    expect(await approval.pending(), 'a granted request should leave the queue').not.toEqual(
      expect.arrayContaining([expect.stringContaining(INVOICE)]),
    );

    const after = await openRequest(page);
    await after.findInvoice(INVOICE);
    const left = await after.rowData();
    report(`invoice ${INVOICE} after the cancellation`, left);

    expect(left.map((r) => r.testCode), 'the cancelled item should be off the bill').not.toContain(target.testCode);
    expect(left.length, 'and nothing else should have gone with it').toBe(before.length - 1);
  });

  // IC_B_07: Admin02 raised the request in IC_02 and Admin02 granted it, on a
  // screen that keeps an Entry User and an Approve User field precisely
  // because two people are meant to be involved.
  test.fail('IC_B_07 a request cannot be granted by the person who raised it', async () => {
    test.skip(seen.selfApproved === undefined, 'no cancellation was granted in this run');

    expect(
      seen.selfApproved,
      `${users.admin.username} raised the request and ${users.admin.username} pressed Cancel Item on it, ` +
        'in one session, with nothing in the way. Two screens and two user fields say this is meant to be ' +
        'maker-checker; nothing enforces it.',
    ).toBe(false);
  });

  test('IC_03 cancelling a finalized test takes its published report with it', async ({ page }) => {
    test.setTimeout(420_000);
    test.skip(
      !SHOULD_CANCEL_FINALIZED,
      'CANCEL_FINALIZED=1 to run this — it grants a cancellation against a test whose report has been ' +
        'signed off and published, and that cannot be put back',
    );

    const published = new LabReportPublishedGroupWisePage(page);
    await published.goto();
    const to = new Date();
    const from = new Date(to.getTime() - PUBLISHED_DAYS_BACK * 24 * 60 * 60 * 1000);
    await published.setDateRange(from, to);
    await published.findInvoice(INVOICE);
    const publishedBefore = await published.publishedTests(INVOICE);
    console.log(`published before: ${JSON.stringify(publishedBefore)}`);
    test.skip(publishedBefore.length === 0, `invoice ${INVOICE} has no published report to contradict`);

    const cancel = await openRequest(page);
    await cancel.findInvoice(INVOICE);
    const rows = await cancel.rowData();
    const target = rows.find(
      (r) => r.selectable && SETTLED.test(r.status) && publishedBefore.some((t) => t.toUpperCase() === r.testName.toUpperCase()),
    );
    test.skip(!target, `nothing on ${INVOICE} is both published and still offered for cancellation`);
    console.log(`cancelling the finalized ${target!.testCode} ${target!.testName} (${target!.status})`);

    await cancel.select(target!.testName);
    await cancel.setRemarks('Automation check: cancelling a test whose report is signed off and published');
    const raised = await cancel.submit();
    console.log(`Request Approval said: ${JSON.stringify(raised)}`);

    const approval = await openApproval(page);
    expect(await approval.open(INVOICE), 'the request should be queued for approval').toBe(true);
    await approval.select(target!.testName);
    const granted = await approval.approve(/cancel|success|not/i);
    console.log(`Cancel Item said: ${JSON.stringify(granted)}`);

    await published.goto();
    await published.setDateRange(from, to);
    await published.findInvoice(INVOICE);
    const publishedAfter = await published.publishedTests(INVOICE);
    console.log(`published after: ${JSON.stringify(publishedAfter)}`);

    expect(
      publishedAfter.map((t) => t.toUpperCase()),
      `the bill for ${target!.testName} has been cancelled and refunded, so the counter should no longer ` +
        'be holding a published report to hand over for it',
    ).not.toContain(target!.testName.toUpperCase());
  });
});

/**
 * The read-only half: IC_B_01, IC_B_05, IC_B_06 and the IC_N_* cases.
 *
 * Nothing here posts. The only buttons pressed are the two that validate
 * before they do anything — Request Approval with nothing ticked or no reason
 * written, and Cancel Item with nothing picked — so these can be run as often
 * as you like, against any data.
 */
test.describe('Investigation cancellation — negative', () => {
  // --- what may be cancelled ----------------------------------------------

  // IC_B_01: all nine rows of a finalized, published and delivered invoice
  // were tickable, and a request against one of them was accepted.
  test.fail('IC_B_01 a test whose report is finalized is not offered for cancellation', async ({ page }) => {
    test.setTimeout(180_000);
    const cancel = await openRequest(page);
    await cancel.findInvoice(INVOICE);

    const rows = await cancel.rowData();
    report(`invoice ${INVOICE}`, rows);

    const settled = rows.filter((r) => SETTLED.test(r.status));
    test.skip(
      settled.length === 0,
      `no item on ${INVOICE} has been reported on yet; run the chain through 8-finalize, or point ` +
        'CANCEL_INVOICE at an invoice whose results are signed off',
    );

    const offered = settled.filter((r) => r.selectable);
    expect(
      offered.map((r) => `${r.testName} (${r.status})`),
      'these results are signed off and the reports have gone out — the screen should not be offering ' +
        'to cancel the bill for them, or should at least say what it is about to undo',
    ).toEqual([]);
  });

  test('IC_N_01 the header checkbox ticks only what may be cancelled', async ({ page }) => {
    const cancel = await openRequest(page);
    await cancel.findInvoice(INVOICE);
    test.skip((await cancel.rows.count()) === 0, `invoice ${INVOICE} has nothing left to cancel`);

    await cancel.selectAll.click();
    await page.waitForTimeout(3_000);

    const ticked = (await cancel.rowData()).filter((r) => r.selected);
    console.log(`select-all ticked ${ticked.length} row(s): ${ticked.map((r) => r.status).join(', ')}`);

    // Documents the blast radius of one click rather than asserting a count:
    // what it ought to leave alone is IC_B_01's claim, not this one's.
    expect(ticked.length, 'the header checkbox should tick something').toBeGreaterThan(0);
  });

  // --- the invoice number box ---------------------------------------------

  test('IC_N_02 an invoice that does not exist is refused by name', async ({ page }) => {
    const cancel = await openRequest(page);
    await cancel.clearSnackbars();

    const rows = await cancel.findInvoice(MISSING_INVOICE);
    const said = await cancel.waitForSnackbar(/not found/i);

    expect(rows, 'nothing should be listed for an invoice that does not exist').toBe(0);
    expect(said.join(' | '), 'the screen should say so rather than empty the grid in silence').toMatch(/not found/i);
    expect(Object.values(await cancel.header()).join('').trim(), 'and no patient should be left on screen').toBe('');
  });

  test('IC_N_03 letters typed into the invoice box are ignored', async ({ page }) => {
    const cancel = await openRequest(page);
    const failures = watchForServerErrors(page);

    await cancel.invoiceNo.click();
    await cancel.invoiceNo.fill('');
    await cancel.invoiceNo.pressSequentially('abc', { delay: 60 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);

    const held = await cancel.invoiceBoxValue();
    console.log(`typed "abc", the box holds "${held}"`);
    expect(held, 'a number box should not be holding letters').toMatch(/^0?$/);
    expect(failures, 'and nothing should have reached the server').toEqual([]);
  });

  for (const [id, payload] of [
    ['IC_N_04', "' OR 1=1--"],
    ['IC_N_05', '<script>alert(1)</script>'],
  ] as const) {
    test(`${id} "${payload}" in the approval search is handled without a server error`, async ({ page }) => {
      const approval = await openApproval(page);
      const failures = watchForServerErrors(page);
      let dialog = false;
      page.on('dialog', async (d) => {
        dialog = true;
        await d.dismiss();
      });

      const rows = await approval.searchFor(payload);

      expect(failures, `"${payload}" must not reach the database unescaped`).toEqual([]);
      expect(dialog, 'and must never be executed as script').toBe(false);
      expect(rows, 'an injection that worked would return rows it has no business returning').toBe(0);
    });
  }

  // IC_B_05: the previous patient and their tests stay on screen.
  test.fail('IC_B_05 clearing the invoice number clears the screen with it', async ({ page }) => {
    test.setTimeout(180_000);
    const cancel = await openRequest(page);

    await cancel.findInvoice(INVOICE);
    const loaded = await cancel.header();
    test.skip(!loaded['Patient Name'], `invoice ${INVOICE} did not load, so there is nothing to clear`);
    console.log(`loaded: ${JSON.stringify(loaded)}`);

    await cancel.invoiceNo.click();
    await cancel.invoiceNo.fill('');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(4_000);

    const after = await cancel.header();
    const rows = await cancel.rowData();
    console.log(`box now holds "${await cancel.invoiceBoxValue()}", header ${JSON.stringify(after)}`);

    expect(
      `${after['Patient Name']} / ${rows.length} row(s)`,
      `the box is empty but ${after['Patient Name']}'s ${rows.length} test(s) are still listed and still ` +
        'tickable — a cancellation raised now goes against a patient whose number is no longer on screen',
    ).toBe(' / 0 row(s)');
  });

  // --- Request Approval validates -----------------------------------------

  test('IC_N_06 Request Approval warns when no test is ticked', async ({ page }) => {
    const cancel = await openRequest(page);
    await cancel.findInvoice(INVOICE);
    test.skip((await cancel.rows.count()) === 0, `invoice ${INVOICE} has nothing left to cancel`);

    await cancel.setRemarks('Automation check: nothing ticked on purpose');
    const said = await cancel.submit(/select at least one/i);

    expect(said.join(' | ')).toMatch(/select at least one test/i);
  });

  test('IC_N_07 Request Approval warns when no reason is written', async ({ page }) => {
    const cancel = await openRequest(page);
    await cancel.findInvoice(INVOICE);
    const rows = await cancel.rowData();
    test.skip(rows.length === 0, `invoice ${INVOICE} has nothing left to cancel`);

    await cancel.select(rows[0].testName);
    await cancel.remarks.fill('');
    const said = await cancel.submit(/remarks/i);

    expect(said.join(' | '), 'Remarks is starred on the form, and the server agrees').toMatch(/remarks is required/i);
  });

  test('IC_N_08 the reason box stops at 500 characters', async ({ page }) => {
    const cancel = await openRequest(page);

    await cancel.remarks.click();
    await cancel.remarks.fill('x'.repeat(600));
    await page.waitForTimeout(1_000);

    expect((await cancel.remarks.inputValue()).length).toBe(500);
  });

  // --- the approval screen ------------------------------------------------

  test('IC_N_09 Cancel Item warns when nothing is picked', async ({ page }) => {
    const approval = await openApproval(page);

    const said = await approval.approve(/select/i);
    expect(said.join(' | ')).toMatch(/select detail/i);
  });

  test('IC_N_10 Cancel Item warns when a request is open but no item is ticked', async ({ page }) => {
    test.setTimeout(180_000);
    const approval = await openApproval(page);
    const queued = await approval.pending();
    test.skip(queued.length === 0, 'the approval queue is empty, so there is no request to open');

    await approval.queueRows.first().click();
    await page.waitForTimeout(4_000);
    const before = await approval.detailRows.count();

    const said = await approval.approve(/select/i);

    expect(said.join(' | ')).toMatch(/select detail/i);
    expect(await approval.detailRows.count(), 'and nothing should have been cancelled').toBe(before);
  });

  test('IC_N_11 the amounts are worked out from the ticked items, not typed', async ({ page }) => {
    test.setTimeout(180_000);
    const approval = await openApproval(page);
    const queued = await approval.pending();
    test.skip(queued.length === 0, 'the approval queue is empty, so there is no request to open');

    await approval.queueRows.first().click();
    await page.waitForTimeout(4_000);
    const items = await approval.rowData();
    test.skip(items.length === 0, 'the queued request lists no items');

    for (const [label, field] of [
      ['Total Tk', approval.total],
      ['Disc Tk', approval.discount],
      ['Refund', approval.refund],
    ] as const) {
      expect(await field.isDisabled(), `${label} should not be typeable by the approver`).toBe(true);
    }

    const empty = await approval.amounts();
    expect(Number(empty.refund), 'nothing ticked, nothing to refund').toBe(0);

    await approval.select(items[0].testName);
    const filled = await approval.amounts();
    console.log(`${items[0].testName}: ${JSON.stringify(filled)}`);

    expect(Number(filled.total), 'the ticked item carries its own total across').toBe(Number(items[0].total));
    expect(
      Number(filled.refund),
      'and the refund is that total less the share of the discount the item carried',
    ).toBeCloseTo(Number(filled.total) - Number(filled.discount), 2);
  });

  // --- the menu ------------------------------------------------------------

  // IC_B_06: the sidebar's own hrefs have the two routes the wrong way round.
  test.fail('IC_B_06 each menu entry is served from the route its name describes', async ({ page }) => {
    const cancel = await openRequest(page);

    const requestMenu = page.getByRole('link', { name: 'Send Request for Cancel' }).first();
    const approveMenu = page.getByRole('link', { name: 'Approve Cancel Request' }).first();
    const requestHref = await requestMenu.getAttribute('href');
    const approveHref = await approveMenu.getAttribute('href');

    console.log(`"Send Request for Cancel" -> ${requestHref}`);
    console.log(`"Approve Cancel Request"  -> ${approveHref}`);
    // The screen under the first link really is the request form: it is the
    // one with the Request Approval button on it.
    await expect(cancel.requestApproval).toBeVisible();

    expect(
      { request: requestHref, approve: approveHref },
      'the request form is served from the "-approval" route and the approval screen from the plain one',
    ).toEqual({ request: ROUTES.investigationCancelApproval, approve: ROUTES.investigationCancelRequest });
  });

  // --- out of reach from here ---------------------------------------------

  test('IC_N_12 a cancellation mid-round-trip leaves the sample screens with it', async () => {
    test.skip(
      true,
      'IC_02 grants a cancellation against an item with no sample and IC_03 against a finalized one, so the ' +
        'middle of the round trip — collected and dispatched, not yet reported on — is the one state neither ' +
        'covers. It needs a bill sitting exactly there, which means running the chain through 5-acknowledge ' +
        'and cancelling before result entry; worth folding into the chain rather than faking here.',
    );
  });

  test('IC_N_13 the refund reaches the counter, not just the bill', async () => {
    test.skip(
      true,
      'IC_02 proves the item and its money leave the bill — the screen works the refund out and answers ' +
        '"Successful Cancel". Where that refund then shows up for a bill already settled in cash is a finance ' +
        'question these two screens do not answer; it wants Due Collection and the day-end figures read ' +
        'alongside, which is a spec of its own.',
    );
  });

  test('IC_N_14 two approvers granting the same request at once', async () => {
    test.skip(
      true,
      'Needs two sessions racing on one queued request, and the loser cannot be told apart from an ordinary ' +
        '"already approved" from outside. Manual, and on a test database — the winner refunds a live bill.',
    );
  });
});
