import { describe, expect, it } from 'vitest';

import { buildKey } from '../src/screenshot.js';

describe('buildKey', () => {
    const SAMPLE = 'https://www.aliexpress.com/item/1005006789012345.html?spm=a2g0o.detail';

    it('prefixes keys with "screenshot_"', () => {
        expect(buildKey(SAMPLE).startsWith('screenshot_')).toBe(true);
    });

    it('produces only key-value-store-safe characters', () => {
        expect(buildKey(SAMPLE)).toMatch(/^[a-zA-Z0-9!\-_.'()]+$/);
    });

    it('stays within the 256-character key limit', () => {
        const longUrl = `https://www.aliexpress.com/item/${'1'.repeat(400)}.html`;
        const key = buildKey(longUrl);
        expect(key.length).toBeLessThanOrEqual(256);
        expect(key.startsWith('screenshot_')).toBe(true);
    });

    it('is deterministic for the same URL and distinct across URLs', () => {
        expect(buildKey(SAMPLE)).toBe(buildKey(SAMPLE));
        expect(buildKey(SAMPLE)).not.toBe(buildKey(`${SAMPLE}&x=1`));
    });
});
