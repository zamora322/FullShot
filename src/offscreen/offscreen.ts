import { ACTIONS } from '../shared/constants';
import { MessagePayload } from '../shared/types';

// Almacenamiento temporal de las partes capturadas
interface CapturedPart {
  dataUrl: string;
  y: number;
}

let capturedParts: CapturedPart[] = [];

// Escuchar mensajes del Service Worker
chrome.runtime.onMessage.addListener((message: MessagePayload, sender, sendResponse) => {
  if (message.action === ACTIONS.OFFSCREEN_ADD_PART && message.dataUrl && message.y !== undefined) {
    capturedParts.push({
      dataUrl: message.dataUrl,
      y: message.y
    });
    sendResponse({ success: true });
    return true;
  }
  
  if (message.action === ACTIONS.OFFSCREEN_STITCH && message.width && message.height && message.dimensions) {
    const { width, height, dimensions } = message;
    
    // Ejecutar asíncronamente y responder
    stitchImages(width, height, dimensions.devicePixelRatio)
      .then((dataUrl) => {
        sendResponse({ success: true, dataUrl });
      })
      .catch((error) => {
        console.error('Error al unir imágenes:', error);
        sendResponse({ success: false, error: error.message || 'Error en el proceso de stitching' });
      });
      
    return true; // Mantiene el canal abierto para respuesta asíncrona
  }
  
  if (message.action === ACTIONS.OFFSCREEN_CLEANUP) {
    capturedParts = [];
    sendResponse({ success: true });
    return true;
  }
});

/**
 * Carga una imagen a partir de un Data URL
 */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar una de las capturas temporales.'));
    img.src = dataUrl;
  });
}

/**
 * Une todas las partes capturadas en un único Canvas y devuelve el Data URL del PNG
 */
async function stitchImages(width: number, height: number, defaultDpr: number): Promise<string> {
  if (capturedParts.length === 0) {
    throw new Error('No hay capturas disponibles para unir.');
  }

  // Límites del Canvas en Chrome (usaremos 32,767 como límite superior seguro)
  const MAX_CANVAS_HEIGHT = 32767;
  const MAX_CANVAS_WIDTH = 32767;
  const MAX_CANVAS_AREA = 16384 * 16384; // Límite típico de rendimiento en muchos sistemas

  let dpr = defaultDpr;
  let canvasWidth = Math.floor(width * dpr);
  let canvasHeight = Math.floor(height * dpr);

  // Reducir DPR progresivamente si supera límites seguros para evitar desbordamiento de memoria
  if (canvasHeight > MAX_CANVAS_HEIGHT || canvasWidth > MAX_CANVAS_WIDTH || (canvasWidth * canvasHeight) > MAX_CANVAS_AREA) {
    console.warn(`Dimensiones de captura muy grandes (${canvasWidth}x${canvasHeight}). Reduciendo DPR.`);
    dpr = 1; // Reducir a DPR 1 como primer paso seguro
    canvasWidth = Math.floor(width * dpr);
    canvasHeight = Math.floor(height * dpr);
    
    // Si aún excede, limitamos la altura física al máximo permitido y notificamos en los logs
    if (canvasHeight > MAX_CANVAS_HEIGHT) {
      console.warn(`La página excede el límite máximo de canvas. Se limitará a ${MAX_CANVAS_HEIGHT} píxeles.`);
      canvasHeight = MAX_CANVAS_HEIGHT;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('No se pudo inicializar el contexto 2D del Canvas.');
  }

  // Fondo blanco por defecto para evitar transparencias si hay huecos
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Cargar y dibujar cada imagen en orden
  for (const part of capturedParts) {
    const img = await loadImage(part.dataUrl);
    
    // Ajustar la posición Y al ratio DPR utilizado en el canvas
    const drawY = Math.floor(part.y * dpr);
    
    // Ajustar el ancho y alto del dibujo al DPR del canvas.
    // La imagen capturada originalmente tiene el tamaño físico basado en el DPR original del dispositivo.
    // Por lo tanto, si reducimos el DPR del canvas a 1 pero la imagen fue capturada con DPR 2,
    // debemos redimensionarla para que quepa en el canvas reescalado.
    const drawWidth = Math.floor(img.width * (dpr / defaultDpr));
    const drawHeight = Math.floor(img.height * (dpr / defaultDpr));
    
    ctx.drawImage(img, 0, drawY, drawWidth, drawHeight);
  }

  // Generar la imagen final
  try {
    const finalDataUrl = canvas.toDataURL('image/png');
    if (!finalDataUrl || finalDataUrl === 'data:,') {
      throw new Error('El navegador no pudo exportar el canvas. Es posible que el tamaño de la imagen supere los límites de memoria física del sistema.');
    }
    return finalDataUrl;
  } catch (e) {
    throw new Error('Fallo al exportar el canvas (toDataURL): ' + (e as Error).message);
  } finally {
    // Liberar memoria limpiando las referencias de las partes
    capturedParts = [];
  }
}
