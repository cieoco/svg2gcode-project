import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildAllGcodes, generateMachiningInfo } from '../js/cam/generator.js';
import { gcodeHeader, gcodeFooter } from '../js/cam/operations.js';
import { validateMachiningInputs } from '../js/cam/validation.js';
import { getProgramOriginContext } from '../js/cam/program-context.js';
import { validateArrayPlan } from '../js/cam/array-plan.js';

// Run the actual UI program builder with settings supplied in memory.
const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const functions = ['buildProgram', 'computePartsExtents', 'parseFaceOrigin', 'applyGcodeOffset'];
const code = functions.map(name => {
    const start = source.indexOf('function ' + name + '(');
    return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');
const defaults = {
    faceEnable: true, surfaceCleanDepth: 1, stockW: 50, stockH: 20, stockT: 7,
    faceOrigin: 'bl-bottom', originMode: 'top-bottomleft', safeZ: 10,
    faceToolD: 10, faceFeedXY: 500, faceFeedZ: 100, faceStepdown: 0.4,
    faceFinishAllow: 0.2, faceFinishFeed: 200, faceSpindle: 12000, faceSpindleDir: 'ccw',
    faceOverlapPct: 40, facePattern: 'oneway',
    toolD: 3, feedXY: 500, feedZ: 100, stepdown: 1, thickness: 7, overcut: 0,
    spindle: 10000, spindleDir: 'cw', postProcessor: 'grbl', materialType: 'wood'
};
const part = { id: 'part', toolpathMode: 'on-path', barStyle: 'path',
    startPoint: { x: 0, y: 0 }, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    moves: [{ type: 'line', to: { x: 10, y: 0 } }] };
function build(overrides = {}, parts = [part]) {
    const sandbox = {
        currentParts: parts, fileLoadPending: false,
        persistSettings: () => ({ mfg: { ...defaults, ...overrides }, layout: {} }),
        buildArrayParts: p => p, ACTIVE_TOOLPATH_MODES: ['on-path', 'inside', 'outside', 'drill'],
        FACE_CORNER_NAMES: { bl: '左下', br: '右下', tl: '左上', tr: '右上', center: '中心' },
        collectSafetyWarnings: () => [], materialCommentName: () => 'WOOD',
        buildAllGcodes, generateMachiningInfo, gcodeHeader, gcodeFooter,
        validateMachiningInputs, getProgramOriginContext, validateArrayPlan
    };
    return vm.runInNewContext(code + '\nbuildProgram()', sandbox);
}

test('merged facing uses its own inputs, spindle and finish pass without contour cutting', () => {
    const result = build({ toolD: NaN, feedXY: NaN, feedZ: NaN, thickness: NaN, stepdown: NaN });
    assert.ok(!result.blocked);
    assert.match(result.txt, /M4/);
    assert.match(result.txt, /FACE FINISH PASS/);
    assert.match(result.txt, /G1 Z6(?:\D|$)/);
    assert.doesNotMatch(result.txt, /NaN/);
    assert.equal(result.viewerMfg.thickness, 7);
    assert.equal(result.viewerMfg.originMode, 'bottom-face');
});

test('merged UI blocks invalid facing feed, finish feed and missing bottom datum', () => {
    for (const overrides of [{ faceFeedXY: NaN }, { faceToolD: 0 }, { faceFinishFeed: 0 },
        { faceStepdown: 0 }, { stockT: 0 }, { surfaceCleanDepth: 7 }]) {
        assert.equal(build(overrides).blocked, true, JSON.stringify(overrides));
    }
});

test('merged zero-depth facing preserves bottom datum while ordinary contours cut', () => {
    const result = build({ surfaceCleanDepth: 0, faceStepdown: NaN, faceFeedXY: NaN });
    assert.ok(!result.blocked);
    assert.doesNotMatch(result.txt, /FACE STOCK/);
    assert.match(result.txt, /G0 Z17/);
    assert.match(result.txt, /G1 Z0(?:\D|$)/);
    assert.equal(result.viewerMfg.originMode, 'bottom-face');
});
