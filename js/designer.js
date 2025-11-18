/**
 * LikeInk Designer - Custom Tattoo Sheet Designer
 * A5 Landscape with 5mm bleed area
 */

// Physical dimensions
// A5 in landscape: 210mm × 148mm at 300 DPI
const A5_LONG_SIDE_MM = 210;
const A5_SHORT_SIDE_MM = 148;
const BLEED_MM = 5;
const MM_TO_PIXELS = 300 / 25.4; // 300 DPI conversion

// const canvas.width = Math.round(A5_LONG_SIDE_MM * MM_TO_PIXELS); // 2480 pixels
// const canvas.height = Math.round(A5_SHORT_SIDE_MM * MM_TO_PIXELS); // 1748 pixels
const BLEED_PIXELS = Math.round(BLEED_MM * MM_TO_PIXELS); // ~59 pixels
const BLEED_OPACITY = 0.95; // Opacity for bleed overlays
const DUPLICATION_OFFSET = 50; // Offset in pixels when duplicating objects

// Canvas default dimensions at 300 DPI
let canvas;
let bleedRect;
let bleedOverlays = [];
let imageUploadCount = 0; // Counter to offset new uploads

// Upload dialog state
let uploadDialog;
let currentImageData = null; // Store current image data for the dialog
let currentImageFile = null; // Store current file

// Undo/Redo history management
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 20; // Maximum number of states to keep
let isRestoring = false; // Flag to prevent saving state during restore
let saveStateTimeout = null; // Debounce timeout for saveState

/**
 * Check if an object is a bleed-related object
 */
function isBleedObject(obj) {
    return obj && (obj.name === 'bleedOverlay' || obj.name === 'bleedArea');
}

/**
 * Get all user objects (excluding bleed overlays)
 */
function getUserObjects() {
    return canvas.getObjects().filter(obj => !isBleedObject(obj));
}

/**
 * Scale canvas size and zoom level based on current container width and window orientation
 */
function scaleCanvas() {
    const canvasWrapper = document.querySelector('.canvas-wrapper');
    if (!canvasWrapper || !canvas) return;

    const containerWidth = canvasWrapper.clientWidth;

    // Account for padding and rulers (roughly 30px for ruler + paddings)
    const computedStyle = window.getComputedStyle(canvasWrapper);
    const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
    const paddingRight = parseFloat(computedStyle.paddingRight) || 0;
    const rulerWidth = 30 + 5; // Approximate ruler width is 30 px + 5px margin
    const availableWidth = containerWidth - paddingLeft - paddingRight - rulerWidth;

    // Calculate virtual canvas size in mm and pixels (A5 size)
    const isWindowLandscape = window.innerWidth > window.innerHeight;
    const canvas_virtual_width_mm = isWindowLandscape ? A5_LONG_SIDE_MM : A5_SHORT_SIDE_MM;
    const canvas_virtual_height_mm = isWindowLandscape ? A5_SHORT_SIDE_MM : A5_LONG_SIDE_MM;
    const canvas_virtual_width_px = canvas_virtual_width_mm * MM_TO_PIXELS;
    const canvas_virtual_height_px = canvas_virtual_height_mm * MM_TO_PIXELS;

    // Calculate scale based on available width
    let canvasScale = availableWidth / canvas_virtual_width_px;
    canvasScale = Math.max(0.18, Math.min(1.0, canvasScale)); // Clamp between 20% and 100%

    // Update canvas dimensions
    const newWidth = Math.round(canvas_virtual_width_px * canvasScale);
    const newHeight = Math.round(canvas_virtual_height_px * canvasScale);

    // if size has not changed significantly, skip
    if (Math.abs(canvas.width - newWidth) < 10 && Math.abs(canvas.height - newHeight) < 10) {
        return;
    }

    canvas.setDimensions({ width: newWidth, height: newHeight });
    canvas.setZoom(canvasScale);

    // Recreate rulers
    createRulers();

    // Recreate bleed area 
    createBleedArea();

    canvas.renderAll();

    console.log(`Canvas scaled to: ${newWidth}x${newHeight} pixels at ${Math.round(canvasScale * 100)}%`);
}

/**
 * Initialize the Fabric.js canvas
 */
function initCanvas() {

    // Begin by initializing canvas full size landscape mode
    canvas = new fabric.Canvas('designer-canvas', {
        width: Math.round(A5_LONG_SIDE_MM * MM_TO_PIXELS),
        height: Math.round(A5_SHORT_SIDE_MM * MM_TO_PIXELS),
        backgroundColor: '#ffffff',
        preserveObjectStacking: true
    });

    // Then scale it to fit the container
    scaleCanvas();

    // Setup event listeners
    setupEventListeners();

    // Update toolbar state on selection
    canvas.on('selection:created', updateToolbarState);
    canvas.on('selection:updated', updateToolbarState);
    canvas.on('selection:cleared', updateToolbarState);

    // Keep bleed overlays on top when objects are added or moved
    canvas.on('object:added', bringBleedAreasToFront);
    canvas.on('object:modified', bringBleedAreasToFront);

    // Track changes for undo/redo
    canvas.on('object:added', saveState);
    canvas.on('object:modified', saveState);
    canvas.on('object:removed', saveState);

    // Save initial state
    saveState();
}

/**
 * Creates objects for bleed area guide (red dashed rectangle) and overlay for bleed zones.
 * Removes any existing bleed area objects before creating new ones.
 */
function createBleedArea() {
    // Remove old bleed areas first
    if (bleedOverlays && bleedOverlays.length > 0) {
        bleedOverlays.forEach(overlay => {
            if (canvas.contains(overlay)) {
                canvas.remove(overlay);
            }
        });
    }
    if (bleedRect && canvas.contains(bleedRect)) {
        canvas.remove(bleedRect);
    }
    bleedOverlays = [];
    bleedRect = null;
    canvas.renderAll(); // Force render to actually remove old areas

    // Create semi-transparent white overlays for the bleed areas (areas that will be trimmed)
    // Top bleed overlay
    const topOverlay = new fabric.Rect({
        left: 0,
        top: 0,
        width: canvas.width / canvas.getZoom(),
        height: BLEED_PIXELS,
        fill: 'white',
        opacity: BLEED_OPACITY,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    });

    // Bottom bleed overlay
    const bottomOverlay = new fabric.Rect({
        left: 0,
        top: (canvas.height / canvas.getZoom()) - BLEED_PIXELS,
        width: canvas.width / canvas.getZoom(),
        height: BLEED_PIXELS,
        fill: 'white',
        opacity: BLEED_OPACITY,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    });

    // Left bleed overlay
    const leftOverlay = new fabric.Rect({
        left: 0,
        top: BLEED_PIXELS,
        width: BLEED_PIXELS,
        height: (canvas.height / canvas.getZoom()) - (BLEED_PIXELS * 2),
        fill: 'white',
        opacity: BLEED_OPACITY,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    });

    // Right bleed overlay
    const rightOverlay = new fabric.Rect({
        left: (canvas.width / canvas.getZoom()) - BLEED_PIXELS,
        top: BLEED_PIXELS,
        width: BLEED_PIXELS,
        height: (canvas.height / canvas.getZoom()) - (BLEED_PIXELS * 2),
        fill: 'white',
        opacity: BLEED_OPACITY,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    });

    // Red dashed line showing the safe area boundary
    bleedRect = new fabric.Rect({
        left: BLEED_PIXELS,
        top: BLEED_PIXELS,
        width: (canvas.width / canvas.getZoom()) - (BLEED_PIXELS * 2),
        height: (canvas.height / canvas.getZoom()) - (BLEED_PIXELS * 2),
        fill: 'transparent',
        stroke: '#dc3545',
        strokeWidth: 3 / canvas.getZoom(), // Scale stroke width
        strokeDashArray: [10 / canvas.getZoom(), 5 / canvas.getZoom()], // Scale dash array
        selectable: false,
        evented: false,
        name: 'bleedArea'
    });

    // Add overlays to array for later reference
    bleedOverlays = [topOverlay, bottomOverlay, leftOverlay, rightOverlay];

    // Add all to canvas
    canvas.add(topOverlay);
    canvas.add(bottomOverlay);
    canvas.add(leftOverlay);
    canvas.add(rightOverlay);
    canvas.add(bleedRect);

    // Keep them on top so bleed areas are always visible
    bringBleedAreasToFront();
}

/**
 * Create rulers showing physical dimensions in mm
 */
function createRulers() {
    const rulerTop = document.getElementById('ruler-top');
    const rulerLeft = document.getElementById('ruler-left');

    if (!rulerTop || !rulerLeft) return;

    // Clear existing ruler marks
    rulerTop.innerHTML = '';
    rulerLeft.innerHTML = '';

    // Set ruler dimensions
    rulerTop.style.width = canvas.width + 'px';
    rulerLeft.style.height = canvas.height + 'px';

    // Create top ruler (horizontal) - every 10mm
    const isWindowLandscape = window.innerWidth > window.innerHeight;
    const canvas_virtual_width_mm = isWindowLandscape ? A5_LONG_SIDE_MM : A5_SHORT_SIDE_MM;
    const canvas_virtual_height_mm = isWindowLandscape ? A5_SHORT_SIDE_MM : A5_LONG_SIDE_MM;

    for (let mm = 0; mm <= canvas_virtual_width_mm; mm += 10) {
        const pixels = mm * MM_TO_PIXELS * canvas.getZoom();
        const tick = document.createElement('div');
        tick.className = 'ruler-tick' + (mm % 50 === 0 ? ' major' : '');
        tick.style.left = pixels + 'px';
        rulerTop.appendChild(tick);

        // Add labels every 50mm
        if (mm % 50 === 0) {
            const label = document.createElement('span');
            label.className = 'ruler-label';
            label.textContent = (mm / 10) + ' cm';
            label.style.left = (pixels - 12) + 'px';
            rulerTop.appendChild(label);
        }
    }

    // Create left ruler (vertical) - every 10mm
    for (let mm = 0; mm <= canvas_virtual_height_mm; mm += 10) {
        const pixels = mm * MM_TO_PIXELS * canvas.getZoom();
        const tick = document.createElement('div');
        tick.className = 'ruler-tick' + (mm % 50 === 0 ? ' major' : '');
        tick.style.top = pixels + 'px';
        rulerLeft.appendChild(tick);

        // Add labels every 50mm
        if (mm % 50 === 0) {
            const label = document.createElement('span');
            label.className = 'ruler-label';
            label.textContent = (mm / 10) + ' cm';
            label.style.top = (pixels - 12) + 'px';
            rulerLeft.appendChild(label);
        }
    }
}

/**
 * Bring bleed area overlays to front
 */
function bringBleedAreasToFront() {
    bleedOverlays.forEach(overlay => {
        if (overlay && canvas.contains(overlay)) {
            canvas.bringToFront(overlay);
        }
    });
    if (bleedRect && canvas.contains(bleedRect)) {
        canvas.bringToFront(bleedRect);
    }
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
    // File upload
    const fileUpload = document.getElementById('file-upload');
    fileUpload.addEventListener('change', handleFileUpload);

    // Toolbar buttons (with optional checks)
    const selectAllBtn = document.getElementById('select-all-btn');
    const deselectBtn = document.getElementById('deselect-btn');
    const duplicateBtn = document.getElementById('duplicate-btn');
    const deleteBtn = document.getElementById('delete-btn');
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    const bringForwardBtn = document.getElementById('bring-forward-btn');
    const sendBackwardBtn = document.getElementById('send-backward-btn');
    const clearBtn = document.getElementById('clear-btn');
    const fillSheetBtn = document.getElementById('fill-sheet-btn');
    const addToCartBtn = document.getElementById('add-to-cart-btn');

    if (selectAllBtn) selectAllBtn.addEventListener('click', selectAll);
    if (deselectBtn) deselectBtn.addEventListener('click', deselectAll);
    if (duplicateBtn) duplicateBtn.addEventListener('click', duplicateSelected);
    if (deleteBtn) deleteBtn.addEventListener('click', deleteSelected);
    if (undoBtn) undoBtn.addEventListener('click', undo);
    if (redoBtn) redoBtn.addEventListener('click', redo);
    if (bringForwardBtn) bringForwardBtn.addEventListener('click', bringForward);
    if (sendBackwardBtn) sendBackwardBtn.addEventListener('click', sendBackward);
    if (clearBtn) clearBtn.addEventListener('click', clearCanvas);
    if (fillSheetBtn) fillSheetBtn.addEventListener('click', fillSheet);
    if (addToCartBtn) addToCartBtn.addEventListener('click', exportToPNG);

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboard);

    // Drag and drop on canvas
    const canvasWrapper = document.querySelector('.canvas-wrapper');
    canvasWrapper.addEventListener('dragover', handleDragOver);
    canvasWrapper.addEventListener('drop', handleDrop);

    // Handle window resize for responsive canvas
    let resizeTimeout;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(function () {
            scaleCanvas();
        }, 250);
    });
}

/**
 * Handle file upload from input
 */
function handleFileUpload(e) {
    const files = e.target.files;
    if (files.length === 0) return;

    Array.from(files).forEach(file => {
        if (file.type.match('image.*')) {
            loadImage(file);
        }
    });

    // Reset file input
    e.target.value = '';
}

/**
 * Load image file and add to canvas
 */
function loadImage(file) {
    const reader = new FileReader();

    reader.onerror = function () {
        console.error('Failed to read file:', file.name);
        alert('Failed to load image. Please try again.');
    };

    reader.onload = function (event) {
        fabric.Image.fromURL(event.target.result, function (img) {
            if (!img || !img.width || !img.height) {
                console.error('Invalid image:', file.name);
                alert('Invalid image file. Please try a different file.');
                return;
            }
            // Scale image to fit reasonably on canvas (max 30% of canvas width)
            const maxWidth = canvas.width * 0.3;
            const maxHeight = canvas.height * 0.3;

            if (img.width > maxWidth || img.height > maxHeight) {
                const scale = Math.min(maxWidth / img.width, maxHeight / img.height);
                img.scale(scale);
            }

            // Calculate offset based on upload count to avoid stacking images
            // Start at top-left corner inside bleed area
            // Vertical offset cycles every 10 images, horizontal keeps growing
            const verticalOffset = (imageUploadCount % 10) * 50;
            const horizontalOffset = Math.floor(imageUploadCount / 10) * 100 + (imageUploadCount % 10) * 50;
            imageUploadCount++;

            // Calculate starting position accounting for image size
            // Use top-left origin and add padding from bleed area plus half the scaled image size
            const scaledWidth = img.width * img.scaleX;
            const scaledHeight = img.height * img.scaleY;
            const startX = BLEED_PIXELS + scaledWidth / 2 + 20; // 20px padding from bleed edge
            const startY = BLEED_PIXELS + scaledHeight / 2 + 20;

            // Position the image starting from top-left with offset
            img.set({
                left: startX + horizontalOffset,
                top: startY + verticalOffset,
                originX: 'center',
                originY: 'center'
            });

            // Add to canvas
            canvas.add(img);
            canvas.setActiveObject(img);
            canvas.renderAll();
            updateToolbarState();
        }, {
            crossOrigin: 'anonymous'
        });
    };

    reader.readAsDataURL(file);
}

/**
 * Handle drag over event
 */
function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
}

/**
 * Handle drop event for drag-and-drop upload
 */
function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    Array.from(files).forEach(file => {
        if (file.type.match('image.*')) {
            loadImage(file);
        }
    });
}

/**
 * Duplicate selected object(s)
 */
function duplicateSelected() {
    const activeObject = canvas.getActiveObject();
    if (!activeObject || activeObject === bleedRect) return;

    // Handle multiple selection (ActiveSelection)
    if (activeObject.type === 'activeSelection') {
        const objects = activeObject.getObjects();
        const clonedObjects = [];

        // Clone each object individually
        let completed = 0;
        objects.forEach((obj) => {
            obj.clone((cloned) => {
                // Get the absolute position on canvas (accounting for group transformation)
                const absLeft = obj.left + activeObject.left + activeObject.width / 2;
                const absTop = obj.top + activeObject.top + activeObject.height / 2;

                cloned.set({
                    left: absLeft + DUPLICATION_OFFSET,
                    top: absTop + DUPLICATION_OFFSET
                });
                canvas.add(cloned);
                clonedObjects.push(cloned);
                completed++;

                // When all objects are cloned, select them
                if (completed === objects.length) {
                    canvas.discardActiveObject();
                    const sel = new fabric.ActiveSelection(clonedObjects, {
                        canvas: canvas
                    });
                    canvas.setActiveObject(sel);
                    canvas.requestRenderAll();
                }
            });
        });
    } else {
        // Handle single object
        activeObject.clone((cloned) => {
            cloned.set({
                left: cloned.left + DUPLICATION_OFFSET,
                top: cloned.top + DUPLICATION_OFFSET
            });
            canvas.add(cloned);
            canvas.setActiveObject(cloned);
            canvas.requestRenderAll();
        });
    }
}

/**
 * Delete selected object(s)
 */
function deleteSelected() {
    const activeObject = canvas.getActiveObject();
    if (!activeObject || activeObject === bleedRect) return;

    // Handle multiple selection (ActiveSelection)
    if (activeObject.type === 'activeSelection') {
        const objects = activeObject.getObjects().slice(); // Create a copy of the array
        canvas.discardActiveObject(); // Deselect first

        // Temporarily disable state saving for bulk delete
        isRestoring = true;
        objects.forEach(obj => {
            canvas.remove(obj);
        });
        isRestoring = false;

        // Save as single state
        saveState();
    } else {
        // Handle single object - normal save will trigger
        canvas.remove(activeObject);
    }

    canvas.renderAll();
    updateToolbarState();
}

/**
 * Select all user objects (excluding bleed overlays)
 */
function selectAll() {
    const userObjects = getUserObjects();

    if (userObjects.length === 0) return;

    // Deselect current selection
    canvas.discardActiveObject();

    // Create new selection with all user objects
    const selection = new fabric.ActiveSelection(userObjects, {
        canvas: canvas
    });

    canvas.setActiveObject(selection);
    canvas.requestRenderAll();
    updateToolbarState();
}

/**
 * Deselect all objects
 */
function deselectAll() {
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    updateToolbarState();
}

/**
 * Bring selected object forward
 */
function bringForward() {
    const activeObject = canvas.getActiveObject();
    if (!activeObject || activeObject === bleedRect) return;

    canvas.bringForward(activeObject);
    canvas.renderAll();
}

/**
 * Send selected object backward
 */
function sendBackward() {
    const activeObject = canvas.getActiveObject();
    if (!activeObject || activeObject === bleedRect) return;

    canvas.sendBackwards(activeObject);

    // Ensure bleed areas stay on top
    bringBleedAreasToFront();
    canvas.renderAll();
}

/**
 * Clear all objects from canvas (except bleed area)
 */
function clearCanvas() {
    if (!confirm('Are you sure you want to clear all images?')) return;

    const objects = getUserObjects();

    if (objects.length === 0) return;

    // Temporarily disable state saving for bulk clear
    isRestoring = true;
    objects.forEach(obj => canvas.remove(obj));
    isRestoring = false;

    canvas.renderAll();
    updateToolbarState();
    saveState();
}

/**
 * Fill sheet with as many copies as possible
 */
function fillSheet() {
    const MARGIN_MM = 3;
    const MARGIN_PIXELS = MARGIN_MM * MM_TO_PIXELS;

    // Get all user objects
    const userObjects = getUserObjects();

    if (userObjects.length === 0) {
        alert('Please add some images first!');
        return;
    }

    // Temporarily disable state saving
    isRestoring = true;

    // Work in virtual coordinates (300 DPI, unscaled)
    const virtualWidth = canvas.width / canvas.getZoom();
    const virtualHeight = canvas.height / canvas.getZoom();

    // First, arrange original objects in a grid layout without overlapping
    const startX = BLEED_PIXELS + MARGIN_PIXELS;
    const startY = BLEED_PIXELS + MARGIN_PIXELS;
    const availableWidth = virtualWidth - (BLEED_PIXELS * 2) - (MARGIN_PIXELS * 2);
    const availableHeight = virtualHeight - (BLEED_PIXELS * 2) - (MARGIN_PIXELS * 2);

    let currentX = startX;
    let currentY = startY;
    let rowHeight = 0;

    // Position each original object
    userObjects.forEach((obj, index) => {
        const bounds = obj.getBoundingRect(true);
        const objWidth = bounds.width;
        const objHeight = bounds.height;

        // Check if object fits in current row
        if (currentX > startX && currentX + objWidth > startX + availableWidth) {
            // Move to next row
            currentX = startX;
            currentY += rowHeight + MARGIN_PIXELS;
            rowHeight = 0;
        }

        // Calculate center position for the object
        const centerX = currentX + objWidth / 2;
        const centerY = currentY + objHeight / 2;

        obj.set({
            left: centerX,
            top: centerY
        });
        obj.setCoords();

        // Update position for next object
        currentX += objWidth + MARGIN_PIXELS;
        rowHeight = Math.max(rowHeight, objHeight);
    });

    // Calculate bounding box of the arranged objects
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    userObjects.forEach(obj => {
        const bounds = obj.getBoundingRect(true);
        minX = Math.min(minX, bounds.left);
        minY = Math.min(minY, bounds.top);
        maxX = Math.max(maxX, bounds.left + bounds.width);
        maxY = Math.max(maxY, bounds.top + bounds.height);
    });

    const groupWidth = maxX - minX;
    const groupHeight = maxY - minY;

    // Calculate how many copies of the entire group fit
    const stepX = groupWidth + MARGIN_PIXELS;
    const stepY = groupHeight + MARGIN_PIXELS;
    const copiesX = Math.floor(availableWidth / stepX);
    const copiesY = Math.floor(availableHeight / stepY);

    if (copiesX < 1 || copiesY < 1) {
        isRestoring = false;
        alert('Design is too large to fit multiple copies!');
        canvas.renderAll();
        return;
    }

    // Create copies of the entire group
    const allCopies = [];

    for (let row = 0; row < copiesY; row++) {
        for (let col = 0; col < copiesX; col++) {
            // Skip the first position (0,0) as original objects are already there
            if (row === 0 && col === 0) continue;

            // Calculate offset for this grid cell
            const cellOffsetX = col * stepX;
            const cellOffsetY = row * stepY;

            // Clone each object in the group
            userObjects.forEach(obj => {
                obj.clone(cloned => {
                    // Position clone based on the original position plus cell offset
                    cloned.set({
                        left: obj.left + cellOffsetX,
                        top: obj.top + cellOffsetY
                    });

                    canvas.add(cloned);
                    allCopies.push(cloned);
                });
            });
        }
    }

    // Ensure bleed areas stay on top and save state once
    setTimeout(() => {
        bringBleedAreasToFront();
        canvas.renderAll();

        // Re-enable state saving and save the entire fill operation as one state
        isRestoring = false;
        saveState();
    }, 100);
}

/**
 * Export canvas to PNG (excluding bleed overlays)
 */
function exportToPNG() {
    if (!canvas) return;

    // Temporarily set bleed overlays opacity to 1 to hide whats behind them 
    bleedOverlays.forEach(overlay => {
        if (overlay) overlay.set('opacity', 1);
    });
    // Ensure bleed rectangle is not visible though
    if (bleedRect) bleedRect.set('opacity', 0);

    // Mirror the canvas horizontally
    canvas.getObjects().forEach(obj => {
        if (obj.name !== 'bleedOverlay' && obj.name !== 'bleedArea') {
            obj.set('flipX', !obj.flipX);
        }
    });

    canvas.renderAll();

    // Export canvas as PNG at full resolution (300 DPI)
    const dataURL = canvas.toDataURL({
        format: 'png',
        quality: 1,
        multiplier: 1 / canvas.getZoom() // Scale back to original 300 DPI resolution
    });

    // Restore objects to original state (un-mirror)
    canvas.getObjects().forEach(obj => {
        if (obj.name !== 'bleedOverlay' && obj.name !== 'bleedArea') {
            obj.set('flipX', !obj.flipX);
        }
    });

    // Restore bleed overlays
    bleedOverlays.forEach(overlay => {
        if (overlay) overlay.set('opacity', BLEED_OPACITY);
    });
    if (bleedRect) bleedRect.set('opacity', 1);
    canvas.renderAll();

    // Create download link
    const link = document.createElement('a');
    link.download = `tattoo-design-${Date.now()}.png`;
    link.href = dataURL;
    link.click();
}

/**
 * Save current canvas state for undo/redo
 */
function saveState() {
    // Don't save state during restoration or if canvas not ready
    if (isRestoring || !canvas) return;

    // Debounce to avoid excessive state saves during rapid changes
    clearTimeout(saveStateTimeout);
    saveStateTimeout = setTimeout(() => {
        saveStateImmediate();
    }, 100);
}

/**
 * Immediately save the current state (internal use)
 */
function saveStateImmediate() {
    if (isRestoring || !canvas) return;

    // Filter out bleed overlays before saving
    const objectsToSave = getUserObjects();

    // Create a temporary canvas state with only user objects
    const stateData = {
        version: canvas.version,
        objects: objectsToSave.map(obj => obj.toJSON(['name']))
    };
    const state = JSON.stringify(stateData);

    // Only save if state has changed
    if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== state) {
        undoStack.push(state);

        // Limit history size
        if (undoStack.length > MAX_HISTORY) {
            undoStack.shift(); // Remove oldest state
        }

        // Clear redo stack when new action is performed
        redoStack = [];

        updateUndoRedoButtons();
    }
}

/**
 * Restore canvas state
 */
function restoreState(state) {
    isRestoring = true;

    // Remove only user objects (keep bleed overlays)
    const userObjects = getUserObjects();
    userObjects.forEach(obj => canvas.remove(obj));

    // Load the saved state (which contains only user objects)
    canvas.loadFromJSON(state, function () {
        // Ensure bleed overlays stay on top
        bringBleedAreasToFront();

        canvas.requestRenderAll();
        isRestoring = false;
        updateToolbarState();
        updateUndoRedoButtons();
    });
}

/**
 * Undo last action
 */
function undo() {
    if (undoStack.length <= 1) return; // Need at least 2 states (current + previous)

    // Move current state to redo stack
    const currentState = undoStack.pop();
    redoStack.push(currentState);

    // Restore previous state
    const previousState = undoStack[undoStack.length - 1];
    restoreState(previousState);
}

/**
 * Redo last undone action
 */
function redo() {
    if (redoStack.length === 0) return;

    // Get state from redo stack
    const state = redoStack.pop();
    undoStack.push(state);

    // Restore it
    restoreState(state);
}

/**
 * Update undo/redo button states
 */
function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');

    if (undoBtn) undoBtn.disabled = undoStack.length <= 1;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

/**
 * Update toolbar button states based on selection
 */
function updateToolbarState() {
    const activeObject = canvas.getActiveObject();
    const hasSelection = activeObject && activeObject !== bleedRect;

    const deselectBtn = document.getElementById('deselect-btn');
    const duplicateBtn = document.getElementById('duplicate-btn');
    const deleteBtn = document.getElementById('delete-btn');
    const bringForwardBtn = document.getElementById('bring-forward-btn');
    const sendBackwardBtn = document.getElementById('send-backward-btn');

    if (deselectBtn) deselectBtn.disabled = !hasSelection;
    if (duplicateBtn) duplicateBtn.disabled = !hasSelection;
    if (deleteBtn) deleteBtn.disabled = !hasSelection;
    if (bringForwardBtn) bringForwardBtn.disabled = !hasSelection;
    if (sendBackwardBtn) sendBackwardBtn.disabled = !hasSelection;
}

/**
 * Handle keyboard shortcuts
 */
function handleKeyboard(e) {
    // Deselect with ESC
    if (e.key === 'Escape') {
        e.preventDefault();
        deselectAll();
    }

    // Delete key
    if (e.key === 'Delete' || e.key === 'Backspace') {
        const activeElement = document.activeElement;
        // Only delete if not typing in an input
        if (activeElement.tagName !== 'INPUT' && activeElement.tagName !== 'TEXTAREA') {
            e.preventDefault();
            deleteSelected();
        }
    }

    // Select All with Ctrl/Cmd + A
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        selectAll();
    }

    // Undo with Ctrl/Cmd + Z
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
    }

    // Redo with Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        e.preventDefault();
        redo();
    }

    // Duplicate with Ctrl/Cmd + D
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        duplicateSelected();
    }

    // Clear with Ctrl/Cmd + Shift + C
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'c') {
        e.preventDefault();
        clearCanvas();
    }
}

/**
 * Initialize everything when DOM is ready
 */
document.addEventListener('DOMContentLoaded', function () {
    console.log('LikeInk Designer initializing');
    initCanvas();
    initUploadDialog();
    
    // Show upload dialog after canvas is ready
    setTimeout(() => {
        showUploadDialog();
    }, 500);

    // Handle window resize for responsive canvas
    let resizeTimeout;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(function () {
            scaleCanvas();
        }, 250);
    });
});

/* ============================================
   UPLOAD DIALOG FUNCTIONS
   ============================================ */

/**
 * Initialize the upload dialog
 */
function initUploadDialog() {
    uploadDialog = document.getElementById('upload-dialog');
    const uploadZone = document.getElementById('upload-zone');
    const dialogFileUpload = document.getElementById('dialog-file-upload');
    const sizeSlider = document.getElementById('size-slider');
    const sizeValue = document.getElementById('size-value');
    const fillSheetDialogBtn = document.getElementById('fill-sheet-dialog-btn');
    const addMoreBtn = document.getElementById('add-more-btn');
    
    // Click to upload
    uploadZone.addEventListener('click', () => {
        dialogFileUpload.click();
    });
    
    // File selection
    dialogFileUpload.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleDialogFileSelect(e.target.files[0]);
        }
    });
    
    // Drag and drop on upload zone
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadZone.classList.add('drag-over');
    });
    
    uploadZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadZone.classList.remove('drag-over');
    });
    
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadZone.classList.remove('drag-over');
        
        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.type.match('image.*')) {
                handleDialogFileSelect(file);
            }
        }
    });
    
    // Size slider
    sizeSlider.addEventListener('input', (e) => {
        const value = e.target.value;
        sizeValue.textContent = parseFloat(value).toFixed(1);
    });
    
    // Update slider range based on orientation
    updateSliderRange();
    
    // Fill sheet button
    fillSheetDialogBtn.addEventListener('click', () => {
        addImageFromDialog(true); // true = fill sheet
    });
    
    // Add more button
    addMoreBtn.addEventListener('click', () => {
        addImageFromDialog(false); // false = just add one
    });
}

/**
 * Update slider range based on current canvas orientation
 */
function updateSliderRange() {
    const sizeSlider = document.getElementById('size-slider');
    const isWindowLandscape = window.innerWidth > window.innerHeight;
    
    // Max width in cm: 21cm for landscape, 15cm for portrait
    const maxCm = isWindowLandscape ? 21 : 15;
    const minCm = 1;
    
    sizeSlider.min = minCm;
    sizeSlider.max = maxCm;
    sizeSlider.step = 0.5;
    
    // Set default to middle value
    const defaultValue = ((minCm + maxCm) / 3).toFixed(1);
    sizeSlider.value = defaultValue;
    document.getElementById('size-value').textContent = defaultValue;
}

/**
 * Handle file selection in dialog
 */
function handleDialogFileSelect(file) {
    if (!file.type.match('image.*')) {
        alert('Please select an image file.');
        return;
    }
    
    currentImageFile = file;
    const reader = new FileReader();
    
    reader.onerror = function () {
        console.error('Failed to read file:', file.name);
        alert('Failed to load image. Please try again.');
    };
    
    reader.onload = function (event) {
        currentImageData = event.target.result;
        showPreview(event.target.result);
    };
    
    reader.readAsDataURL(file);
}

/**
 * Show image preview in dialog
 */
function showPreview(imageData) {
    const uploadZone = document.getElementById('upload-zone');
    const previewSection = document.getElementById('preview-section');
    const previewImage = document.getElementById('preview-image');
    
    previewImage.src = imageData;
    uploadZone.style.display = 'none';
    previewSection.style.display = 'block';
}

/**
 * Add image from dialog to canvas
 */
function addImageFromDialog(shouldFillSheet = false) {
    if (!currentImageData) return;
    
    const sizeSlider = document.getElementById('size-slider');
    const targetWidthCm = parseFloat(sizeSlider.value); // Get value in cm
    const targetWidthMm = targetWidthCm * 10; // Convert cm to mm
    const targetWidthPx = targetWidthMm * MM_TO_PIXELS; // Convert mm to pixels at 300 DPI
    
    fabric.Image.fromURL(currentImageData, function (img) {
        if (!img || !img.width || !img.height) {
            alert('Invalid image file. Please try a different file.');
            return;
        }
        
        // Scale image to target width in virtual space (300 DPI)
        const scale = targetWidthPx / img.width;
        img.scale(scale);
        
        // Position at center of canvas in virtual coordinates
        const virtualWidth = canvas.width / canvas.getZoom();
        const virtualHeight = canvas.height / canvas.getZoom();
        const safeAreaCenterX = virtualWidth / 2;
        const safeAreaCenterY = virtualHeight / 2;
        
        img.set({
            left: safeAreaCenterX,
            top: safeAreaCenterY,
            originX: 'center',
            originY: 'center'
        });
        
        // Add to canvas
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.renderAll();
        updateToolbarState();
        
        if (shouldFillSheet) {
            // Hide dialog first
            hideUploadDialog();
            
            // Fill sheet after a brief delay to let the image be added
            setTimeout(() => {
                fillSheet();
            }, 100);
        } else {
            // Reset dialog for next image
            resetDialogForNextImage();
        }
    }, {
        crossOrigin: 'anonymous'
    });
}

/**
 * Reset dialog for adding another image
 */
function resetDialogForNextImage() {
    const uploadZone = document.getElementById('upload-zone');
    const previewSection = document.getElementById('preview-section');
    const dialogFileUpload = document.getElementById('dialog-file-upload');
    
    // Reset state
    currentImageData = null;
    currentImageFile = null;
    dialogFileUpload.value = '';
    
    // Reset UI
    uploadZone.style.display = 'block';
    previewSection.style.display = 'none';
    
    // Update slider range in case orientation changed
    updateSliderRange();
}

/**
 * Show upload dialog
 */
function showUploadDialog() {
    if (uploadDialog) {
        uploadDialog.classList.add('show');
        resetDialogForNextImage();
    }
}

/**
 * Hide upload dialog
 */
function hideUploadDialog() {
    if (uploadDialog) {
        uploadDialog.classList.remove('show');
    }
}