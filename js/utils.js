/**
 * Minimal Utility Mock for SVG to G-Code App
 * Re-implementing the bare minimum required by generator.js
 */

export function fmt(n) {
    return Number.isFinite(n) ? (Math.round(n * 1000) / 1000).toString() : "NaN";
}

/**
 * Wrap text as a G-code parenthesis comment that is safe for Mach3.
 * Mach3's parser forbids nested "()" , treats "%" as the program
 * start/end marker, and can choke on non-ASCII characters. We strip those,
 * collapse whitespace, and uppercase to match the emitter convention.
 * GRBL accepts the same output, so this is safe for every dialect.
 * @param {string} text - raw comment body (without the surrounding parens)
 * @returns {string} e.g. "(PART FOO STYLE RECT)"
 */
export function gcomment(text) {
    const cleaned = String(text)
        .replace(/[()]/g, ' ')          // no nested / unbalanced parens
        .replace(/%/g, ' ')             // "%" is a reserved program marker
        .replace(/[^\x20-\x7E]/g, '')   // drop non-ASCII (e.g. Chinese)
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
    return `(${cleaned})`;
}
