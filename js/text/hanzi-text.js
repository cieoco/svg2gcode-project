/**
 * Chinese single-line text → parts (Route A prototype)
 *
 * Uses the open hanzi-writer-data set, which provides, for each character, the
 * MEDIAN (centre-line) point list of every stroke. Those medians are already
 * single-line skeletons — no outline, no offset, no centreline extraction — so
 * feeding them into the existing on-path pipeline yields single-stroke
 * engraving directly.
 *
 * Coordinate space: hanzi-writer glyphs live on a 1024×1024 em grid and are
 * Y-UP, which matches parseSVG's machine coordinates, so no Y flip is needed.
 * CJK glyphs are fetched on demand from a CDN and persisted to localStorage,
 * so previously used characters load instantly and work offline afterwards.
 * Printable ASCII is drawn from an embedded Hershey font (fully offline).
 */

import { HERSHEY, HERSHEY_CAP_HEIGHT } from './hershey-simplex.js';

const DATA_BASE = 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2/';
const EM = 1024;              // hanzi-writer em-square size
const cache = new Map();      // char -> {strokes, medians} | null (known-missing)
const LATIN_CAP_FRACTION = 0.72;   // Latin cap height relative to the CJK em

// A CJK ideograph we look up in hanzi-writer-data; anything printable ASCII we
// draw from the embedded Hershey font (offline). Everything else is "missing".
function isCjk(ch) {
    const c = ch.codePointAt(0);
    return (c >= 0x3400 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF);
}
function isLatin(ch) {
    const c = ch.codePointAt(0);
    return c >= 0x21 && c <= 0x7E && HERSHEY[c];  // printable ASCII with a glyph
}

/**
 * One point on a centripetal Catmull-Rom spline (Barry-Goldman form).
 * Passes through p1 and p2; p0/p3 are neighbours that shape the curve.
 * Centripetal parameterisation (alpha=0.5) avoids cusps and self-loops.
 */
function catmullRom(p0, p1, p2, p3, t) {
    const alpha = 0.5;
    const tj = (ti, a, b) => Math.pow(Math.hypot(b.x - a.x, b.y - a.y), alpha) + ti;
    const t0 = 0;
    const t1 = tj(t0, p0, p1);
    const t2 = tj(t1, p1, p2);
    const t3 = tj(t2, p2, p3);
    const tt = t1 + (t2 - t1) * t;
    const lerp = (a, b, ta, tb) => {
        if (tb === ta) return { x: a.x, y: a.y };
        const f = (tt - ta) / (tb - ta);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    };
    const A1 = lerp(p0, p1, t0, t1);
    const A2 = lerp(p1, p2, t1, t2);
    const A3 = lerp(p2, p3, t2, t3);
    const B1 = lerp(A1, A2, t0, t2);
    const B2 = lerp(A2, A3, t1, t3);
    return lerp(B1, B2, t1, t2);
}

/**
 * Smooth and densify a sparse median polyline into a continuous curve.
 * hanzi-writer medians carry only a handful of points per stroke (often 3-5),
 * so cutting straight lines between them looks faceted. Resampling a
 * Catmull-Rom spline through them at a fine step yields a smooth stroke.
 * @param {{x:number,y:number}[]} pts median points (in mm)
 * @param {number} stepMm target sample spacing
 */
function smoothStroke(pts, stepMm) {
    if (!Array.isArray(pts) || pts.length < 3) return pts;
    const P = pts;
    const n = P.length;
    const at = (i) => P[Math.max(0, Math.min(n - 1, i))];
    const out = [{ x: P[0].x, y: P[0].y }];
    for (let i = 0; i < n - 1; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const steps = Math.max(1, Math.ceil(segLen / stepMm));
        for (let s = 1; s <= steps; s++) {
            out.push(catmullRom(p0, p1, p2, p3, s / steps));
        }
    }
    return out;
}

// Persistent cache: successfully fetched glyphs are stored (medians only) in
// localStorage, so characters you have used before load instantly and work
// offline on later visits. No repo bloat; the cache is your actual usage.
const LS_PREFIX = 'hzmed:';
function lsGet(char) {
    try {
        const v = localStorage.getItem(LS_PREFIX + char);
        return v == null ? undefined : { medians: JSON.parse(v) };
    } catch (err) { return undefined; }
}
function lsSet(char, data) {
    try { localStorage.setItem(LS_PREFIX + char, JSON.stringify(data.medians)); }
    catch (err) { /* unavailable or over quota — in-memory cache still works */ }
}

/**
 * Fetch one character's stroke data. Returns null for characters that are not
 * in the dataset. Successful results persist to localStorage; a network
 * failure throws and is NOT cached so it can be retried.
 * @param {string} char single character
 * @returns {Promise<{medians:number[][][]}|null>}
 */
async function fetchCharData(char) {
    if (cache.has(char)) return cache.get(char);
    const stored = lsGet(char);
    if (stored) { cache.set(char, stored); return stored; }

    const res = await fetch(DATA_BASE + encodeURIComponent(char) + '.json');
    if (res.status === 404) { cache.set(char, null); return null; }  // not in dataset
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cache.set(char, data);
    lsSet(char, data);
    return data;
}

/**
 * Warm the cache for a set of characters, fetching unique, not-yet-cached ones
 * with a small concurrency pool. Network errors are recorded but do not reject.
 * @returns {Promise<{networkError:boolean}>}
 */
async function prefetch(chars, concurrency = 6) {
    const todo = [...new Set(chars)].filter((c) => !cache.has(c));
    let networkError = false;
    let i = 0;
    async function worker() {
        while (i < todo.length) {
            const c = todo[i++];
            try { await fetchCharData(c); }
            catch (err) { networkError = true; } // leave uncached for retry
        }
    }
    const n = Math.max(1, Math.min(concurrency, todo.length));
    await Promise.all(Array.from({ length: n }, worker));
    return { networkError };
}

/**
 * Build single-line engraving parts from a string of Chinese text.
 * @param {string} text raw input (newlines start a new row)
 * @param {Object} opts
 * @param {number} opts.sizeMm     glyph height in mm (one em)
 * @param {number} opts.charSpacingMm  extra gap between glyphs (mm)
 * @param {number} opts.lineSpacingMm  extra gap between rows (mm)
 * @param {number} opts.engraveDepthMm engraving depth (partial cut, mm)
 * @param {number} opts.maxChars max glyphs to render (guards against pasting a
 *                               huge block and firing hundreds of requests)
 * @returns {Promise<{parts:Array, missing:string[], networkError:boolean, truncated:boolean}>}
 */
export async function buildHanziParts(text, opts = {}) {
    const sizeMm = Number.isFinite(opts.sizeMm) && opts.sizeMm > 0 ? opts.sizeMm : 20;
    const charSpacingMm = Number.isFinite(opts.charSpacingMm) ? opts.charSpacingMm : 2;
    const lineSpacingMm = Number.isFinite(opts.lineSpacingMm) ? opts.lineSpacingMm : sizeMm * 0.3;
    const engraveDepthMm = Number.isFinite(opts.engraveDepthMm) && opts.engraveDepthMm > 0 ? opts.engraveDepthMm : 1;
    const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 200;

    const cjkScale = sizeMm / EM;
    const cjkAdvance = sizeMm + charSpacingMm;
    const latinScale = (LATIN_CAP_FRACTION * sizeMm) / HERSHEY_CAP_HEIGHT;
    const lineStep = sizeMm + lineSpacingMm;
    // Fine but not excessive: scales with glyph size, clamped for tiny/huge text.
    const smoothStepMm = Math.min(0.6, Math.max(0.2, sizeMm / 50));

    const isSpace = (ch) => ch === ' ' || ch === '　' || ch === '\t';

    // Cap the number of visible (non-whitespace) glyphs to bound the workload.
    const allChars = Array.from(text);
    let visibleCount = 0;
    const chars = [];
    let truncated = false;
    for (const ch of allChars) {
        const visible = ch !== '\n' && !isSpace(ch);
        if (visible && visibleCount >= maxChars) { truncated = true; break; }
        if (visible) visibleCount += 1;
        chars.push(ch);
    }

    // Only CJK glyphs need a network lookup; Latin is embedded (offline).
    const { networkError } = await prefetch(chars.filter(isCjk));

    const parts = [];
    const missing = [];
    let penX = 0;
    let penY = 0;
    let idx = 0;

    const pushStroke = (pointsMm, si, ch) => {
        if (pointsMm.length < 2) return;
        parts.push({
            id: `hz_${Date.now()}_${idx}_${si}`,
            barStyle: 'path',
            toolpathMode: 'on-path',
            points: pointsMm,
            isPartial: true,
            partialDepth: engraveDepthMm,
            listOrdered: true,
            hanziChar: ch
        });
    };

    for (const ch of chars) {
        if (ch === '\n') { penX = 0; penY -= lineStep; continue; }
        if (ch === ' ' || ch === '\t') { penX += latinScale * HERSHEY[32].advance + charSpacingMm; continue; }
        if (ch === '　') { penX += cjkAdvance; continue; }

        if (isCjk(ch)) {
            const data = cache.get(ch);
            if (!data || !Array.isArray(data.medians)) { missing.push(ch); penX += cjkAdvance; idx += 1; continue; }
            data.medians.forEach((median, si) => {
                if (!Array.isArray(median) || median.length < 2) return;
                const raw = median.map(([px, py]) => ({ x: penX + px * cjkScale, y: penY + py * cjkScale }));
                pushStroke(smoothStroke(raw, smoothStepMm), si, ch);   // smooth: sparse medians
            });
            penX += cjkAdvance;
        } else if (isLatin(ch)) {
            const g = HERSHEY[ch.codePointAt(0)];
            // Hershey strokes are already clean line segments — do NOT smooth,
            // so letter corners (A's apex, etc.) stay crisp.
            g.strokes.forEach((stroke, si) => {
                pushStroke(stroke.map(([x, y]) => ({ x: penX + x * latinScale, y: penY + y * latinScale })), si, ch);
            });
            penX += latinScale * g.advance + charSpacingMm;
        } else {
            missing.push(ch);
            penX += cjkAdvance;
        }
        idx += 1;
    }

    return { parts, missing, networkError, truncated };
}
