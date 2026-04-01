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
 * - INSERT (BLOCK reference)
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

function identityMatrix() {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrices(m1, m2) {
    return {
        a: m1.a * m2.a + m1.c * m2.b,
        b: m1.b * m2.a + m1.d * m2.b,
        c: m1.a * m2.c + m1.c * m2.d,
        d: m1.b * m2.c + m1.d * m2.d,
        e: m1.a * m2.e + m1.c * m2.f + m1.e,
        f: m1.b * m2.e + m1.d * m2.f + m1.f
    };
}

function translationMatrix(tx, ty) {
    return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

function scaleMatrix(sx, sy) {
    return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

function rotationMatrix(angleRad) {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

function transformPoint(point, matrix) {
    return {
        x: matrix.a * point.x + matrix.c * point.y + matrix.e,
        y: matrix.b * point.x + matrix.d * point.y + matrix.f
    };
}

function buildInsertMatrix(insert, block) {
    const baseX = Number.isFinite(block.baseX) ? block.baseX : 0;
    const baseY = Number.isFinite(block.baseY) ? block.baseY : 0;
    const sx = Number.isFinite(insert.sx) ? insert.sx : 1;
    const sy = Number.isFinite(insert.sy) ? insert.sy : 1;
    const rotation = Number.isFinite(insert.rotation) ? insert.rotation : 0;
    return multiplyMatrices(
        translationMatrix(insert.x, insert.y),
        multiplyMatrices(
            rotationMatrix(rotation),
            multiplyMatrices(
                scaleMatrix(sx, sy),
                translationMatrix(-baseX, -baseY)
            )
        )
    );
}

function getSimilarityScale(matrix) {
    const scaleX = Math.hypot(matrix.a, matrix.b);
    const scaleY = Math.hypot(matrix.c, matrix.d);
    const dot = matrix.a * matrix.c + matrix.b * matrix.d;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX < EPS || scaleY < EPS) {
        return null;
    }
    if (Math.abs(scaleX - scaleY) > 1e-6 || Math.abs(dot) > 1e-6) {
        return null;
    }
    const det = matrix.a * matrix.d - matrix.b * matrix.c;
    if (det <= 0) return null;
    return scaleX;
}

function sampleArcRecord(record, matrix, stepMm = 0.5) {
    const start = {
        x: record.cx + record.r * Math.cos(record.startAngle),
        y: record.cy + record.r * Math.sin(record.startAngle)
    };
    const end = {
        x: record.cx + record.r * Math.cos(record.endAngle),
        y: record.cy + record.r * Math.sin(record.endAngle)
    };
    const center = { x: record.cx, y: record.cy };
    const scaledCenter = transformPoint(center, matrix);
    const scaledStart = transformPoint(start, matrix);
    const scaledEnd = transformPoint(end, matrix);
    const radius = Math.hypot(scaledStart.x - scaledCenter.x, scaledStart.y - scaledCenter.y);
    const arcMove = {
        type: 'arc',
        to: scaledEnd,
        center: scaledCenter,
        radius,
        clockwise: record.clockwise
    };
    return flattenMovesToPoints(scaledStart, [arcMove], stepMm);
}

function pointsToLineRecords(points, closed = false) {
    const records = [];
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
        const current = points[i];
        const next = points[(i + 1) % points.length];
        if (Math.hypot(next.x - current.x, next.y - current.y) <= EPS) continue;
        records.push({
            type: 'LINE',
            x1: current.x,
            y1: current.y,
            x2: next.x,
            y2: next.y
        });
    }
    return records;
}

function flattenVertexSegment(v1, v2) {
    if (Math.abs(v1.bulge || 0) <= EPS) {
        return [{ x: v1.x, y: v1.y }, { x: v2.x, y: v2.y }];
    }
    const arc = bulgeToArc(v1, v2, v1.bulge);
    if (!arc) return [{ x: v1.x, y: v1.y }, { x: v2.x, y: v2.y }];
    return flattenMovesToPoints({ x: v1.x, y: v1.y }, [arc], 0.5);
}

function flattenVertexRecord(record, matrix) {
    const points = [];
    const count = record.closed ? record.vertices.length : record.vertices.length - 1;
    for (let i = 0; i < count; i++) {
        const segmentPoints = flattenVertexSegment(record.vertices[i], record.vertices[(i + 1) % record.vertices.length]);
        segmentPoints.forEach((point, index) => {
            if (i > 0 && index === 0) return;
            points.push(transformPoint(point, matrix));
        });
    }
    return pointsToLineRecords(points, record.closed);
}

function transformRecord(record, matrix) {
    if (record.type === 'LINE') {
        const start = transformPoint({ x: record.x1, y: record.y1 }, matrix);
        const end = transformPoint({ x: record.x2, y: record.y2 }, matrix);
        return [{
            type: 'LINE',
            x1: start.x,
            y1: start.y,
            x2: end.x,
            y2: end.y
        }];
    }

    if (record.type === 'LWPOLYLINE' || record.type === 'POLYLINE') {
        const scale = getSimilarityScale(matrix);
        if (scale) {
            return [{
                ...record,
                vertices: record.vertices.map((vertex) => ({
                    ...transformPoint(vertex, matrix),
                    bulge: vertex.bulge || 0
                }))
            }];
        }
        return flattenVertexRecord(record, matrix);
    }

    if (record.type === 'CIRCLE') {
        const scale = getSimilarityScale(matrix);
        if (scale) {
            const center = transformPoint({ x: record.cx, y: record.cy }, matrix);
            return [{
                type: 'CIRCLE',
                cx: center.x,
                cy: center.y,
                r: record.r * scale
            }];
        }
        const points = [];
        const segmentCount = 64;
        for (let i = 0; i < segmentCount; i++) {
            const angle = (Math.PI * 2 * i) / segmentCount;
            points.push(transformPoint({
                x: record.cx + record.r * Math.cos(angle),
                y: record.cy + record.r * Math.sin(angle)
            }, matrix));
        }
        return pointsToLineRecords(points, true);
    }

    if (record.type === 'ARC') {
        const scale = getSimilarityScale(matrix);
        if (scale) {
            const center = transformPoint({ x: record.cx, y: record.cy }, matrix);
            const start = transformPoint({
                x: record.cx + record.r * Math.cos(record.startAngle),
                y: record.cy + record.r * Math.sin(record.startAngle)
            }, matrix);
            const end = transformPoint({
                x: record.cx + record.r * Math.cos(record.endAngle),
                y: record.cy + record.r * Math.sin(record.endAngle)
            }, matrix);
            return [{
                type: 'ARC',
                cx: center.x,
                cy: center.y,
                r: record.r * scale,
                startAngle: Math.atan2(start.y - center.y, start.x - center.x),
                endAngle: Math.atan2(end.y - center.y, end.x - center.x),
                clockwise: record.clockwise
            }];
        }
        return pointsToLineRecords(sampleArcRecord(record, matrix), false);
    }

    return [];
}

function parsePolylineRecord(pairs, startIndex) {
    const header = collectFields(pairs, startIndex);
    const flags = parseInt(firstNum(header.fields, 70, 0), 10) || 0;
    const vertices = [];
    let i = header.nextIndex;

    while (i < pairs.length) {
        const curr = pairs[i];
        if (curr.code !== 0) {
            i++;
            continue;
        }
        const type = curr.value.toUpperCase();
        if (type === 'VERTEX') {
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
        if (type === 'SEQEND') {
            i += 1;
            break;
        }
        break;
    }

    return {
        record: vertices.length >= 2 ? {
            type: 'POLYLINE',
            vertices,
            closed: (flags & 1) !== 0
        } : null,
        nextIndex: i
    };
}

function parseLwPolylineRecord(fields) {
    let flags = 0;
    const vertices = [];
    let current = null;

    for (const field of fields) {
        if (field.code === 70) {
            flags = parseInt(field.value, 10) || 0;
        } else if (field.code === 10) {
            if (current) vertices.push(current);
            current = { x: toNum(field.value, NaN), y: NaN, bulge: 0 };
        } else if (field.code === 20 && current) {
            current.y = toNum(field.value, NaN);
        } else if (field.code === 42 && current) {
            current.bulge = toNum(field.value, 0);
        }
    }
    if (current) vertices.push(current);
    const cleanVertices = vertices.filter((vertex) => Number.isFinite(vertex.x) && Number.isFinite(vertex.y));
    return cleanVertices.length >= 2 ? {
        type: 'LWPOLYLINE',
        vertices: cleanVertices,
        closed: (flags & 1) !== 0
    } : null;
}

function parseEntityRecord(pairs, startIndex) {
    const entityType = pairs[startIndex].value.toUpperCase();

    if (entityType === 'POLYLINE') {
        return parsePolylineRecord(pairs, startIndex);
    }

    const entity = collectFields(pairs, startIndex);
    let record = null;

    if (entityType === 'LINE') {
        const x1 = firstNum(entity.fields, 10, NaN);
        const y1 = firstNum(entity.fields, 20, NaN);
        const x2 = firstNum(entity.fields, 11, NaN);
        const y2 = firstNum(entity.fields, 21, NaN);
        if ([x1, y1, x2, y2].every(Number.isFinite) && Math.hypot(x2 - x1, y2 - y1) > EPS) {
            record = { type: 'LINE', x1, y1, x2, y2 };
        }
    } else if (entityType === 'LWPOLYLINE') {
        record = parseLwPolylineRecord(entity.fields);
    } else if (entityType === 'CIRCLE') {
        const cx = firstNum(entity.fields, 10, NaN);
        const cy = firstNum(entity.fields, 20, NaN);
        const r = firstNum(entity.fields, 40, NaN);
        if ([cx, cy, r].every(Number.isFinite) && r > EPS) {
            record = { type: 'CIRCLE', cx, cy, r };
        }
    } else if (entityType === 'ARC') {
        const cx = firstNum(entity.fields, 10, NaN);
        const cy = firstNum(entity.fields, 20, NaN);
        const r = firstNum(entity.fields, 40, NaN);
        let startAngle = firstNum(entity.fields, 50, NaN);
        let endAngle = firstNum(entity.fields, 51, NaN);
        if ([cx, cy, r, startAngle, endAngle].every(Number.isFinite) && r > EPS) {
            startAngle = startAngle * Math.PI / 180;
            endAngle = endAngle * Math.PI / 180;
            if (endAngle <= startAngle) endAngle += Math.PI * 2;
            record = { type: 'ARC', cx, cy, r, startAngle, endAngle, clockwise: false };
        }
    } else if (entityType === 'INSERT') {
        const name = entity.fields.find((field) => field.code === 2)?.value || '';
        const x = firstNum(entity.fields, 10, 0);
        const y = firstNum(entity.fields, 20, 0);
        const sx = firstNum(entity.fields, 41, 1);
        const sy = firstNum(entity.fields, 42, 1);
        const rotation = firstNum(entity.fields, 50, 0) * Math.PI / 180;
        if (name) {
            record = { type: 'INSERT', name, x, y, sx, sy, rotation };
        }
    }

    return { record, nextIndex: entity.nextIndex };
}

function collectSectionRecords(pairs, sectionName) {
    const records = [];
    let inSection = false;

    for (let i = 0; i < pairs.length;) {
        const pair = pairs[i];
        if (pair.code === 0 && pair.value === 'SECTION') {
            const next = pairs[i + 1];
            inSection = !!(next && next.code === 2 && next.value === sectionName);
            i += 2;
            continue;
        }
        if (pair.code === 0 && pair.value === 'ENDSEC') {
            if (inSection) break;
            i++;
            continue;
        }
        if (!inSection || pair.code !== 0) {
            i++;
            continue;
        }
        const { record, nextIndex } = parseEntityRecord(pairs, i);
        if (record) records.push(record);
        i = nextIndex;
    }

    return records;
}

function collectBlockDefinitions(pairs) {
    const blocks = new Map();
    let inBlocks = false;

    for (let i = 0; i < pairs.length;) {
        const pair = pairs[i];
        if (pair.code === 0 && pair.value === 'SECTION') {
            const next = pairs[i + 1];
            inBlocks = !!(next && next.code === 2 && next.value === 'BLOCKS');
            i += 2;
            continue;
        }
        if (pair.code === 0 && pair.value === 'ENDSEC') {
            if (inBlocks) break;
            i++;
            continue;
        }
        if (!inBlocks || pair.code !== 0) {
            i++;
            continue;
        }
        if (pair.value !== 'BLOCK') {
            i++;
            continue;
        }

        const blockEntity = collectFields(pairs, i);
        const name = blockEntity.fields.find((field) => field.code === 2)?.value;
        const baseX = firstNum(blockEntity.fields, 10, 0);
        const baseY = firstNum(blockEntity.fields, 20, 0);
        const records = [];
        i = blockEntity.nextIndex;

        while (i < pairs.length) {
            const curr = pairs[i];
            if (curr.code !== 0) {
                i++;
                continue;
            }
            const type = curr.value.toUpperCase();
            if (type === 'ENDBLK') {
                i = collectFields(pairs, i).nextIndex;
                break;
            }
            const parsed = parseEntityRecord(pairs, i);
            if (parsed.record) records.push(parsed.record);
            i = parsed.nextIndex;
        }

        if (name) {
            blocks.set(name, { name, baseX, baseY, records });
        }
    }

    return blocks;
}

function explodeRecords(records, blocks, parentMatrix = identityMatrix(), depth = 0, stack = new Set()) {
    if (depth > 12) return [];
    const exploded = [];

    for (const record of records) {
        if (record.type === 'INSERT') {
            const block = blocks.get(record.name);
            if (!block || stack.has(record.name)) continue;
            const nextMatrix = multiplyMatrices(parentMatrix, buildInsertMatrix(record, block));
            const nextStack = new Set(stack);
            nextStack.add(record.name);
            exploded.push(...explodeRecords(block.records, blocks, nextMatrix, depth + 1, nextStack));
            continue;
        }
        exploded.push(...transformRecord(record, parentMatrix));
    }

    return exploded;
}

function recordsToParts(records, unitFactor) {
    const parts = [];
    const primitives = [];
    let partIndex = 1;

    for (const record of records) {
        if (record.type === 'LINE') {
            primitives.push({
                kind: 'line',
                start: { x: record.x1, y: record.y1 },
                end: { x: record.x2, y: record.y2 }
            });
            continue;
        }

        if (record.type === 'LWPOLYLINE' || record.type === 'POLYLINE') {
            const part = buildPathFromVertices(record.vertices, record.closed, partIndex++);
            if (part) parts.push(part);
            continue;
        }

        if (record.type === 'CIRCLE') {
            const start = { x: record.cx + record.r, y: record.cy };
            const mid = { x: record.cx - record.r, y: record.cy };
            const part = makePart(start, [
                { type: 'arc', to: mid, center: { x: record.cx, y: record.cy }, radius: record.r, clockwise: false },
                { type: 'arc', to: start, center: { x: record.cx, y: record.cy }, radius: record.r, clockwise: false }
            ], partIndex++);
            if (part) parts.push(part);
            continue;
        }

        if (record.type === 'ARC') {
            let a2 = record.endAngle;
            if (a2 <= record.startAngle) a2 += Math.PI * 2;
            const start = { x: record.cx + record.r * Math.cos(record.startAngle), y: record.cy + record.r * Math.sin(record.startAngle) };
            const end = { x: record.cx + record.r * Math.cos(a2), y: record.cy + record.r * Math.sin(a2) };
            primitives.push({
                kind: 'arc',
                start,
                end,
                center: { x: record.cx, y: record.cy },
                radius: record.r,
                clockwise: record.clockwise
            });
        }
    }

    if (primitives.length > 0) {
        const stitched = stitchPrimitivesToParts(primitives, partIndex, 1e-4);
        parts.push(...stitched.parts);
    }

    for (const part of parts) {
        if (part.startPoint) {
            part.startPoint = { x: part.startPoint.x * unitFactor, y: part.startPoint.y * unitFactor };
        }
        if (part.moves) {
            part.moves = part.moves.map((move) => {
                const nextMove = { ...move };
                if (move.to) nextMove.to = { x: move.to.x * unitFactor, y: move.to.y * unitFactor };
                if (move.center) nextMove.center = { x: move.center.x * unitFactor, y: move.center.y * unitFactor };
                if (Number.isFinite(move.radius)) nextMove.radius = move.radius * unitFactor;
                return nextMove;
            });
        }
        part.points = flattenMovesToPoints(part.startPoint, part.moves, 0.5);
    }

    return parts;
}

export function parseDXF(dxfText) {
    const pairs = toPairs(dxfText);
    if (pairs.length === 0) throw new Error('DXF 內容為空或格式不正確。');

    const unitFactor = detectUnitsFactor(pairs);
    const blocks = collectBlockDefinitions(pairs);
    const entityRecords = collectSectionRecords(pairs, 'ENTITIES');
    const explodedRecords = explodeRecords(entityRecords, blocks);
    const parts = recordsToParts(explodedRecords, unitFactor);

    if (parts.length === 0) {
        throw new Error('DXF 中沒有可解析的 2D 幾何（支援 LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC/INSERT）。');
    }

    return parts;
}
