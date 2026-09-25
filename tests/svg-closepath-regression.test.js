import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseSVG } from '../js/svg-parser.js';
import { buildAllGcodes } from '../js/cam/generator.js';

before(() => {
    globalThis.DOMParser = new JSDOM('').window.DOMParser;
});

const svg = d => `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="${d}"/></svg>`;
const pointCloseTo = (actual, expected) => {
    assert.ok(Math.abs(actual.x - expected.x) < 1e-6, `x ${actual.x} != ${expected.x}`);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-6, `y ${actual.y} != ${expected.y}`);
};

test('drawing after closepath starts a second CAM part at the closed subpath origin', () => {
    const parts = parseSVG(svg('M0 0 L10 0 L10 10 Z L20 0'));

    assert.equal(parts.length, 2);
    pointCloseTo(parts[0].startPoint, { x: 0, y: 0 });
    pointCloseTo(parts[0].moves.at(-1).to, { x: 0, y: 0 });
    pointCloseTo(parts[1].startPoint, { x: 0, y: 0 });
    pointCloseTo(parts[1].moves.at(-1).to, { x: 20, y: 0 });

    const programs = buildAllGcodes(parts, {
        feedXY: 500, feedZ: 100, toolD: 3, safeZ: 5, stockTopZ: 0,
        thickness: 1, overcut: 0, stepdown: 1, faceEnable: false,
        surfaceCleanDepth: 0
    });
    assert.equal(programs.length, 2);
    for (const { text } of programs) {
        const retract = text.indexOf('G0 Z5');
        const approach = text.indexOf('G0 X');
        const cutting = text.indexOf('G1 Z');
        assert.ok(retract >= 0 && retract < approach && approach < cutting,
            'each subpath must retract before positioning and cutting');
    }
});

test('a trailing closepath flushes once and does not create an empty part', () => {
    const parts = parseSVG(svg('M0 0 L10 0 L10 10 Z'));

    assert.equal(parts.length, 1);
    pointCloseTo(parts[0].moves.at(-1).to, { x: 0, y: 0 });
});

test('S and T after closepath start at the restored current point without stale control reflection', () => {
    const smoothCubic = parseSVG(svg('M0 0 C0 10 10 10 10 0 Z S20 0 30 0'));
    const explicitCubic = parseSVG(svg('M0 0 C0 10 10 10 10 0 Z M0 0 C0 0 20 0 30 0'));
    const smoothQuadratic = parseSVG(svg('M0 0 Q10 10 20 0 Z T40 0'));
    const explicitQuadratic = parseSVG(svg('M0 0 Q10 10 20 0 Z M0 0 Q0 0 40 0'));

    for (const [actual, expected] of [[smoothCubic, explicitCubic], [smoothQuadratic, explicitQuadratic]]) {
        assert.equal(actual.length, 2);
        assert.equal(expected.length, 2);
        assert.equal(actual[1].moves.length, expected[1].moves.length);
        actual[1].moves.forEach((move, i) => pointCloseTo(move.to, expected[1].moves[i].to));
    }
});
