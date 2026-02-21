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
        case 'rect':
            const x = parseFloat(el.getAttribute('x')) || 0;
            const y = parseFloat(el.getAttribute('y')) || 0;
            const w = parseFloat(el.getAttribute('width')) || 0;
            const h = parseFloat(el.getAttribute('height')) || 0;
            return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
            
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
    
    // Parse Viewbox and Width/Height for scaling
    let scaleX = 1;
    let scaleY = 1;
    let offsetX = 0;
    let offsetY = 0;

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

        // Sample points along the path
        const points = [];
        // Adaptive sampling based on length
        const step = Math.max(0.1, Math.min(1.0, length / 200)); 
        
        for (let i = 0; i <= length; i += step) {
            const pt = pathEl.getPointAtLength(i);
            points.push({ x: pt.x, y: -pt.y }); // Y is flipped in CNC compared to SVG
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
            holes: [] // Ignore holes within paths for simple MVP
        });
    });

    document.body.removeChild(hiddenSvg);
    return parts;
}
