import { BrowserContext, Page } from '@playwright/test';

/**
 * Reading back what the app actually printed.
 *
 * Every print on this system is built in the browser: the server hands down the
 * bytes, JavaScript wraps them in a `Blob`, and `URL.createObjectURL` turns that
 * into a `blob:` URL which is opened in a second tab. Checking that the tab
 * opened proves very little — a tab opens just as readily on an empty file — so
 * what a test wants is the bytes.
 *
 * The obvious way to get them, fetching the `blob:` URL back from the page that
 * made it, does not work here. Measured against the live app: the URL is never
 * revoked, and `fetch` on it fails immediately and at every moment afterwards,
 * from the creating page, while Chrome's viewer displays the same URL perfectly
 * in the print tab. Whatever the app's content policy allows, it does not allow
 * that fetch — so a read built on it reports "could not be read back" for a
 * report that printed correctly, which is how the microbiology spec came to
 * fail on a flawless 2 MB PDF.
 *
 * So the Blob is kept at the moment it is made, and read from there. Nothing is
 * intercepted or changed on the way through: `createObjectURL` is called as it
 * always was, returns what it always did, and the object it was given is held
 * on to as well.
 */
type PrintWindow = Window & { __printedBlobs?: Record<string, Blob>; __printedOrder?: string[] };

/** What a printed file turned out to be. */
export type PrintedFile = {
  url: string;
  /** Bytes the browser actually holds. */
  size: number;
  /** The file's first five bytes — "%PDF-" for a PDF. */
  header: string;
  contentType: string;
};

/** How many blobs to hold at once; a printed report runs to a few megabytes. */
const KEEP = 8;

function keepObjectUrls(limit: number) {
  const w = window as PrintWindow;
  if (w.__printedBlobs) return;

  const kept: Record<string, Blob> = {};
  const order: string[] = [];
  w.__printedBlobs = kept;
  w.__printedOrder = order;

  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = create(object as Blob);
    if (object instanceof Blob) {
      kept[url] = object;
      order.push(url);
      // Held objects are not collected, so only the last few are kept.
      while (order.length > limit) delete kept[order.shift()!];
    }
    return url;
  };
}

/**
 * Keeps the blobs behind every `blob:` URL the context's pages create, from the
 * next navigation onwards.
 */
export async function keepPrintedBlobs(context: BrowserContext, limit = KEEP) {
  await context.addInitScript(keepObjectUrls, limit);
}

/** The same, for a document that is already open. Best effort. */
export async function keepPrintedBlobsOnPage(page: Page, limit = KEEP) {
  await page.evaluate(keepObjectUrls, limit).catch(() => {});
}

/**
 * Reads a printed `blob:` URL back as bytes.
 *
 * Reads the kept object where there is one. Where there is not — a blob made
 * before the recorder was installed, or by a window other than this one — it
 * falls back to fetching the URL, which is better than nothing on a page whose
 * policy allows it.
 *
 * Returns null when the bytes cannot be reached at all, which is the honest
 * answer in a headless run, where no blob is ever navigated to.
 */
export async function readPrintedBlob(page: Page, url: string): Promise<PrintedFile | null> {
  if (!url.startsWith('blob:')) return null;

  return page.evaluate(async (blobUrl) => {
    const kept = (window as PrintWindow).__printedBlobs?.[blobUrl];

    try {
      const blob: Blob = kept ?? (await (await fetch(blobUrl)).blob());
      const buffer = await blob.arrayBuffer();
      return {
        url: blobUrl,
        size: buffer.byteLength,
        header: new TextDecoder().decode(new Uint8Array(buffer.slice(0, 5))),
        contentType: blob.type,
      };
    } catch {
      return null;
    }
  }, url);
}
