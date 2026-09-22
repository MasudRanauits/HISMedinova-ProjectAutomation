/**
 * Builds the defect report as a PDF, with its own screenshots and recordings.
 *
 *   npm run bug-report
 *
 * It signs in, walks each finding in findings.js, photographs what the screen
 * actually does, then lays the lot out and prints it. The evidence is gathered
 * on the spot rather than pasted in, so it always matches the build it was run
 * against.
 *
 * Some defects are a sequence rather than a state — a date that rewrites itself
 * as it is typed, a grid that empties the moment Show is pressed — and a still
 * of the aftermath does not show them. A finding marked `video: true` is
 * captured in its own recorded window; the file lands beside the report as
 * .webm. A PDF cannot play it, so the printed page names the recording and the
 * HTML version plays it inline.
 *
 * The PDF comes out of headless Chromium, which is the only mode that can print
 * one — so this runs its own browser rather than going through the test config.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const report = require('./findings');
const users = require('../test-data/users.json');

const BASE = process.env.BASE_URL ?? 'https://202.4.101.118:1115';
const OUT_DIR = __dirname;
const SHOTS_DIR = path.join(OUT_DIR, 'screenshots');
const VIDEO_DIR = path.join(OUT_DIR, 'recordings');
const PDF = path.join(OUT_DIR, 'sample-collection-defects.pdf');
const VIEWPORT = { width: 1600, height: 900 };

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function signIn(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  if (/Account\/Login/i.test(page.url())) {
    await page.locator('input[name="Input.Email"]').fill(users.admin.username);
    await page.locator('input[name="Input.Password"]').fill(users.admin.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {}),
      page.locator('button.omrs-submit[type="submit"]').click(),
    ]);
  }

  await page.waitForTimeout(5000);
  const cookies = (await page.context().cookies()).map((c) => c.name);
  if (!cookies.includes('.AspNetCore.Identity.Application')) {
    throw new Error(`could not sign in — the app is at ${page.url()}`);
  }
}

const MARKER_LAYER = '__bug_report_markers';

/**
 * Rings the given boxes in red, in the page itself.
 *
 * Drawing into the page rather than onto the PNG afterwards keeps this
 * dependency-free — no image library — and the ring lands exactly where the
 * element is, since bounding boxes and a fixed-position layer share the same
 * viewport coordinates as the screenshot's clip.
 */
async function drawMarkers(page, boxes) {
  await page.evaluate(
    ({ boxes, id }) => {
      document.getElementById(id)?.remove();
      const layer = document.createElement('div');
      layer.id = id;
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';

      for (const b of boxes) {
        const ring = document.createElement('div');
        ring.style.cssText = [
          'position:absolute',
          `left:${b.x - 5}px`,
          `top:${b.y - 5}px`,
          `width:${b.width + 10}px`,
          `height:${b.height + 10}px`,
          'border:3px solid #e0143c',
          'border-radius:6px',
          'box-shadow:0 0 0 3px rgba(224,20,60,.20)',
        ].join(';');
        layer.appendChild(ring);
      }

      document.body.appendChild(layer);
    },
    { boxes, id: MARKER_LAYER },
  );
}

async function clearMarkers(page) {
  await page.evaluate((id) => document.getElementById(id)?.remove(), MARKER_LAYER);
}

/**
 * Runs every finding's capture and returns it with its evidence attached.
 *
 * A finding that wants a recording gets a window of its own: Playwright ties a
 * video to the life of a page, so one page per finding is what keeps the
 * recordings separate. The rest share a single page, which is quicker.
 */
async function collectEvidence(browser, storageState) {
  fs.rmSync(SHOTS_DIR, { recursive: true, force: true });
  fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  const captured = [];
  const shared = await browser.newContext({ ignoreHTTPSErrors: true, viewport: VIEWPORT, storageState });
  const sharedPage = await shared.newPage();

  for (const finding of report.findings) {
    console.log(`capturing ${finding.id} — ${finding.title}${finding.video ? ' (recording)' : ''}`);

    const recorded = finding.video
      ? await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: VIEWPORT,
          storageState,
          recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
        })
      : null;
    const page = recorded ? await recorded.newPage() : sharedPage;

    await page.goto(BASE + finding.screen.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(12_000);

    const figures = [];
    let index = 0;

    /**
     * Photographs the screen, ringed where the defect is.
     *
     * Two things make a screenshot in a report worth looking at. It has to be
     * readable — a whole 1600px window shrunk into an A4 column puts the text
     * at about four pixels — so `clip` crops to the part that matters. And the
     * reader has to be told where to look, so `mark` draws a red ring around
     * the offending control before the shutter and takes it away after.
     *
     *   shot('caption', { mark: [field], clip: [field, grid] })
     *
     * `clip` defaults to whatever is marked, which is usually what is wanted.
     */
    const shot = async (caption, { mark = [], clip = [] } = {}) => {
      index += 1;
      const file = path.join(SHOTS_DIR, `${finding.id.replace(/[^\w]+/g, '-')}-${index}.png`);

      const boxesOf = async (locators) =>
        (await Promise.all(locators.map((l) => l.boundingBox().catch(() => null)))).filter(Boolean);

      const marked = await boxesOf(mark);
      if (marked.length) await drawMarkers(page, marked);

      const framed = await boxesOf(clip.length ? clip : mark);
      let region;
      if (framed.length) {
        const pad = 18;
        const view = page.viewportSize() ?? { width: 1600, height: 900 };
        const left = Math.max(0, Math.min(...framed.map((b) => b.x)) - pad);
        const top = Math.max(0, Math.min(...framed.map((b) => b.y)) - pad);
        const right = Math.min(view.width, Math.max(...framed.map((b) => b.x + b.width)) + pad);
        const bottom = Math.min(view.height, Math.max(...framed.map((b) => b.y + b.height)) + pad);
        region = { x: left, y: top, width: right - left, height: bottom - top };
      }

      await page.screenshot({ path: file, ...(region ? { clip: region } : {}) });
      await clearMarkers(page);

      figures.push({ file, caption });
    };

    try {
      await finding.capture(page, shot);
    } catch (error) {
      console.log(`  ! ${finding.id} capture failed: ${error.message.split('\n')[0]}`);
      await shot(`Capture failed: ${error.message.split('\n')[0]}`);
    }

    let recording = null;
    if (recorded) {
      // The file is only written out when the context closes, and it is named
      // by Playwright, so it has to be moved afterwards.
      const video = page.video();
      await recorded.close();
      if (video) {
        recording = path.join(VIDEO_DIR, `${finding.id.replace(/[^\w]+/g, '-')}.webm`);
        await video.saveAs(recording);
        await video.delete().catch(() => {});
        console.log(`  recorded ${path.basename(recording)}`);
      }
    }

    captured.push({ ...finding, figures, recording });
  }

  await shared.close();
  return captured;
}

const severityColour = { High: '#b42318', Medium: '#b54708', Low: '#175cd3' };

/** Most serious first, so the report opens on what matters. */
const severityRank = (s) => ({ High: 0, Medium: 1, Low: 2 }[s] ?? 3);

function renderFinding(finding) {
  const figures = finding.figures
    .map((f) => {
      const body = f.placeholder
        ? `<div class="pending">No screenshot yet — run <code>npm run bug-report</code> with the application up</div>`
        : `<img src="data:image/png;base64,${fs.readFileSync(f.file).toString('base64')}" alt="">`;
      return `
      <figure>
        ${body}
        <figcaption>${escapeHtml(f.caption)}</figcaption>
      </figure>`;
    })
    .join('');

  // A PDF cannot play a recording, so the printed page names the file and the
  // HTML plays it; the CSS below swaps one for the other at print time.
  const recording = finding.recording
    ? `
      <figure class="recording">
        <video controls preload="metadata" src="recordings/${escapeHtml(path.basename(finding.recording))}"></video>
        <p class="watch">Recording: <code>bug-report/recordings/${escapeHtml(path.basename(finding.recording))}</code></p>
        <figcaption>The defect as it happens — a still of the aftermath does not show it</figcaption>
      </figure>`
    : '';

  return `
    <section class="finding">
      <h3>
        <span class="id">${escapeHtml(finding.id)}</span>
        ${escapeHtml(finding.title)}
        <span class="sev" style="background:${severityColour[finding.severity] ?? '#475467'}">
          ${escapeHtml(finding.severity)}
        </span>
      </h3>
      <p class="where">${escapeHtml(finding.screen.name)} — <code>${escapeHtml(finding.screen.url)}</code></p>
      <div class="pair">
        <div>
          <h4>Steps</h4>
          <ol>${finding.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
        </div>
        <div>
          <h4>Expected</h4>
          <p>${escapeHtml(finding.expected)}</p>
          <h4>Actual</h4>
          <p class="actual">${escapeHtml(finding.actual)}</p>
        </div>
      </div>
      ${figures}
      ${recording}
    </section>`;
}

function renderHtml(findings) {
  const rows = (pairs) =>
    pairs.map(([id, text]) => `<tr><td class="cid">${escapeHtml(id)}</td><td>${escapeHtml(text)}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.55 "Segoe UI", system-ui, sans-serif; color: #101828; margin: 0; }
  h1 { font-size: 21pt; margin: 0 0 4px; }
  h2 { font-size: 14pt; margin: 26px 0 10px; padding-bottom: 5px; border-bottom: 2px solid #101828; }
  h3 { font-size: 12pt; margin: 0 0 4px; }
  h4 { font-size: 9.5pt; margin: 10px 0 3px; text-transform: uppercase; letter-spacing: .05em; color: #475467; }
  p { margin: 0 0 8px; }
  code { font-family: Consolas, monospace; font-size: .9em; background: #f2f4f7; padding: 1px 4px; border-radius: 3px; }
  .sub { color: #475467; margin: 0 0 2px; }
  .meta { color: #667085; font-size: 9.5pt; }
  .summary li { margin-bottom: 6px; }
  .finding { break-inside: avoid; page-break-inside: avoid; border: 1px solid #d0d5dd; border-radius: 6px;
             padding: 12px 14px; margin-bottom: 14px; }
  .id { font-family: Consolas, monospace; background: #101828; color: #fff; padding: 1px 7px;
        border-radius: 3px; font-size: 9.5pt; margin-right: 6px; }
  .sev { color: #fff; font-size: 8.5pt; padding: 2px 8px; border-radius: 10px; margin-left: 6px;
         text-transform: uppercase; letter-spacing: .04em; }
  .where { color: #667085; font-size: 9.5pt; margin-bottom: 8px; }
  .pair { display: grid; grid-template-columns: 1fr 1.4fr; gap: 18px; }
  .pair ol { margin: 0; padding-left: 18px; }
  .actual { background: #fef3f2; border-left: 3px solid #b42318; padding: 6px 9px; }
  figure { margin: 12px 0 0; break-inside: avoid; }
  /* Close-up crops are small; let them sit at their own size rather than being
     blown up, and keep a full-window shot from swallowing the page. */
  img { max-width: 100%; max-height: 105mm; border: 1px solid #d0d5dd; border-radius: 4px; display: block; }
  figcaption { font-size: 9pt; color: #667085; margin-top: 4px; }
  .pending { border: 1px dashed #d0d5dd; border-radius: 4px; padding: 14px; text-align: center;
             color: #98a2b3; font-size: 9.5pt; background: #fcfcfd; }
  video { width: 100%; max-height: 105mm; border: 1px solid #d0d5dd; border-radius: 4px; display: block;
          background: #101828; }
  .watch { display: none; margin: 0; padding: 9px 12px; border: 1px solid #d0d5dd; border-radius: 4px;
           background: #f9fafb; font-size: 9.5pt; color: #475467; }
  /* On paper the player is an empty box, so print the path to the file instead. */
  @media print { video { display: none; } .watch { display: block; } }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; }
  td { border-top: 1px solid #eaecf0; padding: 5px 6px; vertical-align: top; }
  .cid { font-family: Consolas, monospace; white-space: nowrap; width: 88px; color: #475467; }
  .appendix h4 { text-transform: none; font-size: 11pt; color: #101828; margin-bottom: 2px; }
</style></head>
<body>
  <h1>${escapeHtml(report.title)}</h1>
  <p class="sub">${escapeHtml(report.subtitle)}</p>
  <p class="meta">${escapeHtml(report.system)} &middot; ${escapeHtml(BASE)} &middot; ${new Date().toLocaleString('en-GB')}</p>

  <h2>Summary</h2>
  <ul class="summary">${report.summary.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>

  <h2>Defects (${findings.length})</h2>
  ${[...findings]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .map(renderFinding)
    .join('')}

  <h2>Behaved correctly</h2>
  <table>${rows(report.passed)}</table>

  <h2>Not covered by this run</h2>
  <table>${rows(report.notCovered)}</table>

  <h2 class="appendix">Also worth knowing</h2>
  <div class="appendix">
    ${report.appendix.map((a) => `<h4>${escapeHtml(a.title)}</h4><p>${escapeHtml(a.detail)}</p>`).join('')}
  </div>
</body></html>`;
}

/**
 * A stand-in figure for `--dry`, so the layout can be checked while the
 * application is down or before anyone wants to drive it.
 */
function placeholderEvidence() {
  return report.findings.map((f) => ({
    ...f,
    figures: [{ placeholder: true, caption: 'Evidence for this finding is captured from the running application' }],
  }));
}

const DRY = process.argv.includes('--dry');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: VIEWPORT });
  const page = await context.newPage();

  try {
    let findings;
    if (DRY) {
      console.log('--dry: laying the report out with placeholder figures, not touching the application');
      findings = placeholderEvidence();
    } else {
      // Sign in once and hand the session to every context that follows, so a
      // recorded finding does not have to log in again on camera.
      await signIn(page);
      const session = await context.storageState();
      findings = await collectEvidence(browser, session);
    }

    const html = renderHtml(findings);
    fs.writeFileSync(path.join(OUT_DIR, 'sample-collection-defects.html'), html);

    const printer = await context.newPage();
    await printer.setContent(html, { waitUntil: 'load' });
    // The report lives beside its recordings, so the <video> sources resolve.
    await printer.pdf({ path: PDF, format: 'A4', printBackground: true });

    const recorded = findings.filter((f) => f.recording).length;
    console.log(`\nwrote ${PDF}`);
    console.log(`screenshots in ${SHOTS_DIR}`);
    if (recorded) console.log(`${recorded} recording(s) in ${VIDEO_DIR}`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(`\nfailed: ${e.message}`);
  if (/ERR_CONNECTION_REFUSED|could not sign in/.test(e.message)) {
    console.error('The application does not appear to be running; start it and try again.');
  }
  process.exit(1);
});
