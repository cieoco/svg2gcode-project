/**
 * SVG to G-Code App Logic
 */

import { parseSVG } from './svg-parser.js';
import { parseDXF } from './dxf-parser.js';
import { buildAllGcodes, generateMachiningInfo } from './cam/generator.js';
import { gcodeHeader, gcodeFooter, buildFacePattern } from './cam/operations.js';
import { init3DViewer, update3DToolpath, linkAnimationUI, reset3DView } from './viewer3d.js';
import { buildHanziParts } from './text/hanzi-text.js';

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
            faceStepdown: 1.0,
            faceOverlapPct: 30
        },
        limits: {
            stepdown: [0.3, 6.0],
            feedXY: [400, 3500],
            feedZ: [100, 1000],
            surfaceCleanDepth: [0.05, 1.0],
            faceStepdown: [0.2, 3.0]
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
            faceStepdown: 0.6,
            faceOverlapPct: 55
        },
        limits: {
            stepdown: [0.15, 3.0],
            feedXY: [250, 1800],
            feedZ: [80, 600],
            peckStep: [0.1, 2.0],
            surfaceCleanDepth: [0.03, 0.6],
            faceStepdown: [0.15, 2.0]
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
            faceStepdown: 0.3,
            faceOverlapPct: 65
        },
        limits: {
            stepdown: [0.05, 2.0],
            feedXY: [120, 1200],
            feedZ: [40, 350],
            peckStep: [0.1, 1.5],
            surfaceCleanDepth: [0.02, 0.35],
            faceStepdown: [0.05, 1.0]
        }
    }
};
const TOOL_DIAMETER_SCALED_FIELDS = ['stepdown', 'feedXY', 'feedZ', 'peckStep', 'surfaceCleanDepth', 'faceStepdown'];

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
    stockW: 0,
    stockH: 0,
    stockT: 0,
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
    faceStepdown: DEFAULT_MATERIAL_VALUES.faceStepdown,
    faceOverlapPct: DEFAULT_MATERIAL_VALUES.faceOverlapPct,
    facePattern: 'zigzag',
    faceOrigin: 'bl-top',
    faceEnable: false,
    optimizeOrderEnable: true,
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

const hanziGenerateBtn = document.getElementById('hanziGenerateBtn');
if (hanziGenerateBtn) {
    hanziGenerateBtn.addEventListener('click', async () => {
        const text = (document.getElementById('hanziText')?.value || '').trim();
        if (!text) { log('請先輸入要刻的中文字。'); return; }

        const sizeMm = parseFloat(document.getElementById('hanziSize')?.value) || 20;
        const charSpacingMm = parseFloat(document.getElementById('hanziSpacing')?.value) || 0;
        const engraveDepthMm = parseFloat(document.getElementById('hanziDepth')?.value) || 1;

        hanziGenerateBtn.disabled = true;
        log('正在取得字形中線資料...');
        try {
            const { parts, missing } = await buildHanziParts(text, { sizeMm, charSpacingMm, engraveDepthMm });
            if (parts.length === 0) {
                log('沒有可用的字形資料，請換其他字試試。');
                return;
            }

            previewFlipY = true;
            currentParts = parts;

            let msg = `已產生 ${parts.length} 條單線筆畫（on-path，刻深 ${engraveDepthMm} mm）。`;
            if (missing.length > 0) msg += ` 無資料略過：${[...new Set(missing)].join('')}`;
            log(msg);
            updateGenerateButtonState();

            const designExtents = computePartsExtents(currentParts);
            if (designExtents.minX !== Infinity) {
                setFieldValue('stockW', Math.ceil(designExtents.maxX - designExtents.minX));
                setFieldValue('stockH', Math.ceil(designExtents.maxY - designExtents.minY));
                persistSettings();
            }

            renderPreviewSvg();
            renderToolpathList();
        } catch (err) {
            log(`產生單線文字時發生錯誤：${err.message}`);
        } finally {
            hanziGenerateBtn.disabled = false;
        }
    });
}

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
        // 傻瓜模式面板不多，直接展開避免多按一下（胚料厚度在 stock 面板內）
        setPanelExpanded('camSettingsBody', true);
        setPanelExpanded('stockPanelBody', true);
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

    // 清掃預覽疊加層：胚料矩形 + 清掃刀路 + 對刀定位點標記
    const faceOverlay = buildFaceOverlaySvg({
        minX, maxX, minDisplayY, maxDisplayY, flipY
    });

    let vbMinX = minX;
    let vbMaxX = maxX;
    let vbMinY = minDisplayY;
    let vbMaxY = maxDisplayY;
    if (faceOverlay) {
        vbMinX = Math.min(vbMinX, faceOverlay.bounds.minX);
        vbMaxX = Math.max(vbMaxX, faceOverlay.bounds.maxX);
        vbMinY = Math.min(vbMinY, faceOverlay.bounds.minY);
        vbMaxY = Math.max(vbMaxY, faceOverlay.bounds.maxY);
    }

    const width = Math.max(1e-6, vbMaxX - vbMinX);
    const height = Math.max(1e-6, vbMaxY - vbMinY);
    const pad = Math.max(2, Math.max(width, height) * 0.05);
    const viewBox = `${(vbMinX - pad).toFixed(4)} ${(vbMinY - pad).toFixed(4)} ${(width + pad * 2).toFixed(4)} ${(height + pad * 2).toFixed(4)}`;

    const overlayMarkup = faceOverlay ? faceOverlay.markup : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${overlayMarkup}${renderedPaths.join('')}</svg>`;
}

/**
 * 清掃 2D 預覽：胚料矩形（虛線）、實際清掃刀路（與 G-Code 同一組
 * buildFacePattern 產生）、對刀定位點十字標記。
 * 傳入的是顯示座標範圍；DXF 預覽 Y 已翻轉（display = -machineY），
 * 所以定位點的上下要對映回機器座標的方向。
 */
function buildFaceOverlaySvg({ minX, maxX, minDisplayY, maxDisplayY, flipY }) {
    if (!document.getElementById('faceEnable')?.checked) return null;

    const readNum = (id, fallback) => {
        const v = parseFloat(document.getElementById(id)?.value);
        return Number.isFinite(v) && v > 0 ? v : fallback;
    };

    const designW = maxX - minX;
    const designH = maxDisplayY - minDisplayY;
    const stockW = readNum('stockW', designW);
    const stockH = readNum('stockH', designH);
    const cx = (minX + maxX) / 2;
    const cy = (minDisplayY + maxDisplayY) / 2;
    const sx0 = cx - stockW / 2;
    const sx1 = cx + stockW / 2;
    const sy0 = cy - stockH / 2;
    const sy1 = cy + stockH / 2;

    const toolD = readNum('toolD', DEFAULT_TOOL_D);
    const overlapRaw = parseFloat(document.getElementById('faceOverlapPct')?.value);
    const overlapPct = Number.isFinite(overlapRaw) ? overlapRaw : 40;
    const pattern = document.getElementById('facePattern')?.value || 'zigzag';
    const faceOrigin = parseFaceOrigin(document.getElementById('faceOrigin')?.value).corner;

    // 機器座標的「下」在顯示座標的哪一側：DXF (flipY) 的 display=-machineY，
    // 機器下緣落在顯示 maxY；SVG 則同向。
    const machineBottomAtDisplayMax = flipY;
    const displayCornerMap = machineBottomAtDisplayMax
        ? { bl: 'tl', br: 'tr', tl: 'bl', tr: 'br', center: 'center' }
        : { bl: 'bl', br: 'br', tl: 'tl', tr: 'tr', center: 'center' };
    const displayCorner = displayCornerMap[faceOrigin] || 'bl';

    const patternPts = buildFacePattern({
        x0: sx0, y0: sy0, x1: sx1, y1: sy1,
        toolD,
        overlapPct,
        pattern,
        startCorner: displayCorner === 'center' ? 'bl' : displayCorner
    });
    const polyline = patternPts.length >= 2
        ? `<polyline class="face-path" points="${patternPts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ')}"></polyline>`
        : '';

    // 對刀定位點標記（圓 + 十字）
    const isLeft = displayCorner === 'bl' || displayCorner === 'tl';
    const atMaxY = displayCorner === 'tl' || displayCorner === 'tr';
    const mx = displayCorner === 'center' ? cx : (isLeft ? sx0 : sx1);
    const my = displayCorner === 'center' ? cy : (atMaxY ? sy1 : sy0);
    const mr = Math.max(toolD * 0.6, Math.max(stockW, stockH) * 0.02);
    const marker = `<circle class="face-origin-marker" cx="${mx.toFixed(3)}" cy="${my.toFixed(3)}" r="${mr.toFixed(3)}"></circle>`
        + `<path class="face-origin-cross" d="M ${(mx - mr * 1.8).toFixed(3)} ${my.toFixed(3)} H ${(mx + mr * 1.8).toFixed(3)} M ${mx.toFixed(3)} ${(my - mr * 1.8).toFixed(3)} V ${(my + mr * 1.8).toFixed(3)}"></path>`;

    const markup = `<g class="face-overlay">`
        + `<rect class="face-stock-rect" x="${sx0.toFixed(3)}" y="${sy0.toFixed(3)}" width="${stockW.toFixed(3)}" height="${stockH.toFixed(3)}"></rect>`
        + polyline
        + marker
        + `</g>`;

    const lead = toolD / 2 + 1;
    return {
        markup,
        bounds: {
            minX: sx0 - lead,
            maxX: sx1 + lead,
            minY: sy0 - mr * 2,
            maxY: sy1 + mr * 2
        }
    };
}

// 純清掃（無設計圖）的 2D 預覽：只畫胚料矩形、清掃路徑與定位點
function buildFacingOnlyPreviewSvg() {
    if (!document.getElementById('faceEnable')?.checked) return '';
    const w = parseFloat(document.getElementById('stockW')?.value) || 0;
    const h = parseFloat(document.getElementById('stockH')?.value) || 0;
    if (!(w > 0) || !(h > 0)) return '';

    // 用胚料本身當顯示範圍；flipY=true 讓機器座標的下緣顯示在畫面下方
    const overlay = buildFaceOverlaySvg({ minX: 0, maxX: w, minDisplayY: 0, maxDisplayY: h, flipY: true });
    if (!overlay) return '';

    const b = overlay.bounds;
    const vw = Math.max(1e-6, b.maxX - b.minX);
    const vh = Math.max(1e-6, b.maxY - b.minY);
    const pad = Math.max(2, Math.max(vw, vh) * 0.05);
    const viewBox = `${(b.minX - pad).toFixed(3)} ${(b.minY - pad).toFixed(3)} ${(vw + pad * 2).toFixed(3)} ${(vh + pad * 2).toFixed(3)}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${overlay.markup}</svg>`;
}

function renderPreviewSvg() {
    if (!currentParts || currentParts.length === 0) {
        previewSvg.innerHTML = buildFacingOnlyPreviewSvg();
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
        updateGenerateButtonState();
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const fileContent = e.target.result;
            if (svgFile) {
                // parseSVG 已把 Y 翻成機器座標（Y 向上），顯示時要再翻回螢幕
                // 方向，否則 2D 預覽會與 G-Code / 3D 預覽上下顛倒
                previewFlipY = true;
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
            updateGenerateButtonState();

            // 預設胚料 = 圖形外接矩形（無條件進位到整數 mm），可再手動改大
            const designExtents = computePartsExtents(currentParts);
            if (designExtents.minX !== Infinity) {
                const autoW = Math.ceil(designExtents.maxX - designExtents.minX);
                const autoH = Math.ceil(designExtents.maxY - designExtents.minY);
                setFieldValue('stockW', autoW);
                setFieldValue('stockH', autoH);
                persistSettings();
            }

            renderPreviewSvg();

            // Render toolpath order list
            renderToolpathList();

        } catch (err) {
            log(`解析檔案時發生錯誤: ${err.message}`);
            updateGenerateButtonState();
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
        'stockW',
        'stockH',
        'stockT',
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
        'faceStepdown',
        'faceOverlapPct',
        'facePattern',
        'faceOrigin',
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
        'coolantEnable',
        'optimizeOrderEnable'
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

    const faceEnable = document.getElementById('faceEnable');
    const faceSettings = document.getElementById('faceSettings');
    const faceEnabled = Boolean(settings.faceEnable);
    if (faceEnable) faceEnable.checked = faceEnabled;
    if (faceSettings) faceSettings.style.display = faceEnabled ? 'block' : 'none';

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
        stockW: readNum('stockW', 0),
        stockH: readNum('stockH', 0),
        stockT: readNum('stockT', 0),
        faceEnable: readBool('faceEnable'),
        optimizeOrderEnable: document.getElementById('optimizeOrderEnable') ? readBool('optimizeOrderEnable') : true,
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
        faceStepdown: readNum('faceStepdown', 1),
        faceOverlapPct: readNum('faceOverlapPct', 40),
        facePattern: document.getElementById('facePattern')?.value || 'zigzag',
        faceOrigin: document.getElementById('faceOrigin')?.value || 'bl',

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
    return {
        width: maxX - minX,
        height: maxY - minY,
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2
    };
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

const ACTIVE_TOOLPATH_MODES = ['outside', 'inside', 'drill', 'on-path'];

const FACE_CORNER_NAMES = { bl: '胚料左下角', br: '胚料右下角', tl: '胚料左上角', tr: '胚料右上角', center: '胚料中心' };

// 定位點值 = "角落-Z基準"，例如 'bl-top'、'br-bottom'、'center-top'
// （中心只能碰到頂面）。舊設定只有角落名時視為頂面。
function parseFaceOrigin(value) {
    const [rawCorner = 'bl', rawZ = 'top'] = String(value || 'bl-top').split('-');
    const corner = FACE_CORNER_NAMES[rawCorner] ? rawCorner : 'bl';
    const zref = rawZ === 'bottom' && corner !== 'center' ? 'bottom' : 'top';
    return { corner, zref };
}

// 組出完整 G-Code 程式：generate（下載）與 3D 即時預覽共用同一條路徑。
// 沒有載入設計檔也能跑「純清掃」：只要啟用清掃並填好胚料長寬。
function buildProgram() {
    const sourceParts = Array.isArray(currentParts) ? currentParts : [];

    const { mfg, layout } = persistSettings();

    // Deep copy parts to apply layout transforms without mutating the core data
    let partsToProcess = JSON.parse(JSON.stringify(sourceParts));
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

    // 最短路徑：生成時自動重排加工順序（含陣列複本間的空移），
    // 分組規則不變：非外輪廓先加工、銑線外輪廓最後
    let orderOptimizeInfo = null;
    if (mfg.optimizeOrderEnable) {
        const optimized = computeOptimizedOrder(partsToProcess);
        if (optimized && optimized.after < optimized.before - 1e-6) {
            partsToProcess = optimized.order;
            orderOptimizeInfo = { before: optimized.before, after: optimized.after };
        }
    }

    const extents = computePartsExtents(partsToProcess);
    const effectiveMfg = { ...mfg };

    // 正規化定位點：generator 只需要角落代碼，Z 基準留給原點偏移用
    const faceOriginParsed = parseFaceOrigin(mfg.faceOrigin);
    effectiveMfg.faceOriginCorner = faceOriginParsed.corner;
    effectiveMfg.faceOriginZ = faceOriginParsed.zref;

    // 胚料為矩形：使用者設定長×寬（0 = 自動取圖形範圍），置中於整體圖形
    let stockW = 0;
    let stockH = 0;
    let stockTooSmall = false;
    if (extents.minX !== Infinity) {
        const designW = extents.maxX - extents.minX;
        const designH = extents.maxY - extents.minY;
        stockW = mfg.stockW > 0 ? mfg.stockW : designW;
        stockH = mfg.stockH > 0 ? mfg.stockH : designH;
        stockTooSmall = stockW < designW - 1e-6 || stockH < designH - 1e-6;
        const cx = (extents.minX + extents.maxX) / 2;
        const cy = (extents.minY + extents.maxY) / 2;
        effectiveMfg.stockBounds = {
            minX: cx - stockW / 2,
            minY: cy - stockH / 2,
            maxX: cx + stockW / 2,
            maxY: cy + stockH / 2
        };
    } else if (mfg.stockW > 0 && mfg.stockH > 0) {
        // 純清掃（無設計圖）：胚料以自身尺寸定位，原點交給對刀定位點
        stockW = mfg.stockW;
        stockH = mfg.stockH;
        effectiveMfg.stockBounds = { minX: 0, minY: 0, maxX: stockW, maxY: stockH };
    }

    const activeParts = partsToProcess.filter((part) => ACTIVE_TOOLPATH_MODES.includes(part.toolpathMode));

    // 清掃 Z 模型：材料厚度 = 成品工件高；胚料厚度 = 粗胚實際量測值。
    //  - 頂面對刀（第一次清掃，取真平）：掃掉「清掃總深度」。
    //  - 底面對刀（翻面/最終取高）：清掃量自動 = 胚料厚 − 材料厚，
    //    未量測胚料厚（0）時退回手動「預留量」。
    const faceUserDepth = Math.max(0, mfg.surfaceCleanDepth || 0);
    const finalHeight = mfg.thickness || 0;
    let faceRoughT;
    let faceDepth;
    if (faceOriginParsed.zref === 'bottom') {
        faceRoughT = mfg.stockT > 0 ? mfg.stockT : finalHeight + faceUserDepth;
        faceDepth = Math.max(0, faceRoughT - finalHeight);
    } else {
        faceRoughT = mfg.stockT > 0 ? Math.max(mfg.stockT, finalHeight) : finalHeight;
        faceDepth = faceUserDepth;
    }

    const faceActive = Boolean(effectiveMfg.faceEnable)
        && faceDepth > 0
        && Boolean(effectiveMfg.stockBounds);
    if (activeParts.length === 0 && !faceActive) {
        return { blocked: true };
    }

    if (faceActive) {
        // 內部幾何一律以粗胚厚度計算：切穿深度、支撐橋高度、STOCK 註解
        // 與 3D 胚料框才會落在正確的實體位置
        effectiveMfg.thickness = faceRoughT;
        effectiveMfg.surfaceCleanDepth = faceDepth;
    }

    const safetyWarnings = collectSafetyWarnings(partsToProcess, effectiveMfg);
    if (Boolean(mfg.faceEnable) && mfg.stockT > 0 && mfg.stockT < finalHeight - 1e-6) {
        safetyWarnings.push(`胚料厚度 ${mfg.stockT.toFixed(2)} mm 小於材料厚度 ${finalHeight.toFixed(2)} mm，掃不出目標工件高，請確認量測值。`);
    }
    if (stockTooSmall) {
        const designW = extents.maxX - extents.minX;
        const designH = extents.maxY - extents.minY;
        safetyWarnings.push(`設定的胚料 ${stockW.toFixed(1)}×${stockH.toFixed(1)} mm 小於圖形範圍 ${designW.toFixed(1)}×${designH.toFixed(1)} mm（含陣列/旋轉後），部分刀路會切到胚料外。`);
    }

    const files = buildAllGcodes(partsToProcess, effectiveMfg);
    const info = generateMachiningInfo(effectiveMfg, partsToProcess.length, layout);
    if (files.length === 0) return { blocked: true };

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
    let originLabel = effectiveMfg.originMode;

    if (faceActive && effectiveMfg.stockBounds) {
        // 啟用清掃時：程式原點 = 刀具定位點（胚料上的對刀點），
        // 工件原點下拉此時不生效。
        //  - 頂面對刀：Z0 = 粗胚頂面，清掃掃掉「總深度」。
        //  - 底面對刀：Z0 = 胚料底面（床台），清掃從 材料厚度+預留量 掃到
        //    材料厚度，成品工件高精確等於材料厚度。
        const sb = effectiveMfg.stockBounds;
        const { corner, zref } = faceOriginParsed;
        offsetX = -(corner === 'br' || corner === 'tr' ? sb.maxX : corner === 'center' ? (sb.minX + sb.maxX) / 2 : sb.minX);
        offsetY = -(corner === 'tl' || corner === 'tr' ? sb.maxY : corner === 'center' ? (sb.minY + sb.maxY) / 2 : sb.minY);
        // effectiveMfg.thickness 在底面模式已含預留量（= 粗胚厚度）
        offsetZ = zref === 'bottom' ? (effectiveMfg.thickness || 0) : 0;
        originLabel = zref === 'bottom'
            ? `${FACE_CORNER_NAMES[corner]}・底面（床台，清掃後工件高 = 材料厚度 ${(mfg.thickness || 0).toFixed(2)} mm）`
            : `${FACE_CORNER_NAMES[corner]}・頂面（清掃對刀點）`;
    } else if (extents.minX !== Infinity) {
        const cx = (extents.minX + extents.maxX) / 2;
        const cy = (extents.minY + extents.maxY) / 2;
        const mode = effectiveMfg.originMode;

        // XY: center subtracts midpoint; bottomleft subtracts min corner
        offsetX = mode.includes('center') ? -cx : -extents.minX;
        offsetY = mode.includes('center') ? -cy : -extents.minY;
        // Z: bottom shifts so Z0 = bottom face of material
        offsetZ = mode.startsWith('bottom') ? effectiveMfg.thickness : 0;

        const originLabels = {
            'top-center': '頂面中心',
            'top-bottomleft': '頂面左下角',
            'bottom-center': '底面中心',
            'bottom-bottomleft': '底面左下角'
        };
        originLabel = originLabels[mode] || mode;
    }

    txt = applyGcodeOffset(txt, offsetX, offsetY, offsetZ);

    // Mach3: keep the parenthesis "(...)" comments as-is. They are already
    // sanitized upstream by gcomment() (uppercase ASCII, no nested parens, no
    // '%'), which is what makes them safe for Mach3's stricter parser.
    // (Earlier builds converted these to ';' comments or stripped them; we now
    //  keep parentheses since they are the more universal Mach3 convention.)

    // 3D viewer gets the offset-applied G-code, so shift the stock box too
    const viewerMfg = effectiveMfg.stockBounds
        ? {
            ...effectiveMfg,
            stockBounds: {
                minX: effectiveMfg.stockBounds.minX + offsetX,
                minY: effectiveMfg.stockBounds.minY + offsetY,
                maxX: effectiveMfg.stockBounds.maxX + offsetX,
                maxY: effectiveMfg.stockBounds.maxY + offsetY
            }
        }
        : { ...effectiveMfg };
    if (faceActive) {
        // 3D 胚料框依對刀 Z 基準擺放：頂面對刀時框在 Z0 之下（清掃面在框
        // 頂），底面對刀時框在 Z0 之上。厚度已是粗胚厚度（底面模式含預留量）
        viewerMfg.originMode = faceOriginParsed.zref === 'bottom' ? 'bottom-face' : 'top-face';
    }

    return { txt, viewerMfg, info, safetyWarnings, originLabel, orderOptimizeInfo };
}

// 生成鈕：有零件、或（純清掃）啟用清掃且胚料長寬已填，才可按
function updateGenerateButtonState() {
    const hasParts = Boolean(currentParts && currentParts.length > 0);
    const faceReady = Boolean(document.getElementById('faceEnable')?.checked)
        && (parseFloat(document.getElementById('stockW')?.value) || 0) > 0
        && (parseFloat(document.getElementById('stockH')?.value) || 0) > 0;
    generateBtn.disabled = !hasParts && !faceReady;
}

generateBtn.addEventListener('click', () => {
    try {
        log("正在計算並生成 G-code...");

        const program = buildProgram();
        if (!program) return;
        if (program.blocked) {
            log('尚未指定任何刀路，無法生成 G-Code。\n請先在左側 2D 視圖：\n1. 點選上方的刀路模式（例如「銑線外」）\n2. 再點擊圖形中的線條，把刀路套用到該線段\n（或在「胚料與表面清掃」啟用清掃並填好胚料長寬）');
            return;
        }

        update3DToolpath(program.txt, program.viewerMfg);

        // Switch to 3D tab
        if (!tab3D.classList.contains('active')) {
            tab3D.click();
        }

        // Download
        const blob = new Blob([program.txt], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `svg_export_${Date.now()}.nc`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // 讓加工順序清單同步顯示實際的（優化後）順序
        if (program.orderOptimizeInfo) {
            const listOptimized = computeOptimizedOrder(currentParts);
            if (listOptimized) {
                currentParts = listOptimized.order;
                renderToolpathList();
            }
        }

        const optimizeLine = program.orderOptimizeInfo
            ? `\n空移優化：${program.orderOptimizeInfo.before.toFixed(0)} mm → ${program.orderOptimizeInfo.after.toFixed(0)} mm（省 ${Math.max(0, (1 - program.orderOptimizeInfo.after / program.orderOptimizeInfo.before) * 100).toFixed(0)}%）`
            : '';
        const warningBlock = program.safetyWarnings.length
            ? `\n\n⚠ 注意：\n${program.safetyWarnings.map((w) => `- ${w}`).join('\n')}`
            : '';
        log(`成功！G-Code 檔案已下載。${optimizeLine}${warningBlock}\n\n工件原點：${program.originLabel}\n\n${program.info}`);
    } catch (err) {
        log(`生成 G-code 時發生錯誤: ${err.message}`);
    }
});

// 3D 即時預覽：清掃/胚料參數變更時自動重算刀路並更新 3D 視圖（不下載）
let livePreviewTimer = null;
function refreshLivePreview() {
    clearTimeout(livePreviewTimer);
    livePreviewTimer = setTimeout(() => {
        try {
            const program = buildProgram();
            if (program && !program.blocked) {
                update3DToolpath(program.txt, program.viewerMfg);
            }
        } catch (err) {
            console.warn('3D 即時預覽更新失敗', err);
        }
    }, 250);
}

// --- 加工順序優化：最近鄰 + 2-opt，減少零件間的空移距離。
// 純函式：回傳新順序與前後空移估計，不動輸入陣列；零件太少回傳 null ---
function computeOptimizedOrder(parts) {
    if (!Array.isArray(parts) || parts.length < 3) return null;

    const centers = new Map();
    parts.forEach((part) => {
        const b = computePartBounds(part);
        centers.set(part.id, b ? { x: b.centerX, y: b.centerY } : { x: 0, y: 0 });
    });
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const travelOf = (parts, start) => {
        let total = 0;
        let cur = start;
        for (const p of parts) {
            const c = centers.get(p.id);
            total += dist(cur, c);
            cur = c;
        }
        return total;
    };

    // 起點：整體圖形的左下角（接近常用的工作原點位置）
    const ext = computePartsExtents(parts);
    const start = ext.minX !== Infinity ? { x: ext.minX, y: ext.minY } : { x: 0, y: 0 };

    // 分組：銑線外輪廓永遠留在最後（先切外框零件會鬆動），
    // 「不加工」的路徑放到清單尾端（不產生刀路）
    const cutFirst = parts.filter((p) => ACTIVE_TOOLPATH_MODES.includes(p.toolpathMode) && p.toolpathMode !== 'outside');
    const outsideParts = parts.filter((p) => p.toolpathMode === 'outside');
    const inactiveParts = parts.filter((p) => !ACTIVE_TOOLPATH_MODES.includes(p.toolpathMode));

    const routeGroup = (parts, from) => {
        if (parts.length === 0) return { order: [], end: from };
        // 最近鄰建初始順序
        const remaining = [...parts];
        const order = [];
        let cur = from;
        while (remaining.length) {
            let bestIndex = 0;
            let bestDist = Infinity;
            remaining.forEach((p, i) => {
                const d = dist(cur, centers.get(p.id));
                if (d < bestDist) { bestDist = d; bestIndex = i; }
            });
            const next = remaining.splice(bestIndex, 1)[0];
            order.push(next);
            cur = centers.get(next.id);
        }
        // 2-opt 反轉改善
        let improved = true;
        let guard = 0;
        while (improved && guard++ < 25) {
            improved = false;
            for (let i = 0; i < order.length - 1; i++) {
                for (let j = i + 1; j < order.length; j++) {
                    const a = i === 0 ? from : centers.get(order[i - 1].id);
                    const b = centers.get(order[i].id);
                    const c = centers.get(order[j].id);
                    const next = j === order.length - 1 ? null : centers.get(order[j + 1].id);
                    const curLen = dist(a, b) + (next ? dist(c, next) : 0);
                    const altLen = dist(a, c) + (next ? dist(b, next) : 0);
                    if (altLen + 1e-9 < curLen) {
                        let lo = i, hi = j;
                        while (lo < hi) {
                            const t = order[lo];
                            order[lo] = order[hi];
                            order[hi] = t;
                            lo++; hi--;
                        }
                        improved = true;
                    }
                }
            }
        }
        return { order, end: centers.get(order[order.length - 1].id) };
    };

    const activeBefore = parts.filter((p) => ACTIVE_TOOLPATH_MODES.includes(p.toolpathMode));
    if (activeBefore.length < 3) return null;
    const before = travelOf(activeBefore, start);

    const firstLeg = routeGroup(cutFirst, start);
    const outsideLeg = routeGroup(outsideParts, firstLeg.end);
    const order = [...firstLeg.order, ...outsideLeg.order, ...inactiveParts];
    const after = travelOf([...firstLeg.order, ...outsideLeg.order], start);

    return { order, before, after };
}

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

    // 表面清掃 enable/disable toggle: show facing fields when enabled,
    // switch the program origin to the 對刀定位點 and refresh both previews
    const faceEnableCb = document.getElementById('faceEnable');
    const faceSettingsPanel = document.getElementById('faceSettings');
    const originModeEl = document.getElementById('originMode');

    const syncOriginModeDisabled = () => {
        if (!originModeEl || !faceEnableCb) return;
        originModeEl.disabled = faceEnableCb.checked;
        originModeEl.title = faceEnableCb.checked
            ? '已啟用清掃：程式原點改用清掃的刀具定位點（胚料頂面 X0 Y0 Z0）'
            : '';
    };
    syncOriginModeDisabled();

    if (faceEnableCb && faceSettingsPanel) {
        faceEnableCb.addEventListener('change', () => {
            faceSettingsPanel.style.display = faceEnableCb.checked ? 'block' : 'none';
            syncOriginModeDisabled();
            persistSettings();
            updateGenerateButtonState();
            renderPreviewSvg();
            refreshLivePreview();
        });
    }

    // 深度欄位隨對刀 Z 基準切換意義：
    //  - 頂面：手動「清掃總深度」（第一次清掃取真平）
    //  - 底面 + 已量測胚料厚：自動 = 胚料厚 − 材料厚，欄位唯讀
    //  - 底面 + 未量測（胚料厚 0）：手動「預留量」
    const faceDepthLabelEl = document.getElementById('faceDepthLabel');
    const faceDepthInputEl = document.getElementById('surfaceCleanDepth');
    const syncFaceDepthField = () => {
        if (!faceDepthLabelEl || !faceDepthInputEl) return;
        const { zref } = parseFaceOrigin(document.getElementById('faceOrigin')?.value);
        const stockTVal = parseFloat(document.getElementById('stockT')?.value) || 0;
        const thicknessVal = parseFloat(document.getElementById('thickness')?.value) || 0;

        if (zref === 'bottom' && stockTVal > 0) {
            const autoDepth = Math.max(0, stockTVal - thicknessVal);
            faceDepthInputEl.value = Math.round(autoDepth * 1000) / 1000;
            faceDepthInputEl.readOnly = true;
            faceDepthLabelEl.textContent = '清掃量（自動）(mm)';
            faceDepthInputEl.title = '自動計算：胚料厚度 − 材料厚度。清掃到成品工件高 = 材料厚度';
        } else if (zref === 'bottom') {
            faceDepthInputEl.readOnly = false;
            faceDepthLabelEl.textContent = '清掃預留量 (mm)';
            faceDepthInputEl.title = '未量測胚料厚度：手動填粗胚高出材料厚度的預估餘量，清掃到成品工件高 = 材料厚度';
        } else {
            faceDepthInputEl.readOnly = false;
            faceDepthLabelEl.textContent = '清掃總深度 (mm)';
            faceDepthInputEl.title = '要從碰刀的粗胚頂面往下掃掉的總厚度（第一次清掃取真平）';
        }
    };
    syncFaceDepthField();
    ['faceOrigin', 'stockT', 'thickness', 'materialType'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', syncFaceDepthField);
    });

    // 清掃/胚料參數變更 → 2D 疊加層與 3D 刀路即時更新
    const facePreviewInputIds = ['stockW', 'stockH', 'stockT', 'surfaceCleanDepth', 'faceStepdown', 'faceOverlapPct', 'facePattern', 'faceOrigin', 'toolD', 'thickness'];
    facePreviewInputIds.forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => {
            if (faceEnableCb?.checked) {
                updateGenerateButtonState();
                renderPreviewSvg();
                refreshLivePreview();
            }
        });
    });

    // 還原儲存設定後（可能已勾清掃），校正生成鈕狀態
    updateGenerateButtonState();

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
