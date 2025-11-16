/**
 * LikeInk Designer - Custom Tattoo Sheet Designer
 * A5 Landscape with 5mm bleed area
 */

// Canvas dimensions
// A5 in landscape: 210mm × 148mm at 300 DPI
const MM_TO_PIXELS = 300 / 25.4; // 300 DPI conversion
const A5_WIDTH_MM = 210;
const A5_HEIGHT_MM = 148;
const BLEED_MM = 5;

const CANVAS_WIDTH = Math.round(A5_WIDTH_MM * MM_TO_PIXELS); // 2480 pixels
const CANVAS_HEIGHT = Math.round(A5_HEIGHT_MM * MM_TO_PIXELS); // 1748 pixels
const BLEED_PIXELS = Math.round(BLEED_MM * MM_TO_PIXELS); // ~59 pixels
const BLEED_OPACITY = 0.8; // Opacity for bleed overlays
const DUPLICATION_OFFSET = 50; // Offset in pixels when duplicating objects

// Display scale for screen (adjust for reasonable screen display)
const DISPLAY_SCALE = 0.4; // Scale down for screen display

let canvas;
let bleedRect;
let bleedOverlays = [];
let imageUploadCount = 0; // Counter to offset new uploads

// Undo/Redo history management
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 20; // Maximum number of states to keep
let isRestoring = false; // Flag to prevent saving state during restore

/**
 * Initialize the Fabric.js canvas
 */
function initCanvas() {
    // Create canvas with display dimensions
    const displayWidth = Math.round(CANVAS_WIDTH * DISPLAY_SCALE);
    const displayHeight = Math.round(CANVAS_HEIGHT * DISPLAY_SCALE);
    
    canvas = new fabric.Canvas('designer-canvas', {
        width: displayWidth,
        height: displayHeight,
        backgroundColor: '#ffffff',
        preserveObjectStacking: true
    });

    // Set the zoom level to match our display scale
    canvas.setZoom(DISPLAY_SCALE);

    // Add bleed area visualization
    addBleedArea();

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
 * Add bleed area guide (red dashed rectangle) and overlay for bleed zones
 */
function addBleedArea() {
    // Create semi-transparent white overlays for the bleed areas (areas that will be trimmed)
    
    // Top bleed overlay
    const topOverlay = new fabric.Rect({
        left: 0,
        top: 0,
        width: CANVAS_WIDTH,
        height: BLEED_PIXELS,
        fill: `rgba(255, 255, 255, ${BLEED_OPACITY})`,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    });
    
    // Bottom bleed overlay
    const bottomOverlay = new fabric.Rect({
        left: 0,
        top: CANVAS_HEIGHT - BLEED_PIXELS,
        width: CANVAS_WIDTH,
        height: BLEED_PIXELS,
        fill: `rgba(255, 255, 255, ${BLEED_OPACITY})`,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    });
    
    // Left bleed overlay
    const leftOverlay = new fabric.Rect({
        left: 0,
        top: BLEED_PIXELS,
        width: BLEED_PIXELS,
        height: CANVAS_HEIGHT - (BLEED_PIXELS * 2),
        fill: `rgba(255, 255, 255, ${BLEED_OPACITY})`,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    });
    
    // Right bleed overlay
    const rightOverlay = new fabric.Rect({
        left: CANVAS_WIDTH - BLEED_PIXELS,
        top: BLEED_PIXELS,
        width: BLEED_PIXELS,
        height: CANVAS_HEIGHT - (BLEED_PIXELS * 2),
        fill: `rgba(255, 255, 255, ${BLEED_OPACITY})`,
        selectable: false,
        evented: false,
        name: 'bleedOverlay'
    });
    
    // Red dashed line showing the safe area boundary
    bleedRect = new fabric.Rect({
        left: BLEED_PIXELS,
        top: BLEED_PIXELS,
        width: CANVAS_WIDTH - (BLEED_PIXELS * 2),
        height: CANVAS_HEIGHT - (BLEED_PIXELS * 2),
        fill: 'transparent',
        stroke: '#dc3545',
        strokeWidth: 3,
        strokeDashArray: [10, 5],
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
 * Bring bleed area overlays to front
 */
function bringBleedAreasToFront() {
    bleedOverlays.forEach(overlay => {
        canvas.bringToFront(overlay);
    });
    canvas.bringToFront(bleedRect);
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
    
    if (selectAllBtn) selectAllBtn.addEventListener('click', selectAll);
    if (deselectBtn) deselectBtn.addEventListener('click', deselectAll);
    if (duplicateBtn) duplicateBtn.addEventListener('click', duplicateSelected);
    if (deleteBtn) deleteBtn.addEventListener('click', deleteSelected);
    if (undoBtn) undoBtn.addEventListener('click', undo);
    if (redoBtn) redoBtn.addEventListener('click', redo);
    if (bringForwardBtn) bringForwardBtn.addEventListener('click', bringForward);
    if (sendBackwardBtn) sendBackwardBtn.addEventListener('click', sendBackward);
    if (clearBtn) clearBtn.addEventListener('click', clearCanvas);

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboard);

    // Drag and drop on canvas
    const canvasWrapper = document.querySelector('.canvas-wrapper');
    canvasWrapper.addEventListener('dragover', handleDragOver);
    canvasWrapper.addEventListener('drop', handleDrop);
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

    reader.onload = function(event) {
        fabric.Image.fromURL(event.target.result, function(img) {
            // Scale image to fit reasonably on canvas (max 30% of canvas width)
            const maxWidth = CANVAS_WIDTH * 0.3;
            const maxHeight = CANVAS_HEIGHT * 0.3;
            
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
        objects.forEach(obj => {
            canvas.remove(obj);
        });
    } else {
        // Handle single object
        canvas.remove(activeObject);
    }
    
    canvas.renderAll();
    updateToolbarState();
}

/**
 * Select all user objects (excluding bleed overlays)
 */
function selectAll() {
    // Get all user objects (exclude bleed overlays)
    const userObjects = canvas.getObjects().filter(obj => 
        obj.name !== 'bleedOverlay' && obj.name !== 'bleedArea'
    );
    
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

    const objects = canvas.getObjects().filter(obj => 
        obj !== bleedRect && !bleedOverlays.includes(obj)
    );
    objects.forEach(obj => canvas.remove(obj));
    canvas.renderAll();
    updateToolbarState();
}

/**
 * Save current canvas state for undo/redo
 */
function saveState() {
    // Don't save state during restoration or if canvas not ready
    if (isRestoring || !canvas) return;
    
    // Filter out bleed overlays before saving
    const objectsToSave = canvas.getObjects().filter(obj => 
        obj.name !== 'bleedOverlay' && obj.name !== 'bleedArea'
    );
    
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
    const userObjects = canvas.getObjects().filter(obj => 
        obj.name !== 'bleedOverlay' && obj.name !== 'bleedArea'
    );
    userObjects.forEach(obj => canvas.remove(obj));
    
    // Load the saved state (which contains only user objects)
    canvas.loadFromJSON(state, function() {
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
document.addEventListener('DOMContentLoaded', function() {
    initCanvas();
    console.log('LikeInk Designer initialized');
    console.log(`Canvas: ${CANVAS_WIDTH}x${CANVAS_HEIGHT} pixels (${A5_WIDTH_MM}x${A5_HEIGHT_MM}mm at 300 DPI)`);
    console.log(`Bleed area: ${BLEED_MM}mm (${BLEED_PIXELS} pixels)`);
});
