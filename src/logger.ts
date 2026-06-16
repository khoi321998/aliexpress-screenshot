/**
 * Structural logger type. Crawlee's `Log` (and Apify's `log`) satisfy this shape, but typing
 * helpers against the concrete class triggers a CJS/ESM type-identity clash under NodeNext
 * module resolution. Accepting the structural shape sidesteps that entirely.
 */
export interface Logger {
    info(message: string, data?: Record<string, unknown>): void;
    warning(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
}
