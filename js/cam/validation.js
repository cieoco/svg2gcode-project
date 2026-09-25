/**
 * Validate machining inputs shared by the UI and the G-code generator.
 * This module is deliberately pure so callers can present the same errors
 * before generation without creating any output.
 */
export function validateMachiningInputs(parts, mfg = {}) {
    const errors = [];
    const warnings = [];
    const add = (message) => errors.push(message);
    const finite = (value) => Number.isFinite(value);

    const activeModes = new Set(['outside', 'inside', 'on-path', 'drill']);
    const activeParts = Array.isArray(parts)
        ? parts.filter((part) => activeModes.has(part?.toolpathMode || 'on-path'))
        : [];
    const hasContours = activeParts.length > 0 && !(mfg.faceEnable && finite(mfg.surfaceCleanDepth) && mfg.surfaceCleanDepth > 0);
    const needsStepdown = activeParts.some((part) => (part?.toolpathMode || 'on-path') !== 'drill');
    const faceRequested = Boolean(mfg.faceEnable);
    const faceDepth = mfg.surfaceCleanDepth;
    const hasBounds = Boolean(mfg.stockBounds);
    const faceActive = faceRequested && finite(faceDepth) && faceDepth > 0;
    const hasMachining = hasContours || faceActive;

    if (hasContours || faceActive) {
        const fields = faceActive
            ? [['faceFeedXY', '清掃 XY 進給'], ['faceFeedZ', '清掃 Z 進給'], ['faceToolD', '清掃刀徑']]
            : [['feedXY', 'XY 進給'], ['feedZ', 'Z 進給'], ['toolD', '刀徑']];
        for (const [key, label] of fields) {
            if (!finite(mfg[key]) || mfg[key] <= 0) add(`${label}必須是有限且大於 0 的數值。`);
        }
    }

    if (hasMachining) {
        const topZ = Object.hasOwn(mfg, 'stockTopZ') ? mfg.stockTopZ : 0;
        if (!finite(topZ)) add('胚料頂面 Z 必須是有限數值。');
        if (!finite(mfg.safeZ)) {
            add('安全高度必須是有限數值。');
        } else if (finite(topZ) && mfg.safeZ <= topZ) {
            add(`安全高度 Z${mfg.safeZ} 必須高於胚料頂面 Z${topZ}。`);
        }
    }

    if (hasContours) {
        if (needsStepdown && (!finite(mfg.stepdown) || mfg.stepdown <= 0)) {
            add('每層下刀必須是有限且大於 0 的數值。');
        }
        if (!finite(mfg.thickness) || mfg.thickness <= 0) {
            add('材料厚度必須是有限且大於 0 的數值。');
        }
        if (!finite(mfg.overcut) || mfg.overcut < 0) {
            add('切穿量必須是有限且大於或等於 0 的數值。');
        }
        if (finite(mfg.thickness) && finite(mfg.overcut) && mfg.thickness > 0 && mfg.overcut >= 0) {
            const topZ = Object.hasOwn(mfg, 'stockTopZ') ? mfg.stockTopZ : 0;
            const startZ = topZ;
            if (finite(topZ) && -(mfg.thickness + mfg.overcut) >= startZ) {
                add('輪廓目標 Z 必須低於起始胚料頂面。');
            }
        }
    }

    if (faceRequested && (!finite(faceDepth) || faceDepth < 0)) {
        add('清掃深度必須是有限且大於或等於 0 的數值。');
    }
    if (faceActive) {
        if (!finite(mfg.faceFinishAllow) || mfg.faceFinishAllow < 0) add('清掃精修餘量必須是有限且大於或等於 0 的數值。');
        if (mfg.faceFinishAllow > 0 && (!finite(mfg.faceFinishFeed) || mfg.faceFinishFeed <= 0)) add('清掃精修進給必須是有限且大於 0 的數值。');
        if (!finite(mfg.faceStepdown) || mfg.faceStepdown <= 0) {
            add('清掃每層下刀必須是有限且大於 0 的數值。');
        }
        if (!hasBounds) {
            add('清掃需要有效的胚料範圍。');
        } else {
            const { minX, minY, maxX, maxY } = mfg.stockBounds;
            if (![minX, minY, maxX, maxY].every(finite) || maxX <= minX || maxY <= minY) {
                add('胚料範圍必須是有限座標，且長寬都大於 0。');
            }
        }
    }

    if (hasMachining && finite(mfg.spindle) && mfg.spindle <= 0) {
        warnings.push('主軸轉速為 0；若使用手動主軸控制，這是正常設定。');
    }

    return { errors, warnings };
}
