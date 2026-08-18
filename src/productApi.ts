// MTOP token acquisition + product-availability probe — ported verbatim in mechanism from
// AliExpressDataScraper (`src/productApi.ts`), trimmed to what a screenshot Actor needs.
//
// WHY a screenshot Actor cares about an API token:
//
// The AliExpress PC product page is a client-side React app — the HTML ships almost no data and
// every product field arrives in ONE signed XHR to the MTOP endpoint `mtop.aliexpress.pdp.pc.query`.
// That call is also the single cleanest health check for a session: if it returns a populated
// `data.result`, the IP/fingerprint is trusted and a full page render WILL succeed. If it comes back
// empty / `FAIL_SYS_USER_VALIDATE` / non-JSON, the session is burned.
//
// Probing it costs ~1-3s (one signed HTTP request through the page's request context) versus the
// 30-45s of rendering a page, racing selectors and waiting out a hydration settle only to find a
// slider captcha at the end. That difference is the whole point: block detection becomes cheap, so
// rotate-and-retry is fast. Only after the token proves valid do we reload the page for real and
// screenshot it.
//
// Signing (Alibaba MTOP H5): `sign = MD5(token & t & appKey & data)`, where `token` is the part of
// the `_m_h5_tk` cookie before `_`. A tokenless session's first call returns `FAIL_SYS_TOKEN_EMPTY`
// but SETS that cookie — so we re-read it and retry immediately. That retry loop is the "token
// dance"; it is why the first call looks like a failure and the second one succeeds within
// milliseconds. We never replicate the signing scheme's secrets — the appKey is public and the
// token comes from the browser's own cookie jar.
import { createHash, randomBytes } from 'node:crypto';

import type { Page } from 'playwright';

import type { Logger } from './logger.js';
import { storefrontHost } from './url.js';

/** The MTOP API that returns the full PC product payload. */
const PDP_QUERY_RE = /mtop\.aliexpress\.pdp\.pc\.query/i;
const PDP_API = 'mtop.aliexpress.pdp.pc.query';
/** Per-API H5 appKey used by the PC product endpoint. */
const PDP_APP_KEY = '12574478';

/** Which MTOP gateway (and the site identity that goes with it) a given ship-to must be asked on. */
interface Gateway {
    /** MTOP H5 endpoint base. */
    acsBase: string;
    /** Site origin the signed call claims to come from (referer/origin headers). */
    origin: string;
    /** `ext.site` in the pdp payload — AliExpress's own name for the storefront. */
    site: string;
    /** `ext.host` in the pdp payload. */
    host: string;
}

/**
 * Pick the gateway for a ship-to country.
 *
 * aliexpress.us is a legally separate US storefront with its own catalogue, and `acs.aliexpress.us`
 * only answers for it — asking it about a listing that is only on the global site is exactly the
 * "403 from Spain" symptom. So US keeps the `.us` gateway it has always used (that path works and we
 * don't want to disturb it), and every other ship-to goes to the global `.com` gateway, which is the
 * only one that serves non-US regions.
 */
function gatewayFor(shipToCountry: string): Gateway {
    if (shipToCountry.toUpperCase() === 'US') {
        return { acsBase: 'https://acs.aliexpress.us/h5', origin: 'https://www.aliexpress.us', site: 'usa', host: 'www.aliexpress.us' };
    }
    // Claim the same storefront the crawler actually navigated to (`es.aliexpress.com`, ...), so the
    // referer and `ext.host` match the page the signed call is supposed to be coming from.
    const host = storefrontHost(shipToCountry);
    return { acsBase: 'https://acs.aliexpress.com/h5', origin: `https://${host}`, site: 'glo', host };
}

/** Per-page holder for the intercepted pdp.pc.query JSON, resolved by the response listener. */
interface PdpWaiter {
    promise: Promise<Record<string, unknown> | null>;
    settle: (value: Record<string, unknown> | null) => void;
    settled: boolean;
}
const pdpWaiters = new WeakMap<Page, PdpWaiter>();

/** Narrow an unknown to a plain object; non-objects become `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Arm the pdp.pc.query interceptor on a page BEFORE navigation. The first "full" response (the
 * token-empty retry returns a tiny error body, so we wait for a sizable one) is parsed and resolves
 * {@link waitForPdpResult}. Idempotent per page.
 */
export function armPdpInterceptor(page: Page): void {
    if (pdpWaiters.has(page)) {
        return;
    }
    let settle!: (value: Record<string, unknown> | null) => void;
    const promise = new Promise<Record<string, unknown> | null>((resolve) => {
        settle = resolve;
    });
    const waiter: PdpWaiter = { promise, settle, settled: false };
    pdpWaiters.set(page, waiter);

    page.on('response', async (res) => {
        if (waiter.settled || !PDP_QUERY_RE.test(res.url())) {
            return;
        }
        let body: string;
        try {
            body = await res.text();
        } catch {
            return;
        }
        // The token-empty bootstrap reply is a few hundred bytes; the real payload is tens of KB.
        if (body.length < 5_000) {
            return;
        }
        try {
            const json = JSON.parse(body.replace(/^\s*\w+\(/, '').replace(/\)\s*;?\s*$/, ''));
            const result = asRecord(asRecord(asRecord(json).data).result);
            if (Object.keys(result).length > 0) {
                waiter.settled = true;
                waiter.settle(result);
            }
        } catch {
            // Malformed/partial — ignore and wait for a cleaner one.
        }
    });
}

/**
 * Await the intercepted pdp.pc.query `result` object, or `null` if it doesn't arrive within
 * `timeoutMs` (treated as a block by the caller, which then rotates). Returns `null` if the
 * interceptor was never armed for this page.
 */
export async function waitForPdpResult(page: Page, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const waiter = pdpWaiters.get(page);
    if (!waiter) {
        return null;
    }
    let timer: NodeJS.Timeout;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([waiter.promise, timeout]);
    clearTimeout(timer!);
    return result;
}

function md5(input: string): string {
    return createHash('md5').update(input).digest('hex');
}

/** Read the MTOP token (part of `_m_h5_tk` before the `_`) from the gateway's cookie jar. */
async function readMtopToken(page: Page, acsBase: string): Promise<string> {
    const cookies = await page.context().cookies(acsBase).catch(() => []);
    const tk = cookies.find((c) => c.name === '_m_h5_tk');
    return tk ? tk.value.split('_')[0] : '';
}

/**
 * Build the `data` payload the PC page sends for pdp.pc.query (locale/region inline, not cookie).
 *
 * `country` is the ship-to and it decides whether the listing resolves at all: a seller who does not
 * ship to the requested country answers with an empty `result`, which the caller cannot distinguish
 * from an anti-bot block. It must agree with the `region` in the page's `aep_usuc_f` cookie.
 */
function buildPdpData(productId: string | number, shipToCountry: string, gateway: Gateway): string {
    const ext = JSON.stringify({
        foreverRandomToken: randomBytes(16).toString('hex'),
        site: gateway.site,
        crawler: false,
        'x-m-biz-bx-region': '',
        signedIn: false,
        host: gateway.host,
    });
    return JSON.stringify({
        productId: String(productId),
        _lang: 'en_US',
        _currency: 'USD',
        country: shipToCountry,
        province: '',
        city: '',
        channel: '',
        pdp_ext_f: '',
        pdpNPI: '',
        sourceType: '',
        clientType: 'pc',
        ext,
    });
}

/**
 * Sign + fire ONE MTOP H5 call through the page's request context, with the token dance.
 *
 * `data` is the EXACT JSON string that is both signed and sent. The `TOKEN_EMPTY`/`TOKEN_EXPIRED`
 * replies are NOT failures — they hand us a fresh `_m_h5_tk` cookie, so we loop straight back and
 * re-sign with it (this is the "retry immediately" behaviour). Returns the parsed response object,
 * or `null` on a non-JSON body (a block) / transport failure.
 */
async function callMtopRequest(page: Page, api: string, data: string, log: Logger, gateway: Gateway): Promise<Record<string, unknown> | null> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const token = await readMtopToken(page, gateway.acsBase);
        const t = Date.now().toString();
        const sign = md5(`${token}&${t}&${PDP_APP_KEY}&${data}`);
        const params = new URLSearchParams({
            jsv: '2.5.1',
            appKey: PDP_APP_KEY,
            t,
            sign,
            api,
            v: '1.0',
            type: 'originaljsonp',
            dataType: 'jsonp',
            callback: 'mtopjsonp',
            data,
        });
        const url = `${gateway.acsBase}/${api}/1.0/?${params.toString()}`;

        let body: string;
        try {
            const res = await page.request.get(url, {
                timeout: 15_000,
                headers: { referer: `${gateway.origin}/`, origin: gateway.origin },
            });
            body = await res.text();
        } catch (error) {
            log.warning('MTOP request failed — retrying.', { api, attempt, error: error instanceof Error ? error.message : String(error) });
            continue;
        }

        let json: Record<string, unknown>;
        try {
            json = JSON.parse(body.replace(/^\s*\w+\(/, '').replace(/\)\s*;?\s*$/, ''));
        } catch {
            log.warning('MTOP non-JSON body (likely block).', { api, attempt, snippet: body.slice(0, 120) });
            return null;
        }

        const { ret } = json as { ret?: unknown[] };
        const retStr = Array.isArray(ret) && typeof ret[0] === 'string' ? (ret[0] as string) : '';
        // Token not ready: the response just set a fresh `_m_h5_tk` cookie; loop to re-read + re-sign.
        if (/TOKEN_EMPTY|TOKEN_EXPIRED|TOKEN_EXOIRED/i.test(retStr)) {
            continue;
        }
        return json;
    }
    return null;
}

/**
 * Fetch the product modules via `mtop.aliexpress.pdp.pc.query` DIRECTLY. Returns the `data.result`
 * module map, or `null` when blocked (e.g. `FAIL_SYS_USER_VALIDATE`) so the caller rotates to a
 * fresh session.
 */
async function fetchPdpDirect(page: Page, productId: string | number, log: Logger, shipToCountry: string): Promise<Record<string, unknown> | null> {
    const gateway = gatewayFor(shipToCountry);
    const json = await callMtopRequest(page, PDP_API, buildPdpData(productId, shipToCountry, gateway), log, gateway);
    if (!json) {
        return null;
    }
    const result = asRecord(asRecord(json.data).result);
    if (Object.keys(result).length > 0) {
        return result;
    }
    const { ret } = json as { ret?: unknown[] };
    // An empty result here is ambiguous: an anti-bot block OR a listing the seller simply won't ship
    // to `shipToCountry`. Log the region so the second case is diagnosable from the run log.
    log.warning('pdp.pc.query — no result (block or unavailable for ship-to).', {
        ret: Array.isArray(ret) ? String(ret[0]) : null,
        shipToCountry,
    });
    return null;
}

/** Title — PRODUCT_TITLE.text. Its presence is what makes a `result` payload trustworthy. */
function parseTitle(result: Record<string, unknown>): string | null {
    const t = asRecord(result.PRODUCT_TITLE).text;
    return typeof t === 'string' && t.trim() !== '' ? t.trim() : null;
}

/** Outcome of the token/session probe. */
export interface TokenProbe {
    /** True ⇒ the session is trusted; the page can be rendered and screenshotted. */
    ok: boolean;
    /** Block reason for the rotation tally when `ok` is false. */
    reason?: string;
    /** The product title from the API — handy as a log breadcrumb before the render pass. */
    title?: string;
}

/**
 * Probe the session by acquiring the MTOP token and fetching the product payload with it.
 *
 * Two chances, both cheap: the signed direct call first, then the page's OWN intercepted
 * pdp.pc.query response (the bootstrap navigation fires it anyway, so it may already be in hand).
 * Anything else is a burned session — the caller rotates instead of rendering a page that would
 * only show a captcha.
 */
export async function probeProductToken(page: Page, productId: string, log: Logger, shipToCountry = 'US'): Promise<TokenProbe> {
    let result = await fetchPdpDirect(page, productId, log, shipToCountry);
    if (!result) {
        result = await waitForPdpResult(page, 8_000);
        if (result) {
            log.info('pdp.pc.query recovered from the page interceptor.', { productId });
        }
    }
    if (!result) {
        return { ok: false, reason: 'pdp-blocked' };
    }

    const title = parseTitle(result);
    if (!title) {
        log.warning('pdp.pc.query JSON had no title — treating as blocked.', { productId });
        return { ok: false, reason: 'empty-product' };
    }
    return { ok: true, title };
}
