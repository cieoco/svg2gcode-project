/**
 * Resolve the stock datum used for program offsets independently from whether
 * a facing pass has positive depth and will emit cutting motion.
 */
export function getProgramOriginContext({
    faceEnable = false,
    faceOrigin = 'bl-top',
    faceDepth = 0,
    stockBounds = null,
    thickness = 0,
    originMode = 'top-bottomleft'
} = {}) {
    const [rawCorner = 'bl', rawZ = 'top'] = String(faceOrigin || 'bl-top').split('-');
    const validCorners = new Set(['bl', 'br', 'tl', 'tr', 'center']);
    const corner = validCorners.has(rawCorner) ? rawCorner : 'bl';
    const zref = rawZ === 'bottom' && corner !== 'center' ? 'bottom' : 'top';
    const useFaceDatum = Boolean(faceEnable && stockBounds);
    const faceMotionActive = Boolean(useFaceDatum && Number.isFinite(faceDepth) && faceDepth > 0);
    const resolvedOriginMode = originMode || 'top-bottomleft';
    const offsetZ = useFaceDatum
        ? (zref === 'bottom' ? thickness : 0)
        : (String(resolvedOriginMode).startsWith('bottom') ? thickness : 0);

    return {
        useFaceDatum,
        faceMotionActive,
        corner,
        zref,
        offsetZ,
        viewerOriginMode: useFaceDatum
            ? (zref === 'bottom' ? 'bottom-face' : 'top-face')
            : resolvedOriginMode
    };
}
