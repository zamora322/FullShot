import { ACTIONS } from '../shared/constants';
import { MessagePayload, PageDimensions } from '../shared/types';

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
    stitchImages(width, height, dimensions.devicePixelRatio, dimensions)
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
async function stitchImages(
  width: number,
  height: number,
  defaultDpr: number,
  dimensions?: PageDimensions
): Promise<string> {
  if (capturedParts.length === 0) {
    throw new Error('No hay capturas disponibles para unir.');
  }

  // Límites del Canvas en Chrome (usaremos 32,767 como límite superior seguro)
  const MAX_CANVAS_HEIGHT = 32767;
  const MAX_CANVAS_WIDTH = 32767;
  const MAX_CANVAS_AREA = 16384 * 16384; // Límite típico de rendimiento en muchos sistemas

  const isElementScroll = !!(
    dimensions &&
    dimensions.isElementScroll &&
    dimensions.elementRect &&
    dimensions.elementScrollHeight &&
    dimensions.elementClientHeight
  );

  let dpr = defaultDpr;
  let canvasWidth = Math.floor(width * dpr);
  let canvasHeight = 0;

  if (isElementScroll && dimensions && dimensions.elementRect && dimensions.elementScrollHeight && dimensions.elementClientHeight) {
    const extraScroll = Math.max(0, dimensions.elementScrollHeight - dimensions.elementClientHeight);
    const totalCssHeight = dimensions.clientHeight + extraScroll;
    canvasHeight = Math.floor(totalCssHeight * dpr);
  } else {
    canvasHeight = Math.floor(height * dpr);
  }

  // Reducir DPR progresivamente si supera límites seguros para evitar desbordamiento de memoria
  if (canvasHeight > MAX_CANVAS_HEIGHT || canvasWidth > MAX_CANVAS_WIDTH || (canvasWidth * canvasHeight) > MAX_CANVAS_AREA) {
    console.warn(`Dimensiones de captura muy grandes (${canvasWidth}x${canvasHeight}). Reduciendo DPR.`);
    dpr = 1; // Reducir a DPR 1 como primer paso seguro
    canvasWidth = Math.floor(width * dpr);
    if (isElementScroll && dimensions && dimensions.elementRect && dimensions.elementScrollHeight && dimensions.elementClientHeight) {
      const extraScroll = Math.max(0, dimensions.elementScrollHeight - dimensions.elementClientHeight);
      const totalCssHeight = dimensions.clientHeight + extraScroll;
      canvasHeight = Math.floor(totalCssHeight * dpr);
    } else {
      canvasHeight = Math.floor(height * dpr);
    }
    
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

  if (isElementScroll && dimensions && dimensions.elementRect && dimensions.elementScrollHeight && dimensions.elementClientHeight) {
    // --- STITCHING PARA CONTENEDOR CON SCROLL INTERNO ---
    const { elementRect, elementScrollHeight } = dimensions;

    const srcDpr = defaultDpr;
    const destDpr = dpr;

    const srcElX = Math.floor(elementRect.left * srcDpr);
    const srcElY = Math.floor(elementRect.top * srcDpr);
    const srcElW = Math.floor(elementRect.width * srcDpr);
    const srcElH = Math.floor(elementRect.height * srcDpr);

    const destElX = Math.floor(elementRect.left * destDpr);
    const destElY = Math.floor(elementRect.top * destDpr);
    const destElW = Math.floor(elementRect.width * destDpr);
    const destElH = Math.floor(elementRect.height * destDpr);
    const destTotalElH = Math.floor(elementScrollHeight * destDpr);

    const firstImg = await loadImage(capturedParts[0].dataUrl);
    const lastImg = await loadImage(capturedParts[capturedParts.length - 1].dataUrl);

    // 1. Región superior (por encima del elemento con scroll: barra de navegación, pestañas, cabecera modal, etc.)
    if (destElY > 0 && srcElY > 0) {
      ctx.drawImage(firstImg, 0, 0, firstImg.width, srcElY, 0, 0, canvasWidth, destElY);
    }

    // 2. Región inferior (por debajo del elemento con scroll: botones Guardar/Cancelar, pie de página, etc.)
    const bottomSrcY = srcElY + srcElH;
    const bottomSrcH = firstImg.height - bottomSrcY;
    if (bottomSrcH > 0) {
      const bottomDestY = destElY + destTotalElH;
      const bottomDestH = Math.max(0, canvasHeight - bottomDestY);
      if (bottomDestH > 0) {
        ctx.drawImage(lastImg, 0, bottomSrcY, lastImg.width, bottomSrcH, 0, bottomDestY, canvasWidth, bottomDestH);
      }
    }

    // 3. Márgenes laterales (fondo a los lados del elemento, replicados a lo largo de la altura expandida)
    const sideDestStart = destElY;
    const sideDestEnd = destElY + destTotalElH;
    const sideSliceH_dest = destElH;

    for (let y = sideDestStart; y < sideDestEnd; y += sideSliceH_dest) {
      const currentDestH = Math.min(sideSliceH_dest, sideDestEnd - y);
      const currentSrcH = Math.min(srcElH, Math.floor(currentDestH * (srcDpr / destDpr)));

      // Margen izquierdo
      if (destElX > 0 && srcElX > 0) {
        ctx.drawImage(firstImg, 0, srcElY, srcElX, currentSrcH, 0, y, destElX, currentDestH);
      }
      // Margen derecho
      const rightSrcX = srcElX + srcElW;
      const rightSrcW = firstImg.width - rightSrcX;
      const rightDestX = destElX + destElW;
      const rightDestW = canvasWidth - rightDestX;
      if (rightDestW > 0 && rightSrcW > 0) {
        ctx.drawImage(firstImg, rightSrcX, srcElY, rightSrcW, currentSrcH, rightDestX, y, rightDestW, currentDestH);
      }
    }

    // 4. Secciones del elemento con scroll (ensambladas en orden exacto según su scrollTop)
    for (const part of capturedParts) {
      const img = await loadImage(part.dataUrl);
      const sliceDestY = destElY + Math.floor(part.y * destDpr);
      ctx.drawImage(img, srcElX, srcElY, srcElW, srcElH, destElX, sliceDestY, destElW, destElH);
    }
  } else {
    // --- STITCHING ESTÁNDAR PARA SCROLL DE VENTANA ---
    for (const part of capturedParts) {
      const img = await loadImage(part.dataUrl);
      
      const drawY = Math.floor(part.y * dpr);
      const drawWidth = Math.floor(img.width * (dpr / defaultDpr));
      const drawHeight = Math.floor(img.height * (dpr / defaultDpr));
      
      ctx.drawImage(img, 0, drawY, drawWidth, drawHeight);
    }
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
