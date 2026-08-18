/**
 * Per-country session identity (ported from AliExpressDataScraper's `stealth.ts` / `config.ts`).
 *
 * Product mode presents ONE coherent story per request: the storefront subdomain, the proxy exit
 * country, the browser timezone, the `aep_usuc_f` region cookie and the `country` field of the
 * signed MTOP payload all name the same market. A US IP asking for Spanish delivery is a
 * contradiction no real buyer produces, and AliExpress answers it with captchas — so instead of one
 * fixed country, each request runs entirely inside its own.
 *
 * Only the TIMEZONE varies with the country here. The fingerprint locale stays `en-US` everywhere:
 * we deliberately read AliExpress in English, and an English-language browser is unremarkable in any
 * market — whereas `America/New_York` reported from a Madrid IP is not.
 */

/** Ship-to used when a URL carries no regional signal and no override is set. */
export const DEFAULT_SHIP_TO_COUNTRY = 'US';

/** Locale presented everywhere (fingerprint + CDP override). Deliberately country-independent. */
export const LOCALE = 'en-US';

/** Fallback timezone for a country outside {@link COUNTRY_TIMEZONES}. */
export const DEFAULT_TIMEZONE_ID = 'America/New_York';

/**
 * Countries the Apify DATACENTER pool actually holds IPs in. The account's datacenter groups are
 * US-only; asking proxy.apify.com for any other country returns 407 "Selected proxy groups have no
 * usable proxies from country '<XX>'", which surfaces in the browser as
 * ERR_TUNNEL_CONNECTION_FAILED. Everything outside this list therefore has to go RESIDENTIAL.
 */
export const DATACENTER_COUNTRIES = ['US'];

/**
 * Ship-to / proxy country → the timezone a real desktop there would report. Covers every country
 * `detectShipToCountry` can produce; anything else (only reachable via the manual `shipToCountry`
 * input) falls back to {@link DEFAULT_TIMEZONE_ID}.
 */
const COUNTRY_TIMEZONES: Record<string, string> = {
    US: 'America/New_York',
    ES: 'Europe/Madrid',
    FR: 'Europe/Paris',
    DE: 'Europe/Berlin',
    IT: 'Europe/Rome',
    NL: 'Europe/Amsterdam',
    PL: 'Europe/Warsaw',
    PT: 'Europe/Lisbon',
    GB: 'Europe/London',
    BR: 'America/Sao_Paulo',
    MX: 'America/Mexico_City',
    CL: 'America/Santiago',
    CA: 'America/Toronto',
    RU: 'Europe/Moscow',
    TR: 'Europe/Istanbul',
    KR: 'Asia/Seoul',
    JP: 'Asia/Tokyo',
    VN: 'Asia/Ho_Chi_Minh',
    TH: 'Asia/Bangkok',
    ID: 'Asia/Jakarta',
    IL: 'Asia/Jerusalem',
    SA: 'Asia/Riyadh',
    AE: 'Asia/Dubai',
    AU: 'Australia/Sydney',
};

/** The timezone to present for a given proxy/ship-to country. */
export function timezoneForCountry(country: string): string {
    return COUNTRY_TIMEZONES[country.toUpperCase()] ?? DEFAULT_TIMEZONE_ID;
}

/**
 * Which Apify proxy groups to request for a given exit country. `[]` means the automatic datacenter
 * pool (what US has always used here — far lower latency, and the token gate makes a burned session
 * cheap to detect and rotate away from).
 *
 * Residential is not merely "better" outside the US — it is the only thing that works, because the
 * datacenter pool holds US addresses only. `residentialEverywhere` forces it for US too, for runs
 * that would rather pay for a cleaner IP than rotate.
 */
export function proxyGroupsFor(country: string, residentialEverywhere = false): string[] {
    if (residentialEverywhere) {
        return ['RESIDENTIAL'];
    }
    return DATACENTER_COUNTRIES.includes(country.toUpperCase()) ? [] : ['RESIDENTIAL'];
}
