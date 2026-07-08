/**
 * G-code Generator
 * G-code 生成器
 */

import {
    drillOps,
    faceStockOps,
    profileRectOps,
    profileRoundedRectOps,
    profileCircleOps,
    profilePathOps,
    profileTangentHullOps,
    offsetPath,
    offsetClosedPathMoves,
    signedPolygonArea,
    reverseClosedGeom
} from './operations.js';

function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length - 1; i++) {
        a += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
    }
    return Math.abs(a / 2);
}

function materialName(materialType) {
    if (materialType === 'aluminum') return '鋁材';
    if (materialType === 'plastic') return '塑膠';
    return '木材';
}

function isClosedPath(points) {
    if (!Array.isArray(points) || points.length < 3) return false;
    const first = points[0];
    const last = points[points.length - 1];
    return Math.hypot(first.x - last.x, first.y - last.y) < 0.01;
}

function closedPathArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    const pts = isClosedPath(points) ? points : [...points, points[0]];
    return signedPolygonArea(pts);
}

function orientForMaterial(geom, mode, mfg) {
    if (mfg.materialType !== 'aluminum') return geom;
    if (mode !== 'outside' && mode !== 'inside') return geom;
    if (!isClosedPath(geom.points)) return geom;

    const area = closedPathArea(geom.points);
    if (Math.abs(area) < 1e-6) return geom;

    // For a clockwise spindle, common climb-milling defaults are:
    // outside profiles clockwise, inside profiles counter-clockwise.
    const wantsCcw = mode === 'inside';
    const isCcw = area > 0;
    return isCcw === wantsCcw ? geom : reverseClosedGeom(geom);
}

/**
 * 為單個零件生成 G-code
 * @param {Object} part - 零件物件
 * @param {Object} mfg - 加工參數
 * @returns {string} G-code 文字
 */
export function buildPartGcode(part, mfg) {
    const {
        safeZ,
        feedXY,
        feedZ,
        thickness,
        overcut,
        stepdown,
        holeMode,
        tabThickness,
        tabWidth,
        tabCount,
        peckStep = 0,
        rampEnable = false,
        rampAngleDeg = 3
    } = mfg;

    // Handle toolpath modes
    const mode = part.toolpathMode || 'on-path';
    const topZ = Number.isFinite(mfg.stockTopZ) ? mfg.stockTopZ : 0;

    const isPartial = part.isPartial === true;
    const cutDepth = isPartial ? topZ - Math.abs(part.partialDepth || 2) : -(thickness + overcut);
    const drillZ = isPartial ? cutDepth : -(thickness + overcut);

    const tabEnabled = !isPartial
        && Number.isFinite(tabThickness) && tabThickness > 0
        && Number.isFinite(tabWidth) && tabWidth > 0
        && Number.isFinite(tabCount) && tabCount > 0
        && Number.isFinite(thickness) && tabThickness < thickness;
    const tabZ = tabEnabled ? -(thickness - tabThickness) : NaN;

    // Bridges only apply to outside profile cuts (not partial)
    const activeTabWidth = mode === 'outside' ? tabWidth : 0;
    const activeTabCount = mode === 'outside' ? tabCount : 0;
    const activeTabZ    = mode === 'outside' ? tabZ    : NaN;

    const lines = [];

    // 註解說明
    let labelL = part.L !== undefined ? `L ${part.L.toFixed(2)}MM` : `W ${part.width} H ${part.height || part.diameter}`;
    if (part.barStyle === 'path' && part.points) labelL += ` PTS ${part.points.length}`;

    // Mach3 parsing is aggressive: uppercase only, no underscores, no equals signs
    const safeId = part.id ? part.id.toUpperCase().replace(/_/g, '') : 'UNKNOWN';
    const safeStyle = part.barStyle ? part.barStyle.toUpperCase() : 'RECT';
    lines.push(`(PART ${safeId} ${labelL} STYLE ${safeStyle})`);

    // Support 'none' mode (do not generate geometry G-code for this part)
    if (mode === 'none') {
        const lines = [];
        // Optional: you could push a comment if you want, but empty slice is cleaner
        return lines;
    }

    const offsetDist = mode === 'outside' ? (mfg.toolD / 2) : mode === 'inside' ? (-mfg.toolD / 2) : 0;

    // 1. Drill operation specifically selected by user
    if (mode === 'drill') {
        lines.push("(DRILL SELECTED POINT)");
        // Calculate center of bounding box
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        if (part.points && part.points.length > 0) {
            for (const pt of part.points) {
                if (pt.x < minX) minX = pt.x;
                if (pt.x > maxX) maxX = pt.x;
                if (pt.y < minY) minY = pt.y;
                if (pt.y > maxY) maxY = pt.y;
            }
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            lines.push(...drillOps({ holes: [{ x: cx, y: cy }], safeZ, drillZ, feedZ, topZ, peckStep }));
        }

        return lines.join("\r\n") + "\r\n";
    }

    // 1. 孔加工 (Legacy feature, if any)
    if (holeMode === "mill" && part.holes && part.holes.length > 0) {
        lines.push("(MILL HOLES)");
        for (const h of part.holes) {
            const holeD = Number.isFinite(h.d) ? h.d : part.holeD;
            lines.push(
                ...profileCircleOps({
                    cx: h.x,
                    cy: h.y,
                    diameter: holeD,
                    safeZ,
                    topZ,
                    cutDepth,
                    stepdown,
                    feedXY,
                    feedZ,
                })
            );
        }
    } else if (part.holes && part.holes.length > 0) {
        lines.push(...drillOps({ holes: part.holes, safeZ, drillZ, feedZ, topZ, peckStep }));
    }

    // 1.5 導軌槽 (Slots)
    if (part.slots) {
        lines.push("(PROFILE INTERNAL SLOTS)");
        for (const slot of part.slots) {
            lines.push(
                ...profileRoundedRectOps({
                    rect: slot,
                    safeZ, topZ, cutDepth, stepdown, feedXY, feedZ, tabWidth: 0, tabCount: 0, tabZ: NaN
                })
            );
        }
    }

    if (part.useOutlineForGcode && part.innerOutline && part.innerOutline.length >= 2) {
        lines.push("(PROFILE INNER OUTLINE)");
        lines.push(
            ...profileTangentHullOps({
                circles: part.innerOutline,
                safeZ, topZ, cutDepth, stepdown, feedXY, feedZ, tabWidth: 0, tabCount: 0, tabZ: NaN
            })
        );
    }

    if (part.useOutlineForGcode && part.outline && part.outline.length >= 2) {
        lines.push("(PROFILE OUTLINE)");
        lines.push(
            ...profileTangentHullOps({
                circles: part.outline,
                safeZ, topZ, cutDepth, stepdown, feedXY, feedZ,
                tabWidth: activeTabWidth, tabCount: activeTabCount, tabZ: activeTabZ
            })
        );
    } else if (part.barStyle === 'disk') {
        const cx = part.rect ? (part.rect.x + part.rect.w / 2) : 0;
        const cy = part.rect ? (part.rect.y + part.rect.h / 2) : 0;
        lines.push("(PROFILE DISK OUTLINE)");
        lines.push(
            ...profileCircleOps({
                cx, cy,
                diameter: part.diameter,
                safeZ, topZ, cutDepth, stepdown, feedXY, feedZ,
                clockwise: mfg.materialType === 'aluminum' && mode === 'outside'
            })
        );
    } else if (part.barStyle === 'rounded') {
        const _rectPoints = [
            { x: part.rect.x, y: part.rect.y },
            { x: part.rect.x + part.rect.w, y: part.rect.y },
            { x: part.rect.x + part.rect.w, y: part.rect.y + part.rect.h },
            { x: part.rect.x, y: part.rect.y + part.rect.h },
            { x: part.rect.x, y: part.rect.y }
        ];
        const offsetted = offsetDist !== 0 ? offsetPath(_rectPoints, offsetDist) : _rectPoints;
        const geom = orientForMaterial({ points: offsetted }, mode, mfg);
        lines.push(
            ...profilePathOps({
                points: geom.points,
                safeZ, topZ, cutDepth, stepdown, feedXY, feedZ,
                tabWidth: activeTabWidth, tabCount: activeTabCount, tabZ: activeTabZ,
                ramp: rampEnable, rampAngleDeg
            })
        );
    } else if (part.barStyle === 'path' && part.points) {
        const offsetTyped = offsetDist !== 0 && part.moves && part.moves.length > 0 && part.startPoint
            ? offsetClosedPathMoves(part.startPoint, part.moves, offsetDist)
            : null;
        const offsetted = offsetTyped
            ? offsetTyped.points
            : (offsetDist !== 0 ? offsetPath(part.points, offsetDist) : part.points);
        const useMoves = Boolean(
            offsetTyped ||
            (offsetDist === 0 && part.moves && part.moves.length > 0)
        );
        const geom = orientForMaterial({
            points: offsetted,
            moves: useMoves ? (offsetTyped ? offsetTyped.moves : part.moves) : undefined,
            startPoint: useMoves ? (offsetTyped ? offsetTyped.startPoint : part.startPoint) : undefined
        }, mode, mfg);
        lines.push(
            ...profilePathOps({
                points: geom.points,
                moves: geom.moves,
                startPoint: geom.startPoint,
                safeZ, topZ, cutDepth, stepdown, feedXY, feedZ,
                tabWidth: activeTabWidth, tabCount: activeTabCount, tabZ: activeTabZ,
                ramp: rampEnable, rampAngleDeg
            })
        );
    } else {
        const _rectPoints = [
            { x: part.rect.x, y: part.rect.y },
            { x: part.rect.x + part.rect.w, y: part.rect.y },
            { x: part.rect.x + part.rect.w, y: part.rect.y + part.rect.h },
            { x: part.rect.x, y: part.rect.y + part.rect.h },
            { x: part.rect.x, y: part.rect.y }
        ];
        const offsetted = offsetDist !== 0 ? offsetPath(_rectPoints, offsetDist) : _rectPoints;
        const geom = orientForMaterial({ points: offsetted }, mode, mfg);
        lines.push(
            ...profilePathOps({
                points: geom.points,
                safeZ, topZ, cutDepth, stepdown, feedXY, feedZ,
                tabWidth: activeTabWidth, tabCount: activeTabCount, tabZ: activeTabZ,
                ramp: rampEnable, rampAngleDeg
            })
        );
    }

    // Sweep (pocket clearing) — inside mode only
    if (mode === 'inside' && part.sweep && part.points && part.points.length >= 3) {
        lines.push("(SWEEP POCKET CLEARING)");
        const stepover = Math.abs(part.sweepStepover || mfg.toolD * 0.5);
        const hasMoves = part.moves && part.moves.length > 0 && part.startPoint;
        let n = 1;
        while (n <= 500) {
            const sweepOffset = offsetDist - n * stepover;
            let sweptPoints, sweptMoves, sweptStartPoint;
            if (hasMoves) {
                const result = offsetClosedPathMoves(part.startPoint, part.moves, sweepOffset);
                if (!result || !result.points || result.points.length < 3 || polygonArea(result.points) < 0.5) break;
                sweptPoints = result.points;
                sweptMoves = result.moves;
                sweptStartPoint = result.startPoint;
            } else {
                sweptPoints = offsetPath(part.points, sweepOffset);
                if (!sweptPoints || sweptPoints.length < 3 || polygonArea(sweptPoints) < 0.5) break;
            }
            const geom = orientForMaterial({
                points: sweptPoints,
                moves: sweptMoves,
                startPoint: sweptStartPoint
            }, mode, mfg);
            lines.push(...profilePathOps({
                points: geom.points,
                moves: geom.moves,
                startPoint: geom.startPoint,
                safeZ, topZ, cutDepth, stepdown, feedXY, feedZ,
                tabWidth: 0, tabCount: 0, tabZ: NaN,
                ramp: rampEnable, rampAngleDeg
            }));
            n++;
        }
    }

    return lines.join("\r\n") + "\r\n";
}

/**
 * 為所有零件生成 G-code 檔案
 * @param {Array} parts - 零件陣列
 * @param {Object} mfg - 加工參數
 * @returns {Array<{name: string, text: string}>} 檔案陣列
 */
export function buildAllGcodes(parts, mfg) {
    const files = [];
    let stockTopZ = Number.isFinite(mfg.stockTopZ) ? mfg.stockTopZ : 0;

    // 胚料表面清掃：獨立於工件的前置作業，先整平胚料頂面，
    // 之後所有工件刀路都從掃平後的新頂面 (stockTopZ) 起算
    const faceDepth = Math.max(0, mfg.surfaceCleanDepth || 0);
    if (mfg.faceEnable && faceDepth > 0 && mfg.stockBounds) {
        const faceLines = faceStockOps({
            x0: mfg.stockBounds.minX,
            y0: mfg.stockBounds.minY,
            x1: mfg.stockBounds.maxX,
            y1: mfg.stockBounds.maxY,
            toolD: mfg.toolD,
            overlapPct: mfg.faceOverlapPct,
            faceDepth,
            faceStepdown: mfg.faceStepdown,
            safeZ: mfg.safeZ,
            feedXY: mfg.feedXY,
            feedZ: mfg.feedZ,
            topZ: stockTopZ,
            pattern: mfg.facePattern,
            startCorner: mfg.faceOriginCorner === 'center' || !mfg.faceOriginCorner ? 'bl' : mfg.faceOriginCorner
        });
        if (faceLines.length > 0) {
            files.push({ name: 'facing.nc', text: faceLines.join("\r\n") + "\r\n" });
            stockTopZ -= faceDepth;
        }
    }

    for (const p of parts) {
        const opMfg = { ...mfg, stockTopZ };
        const g = buildPartGcode(p, opMfg);
        files.push({ name: `${p.id}.nc`, text: g });
    }
    return files;
}

/**
 * 生成加工摘要資訊
 * @param {Object} mfg - 加工參數
 * @param {number} partCount - 零件數量
 * @param {Object} layout - 版面與變換設定
 * @returns {string} 摘要文字
 */
export function generateMachiningInfo(mfg, partCount, layout = {}) {
    const cutDepth = mfg.thickness + mfg.overcut;
    const stockTopZ = Number.isFinite(mfg.stockTopZ) ? mfg.stockTopZ : 0;
    const cuttingDistance = Math.max(0, cutDepth + stockTopZ);
    const effectiveStepdown = Number.isFinite(mfg.stepdown) && mfg.stepdown > 1e-6 ? mfg.stepdown : Math.max(cuttingDistance, cutDepth);
    const layers = Math.max(1, Math.ceil(cuttingDistance / Math.max(effectiveStepdown, 1e-6)));
    const arrayCountX = Math.max(1, Math.round(layout.arrayCountX || 1));
    const arrayCountY = Math.max(1, Math.round(layout.arrayCountY || 1));
    const totalCopies = arrayCountX * arrayCountY;

    const info = [];
    info.push(`加工參數摘要：`);
    info.push(`- 加工材料：${materialName(mfg.materialType)}`);
    info.push(`- 零件數量：${partCount}`);
    if (totalCopies > 1) {
        info.push(`- 陣列排列：X ${arrayCountX} 個，間距 ${(layout.arraySpacingX || 0).toFixed(2)} mm；Y ${arrayCountY} 個，間距 ${(layout.arraySpacingY || 0).toFixed(2)} mm`);
        info.push(`- 陣列總副本數：${totalCopies}`);
    }
    info.push(`- 材料厚度：${mfg.thickness.toFixed(2)} mm`);
    info.push(`- 總切深：${cutDepth.toFixed(2)} mm`);
    if (mfg.stockBounds) {
        const sw = mfg.stockBounds.maxX - mfg.stockBounds.minX;
        const sh = mfg.stockBounds.maxY - mfg.stockBounds.minY;
        info.push(`- 胚料尺寸：${sw.toFixed(1)} × ${sh.toFixed(1)} × ${mfg.thickness.toFixed(1)} mm`);
    }
    if (mfg.faceEnable && Number.isFinite(mfg.surfaceCleanDepth) && mfg.surfaceCleanDepth > 0) {
        const patternName = mfg.facePattern === 'spiral' ? '環繞（外→內）' : '往復（Zigzag）';
        const cornerNames = { bl: '胚料左下角', br: '胚料右下角', tl: '胚料左上角', tr: '胚料右上角', center: '胚料中心' };
        const cornerName = cornerNames[mfg.faceOriginCorner] || cornerNames.bl;
        const perPass = Number.isFinite(mfg.faceStepdown) && mfg.faceStepdown > 0 ? mfg.faceStepdown : mfg.surfaceCleanDepth;
        const isBottomRef = mfg.faceOriginZ === 'bottom';
        info.push(`- 胚料表面清掃：${isBottomRef ? '預留量' : '總深度'} ${mfg.surfaceCleanDepth.toFixed(2)} mm，每層下切 ${perPass.toFixed(2)} mm，${patternName}，重疊 ${Number(mfg.faceOverlapPct || 40).toFixed(0)}% 刀徑`);
        if (isBottomRef) {
            // 底面模式下 mfg.thickness 已是粗胚厚度（成品高 + 預留量）
            const finalHeight = mfg.thickness - mfg.surfaceCleanDepth;
            info.push(`- 對刀定位點：${cornerName}・底面（床台 X0 Y0 Z0），清掃從 Z${mfg.thickness.toFixed(2)} 掃到 Z${finalHeight.toFixed(2)}，成品工件高 = ${finalHeight.toFixed(2)} mm`);
        } else {
            info.push(`- 對刀定位點：${cornerName}・頂面（X0 Y0 Z0），清掃後頂面 Z${(stockTopZ - mfg.surfaceCleanDepth).toFixed(2)}`);
        }
    }
    info.push(`- 每層下刀：${mfg.stepdown.toFixed(2)} mm`);
    info.push(`- 切割層數：${layers}`);
    info.push(`- 刀徑：${mfg.toolD.toFixed(2)} mm`);
    info.push(`- XY 進給：${mfg.feedXY.toFixed(0)} mm/min`);
    info.push(`- Z 進給：${mfg.feedZ.toFixed(0)} mm/min`);
    if (mfg.rampEnable) {
        info.push(`- 斜坡進刀：啟用，角度 ${mfg.rampAngleDeg.toFixed(1)} deg`);
    }
    if (Number.isFinite(mfg.peckStep) && mfg.peckStep > 0) {
        info.push(`- 啄鑽：每次 ${mfg.peckStep.toFixed(2)} mm`);
    }
    info.push(`- 冷卻/氣吹：${mfg.coolantEnable ? '啟用 M8/M9' : '停用'}`);
    info.push(`- 孔加工：${mfg.holeMode === "mill" ? "銑內徑" : "鑽中心點"}`);
    info.push(`- 後處理器：${mfg.postProcessor === "mach3" ? "MACH3" : "GRBL"}`);
    if (Number.isFinite(mfg.spindle) && mfg.spindle > 0) {
        info.push(`- 主軸轉速：${mfg.spindle.toFixed(0)} RPM`);
    }
    if (Number.isFinite(mfg.tabThickness) && mfg.tabThickness > 0 && Number.isFinite(mfg.tabWidth) && mfg.tabWidth > 0 && Number.isFinite(mfg.tabCount) && mfg.tabCount > 0) {
        info.push(`- 固定支撐橋 (Tabs): 厚度 ${mfg.tabThickness.toFixed(2)} mm, 寬度 ${mfg.tabWidth.toFixed(2)} mm, 數量 ${Math.round(mfg.tabCount)}`);
    }


    return info.join('\n');
}
