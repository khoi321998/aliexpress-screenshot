import type { Page } from 'playwright';

import type { Logger } from './logger.js';

export async function logEgressIp(page: Page, log: Logger, label: string): Promise<void> {
    try {
        const res = await page.context().request.get('https://api.ipify.org?format=json', { timeout: 15_000 });
        const body = (await res.json()) as { ip?: string };
        log.info(`🌍 egress IP (${label})`, { ip: body.ip ?? null });
    } catch (e) {
        log.warning(`Could not determine egress IP (${label})`, { error: String(e) });
    }
}
