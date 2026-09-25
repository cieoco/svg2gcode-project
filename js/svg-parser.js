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
    let lastIndex = 0;
    while ((m = tokenRe.exec(preprocessed)) !== null) {
        if (!/^[\s,]*$/.test(preprocessed.slice(lastIndex, m.index))) {
            throw new Error(`Malformed SVG path data near "${preprocessed.slice(lastIndex, m.index + 8)}".`);
        }
        if (m[1]) rawTokens.push({ type: 'cmd', val: m[1] });
        else {
            const value = Number(m[2]);
            if (!Number.isFinite(value)) throw new Error('SVG path contains a non-finite coordinate.');
            rawTokens.push({ type: 'num', val: value });
        }
        lastIndex = tokenRe.lastIndex;
    }
    if (!/^[\s,]*$/.test(preprocessed.slice(lastIndex))) throw new Error('Malformed SVG path data.');

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
    const numSeg = Math.max(4, Math.ceil(estLen / stepMm));
    if (numSeg > 10000) throw new Error('SVG curve needs too many segments to meet the 0.05 mm tolerance.');

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
    const numSeg = Math.max(4, Math.ceil(estLen / stepMm));
    if (numSeg > 10000) throw new Error('SVG curve needs too many segments to meet the 0.05 mm tolerance.');

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
 * Parse SVG path d-attribute into non-empty subpaths.
 * Each subpath has { startX, startY, moves }; internal arc moves retain
 * endpoint-parameter metadata until the accumulated affine is known.
 * Coordinates remain in SVG user units.
 */
function parseDAttribute(d, svgToMm) {
    const tokens = tokenizePath(d);
    const subpaths = [];
    let moves = [];
    let curX = 0, curY = 0;
    let startX = 0, startY = 0; // subpath start for Z
    let lastCpX = 0, lastCpY = 0; // last control point for S/T
    let lastCurveFamily = null;
    const STEP_MM = 0.5; // sampling step for curves

    const flushSubpath = () => {
        if (moves.length > 0) subpaths.push({ startX, startY, moves });
    };

    for (const { cmd, args } of tokens) {
        const isRel = cmd === cmd.toLowerCase();
        const C = cmd.toUpperCase();
        const arity = { M: 2, L: 2, H: 1, V: 1, A: 7, C: 6, S: 4, Q: 4, T: 2, Z: 0 }[C];
        if (arity === undefined) throw new Error(`Unsupported SVG path command: ${cmd}`);
        if ((C === 'M' && (args.length < 2 || args.length % 2 !== 0)) ||
            (C !== 'M' && C !== 'Z' && (args.length === 0 || args.length % arity !== 0)) ||
            (C === 'Z' && args.length !== 0)) {
            throw new Error(`Malformed argument count for SVG path command ${cmd}.`);
        }

        switch (C) {
            case 'M': {
                // MoveTo — may have implicit LineTo after first pair
                flushSubpath();
                moves = [];
                lastCurveFamily = null;
                for (let i = 0; i < args.length; i += 2) {
                    let nx = args[i], ny = args[i + 1];
                    if (isRel && i >= 2) { nx += curX; ny += curY; }
                    else if (isRel && i === 0) { nx += curX; ny += curY; }
                    if (i === 0) {
                        // actual moveTo
                        startX = nx; startY = ny;
                    } else {
                        moves.push({ type: 'line', to: { x: nx, y: ny } });
                        lastCurveFamily = null;
                    }
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'L': {
                lastCurveFamily = null;
                for (let i = 0; i < args.length; i += 2) {
                    let nx = args[i], ny = args[i + 1];
                    if (isRel) { nx += curX; ny += curY; }
                    moves.push({ type: 'line', to: { x: nx, y: ny } });
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'H': {
                lastCurveFamily = null;
                for (let i = 0; i < args.length; i++) {
                    let nx = args[i];
                    if (isRel) nx += curX;
                    moves.push({ type: 'line', to: { x: nx, y: curY } });
                    curX = nx;
                }
                break;
            }
            case 'V': {
                lastCurveFamily = null;
                for (let i = 0; i < args.length; i++) {
                    let ny = args[i];
                    if (isRel) ny += curY;
                    moves.push({ type: 'line', to: { x: curX, y: ny } });
                    curY = ny;
                }
                break;
            }
            case 'A': {
                lastCurveFamily = null;
                // Arc: rx ry x-rot large-arc sweep x y (7 params each)
                for (let i = 0; i + 7 <= args.length; i += 7) {
                    let arx = args[i], ary = args[i + 1];
                    const xRot = args[i + 2] * Math.PI / 180;
                    const fA = args[i + 3];
                    const fS = args[i + 4];
                    if ((fA !== 0 && fA !== 1) || (fS !== 0 && fS !== 1)) {
                        throw new Error('SVG arc flags must be 0 or 1.');
                    }
                    let nx = args[i + 5], ny = args[i + 6];
                    if (isRel) { nx += curX; ny += curY; }

                    const arcInfo = svgArcToCenter(curX, curY, arx, ary, xRot, fA, fS, nx, ny);

                    if (arcInfo) {
                        // Defer arc classification until the full affine and viewport
                        // transform is known. A circle can remain circular under a
                        // similarity transform; all other cases need curve sampling.
                        moves.push({
                            type: 'arc',
                            to: { x: nx, y: ny },
                            sourceArc: {
                                cx: arcInfo.cx, cy: arcInfo.cy,
                                rx: arcInfo.rx, ry: arcInfo.ry, phi: arcInfo.phi,
                                startAngle: arcInfo.startAngle, endAngle: arcInfo.endAngle,
                                ccw: arcInfo.ccw
                            }
                        });
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
                    lastCurveFamily = 'cubic';
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'S': {
                // Smooth cubic Bézier: x2 y2 x y
                for (let i = 0; i + 3 < args.length; i += 4) {
                    // Reflect last control point
                    const cp1x = lastCurveFamily === 'cubic' ? 2 * curX - lastCpX : curX;
                    const cp1y = lastCurveFamily === 'cubic' ? 2 * curY - lastCpY : curY;
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
                    lastCurveFamily = 'cubic';
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
                    lastCurveFamily = 'quadratic';
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'T': {
                // Smooth quadratic Bézier: x y
                for (let i = 0; i + 1 < args.length; i += 2) {
                    const cpx = lastCurveFamily === 'quadratic' ? 2 * curX - lastCpX : curX;
                    const cpy = lastCurveFamily === 'quadratic' ? 2 * curY - lastCpY : curY;
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
                    lastCurveFamily = 'quadratic';
                    curX = nx; curY = ny;
                }
                break;
            }
            case 'Z': {
                lastCurveFamily = null;
                if (Math.hypot(curX - startX, curY - startY) > 1e-6) {
                    moves.push({ type: 'line', to: { x: startX, y: startY } });
                }
                curX = startX; curY = startY;
                // SVG closepath restores the current point to this subpath's
                // start. Later drawing commands continue from that point in a
                // new subpath, so CAM must retract before cutting them.
                flushSubpath();
                moves = [];
                startX = curX;
                startY = curY;
                break;
            }
        }
    }

    flushSubpath();
    return subpaths;
}

/**
 * Build a polyline point list from typed moves.
 * This is used by legacy point-only code paths (offset, extents, etc.).
 * Arc moves are sampled so circles/rounded corners do not collapse to endpoints.
 */
function flattenMovesToPoints(startPoint, moves, stepMm = 0.5) {
    const points = [{ x: startPoint.x, y: startPoint.y }];
    let cur = { x: startPoint.x, y: startPoint.y };

    const pushPoint = (pt) => {
        const last = points[points.length - 1];
        if (!last || Math.hypot(last.x - pt.x, last.y - pt.y) > 1e-6) {
            points.push({ x: pt.x, y: pt.y });
        }
    };

    for (const move of moves) {
        if (move.type === 'arc' && move.center && Number.isFinite(move.radius) && move.radius > 1e-9) {
            const cx = move.center.x;
            const cy = move.center.y;
            const r = move.radius;
            const a1 = Math.atan2(cur.y - cy, cur.x - cx);
            const a2 = Math.atan2(move.to.y - cy, move.to.x - cx);
            let sweep = move.clockwise ? (a1 - a2) : (a2 - a1);
            if (sweep < 0) sweep += Math.PI * 2;
            const segCount = Math.max(2, Math.min(720, Math.ceil((r * sweep) / stepMm)));
            const dir = move.clockwise ? -1 : 1;

            for (let i = 1; i <= segCount; i++) {
                const t = i / segCount;
                const a = a1 + dir * sweep * t;
                pushPoint({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
            }
            // Snap last sampled point to exact move endpoint to avoid drift.
            points[points.length - 1] = { x: move.to.x, y: move.to.y };
        } else {
            pushPoint(move.to);
        }
        cur = { x: move.to.x, y: move.to.y };
    }

    return points;
}


/**
 * Extracts geometry from SVG content.
 * Returns parts with a `moves` array (type-aware geometry)
 * AND a `points` array (flattened points for backward compatibility).
 */
export function parseSVG(svgText) {
    if (/<\?xml-stylesheet\b/i.test(svgText)) {
        throw new Error('SVG external stylesheets are unsupported; inline the styles before importing.');
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(cleanSVG(svgText), "image/svg+xml");
    const svgEl = doc.documentElement;
    if (!svgEl || svgEl.localName !== 'svg' || doc.querySelector('parsererror')) {
        throw new Error('Invalid SVG XML: unable to parse the SVG document.');
    }
    if (Array.from(svgEl.getElementsByTagName('*')).some(el =>
        el.localName === 'link' && /stylesheet/i.test(el.getAttribute('rel') || ''))) {
        throw new Error('SVG external stylesheets are unsupported; inline the styles before importing.');
    }

    const cssRules = [];
    for (const styleEl of Array.from(svgEl.getElementsByTagName('*')).filter(el => el.localName === 'style')) {
        const css = styleEl.textContent.replace(/\/\*[\s\S]*?\*\//g, '');
        if (/@(?:import|media|supports|layer|container|scope)\b/i.test(css)) {
            throw new Error('SVG CSS at-rules are unsupported; flatten the styles before importing.');
        }
        const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
        let rule;
        let end = 0;
        while ((rule = rulePattern.exec(css))) {
            if (css.slice(end, rule.index).trim()) throw new Error('Unsupported SVG CSS syntax.');
            end = rulePattern.lastIndex;
            const declarations = rule[2].split(';').map(item => item.trim()).filter(Boolean);
            const relevant = declarations.map(item => {
                const colon = item.indexOf(':');
                if (colon < 0) throw new Error('Unsupported SVG CSS declaration.');
                const property = item.slice(0, colon).trim().toLowerCase();
                const raw = item.slice(colon + 1).trim();
                return { property, value: raw.replace(/\s*!important\s*$/i, '').trim().toLowerCase(), important: /!important\s*$/i.test(raw) };
            }).filter(item => item.property === 'display' || item.property === 'visibility');
            if (!relevant.length) continue;
            for (const selector of rule[1].split(',').map(item => item.trim())) {
                if (!/^(?:[a-zA-Z][\w-]*|\*|[.#][\w-]+)(?:[.#][\w-]+)*(?:\s+(?:[a-zA-Z][\w-]*|\*|[.#][\w-]+)(?:[.#][\w-]+)*)*$/.test(selector)) {
                    throw new Error(`Unsupported SVG CSS selector: ${selector}`);
                }
                const ids = (selector.match(/#[\w-]+/g) || []).length;
                const classes = (selector.match(/\.[\w-]+/g) || []).length;
                const tags = (selector.match(/(?:^|\s)[a-zA-Z][\w-]*/g) || []).length;
                cssRules.push({ selector, declarations: relevant, specificity: ids * 100 + classes * 10 + tags });
            }
        }
        if (css.slice(end).trim()) throw new Error('Unsupported SVG CSS syntax.');
    }

    const identity = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const multiply = (l, r) => ({
        a: l.a * r.a + l.c * r.b,
        b: l.b * r.a + l.d * r.b,
        c: l.a * r.c + l.c * r.d,
        d: l.b * r.c + l.d * r.d,
        e: l.a * r.e + l.c * r.f + l.e,
        f: l.b * r.e + l.d * r.f + l.f
    });
    const apply = (pt, m) => ({ x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f });
    const finiteMatrix = (m) => Object.values(m).every(Number.isFinite);
    const numberList = (text) => {
        const number = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
        const re = new RegExp(number, 'g');
        const values = [];
        let match, last = 0;
        while ((match = re.exec(text))) {
            const between = text.slice(last, match.index);
            const validSeparator = values.length === 0
                ? /^\s*$/.test(between)
                : (between === '' ? /^[+-]/.test(match[0]) : /^\s*,\s*$/.test(between) || /^\s+$/.test(between));
            if (!validSeparator) throw new Error('Malformed numeric arguments.');
            values.push(Number(match[0]));
            last = re.lastIndex;
        }
        if (!/^\s*$/.test(text.slice(last)) || values.some((v) => !Number.isFinite(v))) {
            throw new Error('Malformed or non-finite numeric arguments.');
        }
        return values;
    };
    const parseTransform = (el) => {
        const attr = el.getAttribute('transform');
        if (!attr || !attr.trim()) return identity();
        let result = identity();
        const re = /([A-Za-z]+)\s*\(([^()]*)\)/g;
        let match, last = 0, found = false;
        while ((match = re.exec(attr))) {
            if (!/^[\s,]*$/.test(attr.slice(last, match.index))) throw new Error(`Unsupported or malformed transform: ${attr}`);
            found = true;
            last = re.lastIndex;
            const name = match[1];
            const v = numberList(match[2]);
            let next;
            switch (name) {
                case 'matrix':
                    if (v.length !== 6) throw new Error('matrix() transform requires six numbers.');
                    next = { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
                    break;
                case 'translate':
                    if (v.length < 1 || v.length > 2) throw new Error('translate() transform requires one or two numbers.');
                    next = { ...identity(), e: v[0], f: v[1] || 0 };
                    break;
                case 'scale':
                    if (v.length < 1 || v.length > 2) throw new Error('scale() transform requires one or two numbers.');
                    next = { a: v[0], b: 0, c: 0, d: v.length === 2 ? v[1] : v[0], e: 0, f: 0 };
                    break;
                case 'rotate': {
                    if (v.length !== 1 && v.length !== 3) throw new Error('rotate() transform requires one number or an angle and pivot.');
                    const rad = v[0] * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
                    const rot = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
                    next = v.length === 1 ? rot : multiply(multiply({ ...identity(), e: v[1], f: v[2] }, rot), { ...identity(), e: -v[1], f: -v[2] });
                    break;
                }
                case 'skewX':
                case 'skewY': {
                    if (v.length !== 1) throw new Error(`${name}() transform requires one number.`);
                    const tangent = Math.tan(v[0] * Math.PI / 180);
                    next = name === 'skewX'
                        ? { a: 1, b: 0, c: tangent, d: 1, e: 0, f: 0 }
                        : { a: 1, b: tangent, c: 0, d: 1, e: 0, f: 0 };
                    break;
                }
                default: throw new Error(`Unsupported SVG transform function: ${name}`);
            }
            if (!finiteMatrix(next)) throw new Error('SVG transform contains non-finite values.');
            // SVG transform lists compose as T * S; the rightmost transform acts first.
            result = multiply(result, next);
        }
        if (!found || !/^[\s,]*$/.test(attr.slice(last))) throw new Error(`Unsupported or malformed transform: ${attr}`);
        return result;
    };

    const parseDimMm = (value, label) => {
        const m = String(value).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(mm|cm|in|pt|px)?$/i);
        if (!m) throw new Error(`Invalid SVG ${label} dimension: ${value}`);
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`SVG ${label} dimension must be finite and greater than zero.`);
        const unit = (m[2] || 'px').toLowerCase();
        const factor = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 }[unit];
        const mm = n * factor;
        if (!Number.isFinite(mm) || mm <= 0) throw new Error(`SVG ${label} dimension is outside the supported range.`);
        return mm;
    };

    const widthText = svgEl.getAttribute('width');
    const heightText = svgEl.getAttribute('height');
    const hasWidth = widthText !== null;
    const hasHeight = heightText !== null;
    const widthMm = hasWidth ? parseDimMm(widthText, 'width') : null;
    const heightMm = hasHeight ? parseDimMm(heightText, 'height') : null;
    const vbText = svgEl.getAttribute('viewBox');
    let viewport = { a: 25.4 / 96, b: 0, c: 0, d: 25.4 / 96, e: 0, f: 0 };
    if (vbText !== null) {
        const vb = numberList(vbText);
        if (vb.length !== 4 || vb[2] <= 0 || vb[3] <= 0) throw new Error('SVG viewBox must contain four finite numbers with positive width and height.');
        if (!hasWidth && !hasHeight) throw new Error('SVG only has a viewBox; please provide a physical width or height dimension.');
        const viewportW = widthMm ?? heightMm * vb[2] / vb[3];
        const viewportH = heightMm ?? widthMm * vb[3] / vb[2];
        const par = (svgEl.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim().replace(/^defer\s+/, '');
        let sx = viewportW / vb[2], sy = viewportH / vb[3], ox = 0, oy = 0;
        if (par === 'xMidYMid meet') {
            const scale = Math.min(sx, sy);
            ox = (viewportW - vb[2] * scale) / 2;
            oy = (viewportH - vb[3] * scale) / 2;
            sx = sy = scale;
        } else if (par !== 'none') {
            throw new Error(`Unsupported preserveAspectRatio value: ${par}`);
        }
        viewport = { a: sx, b: 0, c: 0, d: sy, e: ox - vb[0] * sx, f: oy - vb[1] * sy };
    }

    const shapes = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
    const nonRendering = new Set(['defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'metadata', 'title', 'desc']);
    const parts = [];
    const maxScaleOf = (m) => Math.hypot(m.a, m.b, m.c, m.d);
    const isSimilarity = (m) => {
        const x = m.a * m.a + m.b * m.b, y = m.c * m.c + m.d * m.d;
        const dot = m.a * m.c + m.b * m.d;
        const scale2 = Math.max(x, y, 1e-24);
        return x > 0 && Math.abs(x - y) <= 1e-10 * scale2 && Math.abs(dot) <= 1e-10 * scale2;
    };
    const machinePoint = (p, m) => {
        const q = apply(p, m);
        if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) throw new Error('SVG geometry transforms to a non-finite coordinate.');
        return { x: q.x, y: -q.y };
    };
    const sampleSourceArc = (arc, matrix, endPoint) => {
        const sweep = Math.abs(arc.endAngle - arc.startAngle);
        const mappedRadius = maxScaleOf(matrix) * Math.max(arc.rx, arc.ry);
        const length = sweep * mappedRadius;
        const angleStep = mappedRadius <= 0.05 ? sweep : 2 * Math.acos(Math.max(-1, 1 - 0.05 / mappedRadius));
        const n = Math.max(1, Math.ceil(length / 0.5), Math.ceil(sweep / Math.max(angleStep, 1e-6)));
        if (n > 10000) throw new Error('SVG curve needs too many segments to meet the 0.05 mm tolerance.');
        const raw = sampleArc(arc.cx, arc.cy, arc.rx, arc.ry, arc.phi, arc.startAngle, arc.endAngle, arc.ccw, n);
        const sampled = raw.map((p) => ({ type: 'line', to: machinePoint(p, matrix) }));
        sampled[sampled.length - 1].to = machinePoint(endPoint, matrix);
        return sampled;
    };

    const presentation = (el, name) => {
        const style = el.getAttribute('style') || '';
        const declarations = style.split(';').filter((item) => item.split(':')[0]?.trim().toLowerCase() === name);
        const declaration = declarations.filter((item) => /!important\s*$/i.test(item)).at(-1) || declarations.at(-1);
        let winner = { value: el.getAttribute(name), important: false, specificity: -1, order: -1 };
        cssRules.forEach((rule, index) => {
            if (!el.matches(rule.selector)) return;
            for (const item of rule.declarations) {
                if (item.property !== name) continue;
                if (item.important && !winner.important || item.important === winner.important &&
                    (rule.specificity > winner.specificity || rule.specificity === winner.specificity && index >= winner.order)) {
                    winner = { ...item, specificity: rule.specificity, order: index };
                }
            }
        });
        if (declaration) {
            const important = /!important\s*$/i.test(declaration);
            if (important || !winner.important) winner.value = declaration.slice(declaration.indexOf(':') + 1).trim();
        }
        return winner.value?.toLowerCase().replace(/\s*!important\s*$/, '').trim();
    };
    const visit = (el, parentMatrix, displayNone = false, inheritedVisibility = 'visible') => {
        if (el.nodeType !== 1) return;
        const tag = el.localName;
        if (displayNone || nonRendering.has(tag) || presentation(el, 'display') === 'none') return;
        const visibility = presentation(el, 'visibility') || inheritedVisibility;
        const local = parseTransform(el);
        const combined = multiply(parentMatrix, local);
        if (!finiteMatrix(combined) || combined.a * combined.d - combined.b * combined.c === 0) {
            throw new Error('SVG contains a singular or non-finite transform.');
        }
        if (shapes.has(tag) && visibility !== 'hidden' && visibility !== 'collapse') {
            const d = primitiveToPath(el);
            if (d) {
                const finalMatrix = multiply(viewport, combined);
                const curveScale = maxScaleOf(finalMatrix);
                const parsed = parseDAttribute(d, curveScale);
                for (const subpath of parsed) {
                    const startMm = machinePoint({ x: subpath.startX, y: subpath.startY }, finalMatrix);
                    const transformedMoves = [];
                    for (const move of subpath.moves) {
                        if (move.type === 'arc' && move.sourceArc) {
                            const arc = move.sourceArc;
                            if (Math.abs(arc.rx - arc.ry) <= 1e-9 * Math.max(arc.rx, arc.ry, 1) && isSimilarity(finalMatrix)) {
                                const center = machinePoint({ x: arc.cx, y: arc.cy }, finalMatrix);
                                const to = machinePoint(move.to, finalMatrix);
                                const scale = Math.sqrt(finalMatrix.a * finalMatrix.a + finalMatrix.b * finalMatrix.b);
                                const det = combined.a * combined.d - combined.b * combined.c;
                                transformedMoves.push({
                                    type: 'arc', to, center, radius: arc.rx * scale,
                                    clockwise: det < 0 ? !arc.ccw : arc.ccw
                                });
                            } else {
                                transformedMoves.push(...sampleSourceArc(arc, finalMatrix, move.to));
                            }
                        } else {
                            transformedMoves.push({ type: move.type, to: machinePoint(move.to, finalMatrix) });
                        }
                    }
                    if (transformedMoves.length === 0) continue;
                    const points = flattenMovesToPoints(startMm, transformedMoves, 0.5);
                    parts.push({
                        id: `Part_${parts.length + 1}`, barStyle: 'path', points,
                        moves: transformedMoves, startPoint: startMm, holes: []
                    });
                }
            }
        }
        for (const child of Array.from(el.children || [])) visit(child, combined, false, visibility);
    };
    visit(svgEl, identity(), false);
    return parts;
}
