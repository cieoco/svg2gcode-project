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
const resetDefaultsBtn = document.getElementById('resetDefaultsBtn');
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
const UI_MODE_STORAGE_KEY = 'svg2gcode_ui_mode';
const SETTINGS_STORAGE_KEY = 'svg2gcode_settings';
const DEFAULT_MATERIAL = 'wood';
const DEFAULT_TOOL_D = 3.175;
const MATERIAL_PRESETS = {
    wood: {
        label: '木材',
        values: {
            stepdown: 2.0,
            feedXY: 1400,
            feedZ: 450,
            spindle: 12000,
            rampEnable: false,
            rampAngleDeg: 5,
            peckStep: 0,
            coolantEnable: false,
            surfaceCleanDepth: 0.3,
            surfaceCleanStepoverPct: 70
        },
        limits: {
            stepdown: [0.3, 6.0],
            feedXY: [400, 3500],
            feedZ: [100, 1000],
            surfaceCleanDepth: [0.05, 1.0]
        }
    },
    plastic: {
        label: '塑膠',
        values: {
            stepdown: 1.0,
            feedXY: 900,
            feedZ: 250,
            spindle: 8000,
            rampEnable: true,
            rampAngleDeg: 3,
            peckStep: 1.0,
            coolantEnable: false,
            surfaceCleanDepth: 0.2,
            surfaceCleanStepoverPct: 45
        },
        limits: {
            stepdown: [0.15, 3.0],
            feedXY: [250, 1800],
            feedZ: [80, 600],
            peckStep: [0.1, 2.0],
            surfaceCleanDepth: [0.03, 0.6]
        }
    },
    aluminum: {
        label: '鋁材',
        values: {
            stepdown: 0.5,
            feedXY: 450,
            feedZ: 120,
            spindle: 10000,
            rampEnable: true,
            rampAngleDeg: 2,
            peckStep: 0.6,
            coolantEnable: true,
            surfaceCleanDepth: 0.1,
            surfaceCleanStepoverPct: 35
        },
        limits: {
            stepdown: [0.05, 2.0],
            feedXY: [120, 1200],
            feedZ: [40, 350],
            peckStep: [0.1, 1.5],
            surfaceCleanDepth: [0.02, 0.35]
        }
    }
};
const TOOL_DIAMETER_SCALED_FIELDS = ['stepdown', 'feedXY', 'feedZ', 'peckStep', 'surfaceCleanDepth'];

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

function getMaterialPreset(materialType) {
    return MATERIAL_PRESETS[materialType] || MATERIAL_PRESETS[DEFAULT_MATERIAL];
}

function getMaterialPresetValues(materialType, toolD = DEFAULT_TOOL_D) {
    const preset = getMaterialPreset(materialType);
    const d = Number.isFinite(toolD) && toolD > 0 ? toolD : DEFAULT_TOOL_D;
    const ratio = d / DEFAULT_TOOL_D;
    const values = { ...preset.values };

    TOOL_DIAMETER_SCALED_FIELDS.forEach((field) => {
        if (!Number.isFinite(values[field])) return;
        let nextValue = values[field] * ratio;
        const limit = preset.limits?.[field];
        if (limit) {
            nextValue = clamp(nextValue, limit[0], limit[1]);
        }
        values[field] = field === 'feedXY' || field === 'feedZ'
            ? Math.round(nextValue)
            : roundTo(nextValue, 3);
    });

    return values;
}

const DEFAULT_MATERIAL_VALUES = getMaterialPresetValues(DEFAULT_MATERIAL, DEFAULT_TOOL_D);
const DEFAULT_SETTINGS = {
    materialType: DEFAULT_MATERIAL,
    rotateAngle: 0,
    arrayCountX: 1,
    arraySpacingX: 0,
    arrayCountY: 1,
    arraySpacingY: 0,
    thickness: 7,
    materialMargin: 4,
    overcut: 0,
    stepdown: DEFAULT_MATERIAL_VALUES.stepdown,
    safeZ: 10,
    feedXY: DEFAULT_MATERIAL_VALUES.feedXY,
    feedZ: DEFAULT_MATERIAL_VALUES.feedZ,
    spindle: DEFAULT_MATERIAL_VALUES.spindle,
    toolD: DEFAULT_TOOL_D,
    postProcessor: 'grbl',
    originMode: 'bottom-bottomleft',
    rampEnable: DEFAULT_MATERIAL_VALUES.rampEnable,
    rampAngleDeg: DEFAULT_MATERIAL_VALUES.rampAngleDeg,
    peckStep: DEFAULT_MATERIAL_VALUES.peckStep,
    coolantEnable: DEFAULT_MATERIAL_VALUES.coolantEnable,
    surfaceCleanDepth: DEFAULT_MATERIAL_VALUES.surfaceCleanDepth,
    surfaceCleanStepoverPct: DEFAULT_MATERIAL_VALUES.surfaceCleanStepoverPct,
    tabEnabled: false,
    tabCount: 4,
    tabWidth: 4,
    tabThickness: 1
};
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

function syncRotatePreview() {
    if (typeof refreshPreviewTransform === 'function') {
        refreshPreviewTransform(true);
        return;
    }

    const svgEl = previewSvg.querySelector('svg');
    if (!svgEl || !rotateAngle) return;
    const angle = parseFloat(rotateAngle.value) || 0;
    svgEl.style.transform = `rotate(${angle}deg)`;
    svgEl.style.transformOrigin = 'center center';
    svgEl.style.transition = 'transform 0.2s ease-in-out';
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

function setFieldValue(id, value) {
    const el = document.getElementById(id);
    if (!el || value === undefined) return;
    if (el.type === 'checkbox') {
        el.checked = Boolean(value);
    } else {
        el.value = value;
    }
}

function getCurrentToolDiameter() {
    const toolInput = document.getElementById('toolD');
    const value = toolInput ? parseFloat(toolInput.value) : DEFAULT_TOOL_D;
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TOOL_D;
}

function applyMaterialPreset(materialType, options = {}) {
    const preset = getMaterialPreset(materialType);
    setFieldValue('materialType', MATERIAL_PRESETS[materialType] ? materialType : DEFAULT_MATERIAL);

    const toolD = Number.isFinite(options.toolD) && options.toolD > 0
        ? options.toolD
        : getCurrentToolDiameter();
    const values = getMaterialPresetValues(materialType, toolD);

    Object.entries(values).forEach(([id, value]) => {
        setFieldValue(id, value);
    });

    if (options.announce) {
        log(`已依刀徑 ${toolD.toFixed(3)} mm 套用 ${preset.label} 加工預設。`);
    }
}

function materialCommentName(materialType) {
    if (materialType === 'aluminum') return 'ALUMINUM';
    if (materialType === 'plastic') return 'PLASTIC';
    return 'WOOD';
}

function setPanelExpanded(panelId, expanded) {
    const button = document.querySelector(`[data-panel-toggle="${panelId}"]`);
    const panel = document.getElementById(panelId);
    if (!button || !panel) return;
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    button.textContent = expanded ? '−' : '+';
    panel.hidden = !expanded;
}

function applyUiMode(mode, options = {}) {
    const m = mode === 'engineer' ? 'engineer' : 'simple';
    document.body.classList.toggle('mode-simple', m === 'simple');
    document.getElementById('modeSimpleBtn')?.classList.toggle('active', m === 'simple');
    document.getElementById('modeEngineerBtn')?.classList.toggle('active', m === 'engineer');
    if (m === 'simple') {
        // 傻瓜模式只剩一個參數面板，直接展開避免多按一下
        setPanelExpanded('camSettingsBody', true);
    }
    try {
        localStorage.setItem(UI_MODE_STORAGE_KEY, m);
    } catch (e) {
        console.warn('Could not save UI mode to localStorage', e);
    }
    if (options.announce) {
        log(m === 'simple'
            ? '已切換到傻瓜模式：只需選材料、厚度、刀徑，其餘參數依材料預設自動套用。'
            : '已切換到工程模式：顯示全部 CAM 參數。');
    }
}

function initUiMode() {
    let saved = 'simple';
    try {
        saved = localStorage.getItem(UI_MODE_STORAGE_KEY) || 'simple';
    } catch (e) {
        console.warn('Could not load UI mode from localStorage', e);
    }
    applyUiMode(saved);
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
    if (selectedMode === 'surface-clean') return '清掃';
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
        el.classList.remove('path-on-path', 'path-outside', 'path-inside', 'path-drill', 'path-surface-clean', 'path-none', 'path-partial');
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
        part.isPartial = selectedMode !== 'surface-clean' && isPartial;
        part.partialDepth = part.isPartial ? partialDepth : 0;
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
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(mfg));
    } catch (e) {
        console.warn('Could not save settings to localStorage', e);
    }
}

function applySettingsToUi(settings = {}) {
    const fields = [
        'materialType',
        'safeZ',
        'thickness',
        'materialMargin',
        'overcut',
        'stepdown',
        'feedXY',
        'feedZ',
        'spindle',
        'toolD',
        'postProcessor',
        'originMode',
        'rotateAngle',
        'rampAngleDeg',
        'peckStep',
        'surfaceCleanDepth',
        'surfaceCleanStepoverPct',
        'arrayCountX',
        'arraySpacingX',
        'arrayCountY',
        'arraySpacingY',
        'tabThickness',
        'tabWidth',
        'tabCount'
    ];

    fields.forEach((id) => {
        if (settings[id] === undefined) return;
        const el = document.getElementById(id);
        if (el) el.value = settings[id];
    });

    const checkboxFields = [
        'rampEnable',
        'coolantEnable'
    ];
    checkboxFields.forEach((id) => {
        if (settings[id] === undefined) return;
        const el = document.getElementById(id);
        if (el) el.checked = Boolean(settings[id]);
    });

    const tabEnable = document.getElementById('tabEnable');
    const tabSettings = document.getElementById('tabSettings');
    const tabEnabled = Boolean(settings.tabEnabled);
    if (tabEnable) tabEnable.checked = tabEnabled;
    if (tabSettings) tabSettings.style.display = tabEnabled ? 'block' : 'none';

    syncRotatePreview();
}

// Helper: Load settings from localStorage and populate UI
function loadMfgData() {
    try {
        const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (saved) {
            applySettingsToUi({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
        }
    } catch (e) {
        console.warn('Could not load settings from localStorage', e);
    }
}

function resetSettingsToDefaults() {
    applySettingsToUi(DEFAULT_SETTINGS);
    saveMfgData(DEFAULT_SETTINGS);
    if (currentParts) {
        renderPreviewSvg();
    }
    log('已恢復加工參數與版面設定的原始值。');
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
        const el = document.getElementById(id);
        if (!el) return fallback;
        const v = parseFloat(el.value);
        return Number.isFinite(v) ? v : fallback;
    };
    const readBool = (id) => document.getElementById(id)?.checked || false;

    const tabEnabled = document.getElementById('tabEnable')?.checked || false;
    const tabThicknessRaw = readNum('tabThickness', 1);
    const tabWidthRaw = readNum('tabWidth', 4);
    const tabCountRaw = readNum('tabCount', 4);

    const mfg = {
        materialType: document.getElementById('materialType')?.value || DEFAULT_MATERIAL,
        safeZ: readNum('safeZ', 10),
        thickness: readNum('thickness', 7),
        materialMargin: readNum('materialMargin', 4),
        overcut: readNum('overcut', 0.0),
        stepdown: readNum('stepdown', 1.5),
        feedXY: readNum('feedXY', 1000),
        feedZ: readNum('feedZ', 300),
        spindle: readNum('spindle', 10000),
        toolD: readNum('toolD', 3.175),
        postProcessor: document.getElementById('postProcessor')?.value || 'grbl',
        originMode: document.getElementById('originMode')?.value || 'top-bottomleft',
        rampEnable: readBool('rampEnable'),
        rampAngleDeg: readNum('rampAngleDeg', 3),
        peckStep: readNum('peckStep', 0),
        coolantEnable: readBool('coolantEnable'),
        surfaceCleanDepth: readNum('surfaceCleanDepth', 0.2),
        surfaceCleanStepoverPct: readNum('surfaceCleanStepoverPct', 60),

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
function computePartBounds(part) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const pt of part.points || []) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
    }
    if (minX === Infinity) return null;
    return { width: maxX - minX, height: maxY - minY };
}

// 傻瓜級防呆：生成前檢查常見的參數/幾何衝突，回傳警告文字陣列（不阻擋生成）
function collectSafetyWarnings(parts, mfg) {
    const warnings = [];

    if (mfg.stepdown > mfg.thickness) {
        warnings.push(`每層下刀量 ${mfg.stepdown.toFixed(2)} mm 大於材料厚度 ${mfg.thickness.toFixed(2)} mm，會一刀切到底，容易斷刀。建議改小每層下刀量。`);
    }

    if (mfg.tabThickness > 0 && mfg.tabThickness >= mfg.thickness) {
        warnings.push(`支撐橋厚度 ${mfg.tabThickness.toFixed(2)} mm 不小於材料厚度 ${mfg.thickness.toFixed(2)} mm，零件將完全不會被切穿。`);
    }

    // 陣列複製的零件 id 會加上 _ax/_ay 後綴，去掉後綴對回原始路徑編號並去重
    const warnedBaseIds = new Set();
    parts.forEach((part) => {
        if (part.toolpathMode !== 'inside') return;
        const baseId = String(part.id || '').split('_ax')[0];
        if (warnedBaseIds.has(baseId)) return;
        const bounds = computePartBounds(part);
        if (!bounds) return;
        const minDim = Math.min(bounds.width, bounds.height);
        if (minDim <= mfg.toolD) {
            warnedBaseIds.add(baseId);
            const baseIndex = currentParts ? currentParts.findIndex((p) => p.id === baseId) : -1;
            const label = baseIndex >= 0 ? `路徑 #${baseIndex + 1}` : '有一個圖形';
            warnings.push(`${label}（約 ${bounds.width.toFixed(1)}×${bounds.height.toFixed(1)} mm）設定為「銑線內」，但刀具直徑 ${mfg.toolD.toFixed(3)} mm 銑不進這個輪廓，此路徑會被略過或產生錯誤結果。請換小刀或改用「銑線上」。`);
        }
    });

    return warnings;
}

const ACTIVE_TOOLPATH_MODES = ['outside', 'inside', 'drill', 'on-path', 'surface-clean'];

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

        const extents = computePartsExtents(partsToProcess);
        const margin = mfg.materialMargin || 4;
        const effectiveMfg = { ...mfg };

        const activeParts = partsToProcess.filter((part) => ACTIVE_TOOLPATH_MODES.includes(part.toolpathMode));
        if (activeParts.length === 0) {
            log('尚未指定任何刀路，無法生成 G-Code。\n請先在左側 2D 視圖：\n1. 點選上方的刀路模式（例如「銑線外」）\n2. 再點擊圖形中的線條，把刀路套用到該線段');
            return;
        }

        const safetyWarnings = collectSafetyWarnings(partsToProcess, effectiveMfg);

        const surfaceCleanCount = partsToProcess.filter((part) => part.toolpathMode === 'surface-clean').length;
        const files = buildAllGcodes(partsToProcess, effectiveMfg);
        const info = generateMachiningInfo(effectiveMfg, partsToProcess.length, { ...layout, surfaceCleanCount });

        if (files.length > 0) {
            // Compute extents first so stock dimensions can go in the header comment
            const stockW = extents.minX !== Infinity ? (extents.maxX - extents.minX) + margin * 2 : 0;
            const stockH = extents.minY !== Infinity ? (extents.maxY - extents.minY) + margin * 2 : 0;
            const stockT = effectiveMfg.thickness || 0;

            const mergedLines = [];
            // Use strict ASCII uppercase and avoid local date strings which might contain Chinese characters
            const simpleDate = new Date().toISOString().split('T')[0];
            mergedLines.push(`(SVG TO GCODE EXPORT ${simpleDate})`);
            if (stockW > 0 && stockH > 0) {
                mergedLines.push(`(STOCK X${stockW.toFixed(2)} Y${stockH.toFixed(2)} Z${stockT.toFixed(2)} MM)`);
            }
            mergedLines.push(`(MATERIAL ${materialCommentName(mfg.materialType)})`);

            // Add global header
            mergedLines.push(...gcodeHeader(effectiveMfg));

            files.forEach(f => mergedLines.push(f.text));

            // Add global footer
            mergedLines.push(...gcodeFooter(effectiveMfg));

            let txt = mergedLines.join('\r\n');

            // --- Origin Offset ---
            let offsetX = 0, offsetY = 0, offsetZ = 0;

            if (extents.minX !== Infinity) {
                const cx = (extents.minX + extents.maxX) / 2;
                const cy = (extents.minY + extents.maxY) / 2;
                const mode = effectiveMfg.originMode;

                // XY: center subtracts midpoint; bottomleft subtracts min corner
                offsetX = mode.includes('center') ? -cx : -extents.minX;
                offsetY = mode.includes('center') ? -cy : -extents.minY;
                // Z: bottom shifts so Z0 = bottom face of material
                offsetZ = mode.startsWith('bottom') ? effectiveMfg.thickness : 0;
            }

            txt = applyGcodeOffset(txt, offsetX, offsetY, offsetZ);

            // Mach3 has ancient bugs where letters like 'O' (program number) inside comments
            // cause "Bad character used" errors. E.g. (DRILL HOLES) -> O followed by L.
            // Safest fallback is to strip all comments for Mach3.
            if (effectiveMfg.postProcessor === 'mach3') {
                txt = txt.split(/\r?\n/)
                    .map(line => line.replace(/\([^)]*\)/g, '').trim()) // Remove any (...) and trim spaces
                    .filter(line => line !== '') // Remove resulting empty lines
                    .join('\r\n');
            }

            // Update 3D Viewer
            update3DToolpath(txt, effectiveMfg);

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
            const originLabel = originLabels[effectiveMfg.originMode] || effectiveMfg.originMode;

            const warningBlock = safetyWarnings.length
                ? `\n\n⚠ 注意：\n${safetyWarnings.map((w) => `- ${w}`).join('\n')}`
                : '';
            log(`成功！G-Code 檔案已下載。${warningBlock}\n\n工件原點：${originLabel}\n\n${info}`);
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
        if (part.toolpathMode === 'surface-clean') modeLabel = '清掃 (Face)';
        const partialBadge = part.isPartial
            ? `<span style="margin-left:4px;color:#8b5cf6;font-size:0.78rem;">⬦ 非貫穿 ${part.partialDepth}mm</span>`
            : '';
        const sweepBadge = part.sweep
            ? `<span style="margin-left:4px;color:#10b981;font-size:0.78rem;">⬦ 口袋清料 ${part.sweepStepover}mm</span>`
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
                target.partialDepth = 0;
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
    initUiMode();

    document.getElementById('modeSimpleBtn')?.addEventListener('click', () => {
        applyUiMode('simple', { announce: true });
    });
    document.getElementById('modeEngineerBtn')?.addEventListener('click', () => {
        applyUiMode('engineer', { announce: true });
    });

    if (themeSelect) {
        themeSelect.addEventListener('change', () => {
            applyTheme(themeSelect.value);
        });
    }

    // Restore saved settings on initial load
    loadMfgData();

    if (resetDefaultsBtn) {
        resetDefaultsBtn.addEventListener('click', () => {
            resetSettingsToDefaults();
        });
    }

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

    const materialTypeEl = document.getElementById('materialType');
    if (materialTypeEl) {
        materialTypeEl.addEventListener('change', () => {
            applyMaterialPreset(materialTypeEl.value, { announce: true });
        });
    }

    const toolDEl = document.getElementById('toolD');
    if (toolDEl) {
        toolDEl.addEventListener('change', () => {
            const materialType = document.getElementById('materialType')?.value || DEFAULT_MATERIAL;
            applyMaterialPreset(materialType, {
                announce: true,
                toolD: getCurrentToolDiameter()
            });
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
