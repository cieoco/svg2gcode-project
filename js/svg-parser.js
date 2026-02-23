/**
 * SVG Parser Module
 * Parse SVG file content and extract scalable and translatable
 * path shapes suitable for G-code generation.
 *
 * Strategy B: Parse the SVG path "d" attribute directly to preserve
 * geometry type information (lines vs arcs vs curves).
 * - Lines (L/H/V) → kept as-is for G1
 * - Arcs (A) → converted to center-form arcs for G2/G3
 * - Cubic Bézier (C/S) and Quadratic (Q/T) → sampled into points
 */

/**
 * Clean up SVG string
 */
function cleanSVG(svgStr) {
    return svgStr.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * Convert SVG primitives to path commands string
 */
function primitiveToPath(el) {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
        case 'rect': {
            const x = parseFloat(el.getAttribute('x')) || 0;
            const y = parseFloat(el.getAttribute('y')) || 0;
            const w = parseFloat(el.getAttribute('width')) || 0;
            const h = parseFloat(el.getAttribute('height')) || 0;
            let rx = parseFloat(el.getAttribute('rx')) || 0;
            let ry = parseFloat(el.getAttribute('ry')) || 0;
            // If only one is set, SVG spec says the other matches
            if (!rx && ry) rx = ry;
            if (!ry && rx) ry = rx;
            // Clamp to half of dimensions
            rx = Math.min(rx, w / 2);
            ry = Math.min(ry, h / 2);
            if (rx === 0 && ry === 0) {
                // Sharp rectangle
                return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
            }
            // Rounded rectangle using arc commands
            return `M ${x + rx},${y}` +
                ` H ${x + w - rx}` +
                ` A ${rx},${ry} 0 0 1 ${x + w},${y + ry}` +
                ` V ${y + h - ry}` +
                ` A ${rx},${ry} 0 0 1 ${x + w - rx},${y + h}` +
                ` H ${x + rx}` +
                ` A ${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
                ` V ${y + ry}` +
                ` A ${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
        }

        case 'circle':
            const cx = parseFloat(el.getAttribute('cx')) || 0;
            const cy = parseFloat(el.getAttribute('cy')) || 0;
            const r = parseFloat(el.getAttribute('r')) || 0;
            return `M ${cx - r},${cy} A ${r},${r} 0 1,0 ${cx + r},${cy} A ${r},${r} 0 1,0 ${cx - r},${cy}`;

        case 'ellipse':
            const ecx = parseFloat(el.getAttribute('cx')) || 0;
            const ecy = parseFloat(el.getAttribute('cy')) || 0;
            const erx = parseFloat(el.getAttribute('rx')) || 0;
            const ery = parseFloat(el.getAttribute('ry')) || 0;
            return `M ${ecx - erx},${ecy} A ${erx},${ery} 0 1,0 ${ecx + erx},${ecy} A ${erx},${ery} 0 1,0 ${ecx - erx},${ecy}`;

        case 'line':
            const x1 = parseFloat(el.getAttribute('x1')) || 0;
            const y1 = parseFloat(el.getAttribute('y1')) || 0;
            const x2 = parseFloat(el.getAttribute('x2')) || 0;
            const y2 = parseFloat(el.getAttribute('y2')) || 0;
            return `M ${x1} ${y1} L ${x2} ${y2}`;

        case 'polyline':
        case 'polygon':
            const points = el.getAttribute('points');
            if (!points) return '';
            const pts = points.trim().split(/[\s,]+/).map(parseFloat);
            if (pts.length < 2) return '';
            let path = `M ${pts[0]} ${pts[1]}`;
            for (let i = 2; i < pts.length; i += 2) {
                path += ` L ${pts[i]} ${pts[i + 1]}`;
            }
            if (tag === 'polygon') path += ' Z';
            return path;

        case 'path':
            return el.getAttribute('d') || '';

        default:
            return '';
    }
}

/**
 * Tokenize an SVG path "d" attribute string into an array of
 * { cmd, args[] } objects.
 * Handles edge cases like "1.5.3" → [1.5, 0.3], "-1-2" → [-1, -2]
 * Also handles SVG arc flag compression like "A10,10,0,01,20,30"
 */
function tokenizePath(d) {
    // Preprocess: insert spaces around arc flags that may be concatenated
    // SVG arc syntax: A rx ry x-rotation large-arc-flag sweep-flag x y
    // Flags are single 0 or 1 digits that can be concatenated like "01" meaning "0 1"
    // We fix this by pre-processing the d string
    const preprocessed = d.replace(
        /([Aa])\s*((?:[^A-Za-z])*)/g,
        (match, cmd, rest) => {
            // For each arc command, insert spaces between consecutive flag digits
            // The flags are parameters 4 and 5 (0-indexed: 3 and 4)
            // We need to parse carefully: rx ry x-rot fA fS x y
            return cmd + ' ' + rest.replace(
                /(\d*\.?\d+(?:[eE][+-]?\d+)?)\s*,?\s*(\d*\.?\d+(?:[eE][+-]?\d+)?)\s*,?\s*(\d*\.?\d+(?:[eE][+-]?\d+)?)\s*,?\s*([01])\s*,?\s*([01])/g,
                '$1 $2 $3 $4 $5'
            );
        }
    );

    // Extract all tokens: single letters and numbers
    const tokenRe = /([a-zA-Z])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
    const rawTokens = [];
    let m;
    while ((m = tokenRe.exec(preprocessed)) !== null) {
        if (m[1]) rawTokens.push({ type: 'cmd', val: m[1] });
        else rawTokens.push({ type: 'num', val: parseFloat(m[2]) });
    }

    const commands = [];
    let current = null;
    for (const tok of rawTokens) {
        if (tok.type === 'cmd') {
            if (current) commands.push(current);
            current = { cmd: tok.val, args: [] };
        } else {
            if (!current) current = { cmd: 'M', args: [] };
            current.args.push(tok.val);
        }
    }
    if (current) commands.push(current);
    return commands;
}

/**
 * Convert SVG elliptical arc parameters (endpoint form)
 * to center-parameter form suitable for G2/G3.
 *
 * SVG arc: A rx ry x-rotation large-arc-flag sweep-flag x y
 *
 * Returns { cx, cy, rx, ry, startAngle, endAngle, ccw }
 * or null if degenerate.
 */
function svgArcToCenter(x1, y1, rx, ry, phi, fA, fS, x2, y2) {
    // Implementation following SVG spec: F.6
    if (rx === 0 || ry === 0) return null;
    rx = Math.abs(rx);
    ry = Math.abs(ry);

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    const dx2 = (x1 - x2) / 2;
    const dy2 = (y1 - y2) / 2;

    const x1p = cosPhi * dx2 + sinPhi * dy2;
    const y1p = -sinPhi * dx2 + cosPhi * dy2;

    // Correct radii if too small
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        const sq = Math.sqrt(lambda);
        rx *= sq;
        ry *= sq;
    }

    const rxSq = rx * rx;
    const rySq = ry * ry;
    const x1pSq = x1p * x1p;
    const y1pSq = y1p * y1p;

    let num = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
    let den = rxSq * y1pSq + rySq * x1pSq;
    if (den === 0) return null;
    if (num < 0) num = 0;
    let sq = Math.sqrt(num / den);
    if (fA === fS) sq = -sq;

    const cxp = sq * (rx * y1p) / ry;
    const cyp = sq * -(ry * x1p) / rx;

    const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

    const startAngle = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
    let dTheta = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx) - startAngle;

    if (fS === 0 && dTheta > 0) dTheta -= Math.PI * 2;
    if (fS === 1 && dTheta < 0) dTheta += Math.PI * 2;

    const endAngle = startAngle + dTheta;
    const ccw = fS === 1;

    return { cx, cy, rx, ry, startAngle, endAngle, ccw, phi };
}

/**
 * Sample a cubic Bézier curve into line segments.
 * @returns {Array<{x,y}>} sampled points (excluding the start point)
 */
function sampleCubicBezier(p0, p1, p2, p3, stepMm, svgToMm) {
    // Estimate curve length using control polygon
    const chordLen = Math.hypot(p3.x - p0.x, p3.y - p0.y) * svgToMm;
    const polyLen = (Math.hypot(p1.x - p0.x, p1.y - p0.y) +
        Math.hypot(p2.x - p1.x, p2.y - p1.y) +
        Math.hypot(p3.x - p2.x, p3.y - p2.y)) * svgToMm;
    const estLen = (chordLen + polyLen) / 2;
    const numSeg = Math.max(4, Math.min(200, Math.ceil(estLen / stepMm)));

    const pts = [];
    for (let i = 1; i <= numSeg; i++) {
        const t = i / numSeg;
        const t2 = t * t, t3 = t2 * t;
        const mt = 1 - t, mt2 = mt * mt, mt3 = mt2 * mt;
        pts.push({
            x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
            y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y
        });
    }
    return pts;
}

/**
 * Sample a quadratic Bézier curve into line segments.
 */
function sampleQuadBezier(p0, p1, p2, stepMm, svgToMm) {
    const chordLen = Math.hypot(p2.x - p0.x, p2.y - p0.y) * svgToMm;
    const polyLen = (Math.hypot(p1.x - p0.x, p1.y - p0.y) +
        Math.hypot(p2.x - p1.x, p2.y - p1.y)) * svgToMm;
    const estLen = (chordLen + polyLen) / 2;
    const numSeg = Math.max(4, Math.min(200, Math.ceil(estLen / stepMm)));

    const pts = [];
    for (let i = 1; i <= numSeg; i++) {
        const t = i / numSeg;
        const mt = 1 - t;
        pts.push({
            x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
            y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
        });
    }
    return pts;
}

/**
 * Sample an SVG arc into line segments (for non-circular arcs / ellipses).
 */
function sampleArc(cx, cy, rx, ry, phi, startAngle, endAngle, ccw, numSeg) {
    const pts = [];
    const dTheta = endAngle - startAngle;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    for (let i = 1; i <= numSeg; i++) {
        const t = i / numSeg;
        const theta = startAngle + dTheta * t;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const x = cosPhi * rx * cosT - sinPhi * ry * sinT + cx;
        const y = sinPhi * rx * cosT + cosPhi * ry * sinT + cy;
        pts.push({ x, y });
    }
    return pts;
}


/**
 * Parse SVG path d-attribute into a sequence of geometry moves.
 *
 * Returns an array of moves:
 *   { type: 'line', to: {x,y} }
 *   { type: 'arc', to: {x,y}, center: {x,y}, radius: number, clockwise: bool }
 *   (arcs only for circular arcs where rx ≈ ry and rotation ≈ 0)
 *
 * All coordinates are in SVG user units (caller converts to mm).
 */
function parseDAttribute(d, svgToMm) {
    const tokens = tokenizePath(d);
    const moves = []; // result
    let curX = 0, curY = 0;
    let startX = 0, startY = 0; // subpath start for Z
    let lastCpX = 0, lastCpY = 0; // last control point for S/T
    const STEP_MM = 0.5; // sampling step for curves

    for (const { cmd, args } of tokens) {
        const isRel = cmd === cmd.toLowerCase();
        const C = cmd.toUpperCase();

        switch (C) {
            case 'M': {
                // MoveTo — may have implicit LineTo after first pair
                for (let i = 0; i < args.length; i += 2) {
                    let nx = args[i], ny = args[i + 1];
                    if (isRel && i >= 2) { nx += curX; ny += curY; }
                    else if (isRel && i === 0) { nx += curX; ny += curY; }
                    if (i === 0) {
                        // actual moveTo
                        startX = nx; startY = ny;
                    } else {
                        moves.push({ type: 'line', to: { x: nx, y: ny } });
                    }
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'L': {
                for (let i = 0; i < args.length; i += 2) {
                    let nx = args[i], ny = args[i + 1];
                    if (isRel) { nx += curX; ny += curY; }
                    moves.push({ type: 'line', to: { x: nx, y: ny } });
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'H': {
                for (let i = 0; i < args.length; i++) {
                    let nx = args[i];
                    if (isRel) nx += curX;
                    moves.push({ type: 'line', to: { x: nx, y: curY } });
                    curX = nx;
                }
                break;
            }
            case 'V': {
                for (let i = 0; i < args.length; i++) {
                    let ny = args[i];
                    if (isRel) ny += curY;
                    moves.push({ type: 'line', to: { x: curX, y: ny } });
                    curY = ny;
                }
                break;
            }
            case 'A': {
                // Arc: rx ry x-rot large-arc sweep x y (7 params each)
                for (let i = 0; i + 7 <= args.length; i += 7) {
                    let arx = args[i], ary = args[i + 1];
                    const xRot = args[i + 2] * Math.PI / 180;
                    const fA = args[i + 3];
                    const fS = args[i + 4];
                    let nx = args[i + 5], ny = args[i + 6];
                    if (isRel) { nx += curX; ny += curY; }

                    // Check if this is a circular arc (rx ≈ ry)
                    // When rx ≈ ry, rotation doesn't matter (circle is rotationally symmetric)
                    const isCircular = Math.abs(arx - ary) < 0.01 * Math.max(arx, ary);

                    const arcInfo = svgArcToCenter(curX, curY, arx, ary, xRot, fA, fS, nx, ny);

                    if (arcInfo && isCircular) {
                        // Circular arc → G2/G3
                        const r = (arcInfo.rx + arcInfo.ry) / 2;
                        // Direction mapping:
                        // svgArcToCenter sets ccw=true when fS=1 (math convention: positive angle = CCW).
                        // In SVG screen space (Y-down), math-CCW appears as visual-CW.
                        // So ccw=true → visual CW in SVG.
                        // We store "clockwise" in SVG visual space here;
                        // transformMove will invert it when Y is flipped for CNC.
                        // Result: SVG fS=1 → visual CW in SVG → clockwise=true here
                        //       → after Y-flip: clockwise=false → G3 (CNC CCW) ✓
                        const clockwise = arcInfo.ccw; // fS=1→ccw=true→CW in SVG visual
                        moves.push({
                            type: 'arc',
                            to: { x: nx, y: ny },
                            center: { x: arcInfo.cx, y: arcInfo.cy },
                            radius: r,
                            clockwise: clockwise
                        });
                    } else if (arcInfo) {
                        // Elliptical arc → sample into lines
                        const sweep = Math.abs(arcInfo.endAngle - arcInfo.startAngle);
                        const estLen = sweep * Math.max(arcInfo.rx, arcInfo.ry) * svgToMm;
                        const numSeg = Math.max(8, Math.min(200, Math.ceil(estLen / STEP_MM)));
                        const pts = sampleArc(arcInfo.cx, arcInfo.cy, arcInfo.rx, arcInfo.ry,
                            arcInfo.phi, arcInfo.startAngle, arcInfo.endAngle, arcInfo.ccw, numSeg);
                        for (const pt of pts) {
                            moves.push({ type: 'line', to: { x: pt.x, y: pt.y } });
                        }
                    } else {
                        // Degenerate arc → straight line
                        moves.push({ type: 'line', to: { x: nx, y: ny } });
                    }
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'C': {
                // Cubic Bézier: x1 y1 x2 y2 x y (6 params each)
                for (let i = 0; i + 5 < args.length; i += 6) {
                    let cp1x = args[i], cp1y = args[i + 1];
                    let cp2x = args[i + 2], cp2y = args[i + 3];
                    let nx = args[i + 4], ny = args[i + 5];
                    if (isRel) {
                        cp1x += curX; cp1y += curY;
                        cp2x += curX; cp2y += curY;
                        nx += curX; ny += curY;
                    }
                    const pts = sampleCubicBezier(
                        { x: curX, y: curY }, { x: cp1x, y: cp1y },
                        { x: cp2x, y: cp2y }, { x: nx, y: ny },
                        STEP_MM, svgToMm
                    );
                    for (const pt of pts) {
                        moves.push({ type: 'line', to: { x: pt.x, y: pt.y } });
                    }
                    lastCpX = cp2x; lastCpY = cp2y;
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'S': {
                // Smooth cubic Bézier: x2 y2 x y
                for (let i = 0; i + 3 < args.length; i += 4) {
                    // Reflect last control point
                    const cp1x = 2 * curX - lastCpX;
                    const cp1y = 2 * curY - lastCpY;
                    let cp2x = args[i], cp2y = args[i + 1];
                    let nx = args[i + 2], ny = args[i + 3];
                    if (isRel) {
                        cp2x += curX; cp2y += curY;
                        nx += curX; ny += curY;
                    }
                    const pts = sampleCubicBezier(
                        { x: curX, y: curY }, { x: cp1x, y: cp1y },
                        { x: cp2x, y: cp2y }, { x: nx, y: ny },
                        STEP_MM, svgToMm
                    );
                    for (const pt of pts) {
                        moves.push({ type: 'line', to: { x: pt.x, y: pt.y } });
                    }
                    lastCpX = cp2x; lastCpY = cp2y;
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'Q': {
                // Quadratic Bézier: x1 y1 x y
                for (let i = 0; i + 3 < args.length; i += 4) {
                    let cpx = args[i], cpy = args[i + 1];
                    let nx = args[i + 2], ny = args[i + 3];
                    if (isRel) {
                        cpx += curX; cpy += curY;
                        nx += curX; ny += curY;
                    }
                    const pts = sampleQuadBezier(
                        { x: curX, y: curY }, { x: cpx, y: cpy }, { x: nx, y: ny },
                        STEP_MM, svgToMm
                    );
                    for (const pt of pts) {
                        moves.push({ type: 'line', to: { x: pt.x, y: pt.y } });
                    }
                    lastCpX = cpx; lastCpY = cpy;
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'T': {
                // Smooth quadratic Bézier: x y
                for (let i = 0; i + 1 < args.length; i += 2) {
                    const cpx = 2 * curX - lastCpX;
                    const cpy = 2 * curY - lastCpY;
                    let nx = args[i], ny = args[i + 1];
                    if (isRel) { nx += curX; ny += curY; }
                    const pts = sampleQuadBezier(
                        { x: curX, y: curY }, { x: cpx, y: cpy }, { x: nx, y: ny },
                        STEP_MM, svgToMm
                    );
                    for (const pt of pts) {
                        moves.push({ type: 'line', to: { x: pt.x, y: pt.y } });
                    }
                    lastCpX = cpx; lastCpY = cpy;
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'Z': {
                if (Math.hypot(curX - startX, curY - startY) > 1e-6) {
                    moves.push({ type: 'line', to: { x: startX, y: startY } });
                }
                curX = startX; curY = startY;
                break;
            }
        }
    }

    return { startX, startY, moves };
}


/**
 * Extracts geometry from SVG content.
 * Returns parts with a `moves` array (type-aware geometry)
 * AND a `points` array (flattened points for backward compatibility).
 */
export function parseSVG(svgText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(cleanSVG(svgText), "image/svg+xml");
    const svgEl = doc.querySelector('svg');

    if (!svgEl) {
        throw new Error("Invalid SVG content.");
    }

    // Detect SVG viewport units and compute a scale-to-mm factor.
    let svgToMm = 1;

    const svgWidth = svgEl.getAttribute('width') || '';
    const svgHeight = svgEl.getAttribute('height') || '';

    const parseDimMm = (str) => {
        const m = str.trim().match(/^([\d.]+)\s*(cm|mm|in|pt|px)?$/i);
        if (!m) return null;
        const val = parseFloat(m[1]);
        const unit = (m[2] || 'px').toLowerCase();
        const toMm = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 };
        return val * (toMm[unit] || 1);
    };

    const viewBox = svgEl.getAttribute('viewBox');
    if (viewBox && svgWidth) {
        const vbParts = viewBox.trim().split(/[\s,]+/).map(parseFloat);
        const vbW = vbParts[2];
        const physW = parseDimMm(svgWidth);
        if (vbW && physW) {
            svgToMm = physW / vbW;
        }
    } else if (svgWidth) {
        const physW = parseDimMm(svgWidth);
        if (physW !== null) svgToMm = physW / parseFloat(svgWidth);
    }

    const shapes = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
    const parts = [];
    const elements = doc.querySelectorAll(shapes.join(','));
    let partIdCounter = 1;

    // Build a transform matrix from the element's transform attribute
    const parseTransform = (el) => {
        let matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        const transformAttr = el.getAttribute('transform');
        if (transformAttr) {
            const matrixMatch = transformAttr.match(/matrix\s*\(\s*([^\)]+)\)/);
            if (matrixMatch) {
                const vals = matrixMatch[1].trim().split(/[\s,]+/).map(parseFloat);
                if (vals.length === 6) {
                    matrix = { a: vals[0], b: vals[1], c: vals[2], d: vals[3], e: vals[4], f: vals[5] };
                }
            } else {
                const translateMatch = transformAttr.match(/translate\s*\(\s*([^\)]+)\)/);
                if (translateMatch) {
                    const vals = translateMatch[1].trim().split(/[\s,]+/).map(parseFloat);
                    matrix.e = vals[0] || 0;
                    matrix.f = vals[1] || 0;
                }
            }
        }
        return matrix;
    };

    const applyMatrixPt = (pt, m) => ({
        x: m.a * pt.x + m.c * pt.y + m.e,
        y: m.b * pt.x + m.d * pt.y + m.f
    });

    elements.forEach(el => {
        const d = primitiveToPath(el);
        if (!d) return;

        const matrix = parseTransform(el);
        const hasTransform = !(matrix.a === 1 && matrix.b === 0 && matrix.c === 0 &&
            matrix.d === 1 && matrix.e === 0 && matrix.f === 0);
        // If there's a non-trivial rotation/skew, arcs may not stay circular
        const hasRotation = Math.abs(matrix.b) > 1e-6 || Math.abs(matrix.c) > 1e-6;

        const parsed = parseDAttribute(d, svgToMm);
        if (!parsed.moves || parsed.moves.length === 0) return;

        // Transform and convert to mm, flip Y
        const transformMove = (move) => {
            const newMove = { ...move };
            if (move.to) {
                const tp = applyMatrixPt(move.to, matrix);
                newMove.to = { x: tp.x * svgToMm, y: -tp.y * svgToMm };
            }
            if (move.center) {
                const tc = applyMatrixPt(move.center, matrix);
                newMove.center = { x: tc.x * svgToMm, y: -tc.y * svgToMm };
                // When Y is flipped, arc direction reverses
                newMove.clockwise = !move.clockwise;
                newMove.radius = move.radius * svgToMm;
            }
            // If there's rotation in the transform, demote arcs to lines
            if (hasRotation && move.type === 'arc') {
                newMove.type = 'line';
                delete newMove.center;
                delete newMove.radius;
                delete newMove.clockwise;
            }
            return newMove;
        };

        const startPt = applyMatrixPt({ x: parsed.startX, y: parsed.startY }, matrix);
        const startMm = { x: startPt.x * svgToMm, y: -startPt.y * svgToMm };

        const transformedMoves = parsed.moves.map(transformMove);

        // Build backward-compatible `points` array from moves
        const points = [startMm];
        for (const m of transformedMoves) {
            points.push(m.to);
        }

        parts.push({
            id: `Part_${partIdCounter++}`,
            barStyle: 'path',
            points: points,
            moves: transformedMoves,
            startPoint: startMm,
            holes: []
        });
    });

    return parts;
}
