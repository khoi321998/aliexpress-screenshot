/**
 * AliExpress screenshot Actor.
 *
 * Captures a full screenshot of an AliExpress product (`/item/`) or seller (`/store/`) page and
 * stores it as a signed key-value-store PNG/JPEG. Output per request: `{ url, screenshotUrl }`.
 *
 * Two browser modes (see `mode` input):
 *  - `product`: Apify datacenter proxy + fingerprint injector, driven by a TOKEN-FIRST flow
 *    (see `productApi.ts`). Pass 1 is a cheap bootstrap navigation that only warms the anti-bot
 *    cookies; we then probe the session with the signed MTOP `pdp.pc.query` call. A bad session is
 *    detected in seconds — we retire it and throw so Crawlee retries on a fresh IP + fingerprint,
 *    with no time wasted rendering a page that was never going to work. Only once the token proves
 *    valid does pass 2 reload the page for real (assets unblocked) and screenshot it. NEVER solves
 *    captchas here.
 *  - `seller`: real local/container IP, no proxy, no fingerprint. Solves captchas in place via
 *    2captcha and reloads — does NOT rotate.
 *
 * ESM project — relative imports must use the `.js` extension even from `.ts` sources.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { PlaywrightCrawler, type PlaywrightCrawlingContext } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import type { Page } from 'playwright';

import { allowAssets, armAssetBlocking } from './assets.js';
import { CHALLENGE_SELECTORS, classifyPage, TITLE_SELECTORS } from './detection.js';
import { logEgressIp } from './ip.js';
import { armPdpInterceptor, probeProductToken } from './productApi.js';
import { captureAndSave, type CaptureOptions } from './screenshot.js';
import { passCaptcha } from './sellerCaptcha.js';
import { extractAliExpressItemId, normalizeAliExpressUrl } from './url.js';

interface Input {
    startUrls?: { url: string }[];
    mode?: 'product' | 'seller';
    format?: 'png' | 'jpeg';
    fullPage?: boolean;
    viewportWidth?: number;
    viewportHeight?: number;
    twoCaptchaApiKey?: string;
    /** Local debugging only — set false to watch the browser drive the page. Defaults to true. */
    headless?: boolean;
}

// --- Hard-coded operational config (intentionally NOT exposed as input) --------------------------
// These are fixed in code rather than passed via input. To change one, edit it here.
const PROXY_COUNTRY = 'US';
const CURRENCY = 'USD';
const LANGUAGE = 'en_US';
const MAX_CONCURRENCY = 2;
/** Hard cap on how many URLs a single run accepts (anything beyond this is dropped). */
const MAX_URLS = 10;
const WAIT_MS = 3_000;

/**
 * Product mode: how many times we run the handler for one URL before giving up on rotation. The
 * LAST of these attempts is the one that captures whatever rendered, captcha or not (see
 * `rotateOrCapture`). Crawlee runs a request `maxRequestRetries + 1` times, hence the -1.
 */
const MAX_ATTEMPTS_PER_URL = 20;
const MAX_REQUEST_RETRIES = MAX_ATTEMPTS_PER_URL - 1;

/**
 * Seller mode keeps the old, smaller budget: it SOLVES captchas rather than rotating, and one
 * attempt can spend minutes inside a 2captcha solve — 20 of those would run for hours.
 */
const SELLER_MAX_ATTEMPTS_PER_URL = 11;

await Actor.init();

/**
 * Strip tracking query params (and the hash) from an AliExpress URL. The store SPA renders an empty
 * body when it receives the `_gl=` (Google Analytics linker) / `spm=` params that AliExpress appends
 * to shared links — the clean `https://www.aliexpress.com/store/<id>` form renders correctly.
 * `/item/` and `/store/` pages don't need any query params to render, so it's safe to drop them all.
 */
function normalizeUrl(raw: string): string {
    try {
        const u = new URL(raw);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        return raw;
    }
}

const input = ((await Actor.getInput<Input>()) ?? {}) as Input;
const mode: 'product' | 'seller' = input.mode === 'seller' ? 'seller' : 'product';

// Product mode canonicalizes `/item/` URLs to `https://www.aliexpress.com/item/<id>.html` — the
// locale subdomain (`vi.`, `de.`, `m.`, …) is itself a region signal that contradicts our proxy
// country. Anything else (and every seller URL) just loses its tracking params.
const allUrls = [
    ...new Set(
        (input.startUrls ?? [])
            .map((entry) => entry.url)
            .filter(Boolean)
            .map((url) => {
                const clean = (mode === 'product' ? normalizeAliExpressUrl(url) : null) ?? normalizeUrl(url);
                if (clean !== url) log.info('Normalized URL.', { from: url, to: clean });
                return clean;
            }),
    ),
];
// The URL count is capped HERE rather than via `maxRequestsPerCrawl`, which counts every handler
// run — retries included — and so would silently eat the retry budget instead of limiting URLs.
const startUrls = allUrls.slice(0, MAX_URLS);
if (allUrls.length > startUrls.length) {
    log.warning(`Too many URLs — capturing the first ${MAX_URLS} and dropping the rest.`, {
        received: allUrls.length,
        dropped: allUrls.length - startUrls.length,
    });
}
const HEADLESS = input.headless ?? true;
const viewportWidth = input.viewportWidth ?? 1920;
const viewportHeight = input.viewportHeight ?? 1080;
const captureOptions: CaptureOptions = {
    fullPage: input.fullPage ?? true,
    format: input.format === 'jpeg' ? 'jpeg' : 'png',
    waitMs: WAIT_MS,
};

// Terminate quickly when aborted to honour any cost limits (PPU/PPE+U billing).
Actor.on('aborting', async () => {
    // Wait 1s to let Crawlee/SDK state-persistence operations finish before exiting.
    await sleep(1_000);
    await Actor.exit();
});

// --- Shared hooks (ported from the eBay base actor, behaviour unchanged) -------------------------

/** Log any navigation response with status >= 400, including the markers useful for diagnosing blocks. */
async function errorResponseHook({
    response,
    request,
    log: ctxLog,
}: PlaywrightCrawlingContext): Promise<void> {
    const status = response?.status() ?? 0;
    if (status < 400) return;
    const headers = response?.headers() ?? {};
    let bodySnippet = '';
    try {
        bodySnippet = (await response!.text()).slice(0, 500);
    } catch {
        /* body may not be readable — best-effort only */
    }
    ctxLog.warning('Received error response.', {
        url: request.url,
        status,
        cfRay: headers['cf-ray'],
        server: headers.server,
        bodySnippet,
    });
}

async function pushFailure({ request, log: ctxLog }: PlaywrightCrawlingContext): Promise<void> {
    const error = request.errorMessages?.[request.errorMessages.length - 1] ?? 'Unknown error';
    ctxLog.error('Request failed after all retries.', { url: request.url, error });
    await Actor.pushData({ url: request.url, screenshotUrl: null, error });
}

// =================================================================================================
// PRODUCT MODE — US residential proxy + fingerprint, rotate on block (never solve)
// =================================================================================================

const FINGERPRINT_OPTIONS = {
    browsers: [{ name: 'chrome' as const, minVersion: 120 }],
    operatingSystems: ['windows' as const, 'macos' as const],
    devices: ['desktop' as const],
    locales: ['en-US', 'en'],
};
const CHROME_LAUNCH_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-infobars',
    '--disable-notifications',
    '--lang=en-US',
];
const LOCALE = 'en-US';
const TIMEZONE_ID = 'America/New_York';

async function applyRegionOverrides(page: Page): Promise<void> {
    try {
        const client = await page.context().newCDPSession(page);
        await client.send('Emulation.setTimezoneOverride', { timezoneId: TIMEZONE_ID });
        await client.send('Emulation.setLocaleOverride', { locale: LOCALE });
    } catch {
        /* best-effort, never block the crawl */
    }
}

async function applyStealthInitScript(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as { chrome?: unknown };
        if (!w.chrome) w.chrome = { runtime: {} };
        const oq = window.navigator.permissions?.query?.bind(window.navigator.permissions);
        if (oq) {
            window.navigator.permissions.query = async (p: PermissionDescriptor) =>
                p.name === ('notifications' as PermissionName)
                    ? Promise.resolve({ state: Notification.permission } as unknown as PermissionStatus)
                    : oq(p);
        }
    });
}

/**
 * Per-run tally of how many times we rotated because of an anti-bot block, keyed by reason
 * (`captcha`, `punish`, `pdp-blocked`, `empty-product`, …). Each entry counts one actual
 * block-and-retry event — unlike Crawlee's `requestsRetries`, which counts +1 per request no matter
 * how many times it was retried.
 */
const rotationStats: Record<string, number> = {};

/** Retire the session (→ fresh IP + fresh fingerprint on retry) and throw so Crawlee retries. */
function rotateAndRetry(ctx: PlaywrightCrawlingContext, reason: string): never {
    rotationStats[reason] = (rotationStats[reason] ?? 0) + 1;
    ctx.log.warning('Block detected — rotating session/IP/fingerprint and retrying.', {
        reason,
        url: ctx.request.url,
        sessionId: ctx.session?.id,
        retryCount: ctx.request.retryCount,
    });
    ctx.session?.retire();
    throw new Error(`Anti-bot block (${reason}); rotating to a fresh session/proxy.`);
}

/**
 * True when Crawlee has no retries left for this request — the next throw would hand it straight to
 * `failedRequestHandler`. Crawlee runs a request `maxRequestRetries + 1` times, with `retryCount`
 * counting from 0, so the last pass is the one where `retryCount === MAX_REQUEST_RETRIES`.
 */
function isFinalAttempt(ctx: PlaywrightCrawlingContext): boolean {
    return ctx.request.retryCount >= MAX_REQUEST_RETRIES;
}

/**
 * Handle a detected block. Normally this rotates and never returns.
 *
 * On the FINAL attempt there is nothing left to rotate to — throwing would end the run with an empty
 * dataset row and no image at all. So we log it, RETURN, and let the handler carry on to capture
 * whatever rendered, captcha page included: a screenshot of the block is more useful to the caller
 * than nothing, and it makes the failure visible rather than merely reported.
 */
function rotateOrCapture(ctx: PlaywrightCrawlingContext, reason: string): void {
    if (!isFinalAttempt(ctx)) {
        rotateAndRetry(ctx, reason);
    }
    rotationStats[`final-capture:${reason}`] = (rotationStats[`final-capture:${reason}`] ?? 0) + 1;
    ctx.log.warning('Final attempt — no retries left; capturing the page as-is despite the block.', {
        reason,
        url: ctx.request.url,
        retryCount: ctx.request.retryCount,
    });
}

async function buildProductCrawler(): Promise<PlaywrightCrawler> {
    // Apify DATACENTER proxy (default automatic pool — no groups). Datacenter is far lower-latency
    // than residential, so each attempt is cheap; paired with the token probe below (which detects a
    // burned session in seconds), we accept a higher block rate and lean on fast rotate-and-retry.
    // Swap in `{ groups: ['RESIDENTIAL'], countryCode: PROXY_COUNTRY }` for the slower, cleaner path.
    const proxyConfiguration = await Actor.createProxyConfiguration({
        countryCode: PROXY_COUNTRY,
    }); // do NOT pass checkAccess — local runs without proxy access must still run.
    log.info(`Using Apify datacenter proxy (auto, country ${PROXY_COUNTRY}).`);

    const localeCookieValue = `site=glo&c_tp=${CURRENCY}&region=${PROXY_COUNTRY}&b_locale=${LANGUAGE}&ae_u_p_s=2`;

    return new PlaywrightCrawler({
        proxyConfiguration,
        navigationTimeoutSecs: 45,
        requestHandlerTimeoutSecs: 180,
        minConcurrency: 1,
        maxConcurrency: MAX_CONCURRENCY,
        // Sized off the retry budget: `maxRequestsPerCrawl` counts handler runs (retries included),
        // so a flat number would cut rotation short before the final-attempt capture ever ran.
        maxRequestsPerCrawl: startUrls.length * MAX_ATTEMPTS_PER_URL,
        maxRequestRetries: MAX_REQUEST_RETRIES,
        useSessionPool: true,
        persistCookiesPerSession: true,
        retryOnBlocked: false, // we own block detection; Crawlee must not second-guess it mid-handler
        sessionPoolOptions: {
            maxPoolSize: Math.max(MAX_CONCURRENCY + 2, 4),
            sessionOptions: { maxUsageCount: 5, maxErrorScore: 1 }, // maxErrorScore:1 = drop a burned IP immediately
        },
        launchContext: {
            useChrome: true,
            launchOptions: { headless: HEADLESS, args: CHROME_LAUNCH_ARGS },
        },
        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: { fingerprintGeneratorOptions: FINGERPRINT_OPTIONS },
            retireBrowserAfterPageCount: 5,
        },
        preNavigationHooks: [
            async ({ page }, gotoOptions) => {
                await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
                // AliExpress decides currency/locale from the `aep_usuc_f` cookie (and the proxy IP
                // geo), not from the `_currency` field in the pdp payload. Pin it on BOTH domains we
                // touch: `.com` for navigation, `.us` for the `acs` MTOP host.
                await page.context().addCookies([
                    { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.com', path: '/' },
                    { name: 'intl_locale', value: LANGUAGE, domain: '.aliexpress.com', path: '/' },
                    { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.us', path: '/' },
                    { name: 'intl_locale', value: LANGUAGE, domain: '.aliexpress.us', path: '/' },
                ]);
                // Pass 1 exists only to bootstrap cookies, so drop the heavy subresources and resolve
                // navigation at `commit` — the instant the document response (and its Set-Cookie
                // headers) lands, WITHOUT waiting for the SPA to parse/execute. Both are lifted again
                // for the render pass. Never `networkidle` (AliExpress holds connections open).
                await armAssetBlocking(page);
                armPdpInterceptor(page);
                // eslint-disable-next-line no-param-reassign -- mutating gotoOptions is the documented Crawlee way to set navigation options.
                if (gotoOptions) gotoOptions.waitUntil = 'commit';
                await applyRegionOverrides(page);
                await applyStealthInitScript(page);
            },
        ],
        postNavigationHooks: [errorResponseHook],
        failedRequestHandler: pushFailure,
        requestHandler: async (ctx) => {
            const { page, request, log: ctxLog } = ctx;
            // Set once we detect a block we can no longer rotate away from (final attempt). It both
            // short-circuits the checks below and lands in the dataset row, so a last-resort capture
            // is never mistaken for a clean one.
            let blockedAs: string | null = null;

            // 1. Hard block already visible on arrival → rotate immediately (never solve).
            const arrival = await classifyPage(page);
            if (arrival === 'captcha' || arrival === 'punish' || arrival === 'blocked') {
                rotateOrCapture(ctx, arrival); // returns ONLY on the final attempt
                blockedAs = arrival;
            }

            // 2. TOKEN GATE. Acquire the `_m_h5_tk` token and fetch the product payload with it. This
            //    is the whole point of the two-pass flow: a burned session fails here in ~1-3s instead
            //    of after a 30-45s render that ends in a slider captcha. Rotating is therefore cheap,
            //    which is what makes the retry loop fast.
            const productId = extractAliExpressItemId(request.url);
            if (blockedAs) {
                // Already known blocked and out of retries — the signed call would only spend seconds
                // confirming what we can see. Go straight to rendering the block for the screenshot.
                ctxLog.warning('Skipping the token gate — already blocked with no retries left.', { reason: blockedAs });
            } else if (!productId) {
                // Not a /item/ URL (mode mismatch) — nothing to gate on; render it as-is.
                ctxLog.warning('No product id in URL — skipping the token gate.', { url: request.url });
            } else {
                const probe = await probeProductToken(page, productId, ctxLog);
                if (probe.ok) {
                    ctxLog.info('Token valid — session trusted, rendering the page for capture.', {
                        productId,
                        title: probe.title,
                    });
                } else {
                    // `pdp-blocked` may actually be a captcha/punish overlay — reclassify for an
                    // accurate tally ('ok' with no JSON means the signed call timed out, not a block).
                    let reason = probe.reason ?? 'pdp-blocked';
                    if (reason === 'pdp-blocked') {
                        const status = await classifyPage(page);
                        reason = status === 'ok' ? 'pdp-timeout' : status;
                    }
                    rotateOrCapture(ctx, reason);
                    blockedAs = reason;
                }
            }

            await logEgressIp(page, ctxLog, 'product'); // expect a proxy IP here

            // 3. RENDER PASS. The token proved the session is trusted, so now pay for a real render:
            //    unblock images/fonts/CSS (the screenshot needs them) and reload the page properly.
            //    On a final-attempt capture we reload too — pass 1 stopped at `commit` with assets
            //    blocked, so without it the "screenshot" would be a half-styled shell.
            allowAssets(page);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((error: unknown) => {
                ctxLog.warning('Render-pass reload failed — capturing whatever is on the page.', {
                    error: error instanceof Error ? error.message : String(error),
                });
            });

            // 4. Race the product title against any challenge selector: AliExpress injects the
            //    slider/reCAPTCHA a few seconds AFTER domcontentloaded, so blindly waiting out the
            //    title timeout would burn ~30s per challenged page. Whichever appears first wins.
            await Promise.race([
                page.waitForSelector(TITLE_SELECTORS.join(', '), { timeout: 30_000 }).catch(() => null),
                page.waitForSelector(CHALLENGE_SELECTORS.join(', '), { timeout: 30_000 }).catch(() => null),
            ]);

            // 5. Short hydration settle (never networkidle), then a final classify — a late challenge
            //    can still appear after hydration, and `empty` after a full load is a soft block.
            await page.waitForTimeout(1_500 + Math.random() * 1_500);
            const rendered = await classifyPage(page);
            if (rendered !== 'ok') {
                rotateOrCapture(ctx, `render-${rendered}`); // returns ONLY on the final attempt
                blockedAs = `render-${rendered}`;
            }

            // 6. Lazy-load scroll (if fullPage) → waitMs → screenshot → KV save → pushData.
            await captureAndSave(page, request.url, captureOptions, ctxLog, blockedAs ? { blocked: blockedAs } : undefined);
        },
    });
}

// =================================================================================================
// SELLER MODE — real IP, no fingerprint, solve captcha via 2captcha (never rotate)
// =================================================================================================

/**
 * AliExpress overlays a "Register by passkey" login drawer (`.cosmos-drawer`) on store pages.
 * It covers the right side of the viewport and ruins the screenshot, so dismiss it before capture.
 * Best-effort: if no drawer rendered, the close button never appears and we just move on. Falls
 * back to pressing Escape if the close button can't be clicked.
 */
async function dismissLoginDrawer(page: Page, ctxLog: PlaywrightCrawlingContext['log']): Promise<void> {
    const closeButton = page.locator('.cosmos-drawer-close, .dialog-close-icon').first();
    try {
        await closeButton.waitFor({ state: 'visible', timeout: 5_000 });
        await closeButton.click({ timeout: 5_000 });
        await page.waitForTimeout(500);
        ctxLog.info('Closed login drawer popup.');
    } catch {
        // No drawer (or it ignored the click) — try Escape, then carry on regardless.
        await page.keyboard.press('Escape').catch(() => undefined);
    }
}

async function buildSellerCrawler(): Promise<PlaywrightCrawler> {
    const apiKey = input.twoCaptchaApiKey || process.env.TWOCAPTCHA_API_KEY || undefined;
    const localeCookieValue = `site=glo&c_tp=${CURRENCY}&region=${PROXY_COUNTRY}&b_locale=${LANGUAGE}&ae_u_p_s=2`;
    if (!apiKey) log.warning('No 2captcha API key — captcha pages cannot be solved.');

    return new PlaywrightCrawler({
        // NO proxyConfiguration — real IP on purpose
        navigationTimeoutSecs: 90,
        requestHandlerTimeoutSecs: 360, // a 2captcha solve can take 1-3 min
        maxConcurrency: 1,
        maxRequestsPerCrawl: startUrls.length * SELLER_MAX_ATTEMPTS_PER_URL,
        maxRequestRetries: SELLER_MAX_ATTEMPTS_PER_URL - 1,
        browserPoolOptions: { useFingerprints: false }, // NO fingerprint
        launchContext: {
            useChrome: true,
            launchOptions: {
                headless: HEADLESS,
                slowMo: HEADLESS ? 0 : 250,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--start-maximized',
                ],
            },
        },
        preNavigationHooks: [
            async ({ page }) => {
                await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
                await page.context().addCookies([
                    { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.com', path: '/' },
                    { name: 'intl_locale', value: LANGUAGE, domain: '.aliexpress.com', path: '/' },
                ]);
                await page.addInitScript(() => {
                    /* eslint-disable no-underscore-dangle */
                    const w = window as unknown as { __name?: (fn: unknown) => unknown };
                    w.__name = w.__name || ((fn: unknown) => fn);
                    /* eslint-enable no-underscore-dangle */
                });
            },
        ],
        postNavigationHooks: [errorResponseHook],
        failedRequestHandler: pushFailure,
        requestHandler: async (ctx) => {
            const { page, request, log: ctxLog } = ctx;
            await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);

            // Detect → solve → reload (no captcha = no reload, capture right away). See passCaptcha.
            const stillBlocked = await passCaptcha(page, apiKey, ctxLog, 'store');
            if (stillBlocked) {
                ctxLog.warning('Store page still behind a captcha — capturing whatever rendered.', {
                    url: request.url,
                });
            }

            // Dismiss the login/register drawer that AliExpress overlays on store pages so it
            // doesn't cover the screenshot.
            await dismissLoginDrawer(page, ctxLog);

            // No extra readiness gate here: store anchors use `data-href` and the header class is
            // build-hashed, so a selector wait would just hang to its timeout. The page is already
            // loaded (domcontentloaded), and captureAndSave's lazy-load scroll + waitMs handle the
            // final render settle — so we go straight to capture.
            await captureAndSave(page, request.url, captureOptions, ctxLog);
        },
    });
}

// --- Run -----------------------------------------------------------------------------------------

if (startUrls.length === 0) {
    log.warning('No startUrls provided — nothing to capture.');
} else {
    log.info(`Starting AliExpress screenshot Actor in "${mode}" mode.`, { urls: startUrls.length });
    const crawler = mode === 'seller' ? await buildSellerCrawler() : await buildProductCrawler();
    await crawler.run(startUrls);

    // How aggressively AliExpress blocked us, broken down by reason. 0 across the board means every
    // URL passed the token gate and rendered on the first attempt.
    if (mode === 'product') {
        const totalBlockRetries = Object.values(rotationStats).reduce((sum, n) => sum + n, 0);
        log.info(`Block rotations: ${totalBlockRetries}`, { byReason: rotationStats });
    }
}

await Actor.exit();
