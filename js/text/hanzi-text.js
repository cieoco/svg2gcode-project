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
 * Data is fetched on demand from a CDN and cached in memory.
 */

const DATA_BASE = 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2/';
const EM = 1024;              // hanzi-writer em-square size
const cache = new Map();      // char -> {strokes, medians} | null (known-missing)

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

/**
 * Fetch one character's stroke data. Returns null for whitespace or characters
 * that are not in the dataset. Results (including misses) are cached.
 * @param {string} char single character
 * @returns {Promise<{medians:number[][][]}|null>}
 */
async function fetchCharData(char) {
    if (cache.has(char)) return cache.get(char);
    try {
        const res = await fetch(DATA_BASE + encodeURIComponent(char) + '.json');
        if (!res.ok) { cache.set(char, null); return null; }
        const data = await res.json();
        cache.set(char, data);
        return data;
    } catch (err) {
        cache.set(char, null);
        return null;
    }
}

/**
 * Build single-line engraving parts from a string of Chinese text.
 * @param {string} text raw input (newlines start a new row)
 * @param {Object} opts
 * @param {number} opts.sizeMm     glyph height in mm (one em)
 * @param {number} opts.charSpacingMm  extra gap between glyphs (mm)
 * @param {number} opts.lineSpacingMm  extra gap between rows (mm)
 * @param {number} opts.engraveDepthMm engraving depth (partial cut, mm)
 * @returns {Promise<{parts:Array, missing:string[]}>}
 */
export async function buildHanziParts(text, opts = {}) {
    const sizeMm = Number.isFinite(opts.sizeMm) && opts.sizeMm > 0 ? opts.sizeMm : 20;
    const charSpacingMm = Number.isFinite(opts.charSpacingMm) ? opts.charSpacingMm : 2;
    const lineSpacingMm = Number.isFinite(opts.lineSpacingMm) ? opts.lineSpacingMm : sizeMm * 0.3;
    const engraveDepthMm = Number.isFinite(opts.engraveDepthMm) && opts.engraveDepthMm > 0 ? opts.engraveDepthMm : 1;

    const scale = sizeMm / EM;
    const advance = sizeMm + charSpacingMm;
    const lineStep = sizeMm + lineSpacingMm;
    // Fine but not excessive: scales with glyph size, clamped for tiny/huge text.
    const smoothStepMm = Math.min(0.6, Math.max(0.2, sizeMm / 50));

    const parts = [];
    const missing = [];
    let penX = 0;
    let penY = 0;
    let idx = 0;

    for (const ch of Array.from(text)) {
        if (ch === '\n') { penX = 0; penY -= lineStep; continue; }
        if (ch === ' ' || ch === '　' || ch === '\t') { penX += advance; continue; }

        const data = await fetchCharData(ch);
        if (!data || !Array.isArray(data.medians)) {
            missing.push(ch);
            penX += advance;
            continue;
        }

        data.medians.forEach((median, si) => {
            if (!Array.isArray(median) || median.length < 2) return;
            const raw = median.map(([px, py]) => ({
                x: penX + px * scale,
                y: penY + py * scale
            }));
            const points = smoothStroke(raw, smoothStepMm);
            parts.push({
                id: `hz_${Date.now()}_${idx}_${si}`,
                barStyle: 'path',
                toolpathMode: 'on-path',
                points,
                isPartial: true,
                partialDepth: engraveDepthMm,
                listOrdered: true,
                hanziChar: ch
            });
        });

        penX += advance;
        idx += 1;
    }

    return { parts, missing };
}
