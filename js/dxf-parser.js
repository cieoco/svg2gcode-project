/**
 * DXF Parser Module
 * Parses common 2D DXF entities into the same part format used by SVG parser.
 *
 * Supported entities:
 * - LINE
 * - LWPOLYLINE (with bulge arcs)
 * - POLYLINE/VERTEX/SEQEND (2D)
 * - CIRCLE
 * - ARC
 */

const EPS = 1e-9;

function toPairs(dxfText) {
    const lines = String(dxfText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = parseInt(lines[i].trim(), 10);
        if (Number.isNaN(code)) continue;
        pairs.push({ code, value: (lines[i + 1] || '').trim() });
    }
    return pairs;
}

function toNum(v, fallback = NaN) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}

function firstNum(fields, code, fallback = NaN) {
    for (const f of fields) {
        if (f.code === code) return toNum(f.value, fallback);
    }
    return fallback;
}

function detectUnitsFactor(pairs) {
    // DXF $INSUNITS:
    // 1=in, 2=ft, 4=mm, 5=cm, 6=m
    let inHeader = false;
    let wantUnits = false;
    let insUnits = 0;

    for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        if (p.code === 0 && p.value === 'SECTION') {
            const n = pairs[i + 1];
            inHeader = !!(n && n.code === 2 && n.value === 'HEADER');
            continue;
        }
        if (p.code === 0 && p.value === 'ENDSEC') {
            inHeader = false;
            wantUnits = false;
            continue;
        }
        if (!inHeader) continue;
        if (p.code === 9 && p.value === '$INSUNITS') {
            wantUnits = true;
            continue;
        }
        if (wantUnits && p.code === 70) {
            insUnits = parseInt(p.value, 10) || 0;
            wantUnits = false;
        }
    }

    const map = {
        0: 1,       // unitless (assume mm)
        1: 25.4,    // inches
        2: 304.8,   // feet
        4: 1,       // mm
        5: 10,      // cm
        6: 1000,    // m
        14: 100,    // dm
    };
    return map[insUnits] || 1;
}

function collectFields(pairs, startIdx) {
    const type = pairs[startIdx].value.toUpperCase();
    const fields = [];
    let i = startIdx + 1;
    while (i < pairs.length && pairs[i].code !== 0) {
        fields.push(pairs[i]);
        i++;
    }
    return { type, fields, nextIndex: i };
}

function bulgeToArc(p1, p2, bulge) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const chord = Math.hypot(dx, dy);
    if (chord < EPS || Math.abs(bulge) < EPS) return null;

    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const nx = -dy / chord;
    const ny = dx / chord;
    const d = (chord * (1 - bulge * bulge)) / (4 * bulge); // signed center offset
    const cx = mx + nx * d;
    const cy = my + ny * d;
    const radius = Math.hypot(p1.x - cx, p1.y - cy);

    return {
        type: 'arc',
        to: { x: p2.x, y: p2.y },
        center: { x: cx, y: cy },
        radius,
        clockwise: bulge < 0
    };
}

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
        if (move.type === 'arc' && move.center && Number.isFinite(move.radius) && move.radius > EPS) {
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

function makePart(startPoint, moves, idx) {
    if (!startPoint || !moves || moves.length === 0) return null;
    return {
        id: `Part_${idx}`,
        barStyle: 'path',
        startPoint: startPoint,
        moves: moves,
        points: flattenMovesToPoints(startPoint, moves, 0.5),
        holes: []
    };
}

function buildPathFromVertices(vertices, closed, partIndex) {
    if (!vertices || vertices.length < 2) return null;
    const start = { x: vertices[0].x, y: vertices[0].y };
    const moves = [];

    const addSegment = (v1, v2) => {
        const to = { x: v2.x, y: v2.y };
        if (Math.hypot(v2.x - v1.x, v2.y - v1.y) < EPS) return;
        if (Math.abs(v1.bulge || 0) > EPS) {
            const arc = bulgeToArc(v1, v2, v1.bulge);
            if (arc) {
                moves.push(arc);
                return;
            }
        }
        moves.push({ type: 'line', to });
    };

    for (let i = 0; i < vertices.length - 1; i++) {
        addSegment(vertices[i], vertices[i + 1]);
    }
    if (closed) {
        addSegment(vertices[vertices.length - 1], vertices[0]);
    }

    return makePart(start, moves, partIndex);
}

function pointsNear(a, b, tol = 1e-4) {
    return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
}

function reversePrimitive(seg) {
    if (seg.kind === 'line') {
        return {
            kind: 'line',
            start: { x: seg.end.x, y: seg.end.y },
            end: { x: seg.start.x, y: seg.start.y }
        };
    }
    return {
        kind: 'arc',
        start: { x: seg.end.x, y: seg.end.y },
        end: { x: seg.start.x, y: seg.start.y },
        center: { x: seg.center.x, y: seg.center.y },
        radius: seg.radius,
        clockwise: !seg.clockwise
    };
}

function primitiveToMove(seg) {
    if (seg.kind === 'line') {
        return { type: 'line', to: { x: seg.end.x, y: seg.end.y } };
    }
    return {
        type: 'arc',
        to: { x: seg.end.x, y: seg.end.y },
        center: { x: seg.center.x, y: seg.center.y },
        radius: seg.radius,
        clockwise: seg.clockwise
    };
}

function stitchPrimitivesToParts(primitives, startPartIndex, tol = 1e-4) {
    const remaining = primitives.slice();
    const stitchedParts = [];
    let partIndex = startPartIndex;

    while (remaining.length > 0) {
        const chain = [remaining.pop()];
        let extended = true;

        while (extended) {
            extended = false;
            const head = chain[0].start;
            const tail = chain[chain.length - 1].end;

            for (let i = 0; i < remaining.length; i++) {
                const s = remaining[i];
                let picked = null;
                let prepend = false;

                if (pointsNear(s.start, tail, tol)) {
                    picked = s;
                } else if (pointsNear(s.end, tail, tol)) {
                    picked = reversePrimitive(s);
                } else if (pointsNear(s.end, head, tol)) {
                    picked = s;
                    prepend = true;
                } else if (pointsNear(s.start, head, tol)) {
                    picked = reversePrimitive(s);
                    prepend = true;
                }

                if (picked) {
                    if (prepend) chain.unshift(picked);
                    else chain.push(picked);
                    remaining.splice(i, 1);
                    extended = true;
                    break;
                }
            }
        }

        const start = { x: chain[0].start.x, y: chain[0].start.y };
        const moves = chain.map(primitiveToMove);
        const lastTo = moves[moves.length - 1].to;
        if (pointsNear(lastTo, start, tol)) {
            moves[moves.length - 1].to = { x: start.x, y: start.y };
        }

        const part = makePart(start, moves, partIndex++);
        if (part) stitchedParts.push(part);
    }

    return { parts: stitchedParts, nextPartIndex: partIndex };
}

export function parseDXF(dxfText) {
    const pairs = toPairs(dxfText);
    if (pairs.length === 0) throw new Error('DXF 內容為空或格式不正確。');

    const unitFactor = detectUnitsFactor(pairs);
    const parts = [];
    const primitives = [];
    let partIndex = 1;

    let inEntities = false;
    for (let i = 0; i < pairs.length;) {
        const p = pairs[i];

        if (p.code === 0 && p.value === 'SECTION') {
            const next = pairs[i + 1];
            inEntities = !!(next && next.code === 2 && next.value === 'ENTITIES');
            i += 2;
            continue;
        }
        if (p.code === 0 && p.value === 'ENDSEC') {
            inEntities = false;
            i++;
            continue;
        }
        if (!inEntities || p.code !== 0) {
            i++;
            continue;
        }

        const entityType = p.value.toUpperCase();

        if (entityType === 'POLYLINE') {
            const header = collectFields(pairs, i);
            let flags = parseInt(firstNum(header.fields, 70, 0), 10) || 0;
            const vertices = [];
            i = header.nextIndex;

            while (i < pairs.length) {
                const curr = pairs[i];
                if (curr.code !== 0) {
                    i++;
                    continue;
                }
                const t = curr.value.toUpperCase();
                if (t === 'VERTEX') {
                    const vEntity = collectFields(pairs, i);
                    const x = firstNum(vEntity.fields, 10, NaN);
                    const y = firstNum(vEntity.fields, 20, NaN);
                    const bulge = firstNum(vEntity.fields, 42, 0);
                    if (Number.isFinite(x) && Number.isFinite(y)) {
                        vertices.push({ x, y, bulge: Number.isFinite(bulge) ? bulge : 0 });
                    }
                    i = vEntity.nextIndex;
                    continue;
                }
                if (t === 'SEQEND') {
                    i += 1;
                    break;
                }
                break;
            }

            const closed = (flags & 1) !== 0;
            const part = buildPathFromVertices(vertices, closed, partIndex++);
            if (part) parts.push(part);
            continue;
        }

        const entity = collectFields(pairs, i);
        i = entity.nextIndex;

        if (entityType === 'LINE') {
            const x1 = firstNum(entity.fields, 10, NaN);
            const y1 = firstNum(entity.fields, 20, NaN);
            const x2 = firstNum(entity.fields, 11, NaN);
            const y2 = firstNum(entity.fields, 21, NaN);
            if ([x1, y1, x2, y2].every(Number.isFinite) && Math.hypot(x2 - x1, y2 - y1) > EPS) {
                primitives.push({
                    kind: 'line',
                    start: { x: x1, y: y1 },
                    end: { x: x2, y: y2 }
                });
            }
            continue;
        }

        if (entityType === 'LWPOLYLINE') {
            let flags = 0;
            const vertices = [];
            let current = null;

            for (const f of entity.fields) {
                if (f.code === 70) {
                    flags = parseInt(f.value, 10) || 0;
                } else if (f.code === 10) {
                    if (current) vertices.push(current);
                    current = { x: toNum(f.value, NaN), y: NaN, bulge: 0 };
                } else if (f.code === 20 && current) {
                    current.y = toNum(f.value, NaN);
                } else if (f.code === 42 && current) {
                    current.bulge = toNum(f.value, 0);
                }
            }
            if (current) vertices.push(current);
            const cleanVertices = vertices.filter(v => Number.isFinite(v.x) && Number.isFinite(v.y));
            const part = buildPathFromVertices(cleanVertices, (flags & 1) !== 0, partIndex++);
            if (part) parts.push(part);
            continue;
        }

        if (entityType === 'CIRCLE') {
            const cx = firstNum(entity.fields, 10, NaN);
            const cy = firstNum(entity.fields, 20, NaN);
            const r = firstNum(entity.fields, 40, NaN);
            if ([cx, cy, r].every(Number.isFinite) && r > EPS) {
                const start = { x: cx + r, y: cy };
                const mid = { x: cx - r, y: cy };
                const part = makePart(start, [
                    { type: 'arc', to: mid, center: { x: cx, y: cy }, radius: r, clockwise: false },
                    { type: 'arc', to: start, center: { x: cx, y: cy }, radius: r, clockwise: false }
                ], partIndex++);
                if (part) parts.push(part);
            }
            continue;
        }

        if (entityType === 'ARC') {
            const cx = firstNum(entity.fields, 10, NaN);
            const cy = firstNum(entity.fields, 20, NaN);
            const r = firstNum(entity.fields, 40, NaN);
            let a1 = firstNum(entity.fields, 50, NaN);
            let a2 = firstNum(entity.fields, 51, NaN);
            if ([cx, cy, r, a1, a2].every(Number.isFinite) && r > EPS) {
                a1 = a1 * Math.PI / 180;
                a2 = a2 * Math.PI / 180;
                if (a2 <= a1) a2 += Math.PI * 2;
                const start = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
                const end = { x: cx + r * Math.cos(a2), y: cy + r * Math.sin(a2) };
                primitives.push({
                    kind: 'arc',
                    start: start,
                    end: end,
                    center: { x: cx, y: cy },
                    radius: r,
                    clockwise: false // DXF ARC is CCW from start angle to end angle.
                });
            }
            continue;
        }
    }

    if (primitives.length > 0) {
        const stitched = stitchPrimitivesToParts(primitives, partIndex, 1e-4);
        parts.push(...stitched.parts);
        partIndex = stitched.nextPartIndex;
    }

    // Scale to mm
    for (const part of parts) {
        if (part.startPoint) {
            part.startPoint = { x: part.startPoint.x * unitFactor, y: part.startPoint.y * unitFactor };
        }
        if (part.moves) {
            part.moves = part.moves.map(m => {
                const nm = { ...m };
                if (m.to) nm.to = { x: m.to.x * unitFactor, y: m.to.y * unitFactor };
                if (m.center) nm.center = { x: m.center.x * unitFactor, y: m.center.y * unitFactor };
                if (Number.isFinite(m.radius)) nm.radius = m.radius * unitFactor;
                return nm;
            });
        }
        part.points = flattenMovesToPoints(part.startPoint, part.moves, 0.5);
    }

    if (parts.length === 0) {
        throw new Error('DXF 中沒有可解析的 2D 幾何（支援 LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC）。');
    }

    return parts;
}
