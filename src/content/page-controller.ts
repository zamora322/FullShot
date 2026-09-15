import { ACTIONS, OVERLAY_ID, PROGRESS_BAR_ID, PROGRESS_TEXT_ID, CANCEL_BUTTON_ID, STYLE_TAG_ID } from '../shared/constants';
import { MessagePayload, PageDimensions } from '../shared/types';

interface HiddenElement {
  element: HTMLElement;
  originalVisibility: string;
}

let hiddenElements: HiddenElement[] = [];
let originalScrollX = 0;
let originalScrollY = 0;
let currentScrollElement: HTMLElement | null = null;
let originalElementScrollTop = 0;
let isCapturing = false;

// Escuchar mensajes del Service Worker
chrome.runtime.onMessage.addListener((message: MessagePayload, sender, sendResponse) => {
  if (message.action === ACTIONS.GET_DIMENSIONS) {
    if (!isCapturing) {
      // Guardar el estado inicial de la página antes de la primera captura
      savePageState();
    }
    
    const dimensions = getDimensions();
    sendResponse({ success: true, dimensions });
    return true;
  }
  
  if (message.action === ACTIONS.SCROLL_TO && message.y !== undefined) {
    // Si es el primer scroll, podemos aplicar los estilos temporales y ocultar fixed/sticky
    if (!isCapturing) {
      isCapturing = true;
      preparePageForCapture();
    }
    
    scrollToPosition(message.y)
      .then((actualY) => {
        // Enviar respuesta con la posición de scroll Y real para stitching preciso
        sendResponse({ success: true, y: actualY });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      
    return true; // Asíncrono
  }
  
  if (message.action === ACTIONS.CAPTURE_PROGRESS && message.progress) {
    updateProgressUI(message.progress.percentage);
    sendResponse({ success: true });
    return true;
  }
  
  if (message.action === ACTIONS.HIDE_UI) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.style.opacity = '0';
    sendResponse({ success: true });
    return true;
  }
  
  if (message.action === ACTIONS.RESTORE_PAGE) {
    restorePageState();
    sendResponse({ success: true });
    return true;
  }
});

/**
 * Guarda el estado original del scroll y del DOM
 */
function savePageState() {
  originalScrollX = window.scrollX || window.pageXOffset;
  originalScrollY = window.scrollY || window.pageYOffset;
  if (currentScrollElement) {
    originalElementScrollTop = currentScrollElement.scrollTop;
  }
}

/**
 * Busca si existe un elemento principal en la página que contenga scroll interno relevante
 * (por ejemplo un diálogo modal, panel de administración o contenedor SPA)
 */
function findScrollableElement(): HTMLElement | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const candidates: { element: HTMLElement; score: number }[] = [];
  const allElements = document.querySelectorAll('*');

  allElements.forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.id === OVERLAY_ID || node.tagName === 'HTML' || node.tagName === 'BODY') return;
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'NOSCRIPT') return;

    const rect = node.getBoundingClientRect();
    // Debe tener un tamaño visible significativo (mínimo 100x100px)
    if (rect.width < 100 || rect.height < 100) return;
    // Debe estar dentro del viewport visible actual
    if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) return;

    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

    const overflowY = style.overflowY;
    const isOverflowScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    const scrollDiff = node.scrollHeight - node.clientHeight;

    // Si tiene scroll vertical de al menos 30 píxeles
    if (scrollDiff > 30) {
      let canScroll = isOverflowScroll || node.scrollTop > 0;
      if (!canScroll) {
        // Prueba de scroll activo
        const prev = node.scrollTop;
        node.scrollTop = prev + 1;
        if (node.scrollTop !== prev) {
          canScroll = true;
          node.scrollTop = prev;
        }
      }

      if (canScroll) {
        const area = rect.width * rect.height;
        const viewportFraction = area / (vw * vh);
        const isDialog = node.closest('[role="dialog"], [role="alertdialog"], dialog, .modal, [class*="modal"], [class*="dialog"]') !== null;
        
        let score = viewportFraction * Math.min(scrollDiff, 5000);
        if (isDialog) {
          score *= 3; // Prioridad alta para modales activos
        }
        candidates.push({ element: node, score });
      }
    }
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].element;
}

/**
 * Obtiene las dimensiones de la página activa
 */
function getDimensions(): PageDimensions {
  const body = document.body;
  const html = document.documentElement;

  // Calculamos la altura total de forma robusta
  const windowScrollHeight = Math.max(
    body.scrollHeight,
    body.offsetHeight,
    html.clientHeight,
    html.scrollHeight,
    html.offsetHeight
  );

  const windowScrollWidth = Math.max(
    body.scrollWidth,
    body.offsetWidth,
    html.clientWidth,
    html.scrollWidth,
    html.offsetWidth
  );

  const clientWidth = html.clientWidth;
  const clientHeight = html.clientHeight;
  const devicePixelRatio = window.devicePixelRatio || 1;

  const windowScrollDiff = windowScrollHeight - clientHeight;
  const scrollEl = findScrollableElement();

  // Si encontramos un elemento con scroll:
  // - Si window prácticamente no tiene scroll (< 50px de diferencia), o
  // - Si el elemento es un modal activo con scroll, o
  // - Si el elemento tiene un scroll mayor que el de la ventana
  if (scrollEl) {
    const elScrollDiff = scrollEl.scrollHeight - scrollEl.clientHeight;
    const isModal = scrollEl.closest('[role="dialog"], [role="alertdialog"], dialog, .modal, [class*="modal"], [class*="dialog"]') !== null;

    if (windowScrollDiff < 50 || isModal || elScrollDiff > windowScrollDiff) {
      currentScrollElement = scrollEl;
      const rect = scrollEl.getBoundingClientRect();

      return {
        scrollWidth: windowScrollWidth,
        scrollHeight: windowScrollHeight,
        clientWidth,
        clientHeight,
        devicePixelRatio,
        isElementScroll: true,
        elementRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        elementScrollHeight: scrollEl.scrollHeight,
        elementClientHeight: scrollEl.clientHeight
      };
    }
  }

  currentScrollElement = null;
  return {
    scrollWidth: windowScrollWidth,
    scrollHeight: windowScrollHeight,
    clientWidth,
    clientHeight,
    devicePixelRatio,
    isElementScroll: false
  };
}

/**
 * Hace scroll a una posición específica y espera a que el navegador se estabilice
 */
function scrollToPosition(y: number): Promise<number> {
  return new Promise((resolve) => {
    if (currentScrollElement) {
      currentScrollElement.scrollTop = y;
      setTimeout(() => {
        const actualY = currentScrollElement ? currentScrollElement.scrollTop : y;
        resolve(actualY);
      }, 200);
    } else {
      window.scrollTo(0, y);
      setTimeout(() => {
        const actualY = window.scrollY || window.pageYOffset || y;
        resolve(actualY);
      }, 200);
    }
  });
}

/**
 * Prepara la página web ocultando elementos fixed/sticky y desactivando transiciones
 */
function preparePageForCapture() {
  // 1. Inyectar estilos para desactivar animaciones, scroll suave y ocultar barras de scroll
  if (!document.getElementById(STYLE_TAG_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_TAG_ID;
    style.textContent = `
      html, body {
        scroll-behavior: auto !important;
      }
      * {
        animation-play-state: paused !important;
        transition: none !important;
        animation: none !important;
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
      *::-webkit-scrollbar {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  // 2. Buscar y ocultar elementos fixed y sticky
  const allElements = document.querySelectorAll('*');
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  allElements.forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    
    const style = window.getComputedStyle(el);
    const position = style.position;
    
    if (position === 'fixed' || position === 'sticky') {
      // Ignorar el overlay que inyecta nuestra propia extensión
      if (el.id === OVERLAY_ID) return;

      // Si estamos capturando un elemento específico, no ocultar el elemento ni sus ancestros ni descendientes
      if (currentScrollElement && (el === currentScrollElement || el.contains(currentScrollElement) || currentScrollElement.contains(el))) {
        return;
      }

      const rect = el.getBoundingClientRect();
      const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
      
      if (isVisible) {
        // Evitamos ocultar elementos gigantescos que actúen como contenedores principales de la app.
        // Si el elemento cubre más del 95% del viewport, asumimos que es el contenedor estructural principal.
        const isStructuralContainer = rect.width >= viewportWidth * 0.95 && rect.height >= viewportHeight * 0.95;
        
        if (!isStructuralContainer) {
          hiddenElements.push({
            element: el,
            originalVisibility: el.style.visibility
          });
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    }
  });

  // 3. Crear e inyectar el overlay de progreso
  injectProgressUI();
}

/**
 * Restaura el estado original de la página web (DOM, scroll, etc.)
 */
function restorePageState() {
  isCapturing = false;

  // 1. Remover estilos temporales
  const styleTag = document.getElementById(STYLE_TAG_ID);
  if (styleTag) {
    styleTag.remove();
  }

  // 2. Restaurar visibilidad de elementos fixed/sticky
  hiddenElements.forEach((item) => {
    if (item.element) {
      item.element.style.visibility = item.originalVisibility;
    }
  });
  hiddenElements = [];

  // 3. Remover la interfaz de progreso
  removeProgressUI();

  // 4. Restaurar posición original del scroll
  if (currentScrollElement) {
    currentScrollElement.scrollTop = originalElementScrollTop;
    currentScrollElement = null;
  }
  window.scrollTo(originalScrollX, originalScrollY);
}

/**
 * Inyecta el widget de progreso en la página activa
 */
function injectProgressUI() {
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  
  // Estilo premium del overlay con glassmorphism
  overlay.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 280px;
    padding: 20px;
    background: rgba(28, 28, 30, 0.9);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    z-index: 99999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #ffffff;
    user-select: none;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
  `;

  // Título e info
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 600;
    font-size: 15px;
    letter-spacing: 0.3px;
  `;
  header.innerHTML = `
    <span style="background: linear-gradient(135deg, #3b82f6, #60a5fa); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">FullShot</span>
    <span id="${PROGRESS_TEXT_ID}" style="font-size: 13px; color: #a1a1aa; font-weight: 500;">Capturando... 0%</span>
  `;
  overlay.appendChild(header);

  // Barra de progreso (contenedor)
  const progressContainer = document.createElement('div');
  progressContainer.style.cssText = `
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
  `;

  // Barra de progreso (interna)
  const progressBar = document.createElement('div');
  progressBar.id = PROGRESS_BAR_ID;
  progressBar.style.cssText = `
    width: 0%;
    height: 100%;
    background: linear-gradient(90deg, #3b82f6, #60a5fa);
    border-radius: 4px;
    transition: width 0.2s ease-out;
  `;
  progressContainer.appendChild(progressBar);
  overlay.appendChild(progressContainer);

  // Botón cancelar
  const cancelBtn = document.createElement('button');
  cancelBtn.id = CANCEL_BUTTON_ID;
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.style.cssText = `
    width: 100%;
    padding: 10px;
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    outline: none;
  `;

  // Efectos visuales de hover
  cancelBtn.onmouseenter = () => {
    cancelBtn.style.background = 'rgba(239, 68, 68, 0.25)';
    cancelBtn.style.borderColor = 'rgba(239, 68, 68, 0.5)';
  };
  cancelBtn.onmouseleave = () => {
    cancelBtn.style.background = 'rgba(239, 68, 68, 0.15)';
    cancelBtn.style.borderColor = 'rgba(239, 68, 68, 0.3)';
  };

  // Evento cancelar
  cancelBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: ACTIONS.CANCEL_CAPTURE });
  });

  overlay.appendChild(cancelBtn);
  document.body.appendChild(overlay);
}

/**
 * Actualiza la barra de progreso del overlay en la página web
 */
function updateProgressUI(percentage: number) {
  const overlay = document.getElementById(OVERLAY_ID);
  const bar = document.getElementById(PROGRESS_BAR_ID);
  const text = document.getElementById(PROGRESS_TEXT_ID);
  
  if (overlay) {
    overlay.style.opacity = '1';
  }
  if (bar) {
    bar.style.width = `${percentage}%`;
  }
  if (text) {
    text.textContent = `Capturando... ${Math.round(percentage)}%`;
  }
}

/**
 * Remueve el overlay de progreso del DOM
 */
function removeProgressUI() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.remove();
  }
}
