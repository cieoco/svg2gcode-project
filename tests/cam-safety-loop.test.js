import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { validateArrayPlan, MAX_ARRAY_COPIES, MAX_ARRAY_PARTS } from '../js/cam/array-plan.js';
import { buildAllGcodes, buildPartGcode } from '../js/cam/generator.js';

const part = { id: 'p', barStyle: 'path', toolpathMode: 'on-path',
    startPoint: { x: 0, y: 0 }, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    moves: [{ type: 'line', to: { x: 10, y: 0 } }] };
const mfg = { safeZ: 5, feedXY: 500, feedZ: 100, thickness: 7,
    overcut: 0, stepdown: 1, toolD: 3, faceEnable: false, surfaceCleanDepth: 0 };

test('both CAM APIs reject invalid non-through cuts before emitting G-code', () => {
    for (const partialDepth of [0, -1, NaN, Infinity, 7, 20]) {
        const partial = { ...part, isPartial: true, partialDepth };
        assert.throws(() => buildAllGcodes([partial], mfg), /非貫穿/);
        assert.throws(() => buildPartGcode(partial, mfg), /非貫穿/);
    }
    assert.match(buildAllGcodes([{ ...part, isPartial: true, partialDepth: 2 }], mfg)[0].text, /G1 Z-2/);
    assert.deepEqual(buildPartGcode({ ...part, toolpathMode: 'none', isPartial: true, partialDepth: 0 }, mfg), []);
});

test('array limits reject large copies and total paths before allocation', () => {
    assert.equal(validateArrayPlan(5, { arrayCountX: 20, arrayCountY: 20 }), null);
    assert.match(validateArrayPlan(1, { arrayCountX: MAX_ARRAY_COPIES + 1, arrayCountY: 1 }), /最多/);
    assert.match(validateArrayPlan(1, { arrayCountX: 21, arrayCountY: 20 }), /最多/);
    assert.match(validateArrayPlan(6, { arrayCountX: 20, arrayCountY: 20 }), new RegExp(String(MAX_ARRAY_PARTS)));
    assert.match(validateArrayPlan(1, { arrayCountX: Infinity, arrayCountY: 1 }), /整數/);
    assert.equal(validateArrayPlan(0, { arrayCountX: 100000, arrayCountY: 100000 }), null);
});

test('failed new file import clears the old design and disables stale generation', async () => {
    const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('function processFile(file) {');
    const code = source.slice(start, source.indexOf('\n}', start) + 2);
    const messages = [];
    let generatedEnabled = true;
    let previewCleared = false;
    const sandbox = {
        fileLoadSequence: 0, fileLoadPending: false, file: { name: 'broken.svg' },
        currentParts: [part], hanziBaseParts: [part],
        cleanupPreviewInteractions: null, refreshPreviewTransform: null,
        resetPreviewView: null, fileInput: { value: 'old.svg' }, previewSvg: { innerHTML: 'old' },
        isSvgFile: () => true, isDxfFile: () => false,
        renderPreviewSvg: () => { previewCleared = sandbox.currentParts === null; },
        renderToolpathList: () => {}, update3DToolpath: () => {},
        updateGenerateButtonState: () => { generatedEnabled = sandbox.currentParts !== null; },
        log: message => messages.push(message),
        parseSVG: () => { throw new Error('malformed SVG'); },
        FileReader: class { readAsText() { this.onload({ target: { result: '<bad>' } }); } }
    };
    vm.runInNewContext(code + '\nprocessFile(file)', sandbox);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sandbox.currentParts, null);
    assert.equal(sandbox.hanziBaseParts, null);
    assert.equal(sandbox.fileLoadPending, false);
    assert.equal(generatedEnabled, false);
    assert.equal(previewCleared, true);
    assert.equal(sandbox.previewSvg.innerHTML, '');
    assert.match(messages.at(-1), /malformed SVG/);
});
