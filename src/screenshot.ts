import { createHash } from 'node:crypto';

import { Actor } from 'apify';
import type { Page } from 'playwright';

import type { Logger } from './logger.js';

export interface CaptureOptions {
    fullPage: boolean;
    format: 'png' | 'jpeg';
    waitMs: number;
}

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

/**
 * Lazily scroll the full page to trigger lazy-loaded content (AliExpress renders the description
 * block and several product sections only once they scroll into view, often inside an iframe).
 * We scroll in small steps, pause at the bottom so that lazily-fetched content can finish loading,
 * then return to the top. `settleMs` is how long we wait at the bottom before scrolling back up.
 */
async function lazyLoadScroll(page: Page, settleMs = 2_500): Promise<void> {
    // Scroll down in small steps, re-reading scrollHeight each tick since it grows as content loads.
    await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            let total = 0;
            const distance = 300;
            const timer = setInterval(() => {
                const scrollHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                window.scrollBy(0, distance);
                total += distance;
                if (total >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 250);
        });
    });

    // Wait at the bottom for late-loading sections (e.g. the description iframe) to render.
    await page.waitForTimeout(settleMs);

    await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Capture a screenshot, store it in the default key-value store, and push
 * `{ url, screenshotUrl }` to the dataset. `screenshotUrl` is a signed public KV URL
 * with `disableRedirect=true` so it resolves directly to the PNG/JPEG.
 */
export async function captureAndSave(page: Page, url: string, opts: CaptureOptions, log: Logger): Promise<void> {
    if (opts.fullPage) {
        await lazyLoadScroll(page);
    }
    if (opts.waitMs > 0) {
        await page.waitForTimeout(opts.waitMs);
    }

    const screenshot = await page.screenshot({
        fullPage: opts.fullPage,
        type: opts.format,
        ...(opts.format === 'jpeg' ? { quality: 85 } : {}),
    });

    const key = buildKey(url);
    const contentType = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const store = await Actor.openKeyValueStore();
    await store.setValue(key, screenshot, { contentType });

    const publicUrl = store.getPublicUrl(key);
    const screenshotUrl = `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}disableRedirect=true`;

    log.info('Screenshot captured.', { url, key });
    await Actor.pushData({ url, screenshotUrl });
}
