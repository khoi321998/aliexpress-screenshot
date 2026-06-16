import type { Page } from 'playwright';

export const TITLE_SELECTORS = [
    'h1[data-pl="product-title"]',
    'h1.product-title-text',
    '.title--wrap--UUHae_g h1',
    'div[class*="title--wrap"] h1',
    'h1[class*="title"]',
];
export const ANTIBOT_URL_MARKERS = ['/punish', '_____tmd_____', 'x5secdata'];
export const RECAPTCHA_SELECTORS = ['iframe[src*="recaptcha"]', '.g-recaptcha[data-sitekey]', '#g-recaptcha-response'];
export const SLIDER_SELECTORS = [
    '.nc-container',
    '#nc_1_n1z',
    '.btn_slide',
    '.nc_wrapper',
    '#baxia-dialog-content',
    '.baxia-dialog',
    '[class*="baxia"]',
    'iframe[src*="x5sec"]',
    'iframe[src*="punish"]',
];
const CLOUDFLARE_SELECTORS = ['#cf-challenge-running', '#challenge-form', 'iframe[src*="challenges.cloudflare.com"]'];

async function anySelectorPresent(page: Page, sels: string[]): Promise<boolean> {
    for (const s of sels) {
        if ((await page.locator(s).count().catch(() => 0)) > 0) return true;
    }
    return false;
}
export function isPunishUrl(url: string): boolean {
    return ANTIBOT_URL_MARKERS.some((m) => url.includes(m));
}
export async function isCaptchaPage(page: Page): Promise<boolean> {
    return (await anySelectorPresent(page, RECAPTCHA_SELECTORS)) || (await anySelectorPresent(page, SLIDER_SELECTORS));
}
export async function isBlockedPage(page: Page): Promise<boolean> {
    if (await anySelectorPresent(page, CLOUDFLARE_SELECTORS)) return true;
    const t = (await page.title().catch(() => '')).toLowerCase();
    return t.includes('access denied') || t.includes('attention required') || t.includes('just a moment');
}
export async function isProductLoaded(page: Page): Promise<boolean> {
    if (!(await anySelectorPresent(page, TITLE_SELECTORS))) return false;
    return (await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0)) > 200;
}
// punish (URL) → captcha (DOM) → blocked (CF) → product check
export type PageStatus = 'ok' | 'captcha' | 'punish' | 'blocked' | 'empty';
export async function classifyPage(page: Page): Promise<PageStatus> {
    if (isPunishUrl(page.url())) return 'punish';
    if (await isCaptchaPage(page)) return 'captcha';
    if (await isBlockedPage(page)) return 'blocked';
    return (await isProductLoaded(page)) ? 'ok' : 'empty';
}
