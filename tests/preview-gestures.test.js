import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachPreviewGestures } from '../js/preview-gestures.js';

function fixture() {
    const dom = new JSDOM('<div id="preview"><svg><path id="part"/></svg></div>');
    const { window } = dom;
    const prior = { window: globalThis.window, document: globalThis.document };
    globalThis.window = window;
    globalThis.document = window.document;
    const container = window.document.getElementById('preview');
    const svg = container.querySelector('svg');
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
    let selected = 0;
    const gestures = attachPreviewGestures({ container, svg, onBoxSelect: () => selected++ });
    const pointer = (type, id, pointerType, x, y) => {
        const event = new window.Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: id, pointerType, clientX: x, clientY: y, button: 0 });
        (type === 'pointerdown' ? container : window).dispatchEvent(event);
    };
    return {
        window, container, svg, gestures, pointer,
        selected: () => selected,
        close() { gestures.destroy(); dom.window.close(); globalThis.window = prior.window; globalThis.document = prior.document; }
    };
}

test('tap still selects a path, while touch pan suppresses an accidental click', () => {
    const f = fixture();
    try {
        let clicks = 0;
        f.svg.addEventListener('click', () => clicks++);
        f.pointer('pointerdown', 1, 'touch', 50, 50);
        f.pointer('pointerup', 1, 'touch', 50, 50);
        f.svg.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(clicks, 1);
        f.pointer('pointerdown', 2, 'touch', 50, 50);
        f.pointer('pointermove', 2, 'touch', 95, 50);
        f.pointer('pointerup', 2, 'touch', 95, 50);
        f.svg.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(clicks, 1);
        assert.match(f.svg.style.transform, /translate\(45px, 0px\)/);
    } finally { f.close(); }
});

test('two touch pointers zoom and fit view resets pan and scale', () => {
    const f = fixture();
    try {
        f.pointer('pointerdown', 1, 'touch', 100, 100);
        f.pointer('pointerdown', 2, 'touch', 200, 100);
        f.pointer('pointermove', 2, 'touch', 250, 100);
        assert.match(f.svg.style.transform, /scale\(1\.5\)/);
        f.gestures.reset();
        assert.equal(f.svg.style.transform, 'translate(0px, 0px) scale(1) rotate(0deg)');
    } finally { f.close(); }
});

test('mouse drag retains box selection, and cleanup removes handlers', () => {
    const f = fixture();
    try {
        f.pointer('pointerdown', 1, 'mouse', 20, 20);
        f.pointer('pointermove', 1, 'mouse', 120, 120);
        f.pointer('pointerup', 1, 'mouse', 120, 120);
        assert.equal(f.selected(), 1);
        f.gestures.destroy();
        f.pointer('pointerdown', 2, 'mouse', 20, 20);
        f.pointer('pointermove', 2, 'mouse', 120, 120);
        f.pointer('pointerup', 2, 'mouse', 120, 120);
        assert.equal(f.selected(), 1);
    } finally { f.close(); }
});
