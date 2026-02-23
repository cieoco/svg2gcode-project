/**
 * G-code Generator
 * G-code 生成器
 */

import {
    gcodeHeader,
    gcodeFooter,
    drillOps,
    profileRectOps,
    profileRoundedRectOps,
    profileCircleOps,
    profilePathOps,
    profileTangentHullOps,
    offsetPath
} from './operations.js';

/**
 * 為單個零件生成 G-code
 * @param {Object} part - 零件物件
 * @param {Object} mfg - 加工參數
 * @returns {string} G-code 文字
 */
export function buildPartGcode(part, mfg) {
    const { safeZ, feedXY, feedZ, thickness, overcut, stepdown, spindle, holeMode, tabThickness, tabWidth, tabCount, postProcessor } = mfg;

    const cutDepth = -(thickness + overcut); // 負值
    const drillZ = cutDepth; // 鑽孔深度與切深相同

    const tabEnabled = Number.isFinite(tabThickness) && tabThickness > 0
        && Number.isFinite(tabWidth) && tabWidth > 0
        && Number.isFinite(tabCount) && tabCount > 0
        && Number.isFinite(thickness) && tabThickness < thickness;
    const tabZ = tabEnabled ? -(thickness - tabThickness) : NaN;

    const lines = [];
    lines.push(...gcodeHeader({ safeZ, spindle, postProcessor }));

    // 註解說明
    let labelL = part.L !== undefined ? `L=${part.L.toFixed(2)}mm` : `W=${part.width}, H=${part.height || part.diameter}`;
    if (part.barStyle === 'path' && part.points) labelL += ` [Points: ${part.points.length}]`;
    lines.push(`(Part: ${part.id}, ${labelL}, style=${part.barStyle || 'rect'})`);

    // Handle toolpath modes
    const mode = part.toolpathMode || 'on-path';

    // Support 'none' mode (do not generate geometry G-code for this part)
    if (mode === 'none') {
        const lines = [];
        // Optional: you could push a comment if you want, but empty slice is cleaner
        return lines;
    }

    const offsetDist = mode === 'outside' ? (mfg.toolD / 2) : mode === 'inside' ? (-mfg.toolD / 2) : 0;

    // 1. Drill operation specifically selected by user 
    if (mode === 'drill') {
        lines.push("(Drill selected point)");
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
            lines.push(...drillOps({ holes: [{ x: cx, y: cy }], safeZ, drillZ, feedZ }));
        }
        lines.push(...gcodeFooter({ safeZ, spindle, postProcessor }));
        return lines.join("\n") + "\n";
    }

    // 1. 孔加工 (Legacy feature, if any)
    if (holeMode === "mill" && part.holes && part.holes.length > 0) {
        lines.push("[Mill holes]");
        for (const h of part.holes) {
            const holeD = Number.isFinite(h.d) ? h.d : part.holeD;
            lines.push(
                ...profileCircleOps({
                    cx: h.x,
                    cy: h.y,
                    diameter: holeD,
                    safeZ,
                    cutDepth,
                    stepdown,
                    feedXY,
                    feedZ,
                })
            );
        }
    } else if (part.holes && part.holes.length > 0) {
        lines.push(...drillOps({ holes: part.holes, safeZ, drillZ, feedZ }));
    }

    // 1.5 導軌槽 (Slots)
    if (part.slots) {
        lines.push("[Profile internal slots]");
        for (const slot of part.slots) {
            lines.push(
                ...profileRoundedRectOps({
                    rect: slot,
                    safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth: 0, tabCount: 0, tabZ: NaN
                })
            );
        }
    }

    if (part.useOutlineForGcode && part.innerOutline && part.innerOutline.length >= 2) {
        lines.push("[Profile inner outline]");
        lines.push(
            ...profileTangentHullOps({
                circles: part.innerOutline,
                safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth: 0, tabCount: 0, tabZ: NaN
            })
        );
    }

    if (part.useOutlineForGcode && part.outline && part.outline.length >= 2) {
        lines.push("[Profile outline]");
        lines.push(
            ...profileTangentHullOps({
                circles: part.outline,
                safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth, tabCount, tabZ
            })
        );
    } else if (part.barStyle === 'disk') {
        const cx = part.rect ? (part.rect.x + part.rect.w / 2) : 0;
        const cy = part.rect ? (part.rect.y + part.rect.h / 2) : 0;
        lines.push("[Profile disk outline]");
        lines.push(
            ...profileCircleOps({
                cx, cy,
                diameter: part.diameter,
                safeZ, cutDepth, stepdown, feedXY, feedZ
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
        lines.push(
            ...profilePathOps({ points: offsetted, safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth, tabCount, tabZ })
        );
    } else if (part.barStyle === 'path' && part.points) {
        const offsetted = offsetDist !== 0 ? offsetPath(part.points, offsetDist) : part.points;
        lines.push(
            ...profilePathOps({
                points: offsetted,
                safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth, tabCount, tabZ
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
        lines.push(
            ...profilePathOps({ points: offsetted, safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth, tabCount, tabZ })
        );
    }

    lines.push(...gcodeFooter({ safeZ, spindle, postProcessor }));
    return lines.join("\n") + "\n";
}

/**
 * 為所有零件生成 G-code 檔案
 * @param {Array} parts - 零件陣列
 * @param {Object} mfg - 加工參數
 * @returns {Array<{name: string, text: string}>} 檔案陣列
 */
export function buildAllGcodes(parts, mfg) {
    const files = [];
    for (const p of parts) {
        const g = buildPartGcode(p, mfg);
        files.push({ name: `${p.id}.nc`, text: g });
    }
    return files;
}

/**
 * 生成加工摘要資訊
 * @param {Object} mfg - 加工參數
 * @param {number} partCount - 零件數量
 * @returns {string} 摘要文字
 */
export function generateMachiningInfo(mfg, partCount) {
    const cutDepth = mfg.thickness + mfg.overcut;
    const layers = Math.max(1, Math.ceil(cutDepth / mfg.stepdown));

    const info = [];
    info.push(`加工參數摘要：`);
    info.push(`- 零件數量：${partCount}`);
    info.push(`- 材料厚度：${mfg.thickness.toFixed(2)} mm`);
    info.push(`- 總切深：${cutDepth.toFixed(2)} mm`);
    info.push(`- 每層下刀：${mfg.stepdown.toFixed(2)} mm`);
    info.push(`- 切割層數：${layers}`);
    info.push(`- 刀徑：${mfg.toolD.toFixed(2)} mm`);
    info.push(`- XY 進給：${mfg.feedXY.toFixed(0)} mm/min`);
    info.push(`- Z 進給：${mfg.feedZ.toFixed(0)} mm/min`);
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
