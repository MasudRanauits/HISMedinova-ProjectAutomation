/** Saved signed-in session, produced by tests/auth/auth.setup.ts. */
export const ADMIN_STORAGE_STATE = 'playwright/.auth/admin.json';

/**
 * Saved pathologist session, produced by tests/auth/pathologist.setup.ts.
 *
 * Kept apart from the administrator's rather than overwriting it: the two
 * accounts see different menus, and a spec that needs one of them should not
 * depend on whichever setup happened to run last.
 */
export const PATHOLOGIST_STORAGE_STATE = 'playwright/.auth/pathologist.json';

export const ROUTES = {
  login: '/Account/Login',
  home: '/',
  newPatient: '/hospital/patients/new',
  investigation: '/diagnostic/investigation',
  investigationDashboard: '/diagnostic/investigation-dashboard',
  // Where a bill raised on the Corporate Patient tab of OPD Investigation
  // Entry goes. It does not reach the diagnostic dashboard above at all, and
  // it sits under Corporate Management rather than Diagnostic — hence the
  // "marketing" route.
  corporateInvoiceDashboard: '/marketing/corporate-invoice-dashboard',
  // Cancelling a billed test is two screens, and their routes are the wrong
  // way round. The sidebar's "Send Request for Cancel" — where the request is
  // raised — is served from ".../investigation-cancel-approval", and "Approve
  // Cancel Request", where it is granted, from ".../investigation-cancel".
  // Read off the sidebar's own hrefs, not guessed; IC_B_06 holds the app to
  // the naming it ought to have.
  investigationCancelRequest: '/diagnostic/investigation-cancel-approval',
  investigationCancelApproval: '/diagnostic/investigation-cancel',
  // Where the counter takes the rest of the money on a bill posted with a due.
  // The sidebar lists a "Dashboard (Diagnostic-Due)" right beside it, which
  // reports on the same dues rather than collecting them.
  dueCollection: '/diagnostic/due-collection',
  sampleCollection: '/diagnostic/sample-collection',
  sampleAcknowledgementLab: '/diagnostic/sample-acknowledgement-lab',
  // The sidebar calls this one "LAB Result Entry"; the route keeps the older
  // "pathology" name.
  labResultEntry: '/diagnosis/pathology-result-entry',
  // Where the pathologist checks and signs off what result entry saved.
  labResultFinalization: '/diagnosis/pathology-result-finalized',
  // The sidebar calls this one "Microbiology Report"; the route keeps the older
  // "cs" (culture and sensitivity) name. Not to be confused with
  // /diagnosis/cs-report-dashboard, which the menu lists right beside it.
  csReport: '/diagnostic/cs-report',
  // The counter hands the finished report to the patient here. Like the two
  // above, the sidebar's "Report Delivery" sits on a "diagnosis" route rather
  // than a "diagnostic" one; the menu lists a "Report Deliver New" beside it,
  // which is a different screen.
  reportDelivery: '/diagnosis/report-delivery',
  // Where a finalized report turns up, one row per test group rather than one
  // per invoice. The sidebar calls it "Lab Report Published Group Wise"; the
  // route is the plain published screen's with a "2" on the end. The menu lists
  // four more "... Published" screens around it — "Lab Report Published"
  // (/diagnosis/lab-report-published) is the ungrouped one beside it, and is a
  // different screen.
  labReportPublishedGroupWise: '/diagnosis/lab-report-published2',
} as const;
