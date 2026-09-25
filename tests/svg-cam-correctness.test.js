import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { parseSVG } from '../js/svg-parser.js';
import { parseDXF } from '../js/dxf-parser.js';
import { buildAllGcodes, buildPartGcode } from '../js/cam/generator.js';
import { buildZLevels } from '../js/cam/operations.js';
import { validateMachiningInputs } from '../js/cam/validation.js';

before(() => {
    globalThis.DOMParser = new JSDOM('').window.DOMParser;
});

const svg = (content, attrs = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100" ${attrs}>${content}</svg>`;
const closeTo = (actual, expected, epsilon = 1e-6) => assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
);
const pointCloseTo = (actual, expected, epsilon = 1e-6) => {
    closeTo(actual.x, expected.x, epsilon);
    closeTo(actual.y, expected.y, epsilon);
};
const path = (d, transform = '') => `<path ${transform ? `transform="${transform}"` : ''} d="${d}"/>`;
const pointsWithin = (points, target, tolerance) => {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq ? Math.max(0, Math.min(1,
            ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSq)) : 0;
        best = Math.min(best, Math.hypot(target.x - (a.x + t * dx), target.y - (a.y + t * dy)));
    }
    assert.ok(best <= tolerance, `expected curve to pass within ${tolerance} mm; nearest distance was ${best} mm`);
};

test('a path with multiple move commands becomes independent parts', () => {
    const parts = parseSVG('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M 0 0 L 10 0 M 20 0 L 30 0"/></svg>');

    assert.equal(parts.length, 2);
    pointCloseTo(parts[0].startPoint, { x: 0, y: 0 });
    pointCloseTo(parts[0].moves.at(-1).to, { x: 10, y: 0 });
    pointCloseTo(parts[1].startPoint, { x: 20, y: 0 });
    pointCloseTo(parts[1].moves.at(-1).to, { x: 30, y: 0 });
    assert.ok(parts.every(part => !part.moves.some(move => move.to.x > 10 && move.to.x < 20)),
        'no move may connect the two subpaths');
});

test('Z closes only its subpath and relative m starts after the closed point', () => {
    const parts = parseSVG(svg(path('M0 0 L10 0 L10 10 Z m20 0 l10 0')));

    assert.equal(parts.length, 2);
    pointCloseTo(parts[0].moves.at(-1).to, { x: 0, y: 0 });
    pointCloseTo(parts[1].startPoint, { x: 20, y: 0 });
    pointCloseTo(parts[1].moves.at(-1).to, { x: 30, y: 0 });
});

test('relative move coordinates and implicit line pairs retain source order', () => {
    const parts = parseSVG(svg(path('m1 2 3 4 5 6 M50 50')));

    assert.equal(parts.length, 1);
    pointCloseTo(parts[0].startPoint, { x: 1, y: -2 });
    pointCloseTo(parts[0].moves[0].to, { x: 4, y: -6 });
    pointCloseTo(parts[0].moves[1].to, { x: 9, y: -12 });
});

test('nested group transforms are inherited and composed', () => {
    const parts = parseSVG(svg(
        '<g transform="translate(10 20)"><g transform="scale(2)"><path d="M 1 2 L 3 4"/></g></g>'
    ));

    assert.equal(parts.length, 1);
    pointCloseTo(parts[0].startPoint, { x: 12, y: -24 });
    pointCloseTo(parts[0].moves[0].to, { x: 16, y: -28 });
});

test('translate, scale, and rotation about a pivot transform endpoints in SVG order', () => {
    const parts = parseSVG(svg(
        '<path transform="translate(5 7) scale(2) rotate(90 10 20)" d="M 10 20 L 20 20"/>'
    ));

    pointCloseTo(parts[0].startPoint, { x: 25, y: -47 });
    pointCloseTo(parts[0].moves[0].to, { x: 25, y: -67 });
});

test('rotation around a pivot maps the line endpoints in CNC coordinates', () => {
    const [part] = parseSVG(svg(path('M11 10 L12 10', 'rotate(90 10 10)')));

    pointCloseTo(part.startPoint, { x: 10, y: -11 });
    pointCloseTo(part.moves[0].to, { x: 10, y: -12 });
});

test('a rotated circular arc remains an arc and produces a G2/G3 move', () => {
    const [part] = parseSVG(svg(
        '<path transform="rotate(90 50 50)" d="M 20 50 A 20 20 0 0 1 50 20"/>'
    ));

    assert.equal(part.moves.length, 1);
    assert.equal(part.moves[0].type, 'arc');
    pointCloseTo(part.startPoint, { x: 50, y: -20 });
    pointCloseTo(part.moves[0].to, { x: 80, y: -50 });
    const gcode = buildPartGcode(part, {
        safeZ: 5, feedXY: 500, feedZ: 100, thickness: 1, overcut: 0,
        stepdown: 1, toolD: 3, holeMode: 'drill'
    });
    assert.match(gcode, /^G[23] X/m);
});

test('uniform scale transforms circular arc radius and center', () => {
    const [part] = parseSVG(svg(
        '<path transform="translate(10 5) scale(2)" d="M 10 50 A 10 10 0 0 1 30 50"/>'
    ));
    const arc = part.moves[0];

    assert.equal(arc.type, 'arc');
    closeTo(arc.radius, 20);
    pointCloseTo(arc.center, { x: 50, y: -105 });
    pointCloseTo(arc.to, { x: 70, y: -105 });
});

test('untransformed quarter circle keeps its intended center, radius, quadrant, and direction', () => {
    const [part] = parseSVG(svg(path('M10 0 A10 10 0 0 1 0 10')));
    const arc = part.moves[0];

    assert.equal(arc.type, 'arc');
    pointCloseTo(arc.center, { x: 0, y: 0 });
    pointCloseTo(part.startPoint, { x: 10, y: 0 });
    pointCloseTo(arc.to, { x: 0, y: -10 });
    closeTo(arc.radius, 10);
    closeTo(Math.hypot(part.startPoint.x - arc.center.x, part.startPoint.y - arc.center.y), 10);
    closeTo(Math.hypot(arc.to.x - arc.center.x, arc.to.y - arc.center.y), 10);
    assert.equal(arc.clockwise, true);
    assert.ok(part.points.some(point => point.x > 0 && point.y < 0));
    assert.ok(!part.points.some(point => point.x < 0 && point.y > 0),
        'the sweep must not take the other 270 degree route');
});

test('a mirrored circular arc reverses direction', () => {
    const [normal] = parseSVG(svg('<path d="M 10 50 A 20 20 0 0 1 50 50"/>'));
    const [mirrored] = parseSVG(svg('<path transform="scale(-1 1)" d="M 10 50 A 20 20 0 0 1 50 50"/>'));

    assert.equal(normal.moves[0].type, 'arc');
    assert.equal(mirrored.moves[0].type, 'arc');
    assert.notEqual(mirrored.moves[0].clockwise, normal.moves[0].clockwise);
    pointCloseTo(mirrored.startPoint, { x: -10, y: -50 });
});

test('a nonuniformly scaled circular arc is sampled along a curved ellipse', () => {
    const [part] = parseSVG(svg(
        '<path transform="scale(2 1)" d="M 30 50 A 20 20 0 0 1 70 50"/>'
    ));

    assert.ok(part.moves.length > 2, `expected ellipse samples, got ${part.moves.length} move`);
    assert.ok(part.moves.every(move => move.type === 'line'));
    assert.ok(part.moves.some(move => Math.abs(move.to.y - part.startPoint.y) > 1),
        'an interior sample should depart from the endpoint chord');
});

test('S after a line starts with the current point instead of an old cubic control point', () => {
    const d = 'M0 0 C0 100 100 100 100 0 L200 0 S300 0 300 100';
    const expanded = 'M0 0 C0 100 100 100 100 0 L200 0 C200 0 300 0 300 100';
    const [part] = parseSVG(svg(path(d)));
    const [expected] = parseSVG(svg(path(expanded)));
    const lineIndex = part.moves.findIndex(move => Math.abs(move.to.x - 200) < 1e-6);
    const expectedLineIndex = expected.moves.findIndex(move => Math.abs(move.to.x - 200) < 1e-6);
    const smoothCurve = part.moves.slice(lineIndex + 1);
    const expectedCurve = expected.moves.slice(expectedLineIndex + 1);

    assert.equal(smoothCurve.length, expectedCurve.length);
    smoothCurve.forEach((move, i) => pointCloseTo(move.to, expectedCurve[i].to, 1e-9));
    assert.ok(Math.abs(smoothCurve[0].to.y) < 0.1,
        `the first smooth-curve sample unexpectedly moved to y=${smoothCurve[0].to.y}`);
});

test('T after a line starts with the current point instead of an old quadratic control point', () => {
    const [part] = parseSVG(svg(path('M0 0 Q20 40 40 0 L60 0 T100 0')));
    const [expected] = parseSVG(svg(path('M0 0 Q20 40 40 0 L60 0 Q60 0 100 0')));
    const lineIndex = part.moves.findIndex(move => Math.abs(move.to.x - 60) < 1e-6);
    const expectedLineIndex = expected.moves.findIndex(move => Math.abs(move.to.x - 60) < 1e-6);
    const smoothCurve = part.moves.slice(lineIndex + 1);
    const expectedCurve = expected.moves.slice(expectedLineIndex + 1);

    assert.equal(smoothCurve.length, expectedCurve.length);
    smoothCurve.forEach((move, i) => pointCloseTo(move.to, expectedCurve[i].to, 1e-9));
    assert.ok(Math.abs(smoothCurve[0].to.y) < 0.1,
        `the first smooth-curve sample unexpectedly moved to y=${smoothCurve[0].to.y}`);
});

test('minimal S command after L matches its explicit cubic equivalent', () => {
    const [smooth] = parseSVG(svg(path('M10 10 L20 10 S30 10 40 10')));
    const [explicit] = parseSVG(svg(path('M10 10 L20 10 C20 10 30 10 40 10')));

    assert.equal(smooth.moves.length, explicit.moves.length);
    smooth.moves.forEach((move, i) => pointCloseTo(move.to, explicit.moves[i].to, 1e-9));
    assert.ok(smooth.points.every(point => Math.abs(point.y + 10) < 1e-9));
});

test('smooth commands only reflect a compatible curve family and reset after M', () => {
    const pairs = [
        ['M0 0 C0 10 10 10 10 0 L20 0 T30 0', 'M0 0 C0 10 10 10 10 0 L20 0 Q20 0 30 0'],
        ['M0 0 Q10 10 20 0 L30 0 S40 0 50 0', 'M0 0 Q10 10 20 0 L30 0 C30 0 40 0 50 0'],
        ['M0 0 C0 10 10 10 10 0 M20 0 S30 0 40 0', 'M0 0 C0 10 10 10 10 0 M20 0 C20 0 30 0 40 0'],
        ['M0 0 Q10 10 20 0 M30 0 T40 0', 'M0 0 Q10 10 20 0 M30 0 Q30 0 40 0'],
        ['M0 0 C0 10 10 10 10 0 Z S20 0 30 0', 'M0 0 C0 10 10 10 10 0 Z C0 0 20 0 30 0'],
        ['M0 0 Q10 10 20 0 Z T30 0', 'M0 0 Q10 10 20 0 Z Q0 0 30 0']
    ];

    for (const [smoothD, explicitD] of pairs) {
        const actual = parseSVG(svg(path(smoothD)));
        const expected = parseSVG(svg(path(explicitD)));
        assert.equal(actual.length, expected.length, smoothD);
        actual.forEach((part, partIndex) => {
            assert.equal(part.moves.length, expected[partIndex].moves.length, smoothD);
            part.moves.forEach((move, i) => pointCloseTo(move.to, expected[partIndex].moves[i].to, 1e-9));
        });
    }
});

test('similarity transforms keep the quarter circle and its CNC sweep', () => {
    const d = 'M10 0 A10 10 0 0 1 0 10';
    const [part] = parseSVG(svg(path(d, 'rotate(90) scale(2)')));

    assert.equal(part.moves[0].type, 'arc');
    pointCloseTo(part.startPoint, { x: 0, y: -20 });
    pointCloseTo(part.moves[0].to, { x: -20, y: 0 });
    pointCloseTo(part.moves[0].center, { x: 0, y: 0 });
    closeTo(part.moves[0].radius, 20);
    assert.equal(part.moves[0].clockwise, true);
    assert.ok(part.points.some(point => point.x < -1e-6 && point.y < -1e-6),
        'the arc samples should traverse its intended CNC quadrant');
});

test('mirror transforms flip arc direction and produce G3 on path', () => {
    const [part] = parseSVG(svg(path('M10 0 A10 10 0 0 1 0 10', 'scale(-1 1)')));

    assert.equal(part.moves[0].type, 'arc');
    pointCloseTo(part.startPoint, { x: -10, y: 0 });
    pointCloseTo(part.moves[0].to, { x: 0, y: -10 });
    closeTo(part.moves[0].radius, 10);
    assert.equal(part.moves[0].clockwise, false);
    const gcode = buildPartGcode({ ...part, toolpathMode: 'on-path' }, {
        safeZ: 5, feedXY: 500, feedZ: 100, thickness: 1, overcut: 0,
        stepdown: 1, toolD: 3, holeMode: 'drill'
    });
    assert.match(gcode, /^G3 X/m);
});

test('nonuniform scaling samples the transformed quarter circle within 0.05 mm', () => {
    const [part] = parseSVG(svg(path('M10 0 A10 10 0 0 1 0 10', 'scale(2 1)')));

    assert.ok(part.moves.length > 2);
    assert.ok(part.moves.every(move => move.type === 'line'));
    pointsWithin([part.startPoint, ...part.moves.map(move => move.to)],
        { x: 14.1421356, y: -7.0710678 }, 0.05);
});

test('a sheared ellipse keeps both curvature axes in the generated points', () => {
    const [part] = parseSVG(svg('<ellipse cx="50" cy="50" rx="20" ry="10" transform="matrix(1 0.5 0.25 1 0 0)"/>'));
    const xs = part.points.map(point => point.x);
    const ys = part.points.map(point => point.y);

    assert.ok(part.moves.length > 4, 'the sheared ellipse must be represented by sampled line moves');
    closeTo(Math.min(...xs), 62.5 - Math.hypot(20, 2.5), 0.05);
    closeTo(Math.max(...xs), 62.5 + Math.hypot(20, 2.5), 0.05);
    closeTo(Math.min(...ys), -75 - Math.hypot(10, 10), 0.05);
    closeTo(Math.max(...ys), -75 + Math.hypot(10, 10), 0.05);
});

test('a viewBox without physical viewport dimensions is rejected clearly', async () => {
    const source = await readFile(new URL('./fixtures/ambiguous-size.svg', import.meta.url), 'utf8');
    assert.throws(
        () => parseSVG(source),
        /viewBox.*(width|height|dimension)|(width|height|dimension).*viewBox/i
    );
});

test('96 CSS px map to 25.4 mm for supported physical viewport units', () => {
    const variants = ['25.4mm', '2.54cm', '1in', '72pt', '96px', '96'];
    for (const size of variants) {
        const [part] = parseSVG(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96"><path d="M0 0 L96 0"/></svg>`);
        closeTo(part.moves[0].to.x, 25.4, 1e-6);
    }
});

test('viewBox origin is removed and xMidYMid meet centers unused viewport space', () => {
    const [part] = parseSVG(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="10 20 100 50"><path d="M10 20 L110 70"/></svg>'
    );

    pointCloseTo(part.startPoint, { x: 0, y: 0 });
    pointCloseTo(part.moves[0].to, { x: 200, y: -100 });
});

test('default meet preserves aspect ratio and preserveAspectRatio none uses both viewport scales', () => {
    const source = d => `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 100 100"><path d="${d}"/></svg>`;
    const [meet] = parseSVG(source('M0 0 L100 100'));
    const [none] = parseSVG(source('M0 0 L100 100').replace('<svg ', '<svg preserveAspectRatio="none" '));

    pointCloseTo(meet.startPoint, { x: 50, y: 0 });
    pointCloseTo(meet.moves[0].to, { x: 150, y: -100 });
    pointCloseTo(none.startPoint, { x: 0, y: 0 });
    pointCloseTo(none.moves[0].to, { x: 200, y: -100 });
});

test('one physical viewport dimension is enough to infer the other from viewBox', () => {
    for (const attrs of ['width="100mm"', 'height="50mm"']) {
        const [part] = parseSVG(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs} viewBox="0 0 100 50"><path d="M0 0 L100 50"/></svg>`);
        pointCloseTo(part.moves[0].to, { x: 100, y: -50 });
    }
});

test('without a viewBox, geometry uses CSS px regardless of physical root width', () => {
    const sources = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="100mm"><path d="M0 0 L96 0"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L96 0"/></svg>'
    ];

    for (const source of sources) {
        const [part] = parseSVG(source);
        closeTo(part.moves[0].to.x, 25.4, 1e-6);
    }
});

test('invalid viewport sizes, viewBox, and transforms fail explicitly', () => {
    for (const source of [
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100mm"><path d="M0 0 L10 0"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="NaN" height="100mm"><path d="M0 0 L10 0"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100"><path d="M0 0 L10 0"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm"><path transform="unknown(1)" d="M0 0 L10 0"/></svg>'
    ]) {
        assert.throws(() => parseSVG(source));
    }
});

const validContourMfg = overrides => ({
    faceFeedXY: 500,
    faceFeedZ: 100,
    faceToolD: 3,
    faceFinishAllow: 0,
    faceFinishFeed: 200,
    feedXY: 500,
    feedZ: 100,
    toolD: 3,
    safeZ: 5,
    stockTopZ: 0,
    thickness: 10,
    overcut: 0,
    stepdown: 1,
    faceEnable: false,
    surfaceCleanDepth: 0,
    ...overrides
});

test('machining validation blocks nonpositive or nonfinite feeds and tool diameter', () => {
    for (const [field, value, label] of [
        ['feedXY', 0, 'XY 進給'], ['feedXY', -1, 'XY 進給'], ['feedXY', NaN, 'XY 進給'],
        ['feedZ', Infinity, 'Z 進給'], ['feedZ', 0, 'Z 進給'],
        ['toolD', -1, '刀徑'], ['toolD', NaN, '刀徑']
    ]) {
        const result = validateMachiningInputs([{ toolpathMode: 'on-path' }], validContourMfg({ [field]: value }));
        assert.ok(result.errors.some(error => error.includes(label)), `${field}=${value} should be rejected`);
    }
});

test('machining validation requires safeZ above finite stock top and positive contour stepdown', () => {
    for (const [field, value, label] of [
        ['safeZ', 0, '安全高度'], ['safeZ', -1, '安全高度'], ['safeZ', NaN, '安全高度'],
        ['stepdown', 0, '每層下刀'], ['stepdown', -1, '每層下刀'], ['stepdown', Infinity, '每層下刀']
    ]) {
        const result = validateMachiningInputs([{ toolpathMode: 'on-path' }], validContourMfg({ [field]: value }));
        assert.ok(result.errors.some(error => error.includes(label)), `${field}=${value} should be rejected`);
    }
    assert.equal(validateMachiningInputs([{ toolpathMode: 'on-path' }],
        validContourMfg({ stockTopZ: 5, safeZ: 6 })).errors.length, 0);
});

test('buildAllGcodes rejects invalid contour parameters before returning files', () => {
    const parts = [{ id: 'p', barStyle: 'path', startPoint: { x: 0, y: 0 },
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], moves: [{ type: 'line', to: { x: 10, y: 0 } }] }];

    assert.throws(() => buildAllGcodes(parts, validContourMfg({ feedXY: NaN })), /XY 進給/);
    assert.throws(() => buildAllGcodes(parts, validContourMfg({ stockTopZ: -10, thickness: 7 })),
        /(目標|厚度|頂面|Z)/);
    assert.throws(() => buildAllGcodes(parts, validContourMfg({ thickness: NaN })), /材料厚度/);
    assert.throws(() => buildAllGcodes(parts, validContourMfg({ overcut: -1 })), /切穿量/);
});

test('multiple path parts generate separate cutting programs with safe approach moves', async () => {
    const source = await readFile(new URL('./fixtures/compound-path.svg', import.meta.url), 'utf8');
    const parts = parseSVG(source);
    const programs = buildAllGcodes(parts, validContourMfg({ thickness: 1 }));

    assert.equal(programs.length, 2);
    for (const { text } of programs) {
        const safeRetract = text.indexOf('G0 Z5');
        const firstXY = text.indexOf('G0 X');
        const firstCut = text.indexOf('G1 Z');
        assert.ok(safeRetract >= 0 && safeRetract < firstXY && firstXY < firstCut,
            'each independent subpath starts at safe Z before XY positioning and cutting');
    }
});

test('buildZLevels rejects invalid stepdown instead of substituting one full-depth pass', () => {
    for (const badStepdown of [0, -1, NaN, Infinity]) {
        assert.throws(() => buildZLevels(0, -3, badStepdown));
    }
    assert.deepEqual(buildZLevels(0, -3, 1), [-1, -2, -3]);
    assert.deepEqual(buildZLevels(0, 0, 1), []);
});

test('pure facing is active machining and validates its own stepdown and stock bounds', () => {
    const mfg = validContourMfg({
        faceEnable: true,
        surfaceCleanDepth: 1,
        faceStepdown: 0.5,
        stockBounds: { minX: 0, minY: 0, maxX: 100, maxY: 50 }
    });
    assert.equal(validateMachiningInputs([], mfg).errors.length, 0);
    assert.ok(validateMachiningInputs([], { ...mfg, faceStepdown: 0 }).errors.some(e => e.includes('清掃每層下刀')));
    assert.throws(() => buildAllGcodes([], { ...mfg, faceToolD: 0 }), /刀徑/);
    assert.throws(() => buildAllGcodes([], { ...mfg, safeZ: 0 }), /安全高度/);
    assert.throws(() => buildAllGcodes([], { ...mfg, stockBounds: { minX: 0, minY: 0, maxX: 0, maxY: 50 } }));
});

test('zero-depth facing is inactive and does not make an unused face stepdown block contouring', () => {
    const part = { toolpathMode: 'on-path', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    const result = validateMachiningInputs([part], validContourMfg({
        faceEnable: true, surfaceCleanDepth: 0, faceStepdown: NaN
    }));
    assert.equal(result.errors.length, 0);
});

test('drilling does not require a contour stepdown', () => {
    const result = validateMachiningInputs([{ toolpathMode: 'drill', holes: [{ x: 0, y: 0 }] }],
        validContourMfg({ stepdown: 0 }));
    assert.equal(result.errors.length, 0);
});

test('the browser smoke SVG fixture imports as two separate milling parts', async () => {
    const source = await readFile(new URL('./fixtures/compound-path.svg', import.meta.url), 'utf8');
    const parts = parseSVG(source);

    assert.equal(parts.length, 2);
    pointCloseTo(parts[0].startPoint, { x: 0, y: 0 });
    pointCloseTo(parts[0].moves.at(-1).to, { x: 10, y: 0 });
    pointCloseTo(parts[1].startPoint, { x: 20, y: 0 });
    pointCloseTo(parts[1].moves.at(-1).to, { x: 30, y: 0 });
});

test('R02 DXF fixture remains readable as a 25.4 mm line', async () => {
    const source = await readFile(new URL('./fixtures/simple-line.dxf', import.meta.url), 'utf8');
    const parts = parseDXF(source);

    assert.equal(parts.length, 1);
    closeTo(Math.hypot(parts[0].points.at(-1).x - parts[0].points[0].x,
        parts[0].points.at(-1).y - parts[0].points[0].y), 25.4);
});
