/**
 * SVG Parser Module
 * Parse SVG file content and extract scalable and translatable
 * path shapes suitable for G-code generation.
 */

/**
 * Clean up SVG string
 */
function cleanSVG(svgStr) {
    return svgStr.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * Convert SVG primitives to path commands string
 */
function primitiveToPath(el) {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
        case 'rect': {
            const x = parseFloat(el.getAttribute('x')) || 0;
            const y = parseFloat(el.getAttribute('y')) || 0;
            const w = parseFloat(el.getAttribute('width')) || 0;
            const h = parseFloat(el.getAttribute('height')) || 0;
            let rx = parseFloat(el.getAttribute('rx')) || 0;
            let ry = parseFloat(el.getAttribute('ry')) || 0;
            // If only one is set, SVG spec says the other matches
            if (!rx && ry) rx = ry;
            if (!ry && rx) ry = rx;
            // Clamp to half of dimensions
            rx = Math.min(rx, w / 2);
            ry = Math.min(ry, h / 2);
            if (rx === 0 && ry === 0) {
                // Sharp rectangle
                return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
            }
            // Rounded rectangle using arc commands
            return `M ${x + rx},${y}` +
                ` H ${x + w - rx}` +
                ` A ${rx},${ry} 0 0 1 ${x + w},${y + ry}` +
                ` V ${y + h - ry}` +
                ` A ${rx},${ry} 0 0 1 ${x + w - rx},${y + h}` +
                ` H ${x + rx}` +
                ` A ${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
                ` V ${y + ry}` +
                ` A ${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
        }

        case 'circle':
            const cx = parseFloat(el.getAttribute('cx')) || 0;
            const cy = parseFloat(el.getAttribute('cy')) || 0;
            const r = parseFloat(el.getAttribute('r')) || 0;
            // Approximate circle with bezier curves or simple 4-quadrant arcs
            return `M ${cx - r},${cy} a ${r},${r} 0 1,0 ${r * 2},0 a ${r},${r} 0 1,0 -${r * 2},0`;

        case 'ellipse':
            const ecx = parseFloat(el.getAttribute('cx')) || 0;
            const ecy = parseFloat(el.getAttribute('cy')) || 0;
            const rx = parseFloat(el.getAttribute('rx')) || 0;
            const ry = parseFloat(el.getAttribute('ry')) || 0;
            return `M ${ecx - rx},${ecy} a ${rx},${ry} 0 1,0 ${rx * 2},0 a ${rx},${ry} 0 1,0 -${rx * 2},0`;

        case 'line':
            const x1 = parseFloat(el.getAttribute('x1')) || 0;
            const y1 = parseFloat(el.getAttribute('y1')) || 0;
            const x2 = parseFloat(el.getAttribute('x2')) || 0;
            const y2 = parseFloat(el.getAttribute('y2')) || 0;
            return `M ${x1} ${y1} L ${x2} ${y2}`;

        case 'polyline':
        case 'polygon':
            const points = el.getAttribute('points');
            if (!points) return '';
            const pts = points.trim().split(/[\s,]+/).map(parseFloat);
            if (pts.length < 2) return '';
            let path = `M ${pts[0]} ${pts[1]}`;
            for (let i = 2; i < pts.length; i += 2) {
                path += ` L ${pts[i]} ${pts[i + 1]}`;
            }
            if (tag === 'polygon') path += ' Z';
            return path;

        case 'path':
            return el.getAttribute('d') || '';

        default:
            return '';
    }
}

/**
 * Extracts point coordinates from path nodes.
 * Simplified parser: converts everything to points (lines).
 * Note: A real robust parser would use an SVGPathElement and getPointAtLength()
 * or heavily parse bezier curves. For MVP, we depend on the browser's 
 * SVG DOM capabilities to sample the path.
 */
export function parseSVG(svgText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(cleanSVG(svgText), "image/svg+xml");
    const svgEl = doc.querySelector('svg');

    if (!svgEl) {
        throw new Error("Invalid SVG content.");
    }

    // Detect SVG viewport units and compute a scale-to-mm factor.
    // The browser's getPointAtLength() returns values in SVG user units.
    // We need to know how many mm one SVG user unit represents.
    let svgToMm = 1; // default: assume SVG units are already mm

    const svgWidth = svgEl.getAttribute('width') || '';
    const svgHeight = svgEl.getAttribute('height') || '';

    // Helper: parse a dimension string like "15cm", "6in", "400px" into mm
    const parseDimMm = (str) => {
        const m = str.trim().match(/^([\d.]+)\s*(cm|mm|in|pt|px)?$/i);
        if (!m) return null;
        const val = parseFloat(m[1]);
        const unit = (m[2] || 'px').toLowerCase();
        const toMm = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 };
        return val * (toMm[unit] || 1);
    };

    const viewBox = svgEl.getAttribute('viewBox');
    if (viewBox && svgWidth) {
        const vbParts = viewBox.trim().split(/[\s,]+/).map(parseFloat);
        const vbW = vbParts[2]; // viewBox width in user units
        const physW = parseDimMm(svgWidth); // physical width in mm
        if (vbW && physW) {
            svgToMm = physW / vbW; // user-unit → mm
        }
    } else if (svgWidth) {
        // No viewBox: treat width attribute value as direct mm/unit size
        const physW = parseDimMm(svgWidth);
        if (physW !== null) svgToMm = physW / parseFloat(svgWidth);
    }

    // Convert primitives to paths
    const shapes = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
    const parts = [];

    // Create a temporary hidden SVG container to leverage browser Path API
    const hiddenSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    hiddenSvg.style.display = 'none';
    document.body.appendChild(hiddenSvg);

    const elements = doc.querySelectorAll(shapes.join(','));
    let partIdCounter = 1;

    elements.forEach(el => {
        const d = primitiveToPath(el);
        if (!d) return;

        const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
        pathEl.setAttribute("d", d);
        hiddenSvg.appendChild(pathEl);

        const length = pathEl.getTotalLength();
        if (length === 0) return;

        // Build a transform matrix from the element's transform attribute
        // Handles matrix(a,b,c,d,e,f), translate(x,y), scale(s)
        let matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; // identity
        const transformAttr = el.getAttribute('transform');
        if (transformAttr) {
            const matrixMatch = transformAttr.match(/matrix\s*\(\s*([^\)]+)\)/);
            if (matrixMatch) {
                const vals = matrixMatch[1].trim().split(/[\s,]+/).map(parseFloat);
                if (vals.length === 6) {
                    matrix = { a: vals[0], b: vals[1], c: vals[2], d: vals[3], e: vals[4], f: vals[5] };
                }
            } else {
                const translateMatch = transformAttr.match(/translate\s*\(\s*([^\)]+)\)/);
                if (translateMatch) {
                    const vals = translateMatch[1].trim().split(/[\s,]+/).map(parseFloat);
                    matrix.e = vals[0] || 0;
                    matrix.f = vals[1] || 0;
                }
            }
        }

        // Helper: apply 2D affine matrix to a point
        const applyMatrix = (pt) => ({
            x: matrix.a * pt.x + matrix.c * pt.y + matrix.e,
            y: matrix.b * pt.x + matrix.d * pt.y + matrix.f
        });

        // Sample points along the path
        const points = [];
        // length is in SVG user units; convert to mm for sample density calculation
        const lengthMm = length * svgToMm;
        // 0.5mm step for accurate curve representation; cap at 4000 pts
        const numSamples = Math.min(4000, Math.max(64, Math.ceil(lengthMm / 0.5)));
        const step = length / numSamples;

        for (let i = 0; i <= numSamples; i++) {
            const rawPt = pathEl.getPointAtLength(i * step);
            const pt = applyMatrix(rawPt);
            // Convert from SVG user units to mm, flip Y for CNC coordinate system
            points.push({ x: pt.x * svgToMm, y: -pt.y * svgToMm });
        }

        // Close path if needed
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) > 0.1 && d.toLowerCase().endsWith('z')) {
            points.push({ x: first.x, y: first.y });
        }

        parts.push({
            id: `Part_${partIdCounter++}`,
            barStyle: 'path',
            points: points,
            holes: []
        });
    });

    document.body.removeChild(hiddenSvg);
    return parts;
}
