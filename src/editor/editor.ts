import { fabric } from 'fabric';
import { getCaptureDataUrl, clearCaptureDataUrl } from '../shared/storage';
import { generateFilename } from '../shared/utils';

// Constantes
const CANVAS_ID = 'c';
const INITIAL_ZOOM = 1;

// Estado
let canvas: fabric.Canvas;
let currentTool: string = 'select';
let currentColor: string = '#ff0000';
let currentImage: fabric.Image | null = null;
let isDrawing = false;
let drawOriginX = 0;
let drawOriginY = 0;
let tempShape: fabric.Object | null = null;
let tempArrowPreview: fabric.Path | null = null; // Vista previa de flecha durante dibujo

// Referencias DOM
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnRedo = document.getElementById('btn-redo') as HTMLButtonElement;
const btnDelete = document.getElementById('btn-delete') as HTMLButtonElement;
const colorPicker = document.getElementById('color-picker') as HTMLInputElement;

// Inicialización principal
async function initEditor() {
    try {
        const dataUrl = await getCaptureDataUrl();
        if (!dataUrl) {
            alert('No se encontró ninguna captura reciente.');
            return;
        }

        // Crear instancia del canvas
        canvas = new fabric.Canvas(CANVAS_ID, {
            selection: true,
            preserveObjectStacking: true, // Importante para que los objetos no salten al seleccionarlos
            stopContextMenu: true,
            fireRightClick: true
        });

        // Configurar tamaño del viewport para que ocupe todo el espacio disponible
        resizeCanvasToViewport();
        window.addEventListener('resize', resizeCanvasToViewport);

        // Cargar imagen de fondo
        fabric.Image.fromURL(dataUrl, (img) => {
            currentImage = img;
            img.set({
                left: 0,
                top: 0,
                originX: 'left',
                originY: 'top',
                selectable: false,
                evented: false
            });
            
            canvas.setBackgroundImage(img, () => {
                resizeCanvasToViewport();
                saveHistory();
            });
        }, { crossOrigin: 'anonymous' });

        setupToolbar();
        setupCanvasEvents();
        setupKeyboardShortcuts();
        setupExport();

    } catch (error) {
        console.error('Error inicializando el editor:', error);
        alert('Ocurrió un error al cargar la imagen.');
    }
}

function resizeCanvasToViewport() {
    const workspace = document.getElementById('workspace');
    if (!workspace || !canvas) return;
    canvas.setWidth(workspace.clientWidth);
    canvas.setHeight(workspace.clientHeight);
    fitToScreen();
}

function fitToScreen() {
    if (!currentImage || !currentImage.width || !currentImage.height) return;
    const workspace = document.getElementById('workspace');
    if (!workspace || !canvas) return;

    const wsWidth = workspace.clientWidth;
    const wsHeight = workspace.clientHeight;

    // Asegurar que el canvas de Fabric coincida con el tamaño completo del workspace
    if (canvas.getWidth() !== wsWidth || canvas.getHeight() !== wsHeight) {
        canvas.setWidth(wsWidth);
        canvas.setHeight(wsHeight);
    }

    const scaleX = wsWidth / currentImage.width;
    const scaleY = wsHeight / currentImage.height;
    
    // Escala para que quepa cómodamente en pantalla con un margen del 5%
    let scale = Math.min(scaleX, scaleY) * 0.95;
    if (scale > 1) scale = 1;
    
    // Centrar la imagen en el workspace
    const x = (wsWidth - currentImage.width * scale) / 2;
    const y = (wsHeight - currentImage.height * scale) / 2;
    
    canvas.viewportTransform = [scale, 0, 0, scale, Math.max(0, x), Math.max(10, y)];
    canvas.requestRenderAll();
    updateZoomLabel(scale);
}

// Historial (Undo/Redo)
let history: string[] = [];
let historyIndex = -1;
let isHistoryAction = false;

function saveHistory() {
    if (isHistoryAction) return;
    
    // Eliminar futuro si estamos en medio del stack y hacemos una nueva accion
    if (historyIndex < history.length - 1) {
        history = history.slice(0, historyIndex + 1);
    }
    
    // Exportar sin el background para ahorrar muchísima memoria (el background siempre es el mismo)
    const json = canvas.toJSON(['id', 'opacity', 'globalCompositeOperation']);
    delete json.backgroundImage;
    
    history.push(JSON.stringify(json));
    historyIndex++;
    updateHistoryButtons();
}

function updateHistoryButtons() {
    if (btnUndo) btnUndo.style.opacity = historyIndex > 0 ? '1' : '0.3';
    if (btnRedo) btnRedo.style.opacity = historyIndex < history.length - 1 ? '1' : '0.3';
}

function undo() {
    if (historyIndex > 0) {
        isHistoryAction = true;
        historyIndex--;
        loadHistory(history[historyIndex]);
    }
}

function redo() {
    if (historyIndex < history.length - 1) {
        isHistoryAction = true;
        historyIndex++;
        loadHistory(history[historyIndex]);
    }
}

function loadHistory(jsonString: string) {
    const json = JSON.parse(jsonString);
    if (currentImage) {
        json.backgroundImage = currentImage.toObject();
    }
    canvas.loadFromJSON(json, () => {
        canvas.renderAll();
        isHistoryAction = false;
        updateHistoryButtons();
    });
}

function deleteSelected() {
    const activeObjects = canvas.getActiveObjects();
    if (activeObjects.length) {
        activeObjects.forEach(obj => canvas.remove(obj));
        canvas.discardActiveObject();
        saveHistory();
    }
}

// Configuración de Herramientas
function setupToolbar() {
    const buttons = document.querySelectorAll('.tool-btn[data-tool]');
    buttons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            buttons.forEach(b => b.classList.remove('active'));
            const target = e.currentTarget as HTMLElement;
            target.classList.add('active');
            
            const tool = target.dataset.tool;
            if (tool) setTool(tool);
        });
    });

    if (colorPicker) {
        colorPicker.addEventListener('change', (e) => {
            currentColor = (e.target as HTMLInputElement).value;
            // Si hay un objeto seleccionado (texto/forma), cambiar su color
            const activeObj = canvas.getActiveObject();
            if (activeObj) {
                if (activeObj.type === 'i-text') {
                    activeObj.set('fill', currentColor);
                } else if (activeObj.type === 'path' || activeObj.type === 'arrow') { // path es para el lápiz libre
                    activeObj.set('stroke', currentColor);
                } else {
                    activeObj.set('stroke', currentColor);
                }
                canvas.renderAll();
                saveHistory();
            }
        });
    }

    document.getElementById('btn-undo')?.addEventListener('click', undo);
    document.getElementById('btn-redo')?.addEventListener('click', redo);
    document.getElementById('btn-delete')?.addEventListener('click', deleteSelected);
}

function setTool(tool: string) {
    currentTool = tool;
    
    // Resetear modos
    canvas.isDrawingMode = false;
    canvas.selection = false;
    canvas.defaultCursor = 'crosshair';
    canvas.discardActiveObject();
    canvas.renderAll();

    switch (tool) {
        case 'select':
            canvas.selection = true;
            canvas.defaultCursor = 'default';
            break;
        case 'pen':
            canvas.isDrawingMode = true;
            canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
            canvas.freeDrawingBrush.color = currentColor;
            canvas.freeDrawingBrush.width = 4;
            break;
        case 'text':
            canvas.defaultCursor = 'text';
            break;
        // Otras herramientas son manejadas en eventos de mouse
    }
}

// Eventos del Canvas
function setupCanvasEvents() {
    // Zoom y Pan
    canvas.on('mouse:wheel', function(opt) {
        const evt = opt.e;
        if (evt.ctrlKey || evt.metaKey) {
            // Zoom
            let delta = evt.deltaY;
            let zoom = canvas.getZoom();
            zoom *= 0.999 ** delta;
            if (zoom > 20) zoom = 20;
            if (zoom < 0.01) zoom = 0.01;
            canvas.zoomToPoint({ x: evt.offsetX, y: evt.offsetY }, zoom);
            opt.e.preventDefault();
            opt.e.stopPropagation();
            updateZoomLabel(zoom);
        } else {
            // Pan
            const vpt = canvas.viewportTransform;
            if (vpt) {
                vpt[4] -= evt.deltaX;
                vpt[5] -= evt.deltaY;
                canvas.requestRenderAll();
            }
        }
    });

    let isDragging = false;
    let lastPosX = 0;
    let lastPosY = 0;

    canvas.on('mouse:down', function(opt) {
        const evt = opt.e;
        
        // Panning con rueda central o barra espaciadora
        if (evt.button === 1 || evt.altKey) {
            isDragging = true;
            canvas.selection = false;
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
            return;
        }

        // Si es click derecho, ignorar para dibujo
        if (evt.button === 2) return;

        // Si clickea sobre un objeto existente en modo Select, no hacer dibujo nuevo
        if (currentTool === 'select') return;

        const pointer = canvas.getPointer(opt.e);
        isDrawing = true;
        drawOriginX = pointer.x;
        drawOriginY = pointer.y;

        if (currentTool === 'rect') {
            tempShape = new fabric.Rect({
                left: drawOriginX,
                top: drawOriginY,
                width: 0,
                height: 0,
                fill: 'transparent',
                stroke: currentColor,
                strokeWidth: 4,
                selectable: false
            });
            canvas.add(tempShape);
        } else if (currentTool === 'circle') {
            tempShape = new fabric.Ellipse({
                left: drawOriginX,
                top: drawOriginY,
                originX: 'center',
                originY: 'center',
                rx: 0,
                ry: 0,
                fill: 'transparent',
                stroke: currentColor,
                strokeWidth: 4,
                selectable: false
            });
            canvas.add(tempShape);
        } else if (currentTool === 'text') {
            const text = new fabric.IText('Text', {
                left: drawOriginX,
                top: drawOriginY,
                fontFamily: 'Inter',
                fill: currentColor,
                fontSize: 40,
                fontWeight: 'bold',
                selectable: true
            });
            canvas.add(text);
            canvas.setActiveObject(text);
            text.enterEditing();
            text.selectAll();
            setTool('select'); // Volver a select
            (document.querySelector('.tool-btn[data-tool="select"]') as HTMLElement).click();
            isDrawing = false;
        } else if (currentTool === 'highlight') {
            tempShape = new fabric.Rect({
                left: drawOriginX,
                top: drawOriginY,
                width: 0,
                height: 0,
                fill: currentColor,
                opacity: 0.4,
                selectable: false
            });
            canvas.add(tempShape);
        } else if (currentTool === 'arrow') {
            // Para arrow NO creamos shape todavía, sólo guardamos el origen
            // La vista previa se gestiona en mousemove
        } else if (currentTool === 'blur') {
            tempShape = new fabric.Rect({
                left: drawOriginX,
                top: drawOriginY,
                width: 0,
                height: 0,
                fill: 'rgba(255,255,255,0.2)', // preview box
                stroke: '#000',
                strokeDashArray: [5, 5],
                selectable: false
            });
            canvas.add(tempShape);
        } else if (currentTool === 'crop') {
            tempShape = new fabric.Rect({
                left: drawOriginX,
                top: drawOriginY,
                width: 0,
                height: 0,
                fill: 'rgba(0,0,0,0.5)',
                stroke: '#fff',
                strokeDashArray: [5, 5],
                selectable: false
            });
            canvas.add(tempShape);
        }
    });

    canvas.on('mouse:move', function(opt) {
        if (isDragging) {
            const e = opt.e;
            const vpt = canvas.viewportTransform;
            if (vpt) {
                vpt[4] += e.clientX - lastPosX;
                vpt[5] += e.clientY - lastPosY;
                canvas.requestRenderAll();
                lastPosX = e.clientX;
                lastPosY = e.clientY;
            }
            return;
        }

        if (!isDrawing) return;
        const pointer = canvas.getPointer(opt.e);

        // Arrow: regenerar vista previa como Path simple
        if (currentTool === 'arrow') {
            if (tempArrowPreview) { canvas.remove(tempArrowPreview); }
            tempArrowPreview = buildArrowPath(drawOriginX, drawOriginY, pointer.x, pointer.y, currentColor, false);
            canvas.add(tempArrowPreview);
            canvas.renderAll();
            return;
        }

        if (!tempShape) return;

        if (currentTool === 'rect' || currentTool === 'highlight' || currentTool === 'blur' || currentTool === 'crop') {
            const left = Math.min(drawOriginX, pointer.x);
            const top = Math.min(drawOriginY, pointer.y);
            const width = Math.abs(drawOriginX - pointer.x);
            const height = Math.abs(drawOriginY - pointer.y);
            tempShape.set({ left, top, width, height });
        } else if (currentTool === 'circle') {
            tempShape.set({
                rx: Math.abs(drawOriginX - pointer.x),
                ry: Math.abs(drawOriginY - pointer.y)
            });
        }
        
        canvas.renderAll();
    });

    canvas.on('mouse:up', function(opt) {
        isDragging = false;
        
        if (isDrawing) {
            if (currentTool === 'arrow') {
                // Quitar vista previa
                if (tempArrowPreview) { canvas.remove(tempArrowPreview); tempArrowPreview = null; }
                const pointer = canvas.getPointer(opt.e);
                const dx = pointer.x - drawOriginX;
                const dy = pointer.y - drawOriginY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > 10) { // Evitar puntos
                    const arrow = buildArrowPath(drawOriginX, drawOriginY, pointer.x, pointer.y, currentColor, true);
                    canvas.add(arrow);
                    canvas.setActiveObject(arrow);
                    saveHistory();
                }
            } else if (tempShape && currentTool === 'blur' && currentImage) {
                const rect = tempShape as fabric.Rect;
                const blurLeft = rect.left!;
                const blurTop = rect.top!;
                const blurW = rect.width!;
                const blurH = rect.height!;
                canvas.remove(rect);
                
                if (blurW > 5 && blurH > 5) {
                    currentImage.clone((clonedObj: fabric.Image) => {
                        clonedObj.set({ left: 0, top: 0, selectable: true, evented: true });
                        const clipPath = new fabric.Rect({
                            left: blurLeft,
                            top: blurTop,
                            width: blurW,
                            height: blurH,
                            absolutePositioned: true
                        });
                        clonedObj.clipPath = clipPath;
                        // Pixelate es más efectivo visualmente para censura
                        const filter = new (fabric.Image.filters as any).Pixelate({ blocksize: 16 });
                        clonedObj.filters = [filter];
                        clonedObj.applyFilters();
                        canvas.add(clonedObj);
                        saveHistory();
                    });
                }
            } else if (tempShape && currentTool === 'crop' && currentImage) {
                const rect = tempShape as fabric.Rect;
                canvas.remove(rect);
                
                if (rect.width! > 20 && rect.height! > 20) {
                    if (confirm('¿Aplicar este recorte?')) {
                        applyCrop(rect.left!, rect.top!, rect.width!, rect.height!);
                    }
                }
            } else if (tempShape) {
                tempShape.setCoords();
                tempShape.set('selectable', true);
                saveHistory();
            }
        }
        isDrawing = false;
        tempShape = null;
    });

function buildArrowPath(x1: number, y1: number, x2: number, y2: number, color: string, selectable: boolean): fabric.Path {
    const headLen = 20;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const ax1 = x2 - headLen * Math.cos(angle - Math.PI / 6);
    const ay1 = y2 - headLen * Math.sin(angle - Math.PI / 6);
    const ax2 = x2 - headLen * Math.cos(angle + Math.PI / 6);
    const ay2 = y2 - headLen * Math.sin(angle + Math.PI / 6);

    const d = `M ${x1} ${y1} L ${x2} ${y2} M ${x2} ${y2} L ${ax1} ${ay1} M ${x2} ${y2} L ${ax2} ${ay2}`;
    return new fabric.Path(d, {
        stroke: color,
        strokeWidth: 4,
        fill: '',
        selectable,
        evented: selectable,
        strokeLineCap: 'round',
        strokeLineJoin: 'round'
    });
}

function applyCrop(x: number, y: number, w: number, h: number) {
    if (!currentImage || !currentImage.width || !currentImage.height) return;

    const imgW = currentImage.width;
    const imgH = currentImage.height;

    // Normalizar y recortar respetando los límites de la imagen
    const cropX = Math.max(0, Math.min(Math.round(x), imgW));
    const cropY = Math.max(0, Math.min(Math.round(y), imgH));
    const cropW = Math.max(10, Math.min(Math.round(w), imgW - cropX));
    const cropH = Math.max(10, Math.min(Math.round(h), imgH - cropY));

    if (cropW <= 20 || cropH <= 20) return;

    // Obtener el elemento de imagen original o canvas
    const imgElement = currentImage.getElement() as HTMLImageElement | HTMLCanvasElement;
    if (!imgElement) return;

    // Crear un canvas temporal para recortar limpiamente a resolución nativa 1:1
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cropW;
    tempCanvas.height = cropH;
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return;

    tempCtx.drawImage(imgElement, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    const croppedDataUrl = tempCanvas.toDataURL('image/png');

    fabric.Image.fromURL(croppedDataUrl, (newImg) => {
        newImg.set({
            left: 0,
            top: 0,
            originX: 'left',
            originY: 'top',
            selectable: false,
            evented: false
        });

        currentImage = newImg;

        // Desplazar todos los objetos en el canvas (dibujos, flechas, texto, etc.)
        // para que permanezcan en su posición relativa sobre la imagen recortada
        const objects = canvas.getObjects();
        objects.forEach((obj) => {
            obj.set({
                left: (obj.left || 0) - cropX,
                top: (obj.top || 0) - cropY
            });
            obj.setCoords();
        });

        canvas.setBackgroundImage(newImg, () => {
            fitToScreen();
            canvas.renderAll();
            saveHistory();

            // Volver a la herramienta select
            setTool('select');
            const selectBtn = document.querySelector<HTMLElement>('.tool-btn[data-tool="select"]');
            if (selectBtn) {
                document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
                selectBtn.classList.add('active');
            }
        });
    }, { crossOrigin: 'anonymous' });
}

    canvas.on('object:modified', () => saveHistory());
    canvas.on('path:created', () => saveHistory());
}

// Controles Superiores (Zoom y UI)
function updateZoomLabel(zoom: number) {
    const el = document.getElementById('zoom-level');
    if (el) el.textContent = `${Math.round(zoom * 100)}%`;
}

document.getElementById('zoom-in')?.addEventListener('click', () => {
    let zoom = canvas.getZoom() * 1.25;
    if (zoom > 20) zoom = 20;
    const ws = document.getElementById('workspace')!;
    canvas.zoomToPoint(new fabric.Point(ws.clientWidth / 2, ws.clientHeight / 2), zoom);
    updateZoomLabel(zoom);
});

document.getElementById('zoom-out')?.addEventListener('click', () => {
    let zoom = canvas.getZoom() / 1.25;
    if (zoom < 0.02) zoom = 0.02;
    const ws = document.getElementById('workspace')!;
    canvas.zoomToPoint(new fabric.Point(ws.clientWidth / 2, ws.clientHeight / 2), zoom);
    updateZoomLabel(zoom);
});

document.getElementById('zoom-fit')?.addEventListener('click', fitToScreen);

// Keyboard Shortcuts
function setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        // Ignorar shortcuts si estamos editando texto
        if (document.activeElement?.tagName === 'INPUT' || (canvas.getActiveObject() as any)?.isEditing) {
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            if (e.shiftKey) {
                redo();
            } else {
                undo();
            }
            e.preventDefault();
        }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            deleteSelected();
        }
        
        if (e.key === 'v') document.querySelector<HTMLElement>('.tool-btn[data-tool="select"]')?.click();
        if (e.key === 'p') document.querySelector<HTMLElement>('.tool-btn[data-tool="pen"]')?.click();
        if (e.key === 'r') document.querySelector<HTMLElement>('.tool-btn[data-tool="rect"]')?.click();
        if (e.key === 'o') document.querySelector<HTMLElement>('.tool-btn[data-tool="circle"]')?.click();
        if (e.key === 't') document.querySelector<HTMLElement>('.tool-btn[data-tool="text"]')?.click();
    });
}

// Exportación
function setupExport() {
    const modal = document.getElementById('export-modal');
    document.getElementById('btn-export')?.addEventListener('click', () => {
        modal?.classList.remove('hidden');
    });
    
    document.getElementById('btn-close-modal')?.addEventListener('click', () => {
        modal?.classList.add('hidden');
    });

    document.getElementById('btn-dl-png')?.addEventListener('click', () => {
        exportImage('png');
        modal?.classList.add('hidden');
    });

    document.getElementById('btn-dl-jpeg')?.addEventListener('click', () => {
        exportImage('jpeg');
        modal?.classList.add('hidden');
    });

    document.getElementById('btn-copy')?.addEventListener('click', async () => {
        try {
            if (!currentImage || !currentImage.width || !currentImage.height) return;

            // Guardar estado del viewport
            const prevVpt = canvas.viewportTransform ? [...canvas.viewportTransform] : [1, 0, 0, 1, 0, 0];
            const prevWidth = canvas.getWidth();
            const prevHeight = canvas.getHeight();

            // Configurar canvas temporalmente a 1:1 respecto a la imagen actual
            canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
            canvas.setWidth(currentImage.width);
            canvas.setHeight(currentImage.height);
            canvas.renderAll();

            const dataUrl = canvas.toDataURL({ format: 'png', multiplier: 1 });

            // Restaurar estado visual del canvas
            canvas.setWidth(prevWidth);
            canvas.setHeight(prevHeight);
            canvas.viewportTransform = prevVpt;
            canvas.renderAll();

            const res = await fetch(dataUrl);
            const blob = await res.blob();
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
            ]);
            alert('¡Imagen copiada al portapapeles!');
        } catch (err) {
            alert('No se pudo copiar: ' + err);
        }
        modal?.classList.add('hidden');
    });

    document.getElementById('btn-new')?.addEventListener('click', () => {
        if (confirm('¿Deseas iniciar una nueva captura? Los cambios no guardados se perderán.')) {
            clearCaptureDataUrl().then(() => {
                window.close(); // Cierra el editor
            });
        }
    });

    window.addEventListener('beforeunload', (e) => {
        if (historyIndex > 0) { // Si hubo cambios
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

function exportImage(format: 'png' | 'jpeg') {
    if (!currentImage || !currentImage.width || !currentImage.height) return;

    // Guardar el estado actual del viewport y dimensiones del canvas
    const prevVpt = canvas.viewportTransform ? [...canvas.viewportTransform] : [1, 0, 0, 1, 0, 0];
    const prevWidth = canvas.getWidth();
    const prevHeight = canvas.getHeight();

    // Redimensionar temporalmente el canvas al tamaño 1:1 de la imagen actual y resetear viewport
    canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    canvas.setWidth(currentImage.width);
    canvas.setHeight(currentImage.height);
    canvas.renderAll();

    const options: any = { format, multiplier: 1 };
    if (format === 'jpeg') options.quality = 0.92;
    
    const dataUrl = canvas.toDataURL(options);

    // Restaurar canvas al tamaño del viewport del workspace
    canvas.setWidth(prevWidth);
    canvas.setHeight(prevHeight);
    canvas.viewportTransform = prevVpt;
    canvas.renderAll();

    // Descargar
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = generateFilename(window.location.hostname || 'screenshot', format);
    a.click();
}

// Arrancar editor
document.addEventListener('DOMContentLoaded', initEditor);
