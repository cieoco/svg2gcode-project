import test from 'node:test';
import assert from 'node:assert/strict';
import { getProgramOriginContext } from '../js/cam/program-context.js';

const stockBounds = { minX: -20, minY: -10, maxX: 20, maxY: 10 };

test('top-face datum keeps XY stock corner with a cleaning pass', () => {
    const context = getProgramOriginContext({
        faceEnable: true,
        faceOrigin: 'br-top',
        faceDepth: 1,
        stockBounds,
        thickness: 7,
        originMode: 'bottom-center'
    });

    assert.equal(context.useFaceDatum, true);
    assert.equal(context.faceMotionActive, true);
    assert.equal(context.corner, 'br');
    assert.equal(context.offsetZ, 0);
    assert.equal(context.viewerOriginMode, 'top-face');
});

test('bottom-face datum offsets by stock thickness with a cleaning pass', () => {
    const context = getProgramOriginContext({
        faceEnable: true,
        faceOrigin: 'bl-bottom',
        faceDepth: 3,
        stockBounds,
        thickness: 10,
        originMode: 'top-bottomleft'
    });

    assert.equal(context.useFaceDatum, true);
    assert.equal(context.faceMotionActive, true);
    assert.equal(context.offsetZ, 10);
    assert.equal(context.viewerOriginMode, 'bottom-face');
});

test('zero-depth bottom cleaning keeps the selected bottom stock datum', () => {
    const context = getProgramOriginContext({
        faceEnable: true,
        faceOrigin: 'bl-bottom',
        faceDepth: 0,
        stockBounds,
        thickness: 7,
        originMode: 'top-bottomleft'
    });

    assert.equal(context.faceMotionActive, false);
    assert.equal(context.useFaceDatum, true);
    assert.equal(context.offsetZ, 7);
    assert.equal(context.viewerOriginMode, 'bottom-face');
});

test('disabled cleaning uses the selected regular origin mode', () => {
    const context = getProgramOriginContext({
        faceEnable: false,
        faceOrigin: 'br-bottom',
        faceDepth: 0,
        stockBounds,
        thickness: 7,
        originMode: 'bottom-bottomleft'
    });

    assert.equal(context.faceMotionActive, false);
    assert.equal(context.useFaceDatum, false);
    assert.equal(context.offsetZ, 7);
    assert.equal(context.viewerOriginMode, 'bottom-bottomleft');
});
