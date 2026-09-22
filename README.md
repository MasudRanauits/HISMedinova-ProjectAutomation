# HIS Medinova — Playwright Automation

End-to-end UI tests for the Medinova HIS (a Blazor Server application), written with
[Playwright Test](https://playwright.dev/) and TypeScript.

The suite drives the diagnostic round trip the way a person works through it: register a
patient, bill their investigations, then collect, dispatch and acknowledge that invoice's
samples, and finally reprint its labels.

> **These tests run against a live server and write real data.** Posting an invoice, printing
> a label, dispatching and acknowledging all commit against the running system and cannot be
> undone from the UI. Read [Dry runs](#dry-runs) before your first run.

---

## Getting started

```powershell
npm install
npx playwright install
npm test
```

Node LTS is assumed. The tests run **headed** and maximised by default (see
[playwright.config.ts](playwright.config.ts)) — they are meant to be watched.

### Target server

The base URL defaults to `https://202.4.101.118:1115/` and can be overridden:

```powershell
$env:BASE_URL = "https://your-host:port/"; npm test
```

The server uses a self-signed certificate, so `ignoreHTTPSErrors` is on.

### Credentials

Login details live in `test-data/users.json`, which is **not in the repository** — it holds
working passwords for a live server, and those do not belong in version control. Copy the
template and fill it in once, on the machine that runs the tests:

```powershell
Copy-Item test-data/users.example.json test-data/users.json
```

Two accounts have to be filled for the suite to run: `admin` (`Admin02`, Administrator) and
`pathologist` (`Sazia02`, Dr. Sazia Afreen). The remaining role accounts are listed with empty
passwords because ASP.NET Identity stores them hashed and they cannot be read back from the
app. Several tests are skipped purely for want of a second account — fill one in and they
become real tests.

### Switching accounts

Two projects hand the browser from one account to the other the way a person does — open the
app, sign out through the header menu, sign the next account in:

| Project | Switch |
| --- | --- |
| `setup-pathologist` | administrator → pathologist, before the report is finalized |
| `setup-administrator` | pathologist → administrator, once it has been |

```powershell
npx playwright test --project=setup-pathologist --no-deps    # then work as Dr. Sazia Afreen
npx playwright test --project=setup-administrator --no-deps  # and hand it back
```

`--no-deps` matters here: `setup-pathologist` now depends on `7-result-entry`, so without it
the command runs the whole chain from registration first.

The two sessions are saved separately — `playwright/.auth/admin.json` and
`playwright/.auth/pathologist.json` — so neither overwrites the other and a spec can ask for
whichever it needs.

Signing out ends a session **on the server**, not just in the browser, so `setup-pathologist`
leaves `admin.json` holding a cookie that no longer works. `setup-administrator` signs back in
and rewrites it, which is why it is worth running rather than just closing the browser: without
it, a `--no-deps` run of any chain stage fails on the dead session until `--project=setup` is
run again.

---

## How a run is put together

### The chain

The specs hand identifiers to each other, so they cannot run in file order. Each stage is its
own Playwright project, depending on the one before it:

```
setup → 1-register → 2-invoice → 3-collect → 4-dispatch → 5-acknowledge → 6-labels → 7-result-entry
      → setup-pathologist → 8-finalize → setup-administrator → 9-cs-report → 10-report-delivery
```

| Project | Spec | What it does |
| --- | --- | --- |
| `setup` | [tests/auth/auth.setup.ts](tests/auth/auth.setup.ts) | Signs in once, saves the session to `playwright/.auth/admin.json` |
| `setup-pathologist` | [tests/auth/pathologist.setup.ts](tests/auth/pathologist.setup.ts) | Signs the administrator out and the pathologist in, saving that session separately |
| `setup-administrator` | [tests/auth/administrator.setup.ts](tests/auth/administrator.setup.ts) | Signs the pathologist out and the administrator back in once the report is finalized, repairing `admin.json` |
| `chromium-noauth` | [tests/auth/login.spec.ts](tests/auth/login.spec.ts) | Valid and invalid login, starting signed out |
| `1-register` | [tests/patients/new-registration.spec.ts](tests/patients/new-registration.spec.ts) | Registers a patient, records the new UHID |
| `2-invoice` | [tests/diagnostic/investigation-invoice.spec.ts](tests/diagnostic/investigation-invoice.spec.ts) | Bills five tests with a staff discount, settles in cash, records the invoice no |
| `3-collect` | [tests/diagnostic/sample-collection.spec.ts](tests/diagnostic/sample-collection.spec.ts) | Partial collection in two batches, plus a negative suite |
| `4-dispatch` | [tests/diagnostic/sample-dispatch.spec.ts](tests/diagnostic/sample-dispatch.spec.ts) | Refuses a carrier-less dispatch, then sends in two batches |
| `5-acknowledge` | [tests/diagnostic/sample-acknowledgement.spec.ts](tests/diagnostic/sample-acknowledgement.spec.ts) | Receives the samples in the lab, in two batches |
| `6-labels` | [tests/diagnostic/sample-label-print.spec.ts](tests/diagnostic/sample-label-print.spec.ts) | Reprints labels one by one, then all, then the token |
| `7-result-entry` | [tests/diagnostic/lab-result-entry.spec.ts](tests/diagnostic/lab-result-entry.spec.ts) | Enters every result on the invoice, names a technologist, saves, then finds it again under Done |
| `8-finalize` | [tests/diagnostic/lab-result-finalization.spec.ts](tests/diagnostic/lab-result-finalization.spec.ts) | **As the pathologist.** Reaches the screen through the Diagnostic menu, corrects two of one test's results, gives a result to any list left on a placeholder, writes a remark against every test, changes the technologist, and checks a second press of Save cannot file the report twice |
| `9-cs-report` | [tests/diagnostic/microbiology-report.spec.ts](tests/diagnostic/microbiology-report.spec.ts) | Fills a microbiology (culture and sensitivity) report — test, pathologist, technologist, growth, organism, colony counts, C/S message, culture media, ten antibiogram cells and a note — then double-clicks Save, prints and reads the PDF back, and double-clicks Finalize |
| `10-report-delivery` | [tests/diagnostic/report-delivery.spec.ts](tests/diagnostic/report-delivery.spec.ts) | Finds the invoice by date range and number, acknowledges its pending reports, then ticks the acknowledged ones in order, delivers them to the patient, prints them all and reprints one from its own row |

`setup-pathologist` hangs off `7-result-entry`. The switch signs the administrator out on the
**server**, so it has to wait until that account has no work left, and result entry is the last
stage it performs. `8-finalize` then hangs off the switch rather than off `7-result-entry`
directly, because what it needs is the other account — the invoice it works on is whichever one
is recorded in test data. `setup-administrator` hangs off `8-finalize`, so the hand-back lands
after the report is signed off.

`9-cs-report` is the one stage that is not really part of the chain. The Microbiology Report
screen only lists a bill once it carries a culture test whose sample the lab has acknowledged,
and the bill leaves its Pending tab for good once the report is finalized — so the invoice the
chain raised is usually not one of them. The spec therefore takes `csReport.invoiceNo` if the
Pending tab happens to be listing it and otherwise works on the first bill on offer, saying
which it chose. It hangs off `setup-administrator` purely for the session: that is the stage
that signs the administrator back in after the pathologist has had the browser.

`10-report-delivery` is where the round trip ends, at the counter that hands the finished
reports to the patient. Its three radio buttons — Not Acknowledged, Acknowledged, Delivery —
are stages rather than filters, and each is **one-way**: a report that has been acknowledged is
gone from the pending list for good, and one that has been delivered is gone from the
acknowledged list. So the spec can only be run once against a given invoice; a second run finds
its lists empty and stops with a note saying so rather than failing.

Two things about that screen are worth knowing before reading the spec. The **Invoice No** box
is searched on its own — the date range above it does not bound it, so an invoice raised days
before the range starts is still found by number — and it is bound on blur, so the first press
of Show can come back with the list unfiltered (`findInvoice` presses again for exactly that).
And **Print All** is drawn only while the grid it prints has rows: delivering is what empties
the acknowledged grid, so the print lands on the Delivery list, against the reports that were
just handed over.

A full run therefore ends where it started — signed in as the administrator, with both session
files valid.

A failed stage skips the ones after it, so a break shows up as one failure rather than five.

`--project=<stage>` runs a stage **together with everything it depends on**. Add `--no-deps`
to run only that stage against whatever invoice is currently recorded in test data.

### How state travels between specs

Playwright gives spec files no shared memory, so the identifiers are written back into
[test-data/investigations.json](test-data/investigations.json) by `recordUhid` and
`recordInvoiceNo` in [fixtures/test.ts](fixtures/test.ts#L101-L115). Registering a patient
points the invoice spec at the new UHID; posting that invoice points the three sample specs
at the new invoice number. Nothing is edited by hand in between — edit those values yourself
only to aim a single spec at an older invoice.

### One browser, one tab

`workers: 1`, `fullyParallel: false`, and a worker-scoped `sharedContext` fixture
([fixtures/test.ts](fixtures/test.ts#L34-L53)) mean the whole run happens in a single tab,
rather than flickering through a window per test. The signed-in session comes from each
project's `storageState`.

The default timeout is **90s** — the Blazor circuit re-renders on nearly every keystroke, so
a full form takes well past Playwright's 30s default. The heavier specs raise it further.

---

## Dry runs

Every mutating spec can be walked through without committing anything. Each flag makes the
test fill the form, tick the grid and assert on what it sees, then stop short of the save:

| Variable | Set to `0` to skip | Spec |
| --- | --- | --- |
| `INVOICE_POST` | posting the invoice | investigation-invoice |
| `SAMPLE_COLLECT` | printing the label (which is what collects) | sample-collection |
| `SAMPLE_DISPATCH` | sending to the carrier | sample-dispatch |
| `SAMPLE_ACK` | acknowledging receipt | sample-acknowledgement |

| `LAB_RESULT_SAVE` | saving the results (and with them the Done check) | lab-result-entry |
| `LAB_FINALIZE_SAVE` | saving the finalized report (and the double-save check) | lab-result-finalization |
| `CS_REPORT_SAVE` | saving the culture report (and with it the print and finalize checks) | microbiology-report |
| `CS_REPORT_FINALIZE` | signing the culture report off, leaving it saved but unfinalized | microbiology-report |
| `REPORT_DELIVERY` | acknowledging the reports and delivering them | report-delivery |

A saved result is a clinical record against a real patient and the screen offers no way
back, so `LAB_RESULT_SAVE=0` is worth reaching for more often than the others. Without the
save there is nothing on the Done tab to look at, so that half of the test is skipped too.

The same goes double for `9-cs-report`: it works on whatever bill the Pending tab is offering
rather than on an invoice the suite raised itself, so a full run signs off a **real patient's
microbiology report**, and a finalized report cannot be reopened from the UI. Two other knobs
make it safer to live with:

| Variable | What it does |
| --- | --- |
| `CS_REPORT_INVOICE` | Names the bill to work on, instead of taking the first one Pending offers |
| `CS_REPORT_SEED` | Repeats a previous run's random antibiogram values — the seed is printed at the top of every run |
| `REPORT_DELIVERY_INVOICE` | Names the invoice `10-report-delivery` works on, instead of the one recorded in test data — worth having because that screen's stages are one-way, so the recorded invoice is spent after a single run |

```powershell
$env:SAMPLE_COLLECT = "0"; npx playwright test --project=3-collect --no-deps
```

Note that collection, dispatch, acknowledgement and report delivery each run as a **serial
pair** — the first test leaves the invoice half-done and the second picks it up there. They
cannot be repeated against the same invoice: a collected test drops out of the grid entirely,
and an acknowledged or delivered report leaves its list for good, so a second run has nothing
to work with. Run the chain from `1-register` for a fresh one, or aim report delivery at
another invoice with `REPORT_DELIVERY_INVOICE`.

Label printing is the exception — it changes no status, so `6-labels` can be re-run freely.

---

## Scripts

| Command | What it runs |
| --- | --- |
| `npm test` | The whole suite |
| `npm run test:headed` | Same, forced headed |
| `npm run test:ui` | Playwright's UI mode |
| `npm run test:auth` | `tests/auth` only |
| `npm run test:patients` | `tests/patients` only |
| `npm run test:diagnostic` | `tests/diagnostic` only |
| `npm run test:chain` | The full chain, end to end (`--project=6-labels` pulls in every dependency) |
| `npm run report` | Opens the last HTML report |
| `npm run typecheck` | `tsc --noEmit` |

---

## Layout

```
fixtures/test.ts     Shared context/page fixtures, and the recorders that pass
                     UHIDs and invoice numbers between specs
pages/               Page objects, one per screen
test-data/           Users (template only — users.json is gitignored), patient details, and
                     the investigation/sample data
                     that drives the diagnostic specs
tests/               Specs, grouped by area (auth, patients, diagnostic)
utils/constants.ts   Routes and the storage-state path
utils/snackbars.ts   Snackbar recorder (see below)
.github/workflows/   CI
```

### Page objects

Each screen is wrapped in a class under [pages/](pages/) exposing locators plus intent-level
methods (`selectInvoice`, `selectOnly`, `pickCarrier`, `rows`). The `rows()` methods return
typed row objects read straight out of the grid, which is what most assertions work against.

Three app quirks shaped these:

- **The date of birth blanks the identity row.** On the registration form, committing a
  date of birth costs a server round trip — the age is worked out and sent back — and the
  render that carries the new age resets Title, Full Name, Given Name, Surname and Gender
  to empty. Filled in the order the form reads, the date destroys the five fields above it.
  `fillPatient` therefore sets it **first**, and `setDateOfBirth` waits for the age to
  appear before returning, so the reset has landed before anything else is typed. Left
  unhandled this fails only sometimes: the render arrives about a second after the picker
  closes, by which time a fast run may already have typed past it.
- **Snackbars.** The app reports the outcome of a save only through a `.snackbar` that appears
  and disappears within about a second, leaving nothing behind. Polling for it from the test
  never catches it, so [utils/snackbars.ts](utils/snackbars.ts) installs a MutationObserver in
  the page and the test reads back everything it saw. Every screen that posts uses it.
- **Grid group headers.** Collection and dispatch grids interleave department header rows with
  the real ones. Row lookups go through a `testRows` getter that keeps only rows carrying a
  checkbox.

### Test data

[test-data/investigations.json](test-data/investigations.json) carries inline `_note` keys
explaining each block. The important convention: autocompletes are driven by a `query` (what
gets typed) plus a `match` regular expression applied to the suggestion text, because a query
alone is ambiguous — `LIPID` returns six hits and `X-RAY` returns 160.

---

## The negative suite

[sample-collection.spec.ts](tests/diagnostic/sample-collection.spec.ts#L159) carries a set of
`SC_N_*` cases covering date-range handling, SQL/XSS payloads in the search box, stale grids,
missing tube mappings and double-clicks.

Two are marked `test.fail` — they describe what the screen *should* do and currently document
defects: a reversed date range is silently treated as an empty result rather than rejected
(`SC_N_01`), and the date picker rolls `31-02-2026` forward to `03-03-2026` instead of
refusing it (`SC_N_02`). They will start failing the build the day those are fixed, which is
the point; convert them to ordinary tests then.

Six more are `test.skip` with the reason recorded in the skip message — each needs something
this environment cannot give (a second operator, a restricted account, an eight-hour session
lapse, a cancelled invoice, or a throwaway database).

---

## CI

[.github/workflows/playwright.yml](.github/workflows/playwright.yml) runs the suite on push
and PR to `main`/`master` and uploads the HTML report for 30 days. On CI, `forbidOnly` is on
and failures retry twice. Note that CI still points at the same live server unless `BASE_URL`
is set in the workflow.
