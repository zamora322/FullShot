import { ACTIONS } from '../shared/constants';
import { saveCaptureDataUrl } from '../shared/storage';
import { MessagePayload, PageDimensions } from '../shared/types';

let isCaptureInProgress = false;
let currentCaptureTabId: number | null = null;

/**
 * Pausa la ejecución durante N milisegundos
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
let creatingOffscreen: Promise<void> | null = null;

// Escuchar atajos de teclado (Shortcuts)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-fullpage') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      handleStartCapture(tab.id);
    }
  }
});

// Escuchar clics en el icono de la extensión o mensajes del Popup / Content Script
chrome.runtime.onMessage.addListener((message: MessagePayload, sender, sendResponse) => {
  if (message.action === ACTIONS.START_CAPTURE) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab && activeTab.id) {
        handleStartCapture(activeTab.id);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No se encontró una pestaña activa.' });
      }
    });
    return true;
  }

  if (message.action === ACTIONS.CANCEL_CAPTURE) {
    handleCancelCapture();
    sendResponse({ success: true });
    return true;
  }
});

/**
 * Valida si la URL de la pestaña es compatible
 */
function isURLCompatible(url?: string): boolean {
  if (!url) return false;
  // Chrome restringe la inyección de scripts en URLs internas del navegador y en la Chrome Web Store
  const restrictedPrefixes = [
    'chrome://',
    'chrome-extension://',
    'view-source:',
    'about:',
    'chrome.google.com/webstore',
    'chromewebstore.google.com'
  ];
  return !restrictedPrefixes.some(prefix => url.includes(prefix)) && 
         (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://'));
}

/**
 * Crea o inicializa el documento Offscreen en Manifest V3
 */
async function setupOffscreen() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  
  // Comprobar si ya existe un documento offscreen abierto
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  
  if (contexts.length > 0) {
    return;
  }
  
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  
  creatingOffscreen = chrome.offscreen.createDocument({
    url: offscreenUrl,
    reasons: ['BLOBS'],
    justification: 'Procesamiento de imágenes y Canvas para unir capturas de pantalla completa'
  });
  
  await creatingOffscreen;
  creatingOffscreen = null;
}

/**
 * Inicia el flujo de captura de la página completa
 */
async function handleStartCapture(tabId: number) {
  if (isCaptureInProgress) {
    notifyError('Ya hay un proceso de captura en ejecución.');
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isURLCompatible(tab.url)) {
      notifyError('Esta página no puede ser capturada por la extensión.');
      return;
    }

    isCaptureInProgress = true;
    currentCaptureTabId = tabId;

    // 1. Asegurar que el Offscreen document está listo
    await setupOffscreen();
    
    // Limpiar restos de capturas anteriores en el Offscreen Document
    await chrome.runtime.sendMessage({ action: ACTIONS.OFFSCREEN_CLEANUP });

    // 2. Inyectar dinámicamente el Content Script en la pestaña (por si no se ha cargado automáticamente)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });

    // 3. Solicitar las dimensiones iniciales de la página al Content Script
    const dimensionsResponse = await sendTabMessage(tabId, { action: ACTIONS.GET_DIMENSIONS });
    if (!dimensionsResponse || !dimensionsResponse.success || !dimensionsResponse.dimensions) {
      throw new Error(dimensionsResponse?.error || 'No se pudieron obtener las dimensiones de la página.');
    }

    let dimensions = dimensionsResponse.dimensions as PageDimensions;
    const { clientHeight, scrollHeight } = dimensions;

    // Calcular puntos de scroll Y
    let scrollPositions: number[] = [];
    let currentY = 0;
    
    while (currentY < scrollHeight) {
      scrollPositions.push(currentY);
      currentY += clientHeight;
    }
    
    // Asegurarse de capturar la parte inferior exacta de la página
    if (scrollPositions.length > 1) {
      const lastPos = scrollHeight - clientHeight;
      if (scrollPositions[scrollPositions.length - 1] !== lastPos && lastPos > 0) {
        // Reemplazar o añadir la última posición para que sea exactamente el borde inferior
        if (scrollPositions[scrollPositions.length - 1] > lastPos) {
          scrollPositions[scrollPositions.length - 1] = lastPos;
        } else {
          scrollPositions.push(lastPos);
        }
      }
    }

    const totalSteps = scrollPositions.length;

    // 4. Bucle progresivo de scroll y captura
    for (let i = 0; i < totalSteps; i++) {
      if (!isCaptureInProgress || currentCaptureTabId !== tabId) {
        break;
      }

      const yPos = scrollPositions[i];

      // Ordenar al Content Script hacer scroll a la posición
      const scrollResult = await sendTabMessage(tabId, { action: ACTIONS.SCROLL_TO, y: yPos });
      if (!scrollResult || !scrollResult.success) {
        throw new Error(scrollResult?.error || 'Falló el desplazamiento de página.');
      }

      // La posición de scroll real puede variar ligeramente debido al redondeo o lazy loading
      const actualY = scrollResult.y !== undefined ? scrollResult.y : yPos;

      // Esperar 350ms entre cada captura para respetar el límite de Chrome
      // (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: máximo ~2 capturas/segundo)
      await sleep(350);

      // Ocultar la UI de progreso para que no aparezca en la captura
      await sendTabMessage(tabId, { action: ACTIONS.HIDE_UI });
      await sleep(50); // Breve espera para asegurar repintado del DOM

      // Capturar la sección visible de la ventana activa en PNG
      const dataUrl = await captureTabVisibleSection(tab.windowId);
      
      // Enviar la captura capturada al documento Offscreen
      const offscreenResult = await chrome.runtime.sendMessage({
        action: ACTIONS.OFFSCREEN_ADD_PART,
        dataUrl,
        y: actualY
      });

      if (!offscreenResult || !offscreenResult.success) {
        throw new Error(offscreenResult?.error || 'Error al guardar la captura en el offscreen canvas.');
      }

      // Notificar progreso al Popup y al Content Script (overlay)
      const percentage = ((i + 1) / totalSteps) * 100;
      const progressPayload = {
        action: ACTIONS.CAPTURE_PROGRESS,
        progress: { percentage, currentStep: i + 1, totalSteps }
      };
      
      // Enviar a la pestaña (para el overlay)
      await sendTabMessage(tabId, progressPayload);
      // Enviar al Popup (si está abierto)
      chrome.runtime.sendMessage(progressPayload).catch(() => {
        // Ignorar error si el Popup está cerrado
      });

      // --- Gestión Dinámica de Lazy Loading ---
      // Después de cada scroll, volvemos a verificar si la altura del documento aumentó
      if (i < totalSteps - 1) {
        const checkDim = await sendTabMessage(tabId, { action: ACTIONS.GET_DIMENSIONS });
        if (checkDim && checkDim.success && checkDim.dimensions) {
          const newDimensions = checkDim.dimensions as PageDimensions;
          // Si la altura del documento aumentó dinámicamente
          if (newDimensions.scrollHeight > dimensions.scrollHeight) {
            console.log(`Altura dinámica detectada: aumentó de ${dimensions.scrollHeight}px a ${newDimensions.scrollHeight}px.`);
            dimensions = newDimensions; // Actualizar dimensiones de referencia
            
            // Recalcular los puntos de scroll restantes
            const remainingPositions: number[] = [];
            let nextY = scrollPositions[i] + clientHeight;
            
            while (nextY < newDimensions.scrollHeight) {
              remainingPositions.push(nextY);
              nextY += clientHeight;
            }
            
            // Forzar el final exacto
            const lastPos = newDimensions.scrollHeight - clientHeight;
            if (remainingPositions.length > 0 && remainingPositions[remainingPositions.length - 1] !== lastPos && lastPos > 0) {
              if (remainingPositions[remainingPositions.length - 1] > lastPos) {
                remainingPositions[remainingPositions.length - 1] = lastPos;
              } else {
                remainingPositions.push(lastPos);
              }
            } else if (remainingPositions.length === 0 && lastPos > scrollPositions[i]) {
              remainingPositions.push(lastPos);
            }
            
            // Reconstruir la lista de posiciones: las ya procesadas + las nuevas posiciones calculadas
            scrollPositions = [...scrollPositions.slice(0, i + 1), ...remainingPositions];
          }
        }
      }
    }

    if (!isCaptureInProgress) return;

    // 5. Finalizar: Stitching de las imágenes y descarga
    notifyStatus('Uniendo imágenes...');
    
    const stitchResult = await chrome.runtime.sendMessage({
      action: ACTIONS.OFFSCREEN_STITCH,
      width: dimensions.clientWidth,
      height: dimensions.scrollHeight,
      dimensions
    });

    if (!stitchResult || !stitchResult.success || !stitchResult.dataUrl) {
      throw new Error(stitchResult?.error || 'Falló la unión final de la captura.');
    }

    // Guardar la imagen en IndexedDB para el editor (evitar límites de RAM en mensajes)
    await saveCaptureDataUrl(stitchResult.dataUrl);

    // Abrir la pestaña del editor
    chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });

    // 6. Restaurar el estado original de la página y limpiar el offscreen
    await sendTabMessage(tabId, { action: ACTIONS.RESTORE_PAGE });
    await chrome.runtime.sendMessage({ action: ACTIONS.OFFSCREEN_CLEANUP });

    // Informar éxito al Popup
    chrome.runtime.sendMessage({ action: ACTIONS.CAPTURE_COMPLETE }).catch(() => {});

  } catch (error) {
    console.error('Error durante la captura:', error);
    notifyError((error as Error).message || 'Ocurrió un error inesperado al capturar la página.');
    
    // Intentar restaurar la página del usuario pase lo que pase
    if (currentCaptureTabId) {
      sendTabMessage(currentCaptureTabId, { action: ACTIONS.RESTORE_PAGE }).catch(() => {});
    }
  } finally {
    isCaptureInProgress = false;
    currentCaptureTabId = null;
  }
}

/**
 * Cancela el proceso de captura activo
 */
async function handleCancelCapture() {
  if (!isCaptureInProgress) return;
  
  const tabId = currentCaptureTabId;
  isCaptureInProgress = false;
  currentCaptureTabId = null;

  try {
    if (tabId) {
      // Restaurar la página del usuario
      await sendTabMessage(tabId, { action: ACTIONS.RESTORE_PAGE });
    }
    // Limpiar recursos en el Offscreen Document
    await chrome.runtime.sendMessage({ action: ACTIONS.OFFSCREEN_CLEANUP });
  } catch (e) {
    console.error('Error al cancelar la captura:', e);
  }

  // Notificar al Popup de la cancelación
  chrome.runtime.sendMessage({ action: ACTIONS.CAPTURE_ERROR, error: 'Captura cancelada por el usuario.' }).catch(() => {});
}

/**
 * Captura la pestaña visible actualmente
 */
function captureTabVisibleSection(windowId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(
      windowId,
      { format: 'png' },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!dataUrl) {
          reject(new Error('No se pudo capturar la ventana activa.'));
        } else {
          resolve(dataUrl);
        }
      }
    );
  });
}

/**
 * Envía un mensaje a una pestaña y maneja errores de comunicación de Chrome
 */
function sendTabMessage(tabId: number, message: MessagePayload): Promise<any> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      // Evitar crash si la pestaña se cerró o no responde
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Envía una notificación de error al popup
 */
function notifyError(errorMessage: string) {
  chrome.runtime.sendMessage({
    action: ACTIONS.CAPTURE_ERROR,
    error: errorMessage
  }).catch(() => {
    // Si el popup está cerrado, podemos usar una notificación de Chrome
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icons/icon-48.png',
      title: 'FullShot - Error',
      message: errorMessage
    });
  });
}

/**
 * Actualiza el estado en el Popup
 */
function notifyStatus(statusText: string) {
  chrome.runtime.sendMessage({
    action: ACTIONS.CAPTURE_PROGRESS,
    progress: { percentage: 95, currentStep: 9, totalSteps: 10 } // Estado de procesamiento final
  }).catch(() => {});
}
