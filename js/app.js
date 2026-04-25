/**
 * SVG to G-Code App Logic
 */

import { parseSVG } from './svg-parser.js';
import { parseDXF } from './dxf-parser.js';
import { buildAllGcodes, generateMachiningInfo } from './cam/generator.js';
import { gcodeHeader, gcodeFooter } from './cam/operations.js';
import { init3DViewer, update3DToolpath, linkAnimationUI, reset3DView } from './viewer3d.js';

// Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const previewSvg = document.getElementById('previewSvg');
const generateBtn = document.getElementById('generateBtn');
const logText = document.getElementById('logText');
const themeSelect = document.getElementById('themeSelect');

const tab2D = document.getElementById('tab2D');
const tab3D = document.getElementById('tab3D');
const preview3D = document.getElementById('preview3D');

// Animation Controls
const btnPlayPause = document.getElementById('btnPlayPause');
const btnResetView = document.getElementById('btnResetView');
const btnReset = document.getElementById('btnReset');
const progressSlider = document.getElementById('progressSlider');
const lblTime = document.getElementById('lblTime');
const lblProgress = document.getElementById('lblProgress');
const speedSelect = document.getElementById('speedSelect');

const rotateAngle = document.getElementById('rotateAngle');
const THEME_STORAGE_KEY = 'svg2gcode_theme';
let refreshPreviewTransform = null;

rotateAngle.addEventListener('input', (e) => {
    if (typeof refreshPreviewTransform === 'function') {
        refreshPreviewTransform(true);
        return;
    }
    const svgEl = previewSvg.querySelector('svg');
    if (svgEl) {
        const angle = parseFloat(e.target.value) || 0;
        svgEl.style.transform = `rotate(${angle}deg)`;
        svgEl.style.transformOrigin = 'center center';
        svgEl.style.transition = 'transform 0.2s ease-in-out';
    }
});

let currentParts = null;
let isDraggingSvg = false;
let cleanupPreviewInteractions = null;
let previewFlipY = false;

// Init 3D View
init3DViewer('preview3D');
linkAnimationUI(progressSlider, lblTime, lblProgress, btnPlayPause, speedSelect, btnReset);
if (btnResetView) {
    btnResetView.addEventListener('click', () => {
        reset3DView();
    });
}

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
    if (file && (isSvgFile(file) || isDxfFile(file))) {
        processFile(file);
    } else {
        log("請上傳有效的 SVG 或 DXF 檔案。");
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

function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('theme-light', t === 'light');
    if (themeSelect) themeSelect.value = t;
    try {
        localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch (e) {
        console.warn('Could not save theme to localStorage', e);
    }
}

function initTheme() {
    let savedTheme = 'dark';
    try {
        savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
    } catch (e) {
        console.warn('Could not load theme from localStorage', e);
    }
    applyTheme(savedTheme);
}

function isSvgFile(file) {
    if (!file) return false;
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    return name.endsWith('.svg') || type === 'image/svg+xml';
}

function isDxfFile(file) {
    if (!file) return false;
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    return name.endsWith('.dxf') || type.includes('dxf');
}

function getPreviewArraySettings() {
    const layout = getLayoutData();
    return {
        xCount: layout.arrayCountX,
        xSpacing: layout.arraySpacingX,
        yCount: layout.arrayCountY,
        ySpacing: layout.arraySpacingY
    };
}

function buildPartsPreviewSvg(parts, options = {}) {
    if (!parts || parts.length === 0) return '';

    const {
        flipY = false,
        xCount = 1,
        xSpacing = 0,
        yCount = 1,
        ySpacing = 0
    } = options;

    let minX = Infinity;
    let maxX = -Infinity;
    let minDisplayY = Infinity;
    let maxDisplayY = -Infinity;
    const renderedPaths = [];

    for (let row = 0; row < yCount; row++) {
        for (let col = 0; col < xCount; col++) {
            const offsetX = col * xSpacing;
            const offsetY = row * ySpacing;

            for (const part of parts) {
                const pts = part.points || [];
                if (pts.length < 2) continue;

                const commands = [];
                pts.forEach((point, index) => {
                    const shiftedX = point.x + offsetX;
                    const shiftedY = point.y + offsetY;
                    const displayY = flipY ? -shiftedY : shiftedY;

                    minX = Math.min(minX, shiftedX);
                    maxX = Math.max(maxX, shiftedX);
                    minDisplayY = Math.min(minDisplayY, displayY);
                    maxDisplayY = Math.max(maxDisplayY, displayY);

                    commands.push(`${index === 0 ? 'M' : 'L'} ${shiftedX.toFixed(4)} ${displayY.toFixed(4)}`);
                });

                const first = pts[0];
                const last = pts[pts.length - 1];
                const isClosed = Math.hypot(first.x - last.x, first.y - last.y) < 0.01;
                if (isClosed) {
                    commands.push('Z');
                }

                renderedPaths.push(`<path d="${commands.join(' ')}" data-source-part-id="${part.id}" class="path-${part.toolpathMode || 'none'}" fill="none"></path>`);
            }
        }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minDisplayY)) return '';

    const width = Math.max(1e-6, maxX - minX);
    const height = Math.max(1e-6, maxDisplayY - minDisplayY);
    const pad = Math.max(2, Math.max(width, height) * 0.05);
    const viewBox = `${(minX - pad).toFixed(4)} ${(minDisplayY - pad).toFixed(4)} ${(width + pad * 2).toFixed(4)} ${(height + pad * 2).toFixed(4)}`;

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${renderedPaths.join('')}</svg>`;
}

function renderPreviewSvg() {
    if (!currentParts || currentParts.length === 0) {
        previewSvg.innerHTML = '';
        return;
    }

    const arraySettings = getPreviewArraySettings();
    previewSvg.innerHTML = buildPartsPreviewSvg(currentParts, {
        flipY: previewFlipY,
        ...arraySettings
    });
    setupSvgInteractions(currentParts);
    syncPreviewPartClasses();
}

function processFile(file) {
    log(`正在載入 ${file.name}...`);
    refreshPreviewTransform = null;
    if (typeof cleanupPreviewInteractions === 'function') {
        cleanupPreviewInteractions();
        cleanupPreviewInteractions = null;
    }
    const svgFile = isSvgFile(file);
    const dxfFile = isDxfFile(file);
    if (!svgFile && !dxfFile) {
        log("不支援的檔案格式，請使用 SVG 或 DXF。");
        generateBtn.disabled = true;
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const fileContent = e.target.result;
            if (svgFile) {
                previewFlipY = false;
                currentParts = await parseSVG(fileContent);
            } else {
                previewFlipY = true;
                currentParts = parseDXF(fileContent);
            }

            currentParts.forEach((part, i) => {
                part.id = 'part_' + Date.now() + '_' + i;
            });

            const sourceLabel = svgFile ? 'SVG' : 'DXF';
            log(`已從 ${sourceLabel} 成功解析出 ${currentParts.length} 個切削零件路徑。`);
            generateBtn.disabled = currentParts.length === 0;

            renderPreviewSvg();

            // Render toolpath order list
            renderToolpathList();

        } catch (err) {
            log(`解析檔案時發生錯誤: ${err.message}`);
            generateBtn.disabled = true;
        }
    };
    reader.readAsText(file);
}

function getSelectedToolpathMode() {
    const selectedModeRadio = document.querySelector('input[name="toolpathMode"]:checked');
    return selectedModeRadio ? selectedModeRadio.value : 'on-path';
}

function getModeName(selectedMode) {
    if (selectedMode === 'outside') return '銑線外';
    if (selectedMode === 'inside') return '銑線內';
    if (selectedMode === 'drill') return '鑽孔';
    if (selectedMode === 'on-path') return '銑線上';
    return '不加工';
}

function getPartialSettings() {
    const cb = document.getElementById('partialCheck');
    const depthInput = document.getElementById('partialDepth');
    const isPartial = cb ? cb.checked : false;
    const partialDepth = depthInput ? (parseFloat(depthInput.value) || 2) : 2;
    return { isPartial, partialDepth };
}

function getSweepSettings() {
    const cb = document.getElementById('sweepCheck');
    const stepoverInput = document.getElementById('sweepStepover');
    const sweep = cb ? cb.checked : false;
    const sweepStepover = stepoverInput ? (parseFloat(stepoverInput.value) || 2) : 2;
    return { sweep, sweepStepover };
}

function syncPreviewPartClasses() {
    const elements = previewSvg.querySelectorAll('[data-source-part-id]');
    elements.forEach((el) => {
        const part = currentParts?.find((item) => item.id === el.dataset.sourcePartId);
        if (!part) return;
        el.classList.remove('path-on-path', 'path-outside', 'path-inside', 'path-drill', 'path-none', 'path-partial');
        el.classList.add(`path-${part.toolpathMode || 'none'}`);
        if (part.isPartial) el.classList.add('path-partial');
    });
}

function applyToolpathModeToPartIds(partIds, selectedMode) {
    if (!currentParts || !Array.isArray(partIds) || partIds.length === 0) return 0;
    const targetIds = new Set(partIds);
    let changedCount = 0;
    const { isPartial, partialDepth } = getPartialSettings();
    const { sweep, sweepStepover } = getSweepSettings();

    currentParts.forEach((part) => {
        if (!targetIds.has(part.id)) return;
        part.toolpathMode = selectedMode;
        part.isPartial = isPartial;
        part.partialDepth = partialDepth;
        part.sweep = selectedMode === 'inside' ? sweep : false;
        part.sweepStepover = sweepStepover;
        if (!part.listOrdered) {
            part.listOrdered = true;
        }
        changedCount += 1;
    });

    currentParts = [
        ...currentParts.filter((part) => part.listOrdered),
        ...currentParts.filter((part) => !part.listOrdered)
    ];
    syncPreviewPartClasses();
    renderToolpathList();
    return changedCount;
}

function setupSvgInteractions(parts) {
    if (typeof cleanupPreviewInteractions === 'function') {
        cleanupPreviewInteractions();
        cleanupPreviewInteractions = null;
    }

    const svgEl = previewSvg.querySelector('svg');
    if (!svgEl) return;

    const elements = svgEl.querySelectorAll('[data-source-part-id]');

    parts.forEach((part) => {
        if (!part.toolpathMode) {
            part.toolpathMode = 'none';
        }
    });

    elements.forEach((el) => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isDraggingSvg) return;
            const sourcePartId = el.dataset.sourcePartId;
            const selectedMode = getSelectedToolpathMode();
            const changedCount = applyToolpathModeToPartIds([sourcePartId], selectedMode);
            if (changedCount > 0) {
                const newIndex = currentParts.findIndex((part) => part.id === sourcePartId);
                log(`已將路徑 #${newIndex + 1} 設為 ${getModeName(selectedMode)}。`);
            }
        });
    });

    let scale = 1;
    let dragState = null;

    const selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    selectionBox.hidden = true;
    previewSvg.appendChild(selectionBox);

    svgEl.style.transformOrigin = 'center center';
    const getRotateDeg = () => (parseFloat(rotateAngle.value) || 0);

    function updateTransform(animate = false) {
        const rot = getRotateDeg();
        svgEl.style.transition = animate ? 'transform 0.2s ease-in-out' : 'none';
        svgEl.style.transform = `scale(${scale}) rotate(${rot}deg)`;
    }
    refreshPreviewTransform = (animate = false) => updateTransform(animate);

    // Zoom (Mouse Wheel)
    const handleWheel = (e) => {
        e.preventDefault();
        const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
        scale *= zoomDelta;
        scale = Math.max(0.1, Math.min(scale, 10));
        updateTransform(false);
    };
    previewSvg.addEventListener('wheel', handleWheel, { passive: false });

    const handleMouseDown = (e) => {
        if (e.button !== 0) return;
        const rect = previewSvg.getBoundingClientRect();
        dragState = {
            startX: e.clientX - rect.left,
            startY: e.clientY - rect.top,
            selecting: false
        };
        isDraggingSvg = false;
        previewSvg.style.cursor = 'crosshair';
    };
    previewSvg.addEventListener('mousedown', handleMouseDown);

    const handleMouseMove = (e) => {
        if (!dragState) return;
        const rect = previewSvg.getBoundingClientRect();
        const currentX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const currentY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        const dx = currentX - dragState.startX;
        const dy = currentY - dragState.startY;
        if (!dragState.selecting && Math.hypot(dx, dy) < 6) {
            return;
        }
        dragState.selecting = true;
        isDraggingSvg = true;
        const left = Math.min(dragState.startX, currentX);
        const top = Math.min(dragState.startY, currentY);
        selectionBox.hidden = false;
        selectionBox.style.left = `${left}px`;
        selectionBox.style.top = `${top}px`;
        selectionBox.style.width = `${Math.abs(dx)}px`;
        selectionBox.style.height = `${Math.abs(dy)}px`;
    };
    window.addEventListener('mousemove', handleMouseMove);

    const handleMouseUp = () => {
        if (!dragState) return;
        previewSvg.style.cursor = 'default';
        if (dragState.selecting && !selectionBox.hidden) {
            const boxRect = selectionBox.getBoundingClientRect();
            const selectedIds = new Set();
            elements.forEach((el) => {
                const rect = el.getBoundingClientRect();
                const fullyContained = rect.left >= boxRect.left &&
                    rect.right <= boxRect.right &&
                    rect.top >= boxRect.top &&
                    rect.bottom <= boxRect.bottom;
                if (fullyContained && el.dataset.sourcePartId) {
                    selectedIds.add(el.dataset.sourcePartId);
                }
            });
            if (selectedIds.size > 0) {
                const selectedMode = getSelectedToolpathMode();
                const changedCount = applyToolpathModeToPartIds(Array.from(selectedIds), selectedMode);
                if (changedCount > 0) {
                    log(`已將 ${changedCount} 個路徑設為 ${getModeName(selectedMode)}。`);
                }
            }
        }
        selectionBox.hidden = true;
        dragState = null;
        setTimeout(() => {
            isDraggingSvg = false;
        }, 50);
    };
    window.addEventListener('mouseup', handleMouseUp);

    updateTransform(false);

    cleanupPreviewInteractions = () => {
        previewSvg.removeEventListener('wheel', handleWheel);
        previewSvg.removeEventListener('mousedown', handleMouseDown);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        previewSvg.style.cursor = 'default';
        if (selectionBox.isConnected) {
            selectionBox.remove();
        }
        dragState = null;
        isDraggingSvg = false;
    };
}

// Helper: Save current settings to localStorage
function saveMfgData(mfg) {
    try {
        localStorage.setItem('svg2gcode_settings', JSON.stringify(mfg));
    } catch (e) {
        console.warn('Could not save settings to localStorage', e);
    }
}

// Helper: Load settings from localStorage and populate UI
function loadMfgData() {
    try {
        const saved = localStorage.getItem('svg2gcode_settings');
        if (saved) {
            const mfg = JSON.parse(saved);
            if (mfg.safeZ !== undefined) document.getElementById('safeZ').value = mfg.safeZ;
            if (mfg.thickness !== undefined) document.getElementById('thickness').value = mfg.thickness;
            if (mfg.materialMargin !== undefined) document.getElementById('materialMargin').value = mfg.materialMargin;
            if (mfg.overcut !== undefined) document.getElementById('overcut').value = mfg.overcut;
            if (mfg.stepdown !== undefined) document.getElementById('stepdown').value = mfg.stepdown;
            if (mfg.feedXY !== undefined) document.getElementById('feedXY').value = mfg.feedXY;
            if (mfg.feedZ !== undefined) document.getElementById('feedZ').value = mfg.feedZ;
            if (mfg.spindle !== undefined) document.getElementById('spindle').value = mfg.spindle;
            if (mfg.toolD !== undefined) document.getElementById('toolD').value = mfg.toolD;
            if (mfg.postProcessor !== undefined) document.getElementById('postProcessor').value = mfg.postProcessor;
            if (mfg.originMode !== undefined) document.getElementById('originMode').value = mfg.originMode;
            if (mfg.arrayCountX !== undefined) document.getElementById('arrayCountX').value = mfg.arrayCountX;
            if (mfg.arraySpacingX !== undefined) document.getElementById('arraySpacingX').value = mfg.arraySpacingX;
            if (mfg.arrayCountY !== undefined) document.getElementById('arrayCountY').value = mfg.arrayCountY;
            if (mfg.arraySpacingY !== undefined) document.getElementById('arraySpacingY').value = mfg.arraySpacingY;
            // Restore tab settings
            if (mfg.tabEnabled !== undefined) {
                const cb = document.getElementById('tabEnable');
                if (cb) {
                    cb.checked = mfg.tabEnabled;
                    const panel = document.getElementById('tabSettings');
                    if (panel) panel.style.display = mfg.tabEnabled ? 'block' : 'none';
                }
            }
            if (mfg.tabThickness !== undefined && mfg.tabThickness > 0)
                document.getElementById('tabThickness').value = mfg.tabThickness;
            if (mfg.tabWidth !== undefined && mfg.tabWidth > 0)
                document.getElementById('tabWidth').value = mfg.tabWidth;
            if (mfg.tabCount !== undefined && mfg.tabCount > 0)
                document.getElementById('tabCount').value = mfg.tabCount;
        }
    } catch (e) {
        console.warn('Could not load settings from localStorage', e);
    }
}

function getLayoutData() {
    const readNum = (id, fallback) => {
        const input = document.getElementById(id);
        if (!input) return fallback;
        const value = parseFloat(input.value);
        return Number.isFinite(value) ? value : fallback;
    };
    const readCount = (id, fallback) => {
        const value = readNum(id, fallback);
        return Math.max(1, Math.round(value));
    };

    return {
        rotateAngle: readNum('rotateAngle', 0),
        arrayCountX: readCount('arrayCountX', 1),
        arraySpacingX: readNum('arraySpacingX', 0),
        arrayCountY: readCount('arrayCountY', 1),
        arraySpacingY: readNum('arraySpacingY', 0)
    };
}

function persistSettings() {
    const mfg = getMfgData();
    const layout = getLayoutData();
    const tabEnabled = document.getElementById('tabEnable')?.checked || false;
    saveMfgData({ ...mfg, ...layout, tabEnabled });
    return { mfg, layout, tabEnabled };
}

function getMfgData() {
    const readNum = (id, fallback) => {
        const v = parseFloat(document.getElementById(id).value);
        return Number.isFinite(v) ? v : fallback;
    };

    const tabEnabled = document.getElementById('tabEnable')?.checked || false;
    const tabThicknessRaw = readNum('tabThickness', 1);
    const tabWidthRaw = readNum('tabWidth', 4);
    const tabCountRaw = readNum('tabCount', 4);

    const mfg = {
        safeZ: readNum('safeZ', 10),
        thickness: readNum('thickness', 7),
        materialMargin: readNum('materialMargin', 4),
        overcut: readNum('overcut', 0.0),
        stepdown: readNum('stepdown', 1.5),
        feedXY: readNum('feedXY', 1000),
        feedZ: readNum('feedZ', 300),
        spindle: readNum('spindle', 10000),
        toolD: readNum('toolD', 3.175),
        postProcessor: document.getElementById('postProcessor').value || 'grbl',
        originMode: document.getElementById('originMode').value || 'top-bottomleft',

        tabThickness: tabEnabled ? tabThicknessRaw : 0,
        tabWidth: tabEnabled ? tabWidthRaw : 0,
        tabCount: tabEnabled ? tabCountRaw : 0
    };
    return mfg;
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

    return gcodeText.split(/\r?\n/).map(line => {
        if (!line.trim()) return '';
        // Skip comments, non-coordinate lines
        const trimmed = line.trim();
        if (trimmed.startsWith('(') || trimmed.startsWith('%') ||
            trimmed.startsWith('M') || trimmed.startsWith('G20') || trimmed.startsWith('G21')) {
            return line;
        }
        if (!/[XYZ]/.test(line)) return line;

        return line.replace(/([XYZ])([-\d.]+)/g, (match, axis, val) => {
            const v = parseFloat(val);
            if (axis === 'X') return `X${(v + offsetX).toFixed(3)}`;
            if (axis === 'Y') return `Y${(v + offsetY).toFixed(3)}`;
            if (axis === 'Z') return `Z${(v + offsetZ).toFixed(3)}`;
            return match;
        });
    }).filter(l => l !== '').join('\r\n');
}

function offsetPartGeometry(part, offsetX, offsetY) {
    const shiftPoint = (point) => ({
        ...point,
        x: point.x + offsetX,
        y: point.y + offsetY
    });

    if (Array.isArray(part.points)) {
        part.points = part.points.map(shiftPoint);
    }
    if (part.startPoint) {
        part.startPoint = shiftPoint(part.startPoint);
    }
    if (Array.isArray(part.moves)) {
        part.moves = part.moves.map((move) => ({
            ...move,
            to: move.to ? shiftPoint(move.to) : move.to,
            center: move.center ? shiftPoint(move.center) : move.center
        }));
    }
    if (part.rect) {
        part.rect = {
            ...part.rect,
            x: part.rect.x + offsetX,
            y: part.rect.y + offsetY
        };
    }
    if (Array.isArray(part.holes)) {
        part.holes = part.holes.map((hole) => ({
            ...hole,
            x: hole.x + offsetX,
            y: hole.y + offsetY
        }));
    }
    if (Array.isArray(part.slots)) {
        part.slots = part.slots.map((slot) => ({
            ...slot,
            x: slot.x + offsetX,
            y: slot.y + offsetY
        }));
    }
    if (Array.isArray(part.outline)) {
        part.outline = part.outline.map((item) => ({
            ...item,
            x: item.x + offsetX,
            y: item.y + offsetY
        }));
    }
    if (Array.isArray(part.innerOutline)) {
        part.innerOutline = part.innerOutline.map((item) => ({
            ...item,
            x: item.x + offsetX,
            y: item.y + offsetY
        }));
    }
}

function rotatePartGeometry(part, angleDeg, originX, originY) {
    if (!angleDeg) return;

    const rad = -angleDeg * Math.PI / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const rotatePoint = (point) => {
        const localX = point.x - originX;
        const localY = point.y - originY;
        return {
            ...point,
            x: localX * cosA - localY * sinA + originX,
            y: localX * sinA + localY * cosA + originY
        };
    };

    if (Array.isArray(part.points)) {
        part.points = part.points.map(rotatePoint);
    }
    if (part.startPoint) {
        part.startPoint = rotatePoint(part.startPoint);
    }
    if (Array.isArray(part.moves)) {
        part.moves = part.moves.map((move) => ({
            ...move,
            to: move.to ? rotatePoint(move.to) : move.to,
            center: move.center ? rotatePoint(move.center) : move.center
        }));
    }
    if (part.rect) {
        const rotatedRectOrigin = rotatePoint({ x: part.rect.x, y: part.rect.y });
        part.rect = {
            ...part.rect,
            x: rotatedRectOrigin.x,
            y: rotatedRectOrigin.y
        };
    }
    if (Array.isArray(part.holes)) {
        part.holes = part.holes.map(rotatePoint);
    }
    if (Array.isArray(part.slots)) {
        part.slots = part.slots.map((slot) => {
            const rotatedSlotOrigin = rotatePoint({ x: slot.x, y: slot.y });
            return {
                ...slot,
                x: rotatedSlotOrigin.x,
                y: rotatedSlotOrigin.y
            };
        });
    }
    if (Array.isArray(part.outline)) {
        part.outline = part.outline.map(rotatePoint);
    }
    if (Array.isArray(part.innerOutline)) {
        part.innerOutline = part.innerOutline.map(rotatePoint);
    }
}

function buildArrayParts(parts, mfg) {
    const xCount = Math.max(1, Math.round(mfg.arrayCountX || 1));
    const yCount = Math.max(1, Math.round(mfg.arrayCountY || 1));
    const xSpacing = Number.isFinite(mfg.arraySpacingX) ? mfg.arraySpacingX : 0;
    const ySpacing = Number.isFinite(mfg.arraySpacingY) ? mfg.arraySpacingY : 0;

    if (xCount === 1 && yCount === 1) {
        return parts;
    }

    const arrayParts = [];
    for (let row = 0; row < yCount; row++) {
        for (let col = 0; col < xCount; col++) {
            const offsetX = col * xSpacing;
            const offsetY = row * ySpacing;
            const suffix = `_ax${col + 1}_ay${row + 1}`;

            for (const sourcePart of parts) {
                const clonedPart = JSON.parse(JSON.stringify(sourcePart));
                clonedPart.id = `${sourcePart.id}${suffix}`;
                clonedPart.arrayIndexX = col + 1;
                clonedPart.arrayIndexY = row + 1;
                offsetPartGeometry(clonedPart, offsetX, offsetY);
                arrayParts.push(clonedPart);
            }
        }
    }
    return arrayParts;
}

// Generate G-Code
generateBtn.addEventListener('click', () => {
    if (!currentParts || currentParts.length === 0) return;

    const { mfg, layout } = persistSettings();

    try {
        log("正在計算並生成 G-code...");

        // Deep copy parts to apply layout transforms without mutating the core data
        let partsToProcess = JSON.parse(JSON.stringify(currentParts));
        const angle = layout.rotateAngle || 0;

        partsToProcess = buildArrayParts(partsToProcess, layout);

        if (angle !== 0) {
            const extentsBeforeRotate = computePartsExtents(partsToProcess);
            if (extentsBeforeRotate.minX !== Infinity) {
                const originX = (extentsBeforeRotate.minX + extentsBeforeRotate.maxX) / 2;
                const originY = (extentsBeforeRotate.minY + extentsBeforeRotate.maxY) / 2;
                for (const part of partsToProcess) {
                    rotatePartGeometry(part, angle, originX, originY);
                }
            }
        }

        const files = buildAllGcodes(partsToProcess, mfg);
        const info = generateMachiningInfo(mfg, partsToProcess.length, layout);

        if (files.length > 0) {
            const mergedLines = [];
            // Use strict ASCII uppercase and avoid local date strings which might contain Chinese characters
            const simpleDate = new Date().toISOString().split('T')[0];
            mergedLines.push(`(SVG TO GCODE EXPORT ${simpleDate})`);

            // Add global header
            mergedLines.push(...gcodeHeader(mfg));

            files.forEach(f => mergedLines.push(f.text));

            // Add global footer
            mergedLines.push(...gcodeFooter(mfg));

            let txt = mergedLines.join('\r\n');

            // --- Origin Offset ---
            const extents = computePartsExtents(partsToProcess);
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

            // Mach3 has ancient bugs where letters like 'O' (program number) inside comments
            // cause "Bad character used" errors. E.g. (DRILL HOLES) -> O followed by L.
            // Safest fallback is to strip all comments for Mach3.
            if (mfg.postProcessor === 'mach3') {
                txt = txt.split(/\r?\n/)
                    .map(line => line.replace(/\([^)]*\)/g, '').trim()) // Remove any (...) and trim spaces
                    .filter(line => line !== '') // Remove resulting empty lines
                    .join('\r\n');
            }

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

function enforceToolpathListViewportLimit(listEl, maxRows = 10) {
    if (!listEl) return;
    listEl.style.overflowY = 'auto';
    const firstItem = listEl.querySelector('.toolpath-item');
    if (!firstItem) {
        listEl.style.maxHeight = '160px';
        return;
    }

    const rowStyle = window.getComputedStyle(firstItem);
    const rowHeight = firstItem.offsetHeight + (parseFloat(rowStyle.marginBottom) || 0);
    const listStyle = window.getComputedStyle(listEl);
    const padTop = parseFloat(listStyle.paddingTop) || 0;
    const padBottom = parseFloat(listStyle.paddingBottom) || 0;
    const limitHeight = Math.ceil(rowHeight * maxRows + padTop + padBottom);
    listEl.style.maxHeight = `${limitHeight}px`;
}

function renderToolpathList() {
    const list = document.getElementById('toolpathList');
    if (!list) return;

    if (!currentParts || currentParts.length === 0) {
        list.innerHTML = '<div style="padding: 10px; color: var(--text-muted); text-align: center; font-size: 0.85rem;">等待載入 SVG / DXF 檔案...</div>';
        enforceToolpathListViewportLimit(list, 10);
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
        const partialBadge = part.isPartial
            ? `<span style="margin-left:4px;color:#8b5cf6;font-size:0.78rem;">⬦ 非貫穿 ${part.partialDepth}mm</span>`
            : '';
        const sweepBadge = part.sweep
            ? `<span style="margin-left:4px;color:#10b981;font-size:0.78rem;">⬦ 清掃 ${part.sweepStepover}mm</span>`
            : '';

        el.innerHTML = `
            <span><strong style="color:var(--text-muted)">#${index + 1}</strong> 路徑</span>
            <span style="display:flex;align-items:center;gap:4px;">
                <span class="mode-badge ${part.toolpathMode || 'none'}">${modeLabel}</span>${partialBadge}${sweepBadge}
                <button class="toolpath-remove-btn" title="移除此刀路" style="margin-left:6px;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:1rem;line-height:1;padding:0 2px;" data-part-id="${part.id}">×</button>
            </span>
        `;

        el.querySelector('.toolpath-remove-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const target = currentParts.find(p => p.id === part.id);
            if (target) {
                target.toolpathMode = 'none';
                target.isPartial = false;
                target.sweep = false;
                target.listOrdered = false;
            }
            currentParts = [
                ...currentParts.filter(p => p.listOrdered),
                ...currentParts.filter(p => !p.listOrdered)
            ];
            syncPreviewPartClasses();
            renderToolpathList();
            log(`已移除路徑刀路設定。`);
        });

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

    enforceToolpathListViewportLimit(list, 10);
}

function initCollapsiblePanels() {
    const toggleButtons = document.querySelectorAll('[data-panel-toggle]');

    const setExpanded = (button, expanded) => {
        const targetId = button.dataset.panelToggle;
        const panel = targetId ? document.getElementById(targetId) : null;
        if (!panel) return;
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        button.textContent = expanded ? '−' : '+';
        panel.hidden = !expanded;
    };

    toggleButtons.forEach((button) => {
        const expanded = button.getAttribute('aria-expanded') !== 'false';
        setExpanded(button, expanded);
        button.addEventListener('click', () => {
            const nextExpanded = button.getAttribute('aria-expanded') !== 'true';
            setExpanded(button, nextExpanded);
        });
    });
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initCollapsiblePanels();
    if (themeSelect) {
        themeSelect.addEventListener('change', () => {
            applyTheme(themeSelect.value);
        });
    }

    // Restore saved settings on initial load
    loadMfgData();

    // Partial checkbox: show/hide depth input
    const partialCheckEl = document.getElementById('partialCheck');
    const partialDepthEl = document.getElementById('partialDepth');
    const partialDepthUnitEl = document.getElementById('partialDepthUnit');
    if (partialCheckEl && partialDepthEl) {
        partialCheckEl.addEventListener('change', () => {
            const show = partialCheckEl.checked;
            partialDepthEl.style.display = show ? 'inline-block' : 'none';
            if (partialDepthUnitEl) partialDepthUnitEl.style.display = show ? 'inline' : 'none';
        });
    }

    // Sweep controls: show only when 銑線內 is selected
    const sweepLabelEl = document.getElementById('sweepLabel');
    const sweepSepEl = document.getElementById('sweepSep');
    const sweepCheckEl = document.getElementById('sweepCheck');
    const sweepStepoverEl = document.getElementById('sweepStepover');
    const sweepStepoverUnitEl = document.getElementById('sweepStepoverUnit');

    function updateSweepVisibility() {
        const mode = getSelectedToolpathMode();
        const isInside = mode === 'inside';
        if (sweepSepEl) sweepSepEl.style.display = isInside ? 'inline-block' : 'none';
        if (sweepLabelEl) sweepLabelEl.style.display = isInside ? 'flex' : 'none';
        if (!isInside && sweepCheckEl) {
            sweepCheckEl.checked = false;
            if (sweepStepoverEl) sweepStepoverEl.style.display = 'none';
            if (sweepStepoverUnitEl) sweepStepoverUnitEl.style.display = 'none';
        }
    }

    document.querySelectorAll('input[name="toolpathMode"]').forEach(radio => {
        radio.addEventListener('change', updateSweepVisibility);
    });

    if (sweepCheckEl && sweepStepoverEl) {
        sweepCheckEl.addEventListener('change', () => {
            const show = sweepCheckEl.checked;
            sweepStepoverEl.style.display = show ? 'inline-block' : 'none';
            if (sweepStepoverUnitEl) sweepStepoverUnitEl.style.display = show ? 'inline' : 'none';
        });
    }

    // Tab enable/disable toggle
    const tabEnableCb = document.getElementById('tabEnable');
    const tabSettingsPanel = document.getElementById('tabSettings');
    if (tabEnableCb && tabSettingsPanel) {
        tabEnableCb.addEventListener('change', () => {
            tabSettingsPanel.style.display = tabEnableCb.checked ? 'block' : 'none';
            persistSettings();
        });
    }

    // Listen to changes on all settings inputs and save automatically
    const settingInputs = document.querySelectorAll('.settings-section input, .settings-section select');
    const previewArrayInputIds = ['arrayCountX', 'arraySpacingX', 'arrayCountY', 'arraySpacingY'];

    function flashSaved(el) {
        el.style.transition = 'box-shadow 0.15s ease, border-color 0.15s ease';
        el.style.borderColor = '#22c55e';
        el.style.boxShadow = '0 0 0 2px rgba(34,197,94,0.35)';
        setTimeout(() => {
            el.style.borderColor = '';
            el.style.boxShadow = '';
        }, 800);
    }

    settingInputs.forEach(input => {
        // Save on change (blur / select change)
        input.addEventListener('change', () => {
            persistSettings();
            if (currentParts && previewArrayInputIds.includes(input.id)) {
                renderPreviewSvg();
            }
            flashSaved(input);
        });

        // Save on Enter key for number/text inputs
        if (input.tagName === 'INPUT') {
            if (previewArrayInputIds.includes(input.id)) {
                input.addEventListener('input', () => {
                    if (currentParts) {
                        renderPreviewSvg();
                    }
                });
            }
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    persistSettings();
                    if (currentParts && previewArrayInputIds.includes(input.id)) {
                        renderPreviewSvg();
                    }
                    flashSaved(input);
                    input.blur(); // remove focus
                }
            });
        }
    });
});
