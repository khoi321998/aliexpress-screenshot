import type { Page } from 'playwright';

import { solveRecaptchaV2 } from './captcha.js';
import type { Logger } from './logger.js';

const URL_MARKERS = ['punish', '_____tmd_____', 'x5sec'];

// DOM selectors for an actual VISIBLE verification widget (AliExpress slider, baxia punish dialog,
// or an embedded Google reCAPTCHA). NOTE: tokens like "punish" appear in anti-bot scripts on every
// normal page, so only a visible widget / punish URL / punish text counts — not mere DOM presence.
const WIDGET_SELECTORS = [
    '#nc_1_wrapper',
    '.nc-container',
    '#baxia-dialog',
    '#baxia-punish',
    '.baxia-dialog',
    '#nocaptcha',
    '.J_MIDDLEWARE_FRAME_WIDGET',
    'iframe[src*="recaptcha"]',
    'iframe[title*="recaptcha" i]',
];

const TEXT_MARKERS = ['check if you are a robot', "i'm not a robot", 'slide to verify', 'verify to continue'];

/**
 * Detect whether the current page is a captcha / punish page.
 * Returns the matching signal (for logging, e.g. `visible element ".nc-container"`) or null if clean.
 */
export async function detectBlock(page: Page): Promise<string | null> {
    const lowerUrl = page.url().toLowerCase();
    for (const marker of URL_MARKERS) {
        if (lowerUrl.includes(marker)) return `url contains "${marker}"`;
    }

    return page
        .evaluate(
            ({ sels, texts }) => {
                const isVisible = (el: Element | null): boolean => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) return false;
                    const style = getComputedStyle(el);
                    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
                };
                const sel = sels.find((s) => isVisible(document.querySelector(s)));
                if (sel) return `visible element "${sel}"`;
                const body = (document.body?.innerText ?? '').toLowerCase();
                const txt = texts.find((t) => body.includes(t));
                return txt ? `text "${txt}"` : null;
            },
            { sels: WIDGET_SELECTORS, texts: TEXT_MARKERS },
        )
        .catch(() => null);
}

/**
 * Find the reCAPTCHA sitekey by scanning every frame's URL for the `k=<sitekey>` query param
 * (polling ~12×1s, since the challenge iframe may load late), falling back to a `[data-sitekey]` attribute.
 */
export async function findRecaptchaSitekey(page: Page): Promise<string | null> {
    for (let attempt = 0; attempt < 12; attempt++) {
        for (const frame of page.frames()) {
            const match = frame.url().match(/[?&]k=([^&]+)/);
            if (match) return decodeURIComponent(match[1]);
        }
        const dataKey = await page
            .locator('[data-sitekey]')
            .first()
            .getAttribute('data-sitekey')
            .catch(() => null);
        if (dataKey) return dataKey;
        await page.waitForTimeout(1_000);
    }
    return null;
}

/**
 * Inject the solved token into every FRAME that hosts a `g-recaptcha-response` field (the field
 * lives in the nested reCAPTCHA iframe, not the main document — so a single main-frame evaluate
 * finds 0 fields). For each frame we set the field, fire input/change, then walk
 * `___grecaptcha_cfg.clients` to invoke any registered `callback(token)`. Returns the total number
 * of token fields written across all frames (for logging).
 */
export async function injectRecaptchaToken(page: Page, token: string): Promise<number> {
    let totalInjected = 0;
    for (const frame of page.frames()) {
        try {
            const count = await frame.evaluate((tk) => {
                const fields = document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
                    'textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"], [name="g-recaptcha-response"]',
                );
                fields.forEach((field) => {
                    // eslint-disable-next-line no-param-reassign
                    field.value = tk;
                    field.dispatchEvent(new Event('input', { bubbles: true }));
                    field.dispatchEvent(new Event('change', { bubbles: true }));
                });

                // Try to invoke the page's reCAPTCHA success callback directly.
                /* eslint-disable no-underscore-dangle */
                const cfg = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } })
                    .___grecaptcha_cfg;
                /* eslint-enable no-underscore-dangle */
                if (cfg?.clients) {
                    for (const client of Object.values(cfg.clients)) {
                        const stack: unknown[] = [client];
                        while (stack.length) {
                            const node = stack.pop();
                            if (!node || typeof node !== 'object') continue;
                            for (const v of Object.values(node as Record<string, unknown>)) {
                                if (v && typeof v === 'object') {
                                    const { callback } = v as { callback?: unknown };
                                    if (typeof callback === 'function') {
                                        try {
                                            (callback as (arg: string) => void)(tk);
                                        } catch {
                                            /* keep trying other callbacks */
                                        }
                                    }
                                    stack.push(v);
                                }
                            }
                        }
                    }
                }

                return fields.length;
            }, token);
            totalInjected += count ?? 0;
        } catch {
            // detached / cross-origin frame — skip and keep going
        }
    }
    return totalInjected;
}

/**
 * Attempt to solve a reCAPTCHA-based punish page via 2captcha (seller mode only). Logs each step.
 * Returns true if the page is no longer blocked afterwards. Never rotates — seller mode solves in place.
 */
export async function trySolveCaptcha(
    page: Page,
    pageUrl: string,
    apiKey: string | undefined,
    log: Logger,
): Promise<boolean> {
    if (!apiKey) {
        log.warning('Captcha detected but no 2captcha API key configured — cannot solve.');
        return false;
    }

    log.info('🔍 [2/5] Looking for the reCAPTCHA sitekey across all frames...');
    const sitekey = await findRecaptchaSitekey(page);
    if (!sitekey) {
        log.warning('❌ No reCAPTCHA sitekey found after waiting — captcha may be a slider/other type.');
        return false;
    }
    log.info(`🔑 [2/5] Found reCAPTCHA sitekey: ${sitekey}`);

    log.info('📤 [3/5] Sending captcha to 2captcha and waiting for a human/AI solver...');
    const startedAt = Date.now();
    const token = await solveRecaptchaV2(sitekey, pageUrl, apiKey, log);
    if (!token) {
        log.warning('❌ 2captcha did not return a token.');
        return false;
    }
    log.info(`🎟️  [4/5] Got token from 2captcha in ${Math.round((Date.now() - startedAt) / 1000)}s (length=${token.length}).`);

    const injected = await injectRecaptchaToken(page, token);
    log.info(`💉 [5/5] Injected token into ${injected} g-recaptcha-response field(s); waiting for the punish page to clear...`);

    // Poll for the block to clear after injecting the token (~20×1s). Do NOT wait for networkidle —
    // a punish page never goes idle (reCAPTCHA + trackers), which would add a needless delay.
    for (let attempt = 0; attempt < 20; attempt++) {
        if (!(await detectBlock(page))) {
            log.info('✅ Captcha cleared! Page is no longer blocked 🎉');
            return true;
        }
        await page.waitForTimeout(1_000);
    }

    log.warning('⚠️  Still blocked ~20s after injecting the token. Submit step may need adjustment.');
    return false;
}

/**
 * Detect → solve → reload the captcha for whatever page is currently loaded, up to 2 rounds.
 * IMPORTANT: a reload only happens AFTER a successful solve — a clean page (no captcha) is never
 * reloaded. Returns true if the page is STILL blocked afterwards, false once it's clean.
 * `label` names the page for the logs.
 */
export async function passCaptcha(
    page: Page,
    apiKey: string | undefined,
    log: Logger,
    label: string,
): Promise<boolean> {
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);

    // Detect the captcha ASAP — the punish script injects its dialog within ~1s, so a short poll
    // (~6×500ms = 3s) catches a late-injected dialog without stalling clean pages.
    let signal: string | null = null;
    for (let i = 0; i < 6; i++) {
        signal = await detectBlock(page);
        if (signal) break;
        await page.waitForTimeout(500);
    }
    if (!signal) {
        log.info(`✅ No captcha on ${label} — page is clean.`);
        return false; // no captcha → no reload, capture right away
    }

    log.warning(`🚧 Captcha / punish detected on ${label} (signal: ${signal}).`);
    const solved = await trySolveCaptcha(page, page.url(), apiKey, log);
    if (!solved) return true; // couldn't solve — report still-blocked

    // Reload so the SPA renders the real content with the validated cookies, then a SINGLE quick
    // re-check (trySolveCaptcha already confirmed the dialog cleared — no need to re-poll a full
    // round, which is what made the post-solve wait long).
    log.info(`🔄 Reloading ${label} to load content after passing the captcha...`);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    const after = await detectBlock(page);
    if (after) {
        log.warning(`⚠️  ${label} still blocked after reload (signal: ${after}).`);
        return true;
    }
    log.info(`✅ ${label} clean after solving captcha — ready to capture.`);
    return false;
}
