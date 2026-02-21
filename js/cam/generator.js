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
    if (part.barStyle === 'path' && part.points) labelL += ` (Points: ${part.points.length})`;
    lines.push(`(Part: ${part.id}, ${labelL}, style=${part.barStyle || 'rect'})`);

    // 1. 孔加工
    if (holeMode === "mill") {
        lines.push("(Mill holes)");
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
    } else {
        lines.push(...drillOps({ holes: part.holes, safeZ, drillZ, feedZ }));
    }

    // 1.5 導軌槽 (Slots)
    if (part.slots) {
        lines.push("(Profile internal slots)");
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
        lines.push("(Profile inner outline)");
        lines.push(
            ...profileTangentHullOps({
                circles: part.innerOutline,
                safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth: 0, tabCount: 0, tabZ: NaN
            })
        );
    }

    if (part.useOutlineForGcode && part.outline && part.outline.length >= 2) {
        lines.push(
            ...profileTangentHullOps({
                circles: part.outline,
                safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth, tabCount, tabZ
            })
        );
    } else if (part.barStyle === 'disk') {
        const cx = part.rect ? (part.rect.x + part.rect.w / 2) : 0;
        const cy = part.rect ? (part.rect.y + part.rect.h / 2) : 0;
        lines.push(
            ...profileCircleOps({
                cx, cy,
                diameter: part.diameter,
                safeZ, cutDepth, stepdown, feedXY, feedZ
            })
        );
    } else if (part.barStyle === 'rounded') {
        lines.push(
            ...profileRoundedRectOps({ rect: part.rect, safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth, tabCount, tabZ })
        );
    } else if (part.barStyle === 'path' && part.points) {
        lines.push(
            ...profilePathOps({
                points: part.points,
                safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth, tabCount, tabZ
            })
        );
    } else {
        lines.push(
            ...profileRectOps({ rect: part.rect, safeZ, cutDepth, stepdown, feedXY, feedZ, tabWidth, tabCount, tabZ })
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
