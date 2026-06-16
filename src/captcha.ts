import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from './logger.js';

const IN_URL = 'https://2captcha.com/in.php';
const RES_URL = 'https://2captcha.com/res.php';

const FIRST_POLL_DELAY_MS = 15_000;
const POLL_INTERVAL_MS = 5_000;
const SOLVE_TIMEOUT_MS = 300_000;

/**
 * Parse a 2captcha response that may arrive either as JSON (`{ status, request }`,
 * used when `json=1`) or as legacy plaintext (`OK|<token>`, `CAPCHA_NOT_READY`, `ERROR_*`).
 */
function parseResponse(raw: string): { ok: boolean; data: string } {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
        try {
            const json = JSON.parse(trimmed) as { status?: number; request?: string };
            return { ok: json.status === 1, data: json.request ?? '' };
        } catch {
            /* fall through to plaintext parsing */
        }
    }
    if (trimmed.startsWith('OK|')) return { ok: true, data: trimmed.slice(3) };
    return { ok: false, data: trimmed };
}

/**
 * Solve a reCAPTCHA v2 challenge through the classic 2captcha in.php/res.php flow over
 * global `fetch`. Returns the g-recaptcha-response token, or null on failure/timeout.
 */
export async function solveRecaptchaV2(
    sitekey: string,
    pageUrl: string,
    apiKey: string,
    log: Logger,
): Promise<string | null> {
    // 1. Submit the captcha task.
    const inParams = new URLSearchParams({
        key: apiKey,
        method: 'userrecaptcha',
        googlekey: sitekey,
        pageurl: pageUrl,
        json: '1',
    });

    let captchaId: string;
    try {
        const res = await fetch(`${IN_URL}?${inParams.toString()}`);
        const parsed = parseResponse(await res.text());
        if (!parsed.ok) {
            log.warning('2captcha rejected the task submission.', { response: parsed.data });
            return null;
        }
        captchaId = parsed.data;
        log.info(`📨 2captcha accepted the task (id=${captchaId}); polling for the solution...`);
    } catch (e) {
        log.warning('2captcha submission request failed.', { error: String(e) });
        return null;
    }

    // 2. Poll res.php until solved or timed out. 2captcha asks clients to wait ~15s before the
    //    first poll, then poll every ~5s — logging elapsed time on each poll so a long solve is
    //    visibly progressing rather than looking hung.
    const startedAt = Date.now();
    const deadline = startedAt + SOLVE_TIMEOUT_MS;
    await sleep(FIRST_POLL_DELAY_MS);
    const resParams = new URLSearchParams({ key: apiKey, action: 'get', id: captchaId, json: '1' });

    let attempt = 0;
    while (Date.now() < deadline) {
        attempt += 1;
        try {
            const res = await fetch(`${RES_URL}?${resParams.toString()}`);
            const parsed = parseResponse(await res.text());
            if (parsed.ok) {
                const waited = Math.round((Date.now() - startedAt) / 1000);
                log.info(`✅ 2captcha solved the captcha (id=${captchaId}) after ${attempt} poll(s), ~${waited}s.`);
                return parsed.data;
            }
            if (parsed.data !== 'CAPCHA_NOT_READY') {
                log.warning('2captcha returned an error while polling.', { response: parsed.data });
                return null;
            }
        } catch (e) {
            log.warning('2captcha polling request failed; will retry.', { error: String(e) });
        }
        const waited = Math.round((Date.now() - startedAt) / 1000);
        log.info(`⏳ 2captcha still working (poll #${attempt}, waited ~${waited}s)...`);
        await sleep(POLL_INTERVAL_MS);
    }

    log.warning('2captcha solve timed out.', { captchaId });
    return null;
}
