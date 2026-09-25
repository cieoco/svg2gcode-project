/** Manage SVG preview gestures without changing the underlying CAM geometry. */
export function attachPreviewGestures({ container, svg, rotation = () => 0, onBoxSelect = () => {} }) {
    const pointers = new Map();
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let drag = null;
    let pinch = null;
    let suppressClickUntil = 0;
    const selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    selectionBox.hidden = true;
    container.appendChild(selectionBox);

    const render = (animate = false) => {
        svg.style.transformOrigin = 'center center';
        svg.style.transition = animate ? 'transform 0.2s ease-in-out' : 'none';
        svg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale}) rotate(${rotation()}deg)`;
    };
    const point = e => {
        const rect = container.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const clampScale = value => Math.max(0.2, Math.min(value, 10));
    const zoomAt = (factor, x, y) => {
        const rect = container.getBoundingClientRect();
        const cx = x - rect.width / 2;
        const cy = y - rect.height / 2;
        const next = clampScale(scale * factor);
        const ratio = next / scale;
        panX = cx - (cx - panX) * ratio;
        panY = cy - (cy - panY) * ratio;
        scale = next;
        render();
    };
    const reset = () => {
        scale = 1;
        panX = 0;
        panY = 0;
        render(true);
    };
    const makePinch = () => {
        const [a, b] = [...pointers.values()];
        return { distance: Math.hypot(a.x - b.x, a.y - b.y),
            center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    const hideSelection = () => { selectionBox.hidden = true; };
    const onDown = e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        pointers.set(e.pointerId, point(e));
        if (pointers.size === 2) {
            pinch = makePinch();
            drag = null;
            hideSelection();
            suppressClickUntil = Date.now() + 500;
        } else if (pointers.size === 1) {
            const p = point(e);
            drag = { pointerId: e.pointerId, start: p, last: p,
                touch: e.pointerType !== 'mouse', selecting: false, moved: false };
        }
    };
    const onMove = e => {
        if (!pointers.has(e.pointerId)) return;
        const p = point(e);
        pointers.set(e.pointerId, p);
        if (pointers.size >= 2) {
            const next = makePinch();
            if (pinch && pinch.distance > 0) {
                zoomAt(next.distance / pinch.distance, pinch.center.x, pinch.center.y);
                panX += next.center.x - pinch.center.x;
                panY += next.center.y - pinch.center.y;
                render();
            }
            pinch = next;
            suppressClickUntil = Date.now() + 500;
            return;
        }
        if (!drag || drag.pointerId !== e.pointerId) return;
        if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 7) return;
        drag.moved = true;
        if (drag.touch) {
            panX += p.x - drag.last.x;
            panY += p.y - drag.last.y;
            render();
            suppressClickUntil = Date.now() + 500;
        } else {
            drag.selecting = true;
            selectionBox.hidden = false;
            selectionBox.style.left = `${Math.min(drag.start.x, p.x)}px`;
            selectionBox.style.top = `${Math.min(drag.start.y, p.y)}px`;
            selectionBox.style.width = `${Math.abs(p.x - drag.start.x)}px`;
            selectionBox.style.height = `${Math.abs(p.y - drag.start.y)}px`;
            suppressClickUntil = Date.now() + 500;
        }
        drag.last = p;
    };
    const onEnd = e => {
        if (!pointers.has(e.pointerId)) return;
        if (drag?.pointerId === e.pointerId && drag.selecting && e.type === 'pointerup') {
            onBoxSelect(selectionBox.getBoundingClientRect());
        }
        pointers.delete(e.pointerId);
        drag = null;
        pinch = null;
        hideSelection();
        // A remaining finger must be lifted before starting another gesture.
    };
    const onWheel = e => {
        e.preventDefault();
        const p = point(e);
        zoomAt(e.deltaY > 0 ? 0.9 : 1.1, p.x, p.y);
    };
    const onClick = e => {
        if (Date.now() < suppressClickUntil) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    container.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    container.addEventListener('lostpointercapture', onEnd);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('click', onClick, true);
    render();
    return {
        render, reset,
        destroy() {
            container.removeEventListener('pointerdown', onDown);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointercancel', onEnd);
            container.removeEventListener('lostpointercapture', onEnd);
            container.removeEventListener('wheel', onWheel);
            container.removeEventListener('click', onClick, true);
            selectionBox.remove();
        }
    };
}
