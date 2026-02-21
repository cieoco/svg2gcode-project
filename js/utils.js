/**
 * Minimal Utility Mock for SVG to G-Code App
 * Re-implementing the bare minimum required by generator.js
 */

export function fmt(n) {
    return Number.isFinite(n) ? (Math.round(n * 1000) / 1000).toString() : "NaN";
}
