/**
 * G-code Operations
 */

import { fmt } from '../utils.js';

function normalizePostProcessor(postProcessor) {
    const val = String(postProcessor || '').toLowerCase();
    return val === 'mach3' ? 'mach3' : 'grbl';
}

export function gcodeHeader({ safeZ, spindle, postProcessor }) {
    const lines = [];
    const post = normalizePostProcessor(postProcessor);
    lines.push(`(MVP 4-BAR PARTS, ${post === 'mach3' ? 'MACH3' : 'GRBL'})`);
    lines.push("G21  (MM)");
    lines.push("G90  (ABSOLUTE)");
    lines.push("G17  (XY PLANE)");
    lines.push("G94  (FEED PER MINUTE)");
    if (post === 'mach3') {
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
    for (const h of holes) {
        lines.push(`G0 Z${fmt(safeZ)}`);
        lines.push(`G0 X${fmt(h.x)} Y${fmt(h.y)}`);
        lines.push(`G1 Z${fmt(drillZ)} F${fmt(feedZ)}`);
        lines.push(`G0 Z${fmt(safeZ)}`);
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

export function profilePathOps({
    points,
    safeZ,
    cutDepth,
    stepdown,
    feedXY,
    feedZ,
    tabWidth,
    tabCount,
    tabZ
}) {
    if (!points || points.length < 2) return [];

    const lines = [];
    lines.push("(Profile arbitrary path)");

    const zLevels = [];
    const total = Math.abs(cutDepth);
    const sd = Math.abs(stepdown);
    const n = Math.max(1, Math.ceil(total / sd));
    for (let i = 1; i <= n; i++) {
        zLevels.push(-Math.min(i * sd, total));
    }

    let totalLen = 0;
    for (let i = 1; i < points.length; i++) {
        const dx = points[i].x - points[i - 1].x;
        const dy = points[i].y - points[i - 1].y;
        totalLen += Math.hypot(dx, dy);
    }
    const lastP = points[points.length - 1];
    if (lastP.x !== points[0].x || lastP.y !== points[0].y) {
        totalLen += Math.hypot(points[0].x - lastP.x, points[0].y - lastP.y);
    }
    const tabIntervals = buildTabIntervals(totalLen, tabCount, tabWidth);

    const startX = points[0].x;
    const startY = points[0].y;

    for (const z of zLevels) {
        const tabActive = tabIntervals.length && Number.isFinite(tabZ) && z < tabZ - 1e-6;
        let dist = 0;
        lines.push(`G0 Z${fmt(safeZ)}`);
        lines.push(`G0 X${fmt(startX)} Y${fmt(startY)}`);
        lines.push(`G1 Z${fmt(z)} F${fmt(feedZ)}`);

        for (let j = 1; j < points.length; j++) {
            dist = addLineWithTabs(lines, points[j - 1], points[j], z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
        }

        if (lastP.x !== startX || lastP.y !== startY) {
            addLineWithTabs(lines, lastP, { x: startX, y: startY }, z, tabZ, tabIntervals, dist, feedXY, feedZ, tabActive);
        }

        lines.push(`G0 Z${fmt(safeZ)}`);
    }

    return lines;
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

export function offsetPath(points, offsetDist) {
    if (!points || points.length < 2 || offsetDist === 0) return points;

    const result = [];
    const n = points.length;
    // Check if closed
    const isClosed = Math.abs(points[0].x - points[n - 1].x) < 0.001 && Math.abs(points[0].y - points[n - 1].y) < 0.001;

    // Calculate signed polygon area to determine winding (CW vs CCW)
    let area = 0;
    for (let i = 0; i < n; i++) {
        let p1 = points[i];
        let p2 = points[(i + 1) % n];
        area += (p1.x * p2.y - p2.x * p1.y);
    }
    // In SVG (Y down), positive area means Clockwise. 
    const isCW = area > 0;

    // Helper: get normal vector of segment (p1 -> p2)
    const getNormal = (p1, p2) => {
        let dx = p2.x - p1.x;
        let dy = p2.y - p1.y;
        let len = Math.hypot(dx, dy);
        if (len === 0) return { nx: 0, ny: 0 };

        // If CW, the "Outside" of the shape is on the LEFT of the directed edge.
        // If CCW, the "Outside" is on the RIGHT.
        // offsetDist > 0 means Outside. 
        if (isCW) {
            // Left Normal: (dy, -dx)
            return { nx: dy / len, ny: -dx / len };
        } else {
            // Right Normal: (-dy, dx)
            return { nx: -dy / len, ny: dx / len };
        }
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
