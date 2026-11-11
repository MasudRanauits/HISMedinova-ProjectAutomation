import fs from 'fs';
import path from 'path';
import data from '../../test-data/e2e.json';

/**
 * The end-to-end suite's own data, and the one number it writes back.
 *
 * `tests/diagnostic` keeps its numbers in test-data/investigations.json and has
 * `recordUhid`/`recordInvoiceNo` in fixtures/test.ts to write them; this suite
 * deliberately shares neither. The diagnostic chain hands one invoice down a
 * dozen Playwright projects and rewrites that file as it goes, so an E2E run
 * writing into it would quietly re-aim every one of those stages at its own
 * bill. test-data/e2e.json is read and written here and nowhere else, which is
 * what lets the two suites be run in any order, or at the same time, without
 * either standing on the other's data.
 */
export const e2e = data;

const FILE = path.join(__dirname, '..', '..', 'test-data', 'e2e.json');

/**
 * A UHID to bill instead of registering someone.
 *
 * Empty by default: the journey starts by typing a patient into the billing
 * screen, which is what a counter does for someone who has never been here
 * before. Setting `E2E_UHID` to a live UHID looks that patient up instead and
 * leaves the demographics alone.
 */
export const UHID = process.env.E2E_UHID || '';

/** The demographics typed into the billing screen, with this run's name. */
export type E2EPatient = {
  title: string;
  fullName: string;
  gender: string;
  ageYears: string;
  mobile: string;
};

/**
 * The patient to register, with the next name in the series.
 *
 * "Masud Rana-1", "Masud Rana-2", and so on. The mobile number does not
 * change — it is the one the hospital asked the suite to use — so the number on
 * the end of the name is the only thing telling one run's bill from another's
 * on the dashboard. Digits and a hyphen are both allowed in a patient name by
 * the app's own rule (letters, digits and . - / ( )), so the suffix goes in as
 * typed.
 *
 * The sequence is bumped and written back on every call, exactly as the
 * registration spec does with test-data/patients.json — on this suite's own
 * file, so the two never collide.
 */
export function nextPatient(): E2EPatient {
  const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const sequence = (stored.nameSequence ?? 0) + 1;

  stored.nameSequence = sequence;
  fs.writeFileSync(FILE, `${JSON.stringify(stored, null, 2)}\n`);

  return {
    title: data.patient.title,
    fullName: `${data.patient.fullName}-${sequence}`,
    gender: data.patient.gender,
    ageYears: String(data.patient.ageYears),
    mobile: data.patient.mobile,
  };
}

/**
 * The invoice the later stages work on.
 *
 * In a full run this is set in memory by stage 01 the moment the bill is read
 * back off the dashboard — the stages share a module, so nothing has to go
 * through a file at all. The file is for the other way of running them: stage
 * 01 records the number as well, so `--grep "03"` on its own picks up where the
 * last full run left off. `E2E_INVOICE` overrides both.
 */
let current = process.env.E2E_INVOICE || data.invoiceNo || '';

export function invoiceNo(): string {
  return current;
}

/**
 * Hands the number the counter just raised to the seven stages after it, in
 * memory and on disk.
 */
export function recordInvoiceNo(value: string) {
  current = value;

  const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  stored.invoiceNo = value;
  fs.writeFileSync(FILE, `${JSON.stringify(stored, null, 2)}\n`);

  console.log(`recorded invoice ${value} in test-data/e2e.json for the stages that follow`);
}

/** `daysBack` ago .. today, the window every screen in the journey is asked for. */
export function window(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - data.daysBack * 24 * 60 * 60 * 1000);
  return { from, to };
}

/** Turns a `{ query, match }` pair out of the data file into a usable matcher. */
export function matcher(pair: { query: string; match: string }) {
  return { query: pair.query, match: new RegExp(pair.match, 'i') };
}
