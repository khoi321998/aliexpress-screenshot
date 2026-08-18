/**
 * AliExpress URL helpers (ported from AliExpressDataScraper).
 *
 * Product URLs are rebuilt into the canonical form for a given SHIP-TO country:
 *
 *     https://<storefront>.aliexpress.com/item/<itemId>.html
 *
 * The query string is always dropped (`spm`, `algo_pvid`, `gatewayAdapt` … are tracking/redirect
 * noise), but the locale subdomain is NOT collapsed to `www`: it is a region signal, and every other
 * region signal we present — the proxy exit IP, the browser timezone, the `aep_usuc_f` cookie — has
 * to name the SAME country as the storefront we ask. Splitting them (a `region=ES` cookie over a US
 * IP on `www.`) is the contradiction AliExpress answers with a wall of captchas.
 */

/**
 * Ship-to country → the storefront subdomain AliExpress serves that market on. Countries without a
 * dedicated localized host (GB, AU, CA, MX, ...) fall through to `www`, which is what a buyer there
 * actually browses.
 */
const COUNTRY_TO_SUBDOMAIN: Record<string, string> = {
    US: 'www',
    ES: 'es',
    FR: 'fr',
    DE: 'de',
    IT: 'it',
    NL: 'nl',
    PL: 'pl',
    PT: 'pt',
    BR: 'pt',
    RU: 'ru',
    TR: 'tr',
    KR: 'ko',
    JP: 'ja',
    VN: 'vi',
    TH: 'th',
    ID: 'id',
    IL: 'he',
    SA: 'ar',
    AE: 'ar',
};

/** The storefront host for a ship-to country, e.g. `ES` → `es.aliexpress.com`. */
export function storefrontHost(country?: string): string {
    const sub = country ? (COUNTRY_TO_SUBDOMAIN[country.toUpperCase()] ?? 'www') : 'www';
    return `${sub}.aliexpress.com`;
}

/**
 * Canonicalize any AliExpress product URL for a ship-to country, or `null` if it isn't a
 * recognizable `/item/` URL.
 *
 * The HOST is rebuilt from `country` rather than reused from whatever the user pasted, so a stale or
 * mistyped subdomain can never disagree with the region we crawl under. Omitting `country` keeps the
 * historical `www` behavior.
 *
 * Examples:
 *   ('https://es.aliexpress.com/item/1005010204377877.html?gatewayAdapt=glo2esp', 'ES')
 *       -> https://es.aliexpress.com/item/1005010204377877.html
 *   ('https://m.aliexpress.com/item/1005009982221130.html', 'VN')
 *       -> https://vi.aliexpress.com/item/1005009982221130.html
 */
export function normalizeAliExpressUrl(raw: string, country?: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return null;
    }

    // Accept any AliExpress host/subdomain on the .com or .us TLD.
    if (!/(^|\.)aliexpress\.(com|us)$/i.test(parsed.hostname)) {
        return null;
    }

    // The product id is the run of digits in `/item/<id>.html` (the `.html` is optional).
    const match = parsed.pathname.match(/\/item\/(\d+)(?:\.html)?/i);
    if (!match) {
        return null;
    }

    return `https://${storefrontHost(country)}/item/${match[1]}.html`;
}

/**
 * ISO-3166 alpha-3 (as AliExpress writes it in `gatewayAdapt=glo2<iso3>`) → alpha-2, for the
 * markets AliExpress runs a localized gateway for. Anything not listed falls through to the
 * subdomain heuristic below.
 */
const GATEWAY_ISO3_TO_ISO2: Record<string, string> = {
    usa: 'US',
    esp: 'ES',
    fra: 'FR',
    deu: 'DE',
    ita: 'IT',
    nld: 'NL',
    pol: 'PL',
    prt: 'PT',
    bra: 'BR',
    rus: 'RU',
    tur: 'TR',
    kor: 'KR',
    jpn: 'JP',
    vnm: 'VN',
    tha: 'TH',
    idn: 'ID',
    isr: 'IL',
    sau: 'SA',
    are: 'AE',
    gbr: 'GB',
    aus: 'AU',
    can: 'CA',
    mex: 'MX',
    chl: 'CL',
};

/**
 * Locale subdomain → the country AliExpress ships to on that storefront. Only unambiguous
 * language↔market pairs are listed; `www`, `m`, `best`, ... deliberately map to nothing so the
 * caller falls back to the configured default.
 *
 * `pt` → BR because AliExpress's Portuguese storefront targets Brazil, not Portugal (a Portuguese
 * buyer lands on `pt.aliexpress.com` with `gatewayAdapt=glo2prt`, which the ISO-3 map catches first).
 */
const SUBDOMAIN_TO_COUNTRY: Record<string, string> = {
    us: 'US',
    es: 'ES',
    fr: 'FR',
    de: 'DE',
    it: 'IT',
    nl: 'NL',
    pl: 'PL',
    pt: 'BR',
    ru: 'RU',
    tr: 'TR',
    ko: 'KR',
    ja: 'JP',
    vi: 'VN',
    th: 'TH',
    id: 'ID',
    he: 'IL',
    ar: 'SA',
};

/**
 * Work out which country the user was shopping from when they copied this URL, so we pin the SAME
 * ship-to region on our own session (proxy exit, timezone, `aep_usuc_f` cookie, MTOP payload).
 *
 * Two signals, most explicit first:
 *   1. `?gatewayAdapt=glo2esp` — AliExpress's own redirect stamp, an ISO-3 country code.
 *   2. the locale subdomain (`es.`, `de.`, `vi.`, ...).
 *
 * Returns `null` when the URL carries no regional signal (`www.`/`m.`), leaving the choice to the
 * caller's default.
 *
 * Call this on the RAW url — {@link normalizeAliExpressUrl} strips exactly the signals it reads.
 */
export function detectShipToCountry(raw: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return null;
    }
    if (!/(^|\.)aliexpress\.(com|us)$/i.test(parsed.hostname)) {
        return null;
    }

    // 1. The `glo2<iso3>` redirect stamp — AliExpress telling us outright which market it sent the
    //    user to. Trusted over the subdomain, which can lag behind a manual region switch.
    const gateway = parsed.searchParams.get('gatewayAdapt');
    const iso3 = gateway?.match(/glo2([a-z]{3})/i)?.[1]?.toLowerCase();
    if (iso3 && GATEWAY_ISO3_TO_ISO2[iso3]) {
        return GATEWAY_ISO3_TO_ISO2[iso3];
    }

    // 2. The locale subdomain.
    const sub = parsed.hostname.toLowerCase().split('.')[0];
    return SUBDOMAIN_TO_COUNTRY[sub] ?? null;
}

/**
 * Extract the numeric AliExpress product id from any item URL.
 * Returns `null` if the URL has no recognizable `/item/<id>` segment.
 */
export function extractAliExpressItemId(raw: string): string | null {
    const match = raw.match(/\/item\/(\d+)/i);
    return match ? match[1] : null;
}
