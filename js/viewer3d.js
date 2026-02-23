/**
 * 3D Toolpath Viewer
 * Renders the workpiece and G-Code coordinates using Three.js
 */

let scene, camera, renderer, controls;
let toolpathGroup;

export function init3DViewer(containerId) {
    const container = document.getElementById(containerId);

    scene = new THREE.Scene();
    scene.background = new THREE.Color('#0f1115'); // match --bg-dark

    // Camera setup
    camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.up.set(0, 0, 1); // Make Z axis the up vector (machining standard)
    camera.position.set(0, -150, 150);

    // Renderer setup
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    // Orbit controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Grid support
    const gridHelper = new THREE.GridHelper(300, 30, 0x444444, 0x222222);
    gridHelper.rotation.x = Math.PI / 2; // Lay flat on XY plane
    scene.add(gridHelper);

    // Group to hold dynamic parts
    toolpathGroup = new THREE.Group();
    scene.add(toolpathGroup);

    // Handle Resize
    window.addEventListener('resize', () => {
        if (container.clientWidth > 0 && container.style.display !== 'none') {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
        }
    });

    // Handle visibility toggle and resize cleanly
    const resizeObserver = new ResizeObserver((entries) => {
        for (let entry of entries) {
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0) {
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
                renderer.setSize(width, height);
            }
        }
    });
    resizeObserver.observe(container);

    // Animation Loop
    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }
    animate();
}

// --- Animation Variables ---
let animationReqId = null;
let animationPoints = []; // Stores {point: Vector3, isRapid: boolean}
let pathLengths = []; // Stores cumulative length at each point
let totalPathLength = 0;
let currentAnimProg = 0; // 0 to 1
let isPlaying = false;
let playbackSpeed = 5; // mm per frame? or multiplier
const MSEC_PER_FRAME = 16.6;

// Materials
const rapidMat = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.4 });
const cutMat = new THREE.LineBasicMaterial({ color: 0x00e5ff });
const toolheadMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });

let toolhead = null;
let toolpathLinesGroup = null; // Holds the drawn lines

// UI Elements (to be linked from app.js)
let uiRefs = {
    slider: null,
    lblTime: null,
    lblProg: null,
    btnPlay: null
};

export function linkAnimationUI(slider, lblTime, lblProg, btnPlay, selSpeed, btnReset) {
    uiRefs.slider = slider;
    uiRefs.lblTime = lblTime;
    uiRefs.lblProg = lblProg;
    uiRefs.btnPlay = btnPlay;

    slider.addEventListener('input', (e) => {
        currentAnimProg = parseFloat(e.target.value) / 100;
        updateAnimationState();
        if (!isPlaying) drawProgress(currentAnimProg);
    });

    btnPlay.addEventListener('click', () => {
        isPlaying = !isPlaying;
        updatePlayBtnState();
        if (isPlaying) {
            if (currentAnimProg >= 1) currentAnimProg = 0;
            animateToolpath();
        } else {
            if (animationReqId) cancelAnimationFrame(animationReqId);
        }
    });

    btnReset.addEventListener('click', () => {
        currentAnimProg = 0;
        updateAnimationState();
        drawProgress(0);
    });

    selSpeed.addEventListener('change', (e) => {
        playbackSpeed = parseFloat(e.target.value);
    });
}

function updatePlayBtnState() {
    if (!uiRefs.btnPlay) return;
    uiRefs.btnPlay.innerHTML = isPlaying ?
        `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
}

function updateAnimationState() {
    if (!uiRefs.slider) return;
    uiRefs.slider.value = (currentAnimProg * 100).toFixed(1);
    uiRefs.lblProg.innerText = Math.round(currentAnimProg * 100) + '%';

    // Estimate time based on standard feedrate or just total length
    const assumedFeed = 1000; // mm/min
    const totalMinutes = totalPathLength / assumedFeed;
    const currentMinutes = totalMinutes * currentAnimProg;
    const m = Math.floor(currentMinutes);
    const s = Math.floor((currentMinutes - m) * 60);
    uiRefs.lblTime.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function initToolhead(toolDiameter) {
    if (!toolpathGroup) return;

    if (toolhead) toolpathGroup.remove(toolhead);

    // Allocate a fresh Group for the toolhead
    toolhead = new THREE.Group();

    // Use real tool radius from CAM settings (diameter/2)
    const toolRadius = (toolDiameter || 3.175) / 2;
    // End mills have a L/D ratio of ~7x (e.g. 3.175mm dia → ~22mm long)
    const toolHeight = toolRadius * 2 * 7;
    const bitGeo = new THREE.CylinderGeometry(toolRadius, toolRadius, toolHeight, 16);
    bitGeo.translate(0, toolHeight / 2, 0); // shift so bottom tip sits at origin
    const bit = new THREE.Mesh(bitGeo, toolheadMat);
    bit.rotation.x = Math.PI / 2; // lay along Z axis (machining convention)

    toolhead.add(bit);
    toolpathGroup.add(toolhead);
    toolhead.visible = false;
}

/**
 * Parses Gcode string and sets up animation data
 */
export function update3DToolpath(gcodeText, mfg) {
    if (!scene) return;

    if (animationReqId) cancelAnimationFrame(animationReqId);
    isPlaying = false;
    updatePlayBtnState();

    // Show UI control overlay
    document.getElementById('animControls').style.display = 'flex';

    // Clear old objects
    while (toolpathGroup.children.length > 0) {
        const child = toolpathGroup.children[0];
        if (child.geometry) child.geometry.dispose();
        if (child.material && Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else if (child.material) child.material.dispose();
        toolpathGroup.remove(child);
    }
    toolhead = null; // Important: reset to null so initToolhead creates a new one properly

    toolpathLinesGroup = new THREE.Group();
    toolpathGroup.add(toolpathLinesGroup);

    if (!gcodeText) return;

    const lines = gcodeText.split('\n');
    let x = 0, y = 0, z = mfg.safeZ || 5;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    animationPoints = [];
    pathLengths = [];
    totalPathLength = 0;

    let isRapid = true;

    // Start point
    animationPoints.push({ p: new THREE.Vector3(x, y, z), isRapid });
    pathLengths.push(0);

    for (const line of lines) {
        if (line.startsWith('(') || line.startsWith('%')) continue;

        const parts = line.split(/\s+/);
        let newX = x, newY = y, newZ = z;
        let newIsRapid = isRapid;
        let moved = false;

        for (const token of parts) {
            const char = token[0];
            const val = parseFloat(token.substring(1));
            if (isNaN(val)) continue;

            if (char === 'G') {
                if (val === 0) newIsRapid = true;
                if (val === 1) newIsRapid = false;
            } else if (char === 'X') {
                newX = val; moved = true;
                if (newX < minX) minX = newX;
                if (newX > maxX) maxX = newX;
            } else if (char === 'Y') {
                newY = val; moved = true;
                if (newY < minY) minY = newY;
                if (newY > maxY) maxY = newY;
            } else if (char === 'Z') {
                newZ = val; moved = true;
            }
        }

        if (moved) {
            isRapid = newIsRapid;
            const pt = new THREE.Vector3(newX, newY, newZ);
            const dist = pt.distanceTo(animationPoints[animationPoints.length - 1].p);
            totalPathLength += dist;

            animationPoints.push({ p: pt, isRapid });
            pathLengths.push(totalPathLength);

            x = newX; y = newY; z = newZ;
        }
    }

    // Render stock material box
    if (minX !== Infinity && maxX !== -Infinity && minY !== Infinity && maxY !== -Infinity) {
        const margin = mfg.materialMargin !== undefined ? mfg.materialMargin : 4;
        const w = (maxX - minX) + margin * 2;
        const h = (maxY - minY) + margin * 2;
        const d = (mfg.thickness || 3) + 0.1;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        const boxGeo = new THREE.BoxGeometry(w, h, d);
        const edges = new THREE.EdgesGeometry(boxGeo);
        const boxMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15 });
        const boxMesh = new THREE.LineSegments(edges, boxMat);
        boxMesh.position.set(cx, cy, -d / 2);
        toolpathGroup.add(boxMesh);

        // Auto-frame camera to fit the bounding box
        const diag = Math.sqrt(w * w + h * h);
        // FOV-based distance: distance required so the diagonal fills ~70% of the vertical FOV 
        const fovRad = (camera.fov || 50) * Math.PI / 180;
        const camDist = (diag / 2) / Math.tan(fovRad / 2) * 1.2;
        controls.target.set(cx, cy, 0);
        camera.position.set(cx, cy - camDist * 0.6, camDist * 0.8);
        controls.update();
    }

    // Initialize the toolhead using the real tool diameter from CAM settings
    initToolhead(mfg.toolD);

    // Default: draw full path
    currentAnimProg = 1;
    updateAnimationState();
    drawProgress(1);
}

function animateToolpath() {
    if (!isPlaying) return;

    // Calculate how much distance to cover this frame
    // Base speed depends on whether it's rapid or cutting, but we'll simplify: 
    // target mm per second. Base 10mm/sec * playback multiplier
    const speedMultiplier = playbackSpeed; // from UI 
    const stepLength = (10 * speedMultiplier) * (MSEC_PER_FRAME / 1000);

    currentAnimProg += stepLength / totalPathLength;

    if (currentAnimProg >= 1) {
        currentAnimProg = 1;
        isPlaying = false;
        updatePlayBtnState();
        drawProgress(currentAnimProg);
        updateAnimationState();
        return;
    }

    drawProgress(currentAnimProg);
    updateAnimationState();

    animationReqId = requestAnimationFrame(animateToolpath);
}

// Rebuilds the line segments up to the current progress point
function drawProgress(prog) {
    if (animationPoints.length < 2) return;

    // Clear old lines
    while (toolpathLinesGroup.children.length > 0) {
        const child = toolpathLinesGroup.children[0];
        if (child.geometry) child.geometry.dispose();
        toolpathLinesGroup.remove(child);
    }

    const targetLength = totalPathLength * prog;

    // Find which segment we are currently interpolating
    let endIdx = 1;
    for (; endIdx < pathLengths.length; endIdx++) {
        if (pathLengths[endIdx] >= targetLength) {
            break;
        }
    }

    if (endIdx >= animationPoints.length) endIdx = animationPoints.length - 1;

    // Build completed batches
    let currentPoints = [animationPoints[0].p];
    let currentRapid = animationPoints[1].isRapid;

    const addBatch = (pts, rapid) => {
        if (pts.length < 2) return;
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(geo, rapid ? rapidMat : cutMat);
        toolpathLinesGroup.add(line);
    };

    for (let i = 1; i < endIdx; i++) {
        if (animationPoints[i].isRapid !== currentRapid) {
            addBatch(currentPoints, currentRapid);
            currentPoints = [animationPoints[i - 1].p];
            currentRapid = animationPoints[i].isRapid;
        }
        currentPoints.push(animationPoints[i].p);
    }

    // Interpolate the final partial segment
    const startPt = animationPoints[endIdx - 1].p;
    const endPt = animationPoints[endIdx].p;
    const segStartLen = pathLengths[endIdx - 1];
    const segTotLen = pathLengths[endIdx] - segStartLen;

    let currentPos = endPt; // default to end if math fails

    if (segTotLen > 0) {
        const t = (targetLength - segStartLen) / segTotLen;
        currentPos = new THREE.Vector3().lerpVectors(startPt, endPt, t);
    }

    // Add final segment point
    if (animationPoints[endIdx].isRapid !== currentRapid) {
        addBatch(currentPoints, currentRapid);
        currentPoints = [startPt];
        currentRapid = animationPoints[endIdx].isRapid;
    }
    currentPoints.push(currentPos);
    addBatch(currentPoints, currentRapid);

    // Update Toolhead Position
    if (toolhead) {
        toolhead.visible = true;
        toolhead.position.copy(currentPos);

        // simple rotation effect if cutting
        if (!currentRapid && isPlaying && toolhead.children.length > 0) {
            toolhead.children[0].rotation.y += 0.5;
        }
    }
}
