/**
 * G-code Operations
 */

import { fmt } from '../utils.js';
import { optimizePath } from './path-optimizer.js';

function normalizePostProcessor(postProcessor) {
    const val = String(postProcessor || '').toLowerCase();
    return val === 'mach3' ? 'mach3' : 'grbl';
}

export function gcodeHeader({ safeZ, spindle, postProcessor }) {
    const lines = [];
    const post = normalizePostProcessor(postProcessor);
    lines.push(`(SVG2GCODE, ${post === 'mach3' ? 'MACH3' : 'GRBL'})`);
    lines.push("G21  (MM)");
    lines.push("G90  (ABSOLUTE)");
    lines.push("G17  (XY PLANE)");
    if (post === 'mach3') {
        lines.push("G94  (FEED PER MINUTE)");
        lines.push("G64  (CONSTANT VELOCITY MODE)");
        lines.push("G40  (CUTTER COMP OFF)");
        lines.push("G49  (TOOL LENGTH COMP OFF)");
        lines.push("G80  (CANCEL CANNED CYCLES)");
    }
    lines.push(`G0 Z${fmt(safeZ)}`);
    if (Number.isFinite(spindle) && spindle > 0) {
        lines.push(`M3 S${fmt(spindle)}`);
    }
    return lines;
}

export function gcodeFooter({ safeZ, spindle, postProcessor }) {
    const lines = [];
    const post = normalizePostProcessor(postProcessor);
    lines.push(`G0 Z${fmt(safeZ)}`);
    if (Number.isFinite(spindle) && spindle > 0) {
        lines.push("M5");
    }
    lines.push(post === 'mach3' ? "M30" : "M2");
    return lines;
}

export function drillOps({ holes, safeZ, drillZ, feedZ }) {
    const lines = [];
    lines.push("(DRILL HOLES)");
    let first = true;
    for (const h of holes) {
        // Enforce safe Z explicitly only before the very first hole to ensure clearance
        if (first) {
            lines.push(`G0 Z${fmt(safeZ)}`);
            first = false;
        }
        lines.push(`G0 X${fmt(h.x)} Y${fmt(h.y)}`);
        lines.push(`G1 Z${fmt(drillZ)} F${fmt(feedZ)}`); // drill down
        lines.push(`G0 Z${fmt(safeZ)}`); // lift up to safe Z
    }
    return lines;
}

function buildTabIntervals(totalLen, tabCount, tabWidth) {
    const intervals = [];
    if (!Number.isFinite(totalLen) || totalLen <= 0) return intervals;
    if (!Number.isFinite(tabCount) || tabCount <= 0) return intervals;
    if (!Number.isFinite(tabWidth) || tabWidth <= 0) return intervals;
    const count = Math.floor(tabCount);
    if (count <= 0) return intervals;
    const spacing = totalLen / count;
    const offset = spacing / 2;
    for (let i = 0; i < count; i++) {
        const center = offset + i * spacing;
        const start = Math.max(0, center - tabWidth / 2);
        const end = Math.min(totalLen, center + tabWidth / 2);
        if (end > start) intervals.push({ start, end });
    }
    return intervals;
}

function addLineWithTabs(lines, start, end, z, tabZ, intervals, s0, feedXY, feedZ, tabActive) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const segLen = Math.hypot(dx, dy);
    if (!segLen) return s0;

    if (!tabActive || !intervals.length || !Number.isFinite(tabZ)) {
        lines.push(`G1 X${fmt(end.x)} Y${fmt(end.y)} F${fmt(feedXY)}`);
        return s0 + segLen;
    }

    let cursor = 0;
    for (const interval of intervals) {
        if (interval.end <= s0 || interval.start >= s0 + segLen) continue;
        const localStart = Math.max(0, interval.start - s0);
        const localEnd = Math.min(segLen, interval.end - s0);
        if (localStart > cursor + 1e-6) {
            const t = localStart / segLen;
            const x = start.x + dx * t;
            const y = start.y + dy * t;
            lines.push(`G1 X${fmt(x)} Y${fmt(y)} F${fmt(feedXY)}`);
        }
        if (localEnd > localStart + 1e-6) {
            lines.push(`G1 Z${fmt(tabZ)} F${fmt(feedZ)}`);
            const t2 = localEnd / segLen;
            const x2 = start.x + dx * t2;
            const y2 = start.y + dy * t2;
            lines.push(`G1 X${fmt(x2)} Y${fmt(y2)} F${fmt(feedXY)}`);
            lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);
        }
        cursor = Math.max(cursor, localEnd);
    }

    if (cursor < segLen - 1e-6) {
        lines.push(`G1 X${fmt(end.x)} Y${fmt(end.y)} F${fmt(feedXY)}`);
    }

    return s0 + segLen;
}

function addArcWithTabs(lines, center, radius, startAngle, endAngle, ccw, z, tabZ, intervals, s0, feedXY, feedZ, tabActive) {
    if (!Number.isFinite(radius) || radius <= 0) return s0;
    const dir = ccw ? 1 : -1;
    let sweep = ccw ? (endAngle - startAngle) : (startAngle - endAngle);
    if (sweep < 0) sweep += Math.PI * 2;
    const arcLen = sweep * radius;

    const arcSegment = (fromLen, toLen, zLevel) => {
        const aStart = startAngle + dir * (fromLen / radius);
        const aEnd = startAngle + dir * (toLen / radius);
        const endX = center.x + radius * Math.cos(aEnd);
        const endY = center.y + radius * Math.sin(aEnd);
        const iOff = center.x - (center.x + radius * Math.cos(aStart));
        const jOff = center.y - (center.y + radius * Math.sin(aStart));
        const cmd = ccw ? 'G3' : 'G2';
        lines.push(`${cmd} X${fmt(endX)} Y${fmt(endY)} I${fmt(iOff)} J${fmt(jOff)} F${fmt(feedXY)}`);
    };

    if (!tabActive || !intervals.length || !Number.isFinite(tabZ)) {
        arcSegment(0, arcLen, z);
        return s0 + arcLen;
    }

    let cursor = 0;
    for (const interval of intervals) {
        if (interval.end <= s0 || interval.start >= s0 + arcLen) continue;
        const localStart = Math.max(0, interval.start - s0);
        const localEnd = Math.min(arcLen, interval.end - s0);
        if (localStart > cursor + 1e-6) {
            arcSegment(cursor, localStart, z);
        }
        if (localEnd > localStart + 1e-6) {
            lines.push(`G1 Z${fmt(tabZ)} F${fmt(feedZ)}`);
            arcSegment(localStart, localEnd, tabZ);
            lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);
        }
        cursor = Math.max(cursor, localEnd);
    }

    if (cursor < arcLen - 1e-6) {
        arcSegment(cursor, arcLen, z);
    }

    return s0 + arcLen;
}

export function profileRectOps({
    rect,
    safeZ,
    cutDepth,
    stepdown,
    feedXY,
    feedZ,
    tabWidth,
    tabCount,
    tabZ,
}) {
    const lines = [];
    lines.push("(Profile rectangle)");
    const x0 = rect.x,
        y0 = rect.y,
        x1 = rect.x + rect.w,
        y1 = rect.y + rect.h;

    const startX = x0;
    const startY = y0;

    const zLevels = [];
    const total = Math.abs(cutDepth);
    const sd = Math.abs(stepdown);
    const n = Math.max(1, Math.ceil(total / sd));
    for (let i = 1; i <= n; i++) {
        const z = -Math.min(i * sd, total);
        zLevels.push(z);
    }

    const totalLen = 2 * (rect.w + rect.h);
    const tabIntervals = buildTabIntervals(totalLen, tabCount, tabWidth);

    for (const z of zLevels) {
        const tabActive = tabIntervals.length && Number.isFinite(tabZ) && z < tabZ - 1e-6;
        let dist = 0;
        let curr = { x: startX, y: startY };

        lines.push(`G0 Z${fmt(safeZ)}`);
        lines.push(`G0 X${fmt(startX)} Y${fmt(startY)}`);
        lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);

        dist = addLineWithTabs(lines, curr, { x: x1, y: y0 }, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
        curr = { x: x1, y: y0 };
        dist = addLineWithTabs(lines, curr, { x: x1, y: y1 }, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
        curr = { x: x1, y: y1 };
        dist = addLineWithTabs(lines, curr, { x: x0, y: y1 }, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
        curr = { x: x0, y: y1 };
        addLineWithTabs(lines, curr, { x: x0, y: y0 }, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);

        lines.push(`G0 Z${fmt(safeZ)}`);
    }

    return lines;
}

export function profileRoundedRectOps({
    rect,
    safeZ,
    cutDepth,
    stepdown,
    feedXY,
    feedZ,
    tabWidth,
    tabCount,
    tabZ,
}) {
    const lines = [];
    lines.push("(Profile rounded rectangle)");
    const { x: x0, y: y0, w, h } = rect;
    const r = h / 2;
    const x1 = x0 + w;
    const y1 = y0 + h;

    const zLevels = [];
    const total = Math.abs(cutDepth);
    const sd = Math.abs(stepdown);
    const n = Math.max(1, Math.ceil(total / sd));
    for (let i = 1; i <= n; i++) {
        zLevels.push(-Math.min(i * sd, total));
    }

    const totalLen = 2 * (w - 2 * r) + 2 * Math.PI * r;
    const tabIntervals = buildTabIntervals(totalLen, tabCount, tabWidth);

    for (const z of zLevels) {
        const tabActive = tabIntervals.length && Number.isFinite(tabZ) && z < tabZ - 1e-6;
        let dist = 0;

        lines.push(`G0 Z${fmt(safeZ)}`);
        lines.push(`G0 X${fmt(x0 + r)} Y${fmt(y0)}`);
        lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);

        dist = addLineWithTabs(lines, { x: x0 + r, y: y0 }, { x: x1 - r, y: y0 }, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
        dist = addArcWithTabs(lines, { x: x1 - r, y: y0 + r }, r, -Math.PI / 2, Math.PI / 2, true, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
        dist = addLineWithTabs(lines, { x: x1 - r, y: y1 }, { x: x0 + r, y: y1 }, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
        dist = addArcWithTabs(lines, { x: x0 + r, y: y0 + r }, r, Math.PI / 2, Math.PI * 1.5, true, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);

        lines.push(`G0 Z${fmt(safeZ)}`);
    }

    return lines;
}

export function profileCircleOps({
    cx,
    cy,
    diameter,
    safeZ,
    cutDepth,
    stepdown,
    feedXY,
    feedZ,
    tabWidth,
    tabCount,
    tabZ,
}) {
    const lines = [];
    lines.push("(Profile circle)");
    const r = diameter / 2;

    const zLevels = [];
    const total = Math.abs(cutDepth);
    const sd = Math.abs(stepdown);
    const n = Math.max(1, Math.ceil(total / sd));
    for (let i = 1; i <= n; i++) {
        zLevels.push(-Math.min(i * sd, total));
    }

    const totalLen = 2 * Math.PI * r;
    const tabIntervals = buildTabIntervals(totalLen, tabCount, tabWidth);

    for (const z of zLevels) {
        const tabActive = tabIntervals.length && Number.isFinite(tabZ) && z < tabZ - 1e-6;
        let dist = 0;

        lines.push(`G0 Z${fmt(safeZ)}`);
        lines.push(`G0 X${fmt(cx + r)} Y${fmt(cy)}`);
        lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);

        dist = addArcWithTabs(lines, { x: cx, y: cy }, r, 0, Math.PI * 2, true, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);

        lines.push(`G0 Z${fmt(safeZ)}`);
    }

    return lines;
}

/**
 * Simplify runs of consecutive line moves using Douglas-Peucker,
 * then merge collinear lines. Arc moves pass through unchanged.
 */
function simplifyLineMoves(moves) {
    const result = [];
    let lineRun = []; // collect consecutive line moves

    const flushLineRun = () => {
        if (lineRun.length === 0) return;
        // Build points from line run
        const pts = [lineRun[0].from];
        for (const m of lineRun) pts.push(m.to);

        // Douglas-Peucker simplification
        const simplified = douglasPuckerSimplify(pts, 0.005);

        // Merge collinear
        const merged = mergeCollinear(simplified);

        // Convert back to moves
        for (let i = 0; i < merged.length - 1; i++) {
            result.push({ type: 'line', from: merged[i], to: merged[i + 1] });
        }
        lineRun = [];
    };

    for (const m of moves) {
        if (m.type === 'arc') {
            flushLineRun();
            result.push(m);
        } else {
            lineRun.push(m);
        }
    }
    flushLineRun();
    return result;
}

/**
 * Douglas-Peucker polyline simplification (inline, no external dep)
 */
function douglasPuckerSimplify(pts, tolerance) {
    if (pts.length <= 2) return pts;

    let maxDist = 0, maxIdx = 0;
    const first = pts[0], last = pts[pts.length - 1];
    const dx = last.x - first.x, dy = last.y - first.y;
    const lenSq = dx * dx + dy * dy;

    for (let i = 1; i < pts.length - 1; i++) {
        let dist;
        if (lenSq === 0) {
            dist = Math.hypot(pts[i].x - first.x, pts[i].y - first.y);
        } else {
            const t = Math.max(0, Math.min(1, ((pts[i].x - first.x) * dx + (pts[i].y - first.y) * dy) / lenSq));
            const px = first.x + t * dx, py = first.y + t * dy;
            dist = Math.hypot(pts[i].x - px, pts[i].y - py);
        }
        if (dist > maxDist) { maxDist = dist; maxIdx = i; }
    }

    if (maxDist > tolerance) {
        const left = douglasPuckerSimplify(pts.slice(0, maxIdx + 1), tolerance);
        const right = douglasPuckerSimplify(pts.slice(maxIdx), tolerance);
        return left.slice(0, -1).concat(right);
    }
    return [first, last];
}

/**
 * Merge collinear consecutive segments
 */
function mergeCollinear(pts) {
    if (pts.length <= 2) return pts;
    const result = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
        const prev = result[result.length - 1];
        const curr = pts[i];
        const next = pts[i + 1];
        // Cross product to check collinearity
        const cross = (curr.x - prev.x) * (next.y - prev.y) - (curr.y - prev.y) * (next.x - prev.x);
        const segLen = Math.hypot(next.x - prev.x, next.y - prev.y);
        if (segLen > 0 && Math.abs(cross) / segLen > 0.001) {
            result.push(curr);
        }
    }
    result.push(pts[pts.length - 1]);
    return result;
}

export function profilePathOps({
    points,
    moves: svgMoves,
    startPoint,
    safeZ,
    cutDepth,
    stepdown,
    feedXY,
    feedZ,
    tabWidth,
    tabCount,
    tabZ
}) {
    if ((!points || points.length < 2) && (!svgMoves || svgMoves.length === 0)) return [];

    const lines = [];
    lines.push("(Profile arbitrary path)");

    const zLevels = [];
    const total = Math.abs(cutDepth);
    const sd = Math.abs(stepdown);
    const n = Math.max(1, Math.ceil(total / sd));
    for (let i = 1; i <= n; i++) {
        zLevels.push(-Math.min(i * sd, total));
    }

    // --- Build moves array ---
    // Strategy B: if svgMoves exist, convert to {from, to, ...} format
    //             and simplify only line segments (arcs pass through unchanged)
    let moves;
    if (svgMoves && svgMoves.length > 0 && startPoint) {
        // Convert svgMoves to moves with from/to pairs
        moves = [];
        let cur = { x: startPoint.x, y: startPoint.y };
        for (const sm of svgMoves) {
            if (sm.type === 'arc') {
                moves.push({
                    type: 'arc',
                    from: { ...cur },
                    to: { ...sm.to },
                    center: { ...sm.center },
                    radius: sm.radius,
                    clockwise: sm.clockwise
                });
            } else {
                moves.push({
                    type: 'line',
                    from: { ...cur },
                    to: { ...sm.to }
                });
            }
            cur = { x: sm.to.x, y: sm.to.y };
        }

        // Simplify consecutive line segments (skip arcs)
        // Collect runs of lines, apply Douglas-Peucker, then merge collinear
        moves = simplifyLineMoves(moves);
    } else {
        // Fallback: old path from points only
        moves = optimizePath(points, {
            simplifyTolerance: 0.005,
            arcTolerance: 0.02,
            minArcRadius: 0.5,
            maxArcRadius: 50000,
            enableArcFitting: false,
        });
    }

    if (!moves || moves.length === 0) return [];

    // Compute total path length for tab intervals
    let totalLen = 0;
    for (const m of moves) {
        if (m.type === 'arc') {
            totalLen += arcMoveLength(m);
        } else {
            totalLen += Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
        }
    }

    const tabIntervals = buildTabIntervals(totalLen, tabCount, tabWidth);

    const startX = moves[0].from.x;
    const startY = moves[0].from.y;

    // Check if path is closed
    const lastMove = moves[moves.length - 1];
    const isClosed = Math.hypot(lastMove.to.x - startX, lastMove.to.y - startY) < 0.01;

    for (let li = 0; li < zLevels.length; li++) {
        const z = zLevels[li];
        const tabActive = tabIntervals.length && Number.isFinite(tabZ) && z < tabZ - 1e-6;
        let dist = 0;

        // Ramp entry for closed paths (except first layer if only 1 layer)
        const useRamp = isClosed && zLevels.length > 1 && li > 0;

        lines.push(`G0 Z${fmt(safeZ)}`);
        lines.push(`G0 X${fmt(startX)} Y${fmt(startY)}`);

        if (useRamp) {
            // Ramp entry: plunge gradually over the first move
            const prevZ = li > 0 ? zLevels[li - 1] : 0;
            lines.push(`G1 Z${fmt(prevZ)} F${fmt(feedZ)}`);
            // Ramp down over the first segment
            const firstMove = moves[0];
            if (firstMove.type === 'line') {
                const rampLen = Math.hypot(firstMove.to.x - firstMove.from.x, firstMove.to.y - firstMove.from.y);
                if (rampLen > 0.1) {
                    // Ramp by moving XY and Z simultaneously
                    const rampFeed = Math.min(feedXY, Math.sqrt(feedXY * feedXY + feedZ * feedZ));
                    lines.push(`G1 X${fmt(firstMove.to.x)} Y${fmt(firstMove.to.y)} Z${fmt(z)} F${fmt(rampFeed)}`);
                    dist += rampLen;
                    // Continue from move index 1
                    for (let mi = 1; mi < moves.length; mi++) {
                        dist = emitOptimizedMove(lines, moves[mi], z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
                    }
                    // Closing cut: only on final layer — intermediate layers are re-cut by the next pass
                    if (li === zLevels.length - 1) {
                        emitOptimizedMove(lines, firstMove, z, tabZ, tabIntervals, 0, feedXY, feedZ, tabActive);
                    }
                    lines.push(`G0 Z${fmt(safeZ)}`);
                    continue;
                }
            }
            // Fallback: normal plunge
            lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);
        } else {
            lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);
        }

        for (const move of moves) {
            dist = emitOptimizedMove(lines, move, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
        }

        // Close path if not already closed
        if (!isClosed) {
            // nothing — open path stays open
        }

        lines.push(`G0 Z${fmt(safeZ)}`);
    }

    return lines;
}

/**
 * Emit a single optimized move (line or arc) with tab support
 */
function emitOptimizedMove(lines, move, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive) {
    if (move.type === 'arc') {
        return emitArcMove(lines, move, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
    } else {
        return addLineWithTabs(lines, move.from, move.to, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
    }
}

/**
 * Emit an arc move (G2/G3) with tab support
 */
function emitArcMove(lines, move, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive) {
    const { from, to, center, clockwise } = move;

    // Calculate I, J (relative center offsets from start point)
    const iOff = center.x - from.x;
    const jOff = center.y - from.y;

    const arcLen = arcMoveLength(move);
    const cmd = clockwise ? 'G2' : 'G3';

    if (!tabActive || !tabIntervals.length || !Number.isFinite(tabZ)) {
        lines.push(`${cmd} X${fmt(to.x)} Y${fmt(to.y)} I${fmt(iOff)} J${fmt(jOff)} F${fmt(feedXY)}`);
        return dist + arcLen;
    }

    // Check if any tab interval overlaps this arc segment
    let hasOverlap = false;
    for (const interval of tabIntervals) {
        if (interval.start < dist + arcLen && interval.end > dist) {
            hasOverlap = true;
            break;
        }
    }

    if (!hasOverlap) {
        lines.push(`${cmd} X${fmt(to.x)} Y${fmt(to.y)} I${fmt(iOff)} J${fmt(jOff)} F${fmt(feedXY)}`);
        return dist + arcLen;
    }

    // Tab overlaps arc — need to break into sub-arcs
    const radius = Math.hypot(iOff, jOff);
    const startAngle = Math.atan2(from.y - center.y, from.x - center.x);

    let cursor = 0;
    for (const interval of tabIntervals) {
        if (interval.end <= dist || interval.start >= dist + arcLen) continue;
        const localStart = Math.max(0, interval.start - dist);
        const localEnd = Math.min(arcLen, interval.end - dist);

        if (localStart > cursor + 1e-6) {
            // Emit normal arc up to tab start
            const aEnd = startAngle + (clockwise ? -1 : 1) * (localStart / radius);
            const ex = center.x + radius * Math.cos(aEnd);
            const ey = center.y + radius * Math.sin(aEnd);
            const aCurr = startAngle + (clockwise ? -1 : 1) * (cursor / radius);
            const sx = center.x + radius * Math.cos(aCurr);
            const sy = center.y + radius * Math.sin(aCurr);
            const ci = center.x - sx;
            const cj = center.y - sy;
            lines.push(`${cmd} X${fmt(ex)} Y${fmt(ey)} I${fmt(ci)} J${fmt(cj)} F${fmt(feedXY)}`);
        }

        if (localEnd > localStart + 1e-6) {
            // Raise to tab Z
            lines.push(`G1 Z${fmt(tabZ)} F${fmt(feedZ)}`);
            // Emit arc at tab height
            const aStart2 = startAngle + (clockwise ? -1 : 1) * (localStart / radius);
            const aEnd2 = startAngle + (clockwise ? -1 : 1) * (localEnd / radius);
            const sx2 = center.x + radius * Math.cos(aStart2);
            const sy2 = center.y + radius * Math.sin(aStart2);
            const ex2 = center.x + radius * Math.cos(aEnd2);
            const ey2 = center.y + radius * Math.sin(aEnd2);
            const ci2 = center.x - sx2;
            const cj2 = center.y - sy2;
            lines.push(`${cmd} X${fmt(ex2)} Y${fmt(ey2)} I${fmt(ci2)} J${fmt(cj2)} F${fmt(feedXY)}`);
            // Return to cut depth
            lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);
        }
        cursor = Math.max(cursor, localEnd);
    }

    if (cursor < arcLen - 1e-6) {
        // Emit remaining arc
        const aCurr = startAngle + (clockwise ? -1 : 1) * (cursor / radius);
        const sx = center.x + radius * Math.cos(aCurr);
        const sy = center.y + radius * Math.sin(aCurr);
        const ci = center.x - sx;
        const cj = center.y - sy;
        lines.push(`${cmd} X${fmt(to.x)} Y${fmt(to.y)} I${fmt(ci)} J${fmt(cj)} F${fmt(feedXY)}`);
    }

    return dist + arcLen;
}

/**
 * Calculate arc move length
 */
function arcMoveLength(move) {
    const { from, to, center, radius, clockwise } = move;
    const r = radius || Math.hypot(center.x - from.x, center.y - from.y);
    const a1 = Math.atan2(from.y - center.y, from.x - center.x);
    const a2 = Math.atan2(to.y - center.y, to.x - center.x);
    let sweep = clockwise ? (a1 - a2) : (a2 - a1);
    if (sweep < 0) sweep += Math.PI * 2;
    if (sweep > Math.PI * 2) sweep -= Math.PI * 2;
    return Math.abs(sweep) * r;
}

export function profileTangentHullOps({
    circles,
    safeZ,
    cutDepth,
    stepdown,
    feedXY,
    feedZ,
    tabWidth,
    tabCount,
    tabZ,
}) {
    if (!circles || circles.length < 2) return [];

    const getTangent = (c1, c2) => {
        const dx = c2.x - c1.x;
        const dy = c2.y - c1.y;
        const dist = Math.hypot(dx, dy);
        if (dist === 0) return null;
        const nx = dy / dist;
        const ny = -dx / dist;
        return {
            start: { x: c1.x + nx * c1.r, y: c1.y + ny * c1.r },
            end: { x: c2.x + nx * c2.r, y: c2.y + ny * c2.r }
        };
    };

    const tangents = [];
    const n = circles.length;
    for (let i = 0; i < n; i++) {
        const t = getTangent(circles[i], circles[(i + 1) % n]);
        if (!t) return [];
        tangents.push(t);
    }

    const cross = (ax, ay, bx, by) => ax * by - ay * bx;

    const arcMeta = [];
    let totalLen = 0;
    for (let i = 0; i < n; i++) {
        const curr = tangents[i];
        const next = tangents[(i + 1) % n];
        const lineLen = Math.hypot(curr.end.x - curr.start.x, curr.end.y - curr.start.y);

        const cNext = circles[(i + 1) % n];
        const v1x = curr.end.x - cNext.x;
        const v1y = curr.end.y - cNext.y;
        const v2x = next.start.x - cNext.x;
        const v2y = next.start.y - cNext.y;
        const ccw = cross(v1x, v1y, v2x, v2y) > 0;
        const startA = Math.atan2(v1y, v1x);
        const endA = Math.atan2(v2y, v2x);
        let sweep = ccw ? (endA - startA) : (startA - endA);
        if (sweep < 0) sweep += Math.PI * 2;
        const arcLen = Math.abs(sweep) * cNext.r;
        arcMeta.push({ center: cNext, r: cNext.r, startA, endA, ccw, arcLen, lineLen });
        totalLen += lineLen + arcLen;
    }

    const tabIntervals = buildTabIntervals(totalLen, tabCount, tabWidth);

    const zLevels = [];
    const total = Math.abs(cutDepth);
    const sd = Math.abs(stepdown);
    const steps = Math.max(1, Math.ceil(total / sd));
    for (let i = 1; i <= steps; i++) {
        zLevels.push(-Math.min(i * sd, total));
    }

    const lines = [];
    lines.push("(Profile tangent hull)");

    for (const z of zLevels) {
        const tabActive = tabIntervals.length && Number.isFinite(tabZ) && z < tabZ - 1e-6;
        let dist = 0;
        let currPos = tangents[0].start;

        lines.push(`G0 Z${fmt(safeZ)}`);
        lines.push(`G0 X${fmt(currPos.x)} Y${fmt(currPos.y)}`);
        lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);

        for (let i = 0; i < n; i++) {
            const curr = tangents[i];
            const next = tangents[(i + 1) % n];
            const meta = arcMeta[i];

            dist = addLineWithTabs(lines, currPos, curr.end, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
            dist = addArcWithTabs(lines, { x: meta.center.x, y: meta.center.y }, meta.r, meta.startA, meta.endA, meta.ccw, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
            currPos = next.start;
        }

        lines.push(`G0 Z${fmt(safeZ)}`);
    }

    return lines;
}

function flattenPathMoves(startPoint, moves, stepMm = 0.5) {
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
            points[points.length - 1] = { x: move.to.x, y: move.to.y };
        } else {
            pushPoint(move.to);
        }
        cur = { x: move.to.x, y: move.to.y };
    }

    return points;
}

function computePolygonArea(points) {
    let area = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        area += (p1.x * p2.y - p2.x * p1.y);
    }
    return area / 2;
}

function normalizeOffsetPoints(points) {
    if (!points || points.length < 2) return points || [];

    const filtered = [];
    for (const pt of points) {
        const last = filtered[filtered.length - 1];
        if (!last || Math.hypot(last.x - pt.x, last.y - pt.y) > 1e-6) {
            filtered.push({ x: pt.x, y: pt.y });
        }
    }

    if (filtered.length < 2) return filtered;

    const isClosed = Math.hypot(filtered[0].x - filtered[filtered.length - 1].x, filtered[0].y - filtered[filtered.length - 1].y) < 1e-6;
    if (isClosed) {
        filtered[filtered.length - 1] = { ...filtered[0] };
    }

    return filtered;
}

function getLeftNormal(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return { nx: 0, ny: 0 };
    return { nx: -dy / len, ny: dx / len };
}

function intersectLineLine(a1, a2, b1, b2) {
    const dax = a2.x - a1.x;
    const day = a2.y - a1.y;
    const dbx = b2.x - b1.x;
    const dby = b2.y - b1.y;
    const denom = dax * dby - day * dbx;
    if (Math.abs(denom) < 1e-9) return null;

    const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom;
    return { x: a1.x + dax * t, y: a1.y + day * t };
}

function intersectLineCircle(line, circle, hint) {
    const dx = line.p2.x - line.p1.x;
    const dy = line.p2.y - line.p1.y;
    const fx = line.p1.x - circle.center.x;
    const fy = line.p1.y - circle.center.y;

    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - circle.radius * circle.radius;
    const disc = b * b - 4 * a * c;
    if (disc < -1e-9 || a < 1e-9) return null;

    const roots = [];
    if (Math.abs(disc) < 1e-9) {
        roots.push(-b / (2 * a));
    } else {
        const s = Math.sqrt(Math.max(0, disc));
        roots.push((-b - s) / (2 * a), (-b + s) / (2 * a));
    }

    const points = roots.map(t => ({ x: line.p1.x + dx * t, y: line.p1.y + dy * t }));
    if (!points.length) return null;
    if (points.length === 1) return points[0];

    return points.reduce((best, pt) => {
        const bestDist = Math.hypot(best.x - hint.x, best.y - hint.y);
        const dist = Math.hypot(pt.x - hint.x, pt.y - hint.y);
        return dist < bestDist ? pt : best;
    });
}

function intersectCircleCircle(a, b, hint) {
    const dx = b.center.x - a.center.x;
    const dy = b.center.y - a.center.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) return null;
    if (d > a.radius + b.radius + 1e-6) return null;
    if (d < Math.abs(a.radius - b.radius) - 1e-6) return null;

    const aa = (a.radius * a.radius - b.radius * b.radius + d * d) / (2 * d);
    const hSq = a.radius * a.radius - aa * aa;
    if (hSq < -1e-6) return null;
    const h = Math.sqrt(Math.max(0, hSq));

    const xm = a.center.x + (aa * dx) / d;
    const ym = a.center.y + (aa * dy) / d;

    const rx = -dy * (h / d);
    const ry = dx * (h / d);

    const p1 = { x: xm + rx, y: ym + ry };
    const p2 = { x: xm - rx, y: ym - ry };
    if (Math.hypot(p1.x - p2.x, p1.y - p2.y) < 1e-6) return p1;

    return Math.hypot(p1.x - hint.x, p1.y - hint.y) <= Math.hypot(p2.x - hint.x, p2.y - hint.y) ? p1 : p2;
}

function fallbackJoinPoint(prevPrimitive, nextPrimitive, hint) {
    if (prevPrimitive.type === 'line' || nextPrimitive.type === 'line') {
        const line = prevPrimitive.type === 'line' ? prevPrimitive : nextPrimitive;
        const dx = line.p2.x - line.p1.x;
        const dy = line.p2.y - line.p1.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq > 1e-9) {
            const t = ((hint.x - line.p1.x) * dx + (hint.y - line.p1.y) * dy) / lenSq;
            return { x: line.p1.x + dx * t, y: line.p1.y + dy * t };
        }
    }

    if (prevPrimitive.type === 'arc' || nextPrimitive.type === 'arc') {
        const arc = prevPrimitive.type === 'arc' ? prevPrimitive : nextPrimitive;
        const vx = hint.x - arc.center.x;
        const vy = hint.y - arc.center.y;
        const len = Math.hypot(vx, vy);
        if (len > 1e-9) {
            return {
                x: arc.center.x + (vx / len) * arc.radius,
                y: arc.center.y + (vy / len) * arc.radius
            };
        }
    }

    return { x: hint.x, y: hint.y };
}

function intersectOffsetPrimitives(prevPrimitive, nextPrimitive, hint) {
    let pt = null;
    if (prevPrimitive.type === 'line' && nextPrimitive.type === 'line') {
        pt = intersectLineLine(prevPrimitive.p1, prevPrimitive.p2, nextPrimitive.p1, nextPrimitive.p2);
    } else if (prevPrimitive.type === 'line' && nextPrimitive.type === 'arc') {
        pt = intersectLineCircle(prevPrimitive, nextPrimitive, hint);
    } else if (prevPrimitive.type === 'arc' && nextPrimitive.type === 'line') {
        pt = intersectLineCircle(nextPrimitive, prevPrimitive, hint);
    } else if (prevPrimitive.type === 'arc' && nextPrimitive.type === 'arc') {
        pt = intersectCircleCircle(prevPrimitive, nextPrimitive, hint);
    }

    return pt || fallbackJoinPoint(prevPrimitive, nextPrimitive, hint);
}

function getPrimitiveVertexOffset(seg, primitive, vertex, sideSign, offsetMag) {
    if (primitive.type === 'line') {
        const normal = getLeftNormal(seg.from, seg.to);
        return {
            x: vertex.x + normal.nx * sideSign * offsetMag,
            y: vertex.y + normal.ny * sideSign * offsetMag
        };
    }

    if (primitive.type === 'arc' && seg.center && Number.isFinite(seg.radius)) {
        const vx = vertex.x - seg.center.x;
        const vy = vertex.y - seg.center.y;
        const len = Math.hypot(vx, vy);
        if (len > 1e-9) {
            const radiusShift = sideSign * (seg.clockwise ? offsetMag : -offsetMag);
            const nextRadius = seg.radius + radiusShift;
            return {
                x: seg.center.x + (vx / len) * nextRadius,
                y: seg.center.y + (vy / len) * nextRadius
            };
        }
    }

    return null;
}

function computeJoinPointAtVertex(prevSeg, prevPrimitive, nextSeg, nextPrimitive, vertex, sideSign, offsetMag) {
    const prevCandidate = getPrimitiveVertexOffset(prevSeg, prevPrimitive, vertex, sideSign, offsetMag);
    const nextCandidate = getPrimitiveVertexOffset(nextSeg, nextPrimitive, vertex, sideSign, offsetMag);

    if (prevCandidate && nextCandidate) {
        const gap = Math.hypot(prevCandidate.x - nextCandidate.x, prevCandidate.y - nextCandidate.y);
        if (gap < 0.05) {
            return {
                x: (prevCandidate.x + nextCandidate.x) / 2,
                y: (prevCandidate.y + nextCandidate.y) / 2
            };
        }
    }

    return intersectOffsetPrimitives(prevPrimitive, nextPrimitive, vertex);
}

function computeArcSweep(from, to, center, clockwise) {
    const a1 = Math.atan2(from.y - center.y, from.x - center.x);
    const a2 = Math.atan2(to.y - center.y, to.x - center.x);
    let sweep = clockwise ? (a1 - a2) : (a2 - a1);
    if (sweep < 0) sweep += Math.PI * 2;
    return sweep;
}

export function offsetClosedPathMoves(startPoint, moves, offsetDist) {
    if (!startPoint || !moves || moves.length < 2 || !Number.isFinite(offsetDist) || Math.abs(offsetDist) < 1e-9) {
        return null;
    }

    const segments = [];
    let cur = { x: startPoint.x, y: startPoint.y };
    for (const move of moves) {
        const seg = { ...move, from: { ...cur }, to: { ...move.to } };
        segments.push(seg);
        cur = { x: move.to.x, y: move.to.y };
    }

    const last = segments[segments.length - 1];
    const isClosed = Math.hypot(last.to.x - startPoint.x, last.to.y - startPoint.y) < 0.01;
    if (!isClosed) return null;

    const flatPoints = flattenPathMoves(startPoint, moves, 0.5);
    const area = computePolygonArea(flatPoints);
    const isCW = area < 0;
    const sideSign = (offsetDist >= 0 ? 1 : -1) * (isCW ? 1 : -1); // +1 = left, -1 = right
    const offsetMag = Math.abs(offsetDist);

    const primitives = segments.map(seg => {
        if (seg.type === 'arc' && seg.center && Number.isFinite(seg.radius)) {
            const radiusShift = sideSign * (seg.clockwise ? offsetMag : -offsetMag);
            const nextRadius = seg.radius + radiusShift;
            if (!Number.isFinite(nextRadius) || nextRadius <= 1e-6) {
                return null;
            }
            return {
                type: 'arc',
                center: { ...seg.center },
                radius: nextRadius,
                clockwise: seg.clockwise,
                originalSweep: computeArcSweep(seg.from, seg.to, seg.center, seg.clockwise)
            };
        }

        const normal = getLeftNormal(seg.from, seg.to);
        const ox = normal.nx * sideSign * offsetMag;
        const oy = normal.ny * sideSign * offsetMag;
        return {
            type: 'line',
            p1: { x: seg.from.x + ox, y: seg.from.y + oy },
            p2: { x: seg.to.x + ox, y: seg.to.y + oy }
        };
    });

    if (primitives.some(p => !p)) return null;

    const joinPoints = [];
    for (let i = 0; i < segments.length; i++) {
        const prevIdx = (i - 1 + segments.length) % segments.length;
        joinPoints[i] = computeJoinPointAtVertex(
            segments[prevIdx],
            primitives[prevIdx],
            segments[i],
            primitives[i],
            segments[prevIdx].to,
            sideSign,
            offsetMag
        );
    }

    const offsetMoves = [];
    for (let i = 0; i < segments.length; i++) {
        const startPointForMove = joinPoints[i];
        const endPoint = joinPoints[(i + 1) % segments.length];
        const primitive = primitives[i];
        if (primitive.type === 'arc') {
            const cwSweep = computeArcSweep(startPointForMove, endPoint, primitive.center, true);
            const ccwSweep = computeArcSweep(startPointForMove, endPoint, primitive.center, false);
            const cwError = Math.abs(cwSweep - primitive.originalSweep);
            const ccwError = Math.abs(ccwSweep - primitive.originalSweep);
            const clockwise = Math.abs(cwError - ccwError) <= 1e-6
                ? primitive.clockwise
                : cwError < ccwError;
            offsetMoves.push({
                type: 'arc',
                to: { ...endPoint },
                center: { ...primitive.center },
                radius: primitive.radius,
                clockwise
            });
        } else {
            offsetMoves.push({
                type: 'line',
                to: { ...endPoint }
            });
        }
    }

    return {
        startPoint: { ...joinPoints[0] },
        moves: offsetMoves,
        points: flattenPathMoves(joinPoints[0], offsetMoves, 0.5)
    };
}

export function offsetPath(points, offsetDist) {
    if (!points || points.length < 2 || offsetDist === 0) return points;

    points = normalizeOffsetPoints(points);
    if (points.length < 2) return points;

    const result = [];
    const n = points.length;
    // Check if closed
    const isClosed = Math.abs(points[0].x - points[n - 1].x) < 0.001 && Math.abs(points[0].y - points[n - 1].y) < 0.001;

    // Points are already in CNC space (Y up), so negative area means clockwise.
    const area = computePolygonArea(isClosed ? points : [...points, points[0]]);
    const isCW = area < 0;

    const getNormal = (p1, p2) => {
        let dx = p2.x - p1.x;
        let dy = p2.y - p1.y;
        let len = Math.hypot(dx, dy);
        if (len === 0) return { nx: 0, ny: 0 };

        if (isCW) {
            const left = getLeftNormal(p1, p2);
            return left;
        }

        const left = getLeftNormal(p1, p2);
        return { nx: -left.nx, ny: -left.ny };
    };

    // Calculate normals for each segment
    const normals = [];
    for (let i = 0; i < n - 1; i++) {
        normals.push(getNormal(points[i], points[i + 1]));
    }
    if (isClosed) {
        normals.push(normals[0]); // Last point matches first point
    }

    // Offset each point by averaging normals of adjacent segments
    for (let i = 0; i < n - 1; i++) {
        let prevN, nextN;
        if (i === 0) {
            prevN = isClosed ? normals[normals.length - 2] : normals[0];
            nextN = normals[0];
        } else {
            prevN = normals[i - 1];
            nextN = normals[i];
        }

        // If a segment has 0 length and gave a 0 normal, borrow from the other
        if (prevN.nx === 0 && prevN.ny === 0) prevN = nextN;
        if (nextN.nx === 0 && nextN.ny === 0) nextN = prevN;

        // Average normal
        let avgNx = prevN.nx + nextN.nx;
        let avgNy = prevN.ny + nextN.ny;
        let len = Math.hypot(avgNx, avgNy);

        // If normals cancel each other out (e.g. 180 degree turn), fallback to one of them
        if (len < 0.001) {
            avgNx = nextN.nx;
            avgNy = nextN.ny;
            len = Math.hypot(avgNx, avgNy);
        }

        avgNx /= len;
        avgNy /= len;

        // Apply offset (miter-like expansion)
        // dot(avgN, N1) helps scale the offset for corners
        let dot = avgNx * nextN.nx + avgNy * nextN.ny;
        let miterDist = offsetDist;

        // Avoid huge spikes on sharp angles by checking dot product limit
        if (dot > 0.2) {
            miterDist = offsetDist / dot;
        } else {
            // For very sharp angles, just use the offset to avoid shooting into space
            miterDist = offsetDist;
        }

        // Hard cap the miter joint to 2.5x the offset distance to prevent artifacts 
        // from Bezier curve approximation artifacts.
        if (Math.abs(miterDist) > Math.abs(offsetDist * 2.5)) {
            miterDist = offsetDist * 2.5 * Math.sign(miterDist);
        }

        result.push({
            x: points[i].x + avgNx * miterDist,
            y: points[i].y + avgNy * miterDist
        });
    }

    // handle the last point
    if (isClosed) {
        result.push({ x: result[0].x, y: result[0].y });
    } else {
        // for open path, just use the last normal
        let prevN = normals[n - 2];
        if (!prevN) prevN = { nx: 0, ny: 0 };
        result.push({
            x: points[n - 1].x + prevN.nx * offsetDist,
            y: points[n - 1].y + prevN.ny * offsetDist
        });
    }

    return result;
}
