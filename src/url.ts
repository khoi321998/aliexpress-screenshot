/**
 * AliExpress URL helpers (ported from AliExpressDataScraper).
 *
 * The locale subdomain (`vi.`, `de.`, `m.`, `us.`, …) and the query string are themselves
 * region/tracking signals that conflict with our proxy country, so product URLs are normalized to
 * the neutral canonical form:
 *
 *     https://www.aliexpress.com/item/<itemId>.html
 */

/** Canonicalize any AliExpress product URL, or `null` if it isn't a recognizable `/item/` URL. */
export function normalizeAliExpressUrl(raw: string): string | null {
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

    return `https://www.aliexpress.com/item/${match[1]}.html`;
}

/**
 * Extract the numeric AliExpress product id from any item URL.
 * Returns `null` if the URL has no recognizable `/item/<id>` segment.
 */
export function extractAliExpressItemId(raw: string): string | null {
    const match = raw.match(/\/item\/(\d+)/i);
    return match ? match[1] : null;
}
