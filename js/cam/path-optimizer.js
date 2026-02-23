/**
 * Path Optimizer Module
 * 路徑優化模組 — 減少 CNC 抖動
 * 
 * 1. Douglas-Peucker 路徑簡化（去除共線冗餘點）
 * 2. 圓弧擬合（Arc Fitting）— 將連續小線段轉成 G2/G3
 * 3. 合併直線段
 *
 * Safety-first: only fit arcs when the geometry is clearly circular.
 * When in doubt, keep lines — CNC controllers handle G1 well with G64.
 */

/**
 * Douglas-Peucker 路徑簡化演算法
 * @param {Array<{x:number, y:number}>} points
 * @param {number} tolerance - mm, default 0.01
 * @returns {Array<{x:number, y:number}>}
 */
export function simplifyPath(points, tolerance = 0.01) {
    if (!points || points.length < 3) return points ? [...points] : [];

    const sqTol = tolerance * tolerance;
    const kept = new Uint8Array(points.length);
    kept[0] = 1;
    kept[points.length - 1] = 1;

    const stack = [[0, points.length - 1]];

    while (stack.length > 0) {
        const [start, end] = stack.pop();
        if (end - start < 2) continue;

        let maxDist = 0;
        let maxIdx = start;

        const dx = points[end].x - points[start].x;
        const dy = points[end].y - points[start].y;
        const lenSq = dx * dx + dy * dy;

        for (let i = start + 1; i < end; i++) {
            let dist;
            if (lenSq === 0) {
                const ex = points[i].x - points[start].x;
                const ey = points[i].y - points[start].y;
                dist = ex * ex + ey * ey;
            } else {
                const t = Math.max(0, Math.min(1,
                    ((points[i].x - points[start].x) * dx + (points[i].y - points[start].y) * dy) / lenSq
                ));
                const projX = points[start].x + t * dx;
                const projY = points[start].y + t * dy;
                const ex = points[i].x - projX;
                const ey = points[i].y - projY;
                dist = ex * ex + ey * ey;
            }
            if (dist > maxDist) {
                maxDist = dist;
                maxIdx = i;
            }
        }

        if (maxDist > sqTol) {
            kept[maxIdx] = 1;
            stack.push([start, maxIdx]);
            stack.push([maxIdx, end]);
        }
    }

    const result = [];
    for (let i = 0; i < points.length; i++) {
        if (kept[i]) result.push(points[i]);
    }
    return result;
}


/**
 * 三點定圓（外接圓）
 * @returns {{ cx, cy, r }} or null (collinear)
 */
function circumscribedCircle(p1, p2, p3) {
    const ax = p1.x, ay = p1.y;
    const bx = p2.x, by = p2.y;
    const cx = p3.x, cy = p3.y;

    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-10) return null;

    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    const r = Math.hypot(ax - ux, ay - uy);

    return { cx: ux, cy: uy, r };
}


/**
 * Arc fitting with conservative safety checks.
 *
 * Key safety rules:
 *  - Minimum 3 points to define an arc
 *  - Minimum sweep angle of 15 deg (smaller arcs are just lines)
 *  - Maximum sweep angle of 350 deg (near-full circles cause IJ errors)
 *  - Arc sagitta (chord-height) must be > threshold (otherwise it is a line)
 *  - All intermediate points must lie within tolerance of the fitted circle
 *  - Maximum arc radius capped (huge radius = basically a line)
 */
export function fitArcs(points, tolerance = 0.02, minArcRadius = 0.5, maxArcRadius = 50000) {
    if (!points || points.length < 2) return [];
    if (points.length === 2) {
        return [{ type: 'line', from: points[0], to: points[1] }];
    }

    const MIN_SWEEP_DEG = 15;
    const MAX_SWEEP_DEG = 350;
    const MIN_SAGITTA = tolerance * 2;

    const moves = [];
    let i = 0;

    while (i < points.length - 1) {
        if (i + 2 >= points.length) {
            moves.push({ type: 'line', from: points[i], to: points[i + 1] });
            i++;
            continue;
        }

        const arcResult = tryFitArcSafe(points, i, tolerance, minArcRadius, maxArcRadius, MIN_SWEEP_DEG, MAX_SWEEP_DEG, MIN_SAGITTA);

        if (arcResult) {
            moves.push({
                type: 'arc',
                from: points[i],
                to: points[arcResult.endIdx],
                center: arcResult.center,
                radius: arcResult.radius,
                clockwise: arcResult.clockwise
            });
            i = arcResult.endIdx;
        } else {
            moves.push({ type: 'line', from: points[i], to: points[i + 1] });
            i++;
        }
    }

    return moves;
}


/**
 * Safe arc fitting with multiple geometric checks
 */
function tryFitArcSafe(points, startIdx, tolerance, minR, maxR, minSweepDeg, maxSweepDeg, minSagitta) {
    if (startIdx + 2 >= points.length) return null;

    const p0 = points[startIdx];
    const p1 = points[startIdx + 1];
    const p2 = points[startIdx + 2];

    const circle = circumscribedCircle(p0, p1, p2);
    if (!circle) return null;
    if (circle.r < minR || circle.r > maxR) return null;

    // Determine arc direction
    const cross0 = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    const clockwise = cross0 < 0;

    const a0 = Math.atan2(p0.y - circle.cy, p0.x - circle.cx);

    // Extend the arc
    let endIdx = startIdx + 2;

    for (let j = startIdx + 3; j < points.length; j++) {
        const pt = points[j];

        const distFromCircle = Math.abs(Math.hypot(pt.x - circle.cx, pt.y - circle.cy) - circle.r);
        if (distFromCircle > tolerance) break;

        const prevPt = points[j - 1];
        const crossCheck = (pt.x - prevPt.x) * (circle.cy - prevPt.y) - (pt.y - prevPt.y) * (circle.cx - prevPt.x);
        const localCW = crossCheck < 0;
        if (localCW !== clockwise) break;

        const aJ = Math.atan2(pt.y - circle.cy, pt.x - circle.cx);
        let sweep = clockwise ? (a0 - aJ) : (aJ - a0);
        if (sweep < 0) sweep += Math.PI * 2;
        if (sweep > Math.PI * 2) sweep -= Math.PI * 2;
        if (sweep * 180 / Math.PI > maxSweepDeg) break;

        endIdx = j;
    }

    if (endIdx - startIdx < 2) return null;

    // Refit circle using first, middle, last for better accuracy
    const midIdx = Math.floor((startIdx + endIdx) / 2);
    const refined = circumscribedCircle(points[startIdx], points[midIdx], points[endIdx]);
    const finalCircle = refined || circle;

    if (finalCircle.r < minR || finalCircle.r > maxR) return null;

    // Verify ALL intermediate points
    for (let j = startIdx; j <= endIdx; j++) {
        const pt = points[j];
        const d = Math.abs(Math.hypot(pt.x - finalCircle.cx, pt.y - finalCircle.cy) - finalCircle.r);
        if (d > tolerance) {
            endIdx = j - 1;
            break;
        }
    }

    if (endIdx - startIdx < 2) return null;

    // Final sweep angle check
    const aStart = Math.atan2(points[startIdx].y - finalCircle.cy, points[startIdx].x - finalCircle.cx);
    const aEnd = Math.atan2(points[endIdx].y - finalCircle.cy, points[endIdx].x - finalCircle.cx);
    let finalSweep = clockwise ? (aStart - aEnd) : (aEnd - aStart);
    if (finalSweep < 0) finalSweep += Math.PI * 2;
    if (finalSweep > Math.PI * 2) finalSweep -= Math.PI * 2;
    const finalSweepDeg = finalSweep * 180 / Math.PI;

    if (finalSweepDeg < minSweepDeg) return null;
    if (finalSweepDeg > maxSweepDeg) return null;

    // Sagitta check — arc must bulge enough to be worth it
    const chordLen = Math.hypot(
        points[endIdx].x - points[startIdx].x,
        points[endIdx].y - points[startIdx].y
    );
    const halfChord = chordLen / 2;
    let sagitta;
    if (halfChord >= finalCircle.r) {
        sagitta = finalCircle.r;
    } else {
        sagitta = finalCircle.r - Math.sqrt(finalCircle.r * finalCircle.r - halfChord * halfChord);
    }

    if (sagitta < minSagitta) return null;

    return {
        center: { x: finalCircle.cx, y: finalCircle.cy },
        radius: finalCircle.r,
        endIdx,
        clockwise
    };
}


/**
 * 合併連續共線的直線段
 */
export function mergeCollinearLines(moves, angleTolerance = 0.001) {
    if (!moves || moves.length < 2) return moves || [];

    const result = [moves[0]];

    for (let i = 1; i < moves.length; i++) {
        const prev = result[result.length - 1];
        const curr = moves[i];

        if (prev.type === 'line' && curr.type === 'line') {
            const a1 = Math.atan2(prev.to.y - prev.from.y, prev.to.x - prev.from.x);
            const a2 = Math.atan2(curr.to.y - curr.from.y, curr.to.x - curr.from.x);
            let diff = Math.abs(a1 - a2);
            if (diff > Math.PI) diff = 2 * Math.PI - diff;

            if (diff < angleTolerance) {
                prev.to = curr.to;
                continue;
            }
        }

        result.push(curr);
    }

    return result;
}


/**
 * 完整的路徑優化管線
 */
export function optimizePath(points, options = {}) {
    const {
        simplifyTolerance = 0.005,
        arcTolerance = 0.02,
        minArcRadius = 0.5,
        maxArcRadius = 50000,
        angleTolerance = 0.002,
        enableArcFitting = true,
    } = options;

    // Step 1: Simplify
    const simplified = simplifyPath(points, simplifyTolerance);

    // Step 2: Arc fitting (conservative)
    let moves;
    if (enableArcFitting && simplified.length >= 3) {
        moves = fitArcs(simplified, arcTolerance, minArcRadius, maxArcRadius);
    } else {
        moves = [];
        for (let i = 0; i < simplified.length - 1; i++) {
            moves.push({ type: 'line', from: simplified[i], to: simplified[i + 1] });
        }
    }

    // Step 3: Merge collinear lines
    moves = mergeCollinearLines(moves, angleTolerance);

    return moves;
}
