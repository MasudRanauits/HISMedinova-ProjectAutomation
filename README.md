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
      → 7b-unpublished → setup-pathologist → 8-finalize → setup-administrator → 8b-published
      → 9-cs-report → 10-report-delivery → 11-cancel → 12-due-collection
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
| `4-dispatch` | [tests/diagnostic/sample-dispatch.spec.ts](tests/diagnostic/sample-dispatch.spec.ts) | Refuses a carrier-less dispatch, then sends in two batches, plus a negative suite |
| `5-acknowledge` | [tests/diagnostic/sample-acknowledgement.spec.ts](tests/diagnostic/sample-acknowledgement.spec.ts) | Receives the samples in the lab, in two batches, then checks the invoice has left both pending lists |
| `6-labels` | [tests/diagnostic/sample-label-print.spec.ts](tests/diagnostic/sample-label-print.spec.ts) | Reprints labels one by one, then all, then the token |
| `7-result-entry` | [tests/diagnostic/lab-result-entry.spec.ts](tests/diagnostic/lab-result-entry.spec.ts) | Enters every result on the invoice, names a technologist, saves, then finds it again under Done |
| `7b-unpublished` | [tests/diagnostic/lab-report-unpublished.spec.ts](tests/diagnostic/lab-report-unpublished.spec.ts) | Checks that the invoice is **not** yet on Lab Report Published Group Wise, because nobody has signed its report off. Marked `test.fail`: this build publishes it anyway |
| `8-finalize` | [tests/diagnostic/lab-result-finalization.spec.ts](tests/diagnostic/lab-result-finalization.spec.ts) | **As the pathologist.** Reaches the screen through the Diagnostic menu, corrects two of one test's results, gives a result to any list left on a placeholder, writes a remark against every test, changes the technologist, checks a second press of Save cannot file the report twice, and signs the report off with **Finalize** |
| `8b-published` | [tests/diagnostic/lab-report-published.spec.ts](tests/diagnostic/lab-report-published.spec.ts) | Reads the two screens a finalized report is meant to reach — Lab Report Published Group Wise, a row per test group, and Report Delivery — without changing either |
| `9-cs-report` | [tests/diagnostic/microbiology-report.spec.ts](tests/diagnostic/microbiology-report.spec.ts) | Fills a microbiology (culture and sensitivity) report — test, pathologist, technologist, growth, organism, colony counts, C/S message, culture media, ten antibiogram cells and a note — then double-clicks Save, prints and reads the PDF back, and double-clicks Finalize. Two read-only suites sit beneath it, covering the rest of the screen |
| `10-report-delivery` | [tests/diagnostic/report-delivery.spec.ts](tests/diagnostic/report-delivery.spec.ts) | Finds the invoice by date range and number, acknowledges its pending reports, then ticks the acknowledged ones in order, delivers them to the patient, prints them all and reprints one from its own row |
| `11-cancel` | [tests/diagnostic/investigation-cancel.spec.ts](tests/diagnostic/investigation-cancel.spec.ts) | Cancels a billed test the way the app asks for it — Send Request for Cancel raises the request, Approve Cancel Request queues it — raising one and sending it straight back with Reverse Cancel. Never grants a cancellation |
| `12-due-collection` | [tests/diagnostic/due-collection.spec.ts](tests/diagnostic/due-collection.spec.ts) | Raises a bill with nothing paid, then collects it at the counter — part in cash, part on a card, the rest on a mobile wallet — checking the bill at every stage: due, part paid, paid. Then presses Save on the settled bill to check it is refused, clears a corporate bill of the share owed by the company, and checks a second counter is locked out while one has a bill open |

`setup-pathologist` hangs off `7b-unpublished`. The switch signs the administrator out on the
**server**, so it has to wait until that account has no work left — and `7b-unpublished` is now
the last stage it performs, reading the published screen while the invoice still has nobody's
signature on it. That is a state the chain only passes through: result entry has just left it,
and finalization is about to end it, which is why the check sits between the two rather than
going looking for an unfinalized invoice of its own.

`8-finalize` then hangs off the switch rather than off the stages before it directly, because
what it needs is the other account — the invoice it works on is whichever one is recorded in
test data. `setup-administrator` hangs off `8-finalize`, so the hand-back lands
after the report is signed off.

`9-cs-report` is the one stage that is not really part of the chain. The Microbiology Report
screen only lists a bill once it carries a culture test whose sample the lab has acknowledged,
and the bill leaves its Pending tab for good once the report is finalized — so the invoice the
chain raised is usually not one of them. The spec therefore takes `csReport.invoiceNo` if the
Pending tab happens to be listing it and otherwise works on the first bill on offer, saying
which it chose. It hangs off `setup-administrator` purely for the session: that is the stage
that signs the administrator back in after the pathologist has had the browser.

`8b-published` is the stage after the hand-back, and it only reads: Lab Report Published Group
Wise lists a finalized report one row per **test group** rather than one per invoice — an
invoice carrying endocrinology and biochemistry work is two rows, each naming its own group's
tests — and Report Delivery should be holding the same reports under "Not Acknowledged". It
changes neither screen, so it can be re-run against the same invoice as often as you like, and
it has to come before `10-report-delivery`, which spends them.

Note that the published screen's **Invoice No** box is applied by its **Filter** button, not by
Show: pressing Show with a number typed in comes back with the whole date range as though
nothing had been typed, and nothing on screen says the number was ignored.

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

`11-cancel` is the one stage that takes a bill apart rather than moving it along, and it is
last for the same reason `6-labels` sits near the end: it leaves nothing behind. Cancelling a
test is two screens — **Send Request for Cancel** raises the request against an invoice
number, **Approve Cancel Request** queues it, and only **Cancel Item** on that second screen
takes the money off the bill.

The stage drives both halves. `IC_01` raises a request and sends it straight back with
**Reverse Cancel** — the per-row button that withdraws a request without granting it — so
that test leaves the ledger as it found it. `IC_02` then raises another and **grants** it,
which is the one thing in this suite that cannot be put back: Reverse Cancel undoes a
*pending* request, not a granted one. It therefore picks the cheapest item on the bill that
has not been reported on, and says in the log exactly what it spent. That is only reasonable
because the target is a UAT server — set `CANCEL_APPROVE=0` before aiming `BASE_URL`
anywhere else.

Mind the routes, which are the wrong way round. "Send Request for Cancel" is served from
`/diagnostic/investigation-cancel-approval` and "Approve Cancel Request" from
`/diagnostic/investigation-cancel` — the menu names are right, the URLs read as each
other's. The invoice box on the request screen has no Search button beside it either: it is
bound per keystroke, so the lookup fires on Enter or on blur, and a thirteen-digit number
typed a digit at a time asks the server thirteen questions and is answered "not found" twelve
times on the way past. The page object fills it in one go for exactly that reason.

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
| `CORPORATE_POST` | posting the **corporate** invoice | investigation-invoice |
| `SAMPLE_COLLECT` | printing the label (which is what collects) | sample-collection |
| `SAMPLE_DISPATCH` | sending to the carrier | sample-dispatch |
| `SAMPLE_ACK` | acknowledging receipt | sample-acknowledgement |

| `LAB_RESULT_SAVE` | saving the results (and with them the Done check) | lab-result-entry |
| `LAB_FINALIZE_SAVE` | saving the finalized report (and the double-save check) | lab-result-finalization |
| `LAB_FINALIZE_PUBLISH` | pressing Finalize, leaving the report saved but unsigned | lab-result-finalization |
| `CS_REPORT_SAVE` | saving the culture report (and with it the print and finalize checks) | microbiology-report |
| `CS_REPORT_FINALIZE` | signing the culture report off, leaving it saved but unfinalized | microbiology-report |
| `REPORT_DELIVERY` | acknowledging the reports and delivering them | report-delivery |
| `CANCEL_REQUEST` | raising the cancel request (and with it the withdrawal that puts it back) | investigation-cancel |
| `CANCEL_APPROVE` | **granting** the cancellation — `IC_02`, the one step in the suite nothing can undo | investigation-cancel |

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
| `LAB_PUBLISHED_INVOICE` | Names the invoice `7b-unpublished` and `8b-published` read, instead of the one recorded in test data. Both only read, so either can be re-run against the same invoice as often as you like |
| `REPORT_DELIVERY_INVOICE` | Names the invoice `10-report-delivery` works on, instead of the one recorded in test data — worth having because that screen's stages are one-way, so the recorded invoice is spent after a single run |
| `CANCEL_INVOICE` | Names the invoice `11-cancel` works on, instead of the one recorded in test data. The screens take a number rather than a date range, so any posted bill will do |
| `CANCEL_FINALIZED` | `1` adds `IC_03`, which grants a cancellation against a test whose report is **already signed off and published**, then reads the published screen back. Off by default even on UAT: it is the destructive half of `IC_B_01` and costs the invoice a finalized test for good |
| `SAMPLE_DISPATCH_DAYS` | How far back the `SD_N_*`/`SD_B_*` cases look for an invoice to read, in days (default 7). They need one invoice in each dispatch state, and a quiet day leaves all three filters reading 0 — which skips those cases rather than failing them |

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

## The end-to-end round trip

[tests/E2E/diagnostic-round-trip.spec.ts](tests/E2E/diagnostic-round-trip.spec.ts) is a
different kind of test from everything above, and it is kept in a folder of its own to say so.

`tests/diagnostic` is the module's **test suite**: a spec per screen, each one taking that
screen apart — its happy path, its negative cases, its known defects — wired into the chain of
projects described above. `tests/E2E` asks the other question: **does one patient's work get
all the way from the counter to the counter?** So it is one file, one patient, one invoice, one
browser tab, and it asserts the *handover* at each seam rather than every control on every
screen.

Eight stages, in the order the hospital performs them:

| # | Stage | Screen | Who |
| --- | --- | --- | --- |
| 01 | Investigation entry | OPD Investigation Entry | administrator |
| 02 | Sample collection | Sample Collection | administrator |
| 03 | Sample dispatch | Sample Collection ▸ Dispatch | administrator |
| 04 | Sample acknowledgement | Sample Acknowledgement (LAB) | administrator |
| 05 | Lab result entry | LAB Result Entry | administrator |
| 06 | Lab result finalization | Lab Result Finalization | **pathologist** |
| 07 | Microbiology report | Microbiology Report (C/S) | administrator |
| 08 | Report delivery | Report Delivery | administrator |

```powershell
npm run test:e2e          # the whole journey
npx playwright test --project=e2e
```

### It does not touch the diagnostic suite's data

The chain rewrites [test-data/investigations.json](test-data/investigations.json) as it goes,
so an E2E run writing into that file would quietly re-aim every numbered project at its own
bill. The E2E reads and writes [test-data/e2e.json](test-data/e2e.json) alone, through
[tests/E2E/e2e-data.ts](tests/E2E/e2e-data.ts) — never `recordUhid` or `recordInvoiceNo`. The
two suites can therefore be run in any order without either standing on the other's numbers.

The `e2e` project is also declared **last** in the config. Stage 06 signs the administrator
out to let the pathologist sign the report off and signs them back in afterwards — the same
switch `setup-pathologist` makes — so it must not land in the middle of the numbered stages,
which all run as the administrator. Both session files are rewritten on the way through, so a
run leaves `playwright/.auth` as the other projects expect it.

### One patient, one invoice

The patient is `uhid` in [test-data/e2e.json](test-data/e2e.json) and already exists — this
suite registers nobody. Stage 01 raises a fresh bill against them and reads its number back off
the dashboard, because the app never shows the number it has just written. That number is then
held in the module and handed to the seven stages after it, and recorded in `e2e.json` as well
so a single stage can be re-run on its own.

The stages are **serial**: a stage that fails skips the ones after it, so a break reads as one
red stage at the seam it broke rather than as seven. What stages 03 and 04 move is what stage
02 actually found on the grid, read off the screen rather than named in the data file — the
X-ray on the bill takes no sample and is correctly absent from all three.

The bill has to carry a **culture test** or stage 07 has no report to fill:
`STOOL FOR CULTURE & SENSITIVITY` is what puts it on the Microbiology screen's Pending tab.

### When the server will not allocate lab numbers

Stage 01 presses POST up to three times, because the app sometimes asks it to. A bill is
numbered by allocating a lab number per test, and on a busy server that allocation outruns the
database command timeout:

> Lab numbers could not be allocated, so nothing was saved. Please save again. (Execution
> Timeout Expired. The timeout period elapsed prior to completion of the operation or the
> server is not responding.)

The app rolls the whole thing back, leaves the form exactly as it was, and ends the message with
an instruction. That is a slow server, not a broken screen — and failing the stage on it would
skip the seven stages behind it and send whoever reads the output hunting a defect that is not
there. So the stage heeds it: it waits ten seconds, checks the bill on the form is still the
bill it priced (`due` 0, `netPayable` unchanged), and posts again. Retrying is safe precisely
because of the *nothing was saved* — there is no half-written bill to double up on.

Any **other** refusal — a due the screen will not post, a discount it will not allow — is not
retried; pressing POST again would only earn it twice. Three failed allocations in a row stop
the stage with the server named as the cause.

### Reading the new invoice number back

The app never shows the number it has just written, so stage 01 reads it off the diagnostic
dashboard — and that read is a race it used to lose. Two things were wrong:

- **`show()` does not mean the grid is loaded.** The table is drawn with its headers before the
  query is even sent, so waiting for it returns in about ten milliseconds. The screen disables
  **Show** and **Filter** while it fetches and enables them again when the rows land, and that
  is the only honest readiness signal it gives — `dashboard.settle()` waits on it.
- **The generic `Search` box does not match mobile numbers.** The screen has grown
  **Search (Invoice No)** and **Search (Mobile No)** beside it, applied by their own **Filter**
  button. `dashboard.findByMobile()` uses those, and asks again until the bill turns up rather
  than reading once.

On 2026-11-09 the two together reported an invoice that had just been posted and acknowledged
with *successful save* as never having been written at all.

### What a signed-off report looks like, and when the counter can see it

Two things about the back half of the journey that cost a run each to learn.

**Finalize is disabled, not removed.** `LabResultFinalizationPage.isFinalized()` asks whether
Finalize has been dropped and Undo brought to life. That is not this build: a report that
finalized perfectly well — the invoice moved to Done, which is what the stage checks — came back
reading `Save (disabled), Finalize (disabled), Undo (disabled), Clear Form`. Undo never comes
alive at all, so it carries no signal. Stage 06 holds Finalize to being *out of reach* and
leans on the Done tab for the real answer. The page object is left alone: it belongs to
`tests/diagnostic` too, and quietly relaxing a shared assertion to get one suite green is how a
screen stops being watched.

**The Microbiology screen disables Show while a report is open.** The left panel cannot be
re-queried while the right half holds a report, so the post-finalize check reloads the screen
first. Asking in place sat on a dead button for thirty seconds and timed out on a report that
had just finalized.

**Report Delivery lags publication.** Signing a report off is not the same instant as the
counter being able to see it. On 2026-11-09 both reports on an invoice were finalized — the
microbiology screen answering *"Report finalized. It is now in the Acknowledged tab of Report
Delivery"* — and Report Delivery still showed nothing under any of its three stages half a
minute later. Ten minutes on, untouched, the invoice was sitting there under **Not
Acknowledged**. Stage 08 therefore gives the counter about three minutes to catch up
(`DELIVERY_LOOKUP_ROUNDS`) before calling the reports missing.

Note also that the reports do not all arrive at the same stage: the lab and culture reports land
under **Acknowledged** directly, while the radiology one waits under **Not Acknowledged**. Stage
08 acknowledges whatever is pending, then delivers everything the Acknowledged list holds, so it
does not matter how they are split.

### A tick that does not take

Every checkbox on the sample screens round-trips over the Blazor circuit, and the page objects
give each one 800 ms plus Playwright's five-second default to come back. That is not always
enough here: on 2026-11-09 the very first row of the acknowledgement grid came back unticked and
the journey died on a checkbox, four stages in and with nothing wrong anywhere.

Stages 03 and 04 therefore wrap their ticking in `expect(...).toPass()`. Both `selectOnly` and
`selectAll` only click a box whose state differs from the one asked for, so a second pass touches
only what did not take — which is what makes this a retry rather than a reason to widen a timeout
inside a page object `tests/diagnostic` shares.

### What a slow afternoon turns up

Everything above was found on a server answering briskly. On 2026-11-09 the same UAT box spent an
afternoon answering slowly — the `setup` project alone took 53 seconds at one point — and six more
races surfaced, every one of them the same shape: **reading a screen before it had finished
arriving.**

| What broke | What the screen was actually doing |
| --- | --- |
| A test search for `STOOL` was handed forty SERUM tests | The box answers *every keystroke*. The answer to the first letter was still on screen when the reading was taken. Stage 01 retypes the query — but only while nothing has reached the bill, because a retry past a successful pick bills the patient twice |
| A report read as holding one test when it held three | The report is built department by department, and `openInvoice` returns four seconds after the *first* heading. `settleReport()` counts headings until the count stops moving. Worse than the failed check was the near miss: filling a half-built report covers what has landed and leaves the rest blank |
| The pathologist sign-in "failed" | The POST outran the minute `expectLoggedIn` allows. The switch now asks the app who is signed in before retrying, so a sign-in that lands late is accepted rather than repeated |
| `not on the Pending tab — it was listed under Pending` | The finalization grid did not answer inside the wait. The second half of that sentence was the extra look the message itself triggered. Both this lookup and the microbiology one now ask more than once |
| Every click swallowed, on a page that looked fine | The Blazor **reconnect overlay**. Note that `utils/blazor.ts` watches `#reconnect-modal`, the app's own; this one was `#components-reconnect-modal`, Blazor's. `waitForLiveCircuit()` in the spec waits for both |
| `the save was not acknowledged` | The snackbar landed outside fifteen seconds. It is the app clearing its throat, not the record — the Done tab is what proves a save, so the message is logged and waited 90 s for, never asserted on |

The Microbiology screen also disables **Show** while a query is in flight, not only while a report
is open — the same trick the investigation dashboard plays with Show and Filter. Reloading the
screen deals with the open report and does nothing about the queries the reload itself sets off,
so each search waits for the button to come back to life first.

And two things about Report Delivery that are not timing at all:

- **The reports do not all arrive at the same stage.** Lab and culture reports are put straight
  into **Acknowledged** when they are signed off; only the radiology one waits under **Not
  Acknowledged**. A bill with no radiology test has nothing to acknowledge, and stage 08 treats an
  empty pending list as a state rather than a failure.
- **An invoice stays listed under a stage it has no reports left in** — the stale stage counts the
  diagnostic suite records as `RD_B_03`. So the row clicks fine and the grid behind it comes up
  empty, patient bar blank. Stage 08 asks whether there are *report rows*, not whether the invoice
  is listed.

The lesson worth carrying: on this app, almost every "missing" row, empty report or dead button is
a screen that had not finished answering. Before widening a timeout, look for something the screen
itself says when it is ready — a button coming back to life, a count coming to rest, a row
appearing — and wait for that instead.

### Print Label does not always collect

"Print Label" is what records a sample as collected, and the press does not always take: it goes
through, the server answers, the grid redraws, and every status still reads **Not Collected**.
The collection spec has carried a note about this since it was written; on 2026-11-10 it took a
whole invoice — all four samples, none collected.

The screen says nothing either way. There is no snackbar when the collection works and none when
it does not, so a failed press and a successful one are indistinguishable until the invoice is
re-opened and the status column read.

Stage 02 therefore presses, reads the statuses back, and presses again for whatever is still
pending, up to `COLLECT_PASSES`. Re-printing a label for a sample already collected is a reprint
and changes no status — which is why the suite can re-run `6-labels` freely — so the extra passes
cost nothing. Reported as `E2E_B_07` in
[bug-report/e2e-round-trip-findings.md](bug-report/e2e-round-trip-findings.md).

### Changing a filter is a query, so ask again rather than wait longer

Each sample screen ends its stage the same way: re-open, narrow to the invoice, switch to the
filter the work should have moved it to, look for the row. Every one of those steps makes the
server rebuild the grid, and `filterBy` and `searchInvoice` each allow a flat few seconds.

Waiting longer on the row does not help. The grid is only rebuilt when something asks it to, so a
reading taken after a query that came back empty stays empty however long it is watched — which
is how a 60-second `toBeVisible` failed on an invoice whose samples had just been acknowledged.
`expectListedUnder()` asks again instead: it repeats the whole narrow-and-look, which commits
nothing and is therefore free to repeat.

### Knobs

| Variable | What it does |
| --- | --- |
| `E2E_UHID` | Bills a different patient for one run |
| `E2E_INVOICE` | Aims the later stages at a particular bill, instead of the one stage 01 raised |
| `E2E_CS_SEED` | Repeats a previous run's random antibiogram values — the seed is printed by stage 07 |

### This writes real data

Every stage commits, and there are no dry-run flags: a journey that stops at the first save is
not a journey. A bill is posted, samples are collected and dispatched, clinical results are
filed and signed off, reports are handed over — none of it undoable from the UI, and most of it
one-way. That is why the suite raises its own invoice at stage 01 rather than reusing one, so a
re-run of the whole file always works on a bill of its own.

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
| `npm run test:e2e` | The end-to-end round trip only (`tests/E2E`) |
| `npm run bug-report:e2e` | Prints the end-to-end defect report (`bug-report/e2e-round-trip-findings.md`) to PDF |
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
tests/E2E/           The one unbroken journey of a single patient, on its own data
                     (test-data/e2e.json)
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

  Waiting for the age is not the whole answer, though, because the age is not always what
  the blanking render carries. On 2026-11-07 a second one landed long after it: Title, Full
  Name, Given Name, Surname, Gender **and** Marital Status all came back empty with Full
  Name and Gender flagged Required, while everything from Religion down — blood group,
  parents, mobile, ID, occupation, the whole address — sat untouched. Which render lands
  when is not worth predicting, so `fillPatient` now reads the row back at the end of the
  fill and writes it again if it has gone (`repairIdentityRow`). Checked at the end rather
  than straight after typing, because the render can arrive at any point while the rest of
  the form is going in.
- **Snackbars.** The app reports the outcome of a save only through a `.snackbar` that appears
  and disappears within about a second, leaving nothing behind. Polling for it from the test
  never catches it, so [utils/snackbars.ts](utils/snackbars.ts) installs a MutationObserver in
  the page and the test reads back everything it saw. Every screen that posts uses it. The
  recorder goes in as an init script as well as on the document in hand, because the app
  answers a dropped circuit with a reload and a recorder that went down with the old document
  does not report that it is gone — it reports that the screen said nothing, which reads as a
  defect in the app. Reads sweep the page once more before answering, and put the recorder
  back if they find it missing.
- **Grid group headers.** Collection and dispatch grids interleave department header rows with
  the real ones. Row lookups go through a `testRows` getter that keeps only rows carrying a
  checkbox.

### Test data

[test-data/investigations.json](test-data/investigations.json) carries inline `_note` keys
explaining each block. The important convention: autocompletes are driven by a `query` (what
gets typed) plus a `match` regular expression applied to the suggestion text, because a query
alone is ambiguous — `LIPID` returns six hits and `X-RAY` returns 160.

---

## The counter tabs

OPD Investigation Entry is six forms rather than one. Along the top it draws **Billing One**
through **Billing Five** and a **Corporate Patient** tab, and the five billing ones are not
views of a single bill: each keeps its own draft, which is what lets a counter park a
half-typed bill on one tab and take the next patient on another. The screen opens on Billing
One, which is why every test written before these drove the form without choosing a tab at
all.

`InvestigationPage.selectTab()` switches between them and
[CorporatePatientPage](pages/CorporatePatientPage.ts) wraps the sixth.

### Why the corporate page re-points nearly every locator

The six panes live in one document, and a pane that has been opened once **stays in the
markup** when another tab is selected — hidden, holding its own bill. Billing One's form sits
under `.inv2` and the corporate one under `.cor2`. So an unscoped locator finds two
"12-digit UHID" boxes, two `#ageyear` boxes (the same id twice over, which is invalid markup
the app gets away with because only one is ever on screen) and two `Payment (cash)` labels —
and picks the hidden one, because it comes first. `CorporatePatientPage` therefore hangs every
locator off `.cor2`, and the locators it overrides are declared without `readonly` in
`InvestigationPage` for that reason alone.

### What the corporate tab does differently

| | Billing One … Five | Corporate Patient |
| --- | --- | --- |
| Corporate client | — | **required**, "Client search…" |
| Media | yes | — |
| D. Category | yes | — |
| Totals | Sub total → Net payable | Total(Tk) → G.Total(Tk) |
| Payment | cash, card, mobile | cash, card, mobile, **cheque, bank deposit, pay order** |
| Card types | Credit Card | VISA, MasterCard, Nexus Card, Credit Card |

Its summary strip is its own markup (`.cor2-summary-row`, against Billing One's
`.inv2-summary-row`) with its own words — there is no "Sub total" and no "Net payable" on it.
Reading the figures off the page text from this tab would return Billing One's hidden strip,
so `corporateTotals()` reads the rows structurally instead.

### The patient bar, and the doctor it eats

A UHID lookup on this tab **collapses the demographics editor** into a one-line bar —
`UHID … NAME … AGE … GENDER … CORPORATE … REF …` with "Edit / Search" and "Clear" on the end.
After it there is no Patient name box, no Mobile No box, no client box and no doctor box until
`expandEditor()` presses "Edit / Search". The mobile number is only in the editor; the bar
never prints it.

The two fields filled in before a lookup do not fare the same. The **corporate client**
survives it, and the bar shows it with the contract expiry ("PRIME Bank Ltd. exp: 31/05/28").
The **referring doctor** does not: the bar comes back reading `REF —` and the box is empty when
the editor is reopened, with nothing said about it. So a counter who fills the form top to
bottom and searches the patient last posts a bill with no referring doctor on it.

`TC-C03` is the case that pins that down, and it is why `TC-C01` chooses the company **before**
the lookup and the doctor **after** it.

### A test cannot be billed before the company is

The grid refuses a line until a corporate client is named — a test picked off the suggestion
list before then does not reach the bill, and the screen answers "Please select Cor client."
That is the real guard: **POST stays enabled** with no company on the bill, so what stops it
being submitted is the empty grid rather than the button. `TC-C02` covers both halves.

### Where a corporate invoice ends up

Not on the Diagnostic dashboard. A corporate bill posted and confirmed with "Successful Save!"
is absent from [/diagnostic/investigation-dashboard](pages/InvestigationDashboardPage.ts) under
every filter that screen offers; it is listed under Corporate Management instead, at
`/marketing/corporate-invoice-dashboard`, wrapped by
[CorporateInvoiceDashboardPage](pages/CorporateInvoiceDashboardPage.ts). That grid is also the
only place the company on a posted bill can be checked, being the only one with a CORPORATE
CLIENT column — so `TC-C01` reads its invoice number back there rather than where the Billing
One test reads its own.

A part-paid corporate bill lands as **DUE**: the cash taken at the counter settles its share and
the company is invoiced for the balance, which is the normal shape of one rather than a
half-finished bill.

---

## Due collection

Everything above raises bills. [Due Collection](pages/DueCollectionPage.ts) is where the rest
of the money on one is taken, and `12-due-collection` drives it. Four things about that screen
shape the spec.

### A bill is fetched with Enter, one at a time

There is no search button beside **Bill No** and no grid of outstanding bills: the box is typed
into and **Enter** fetches it. The round arrow at the top of the screen is a Back link — clicking
it leaves Due Collection altogether, which is not what it looks like. The box is a number input,
so the bill goes in as digits: the dashboard prints `MDH2611020200005`, the screen is handed
`2611020200005`.

A number that matches nothing is not reported. The boxes stay empty and no message is shown, so
`load` comes back `false` rather than waiting for an error that never arrives.

### Net Payable is what is **left** to pay

On the entry screen Net Payable is what the bill came to. Here it is what is still owing: a bill
of 940 Tk with 45 Tk discounted and 447 Tk already taken shows Sub Total 940, Previous Paid 447,
Net Payable 448 and Due Amount 448. The two right-hand figures track each other, and the
arithmetic that closes is

```
Previous Paid + Due Amount + discounts = Sub Total
```

### Three ways to take the money, two of which grow the form

**Payment (Cash)** is always there. Choosing a card in **Select Card** (VISA, MasterCard, Nexus
Card, Credit Card) adds a **POS** dropdown and a card payment box; choosing a wallet in **Select
Mobile** (BKash, Nagod) adds a **Payment(Mobile)** box. Neither box exists until its dropdown is
set, which is how the screen stops a card or wallet payment going in without saying which card or
which wallet — the same shape the OPD entry screen uses.

Each collection lands in **Transaction History** as a credit naming the method it came in on —
`DueCollection(Cash)`, `DueCollection(Card-EBL POS)`, `DueCollection(Mobile-BKash)` — so that grid
is where a payment-method test reads its result back. The bill itself is the first line of it, as
a `Service Cost` debit. The save is reported as "Due collected.", not the "Successful Save!" the
entry screen answers with.

### A settled bill looks collectable, and is not

Once a bill is paid to the taka the panel still looks usable: Payment (Cash) stays enabled and
**Save** stays offered, on a bill showing Due Amount 0. Before any bill is fetched the screen
disables both, so the inconsistency is real — but it is only cosmetic, and the spec establishes
that by **pressing Save** rather than assuming either way:

| | what the screen does |
| --- | --- |
| Save, nothing typed | "Nothing to collect -- enter a payment or a discount first." |
| An amount typed in | refused at the box — "Please input correct value", Payment stays 0 |
| Save after that | refused again, same message |

Neither press writes a line to the ledger, so a counter who fetches an already-paid bill and
presses Save cannot take money for it.

### Clearing a corporate bill

The company's balance is collected on this same screen, with no corporate handling of its own —
the counter fetches it by bill number like any other. `12-due-collection` reads one, checks the
arithmetic closes against what the company was invoiced for, then takes the balance in cash and
checks the bill reads **PAID** on the corporate dashboard afterwards.

That test spends the bill it works on, the way `10-report-delivery` spends its invoice: a
corporate bill cleared here is paid for good. A fresh one comes from the corporate half of
`2-invoice` on each run of the chain, and the test skips with a note if none is outstanding.

### One counter at a time, and the lock outlives the tab

The screen takes a lock on the bill it opens. A second PC loading the same bill gets a banner —
"Due collection for this bill is open on another PC — *user* (*address*) since *time*" — and the
whole money panel disabled, Save included. That is worth having, and the spec checks it: two
counters collecting the same bill at once would take the money twice.

The part to watch is that the lock is held by the Blazor **circuit**, and survives it by five to
six minutes. Navigating back to `/diagnostic/due-collection` starts a new circuit, so a spec that
re-opened the screen between instalments is locked out *by its own previous visit*, with the
panel dead and nothing but the banner to say why. `12-due-collection` therefore opens the screen
once and re-fetches the bill with `load`, which stays on the circuit that already holds the lock,
and leaves the screen deliberately when it is done.

### POST asks before it writes a due bill

Posting a bill that still owes something does not save it. It raises a **Due bill** modal — "This
bill has a due of Tk 290. Do you want to post it as a due bill?" — and waits. Nothing is written
until **Confirm**, and nothing is said if it is not pressed: the form is simply left as it was,
which reads exactly like a post that silently failed. `InvestigationPage.confirmDueBill` answers
it, and returns `''` on a bill paid in full, which never raises it.

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

Beside them sits a `Sample collection — defects` block, `SC_B_01` to `SC_B_04`, found on
2026-11-04 and written the same way: what the screen ought to do, marked `test.fail`. None of
them collects a sample — the only things pressed are Show, the collection-point dropdown and
the column headers.

| Case | The defect |
| --- | --- |
| `SC_B_01` | Three of the invoice grid's four sortable columns sort nothing. Invoice No, Name, Date and Time all carry a pointer cursor and a sort icon; only Invoice No sorts, and the other three leave the order exactly as it was, before and after two clicks. The operator cannot have the list in the order they work in, which is time of arrival |
| `SC_B_02` | On the test grid, Test Name reorders the rows into no order at all. Lab No beside it sorts and reverses properly; Test Name does move the rows, so it is not dead, but neither press leaves them in name order — one click on a six-test invoice gave IMMUNOGLOBULIN -IGE, URINE ANALYSIS R/M/E, HBSAG-ELISA METHOD, VDRL-QUALITATIVE TEST, CBC With ESR*, ICT FOR TB, and the second only swapped the two in the middle. Looking a test up by name is no easier after the press than before it |
| `SC_B_03` | **"Sample collection at" filters nothing.** HUB, Home Collection, B2B and Outside Collection each return the same invoices in the same order with the same counts beside them, and the empty "Select one" can be chosen as well. Whether the choice is recorded against the collection is a database question the screen cannot answer; what it does not do is narrow the list |
| `SC_B_04` | **A query still running looks exactly like a settled answer.** Over a 30-day range Collected Patient took 20.1s to fill, All Patient 10.1s and Partial Collected 5.0s. Throughout there is no spinner, no disabled control and no "loading" anywhere, and the grid holds one of two things: nothing at all, or the rows the previous query left behind. Both were seen on 2026-11-05 — an empty grid at second three with 2 beside the filter, and on another press the previous 27 rows still listed with the same 2 beside it. At second five the operator is looking either at a confidently empty day or at somebody else's invoices |

Three `SC_N_*` cases were added alongside them for what the screen gets right, because the
defects above lean on it: the three states sum to "All Patient" (`SC_N_25`), the header
checkbox clears and re-ticks every test row it still owns (`SC_N_26` — a row already collected keeps a
ticked, disabled box no header press can move, and is set aside), and the rest of a long list is
reachable by scrolling (`SC_N_27`).

That last one corrects a misreading this suite carried for a while. The invoice grid sits in a
216-pixel scroller and keeps only the two dozen rows around the scroll position in the DOM —
`sh=32533` against `h=216` for a 657-invoice day — so `invoiceRows.count()` is a count of what
has been **rendered**, never of what the filter matched. Nothing is truncated and nothing is
missing; the rows arrive as they are scrolled to. Anything comparing one list against another
has to compare `filterCount`, the number the app writes into the filter's own label. `SC_N_19`
compared two rendered counts and so could not have failed whatever the screen did; it now
compares the counts.

[investigation-cancel.spec.ts](tests/diagnostic/investigation-cancel.spec.ts) carries the same
shape for the two cancellation screens: `IC_N_*` for what they get right and `IC_B_*` for seven
defects found on 2026-11-02, each written as the behaviour the screen ought to have and marked
`test.fail`.

| Case | The defect |
| --- | --- |
| `IC_B_01` | A test whose result is finalized and whose report has been published and handed over is still offered for cancellation — all nine rows of 2610260200001 were tickable, and the request for one of them was accepted with "Request Sent successfully." |
| `IC_B_07` | One account can raise a request and grant it. Admin02 did both in a single session with nothing in the way, on a screen that keeps an Entry User and an Approve User field precisely because two people are meant to be involved |
| `IC_B_02` | The approval queue's **Entry User** is whoever raised the *invoice*, not whoever asked for the cancellation — a request raised as Admin02 was queued as "Ripon02", the clerk who billed it days earlier |
| `IC_B_03` | **Approve User** names somebody on a request still waiting in the queue, so the field reads as a decision nobody has taken |
| `IC_B_04` | **Reverse Cancel** withdraws the request correctly and then reports "Successful Approved.", on a screen whose other red button really does approve. No confirmation step either |
| `IC_B_05` | Clearing the invoice number leaves the last patient's name, age, entry date and every one of their tests on screen, still tickable, with the box reading 0 |
| `IC_B_06` | The two routes are swapped, as above |

What they get right is worth knowing too, and the `IC_N_*` cases pin it down: both screens
validate before they post ("Please select at least one test.", "Remarks is required…",
"Please select detail"), the reason box stops at 500 characters, an unknown invoice is refused
by name rather than emptying the grid in silence, an item already awaiting approval is not
offered for a second request, and the three amounts on the approval screen are computed from
the ticked rows and disabled rather than typed by the approver.

Granting is driven rather than described. `IC_02` cancels the cheapest unreported item on the
bill and checks the arithmetic the screen was about to commit — the ticked item's total, the
discount it carried, and a refund that is one less the other — then that the item leaves both
the queue and the bill and takes nothing else with it. Checked on 2026-11-02 against
2610260200001: "Gray Tube*, 20 Tk" went for 20.00 total, 0.00 discount, 20.00 refund,
answered "Successful Cancel", and the bill came back one row shorter.

`IC_03`, behind `CANCEL_FINALIZED=1`, is the question `IC_B_01` leaves open: granting the
cancellation of a test whose report has already been signed off, published and handed over,
then reading the published screen back to see whether the report went with it.

Three cases stay `test.skip`: a cancellation taken mid-round-trip (collected and dispatched,
not yet reported on — a state the chain would have to be stopped in), where the refund shows
up for a bill already settled in cash, and two approvers racing on one request.

[sample-dispatch.spec.ts](tests/diagnostic/sample-dispatch.spec.ts#L176) carries the same shape
again for the dispatch tab — `SD_N_*` for what the screen gets right, `SD_B_*` for eight defects
found on 2026-11-04 — and none of it dispatches anything. "Send to carrier" is pressed twice,
once with no invoice open at all and once against an invoice whose samples are already with a
carrier, so there is never anything for a press to commit; ticking a row commits nothing on its
own either. The cases can therefore be re-run as often as you like, against any data.

| Case | The defect |
| --- | --- |
| `SD_B_09` | **Send to carrier**, pressed with the invoice open, a carrier chosen and the ticks forgotten, answers **"save finished."** Nothing was sent — the samples stay where they were — and the operator has been told the dispatch worked. This is the likeliest of the eight to be met in ordinary use |
| `SD_B_05` | The same answer, **"save finished."**, for a press with no invoice open and no carrier set. The button does refuse properly once an invoice is open and no carrier is chosen ("Please select sample carrier.") — so the check exists and is simply not reached when there is nothing on the grid to check against |
| `SD_B_08` | An invoice whose samples are **all** with a carrier opens with every row ticked and every checkbox live. On the collection tab a second press is only a reprint; here the one button on the screen hands samples to a carrier, so an invoice opened to check where a sample went is a single press from being dispatched again. Whether that press overwrites the carrier and the time it was handed over costs a live sample's audit trail to answer, and belongs on a test database |
| `SD_B_06` | The grid refuses a tick until a carrier is set, and then lets the carrier be taken away with the tick left standing — a dispatch one press away with the carrier box empty |
| `SD_B_01` | A reversed date range is queried rather than refused, and the empty grid that comes back reads as "no invoices today" |
| `SD_B_02` | The date picker rolls `31-02-2026` forward to `03/03/2026`, so the screen reports on a day nobody asked for — the collection tab's `SC_N_02`, one tab over |
| `SD_B_03` | Both date boxes can be cleared and **Show** still fires |
| `SD_B_04` | The invoice search box takes all 600 characters pasted into it; there is no cap |

`SD_B_07` used to sit in that table, claiming the **Dispatched** badge counted for all time while
the grid obeyed the date range — 623 against a grid of 27 over 28-10 .. 04-11, with the two short
filters agreeing with their grids exactly. It was the same misreading `SC_N_19` carried, for the
same reason: dispatch is a tab on the sample-collection route, and its invoice grid is that
screen's 216-pixel scroller, which keeps only the rows around the scroll position in the DOM.
Measured on 2026-11-07 over 30 days: Dispatched badge 3609, 29 rows rendered, `sh=36863` against
`h=216`, and scrolling walked the bottom of the window through four different invoices. The badge
was right. It is now `SD_N_20`, which checks what can be checked — the grid never shows more rows
than the filter counted, a list short enough to render whole agrees with its badge exactly, and a
longer one goes on producing rows as it is scrolled.

What it gets right is worth knowing too, and the `SD_N_*` cases pin it down: a future range and a
six-year one are both answered without a server error (01-01-2020 to date came back in about two
seconds), **Show** says when it is working — it disables itself and spins while a query is in
flight, which is exactly what `SC_B_04` found missing on the collection tab one tab over, and what
`show()` now waits on rather than pressing a button that cannot be pressed, `' OR 1=1--` and
`<script>alert(1)</script>` are handled safely in the search box, a
carrier nobody is named under offers no suggestion and the text typed for it is cleared out rather
than left to be mistaken for a choice, every dispatched row names its carrier and the minute it
went, no invoice is listed under two dispatch states at once, opening a second invoice replaces
the first one's tests rather than adding to them, only samples the counter has collected are
offered, and no cell renders as "null".

Five cases stay `test.skip`, each needing something this environment cannot give: a dispatch cut
off mid-post, two operators dispatching one lab number, a restricted account, an eight-hour
session lapse, and a double press of Send to carrier against rows that are genuinely tickable.

The cases that read a grid look back a week rather than at today (`SAMPLE_DISPATCH_DAYS` widens
it). Today alone is routinely empty on this server — on 2026-11-04 all three filters read 0 —
and an empty screen skips those cases rather than failing them, which is how a suite comes to
pass without having looked at anything.

[microbiology-report.spec.ts](tests/diagnostic/microbiology-report.spec.ts#L380) carries the shape
once more for the culture and sensitivity report — `CS_N_*` for what the screen gets right, `CS_B_*`
for six defects found on 2026-11-05 — in two suites beneath the one pass that fills a report and
signs it off.

**Nothing in either suite saves.** The only Save pressed is on the empty shell, where the button is
disabled anyway; no loaded report is saved, printed or finalized. Everything they touch — a test
picked, a growth recorded, an organism named, a medium ticked, a note typed — lives on the circuit
until somebody saves it, and nobody does. So they can be re-run as often as you like, against
whatever bill the Pending tab is offering. Where it is offering nothing, each case says so and
skips: a bill reaches this screen once the lab has acknowledged a culture sample and leaves it for
good once its report is finalized, so an empty Pending tab is the ordinary state of the screen the
day after a chain run, not a fault.

| Case | The defect |
| --- | --- |
| `CS_B_04` | **The Pathologist panel's Search box filters nothing.** `ZZQXNOTAPATHOLOGIST` comes back with all ten pathologists, and so does `PROF.`. The panel is a grid worked by clicking a row, and `selectFromDropdown(label, match)` types `match` into this box and then takes the top row — so a caller that asks for a particular pathologist gets whoever happens to be listed first, with nothing on screen to say so. The same box sits over Technologist and Test Name |
| `CS_B_05` | **The C/S Message autocomplete ignores what is typed into it.** The same ten lines come back for `Salmonella`, for `ZZQXNOTAMESSAGE` and for an empty box — the first ten of the list, whatever was asked for. The line this box fills in is the report's conclusion, so a lab looking for "no growth" has to read the whole list to find it, and `pickCsMessage(query, match)` only works because it matches the suggestion text itself rather than trusting the filtering |
| `CS_B_06` | The note box takes all 2000 characters pasted into it and declares no `maxlength`; there is no cap, as on the dispatch tab's search box (`SD_B_04`) |
| `CS_B_01` | A reversed date range is queried rather than refused, and the empty grid that comes back reads as "no bills" |
| `CS_B_02` | The date picker rolls `31-02-2026` forward to `03-03-2026`, so the screen reports on a day nobody asked for — `SC_N_02` and `SD_B_02` again |
| `CS_B_03` | Both pickers can be cleared and **Show** still fires |

What it gets right is worth knowing too, and this screen gets a good deal right. The `CS_N_*` cases
pin down two rules the whole form rests on. **No growth builds no antibiogram**: with CULTURE RESULT
on NG the sensitivity panel is not on the page at all, and switching to G builds it — forty
antibiotics on the stool culture. And **a column opens only once its organism has been isolated**:
all three columns of those forty rows arrive disabled, naming an organism in Organism Isolated A
opens all forty of column A, and B and C stay shut for the second and third organism nobody has
isolated. A cell then offers S, R and I and nothing else, and a letter typed into one and never
chosen is not left behind looking like a result.

The rest of the list: the screen is reachable from the Diagnostic menu and opens on Pending; a bill
is listed under Pending or Done and never both; a future range and a six-year one are both answered
without a server error (01-01-2020 to date came back in about two seconds, empty); `!@#$%^&*()`,
`' OR 1=1--`, `../../etc/passwd` and `<script>alert(1)</script>` are all handled safely in the
search box, and a box holding nothing but spaces behaves like an empty one; Save and Print are
disabled until a report is loaded and Finalize until one is saved; a report already signed off opens
under Done with no Finalize to press again; the organism and colony lists offer real values and keep
what they are given; a medium ticked by mistake can be cleared again; the note box holds what is
typed and empties again; and opening a second bill replaces the first one's report rather than
leaving half of it on screen.

Both suites are in the `9-cs-report` project with the pass that signs a report off, so
`--grep "CS_N_|CS_B_"` runs the read-only half on its own:

```bash
npx playwright test --project=9-cs-report --no-deps --grep "CS_N_|CS_B_"
```

---

## What the SMS says, and why nothing checks it

Publishing a report is meant to text the patient, and the message is meant to name whatever is
still pending on the same invoice — so somebody told one report is ready is not left thinking
the rest were forgotten. Lab Report Published Group Wise is where that grouping is visible: one
row per test group, each listing its own tests, so the message for a group should carry the test
names from the groups that have not been published yet.

**Nothing in this app shows what was sent.** There is no SMS log, outbox, message history or
notification screen anywhere in it — every module the administrator can open was walked looking
for one on 2026-11-02 (Diagnostic, Administrative, MIS, Registration) and none of them carries
one. A UI test therefore has nothing to read the message back from, and checking this needs
either the gateway's own logs or a look at the table the app queues messages in. This suite has
neither.

So the case is left in the suite as a `test.skip` carrying that reason, in
[lab-report-published.spec.ts](tests/diagnostic/lab-report-published.spec.ts), rather than left
out of it: the requirement is real and untested, and a skip with a reason says so where a
missing test would not. When the app grows a screen that shows what was sent, it becomes an
ordinary test — publish one group of a multi-group invoice, read the message back, and expect it
to name the tests of the groups still unpublished.

---

## CI

[.github/workflows/playwright.yml](.github/workflows/playwright.yml) runs the suite on push
and PR to `main`/`master` and uploads the HTML report for 30 days. On CI, `forbidOnly` is on
and failures retry twice. Note that CI still points at the same live server unless `BASE_URL`
is set in the workflow.
