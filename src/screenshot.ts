import { createHash } from 'node:crypto';

import { Actor } from 'apify';
import type { Page } from 'playwright';

import type { Logger } from './logger.js';

export interface CaptureOptions {
    fullPage: boolean;
    format: 'png' | 'jpeg';
    waitMs: number;
    /**
     * Hard ceiling (in CSS pixels) on how deep a full-page capture goes — the caller derives it
     * from `maxCaptureScreens * viewportHeight`. AliExpress `/store/` pages append products as you
     * scroll, so `scrollHeight` grows about as fast as we scroll and the "scroll to the bottom"
     * loop never terminates on its own. The cap bounds BOTH the scroll loop and the captured
     * image. `0` disables it (only safe on `/item/` pages, which are finite).
     */
    maxHeight: number;
}

/**
 * Playwright defaults to 30s, which a tall full-page capture blows through while encoding. Only
 * reached when the page is genuinely enormous — a normal capture finishes in a second or two.
 */
const SCREENSHOT_TIMEOUT_MS = 120_000;

/**
 * Build a key-value-store-safe key for a screenshot. KV keys allow only `[a-zA-Z0-9!\-_.'()]`
 * and must be ≤256 chars, so we sanitize the URL and append an md5 hash to keep it unique.
 */
export function buildKey(url: string): string {
    const hash = createHash('md5').update(url).digest('hex');
    const sanitized = url.replace(/[^a-zA-Z0-9!\-_.'()]/g, '_');
    let key = `screenshot_${sanitized}_${hash}`;
    if (key.length > 256) key = `screenshot_${hash}`;
    return key;
}

/** Current full document size, which grows as lazy-loaded content renders. */
async function documentSize(page: Page): Promise<{ width: number; height: number }> {
    return page.evaluate(() => ({
        width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
        height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    }));
}

/**
 * Lazily scroll the page to trigger lazy-loaded content (AliExpress renders the description
 * block and several product sections only once they scroll into view, often inside an iframe).
 * We scroll in small steps, pause at the bottom so that lazily-fetched content can finish loading,
 * then return to the top. `settleMs` is how long we wait at the bottom before scrolling back up.
 *
 * Stops at whichever comes first: the bottom of the document, or `maxScrollPx` (see
 * `CaptureOptions.maxHeight`). Without that second condition an infinite-scroll store page keeps
 * the loop running until the Actor times out.
 */
async function lazyLoadScroll(page: Page, maxScrollPx: number, settleMs = 2_500): Promise<void> {
    // Scroll down in small steps, re-reading scrollHeight each tick since it grows as content loads.
    await page.evaluate(async (maxPx) => {
        await new Promise<void>((resolve) => {
            let total = 0;
            const distance = 300;
            const timer = setInterval(() => {
                const scrollHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                window.scrollBy(0, distance);
                total += distance;
                if (total >= scrollHeight || (maxPx > 0 && total >= maxPx)) {
                    clearInterval(timer);
                    resolve();
                }
            }, 250);
        });
    }, maxScrollPx);

    // Wait at the bottom for late-loading sections (e.g. the description iframe) to render.
    await page.waitForTimeout(settleMs);

    await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Capture a screenshot, store it in the default key-value store, and push
 * `{ url, screenshotUrl }` to the dataset. `screenshotUrl` is a signed public KV URL
 * with `disableRedirect=true` so it resolves directly to the PNG/JPEG.
 *
 * `extra` is merged into the pushed record — the product flow uses it to stamp `blocked` on a
 * last-resort capture (final attempt, page still behind a challenge) so it is never mistaken for a
 * clean one.
 */
export async function captureAndSave(
    page: Page,
    url: string,
    opts: CaptureOptions,
    log: Logger,
    extra?: Record<string, unknown>,
): Promise<void> {
    if (opts.fullPage) {
        await lazyLoadScroll(page, opts.maxHeight);
    }
    if (opts.waitMs > 0) {
        await page.waitForTimeout(opts.waitMs);
    }

    // Playwright trims `clip` against the document rect, so combining it with `fullPage` yields
    // "the whole page, but no taller than maxHeight" — exactly the ceiling we want.
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (opts.fullPage && opts.maxHeight > 0) {
        const size = await documentSize(page);
        if (size.height > opts.maxHeight) {
            clip = { x: 0, y: 0, width: size.width, height: opts.maxHeight };
            log.info('Page is taller than the capture cap — clipping.', {
                url,
                documentHeight: size.height,
                maxHeight: opts.maxHeight,
            });
        }
    }

    const screenshot = await page.screenshot({
        fullPage: opts.fullPage,
        type: opts.format,
        timeout: SCREENSHOT_TIMEOUT_MS,
        ...(clip ? { clip } : {}),
        ...(opts.format === 'jpeg' ? { quality: 85 } : {}),
    });

    const key = buildKey(url);
    const contentType = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const store = await Actor.openKeyValueStore();
    await store.setValue(key, screenshot, { contentType });

    const publicUrl = store.getPublicUrl(key);
    const screenshotUrl = `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}disableRedirect=true`;

    log.info('Screenshot captured.', { url, key, ...extra });
    log.info(`Screenshot URL: ${screenshotUrl}`);
    await Actor.pushData({ url, screenshotUrl, ...extra });
}
