import { defineConfig, devices } from '@playwright/test';
import { ADMIN_STORAGE_STATE, PATHOLOGIST_STORAGE_STATE } from './utils/constants';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * A maximised desktop Chrome.
 *
 * `devices['Desktop Chrome']` pins the viewport to 1280x720, which leaves the
 * page letterboxed inside the window and makes the wider grids — the dispatch
 * one is fifteen columns — scroll sideways. Clearing the viewport hands the
 * page the whole window instead, and the window is opened at full screen size.
 */
const { deviceScaleFactor, ...desktopChrome } = devices['Desktop Chrome'];
const DESKTOP = {
  ...desktopChrome,
  // A scale factor cannot be set alongside a cleared viewport, and the preset
  // carries one, so it is dropped above rather than overridden here.
  viewport: null,
};

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  /* The Blazor Server UI re-renders over the circuit on nearly every keystroke,
     so a full form takes well past the 30s default. */
  timeout: 90_000,
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* One worker, so the run never opens a second browser: the authenticated
     projects share a single tab (see fixtures/test.ts) and the screens are
     driven one after another, the way a person would. */
  workers: 1,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    baseURL: process.env.BASE_URL ?? 'https://202.4.101.118:1115/',

    /* The server uses a self-signed certificate. */
    ignoreHTTPSErrors: true,

    /* Run with a visible browser window, opened at full screen size. */
    headless: false,
    launchOptions: { args: ['--start-maximized'] },

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    /* Signs in once and writes the session file the authenticated project reuses. */
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...DESKTOP },
    },

    /* Tests that must start signed out. */
    {
      name: 'chromium-noauth',
      testMatch: /login\.spec\.ts/,
      use: { ...DESKTOP },
    },

    /**
     * The diagnostic round trip, as one ordered chain.
     *
     * These specs hand work to each other: registering a patient tells the
     * invoice spec which UHID to bill, and posting that invoice tells the three
     * sample specs which invoice to work on (see fixtures/test.ts). Run as one
     * project they would go in file order — acknowledgement before collection,
     * registration last of all — and every stage would be looking at the wrong
     * invoice. A project per stage, each depending on the one before, is what
     * puts them in the order the screens are actually used in.
     *
     * A failed stage skips the ones after it, so a break shows up as a single
     * failure rather than five.
     *
     * `--project=<stage>` runs a stage together with everything it depends on;
     * add `--no-deps` to run only that stage, against whatever invoice is
     * recorded in test-data.
     */
    ...[
      { name: '1-register', file: /new-registration\.spec\.ts/ },
      { name: '2-invoice', file: /investigation-invoice\.spec\.ts/ },
      { name: '3-collect', file: /sample-collection\.spec\.ts/ },
      { name: '4-dispatch', file: /sample-dispatch\.spec\.ts/ },
      { name: '5-acknowledge', file: /sample-acknowledgement\.spec\.ts/ },
      /* Reprinting labels changes nothing, so it sits at the end of the chain
         rather than in the middle of it. */
      { name: '6-labels', file: /sample-label-print\.spec\.ts/ },
      /* Reprinting an invoice from the dashboard changes nothing either, and it
         needs no invoice of its own — it reports on whatever the last three days
         hold. It sits beside the label reprints for the same reason, and is
         lettered rather than numbered so the stages after it keep the names
         `--project=` and `test:chain` already use. */
      { name: '6b-dashboard-print', file: /investigation-dashboard-print\.spec\.ts/ },
      /* Results can only be entered once the lab has acknowledged the samples,
         so this follows acknowledgement; it is put after label printing only
         because that stage changes no status and can sit anywhere. */
      { name: '7-result-entry', file: /lab-result-entry\.spec\.ts/ },
    ].map((stage, index, stages) => ({
      name: stage.name,
      testMatch: stage.file,
      dependencies: [index === 0 ? 'setup' : stages[index - 1].name],
      use: {
        ...DESKTOP,
        storageState: ADMIN_STORAGE_STATE,
      },
    })),

    /**
     * The pathologist's half of the round trip, and why it hangs off the chain.
     *
     * `setup-pathologist` signs the administrator out — on the server, not just
     * in the browser — which leaves the session file the whole chain above runs
     * on holding a dead cookie. So the switch has to wait until the
     * administrator has no work left: it depends on `7-result-entry`, the last
     * stage that account performs. Depending on `setup` alone left the order to
     * declaration order, which holds only in a full-suite run —
     * `--project=8-finalize` would then switch accounts without the results
     * having been entered at all.
     *
     * `8-finalize` still hangs off the switch rather than off `7-result-entry`
     * directly, because what it needs is the other account; the invoice it
     * works on is whichever one is recorded in test-data.
     */
    {
      name: 'setup-pathologist',
      testMatch: /pathologist\.setup\.ts/,
      dependencies: ['7-result-entry'],
      use: { ...DESKTOP, storageState: ADMIN_STORAGE_STATE },
    },
    {
      name: '8-finalize',
      testMatch: /lab-result-finalization\.spec\.ts/,
      dependencies: ['setup-pathologist'],
      use: { ...DESKTOP, storageState: PATHOLOGIST_STORAGE_STATE },
    },

    /**
     * Hands the browser back once the pathologist is done.
     *
     * Depends on `8-finalize` so it lands after the report is signed off, which
     * is where the switch back belongs — and it rewrites the administrator's
     * session file, which `setup-pathologist` invalidated on its way out.
     */
    {
      name: 'setup-administrator',
      testMatch: /administrator\.setup\.ts/,
      dependencies: ['8-finalize'],
      use: { ...DESKTOP, storageState: PATHOLOGIST_STORAGE_STATE },
    },

    /**
     * The microbiology report, which stands apart from the chain above.
     *
     * A bill only reaches this screen if it carries a culture test whose sample
     * the lab has acknowledged, and it leaves for good once its report is
     * finalized — so it works on whatever the Pending tab is offering rather
     * than on the invoice the chain raised (see
     * tests/diagnostic/microbiology-report.spec.ts).
     *
     * It runs as the administrator, and it depends on `setup-administrator`
     * purely for the session: that is the stage that signs that account back in
     * after the pathologist has had the browser, so this is the first point in a
     * full run where the administrator's session file is valid again.
     */
    {
      name: '9-cs-report',
      testMatch: /microbiology-report\.spec\.ts/,
      dependencies: ['setup-administrator'],
      use: { ...DESKTOP, storageState: ADMIN_STORAGE_STATE },
    },

    /**
     * Handing the finished reports to the patient, which is where the round trip
     * ends.
     *
     * It works on the invoice the chain raised, and it can only do so once: the
     * screen's stages are one-way, so a second run finds its lists empty. It
     * runs as the administrator, and follows the microbiology report only
     * because that is the last stage to touch the reports before the counter
     * does.
     */
    {
      name: '10-report-delivery',
      testMatch: /report-delivery\.spec\.ts/,
      dependencies: ['9-cs-report'],
      use: { ...DESKTOP, storageState: ADMIN_STORAGE_STATE },
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
