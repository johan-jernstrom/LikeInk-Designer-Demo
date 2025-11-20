/**
 * LikeInk Designer - Custom Tattoo Sheet Designer
 * A5 sheet with 5mm bleed area
 */

// Physical dimensions
// A5 sheet: 210mm × 148mm at 300 DPI
const A5_LONG_SIDE_MM = 210;
const A5_SHORT_SIDE_MM = 148;
const BLEED_MM = 5;
const MM_TO_PIXELS = 300 / 25.4; // 300 DPI conversion

// const canvas.width = Math.round(A5_LONG_SIDE_MM * MM_TO_PIXELS); // 2480 pixels
// const canvas.height = Math.round(A5_SHORT_SIDE_MM * MM_TO_PIXELS); // 1748 pixels
const BLEED_PIXELS = Math.round(BLEED_MM * MM_TO_PIXELS); // ~59 pixels
const BLEED_OPACITY = 0.95; // Opacity for bleed overlays
const DUPLICATION_OFFSET = 50; // Offset in pixels when duplicating objects
const PLACEMENT_PADDING = 20; // Extra padding inside bleed edge for auto-placement
const PLACEMENT_GUTTER = 12; // Minimum gap to keep between placed objects
const SVG_API_BASE_URL = 'https://api.svgapi.com/v1';
const SVG_API_DOMAIN_KEY = window.svgApiDomainKey || 'Ty5WcDa63E'; // Public demo key
const SYMBOLS_PAGE_SIZE = 18; // SVG API limit is 20

// Canvas default dimensions at 300 DPI
let canvas;
let bleedOverlays = [];
let textMeasurementHelper = null; // Reused Fabric text instance for measurements
let lastOrientationIsLandscape = null; // Track orientation to trigger reflow on change

// Upload dialog state
let uploadDialog;
let currentImageData = null; // Store current image data for the dialog
let currentImageFile = null; // Store current file
let activeDialogMode = 'image';

// Symbols tab state
const symbolUI = {
    searchInput: null,
    searchButton: null,
    loading: null,
    resultsGrid: null,
    emptyState: null,
    pagination: null,
    prevButton: null,
    nextButton: null,
    pageInfo: null,
    selectionPanel: null,
    preview: null,
    title: null,
    tags: null,
    addButton: null,
    fillButton: null,
    domainWarning: null
};

let symbolSearchState = {
    query: '',
    start: 0,
    limit: SYMBOLS_PAGE_SIZE,
    prevStack: [],
    nextStart: null,
    total: null,
    results: [],
    selectedIndex: null
};
let symbolSearchController = null;

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
    const orientationChanged = lastOrientationIsLandscape !== null && lastOrientationIsLandscape !== isWindowLandscape;
    lastOrientationIsLandscape = isWindowLandscape;
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
    const sizeChanged = Math.abs(canvas.width - newWidth) >= 10 || Math.abs(canvas.height - newHeight) >= 10;

    if (!sizeChanged && !orientationChanged) {
        return;
    }

    if (sizeChanged) {
        canvas.setDimensions({ width: newWidth, height: newHeight });
    }
    canvas.setZoom(canvasScale);

    // Recreate rulers
    createRulers();

    // Recreate bleed area 
    createBleedArea();

    canvas.renderAll();

    console.log(`Canvas scaled to: ${newWidth}x${newHeight} pixels at ${Math.round(canvasScale * 100)}%`);

    if (orientationChanged) {
        console.log('Orientation changed, reflowing objects into safe area.');
        reflowObjectsIntoSafeArea();
    }
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
    canvas.on('object:added', bringBleedObjectsToFront);
    canvas.on('object:modified', bringBleedObjectsToFront);

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
    canvas.getObjects()
        .filter(obj => isBleedObject(obj))
        .forEach(obj => {
            canvas.remove(obj);
        });
    bleedOverlays = [];

    // Create semi-transparent white overlays for the bleed areas (areas that will be trimmed)
    // Top bleed overlay
    canvas.add(new fabric.Rect({
        left: 0,
        top: 0,
        width: canvas.width / canvas.getZoom(),
        height: BLEED_PIXELS,
        fill: 'white',
        opacity: BLEED_OPACITY,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    }));

    // Bottom bleed overlay
    canvas.add(new fabric.Rect({
        left: 0,
        top: (canvas.height / canvas.getZoom()) - BLEED_PIXELS,
        width: canvas.width / canvas.getZoom(),
        height: BLEED_PIXELS,
        fill: 'white',
        opacity: BLEED_OPACITY,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    }));

    // Left bleed overlay
    canvas.add(new fabric.Rect({
        left: 0,
        top: BLEED_PIXELS,
        width: BLEED_PIXELS,
        height: (canvas.height / canvas.getZoom()) - (BLEED_PIXELS * 2),
        fill: 'white',
        opacity: BLEED_OPACITY,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    }));

    // Right bleed overlay
    canvas.add(new fabric.Rect({
        left: (canvas.width / canvas.getZoom()) - BLEED_PIXELS,
        top: BLEED_PIXELS,
        width: BLEED_PIXELS,
        height: (canvas.height / canvas.getZoom()) - (BLEED_PIXELS * 2),
        fill: 'white',
        opacity: BLEED_OPACITY,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    }));

    // Red dashed line showing the safe area boundary
    canvas.add(new fabric.Rect({
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
    }));

    // Keep them on top so bleed areas are always visible
    bringBleedObjectsToFront();
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
function bringBleedObjectsToFront() {
    if (isRestoring) return;

    canvas.getObjects()
        .filter(obj => isBleedObject(obj))
        .forEach(obj => {
            canvas.bringObjectToFront(obj);
        });
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
 * Common helper to process lists of image files
 */
function processImageFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    Array.from(fileList).forEach(file => {
        if (file.type && file.type.match('image.*')) {
            loadImage(file);
        }
    });
}

/**
 * Handle file upload from input
 */
function handleFileUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    processImageFiles(files);

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
        fabric.Image.fromURL(event.target.result)
            .then(function (img) {
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

                // Add to canvas
                canvas.add(img);
                arrangeObjectOnCanvas(img);

                canvas.setActiveObject(img);
                canvas.renderAll();
                updateToolbarState();
            }, {
                crossOrigin: 'anonymous'
            });
    };

    reader.readAsDataURL(file);
}

/** Arrange newly added object on canvas to avoid overlapping existing objects
 * Aims to place the object within the safe area (inside bleed edges) while avoiding overlaps
 * similar to a simple bin-packing algorithm. Prioritizes top-left placement.
 * @param {fabric.Object} objToArrange - The Fabric.js object to arrange on canvas
*/
function arrangeObjectOnCanvas(objToArrange) {
    if (!canvas || !objToArrange) return false;

    const zoom = canvas.getZoom() || 1;
    const virtualWidth = canvas.width / zoom;
    const virtualHeight = canvas.height / zoom;

    const safeRect = {
        left: BLEED_PIXELS + PLACEMENT_PADDING,
        top: BLEED_PIXELS + PLACEMENT_PADDING,
        right: virtualWidth - BLEED_PIXELS - PLACEMENT_PADDING,
        bottom: virtualHeight - BLEED_PIXELS - PLACEMENT_PADDING
    };

    // If safe area is invalid, place at center of canvas and return early
    if (safeRect.right <= safeRect.left || safeRect.bottom <= safeRect.top) {
        objToArrange.set({ left: virtualWidth / 2, top: virtualHeight / 2, originX: 'center', originY: 'center' });
        objToArrange.setCoords();
        return false;
    }

    const targetWidth = objToArrange.getScaledWidth();
    const targetHeight = objToArrange.getScaledHeight();

    // Start with the entire safe area as available space
    let freeRects = [safeRect];

    // Subtract existing objects from freeRects to find available spaces
    const blockers = getUserObjects().filter(obj => obj !== objToArrange);
    blockers.forEach(obj => {
        const bounds = obj.getBoundingRect();
        const blocker = {
            left: bounds.left - PLACEMENT_GUTTER,
            top: bounds.top - PLACEMENT_GUTTER,
            right: bounds.left + bounds.width + PLACEMENT_GUTTER,
            bottom: bounds.top + bounds.height + PLACEMENT_GUTTER
        };

        // Clamp blocker to fit within safe area
        const clampedBlocker = clampRect(blocker, safeRect);
        if (clampedBlocker) {
            // Subtract the clamped blocker from freeRects to update available spaces
            freeRects = freeRects.flatMap(rect => subtractRect(rect, clampedBlocker));
        }
    });

    // Prune any contained rectangles to optimize free space list
    freeRects = pruneContainedRects(freeRects);

    // Sort free rectangles by their top-left position to prioritize placement
    freeRects.sort((a, b) => (a.top - b.top) || (a.left - b.left));

    // Find the first free rectangle that can fit the image
    const placementRect = freeRects.find(rect => {
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        return width >= targetWidth && height >= targetHeight;
    });

    // Place the image in the found free rectangle (if any)
    if (placementRect) {
        objToArrange.set({
            left: placementRect.left + targetWidth / 2,
            top: placementRect.top + targetHeight / 2,
            originX: 'center',
            originY: 'center'
        });
        objToArrange.setCoords();
        return true;
    }

    // Fallback: place at center of safe area if no slot available
    objToArrange.set({
        left: (safeRect.left + safeRect.right) / 2,
        top: (safeRect.top + safeRect.bottom) / 2,
        originX: 'center',
        originY: 'center'
    });
    objToArrange.setCoords();
    return false;

    // Helper to clamp a rectangle within bounds
    function clampRect(rect, bounds) {
        const clampedRect = {
            left: Math.max(rect.left, bounds.left),
            top: Math.max(rect.top, bounds.top),
            right: Math.min(rect.right, bounds.right),
            bottom: Math.min(rect.bottom, bounds.bottom)
        };

        if (clampedRect.left >= clampedRect.right || clampedRect.top >= clampedRect.bottom) {
            return null;
        }
        return clampedRect;
    }

    // Subtract blockerRect from freeRect, returning array of resulting rectangles, example:
    // freeRect: {left:0, top:0, right:100, bottom:100}
    // blockerRect: {left:30, top:30, right:70, bottom:70}
    // returns: [
    //   {left:0, top:0, right:100, bottom:30},    // Top
    //   {left:0, top:30, right:30, bottom:70},    // Left
    //   {left:70, top:30, right:100, bottom:70},  // Right
    //   {left:0, top:70, right:100, bottom:100}   // Bottom
    // ]
    function subtractRect(freeRect, blockerRect) {
        const intersection = {
            left: Math.max(freeRect.left, blockerRect.left),
            top: Math.max(freeRect.top, blockerRect.top),
            right: Math.min(freeRect.right, blockerRect.right),
            bottom: Math.min(freeRect.bottom, blockerRect.bottom)
        };

        if (intersection.left >= intersection.right || intersection.top >= intersection.bottom) {
            return [freeRect];
        }

        const result = [];

        // Space above the blocker
        if (freeRect.top < intersection.top) {
            result.push({ left: freeRect.left, top: freeRect.top, right: freeRect.right, bottom: intersection.top });
        }

        // Space below the blocker
        if (intersection.bottom < freeRect.bottom) {
            result.push({ left: freeRect.left, top: intersection.bottom, right: freeRect.right, bottom: freeRect.bottom });
        }

        const middleTop = Math.max(freeRect.top, intersection.top);
        const middleBottom = Math.min(freeRect.bottom, intersection.bottom);

        if (middleBottom > middleTop) {
            // Space to the left of the blocker
            if (freeRect.left < intersection.left) {
                result.push({ left: freeRect.left, top: middleTop, right: intersection.left, bottom: middleBottom });
            }

            // Space to the right of the blocker
            if (intersection.right < freeRect.right) {
                result.push({ left: intersection.right, top: middleTop, right: freeRect.right, bottom: middleBottom });
            }
        }

        return result.filter(rect => rect.right - rect.left > 1 && rect.bottom - rect.top > 1);
    }

    // Remove rectangles that are fully contained within others
    function pruneContainedRects(rects) {
        return rects.filter((rect, index) => {
            return !rects.some((other, otherIdx) => {
                if (index === otherIdx) return false;
                return other.left <= rect.left && other.top <= rect.top &&
                    other.right >= rect.right && other.bottom >= rect.bottom;
            });
        });
    }
}

/**
 * Reflow any objects that fall outside the safe area after an orientation change.
 * Uses arrangeImageOnCanvas to find new slots for displaced items.
 */
function reflowObjectsIntoSafeArea() {
    if (!canvas) return;

    const zoom = canvas.getZoom() || 1;
    const virtualWidth = canvas.width / zoom;
    const virtualHeight = canvas.height / zoom;

    const safeRect = {
        left: BLEED_PIXELS + PLACEMENT_PADDING,
        top: BLEED_PIXELS + PLACEMENT_PADDING,
        right: virtualWidth - BLEED_PIXELS - PLACEMENT_PADDING,
        bottom: virtualHeight - BLEED_PIXELS - PLACEMENT_PADDING
    };

    if (safeRect.right <= safeRect.left || safeRect.bottom <= safeRect.top) {
        return;
    }

    const outOfBoundsObjects = getUserObjects().filter(obj => {
        const bounds = obj.getBoundingRect(true);
        return bounds.left < safeRect.left ||
            bounds.top < safeRect.top ||
            (bounds.left + bounds.width) > safeRect.right ||
            (bounds.top + bounds.height) > safeRect.bottom;
    });

    if (outOfBoundsObjects.length === 0) {
        return;
    }

    const previousRestoringState = isRestoring;
    isRestoring = true;

    outOfBoundsObjects.forEach(obj => canvas.remove(obj));

    const failedRepositions = [];
    outOfBoundsObjects.forEach(obj => {
        canvas.add(obj);
        const placed = arrangeObjectOnCanvas(obj);
        if (!placed) {
            failedRepositions.push(obj);
        }
    });

    canvas.requestRenderAll();
    bringBleedObjectsToFront();

    isRestoring = previousRestoringState;
    if (!previousRestoringState) {
        saveState();
    }
    console.log(`Reflowed ${outOfBoundsObjects.length} object(s) into safe area after orientation change.`);
    if (failedRepositions.length > 0) {
        console.warn(`${failedRepositions.length} object(s) could not be repositioned within the safe area.`);
    }
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
    if (!files || files.length === 0) return;

    processImageFiles(files);
}

/**
 * Duplicate selected object(s)
 */
function duplicateSelected() {
    const activeObject = canvas.getActiveObject();
    if (!activeObject || isBleedObject(activeObject)) return;

    // Handle multiple selection (activeselection)
    if (activeObject.type === 'activeselection') {
        const objects = activeObject.getObjects().filter(obj => !isBleedObject(obj));   // Exclude bleed objects even though they shouldn't be selectable
        const clonedObjects = [];

        // Clone each object individually
        let completed = 0;
        objects.forEach((obj) => {
            obj.clone()
                .then((cloned) => {
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
        activeObject.clone()
            .then((cloned) => {
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
    if (!activeObject || isBleedObject(activeObject)) return;

    // Handle multiple selection (activeselection)
    if (activeObject.type === 'activeselection') {
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
    if (!activeObject || isBleedObject(activeObject)) return;

    canvas.bringForward(activeObject);
    canvas.renderAll();
}

/**
 * Send selected object backward
 */
function sendBackward() {
    const activeObject = canvas.getActiveObject();
    if (!activeObject || isBleedObject(activeObject)) return;

    canvas.sendBackwards(activeObject);

    // Ensure bleed areas stay on top
    bringBleedObjectsToFront();
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
 * Fill the sheet by re-arranging existing objects via arrangeImageOnCanvas
 * and then repeatedly cloning those originals until no more clones fit.
 */
async function fillSheet() {
    const userObjects = getUserObjects();

    if (userObjects.length === 0) {
        alert('Please add some images first!');
        return;
    }

    isRestoring = true;
    canvas.discardActiveObject();

    try {
        const originals = [...userObjects];
        originals.forEach(obj => canvas.remove(obj));

        const placedOriginals = [];
        const failedOriginals = [];

        originals.forEach(obj => {
            canvas.add(obj);
            const placed = arrangeObjectOnCanvas(obj);
            if (placed) {
                placedOriginals.push(obj);
            } else {
                failedOriginals.push(obj);
            }
        });

        if (failedOriginals.length > 0) {
            console.warn('Some originals could not be arranged within the safe area.');
        }

        if (placedOriginals.length > 0) {
            let clonesPlacedInPass = 0;
            do {
                clonesPlacedInPass = 0;
                for (const base of placedOriginals) {
                    try {
                        const clone = await base.clone();
                        canvas.add(clone);
                        const placed = arrangeObjectOnCanvas(clone);
                        if (placed) {
                            clonesPlacedInPass++;
                        } else {
                            canvas.remove(clone);
                        }
                    } catch (err) {
                        console.error('Error cloning object during fillSheet:', err);
                    }
                }
            } while (clonesPlacedInPass > 0);
        } else {
            alert('No objects could be arranged within the safe area.');
        }
    } catch (err) {
        console.error('Unexpected error while filling the sheet:', err);
    } finally {
        canvas.requestRenderAll();
        bringBleedObjectsToFront();
        isRestoring = false;
        saveState();
    }
}

/**
 * Export canvas to PNG (excluding bleed overlays)
 */
function exportToPNG() {
    if (!canvas) return;

    // Make bleed overlays fully visible for export to hide overflowing objects
    canvas.getObjects()
        .filter(obj => obj.name === 'bleedOverlay')
        .forEach(overlay => {
            overlay.set('opacity', 1);
        });
    // Hide bleed area rectangle
    canvas.getObjects()
        .filter(obj => obj.name === 'bleedArea')
        .forEach(rect => {
            rect.set('opacity', 0);
        });


    // Mirror the canvas horizontally
    canvas.getObjects().forEach(obj => {
        if (!isBleedObject(obj)) {
            obj.set('flipX', !obj.flipX);
        }
    });

    // Force canvas background to white before export (defensive)
    canvas.backgroundColor = '#ffffff';
    canvas.renderAll();

    // Export canvas as PNG at full resolution (300 DPI)
    const dataURL = canvas.toDataURL({
        format: 'png',
        quality: 1,
        multiplier: 1 / canvas.getZoom(), // Scale back to original 300 DPI resolution
        enableRetinaScaling: false,
        backgroundColor: '#ffffff' // Explicitly set white background
    });

    // Restore objects to original state (un-mirror)
    canvas.getObjects().forEach(obj => {
        if (!isBleedObject(obj)) {
            obj.set('flipX', !obj.flipX);
        }
    });

    // Restore bleed overlays and area visibility
    canvas.getObjects()
        .filter(obj => obj.name === 'bleedOverlay')
        .forEach(overlay => {
            overlay.set('opacity', BLEED_OPACITY);
        });
    canvas.getObjects()
        .filter(obj => obj.name === 'bleedArea')
        .forEach(rect => {
            rect.set('opacity', 1);
        });
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
    }, 250);
}

/**
 * Immediately save the current state (internal use)
 */
function saveStateImmediate() {
    if (isRestoring || !canvas) return;

    // Filter out bleed overlays before saving
    const objectsToSave = getUserObjects();

    // Create a temporary canvas state with only user objects 
    // bleed overlays will be re-added on restore
    const stateData = {
        version: canvas.version,
        objects: objectsToSave.map(obj => obj.toJSON(['name'])),
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

    // Load the saved state 
    // State contains only user objects since the special properties of the bleed areas 
    // (like their name and not being selectable) do not survive JSON serialization well, 
    // so we re-add them after loading (also needed because loadFromJSON replaces all objects)
    canvas.loadFromJSON(state)
        .then((canvas) => {
            createBleedArea();
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
    const hasSelection = activeObject && !isBleedObject(activeObject);

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
        const typingInField = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable);
        if (!typingInField) {
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
    const closeDialogBtn = document.getElementById('close-dialog-btn');
    const openUploadDialogBtn = document.getElementById('open-upload-dialog-btn');

    // Content type switching
    const imageModeBtn = document.getElementById('image-mode-btn');
    const textModeBtn = document.getElementById('text-mode-btn');
    const symbolModeBtn = document.getElementById('symbol-mode-btn');
    const imageSection = document.getElementById('image-section');
    const textSection = document.getElementById('text-section');
    const symbolsSection = document.getElementById('symbols-section');

    // Text mode elements
    const textSizeSlider = document.getElementById('text-size-slider');
    const textSizeValue = document.getElementById('text-size-value');
    const textFontSelect = document.getElementById('text-font-select');
    const fillSheetTextBtn = document.getElementById('fill-sheet-text-btn');
    const addTextBtn = document.getElementById('add-text-btn');

    // Mode switching
    const dialogModes = {
        image: { button: imageModeBtn, section: imageSection },
        text: { button: textModeBtn, section: textSection },
        symbols: { button: symbolModeBtn, section: symbolsSection }
    };

    Object.entries(dialogModes).forEach(([mode, config]) => {
        if (!config.button || !config.section) return;
        config.button.addEventListener('click', () => setDialogMode(mode, dialogModes));
    });

    setDialogMode('image', dialogModes);

    // Text size slider
    if (textSizeSlider && textSizeValue) {
        textSizeSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            textSizeValue.textContent = value;
            updateTextWidth();
        });
    }

    initTextPreviewInput();

    if (textFontSelect) {
        textFontSelect.addEventListener('change', () => {
            updateTextWidth();
        });
    }

    initSymbolsTab();

    // Text buttons
    if (fillSheetTextBtn) {
        fillSheetTextBtn.addEventListener('click', () => {
            addTextFromDialog({ closeDialog: true });
        });
    }

    if (addTextBtn) {
        addTextBtn.addEventListener('click', () => {
            addTextFromDialog();
        });
    }

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
        updateImageSize();
    });

    // Update slider range based on orientation
    updateSliderRange();

    // "No" button closes dialog after adding content
    fillSheetDialogBtn.addEventListener('click', () => {
        addImageFromDialog({ closeDialog: true });
    });

    // "Yes" button keeps dialog open for additional uploads
    addMoreBtn.addEventListener('click', () => {
        addImageFromDialog();
    });

    // Close dialog button
    if (closeDialogBtn) {
        closeDialogBtn.addEventListener('click', () => {
            hideUploadDialog();
        });
    }

    // Click outside dialog to close
    uploadDialog.addEventListener('click', (e) => {
        if (e.target === uploadDialog) {
            hideUploadDialog();
        }
    });

    // Open upload dialog button in toolbar
    if (openUploadDialogBtn) {
        openUploadDialogBtn.addEventListener('click', () => {
            showUploadDialog();
        });
    }

    // ESC key to close dialog
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && uploadDialog && uploadDialog.classList.contains('show')) {
            hideUploadDialog();
        }
    });

    updateTextWidth();
}

function getDialogModeConfig() {
    return {
        image: {
            button: document.getElementById('image-mode-btn'),
            section: document.getElementById('image-section')
        },
        text: {
            button: document.getElementById('text-mode-btn'),
            section: document.getElementById('text-section')
        },
        symbols: {
            button: document.getElementById('symbol-mode-btn'),
            section: document.getElementById('symbols-section')
        }
    };
}

function setDialogMode(mode, configs) {
    const map = configs || getDialogModeConfig();
    Object.entries(map).forEach(([key, config]) => {
        if (!config.button || !config.section) return;
        if (key === mode) {
            config.button.classList.add('active');
            config.section.classList.add('active');
        } else {
            config.button.classList.remove('active');
            config.section.classList.remove('active');
        }
    });
    activeDialogMode = mode;
}

function initSymbolsTab() {
    symbolUI.searchInput = document.getElementById('symbol-search-input');
    symbolUI.searchButton = document.getElementById('symbol-search-btn');
    symbolUI.loading = document.getElementById('symbol-loading');
    symbolUI.resultsGrid = document.getElementById('symbol-results-grid');
    symbolUI.emptyState = document.getElementById('symbol-empty-state');
    symbolUI.pagination = document.getElementById('symbol-pagination');
    symbolUI.prevButton = document.getElementById('symbol-prev-btn');
    symbolUI.nextButton = document.getElementById('symbol-next-btn');
    symbolUI.pageInfo = document.getElementById('symbol-page-info');
    symbolUI.selectionPanel = document.getElementById('symbol-selection-panel');
    symbolUI.preview = document.getElementById('symbol-preview');
    symbolUI.title = document.getElementById('symbol-title');
    symbolUI.tags = document.getElementById('symbol-tags');
    symbolUI.addButton = document.getElementById('add-symbol-btn');
    symbolUI.fillButton = document.getElementById('fill-sheet-symbol-btn');
    symbolUI.domainWarning = document.getElementById('symbol-domain-warning');

    if (!symbolUI.searchInput || !symbolUI.resultsGrid) return;

    if (symbolUI.searchButton) {
        symbolUI.searchButton.addEventListener('click', () => {
            startSymbolSearch();
        });
    }

    symbolUI.searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            startSymbolSearch();
        }
    });

    if (symbolUI.prevButton) {
        symbolUI.prevButton.addEventListener('click', () => {
            handleSymbolPagination('prev');
        });
    }

    if (symbolUI.nextButton) {
        symbolUI.nextButton.addEventListener('click', () => {
            handleSymbolPagination('next');
        });
    }

    symbolUI.resultsGrid.addEventListener('click', (event) => {
        const card = event.target.closest('.symbol-card');
        if (!card) return;
        const index = parseInt(card.dataset.index, 10);
        if (Number.isInteger(index)) {
            selectSymbolResult(index);
        }
    });

    if (symbolUI.addButton) {
        symbolUI.addButton.addEventListener('click', () => {
            addSelectedSymbolToCanvas();
        });
    }

    if (symbolUI.fillButton) {
        symbolUI.fillButton.addEventListener('click', () => {
            addSelectedSymbolToCanvas({ fillSheetAfter: true });
        });
    }

    updateSymbolDomainWarning();
    showSymbolEmptyState('Use the search box to explore thousands of SVG symbols.');
    updateSymbolSelectionPanel();
}

function startSymbolSearch({ start = 0, preserveStack = false } = {}) {
    if (!symbolUI.searchInput) return;
    const query = symbolUI.searchInput.value.trim();
    if (!query) {
        showSymbolEmptyState('Enter a keyword such as "flower", "moon", or "triangle" to search for icons.');
        symbolSearchState.results = [];
        renderSymbolResults(true);
        return;
    }

    if (!hasSymbolApiKey()) {
        updateSymbolDomainWarning(true);
        showSymbolEmptyState('Provide your svgapi.com domain key to enable symbol search.');
        return;
    }

    const sameQuery = query === symbolSearchState.query;
    if (!preserveStack || !sameQuery) {
        symbolSearchState.prevStack = [];
    }

    fetchSymbols(query, start);
}

async function fetchSymbols(query, start) {
    if (!symbolUI.resultsGrid) return;

    symbolSearchState.query = query;
    symbolSearchState.start = start;
    symbolSearchState.selectedIndex = null;
    symbolSearchState.limit = Math.min(SYMBOLS_PAGE_SIZE, 20);

    setSymbolLoading(true);
    showSymbolEmptyState('');
    symbolUI.resultsGrid.innerHTML = '';

    if (symbolSearchController) {
        symbolSearchController.abort();
    }
    symbolSearchController = new AbortController();

    try {
        const url = buildSvgApiListUrl(query, start, SYMBOLS_PAGE_SIZE);
        const response = await fetch(url, { signal: symbolSearchController.signal });
        if (!response.ok) {
            throw new Error(`SVG API responded with status ${response.status}`);
        }
        const data = await response.json();
        const normalized = normalizeSymbolResponse(data);
        symbolSearchState.results = normalized.items;
        symbolSearchState.nextStart = normalized.nextStart;
        symbolSearchState.total = normalized.total;
        renderSymbolResults(true);
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Symbol search failed:', error);
        symbolSearchState.results = [];
        symbolSearchState.selectedIndex = null;
        showSymbolEmptyState('Unable to load symbols. Please try again.');
        updateSymbolSelectionPanel();
        updateSymbolPaginationControls();
    } finally {
        setSymbolLoading(false);
    }
}

function buildSvgApiListUrl(query, start, limit) {
    const safeQuery = encodeURIComponent(query);
    let url = `${SVG_API_BASE_URL}/${SVG_API_DOMAIN_KEY}/list/?search=${safeQuery}&limit=${Math.min(limit, 20)}`;
    if (start && start > 0) {
        url += `&start=${start}`;
    }
    return url;
}

function normalizeSymbolResponse(payload) {
    const collections = [payload && payload.icons, payload && payload.data, payload && payload.results, payload && payload.items];
    const rawItems = collections.find(Array.isArray) || [];
    const items = rawItems.map((item, index) => formatSymbolItem(item, index));
    const nextStart = extractStartValue(payload ? payload.next : null);
    const total = payload && typeof payload.total === 'number'
        ? payload.total
        : (payload && typeof payload.count === 'number' ? payload.count : null);

    return { items, nextStart, total };
}

function formatSymbolItem(item, index) {
    const fallbackId = `symbol-${Date.now()}-${index}`;
    const tags = Array.isArray(item && item.tags) ? item.tags :
        (typeof (item && item.tags) === 'string'
            ? item.tags.split(/[,;]+/).map(tag => tag.trim()).filter(Boolean)
            : (Array.isArray(item && item.keywords) ? item.keywords : []));
    return {
        id: (item && (item.id || item.slug || item.uuid || item.name)) || fallbackId,
        title: (item && (item.title || item.name || item.slug)) || 'Untitled symbol',
        tags,
        svg: item && (item.svg || item.svg_inline || item.svg_data) || null,
        url: item && (item.url || item.download_url || item.svg_url) || null,
        previewUrl: item && (item.preview_url || item.thumbnail || item.url) || null
    };
}

function extractStartValue(value) {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        const match = value.match(/[?&]start=(\d+)/i);
        if (match) {
            return parseInt(match[1], 10);
        }
    }
    return null;
}

function renderSymbolResults(clearSelection) {
    if (!symbolUI.resultsGrid || !symbolUI.emptyState) return;

    if (clearSelection) {
        symbolSearchState.selectedIndex = null;
    }

    symbolUI.resultsGrid.innerHTML = '';

    if (!symbolSearchState.results.length) {
        symbolUI.resultsGrid.style.display = 'none';
        symbolUI.emptyState.style.display = 'block';
        if (symbolSearchState.query) {
            setSymbolEmptyMessage(`No symbols found for "${symbolSearchState.query}". Try another keyword.`);
        }
        updateSymbolSelectionPanel();
        updateSymbolPaginationControls();
        return;
    }

    symbolUI.emptyState.style.display = 'none';
    symbolUI.resultsGrid.style.display = 'grid';

    symbolSearchState.results.forEach((symbol, index) => {
        const card = document.createElement('div');
        card.className = 'symbol-card';
        card.dataset.index = index;

        const preview = document.createElement('div');
        preview.className = 'symbol-card-preview';
        if (symbol.previewUrl) {
            const img = document.createElement('img');
            img.src = symbol.previewUrl;
            img.alt = symbol.title;
            img.loading = 'lazy';
            img.referrerPolicy = 'no-referrer';
            preview.appendChild(img);
        } else if (symbol.svg) {
            preview.innerHTML = symbol.svg;
        } else {
            preview.textContent = 'Preview unavailable';
        }
        card.appendChild(preview);

        const title = document.createElement('div');
        title.className = 'symbol-card-title';
        title.textContent = symbol.title;
        card.appendChild(title);

        symbolUI.resultsGrid.appendChild(card);
    });

    applySymbolSelectionStyles();
    updateSymbolSelectionPanel();
    updateSymbolPaginationControls();
}

function applySymbolSelectionStyles() {
    if (!symbolUI.resultsGrid) return;
    const cards = symbolUI.resultsGrid.querySelectorAll('.symbol-card');
    cards.forEach(card => {
        const cardIndex = parseInt(card.dataset.index, 10);
        if (cardIndex === symbolSearchState.selectedIndex) {
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }
    });
}

function showSymbolEmptyState(message) {
    if (!symbolUI.emptyState || !symbolUI.resultsGrid) return;
    symbolUI.resultsGrid.innerHTML = '';
    symbolUI.resultsGrid.style.display = 'none';
    symbolUI.emptyState.style.display = 'block';
    if (message) {
        setSymbolEmptyMessage(message);
    }
}

function setSymbolEmptyMessage(message) {
    if (!symbolUI.emptyState) return;
    symbolUI.emptyState.innerHTML = '';
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    symbolUI.emptyState.appendChild(paragraph);
}

function setSymbolLoading(isLoading, { disableInput = true, disableButton = true } = {}) {
    if (symbolUI.loading) {
        symbolUI.loading.style.display = isLoading ? 'block' : 'none';
    }
    if (symbolUI.searchButton && disableButton) {
        symbolUI.searchButton.disabled = isLoading;
    }
    if (symbolUI.searchInput && disableInput) {
        symbolUI.searchInput.disabled = isLoading;
    }
}

function updateSymbolPaginationControls() {
    if (!symbolUI.pagination || !symbolUI.prevButton || !symbolUI.nextButton || !symbolUI.pageInfo) return;
    const hasPrev = symbolSearchState.prevStack.length > 0;
    const hasNext = Number.isInteger(symbolSearchState.nextStart);
    if (!symbolSearchState.results.length) {
        symbolUI.pagination.style.display = 'none';
    } else {
        symbolUI.pagination.style.display = hasPrev || hasNext ? 'flex' : 'none';
    }
    symbolUI.prevButton.disabled = !hasPrev;
    symbolUI.nextButton.disabled = !hasNext;
    const pageNumber = Math.floor(symbolSearchState.start / symbolSearchState.limit) + 1;
    symbolUI.pageInfo.textContent = `Page ${pageNumber}`;
}

function handleSymbolPagination(direction) {
    if (!symbolSearchState.results.length) return;
    if (direction === 'next') {
        if (!Number.isInteger(symbolSearchState.nextStart)) return;
        symbolSearchState.prevStack.push(symbolSearchState.start);
        startSymbolSearch({ start: symbolSearchState.nextStart, preserveStack: true });
    } else if (direction === 'prev') {
        if (!symbolSearchState.prevStack.length) return;
        const previousStart = symbolSearchState.prevStack.pop();
        startSymbolSearch({ start: previousStart, preserveStack: true });
    }
}

function selectSymbolResult(index) {
    if (index < 0 || index >= symbolSearchState.results.length) return;
    symbolSearchState.selectedIndex = index;
    applySymbolSelectionStyles();
    updateSymbolSelectionPanel();
}

function updateSymbolSelectionPanel() {
    if (!symbolUI.selectionPanel) return;
    const symbol = getSelectedSymbol();
    if (!symbol) {
        symbolUI.selectionPanel.style.display = 'none';
        if (symbolUI.preview) {
            symbolUI.preview.innerHTML = '';
        }
        setSymbolActionButtonsEnabled(false);
        return;
    }

    symbolUI.selectionPanel.style.display = 'flex';
    if (symbolUI.preview) {
        symbolUI.preview.innerHTML = '';
        if (symbol.svg) {
            symbolUI.preview.innerHTML = symbol.svg;
        } else if (symbol.previewUrl || symbol.url) {
            const img = document.createElement('img');
            img.src = symbol.previewUrl || symbol.url;
            img.alt = symbol.title;
            img.loading = 'lazy';
            symbolUI.preview.appendChild(img);
        } else {
            symbolUI.preview.textContent = 'Preview unavailable';
        }
    }

    if (symbolUI.title) {
        symbolUI.title.textContent = symbol.title;
    }
    if (symbolUI.tags) {
        const hasTags = Array.isArray(symbol.tags) && symbol.tags.length > 0;
        symbolUI.tags.textContent = hasTags ? `Tags: ${symbol.tags.join(', ')}` : 'No tags provided for this symbol.';
    }

    setSymbolActionButtonsEnabled(true);
}

function setSymbolActionButtonsEnabled(enabled) {
    if (symbolUI.addButton) {
        symbolUI.addButton.disabled = !enabled;
    }
    if (symbolUI.fillButton) {
        symbolUI.fillButton.disabled = !enabled;
    }
}

function updateSymbolDomainWarning(forceShow) {
    if (!symbolUI.domainWarning) return;
    if (hasSymbolApiKey() && !forceShow) {
        symbolUI.domainWarning.style.display = 'none';
    } else {
        symbolUI.domainWarning.style.display = 'block';
    }
}

function hasSymbolApiKey() {
    return typeof SVG_API_DOMAIN_KEY === 'string' && SVG_API_DOMAIN_KEY.length > 0;
}

function getSelectedSymbol() {
    if (typeof symbolSearchState.selectedIndex !== 'number') {
        return null;
    }
    return symbolSearchState.results[symbolSearchState.selectedIndex] || null;
}

async function addSelectedSymbolToCanvas({ fillSheetAfter = false } = {}) {
    const symbol = getSelectedSymbol();
    if (!symbol) {
        alert('Please select a symbol first.');
        return;
    }

    try {
        setSymbolLoading(true, { disableInput: false, disableButton: false });
        const svgContent = await fetchSymbolSvgContent(symbol);
        const fabricObject = await createFabricObjectFromSvg(svgContent);
        positionSymbolOnCanvas(fabricObject);
        canvas.add(fabricObject);
        arrangeObjectOnCanvas(fabricObject);
        canvas.setActiveObject(fabricObject);
        canvas.renderAll();
        updateToolbarState();

        if (fillSheetAfter) {
            hideUploadDialog();
            setTimeout(() => {
                fillSheet();
            }, 100);
        }
    } catch (error) {
        console.error('Failed to add symbol:', error);
        alert('Unable to add symbol to the sheet. Please try again.');
    } finally {
        setSymbolLoading(false, { disableInput: false, disableButton: false });
    }
}

async function fetchSymbolSvgContent(symbol) {
    if (symbol.svg) {
        return symbol.svg;
    }
    if (!symbol.url) {
        throw new Error('Symbol does not provide an SVG download URL.');
    }
    const response = await fetch(symbol.url);
    if (!response.ok) {
        throw new Error(`Failed to download SVG (${response.status}).`);
    }
    const svgText = await response.text();
    symbol.svg = svgText;
    return svgText;
}

function createFabricObjectFromSvg(svgText) {
    return new Promise((resolve, reject) => {
        fabric.loadSVGFromString(svgText, (objects, options) => {
            if (!objects || !objects.length) {
                reject(new Error('SVG did not contain drawable elements.'));
                return;
            }
            const obj = fabric.util.groupSVGElements(objects, options || {});
            resolve(obj);
        }, (error) => {
            reject(error);
        });
    });
}

function positionSymbolOnCanvas(symbolObject) {
    const virtualWidth = canvas.width / canvas.getZoom();
    const virtualHeight = canvas.height / canvas.getZoom();
    const safeAreaWidth = virtualWidth - (BLEED_PIXELS * 2);
    const maxWidth = safeAreaWidth * 0.8;

    if (symbolObject.width > maxWidth) {
        symbolObject.scaleToWidth(maxWidth);
    }

    symbolObject.set({
        left: virtualWidth / 2,
        top: virtualHeight / 2,
        originX: 'center',
        originY: 'center'
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

    // Set default to one third of the max size
    const defaultValue = Math.round(((minCm + maxCm) / 3).toFixed(1));
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

    // Update image size display when image loads
    previewImage.onload = function () {
        updateImageSize();
    };
}

/**
 * Update image size display based on current slider value
 */
function updateImageSize() {
    const previewImage = document.getElementById('preview-image');
    const sizeSlider = document.getElementById('size-slider');
    const sizeHeightValue = document.getElementById('size-height-value');

    if (!previewImage || !sizeSlider || !sizeHeightValue || !previewImage.naturalWidth) return;

    const targetWidthCm = parseFloat(sizeSlider.value);
    const aspectRatio = previewImage.naturalHeight / previewImage.naturalWidth;
    const heightCm = targetWidthCm * aspectRatio;

    sizeHeightValue.textContent = heightCm.toFixed(1);
}

/**
 * Add image from dialog to canvas
 * @param {{closeDialog?: boolean, fillSheetAfter?: boolean}} options
 */
function addImageFromDialog({ closeDialog = false, fillSheetAfter = false } = {}) {
    if (!currentImageData) return;

    const sizeSlider = document.getElementById('size-slider');
    const targetWidthCm = parseFloat(sizeSlider.value); // Get value in cm
    const targetWidthMm = targetWidthCm * 10; // Convert cm to mm
    const targetWidthPx = targetWidthMm * MM_TO_PIXELS; // Convert mm to pixels at 300 DPI

    fabric.Image.fromURL(currentImageData)
        .then((img) => {
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
            arrangeObjectOnCanvas(img);
            canvas.setActiveObject(img);
            canvas.renderAll();
            updateToolbarState();

            if (fillSheetAfter) {
                // Hide dialog first
                hideUploadDialog();

                // Fill sheet after a brief delay to let the image be added
                setTimeout(() => {
                    fillSheet();
                }, 100);
            } else if (closeDialog) {
                hideUploadDialog();
                resetDialogForNextImage();
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
 * Add text from dialog
 * @param {{closeDialog?: boolean, fillSheetAfter?: boolean}} options
 */
function addTextFromDialog({ closeDialog = false, fillSheetAfter = false } = {}) {
    const textSizeSlider = document.getElementById('text-size-slider');

    const textContent = getTextPreviewValue();
    if (!textContent) {
        alert('Please enter some text.');
        return;
    }

    const fontSize = parseInt(textSizeSlider.value, 10);
    const fontFamily = getSelectedTextFont();

    // Get virtual canvas dimensions
    const virtualWidth = canvas.width / canvas.getZoom();
    const virtualHeight = canvas.height / canvas.getZoom();
    const safeAreaCenterX = virtualWidth / 2;
    const safeAreaCenterY = virtualHeight / 2;

    // Create text object
    const text = new fabric.Text(textContent, {
        left: safeAreaCenterX,
        top: safeAreaCenterY,
        originX: 'center',
        originY: 'center',
        fontSize: fontSize,
        fill: '#000000',
        fontFamily: fontFamily
    });

    // Add to canvas
    canvas.add(text);
    arrangeObjectOnCanvas(text);
    canvas.setActiveObject(text);
    canvas.renderAll();
    updateToolbarState();

    if (fillSheetAfter) {
        // Hide dialog first
        hideUploadDialog();

        // Fill sheet after a brief delay to let the text be added
        setTimeout(() => {
            fillSheet();
        }, 100);
    } else if (closeDialog) {
        hideUploadDialog();
        resetDialogForNextText();
    } else {
        // Reset dialog for next text
        resetDialogForNextText();
    }
}

/**
 * Reset dialog for adding another text
 */
function resetDialogForNextText() {
    const textPreview = getTextPreviewElement();
    if (textPreview) {
        textPreview.textContent = '';
        textPreview.focus();
    }
    updateTextWidth();
}

/**
 * Lazily create a reusable Fabric.Text instance for measurement only
 */
function getTextMeasurementHelper() {
    if (!textMeasurementHelper) {
        textMeasurementHelper = new fabric.Text('', {
            fontFamily: 'Arial',
            left: -1000,
            top: -1000,
            visible: false
        });
    }
    return textMeasurementHelper;
}

function getSelectedTextFont() {
    const select = document.getElementById('text-font-select');
    return select && select.value ? select.value : 'Arial';
}

function getTextPreviewElement() {
    return document.getElementById('text-preview');
}

function getTextPreviewValue() {
    const textPreview = getTextPreviewElement();
    if (!textPreview) return '';
    return textPreview.innerText
        .replace(/\u00A0/g, ' ')
        .replace(/\r\n/g, '\n')
        .trim();
}

function initTextPreviewInput() {
    const textPreview = getTextPreviewElement();
    if (!textPreview) return;

    textPreview.textContent = '';

    textPreview.addEventListener('input', () => {
        updateTextWidth();
    });

    textPreview.addEventListener('paste', event => {
        event.preventDefault();
        const clipboard = event.clipboardData || window.clipboardData;
        const text = clipboard ? clipboard.getData('text/plain') : '';
        insertTextAtCursor(textPreview, text);
        updateTextWidth();
    });
}

// Inserts plain text at the current caret location in the preview input
function insertTextAtCursor(element, text) {
    if (!text) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        element.textContent += text;
        return;
    }

    const range = selection.getRangeAt(0);
    if (!element.contains(range.commonAncestorContainer)) {
        element.focus();
        const focusSelection = window.getSelection();
        if (!focusSelection) {
            element.textContent += text;
            return;
        }
        focusSelection.removeAllRanges();
        const newRange = document.createRange();
        newRange.selectNodeContents(element);
        newRange.collapse(false);
        focusSelection.addRange(newRange);
    }

    const activeSelection = window.getSelection();
    if (!activeSelection || activeSelection.rangeCount === 0) {
        element.textContent += text;
        return;
    }

    const activeRange = activeSelection.getRangeAt(0);
    activeRange.deleteContents();
    const textNode = document.createTextNode(text);
    activeRange.insertNode(textNode);
    activeRange.setStartAfter(textNode);
    activeRange.setEndAfter(textNode);
    activeSelection.removeAllRanges();
    activeSelection.addRange(activeRange);
}

function applyTextPreviewStyle(textContent, fontSize, fontFamily) {
    const textPreview = getTextPreviewElement();
    if (!textPreview) return;

    textPreview.style.fontFamily = fontFamily;
    if (fontSize && textContent) {
        const previewFontSize = Math.min(fontSize, 96);
        textPreview.style.fontSize = previewFontSize + 'px';
    } else {
        textPreview.style.fontSize = '';
    }
}

/**
 * Calculate and display text width in millimeters
 */
function updateTextWidth() {
    const textPreview = getTextPreviewElement();
    const textSizeSlider = document.getElementById('text-size-slider');
    const textSizeValue = document.getElementById('text-size-value');
    const textHeightValue = document.getElementById('text-height-value');
    const textSizeControl = document.querySelector('.text-size-control');
    const textSizeWarning = document.getElementById('text-size-warning');

    if (!textPreview || !textSizeSlider || !textSizeValue) return;

    const textContent = getTextPreviewValue();
    const fontSize = parseInt(textSizeSlider.value, 10) || 40;
    const fontFamily = getSelectedTextFont();

    applyTextPreviewStyle(textContent, fontSize, fontFamily);

    if (!textContent) {
        textSizeValue.textContent = '—';
        if (textHeightValue) textHeightValue.textContent = '—';
        if (textSizeControl) textSizeControl.classList.remove('warning');
        if (textSizeWarning) textSizeWarning.style.display = 'none';
        return;
    }

    // Reuse a single Fabric.Text instance for measurement to avoid allocations
    const measurementText = getTextMeasurementHelper();
    measurementText.set({
        text: textContent,
        fontSize: fontSize,
        fontFamily: fontFamily
    });

    if (typeof measurementText.initDimensions === 'function') {
        measurementText.initDimensions();
    } else if (typeof measurementText._initDimensions === 'function') {
        // Fallback for Fabric versions exposing only the private API
        measurementText._initDimensions();
    }

    // Get width and height in pixels (virtual canvas coordinates)
    const widthPx = measurementText.width;
    const heightPx = measurementText.height;
    const widthMm = widthPx / MM_TO_PIXELS; // Convert pixels to mm
    const heightMm = heightPx / MM_TO_PIXELS; // Convert pixels to mm
    const widthCm = widthMm / 10;
    const heightCm = heightMm / 10;

    textSizeValue.textContent = widthCm.toFixed(1);
    if (textHeightValue) textHeightValue.textContent = heightCm.toFixed(1);

    // Check if text exceeds safe area (canvas width minus 2x bleed of 5mm each)
    // Determine canvas width based on window orientation (same logic as slider range)
    const isWindowLandscape = window.innerWidth > window.innerHeight;
    const canvasWidthMm = isWindowLandscape ? A5_LONG_SIDE_MM : A5_SHORT_SIDE_MM;
    const safeAreaWidthMm = canvasWidthMm - (2 * BLEED_MM); // minus 10mm total bleed
    const safeAreaWidthCm = safeAreaWidthMm / 10;

    if (widthCm > safeAreaWidthCm) {
        // Text is too wide - show warning
        if (textSizeControl) textSizeControl.classList.add('warning');
        if (textSizeWarning) textSizeWarning.style.display = 'block';
    } else {
        // Text fits - hide warning
        if (textSizeControl) textSizeControl.classList.remove('warning');
        if (textSizeWarning) textSizeWarning.style.display = 'none';
    }
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