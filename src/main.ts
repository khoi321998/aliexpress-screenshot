/**
 * AliExpress screenshot Actor.
 *
 * Captures a full screenshot of an AliExpress product (`/item/`) or seller (`/store/`) page and
 * stores it as a signed key-value-store PNG/JPEG. Output per request: `{ url, screenshotUrl }`.
 *
 * Two browser modes (see `mode` input):
 *  - `product`: US residential proxy + fingerprint injector. AVOIDANCE + ROTATION only — a
 *    captcha/punish/blocked/empty page burns the session, so we retire it and throw, letting
 *    Crawlee retry on a fresh sticky IP + fresh fingerprint. NEVER solves captchas here.
 *  - `seller`: real local/container IP, no proxy, no fingerprint. Solves captchas in place via
 *    2captcha and reloads — does NOT rotate.
 *
 * ESM project — relative imports must use the `.js` extension even from `.ts` sources.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { PlaywrightCrawler, type PlaywrightCrawlingContext } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import type { Page } from 'playwright';

import { classifyPage, TITLE_SELECTORS } from './detection.js';
import { logEgressIp } from './ip.js';
import { captureAndSave, type CaptureOptions } from './screenshot.js';
import { passCaptcha } from './sellerCaptcha.js';

interface Input {
    startUrls?: { url: string }[];
    mode?: 'product' | 'seller';
    format?: 'png' | 'jpeg';
    fullPage?: boolean;
    viewportWidth?: number;
    viewportHeight?: number;
    twoCaptchaApiKey?: string;
}

// --- Hard-coded operational config (intentionally NOT exposed as input) --------------------------
// These are fixed in code rather than passed via input. To change one, edit it here.
const PROXY_COUNTRY = 'US';
const CURRENCY = 'USD';
const LANGUAGE = 'en_US';
const MAX_CONCURRENCY = 2;
const MAX_REQUESTS_PER_CRAWL = 10;
const MAX_REQUEST_RETRIES = 5;
const HEADLESS = true;
const WAIT_MS = 3_000;

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

const startUrls = (input.startUrls ?? [])
    .map((entry) => entry.url)
    .filter(Boolean)
    .map((url) => {
        const clean = normalizeUrl(url);
        if (clean !== url) log.info('Stripped tracking params from URL.', { from: url, to: clean });
        return clean;
    });
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

/** Retire the session (→ fresh sticky IP + fresh fingerprint on retry) and throw so Crawlee retries. */
function rotateAndRetry(ctx: PlaywrightCrawlingContext, reason: string): never {
    ctx.log.warning('Block detected — rotating session/IP/fingerprint and retrying.', {
        reason,
        url: ctx.request.url,
        sessionId: ctx.session?.id,
        retryCount: ctx.request.retryCount,
    });
    ctx.session?.retire();
    throw new Error(`Anti-bot block (${reason}); rotating to a fresh session/proxy.`);
}

async function buildProductCrawler(): Promise<PlaywrightCrawler> {
    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: PROXY_COUNTRY,
    }); // do NOT pass checkAccess — local runs without proxy access must still run.

    return new PlaywrightCrawler({
        proxyConfiguration,
        navigationTimeoutSecs: 45,
        requestHandlerTimeoutSecs: 120,
        minConcurrency: 1,
        maxConcurrency: MAX_CONCURRENCY,
        maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL,
        maxRequestRetries: MAX_REQUEST_RETRIES,
        useSessionPool: true,
        persistCookiesPerSession: true,
        retryOnBlocked: false,
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
                // eslint-disable-next-line no-param-reassign
                if (gotoOptions) gotoOptions.waitUntil = 'domcontentloaded';
                await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
                await applyRegionOverrides(page);
                await applyStealthInitScript(page);
            },
        ],
        postNavigationHooks: [errorResponseHook],
        failedRequestHandler: pushFailure,
        requestHandler: async (ctx) => {
            const { page, request, log: ctxLog } = ctx;

            // 1. Classify on arrival. captcha/punish/blocked → burned session → rotate (never solve).
            let status = await classifyPage(page);
            if (status === 'captcha' || status === 'punish' || status === 'blocked') rotateAndRetry(ctx, status);

            // 2. Wait for real product markup + a short hydration settle (never networkidle).
            await page.waitForSelector(TITLE_SELECTORS.join(', '), { timeout: 30_000 }).catch(() => undefined);
            await page.waitForTimeout(1_500 + Math.random() * 1_500);

            // 3. A late challenge can appear AFTER hydration — re-classify once before trusting the page.
            //    `empty` after a full load is a soft block; rotate it like a hard one.
            status = await classifyPage(page);
            if (status !== 'ok') rotateAndRetry(ctx, status);

            await logEgressIp(page, ctxLog, 'product'); // expect a proxy IP here

            // 4. Lazy-load scroll (if fullPage) → waitMs → screenshot → KV save → pushData.
            await captureAndSave(page, request.url, captureOptions, ctxLog);
        },
    });
}

// =================================================================================================
// SELLER MODE — real IP, no fingerprint, solve captcha via 2captcha (never rotate)
// =================================================================================================

async function buildSellerCrawler(): Promise<PlaywrightCrawler> {
    const apiKey = input.twoCaptchaApiKey || process.env.TWOCAPTCHA_API_KEY || undefined;
    const localeCookieValue = `site=glo&c_tp=${CURRENCY}&region=${PROXY_COUNTRY}&b_locale=${LANGUAGE}&ae_u_p_s=2`;
    if (!apiKey) log.warning('No 2captcha API key — captcha pages cannot be solved.');

    return new PlaywrightCrawler({
        // NO proxyConfiguration — real IP on purpose
        navigationTimeoutSecs: 90,
        requestHandlerTimeoutSecs: 360, // a 2captcha solve can take 1-3 min
        maxConcurrency: 1,
        maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL,
        maxRequestRetries: MAX_REQUEST_RETRIES,
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
}

await Actor.exit();
