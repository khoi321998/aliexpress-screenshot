# AliExpress Screenshot Actor

**Capture pixel-perfect screenshots of any [AliExpress](https://www.aliexpress.com) product or seller page** and get back a permanent, shareable image URL. This Actor renders each page in a real Chromium browser, scrolls it to trigger lazy-loaded images, and stores a full-page **PNG or JPEG** in the Apify key-value store. The result is a structured dataset of `{ url, screenshotUrl }` records you can pull through the **Apify API**, schedule, or wire into your own integrations, monitoring, and proxy rotation.

AliExpress is aggressive about bot detection, so this Actor ships with **two purpose-built browser strategies** you choose with a single `mode` switch.

## Why use the AliExpress Screenshot Actor?

- **Visual archiving & compliance** — keep dated, tamper-evident snapshots of product listings, prices, and seller storefronts.
- **Price & listing monitoring** — pair scheduled runs with the screenshot URLs to track how a listing changes over time.
- **Dispute & QA evidence** — capture exactly what a buyer sees, including images, badges, and promotions.
- **Anti-bot resilience built in** — residential proxy + browser-fingerprint rotation, or in-page captcha solving via 2captcha.
- **Apify platform advantages** — API access, scheduling, storage, monitoring, and proxy rotation, with no infrastructure to manage.

## How to use the AliExpress Screenshot Actor

1. Open the Actor in Apify Console and go to the **Input** tab.
2. Paste one or more AliExpress **product** (`/item/...`) or **seller** (`/store/...`) URLs into **Start URLs**.
3. Pick a **Mode** (see below). Start with **Product** for individual listings.
4. (Optional) Choose **PNG/JPEG**, full-page vs. viewport, viewport size, and extra wait time.
5. Click **Start**. When the run finishes, open the **Output** / **Dataset** tab to view each page's screenshot link.

### Choosing a mode

| Mode | Network | Anti-bot strategy | Best for |
| --- | --- | --- | --- |
| **Product** (default) | US residential proxy | Fingerprint injection; on any block it **rotates** to a fresh IP + fingerprint and retries. Never solves captchas. | `/item/` product pages |
| **Seller** | Real container IP (no proxy) | No fingerprint; on a block it **solves** the captcha in place via 2captcha and reloads. | `/store/` seller pages |

> Seller mode requires a **2captcha API key** (input field or `TWOCAPTCHA_API_KEY` env var) to clear challenges. Without it, blocked seller pages cannot be captured.

## Input

Configure the run from the **Input** tab or via the API. Key fields:

- **startUrls** (required) — AliExpress product/seller URLs to capture.
- **mode** — `product` (proxy + fingerprint rotation) or `seller` (real IP + 2captcha).
- **format** — `png` or `jpeg` (JPEG is saved at quality 85).
- **fullPage** — capture the entire scrollable page (default) or just the viewport.
- **viewportWidth / viewportHeight** — browser viewport size (default 1920×1080).
- **waitMs** — extra settle time before the screenshot (default 3000 ms).
- **proxyCountry** — residential proxy country / locale region (default `US`).
- **maxConcurrency** — parallel pages in product mode (default 2; seller mode is always 1).
- **maxRequestsPerCrawl** — page cap per run (default 10).
- **maxRequestRetries** — retries per page; each product-mode retry rotates IP + fingerprint (default 5).
- **headless** — run the browser headless (default true).
- **twoCaptchaApiKey** — seller mode only; falls back to `TWOCAPTCHA_API_KEY`.
- **currency / language** — seller-mode locale cookie values (default `USD` / `en_US`).

Example input:

```json
{
    "startUrls": [{ "url": "https://www.aliexpress.com/item/1005006344542164.html" }],
    "mode": "product",
    "format": "png",
    "fullPage": true,
    "proxyCountry": "US",
    "maxConcurrency": 2,
    "maxRequestRetries": 5
}
```

## Output

Each captured page produces one dataset record. The `screenshotUrl` is a signed public key-value-store URL with `disableRedirect=true`, so it resolves directly to the image file.

```json
{
    "url": "https://www.aliexpress.com/item/1005006344542164.html",
    "screenshotUrl": "https://api.apify.com/v2/key-value-stores/<storeId>/records/screenshot_..._<md5>?disableRedirect=true"
}
```

Pages that fail after all retries are recorded as:

```json
{
    "url": "https://www.aliexpress.com/item/....html",
    "screenshotUrl": null,
    "error": "Anti-bot block (captcha); rotating to a fresh session/proxy."
}
```

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel.

### Data table

| Field | Type | Description |
| --- | --- | --- |
| `url` | string | The AliExpress page that was requested. |
| `screenshotUrl` | string \| null | Direct link to the stored PNG/JPEG, or `null` on failure. |
| `error` | string | Present only on failed records; the reason capture failed. |

## How much does it cost to screenshot AliExpress?

Cost is driven by compute time and proxy usage:

- **Product mode** uses **Apify Residential proxy**, which is billed per GB on top of compute units. Blocks trigger retries on fresh IPs, so heavily protected pages cost more.
- **Seller mode** uses the **real container IP** (no proxy cost) but may incur **2captcha** charges (billed by 2captcha, not Apify) when challenges appear.

To control spend, lower `maxRequestsPerCrawl`, cap `maxRequestRetries`, and prefer JPEG for smaller stored images. Free-tier Apify accounts include monthly platform credits you can use to trial the Actor.

## Tips & advanced options

- **Use the right mode for the URL.** `/item/` pages → product mode; `/store/` pages → seller mode.
- **Give rotation room.** Product mode relies on retries to find a clean IP — keep `maxRequestRetries` at 5+ for stubborn pages.
- **Speed vs. completeness.** Disable `fullPage` and lower `waitMs` for faster, viewport-only captures.
- **Smaller files.** Choose JPEG (quality 85) when exact color fidelity isn't required.

## FAQ, disclaimers, and support

**Is screenshotting AliExpress legal?** This Actor captures publicly available pages. You are responsible for complying with AliExpress's Terms of Service and applicable laws, and for not capturing personal or sensitive data without permission.

**Why did a page come back with `screenshotUrl: null`?** The page was blocked beyond what the chosen mode could overcome (e.g., no 2captcha key in seller mode, or rotation exhausted in product mode). Try increasing retries, switching modes, or supplying a 2captcha key.

**Known limitations.** AliExpress changes its markup and anti-bot defenses frequently; selectors and detection heuristics may need updates over time.

**Support.** Found a bug or need a custom variant? Open an issue from the Actor's **Issues** tab.
