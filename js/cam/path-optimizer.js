/**
 * Path Optimizer Module
 * 路徑優化模組 — 減少 CNC 抖動
 * 
 * 1. Douglas-Peucker 路徑簡化（去除共線冗餘點）
 * 2. 圓弧擬合（Arc Fitting）— 將連續小線段轉成 G2/G3
 * 3. 合併直線段
 */

/**
 * Douglas-Peucker 路徑簡化演算法
 * 去除在容差範圍內的冗餘點，大幅減少 G1 指令數量
 * @param {Array<{x:number, y:number}>} points - 原始點陣列
 * @param {number} tolerance - 容差（mm），建議 0.005 ~ 0.02
 * @returns {Array<{x:number, y:number}>} 簡化後的點陣列
 */
export function simplifyPath(points, tolerance = 0.01) {
    if (!points || points.length < 3) return points ? [...points] : [];

    const sqTol = tolerance * tolerance;

    // Iterative Douglas-Peucker to avoid stack overflow on large arrays
    const kept = new Uint8Array(points.length);
    kept[0] = 1;
    kept[points.length - 1] = 1;

    // Stack-based iteration
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
                // Start and end are the same point
                const ex = points[i].x - points[start].x;
                const ey = points[i].y - points[start].y;
                dist = ex * ex + ey * ey;
            } else {
                // Perpendicular distance squared
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
 * 嘗試將連續的點擬合成圓弧 (Arc Fitting)
 * 使用三點定圓法，檢測連續點是否在同一圓弧上
 * 
 * 回傳混合指令陣列：
 *   { type: 'line', to: {x,y} }
 *   { type: 'arc', to: {x,y}, center: {x,y}, clockwise: bool }
 * 
 * @param {Array<{x:number, y:number}>} points - 簡化後的點陣列
 * @param {number} arcTolerance - 圓弧擬合容差（mm），建議 0.005 ~ 0.02
 * @param {number} minArcRadius - 最小圓弧半徑（mm），過小的弧會保留為直線
 * @param {number} maxArcRadius - 最大圓弧半徑（mm），過大的弧視為直線
 * @returns {Array} 混合指令陣列
 */
export function fitArcs(points, arcTolerance = 0.01, minArcRadius = 0.5, maxArcRadius = 100000) {
    if (!points || points.length < 2) return [];
    if (points.length === 2) {
        return [{ type: 'line', from: points[0], to: points[1] }];
    }

    const moves = [];
    let i = 0;

    while (i < points.length - 1) {
        // Try to fit an arc starting at index i
        const arcResult = tryFitArc(points, i, arcTolerance, minArcRadius, maxArcRadius);

        if (arcResult && arcResult.endIdx > i + 1) {
            // Successfully fitted an arc spanning multiple points
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
            // Just a line segment
            moves.push({
                type: 'line',
                from: points[i],
                to: points[i + 1]
            });
            i++;
        }
    }

    return moves;
}

/**
 * 嘗試從 startIdx 開始擬合最長的圓弧
 */
function tryFitArc(points, startIdx, tolerance, minR, maxR) {
    if (startIdx + 2 >= points.length) return null;

    // Use first 3 points to define the initial circle
    const p0 = points[startIdx];
    const p1 = points[startIdx + 1];
    const p2 = points[startIdx + 2];

    const circle = circumscribedCircle(p0, p1, p2);
    if (!circle) return null;
    if (circle.r < minR || circle.r > maxR) return null;

    // Determine arc direction (CW or CCW)
    const cross = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    const clockwise = cross < 0;

    // Extend the arc as far as possible
    let endIdx = startIdx + 2;

    for (let j = startIdx + 3; j < points.length; j++) {
        const pt = points[j];
        const dist = Math.abs(Math.hypot(pt.x - circle.cx, pt.y - circle.cy) - circle.r);
        if (dist > tolerance) break;

        // Also check that the arc direction stays consistent
        const prevPt = points[j - 1];
        const crossCheck = (pt.x - prevPt.x) * (circle.cy - prevPt.y) - (pt.y - prevPt.y) * (circle.cx - prevPt.x);
        const localCW = crossCheck < 0;
        // Arc direction must remain the same
        if (localCW !== clockwise) break;

        // Avoid arcs with sweep > 350 degrees (nearly full circle)
        const a0 = Math.atan2(p0.y - circle.cy, p0.x - circle.cx);
        const aJ = Math.atan2(pt.y - circle.cy, pt.x - circle.cx);
        let sweep = clockwise ? (a0 - aJ) : (aJ - a0);
        if (sweep < 0) sweep += Math.PI * 2;
        if (sweep > Math.PI * 2 * 0.97) break;

        endIdx = j;
    }

    // Must span at least 3 points to be worthwhile as an arc
    if (endIdx - startIdx < 2) return null;

    // Refit the circle using first, middle, and last point for better accuracy
    const midIdx = Math.floor((startIdx + endIdx) / 2);
    const refinedCircle = circumscribedCircle(points[startIdx], points[midIdx], points[endIdx]);
    if (!refinedCircle) return circle ? { center: { x: circle.cx, y: circle.cy }, radius: circle.r, endIdx, clockwise } : null;

    // Verify all points still within tolerance using refined circle
    for (let j = startIdx; j <= endIdx; j++) {
        const pt = points[j];
        const dist = Math.abs(Math.hypot(pt.x - refinedCircle.cx, pt.y - refinedCircle.cy) - refinedCircle.r);
        if (dist > tolerance) {
            // Fall back to original circle result
            return {
                center: { x: circle.cx, y: circle.cy },
                radius: circle.r,
                endIdx,
                clockwise
            };
        }
    }

    return {
        center: { x: refinedCircle.cx, y: refinedCircle.cy },
        radius: refinedCircle.r,
        endIdx,
        clockwise
    };
}

/**
 * 三點定圓（外接圓）
 * @returns {{ cx, cy, r }} 或 null（共線時）
 */
function circumscribedCircle(p1, p2, p3) {
    const ax = p1.x, ay = p1.y;
    const bx = p2.x, by = p2.y;
    const cx = p3.x, cy = p3.y;

    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-10) return null; // collinear

    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    const r = Math.hypot(ax - ux, ay - uy);

    return { cx: ux, cy: uy, r };
}


/**
 * 合併連續共線的直線段
 * @param {Array} moves - fitArcs 回傳的混合指令
 * @param {number} angleTolerance - 角度容差（弧度），建議 0.001
 * @returns {Array} 合併後的指令
 */
export function mergeCollinearLines(moves, angleTolerance = 0.001) {
    if (!moves || moves.length < 2) return moves || [];

    const result = [moves[0]];

    for (let i = 1; i < moves.length; i++) {
        const prev = result[result.length - 1];
        const curr = moves[i];

        if (prev.type === 'line' && curr.type === 'line') {
            // Check if they're collinear
            const a1 = Math.atan2(prev.to.y - prev.from.y, prev.to.x - prev.from.x);
            const a2 = Math.atan2(curr.to.y - curr.from.y, curr.to.x - curr.from.x);
            let diff = Math.abs(a1 - a2);
            if (diff > Math.PI) diff = 2 * Math.PI - diff;

            if (diff < angleTolerance) {
                // Merge: extend the previous line
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
 * 1. Douglas-Peucker 簡化
 * 2. 圓弧擬合
 * 3. 合併共線段
 * 
 * @param {Array<{x:number, y:number}>} points - 原始取樣點
 * @param {Object} options - 優化參數
 * @returns {Array} 優化後的移動指令
 */
export function optimizePath(points, options = {}) {
    const {
        simplifyTolerance = 0.005,  // mm — 路徑簡化容差
        arcTolerance = 0.01,        // mm — 圓弧擬合容差
        minArcRadius = 0.5,         // mm
        maxArcRadius = 100000,      // mm
        angleTolerance = 0.001,     // rad — 共線合併角度容差
        enableArcFitting = true,
    } = options;

    // Step 1: Simplify
    const simplified = simplifyPath(points, simplifyTolerance);

    // Step 2: Arc fitting
    let moves;
    if (enableArcFitting && simplified.length >= 3) {
        moves = fitArcs(simplified, arcTolerance, minArcRadius, maxArcRadius);
    } else {
        // Convert points to line moves
        moves = [];
        for (let i = 0; i < simplified.length - 1; i++) {
            moves.push({ type: 'line', from: simplified[i], to: simplified[i + 1] });
        }
    }

    // Step 3: Merge collinear lines
    moves = mergeCollinearLines(moves, angleTolerance);

    return moves;
}
