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
} as const;
