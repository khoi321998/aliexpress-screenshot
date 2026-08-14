/**
 * Per-page subresource blocking, toggleable at runtime.
 *
 * The product flow navigates twice: a CHEAP bootstrap pass (whose only job is to warm the anti-bot
 * cookies + the `_m_h5_tk` MTOP token) and, once the token proves valid, a FULL render pass we
 * actually screenshot. Images/fonts/CSS/media are pure waste on the first pass — they saturate the
 * proxy and add seconds to every attempt, and attempts are exactly what we want to be cheap because
 * a block means we throw the whole session away.
 *
 * A single route handler installed before navigation reads a mutable per-page flag, so
 * {@link allowAssets} flips blocking off for the render pass without `unroute()` racing an in-flight
 * request.
 */
import type { Page } from 'playwright';

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

/** Pages that have graduated to the full render pass (assets allowed again). */
const assetsAllowed = new WeakSet<Page>();

/** Install the route handler. Call before navigation; blocking starts ON. */
export async function armAssetBlocking(page: Page): Promise<void> {
    await page.route('**/*', async (route) => {
        if (!assetsAllowed.has(page) && BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
            await route.abort().catch(() => undefined);
            return;
        }
        await route.continue().catch(() => undefined);
    });
}

/** Let images/fonts/CSS/media through from now on (i.e. for the render pass we screenshot). */
export function allowAssets(page: Page): void {
    assetsAllowed.add(page);
}
