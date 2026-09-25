export const MAX_ARRAY_COPIES = 400;
export const MAX_ARRAY_PARTS = 2000;

/** Return a user-facing error before allocating preview or CAM copies. */
export function validateArrayPlan(partCount, { arrayCountX = 1, arrayCountY = 1 } = {}) {
    if (partCount === 0) return null;
    if (!Number.isSafeInteger(arrayCountX) || arrayCountX < 1
        || !Number.isSafeInteger(arrayCountY) || arrayCountY < 1) {
        return '陣列數量必須是大於 0 的整數。';
    }
    if (arrayCountX > MAX_ARRAY_COPIES || arrayCountY > MAX_ARRAY_COPIES
        || arrayCountX * arrayCountY > MAX_ARRAY_COPIES) {
        return `陣列複製數量最多 ${MAX_ARRAY_COPIES} 組，請減少 X 或 Y 數量。`;
    }
    if (partCount * arrayCountX * arrayCountY > MAX_ARRAY_PARTS) {
        return `陣列展開後最多 ${MAX_ARRAY_PARTS} 條路徑，請減少複製數量或原始路徑。`;
    }
    return null;
}
