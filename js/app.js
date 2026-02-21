/**
 * SVG to G-Code App Logic
 */

import { parseSVG } from './svg-parser.js';
import { buildAllGcodes, generateMachiningInfo } from './cam/generator.js';
import { init3DViewer, update3DToolpath, linkAnimationUI } from './viewer3d.js';

// Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const previewSvg = document.getElementById('previewSvg');
const generateBtn = document.getElementById('generateBtn');
const logText = document.getElementById('logText');

const tab2D = document.getElementById('tab2D');
const tab3D = document.getElementById('tab3D');
const preview3D = document.getElementById('preview3D');

// Animation Controls
const btnPlayPause = document.getElementById('btnPlayPause');
const btnReset = document.getElementById('btnReset');
const progressSlider = document.getElementById('progressSlider');
const lblTime = document.getElementById('lblTime');
const lblProgress = document.getElementById('lblProgress');
const speedSelect = document.getElementById('speedSelect');

let currentParts = null;

// Init 3D View
init3DViewer('preview3D');
linkAnimationUI(progressSlider, lblTime, lblProgress, btnPlayPause, speedSelect, btnReset);

tab2D.addEventListener('click', () => {
    tab2D.classList.add('active');
    tab3D.classList.remove('active');
    previewSvg.style.display = 'flex';
    preview3D.style.display = 'none';
    dropZone.style.display = '';           // show upload area in 2D
});

tab3D.addEventListener('click', () => {
    tab3D.classList.add('active');
    tab2D.classList.remove('active');
    previewSvg.style.display = 'none';
    preview3D.style.display = 'block';
    dropZone.style.display = 'none';       // hide upload area in 3D
});

// Handle Drag & Drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'image/svg+xml') {
        processFile(file);
    } else {
        log("請上傳有效的 SVG 檔案。");
    }
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        processFile(file);
    }
});

dropZone.addEventListener('click', () => {
    fileInput.click();
});

function log(msg) {
    if (logText) {
        logText.innerText = msg;
    }
    console.log(msg);
}

function processFile(file) {
    log(`正在載入 ${file.name}...`);
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const svgContent = e.target.result;
            // Display Original SVG
            previewSvg.innerHTML = svgContent;

            // Parse to Parts
            currentParts = await parseSVG(svgContent);
            currentParts.forEach((part, i) => {
                part.id = 'part_' + Date.now() + '_' + i;
            });

            log(`已從 SVG 成功解析出 ${currentParts.length} 個切削零件路徑。`);
            generateBtn.disabled = currentParts.length === 0;

            // Make SVG elements interactive
            setupSvgInteractions(currentParts);

            // Render toolpath order list
            renderToolpathList();

        } catch (err) {
            log(`解析 SVG 時發生錯誤: ${err.message}`);
            generateBtn.disabled = true;
        }
    };
    reader.readAsText(file);
}

function setupSvgInteractions(parts) {
    const svgEl = previewSvg.querySelector('svg');
    if (!svgEl) return;

    // Use querySelectorAll to get the paths in the same order as parsed
    const shapes = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
    const elements = svgEl.querySelectorAll(shapes.join(','));

    // Assign index and click listener
    elements.forEach((el, index) => {
        if (index < parts.length) {
            el.dataset.partId = parts[index].id;
            // Set default mode
            if (!parts[index].toolpathMode) {
                parts[index].toolpathMode = 'none';
                el.classList.add('path-none');
            }

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                // Ignore click if we were dragging
                if (isDraggingSvg) return;

                // Get selected toolpath mode from radio buttons
                const selectedModeRadio = document.querySelector('input[name="toolpathMode"]:checked');
                const selectedMode = selectedModeRadio ? selectedModeRadio.value : 'on-path';

                // Find matching part by ID
                const partIndex = currentParts.findIndex(p => p.id === el.dataset.partId);
                if (partIndex !== -1) {
                    // Update part data
                    currentParts[partIndex].toolpathMode = selectedMode;

                    // Click-to-order logic: first clicked -> #1, second -> #2, etc.
                    if (!currentParts[partIndex].listOrdered) {
                        const [movedPart] = currentParts.splice(partIndex, 1);
                        movedPart.listOrdered = true;

                        // Insert after the last ordered part
                        const insertIndex = currentParts.findIndex(p => !p.listOrdered);
                        if (insertIndex === -1) {
                            currentParts.push(movedPart); // all others are ordered, put at end
                        } else {
                            currentParts.splice(insertIndex, 0, movedPart);
                        }
                    }

                    // Update CSS class
                    el.classList.remove('path-on-path', 'path-outside', 'path-inside', 'path-drill', 'path-none');
                    el.classList.add(`path-${selectedMode}`);

                    // Re-find index to log the correct new position
                    const newIndex = currentParts.findIndex(p => p.id === el.dataset.partId);

                    let modeName = '不加工';
                    if (selectedMode === 'outside') modeName = '銑線外';
                    if (selectedMode === 'inside') modeName = '銑線內';
                    if (selectedMode === 'drill') modeName = '鑽孔';
                    if (selectedMode === 'on-path') modeName = '銑線上';

                    log(`已將路徑 #${newIndex + 1} 設為 ${modeName}。`);

                    // Re-render toolpath list to update badges and order
                    renderToolpathList();
                }
            });
        }
    });

    // Implement Pan and Zoom
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;

    // Use a wrapper or transform the SVG directly? 
    // It's safer to transform the SVG element itself.
    svgEl.style.transformOrigin = 'center center';

    function updateTransform() {
        svgEl.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    // Zoom (Mouse Wheel)
    previewSvg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
        scale *= zoomDelta;
        // Limit zoom
        scale = Math.max(0.1, Math.min(scale, 10));
        updateTransform();
    }, { passive: false });

    // Pan (Mouse Drag)
    previewSvg.addEventListener('mousedown', (e) => {
        // Only pan on left click background (not on the path if we want to click path)
        // Wait, to allow both: click on path selects it, drag pans.
        isDragging = true;
        isDraggingSvg = false;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        previewSvg.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        isDraggingSvg = true; // Flage to prevent click event on paths
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateTransform();
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
        previewSvg.style.cursor = 'default';
        // Reset the drag flag slightly after to allow click events to complete
        setTimeout(() => isDraggingSvg = false, 50);
    });

    // Initial reset
    updateTransform();
}

// Global flag to prevent click after drag
let isDraggingSvg = false;

function getMfgData() {
    return {
        safeZ: parseFloat(document.getElementById('safeZ').value) || 5,
        thickness: parseFloat(document.getElementById('thickness').value) || 3,
        overcut: parseFloat(document.getElementById('overcut').value) || 0.5,
        stepdown: parseFloat(document.getElementById('stepdown').value) || 1,
        feedXY: parseFloat(document.getElementById('feedXY').value) || 1000,
        feedZ: parseFloat(document.getElementById('feedZ').value) || 300,
        spindle: parseFloat(document.getElementById('spindle').value) || 10000,
        toolD: parseFloat(document.getElementById('toolD').value) || 3.175,
        postProcessor: document.getElementById('postProcessor').value || 'grbl',
        originMode: document.getElementById('originMode').value || 'top-bottomleft',
        holeMode: 'drill',
        tabThickness: 0,
        tabWidth: 0,
        tabCount: 0
    };
}

/**
 * Compute bounding box of all points across all parts
 */
function computePartsExtents(parts) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const p of parts) {
        if (!p.points) continue;
        for (const pt of p.points) {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
        }
    }
    return { minX, maxX, minY, maxY };
}

/**
 * Apply XY and Z offset to the generated G-code text.
 * Shifts every X, Y, Z coordinate by the given offsets.
 */
function applyGcodeOffset(gcodeText, offsetX, offsetY, offsetZ) {
    if (offsetX === 0 && offsetY === 0 && offsetZ === 0) return gcodeText;

    return gcodeText.split('\n').map(line => {
        // Skip comments, non-coordinate lines
        if (line.startsWith('(') || line.startsWith('%') ||
            line.startsWith('M') || line.startsWith('G20') || line.startsWith('G21')) {
            return line;
        }
        if (!/[XYZ]/.test(line)) return line;

        return line.replace(/([XYZ])([-\d.]+)/g, (match, axis, val) => {
            const v = parseFloat(val);
            if (axis === 'X') return `X${(v + offsetX).toFixed(4)}`;
            if (axis === 'Y') return `Y${(v + offsetY).toFixed(4)}`;
            if (axis === 'Z') return `Z${(v + offsetZ).toFixed(4)}`;
            return match;
        });
    }).join('\n');
}

// Generate G-Code
generateBtn.addEventListener('click', () => {
    if (!currentParts || currentParts.length === 0) return;

    const mfg = getMfgData();

    try {
        log("正在計算並生成 G-code...");
        const files = buildAllGcodes(currentParts, mfg);
        const info = generateMachiningInfo(mfg, currentParts.length);

        if (files.length > 0) {
            const mergedLines = [];
            mergedLines.push(`(SVG to GCODE Export - ${new Date().toLocaleString()})`);
            files.forEach(f => mergedLines.push(f.text));

            let txt = mergedLines.join('\n');

            // --- Origin Offset ---
            const extents = computePartsExtents(currentParts);
            let offsetX = 0, offsetY = 0, offsetZ = 0;

            if (extents.minX !== Infinity) {
                const cx = (extents.minX + extents.maxX) / 2;
                const cy = (extents.minY + extents.maxY) / 2;
                const mode = mfg.originMode;

                // XY: center subtracts midpoint; bottomleft subtracts min corner
                offsetX = mode.includes('center') ? -cx : -extents.minX;
                offsetY = mode.includes('center') ? -cy : -extents.minY;
                // Z: bottom shifts so Z0 = bottom face of material
                offsetZ = mode.startsWith('bottom') ? mfg.thickness : 0;
            }

            txt = applyGcodeOffset(txt, offsetX, offsetY, offsetZ);

            // Update 3D Viewer
            update3DToolpath(txt, mfg);

            // Switch to 3D tab
            if (!tab3D.classList.contains('active')) {
                tab3D.click();
            }

            // Download
            const blob = new Blob([txt], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `svg_export_${Date.now()}.nc`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            const originLabels = {
                'top-center': '頂面中心',
                'top-bottomleft': '頂面左下角',
                'bottom-center': '底面中心',
                'bottom-bottomleft': '底面左下角'
            };
            const originLabel = originLabels[mfg.originMode] || mfg.originMode;

            log(`成功！G-Code 檔案已下載。\n工件原點：${originLabel}\n\n${info}`);
        }
    } catch (err) {
        log(`生成 G-code 時發生錯誤: ${err.message}`);
    }
});

// --- Toolpath Ordering Logic ---
let draggedPartId = null;

function renderToolpathList() {
    const list = document.getElementById('toolpathList');
    if (!list) return;

    if (!currentParts || currentParts.length === 0) {
        list.innerHTML = '<div style="padding: 10px; color: var(--text-muted); text-align: center; font-size: 0.85rem;">等待載入 SVG 檔案...</div>';
        return;
    }

    list.innerHTML = '';

    currentParts.forEach((part, index) => {
        const el = document.createElement('div');
        el.className = 'toolpath-item';
        el.draggable = true;
        el.dataset.id = part.id;

        let modeLabel = '不加工 (None)';
        if (part.toolpathMode === 'on-path') modeLabel = '線上 (On Path)';
        if (part.toolpathMode === 'outside') modeLabel = '線外 (Outside)';
        if (part.toolpathMode === 'inside') modeLabel = '線內 (Inside)';
        if (part.toolpathMode === 'drill') modeLabel = '鑽孔 (Drill)';

        el.innerHTML = `
            <span><strong style="color:var(--text-muted)">#${index + 1}</strong> 路徑</span>
            <span class="mode-badge ${part.toolpathMode || 'none'}">${modeLabel}</span>
        `;

        el.addEventListener('dragstart', (e) => {
            draggedPartId = part.id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', part.id);
            setTimeout(() => el.classList.add('dragging'), 0);
        });

        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            // Add a visual cue if needed here (e.g. margin or border on the dragged-over element)
        });

        el.addEventListener('drop', (e) => {
            e.preventDefault();
            if (draggedPartId && draggedPartId !== part.id) {
                // Reorder currentParts
                const fromIndex = currentParts.findIndex(p => p.id === draggedPartId);
                const toIndex = currentParts.findIndex(p => p.id === part.id);

                if (fromIndex !== -1 && toIndex !== -1) {
                    const [movedPart] = currentParts.splice(fromIndex, 1);
                    currentParts.splice(toIndex, 0, movedPart);
                    // Rerender list
                    renderToolpathList();
                    log(`已調整加工順序：移至 #${toIndex + 1}。`);
                }
            }
        });

        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            draggedPartId = null;
        });

        // Highlight corresponding SVG element on hover
        el.addEventListener('mouseenter', () => {
            const svgEl = previewSvg.querySelector(`svg [data-part-id="${part.id}"]`);
            if (svgEl) {
                svgEl.style.strokeWidth = '3px';
                svgEl.style.opacity = '0.5';
            }
        });
        el.addEventListener('mouseleave', () => {
            const svgEl = previewSvg.querySelector(`svg [data-part-id="${part.id}"]`);
            if (svgEl) {
                svgEl.style.strokeWidth = '';
                svgEl.style.opacity = '';
            }
        });

        list.appendChild(el);
    });
}

