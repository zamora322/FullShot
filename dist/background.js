"use strict";
(() => {
  // src/shared/constants.ts
  var ACTIONS = {
    START_CAPTURE: "START_CAPTURE",
    CANCEL_CAPTURE: "CANCEL_CAPTURE",
    CAPTURE_PROGRESS: "CAPTURE_PROGRESS",
    CAPTURE_COMPLETE: "CAPTURE_COMPLETE",
    CAPTURE_ERROR: "CAPTURE_ERROR",
    // Mensajes entre Service Worker y Content Script
    GET_DIMENSIONS: "GET_DIMENSIONS",
    SCROLL_TO: "SCROLL_TO",
    RESTORE_PAGE: "RESTORE_PAGE",
    HIDE_UI: "HIDE_UI",
    // Mensajes para el Offscreen Document
    OFFSCREEN_INIT_CANVAS: "OFFSCREEN_INIT_CANVAS",
    OFFSCREEN_ADD_PART: "OFFSCREEN_ADD_PART",
    OFFSCREEN_STITCH: "OFFSCREEN_STITCH",
    OFFSCREEN_CLEANUP: "OFFSCREEN_CLEANUP"
  };

  // src/shared/storage.ts
  var DB_NAME = "FullShotDB";
  var DB_VERSION = 1;
  var STORE_NAME = "captures";
  var CAPTURE_KEY = "latest_capture";
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    });
  }
  async function saveCaptureDataUrl(dataUrl) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(dataUrl, CAPTURE_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // src/background/service-worker.ts
  var isCaptureInProgress = false;
  var currentCaptureTabId = null;
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  var creatingOffscreen = null;
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === "capture-fullpage") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        handleStartCapture(tab.id);
      }
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === ACTIONS.START_CAPTURE) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (activeTab && activeTab.id) {
          handleStartCapture(activeTab.id);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "No se encontr\xF3 una pesta\xF1a activa." });
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
  function isURLCompatible(url) {
    if (!url)
      return false;
    const restrictedPrefixes = [
      "chrome://",
      "chrome-extension://",
      "view-source:",
      "about:",
      "chrome.google.com/webstore",
      "chromewebstore.google.com"
    ];
    return !restrictedPrefixes.some((prefix) => url.includes(prefix)) && (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://"));
  }
  async function setupOffscreen() {
    const offscreenUrl = chrome.runtime.getURL("offscreen.html");
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
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
      reasons: ["BLOBS"],
      justification: "Procesamiento de im\xE1genes y Canvas para unir capturas de pantalla completa"
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
  async function handleStartCapture(tabId) {
    if (isCaptureInProgress) {
      notifyError("Ya hay un proceso de captura en ejecuci\xF3n.");
      return;
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isURLCompatible(tab.url)) {
        notifyError("Esta p\xE1gina no puede ser capturada por la extensi\xF3n.");
        return;
      }
      isCaptureInProgress = true;
      currentCaptureTabId = tabId;
      await setupOffscreen();
      await chrome.runtime.sendMessage({ action: ACTIONS.OFFSCREEN_CLEANUP });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      const dimensionsResponse = await sendTabMessage(tabId, { action: ACTIONS.GET_DIMENSIONS });
      if (!dimensionsResponse || !dimensionsResponse.success || !dimensionsResponse.dimensions) {
        throw new Error(dimensionsResponse?.error || "No se pudieron obtener las dimensiones de la p\xE1gina.");
      }
      let dimensions = dimensionsResponse.dimensions;
      const isElementScroll = !!dimensions.isElementScroll;
      const clientHeight = isElementScroll && dimensions.elementClientHeight ? dimensions.elementClientHeight : dimensions.clientHeight;
      const scrollHeight = isElementScroll && dimensions.elementScrollHeight ? dimensions.elementScrollHeight : dimensions.scrollHeight;
      let scrollPositions = [];
      let currentY = 0;
      while (currentY < scrollHeight) {
        scrollPositions.push(currentY);
        currentY += clientHeight;
      }
      if (scrollPositions.length > 1) {
        const lastPos = scrollHeight - clientHeight;
        if (scrollPositions[scrollPositions.length - 1] !== lastPos && lastPos > 0) {
          if (scrollPositions[scrollPositions.length - 1] > lastPos) {
            scrollPositions[scrollPositions.length - 1] = lastPos;
          } else {
            scrollPositions.push(lastPos);
          }
        }
      }
      const totalSteps = scrollPositions.length;
      for (let i = 0; i < totalSteps; i++) {
        if (!isCaptureInProgress || currentCaptureTabId !== tabId) {
          break;
        }
        const yPos = scrollPositions[i];
        const scrollResult = await sendTabMessage(tabId, { action: ACTIONS.SCROLL_TO, y: yPos });
        if (!scrollResult || !scrollResult.success) {
          throw new Error(scrollResult?.error || "Fall\xF3 el desplazamiento de p\xE1gina.");
        }
        const actualY = scrollResult.y !== void 0 ? scrollResult.y : yPos;
        await sleep(350);
        await sendTabMessage(tabId, { action: ACTIONS.HIDE_UI });
        await sleep(50);
        const dataUrl = await captureTabVisibleSection(tab.windowId);
        const offscreenResult = await chrome.runtime.sendMessage({
          action: ACTIONS.OFFSCREEN_ADD_PART,
          dataUrl,
          y: actualY
        });
        if (!offscreenResult || !offscreenResult.success) {
          throw new Error(offscreenResult?.error || "Error al guardar la captura en el offscreen canvas.");
        }
        const percentage = (i + 1) / totalSteps * 100;
        const progressPayload = {
          action: ACTIONS.CAPTURE_PROGRESS,
          progress: { percentage, currentStep: i + 1, totalSteps }
        };
        await sendTabMessage(tabId, progressPayload);
        chrome.runtime.sendMessage(progressPayload).catch(() => {
        });
        if (i < totalSteps - 1) {
          const checkDim = await sendTabMessage(tabId, { action: ACTIONS.GET_DIMENSIONS });
          if (checkDim && checkDim.success && checkDim.dimensions) {
            const newDimensions = checkDim.dimensions;
            const currentTotalHeight = isElementScroll ? dimensions.elementScrollHeight || 0 : dimensions.scrollHeight;
            const newTotalHeight = isElementScroll ? newDimensions.elementScrollHeight || 0 : newDimensions.scrollHeight;
            if (newTotalHeight > currentTotalHeight) {
              console.log(`Altura din\xE1mica detectada: aument\xF3 de ${currentTotalHeight}px a ${newTotalHeight}px.`);
              dimensions = newDimensions;
              const remainingPositions = [];
              let nextY = scrollPositions[i] + clientHeight;
              while (nextY < newTotalHeight) {
                remainingPositions.push(nextY);
                nextY += clientHeight;
              }
              const lastPos = newTotalHeight - clientHeight;
              if (remainingPositions.length > 0 && remainingPositions[remainingPositions.length - 1] !== lastPos && lastPos > 0) {
                if (remainingPositions[remainingPositions.length - 1] > lastPos) {
                  remainingPositions[remainingPositions.length - 1] = lastPos;
                } else {
                  remainingPositions.push(lastPos);
                }
              } else if (remainingPositions.length === 0 && lastPos > scrollPositions[i]) {
                remainingPositions.push(lastPos);
              }
              scrollPositions = [...scrollPositions.slice(0, i + 1), ...remainingPositions];
            }
          }
        }
      }
      if (!isCaptureInProgress)
        return;
      notifyStatus("Uniendo im\xE1genes...");
      const stitchResult = await chrome.runtime.sendMessage({
        action: ACTIONS.OFFSCREEN_STITCH,
        width: dimensions.clientWidth,
        height: dimensions.scrollHeight,
        dimensions
      });
      if (!stitchResult || !stitchResult.success || !stitchResult.dataUrl) {
        throw new Error(stitchResult?.error || "Fall\xF3 la uni\xF3n final de la captura.");
      }
      await saveCaptureDataUrl(stitchResult.dataUrl);
      chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
      await sendTabMessage(tabId, { action: ACTIONS.RESTORE_PAGE });
      await chrome.runtime.sendMessage({ action: ACTIONS.OFFSCREEN_CLEANUP });
      chrome.runtime.sendMessage({ action: ACTIONS.CAPTURE_COMPLETE }).catch(() => {
      });
    } catch (error) {
      console.error("Error durante la captura:", error);
      notifyError(error.message || "Ocurri\xF3 un error inesperado al capturar la p\xE1gina.");
      if (currentCaptureTabId) {
        sendTabMessage(currentCaptureTabId, { action: ACTIONS.RESTORE_PAGE }).catch(() => {
        });
      }
    } finally {
      isCaptureInProgress = false;
      currentCaptureTabId = null;
    }
  }
  async function handleCancelCapture() {
    if (!isCaptureInProgress)
      return;
    const tabId = currentCaptureTabId;
    isCaptureInProgress = false;
    currentCaptureTabId = null;
    try {
      if (tabId) {
        await sendTabMessage(tabId, { action: ACTIONS.RESTORE_PAGE });
      }
      await chrome.runtime.sendMessage({ action: ACTIONS.OFFSCREEN_CLEANUP });
    } catch (e) {
      console.error("Error al cancelar la captura:", e);
    }
    chrome.runtime.sendMessage({ action: ACTIONS.CAPTURE_ERROR, error: "Captura cancelada por el usuario." }).catch(() => {
    });
  }
  function captureTabVisibleSection(windowId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(
        windowId,
        { format: "png" },
        (dataUrl) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!dataUrl) {
            reject(new Error("No se pudo capturar la ventana activa."));
          } else {
            resolve(dataUrl);
          }
        }
      );
    });
  }
  function sendTabMessage(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }
  function notifyError(errorMessage) {
    chrome.runtime.sendMessage({
      action: ACTIONS.CAPTURE_ERROR,
      error: errorMessage
    }).catch(() => {
      chrome.notifications?.create({
        type: "basic",
        iconUrl: "icons/icon-48.png",
        title: "FullShot - Error",
        message: errorMessage
      });
    });
  }
  function notifyStatus(statusText) {
    chrome.runtime.sendMessage({
      action: ACTIONS.CAPTURE_PROGRESS,
      progress: { percentage: 95, currentStep: 9, totalSteps: 10 }
      // Estado de procesamiento final
    }).catch(() => {
    });
  }
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3NoYXJlZC9jb25zdGFudHMudHMiLCAiLi4vc3JjL3NoYXJlZC9zdG9yYWdlLnRzIiwgIi4uL3NyYy9iYWNrZ3JvdW5kL3NlcnZpY2Utd29ya2VyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJleHBvcnQgY29uc3QgQUNUSU9OUyA9IHtcclxuICBTVEFSVF9DQVBUVVJFOiAnU1RBUlRfQ0FQVFVSRScsXHJcbiAgQ0FOQ0VMX0NBUFRVUkU6ICdDQU5DRUxfQ0FQVFVSRScsXHJcbiAgQ0FQVFVSRV9QUk9HUkVTUzogJ0NBUFRVUkVfUFJPR1JFU1MnLFxyXG4gIENBUFRVUkVfQ09NUExFVEU6ICdDQVBUVVJFX0NPTVBMRVRFJyxcclxuICBDQVBUVVJFX0VSUk9SOiAnQ0FQVFVSRV9FUlJPUicsXHJcbiAgXHJcbiAgLy8gTWVuc2FqZXMgZW50cmUgU2VydmljZSBXb3JrZXIgeSBDb250ZW50IFNjcmlwdFxyXG4gIEdFVF9ESU1FTlNJT05TOiAnR0VUX0RJTUVOU0lPTlMnLFxyXG4gIFNDUk9MTF9UTzogJ1NDUk9MTF9UTycsXHJcbiAgUkVTVE9SRV9QQUdFOiAnUkVTVE9SRV9QQUdFJyxcclxuICBISURFX1VJOiAnSElERV9VSScsXHJcbiAgXHJcbiAgLy8gTWVuc2FqZXMgcGFyYSBlbCBPZmZzY3JlZW4gRG9jdW1lbnRcclxuICBPRkZTQ1JFRU5fSU5JVF9DQU5WQVM6ICdPRkZTQ1JFRU5fSU5JVF9DQU5WQVMnLFxyXG4gIE9GRlNDUkVFTl9BRERfUEFSVDogJ09GRlNDUkVFTl9BRERfUEFSVCcsXHJcbiAgT0ZGU0NSRUVOX1NUSVRDSDogJ09GRlNDUkVFTl9TVElUQ0gnLFxyXG4gIE9GRlNDUkVFTl9DTEVBTlVQOiAnT0ZGU0NSRUVOX0NMRUFOVVAnXHJcbn0gYXMgY29uc3Q7XHJcblxyXG5leHBvcnQgY29uc3QgT1ZFUkxBWV9JRCA9ICdmdWxsc2hvdC1jYXB0dXJlLW92ZXJsYXknO1xyXG5leHBvcnQgY29uc3QgUFJPR1JFU1NfQkFSX0lEID0gJ2Z1bGxzaG90LXByb2dyZXNzLWJhcic7XHJcbmV4cG9ydCBjb25zdCBQUk9HUkVTU19URVhUX0lEID0gJ2Z1bGxzaG90LXByb2dyZXNzLXRleHQnO1xyXG5leHBvcnQgY29uc3QgQ0FOQ0VMX0JVVFRPTl9JRCA9ICdmdWxsc2hvdC1jYW5jZWwtYnV0dG9uJztcclxuZXhwb3J0IGNvbnN0IFNUWUxFX1RBR19JRCA9ICdmdWxsc2hvdC10ZW1wb3Jhcnktc3R5bGVzJztcclxuIiwgImNvbnN0IERCX05BTUUgPSAnRnVsbFNob3REQic7XHJcbmNvbnN0IERCX1ZFUlNJT04gPSAxO1xyXG5jb25zdCBTVE9SRV9OQU1FID0gJ2NhcHR1cmVzJztcclxuY29uc3QgQ0FQVFVSRV9LRVkgPSAnbGF0ZXN0X2NhcHR1cmUnO1xyXG5cclxuLyoqXHJcbiAqIEFicmUgbGEgY29uZXhpXHUwMEYzbiBhIEluZGV4ZWREQiBwYXJhIGxhIGV4dGVuc2lcdTAwRjNuXHJcbiAqL1xyXG5mdW5jdGlvbiBvcGVuREIoKTogUHJvbWlzZTxJREJEYXRhYmFzZT4ge1xyXG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICBjb25zdCByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4oREJfTkFNRSwgREJfVkVSU0lPTik7XHJcbiAgICBcclxuICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcclxuICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4gcmVzb2x2ZShyZXF1ZXN0LnJlc3VsdCk7XHJcbiAgICBcclxuICAgIHJlcXVlc3Qub251cGdyYWRlbmVlZGVkID0gKGV2ZW50KSA9PiB7XHJcbiAgICAgIGNvbnN0IGRiID0gKGV2ZW50LnRhcmdldCBhcyBJREJPcGVuREJSZXF1ZXN0KS5yZXN1bHQ7XHJcbiAgICAgIGlmICghZGIub2JqZWN0U3RvcmVOYW1lcy5jb250YWlucyhTVE9SRV9OQU1FKSkge1xyXG4gICAgICAgIGRiLmNyZWF0ZU9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xyXG4gICAgICB9XHJcbiAgICB9O1xyXG4gIH0pO1xyXG59XHJcblxyXG4vKipcclxuICogR3VhcmRhIGVsIERhdGFVUkwgZGUgbGEgY2FwdHVyYSBjb21wbGV0YSBlbiBJbmRleGVkREJcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlQ2FwdHVyZURhdGFVcmwoZGF0YVVybDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgZGIgPSBhd2FpdCBvcGVuREIoKTtcclxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihbU1RPUkVfTkFNRV0sICdyZWFkd3JpdGUnKTtcclxuICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoU1RPUkVfTkFNRSk7XHJcbiAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUucHV0KGRhdGFVcmwsIENBUFRVUkVfS0VZKTtcclxuICAgIFxyXG4gICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiByZXNvbHZlKCk7XHJcbiAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZWN1cGVyYSBlbCBEYXRhVVJMIGRlIGxhIGNhcHR1cmEgY29tcGxldGEgZGVzZGUgSW5kZXhlZERCXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0Q2FwdHVyZURhdGFVcmwoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XHJcbiAgY29uc3QgZGIgPSBhd2FpdCBvcGVuREIoKTtcclxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihbU1RPUkVfTkFNRV0sICdyZWFkb25seScpO1xyXG4gICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcclxuICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXQoQ0FQVFVSRV9LRVkpO1xyXG4gICAgXHJcbiAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUocmVxdWVzdC5yZXN1bHQgfHwgbnVsbCk7XHJcbiAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFbGltaW5hIGxhIGNhcHR1cmEgYWN0dWFsIHBhcmEgbGliZXJhciBlc3BhY2lvXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xlYXJDYXB0dXJlRGF0YVVybCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBkYiA9IGF3YWl0IG9wZW5EQigpO1xyXG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKFtTVE9SRV9OQU1FXSwgJ3JlYWR3cml0ZScpO1xyXG4gICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcclxuICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5kZWxldGUoQ0FQVFVSRV9LRVkpO1xyXG4gICAgXHJcbiAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUoKTtcclxuICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcclxuICB9KTtcclxufVxyXG4iLCAiaW1wb3J0IHsgQUNUSU9OUyB9IGZyb20gJy4uL3NoYXJlZC9jb25zdGFudHMnO1xyXG5pbXBvcnQgeyBzYXZlQ2FwdHVyZURhdGFVcmwgfSBmcm9tICcuLi9zaGFyZWQvc3RvcmFnZSc7XHJcbmltcG9ydCB7IE1lc3NhZ2VQYXlsb2FkLCBQYWdlRGltZW5zaW9ucyB9IGZyb20gJy4uL3NoYXJlZC90eXBlcyc7XHJcblxyXG5sZXQgaXNDYXB0dXJlSW5Qcm9ncmVzcyA9IGZhbHNlO1xyXG5sZXQgY3VycmVudENhcHR1cmVUYWJJZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XHJcblxyXG4vKipcclxuICogUGF1c2EgbGEgZWplY3VjaVx1MDBGM24gZHVyYW50ZSBOIG1pbGlzZWd1bmRvc1xyXG4gKi9cclxuZnVuY3Rpb24gc2xlZXAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xyXG4gIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcclxufVxyXG5sZXQgY3JlYXRpbmdPZmZzY3JlZW46IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcclxuXHJcbi8vIEVzY3VjaGFyIGF0YWpvcyBkZSB0ZWNsYWRvIChTaG9ydGN1dHMpXHJcbmNocm9tZS5jb21tYW5kcy5vbkNvbW1hbmQuYWRkTGlzdGVuZXIoYXN5bmMgKGNvbW1hbmQpID0+IHtcclxuICBpZiAoY29tbWFuZCA9PT0gJ2NhcHR1cmUtZnVsbHBhZ2UnKSB7XHJcbiAgICBjb25zdCBbdGFiXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCBjdXJyZW50V2luZG93OiB0cnVlIH0pO1xyXG4gICAgaWYgKHRhYiAmJiB0YWIuaWQpIHtcclxuICAgICAgaGFuZGxlU3RhcnRDYXB0dXJlKHRhYi5pZCk7XHJcbiAgICB9XHJcbiAgfVxyXG59KTtcclxuXHJcbi8vIEVzY3VjaGFyIGNsaWNzIGVuIGVsIGljb25vIGRlIGxhIGV4dGVuc2lcdTAwRjNuIG8gbWVuc2FqZXMgZGVsIFBvcHVwIC8gQ29udGVudCBTY3JpcHRcclxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlOiBNZXNzYWdlUGF5bG9hZCwgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcclxuICBpZiAobWVzc2FnZS5hY3Rpb24gPT09IEFDVElPTlMuU1RBUlRfQ0FQVFVSRSkge1xyXG4gICAgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIGN1cnJlbnRXaW5kb3c6IHRydWUgfSwgKHRhYnMpID0+IHtcclxuICAgICAgY29uc3QgYWN0aXZlVGFiID0gdGFic1swXTtcclxuICAgICAgaWYgKGFjdGl2ZVRhYiAmJiBhY3RpdmVUYWIuaWQpIHtcclxuICAgICAgICBoYW5kbGVTdGFydENhcHR1cmUoYWN0aXZlVGFiLmlkKTtcclxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogJ05vIHNlIGVuY29udHJcdTAwRjMgdW5hIHBlc3RhXHUwMEYxYSBhY3RpdmEuJyB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gdHJ1ZTtcclxuICB9XHJcblxyXG4gIGlmIChtZXNzYWdlLmFjdGlvbiA9PT0gQUNUSU9OUy5DQU5DRUxfQ0FQVFVSRSkge1xyXG4gICAgaGFuZGxlQ2FuY2VsQ2FwdHVyZSgpO1xyXG4gICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcclxuICAgIHJldHVybiB0cnVlO1xyXG4gIH1cclxufSk7XHJcblxyXG4vKipcclxuICogVmFsaWRhIHNpIGxhIFVSTCBkZSBsYSBwZXN0YVx1MDBGMWEgZXMgY29tcGF0aWJsZVxyXG4gKi9cclxuZnVuY3Rpb24gaXNVUkxDb21wYXRpYmxlKHVybD86IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gIGlmICghdXJsKSByZXR1cm4gZmFsc2U7XHJcbiAgLy8gQ2hyb21lIHJlc3RyaW5nZSBsYSBpbnllY2NpXHUwMEYzbiBkZSBzY3JpcHRzIGVuIFVSTHMgaW50ZXJuYXMgZGVsIG5hdmVnYWRvciB5IGVuIGxhIENocm9tZSBXZWIgU3RvcmVcclxuICBjb25zdCByZXN0cmljdGVkUHJlZml4ZXMgPSBbXHJcbiAgICAnY2hyb21lOi8vJyxcclxuICAgICdjaHJvbWUtZXh0ZW5zaW9uOi8vJyxcclxuICAgICd2aWV3LXNvdXJjZTonLFxyXG4gICAgJ2Fib3V0OicsXHJcbiAgICAnY2hyb21lLmdvb2dsZS5jb20vd2Vic3RvcmUnLFxyXG4gICAgJ2Nocm9tZXdlYnN0b3JlLmdvb2dsZS5jb20nXHJcbiAgXTtcclxuICByZXR1cm4gIXJlc3RyaWN0ZWRQcmVmaXhlcy5zb21lKHByZWZpeCA9PiB1cmwuaW5jbHVkZXMocHJlZml4KSkgJiYgXHJcbiAgICAgICAgICh1cmwuc3RhcnRzV2l0aCgnaHR0cDovLycpIHx8IHVybC5zdGFydHNXaXRoKCdodHRwczovLycpIHx8IHVybC5zdGFydHNXaXRoKCdmaWxlOi8vJykpO1xyXG59XHJcblxyXG4vKipcclxuICogQ3JlYSBvIGluaWNpYWxpemEgZWwgZG9jdW1lbnRvIE9mZnNjcmVlbiBlbiBNYW5pZmVzdCBWM1xyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gc2V0dXBPZmZzY3JlZW4oKSB7XHJcbiAgY29uc3Qgb2Zmc2NyZWVuVXJsID0gY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdvZmZzY3JlZW4uaHRtbCcpO1xyXG4gIFxyXG4gIC8vIENvbXByb2JhciBzaSB5YSBleGlzdGUgdW4gZG9jdW1lbnRvIG9mZnNjcmVlbiBhYmllcnRvXHJcbiAgY29uc3QgY29udGV4dHMgPSBhd2FpdCBjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cyh7XHJcbiAgICBjb250ZXh0VHlwZXM6IFsnT0ZGU0NSRUVOX0RPQ1VNRU5UJ10sXHJcbiAgICBkb2N1bWVudFVybHM6IFtvZmZzY3JlZW5VcmxdXHJcbiAgfSk7XHJcbiAgXHJcbiAgaWYgKGNvbnRleHRzLmxlbmd0aCA+IDApIHtcclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgXHJcbiAgaWYgKGNyZWF0aW5nT2Zmc2NyZWVuKSB7XHJcbiAgICBhd2FpdCBjcmVhdGluZ09mZnNjcmVlbjtcclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgXHJcbiAgY3JlYXRpbmdPZmZzY3JlZW4gPSBjaHJvbWUub2Zmc2NyZWVuLmNyZWF0ZURvY3VtZW50KHtcclxuICAgIHVybDogb2Zmc2NyZWVuVXJsLFxyXG4gICAgcmVhc29uczogWydCTE9CUyddLFxyXG4gICAganVzdGlmaWNhdGlvbjogJ1Byb2Nlc2FtaWVudG8gZGUgaW1cdTAwRTFnZW5lcyB5IENhbnZhcyBwYXJhIHVuaXIgY2FwdHVyYXMgZGUgcGFudGFsbGEgY29tcGxldGEnXHJcbiAgfSk7XHJcbiAgXHJcbiAgYXdhaXQgY3JlYXRpbmdPZmZzY3JlZW47XHJcbiAgY3JlYXRpbmdPZmZzY3JlZW4gPSBudWxsO1xyXG59XHJcblxyXG4vKipcclxuICogSW5pY2lhIGVsIGZsdWpvIGRlIGNhcHR1cmEgZGUgbGEgcFx1MDBFMWdpbmEgY29tcGxldGFcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVN0YXJ0Q2FwdHVyZSh0YWJJZDogbnVtYmVyKSB7XHJcbiAgaWYgKGlzQ2FwdHVyZUluUHJvZ3Jlc3MpIHtcclxuICAgIG5vdGlmeUVycm9yKCdZYSBoYXkgdW4gcHJvY2VzbyBkZSBjYXB0dXJhIGVuIGVqZWN1Y2lcdTAwRjNuLicpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuXHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmdldCh0YWJJZCk7XHJcbiAgICBpZiAoIWlzVVJMQ29tcGF0aWJsZSh0YWIudXJsKSkge1xyXG4gICAgICBub3RpZnlFcnJvcignRXN0YSBwXHUwMEUxZ2luYSBubyBwdWVkZSBzZXIgY2FwdHVyYWRhIHBvciBsYSBleHRlbnNpXHUwMEYzbi4nKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGlzQ2FwdHVyZUluUHJvZ3Jlc3MgPSB0cnVlO1xyXG4gICAgY3VycmVudENhcHR1cmVUYWJJZCA9IHRhYklkO1xyXG5cclxuICAgIC8vIDEuIEFzZWd1cmFyIHF1ZSBlbCBPZmZzY3JlZW4gZG9jdW1lbnQgZXN0XHUwMEUxIGxpc3RvXHJcbiAgICBhd2FpdCBzZXR1cE9mZnNjcmVlbigpO1xyXG4gICAgXHJcbiAgICAvLyBMaW1waWFyIHJlc3RvcyBkZSBjYXB0dXJhcyBhbnRlcmlvcmVzIGVuIGVsIE9mZnNjcmVlbiBEb2N1bWVudFxyXG4gICAgYXdhaXQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyBhY3Rpb246IEFDVElPTlMuT0ZGU0NSRUVOX0NMRUFOVVAgfSk7XHJcblxyXG4gICAgLy8gMi4gSW55ZWN0YXIgZGluXHUwMEUxbWljYW1lbnRlIGVsIENvbnRlbnQgU2NyaXB0IGVuIGxhIHBlc3RhXHUwMEYxYSAocG9yIHNpIG5vIHNlIGhhIGNhcmdhZG8gYXV0b21cdTAwRTF0aWNhbWVudGUpXHJcbiAgICBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xyXG4gICAgICB0YXJnZXQ6IHsgdGFiSWQgfSxcclxuICAgICAgZmlsZXM6IFsnY29udGVudC5qcyddXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAzLiBTb2xpY2l0YXIgbGFzIGRpbWVuc2lvbmVzIGluaWNpYWxlcyBkZSBsYSBwXHUwMEUxZ2luYSBhbCBDb250ZW50IFNjcmlwdFxyXG4gICAgY29uc3QgZGltZW5zaW9uc1Jlc3BvbnNlID0gYXdhaXQgc2VuZFRhYk1lc3NhZ2UodGFiSWQsIHsgYWN0aW9uOiBBQ1RJT05TLkdFVF9ESU1FTlNJT05TIH0pO1xyXG4gICAgaWYgKCFkaW1lbnNpb25zUmVzcG9uc2UgfHwgIWRpbWVuc2lvbnNSZXNwb25zZS5zdWNjZXNzIHx8ICFkaW1lbnNpb25zUmVzcG9uc2UuZGltZW5zaW9ucykge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoZGltZW5zaW9uc1Jlc3BvbnNlPy5lcnJvciB8fCAnTm8gc2UgcHVkaWVyb24gb2J0ZW5lciBsYXMgZGltZW5zaW9uZXMgZGUgbGEgcFx1MDBFMWdpbmEuJyk7XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IGRpbWVuc2lvbnMgPSBkaW1lbnNpb25zUmVzcG9uc2UuZGltZW5zaW9ucyBhcyBQYWdlRGltZW5zaW9ucztcclxuICAgIGNvbnN0IGlzRWxlbWVudFNjcm9sbCA9ICEhZGltZW5zaW9ucy5pc0VsZW1lbnRTY3JvbGw7XHJcblxyXG4gICAgY29uc3QgY2xpZW50SGVpZ2h0ID0gaXNFbGVtZW50U2Nyb2xsICYmIGRpbWVuc2lvbnMuZWxlbWVudENsaWVudEhlaWdodCBcclxuICAgICAgPyBkaW1lbnNpb25zLmVsZW1lbnRDbGllbnRIZWlnaHQgXHJcbiAgICAgIDogZGltZW5zaW9ucy5jbGllbnRIZWlnaHQ7XHJcblxyXG4gICAgY29uc3Qgc2Nyb2xsSGVpZ2h0ID0gaXNFbGVtZW50U2Nyb2xsICYmIGRpbWVuc2lvbnMuZWxlbWVudFNjcm9sbEhlaWdodCBcclxuICAgICAgPyBkaW1lbnNpb25zLmVsZW1lbnRTY3JvbGxIZWlnaHQgXHJcbiAgICAgIDogZGltZW5zaW9ucy5zY3JvbGxIZWlnaHQ7XHJcblxyXG4gICAgLy8gQ2FsY3VsYXIgcHVudG9zIGRlIHNjcm9sbCBZXHJcbiAgICBsZXQgc2Nyb2xsUG9zaXRpb25zOiBudW1iZXJbXSA9IFtdO1xyXG4gICAgbGV0IGN1cnJlbnRZID0gMDtcclxuICAgIFxyXG4gICAgd2hpbGUgKGN1cnJlbnRZIDwgc2Nyb2xsSGVpZ2h0KSB7XHJcbiAgICAgIHNjcm9sbFBvc2l0aW9ucy5wdXNoKGN1cnJlbnRZKTtcclxuICAgICAgY3VycmVudFkgKz0gY2xpZW50SGVpZ2h0O1xyXG4gICAgfVxyXG4gICAgXHJcbiAgICAvLyBBc2VndXJhcnNlIGRlIGNhcHR1cmFyIGxhIHBhcnRlIGluZmVyaW9yIGV4YWN0YSBkZSBsYSBwXHUwMEUxZ2luYSBvIGVsZW1lbnRvXHJcbiAgICBpZiAoc2Nyb2xsUG9zaXRpb25zLmxlbmd0aCA+IDEpIHtcclxuICAgICAgY29uc3QgbGFzdFBvcyA9IHNjcm9sbEhlaWdodCAtIGNsaWVudEhlaWdodDtcclxuICAgICAgaWYgKHNjcm9sbFBvc2l0aW9uc1tzY3JvbGxQb3NpdGlvbnMubGVuZ3RoIC0gMV0gIT09IGxhc3RQb3MgJiYgbGFzdFBvcyA+IDApIHtcclxuICAgICAgICAvLyBSZWVtcGxhemFyIG8gYVx1MDBGMWFkaXIgbGEgXHUwMEZBbHRpbWEgcG9zaWNpXHUwMEYzbiBwYXJhIHF1ZSBzZWEgZXhhY3RhbWVudGUgZWwgYm9yZGUgaW5mZXJpb3JcclxuICAgICAgICBpZiAoc2Nyb2xsUG9zaXRpb25zW3Njcm9sbFBvc2l0aW9ucy5sZW5ndGggLSAxXSA+IGxhc3RQb3MpIHtcclxuICAgICAgICAgIHNjcm9sbFBvc2l0aW9uc1tzY3JvbGxQb3NpdGlvbnMubGVuZ3RoIC0gMV0gPSBsYXN0UG9zO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICBzY3JvbGxQb3NpdGlvbnMucHVzaChsYXN0UG9zKTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBjb25zdCB0b3RhbFN0ZXBzID0gc2Nyb2xsUG9zaXRpb25zLmxlbmd0aDtcclxuXHJcbiAgICAvLyA0LiBCdWNsZSBwcm9ncmVzaXZvIGRlIHNjcm9sbCB5IGNhcHR1cmFcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdG90YWxTdGVwczsgaSsrKSB7XHJcbiAgICAgIGlmICghaXNDYXB0dXJlSW5Qcm9ncmVzcyB8fCBjdXJyZW50Q2FwdHVyZVRhYklkICE9PSB0YWJJZCkge1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBjb25zdCB5UG9zID0gc2Nyb2xsUG9zaXRpb25zW2ldO1xyXG5cclxuICAgICAgLy8gT3JkZW5hciBhbCBDb250ZW50IFNjcmlwdCBoYWNlciBzY3JvbGwgYSBsYSBwb3NpY2lcdTAwRjNuXHJcbiAgICAgIGNvbnN0IHNjcm9sbFJlc3VsdCA9IGF3YWl0IHNlbmRUYWJNZXNzYWdlKHRhYklkLCB7IGFjdGlvbjogQUNUSU9OUy5TQ1JPTExfVE8sIHk6IHlQb3MgfSk7XHJcbiAgICAgIGlmICghc2Nyb2xsUmVzdWx0IHx8ICFzY3JvbGxSZXN1bHQuc3VjY2Vzcykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihzY3JvbGxSZXN1bHQ/LmVycm9yIHx8ICdGYWxsXHUwMEYzIGVsIGRlc3BsYXphbWllbnRvIGRlIHBcdTAwRTFnaW5hLicpO1xyXG4gICAgICB9XHJcblxyXG4gICAgICAvLyBMYSBwb3NpY2lcdTAwRjNuIGRlIHNjcm9sbCByZWFsIHB1ZWRlIHZhcmlhciBsaWdlcmFtZW50ZSBkZWJpZG8gYWwgcmVkb25kZW8gbyBsYXp5IGxvYWRpbmdcclxuICAgICAgY29uc3QgYWN0dWFsWSA9IHNjcm9sbFJlc3VsdC55ICE9PSB1bmRlZmluZWQgPyBzY3JvbGxSZXN1bHQueSA6IHlQb3M7XHJcblxyXG4gICAgICAvLyBFc3BlcmFyIDM1MG1zIGVudHJlIGNhZGEgY2FwdHVyYSBwYXJhIHJlc3BldGFyIGVsIGxcdTAwRURtaXRlIGRlIENocm9tZVxyXG4gICAgICAvLyAoTUFYX0NBUFRVUkVfVklTSUJMRV9UQUJfQ0FMTFNfUEVSX1NFQ09ORDogbVx1MDBFMXhpbW8gfjIgY2FwdHVyYXMvc2VndW5kbylcclxuICAgICAgYXdhaXQgc2xlZXAoMzUwKTtcclxuXHJcbiAgICAgIC8vIE9jdWx0YXIgbGEgVUkgZGUgcHJvZ3Jlc28gcGFyYSBxdWUgbm8gYXBhcmV6Y2EgZW4gbGEgY2FwdHVyYVxyXG4gICAgICBhd2FpdCBzZW5kVGFiTWVzc2FnZSh0YWJJZCwgeyBhY3Rpb246IEFDVElPTlMuSElERV9VSSB9KTtcclxuICAgICAgYXdhaXQgc2xlZXAoNTApOyAvLyBCcmV2ZSBlc3BlcmEgcGFyYSBhc2VndXJhciByZXBpbnRhZG8gZGVsIERPTVxyXG5cclxuICAgICAgLy8gQ2FwdHVyYXIgbGEgc2VjY2lcdTAwRjNuIHZpc2libGUgZGUgbGEgdmVudGFuYSBhY3RpdmEgZW4gUE5HXHJcbiAgICAgIGNvbnN0IGRhdGFVcmwgPSBhd2FpdCBjYXB0dXJlVGFiVmlzaWJsZVNlY3Rpb24odGFiLndpbmRvd0lkKTtcclxuICAgICAgXHJcbiAgICAgIC8vIEVudmlhciBsYSBjYXB0dXJhIGNhcHR1cmFkYSBhbCBkb2N1bWVudG8gT2Zmc2NyZWVuXHJcbiAgICAgIGNvbnN0IG9mZnNjcmVlblJlc3VsdCA9IGF3YWl0IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHtcclxuICAgICAgICBhY3Rpb246IEFDVElPTlMuT0ZGU0NSRUVOX0FERF9QQVJULFxyXG4gICAgICAgIGRhdGFVcmwsXHJcbiAgICAgICAgeTogYWN0dWFsWVxyXG4gICAgICB9KTtcclxuXHJcbiAgICAgIGlmICghb2Zmc2NyZWVuUmVzdWx0IHx8ICFvZmZzY3JlZW5SZXN1bHQuc3VjY2Vzcykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihvZmZzY3JlZW5SZXN1bHQ/LmVycm9yIHx8ICdFcnJvciBhbCBndWFyZGFyIGxhIGNhcHR1cmEgZW4gZWwgb2Zmc2NyZWVuIGNhbnZhcy4nKTtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gTm90aWZpY2FyIHByb2dyZXNvIGFsIFBvcHVwIHkgYWwgQ29udGVudCBTY3JpcHQgKG92ZXJsYXkpXHJcbiAgICAgIGNvbnN0IHBlcmNlbnRhZ2UgPSAoKGkgKyAxKSAvIHRvdGFsU3RlcHMpICogMTAwO1xyXG4gICAgICBjb25zdCBwcm9ncmVzc1BheWxvYWQgPSB7XHJcbiAgICAgICAgYWN0aW9uOiBBQ1RJT05TLkNBUFRVUkVfUFJPR1JFU1MsXHJcbiAgICAgICAgcHJvZ3Jlc3M6IHsgcGVyY2VudGFnZSwgY3VycmVudFN0ZXA6IGkgKyAxLCB0b3RhbFN0ZXBzIH1cclxuICAgICAgfTtcclxuICAgICAgXHJcbiAgICAgIC8vIEVudmlhciBhIGxhIHBlc3RhXHUwMEYxYSAocGFyYSBlbCBvdmVybGF5KVxyXG4gICAgICBhd2FpdCBzZW5kVGFiTWVzc2FnZSh0YWJJZCwgcHJvZ3Jlc3NQYXlsb2FkKTtcclxuICAgICAgLy8gRW52aWFyIGFsIFBvcHVwIChzaSBlc3RcdTAwRTEgYWJpZXJ0bylcclxuICAgICAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UocHJvZ3Jlc3NQYXlsb2FkKS5jYXRjaCgoKSA9PiB7XHJcbiAgICAgICAgLy8gSWdub3JhciBlcnJvciBzaSBlbCBQb3B1cCBlc3RcdTAwRTEgY2VycmFkb1xyXG4gICAgICB9KTtcclxuXHJcbiAgICAgIC8vIC0tLSBHZXN0aVx1MDBGM24gRGluXHUwMEUxbWljYSBkZSBMYXp5IExvYWRpbmcgLS0tXHJcbiAgICAgIC8vIERlc3B1XHUwMEU5cyBkZSBjYWRhIHNjcm9sbCwgdm9sdmVtb3MgYSB2ZXJpZmljYXIgc2kgbGEgYWx0dXJhIGF1bWVudFx1MDBGM1xyXG4gICAgICBpZiAoaSA8IHRvdGFsU3RlcHMgLSAxKSB7XHJcbiAgICAgICAgY29uc3QgY2hlY2tEaW0gPSBhd2FpdCBzZW5kVGFiTWVzc2FnZSh0YWJJZCwgeyBhY3Rpb246IEFDVElPTlMuR0VUX0RJTUVOU0lPTlMgfSk7XHJcbiAgICAgICAgaWYgKGNoZWNrRGltICYmIGNoZWNrRGltLnN1Y2Nlc3MgJiYgY2hlY2tEaW0uZGltZW5zaW9ucykge1xyXG4gICAgICAgICAgY29uc3QgbmV3RGltZW5zaW9ucyA9IGNoZWNrRGltLmRpbWVuc2lvbnMgYXMgUGFnZURpbWVuc2lvbnM7XHJcbiAgICAgICAgICBjb25zdCBjdXJyZW50VG90YWxIZWlnaHQgPSBpc0VsZW1lbnRTY3JvbGwgPyAoZGltZW5zaW9ucy5lbGVtZW50U2Nyb2xsSGVpZ2h0IHx8IDApIDogZGltZW5zaW9ucy5zY3JvbGxIZWlnaHQ7XHJcbiAgICAgICAgICBjb25zdCBuZXdUb3RhbEhlaWdodCA9IGlzRWxlbWVudFNjcm9sbCA/IChuZXdEaW1lbnNpb25zLmVsZW1lbnRTY3JvbGxIZWlnaHQgfHwgMCkgOiBuZXdEaW1lbnNpb25zLnNjcm9sbEhlaWdodDtcclxuXHJcbiAgICAgICAgICAvLyBTaSBsYSBhbHR1cmEgZGVsIGRvY3VtZW50byBvIGNvbnRlbmVkb3IgYXVtZW50XHUwMEYzIGRpblx1MDBFMW1pY2FtZW50ZVxyXG4gICAgICAgICAgaWYgKG5ld1RvdGFsSGVpZ2h0ID4gY3VycmVudFRvdGFsSGVpZ2h0KSB7XHJcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBBbHR1cmEgZGluXHUwMEUxbWljYSBkZXRlY3RhZGE6IGF1bWVudFx1MDBGMyBkZSAke2N1cnJlbnRUb3RhbEhlaWdodH1weCBhICR7bmV3VG90YWxIZWlnaHR9cHguYCk7XHJcbiAgICAgICAgICAgIGRpbWVuc2lvbnMgPSBuZXdEaW1lbnNpb25zOyAvLyBBY3R1YWxpemFyIGRpbWVuc2lvbmVzIGRlIHJlZmVyZW5jaWFcclxuICAgICAgICAgICAgXHJcbiAgICAgICAgICAgIC8vIFJlY2FsY3VsYXIgbG9zIHB1bnRvcyBkZSBzY3JvbGwgcmVzdGFudGVzXHJcbiAgICAgICAgICAgIGNvbnN0IHJlbWFpbmluZ1Bvc2l0aW9uczogbnVtYmVyW10gPSBbXTtcclxuICAgICAgICAgICAgbGV0IG5leHRZID0gc2Nyb2xsUG9zaXRpb25zW2ldICsgY2xpZW50SGVpZ2h0O1xyXG4gICAgICAgICAgICBcclxuICAgICAgICAgICAgd2hpbGUgKG5leHRZIDwgbmV3VG90YWxIZWlnaHQpIHtcclxuICAgICAgICAgICAgICByZW1haW5pbmdQb3NpdGlvbnMucHVzaChuZXh0WSk7XHJcbiAgICAgICAgICAgICAgbmV4dFkgKz0gY2xpZW50SGVpZ2h0O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAvLyBGb3J6YXIgZWwgZmluYWwgZXhhY3RvXHJcbiAgICAgICAgICAgIGNvbnN0IGxhc3RQb3MgPSBuZXdUb3RhbEhlaWdodCAtIGNsaWVudEhlaWdodDtcclxuICAgICAgICAgICAgaWYgKHJlbWFpbmluZ1Bvc2l0aW9ucy5sZW5ndGggPiAwICYmIHJlbWFpbmluZ1Bvc2l0aW9uc1tyZW1haW5pbmdQb3NpdGlvbnMubGVuZ3RoIC0gMV0gIT09IGxhc3RQb3MgJiYgbGFzdFBvcyA+IDApIHtcclxuICAgICAgICAgICAgICBpZiAocmVtYWluaW5nUG9zaXRpb25zW3JlbWFpbmluZ1Bvc2l0aW9ucy5sZW5ndGggLSAxXSA+IGxhc3RQb3MpIHtcclxuICAgICAgICAgICAgICAgIHJlbWFpbmluZ1Bvc2l0aW9uc1tyZW1haW5pbmdQb3NpdGlvbnMubGVuZ3RoIC0gMV0gPSBsYXN0UG9zO1xyXG4gICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICByZW1haW5pbmdQb3NpdGlvbnMucHVzaChsYXN0UG9zKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVtYWluaW5nUG9zaXRpb25zLmxlbmd0aCA9PT0gMCAmJiBsYXN0UG9zID4gc2Nyb2xsUG9zaXRpb25zW2ldKSB7XHJcbiAgICAgICAgICAgICAgcmVtYWluaW5nUG9zaXRpb25zLnB1c2gobGFzdFBvcyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgXHJcbiAgICAgICAgICAgIC8vIFJlY29uc3RydWlyIGxhIGxpc3RhIGRlIHBvc2ljaW9uZXM6IGxhcyB5YSBwcm9jZXNhZGFzICsgbGFzIG51ZXZhcyBwb3NpY2lvbmVzIGNhbGN1bGFkYXNcclxuICAgICAgICAgICAgc2Nyb2xsUG9zaXRpb25zID0gWy4uLnNjcm9sbFBvc2l0aW9ucy5zbGljZSgwLCBpICsgMSksIC4uLnJlbWFpbmluZ1Bvc2l0aW9uc107XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCFpc0NhcHR1cmVJblByb2dyZXNzKSByZXR1cm47XHJcblxyXG4gICAgLy8gNS4gRmluYWxpemFyOiBTdGl0Y2hpbmcgZGUgbGFzIGltXHUwMEUxZ2VuZXMgeSBkZXNjYXJnYVxyXG4gICAgbm90aWZ5U3RhdHVzKCdVbmllbmRvIGltXHUwMEUxZ2VuZXMuLi4nKTtcclxuICAgIFxyXG4gICAgY29uc3Qgc3RpdGNoUmVzdWx0ID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2Uoe1xyXG4gICAgICBhY3Rpb246IEFDVElPTlMuT0ZGU0NSRUVOX1NUSVRDSCxcclxuICAgICAgd2lkdGg6IGRpbWVuc2lvbnMuY2xpZW50V2lkdGgsXHJcbiAgICAgIGhlaWdodDogZGltZW5zaW9ucy5zY3JvbGxIZWlnaHQsXHJcbiAgICAgIGRpbWVuc2lvbnNcclxuICAgIH0pO1xyXG5cclxuICAgIGlmICghc3RpdGNoUmVzdWx0IHx8ICFzdGl0Y2hSZXN1bHQuc3VjY2VzcyB8fCAhc3RpdGNoUmVzdWx0LmRhdGFVcmwpIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKHN0aXRjaFJlc3VsdD8uZXJyb3IgfHwgJ0ZhbGxcdTAwRjMgbGEgdW5pXHUwMEYzbiBmaW5hbCBkZSBsYSBjYXB0dXJhLicpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIEd1YXJkYXIgbGEgaW1hZ2VuIGVuIEluZGV4ZWREQiBwYXJhIGVsIGVkaXRvciAoZXZpdGFyIGxcdTAwRURtaXRlcyBkZSBSQU0gZW4gbWVuc2FqZXMpXHJcbiAgICBhd2FpdCBzYXZlQ2FwdHVyZURhdGFVcmwoc3RpdGNoUmVzdWx0LmRhdGFVcmwpO1xyXG5cclxuICAgIC8vIEFicmlyIGxhIHBlc3RhXHUwMEYxYSBkZWwgZWRpdG9yXHJcbiAgICBjaHJvbWUudGFicy5jcmVhdGUoeyB1cmw6IGNocm9tZS5ydW50aW1lLmdldFVSTCgnZWRpdG9yLmh0bWwnKSB9KTtcclxuXHJcbiAgICAvLyA2LiBSZXN0YXVyYXIgZWwgZXN0YWRvIG9yaWdpbmFsIGRlIGxhIHBcdTAwRTFnaW5hIHkgbGltcGlhciBlbCBvZmZzY3JlZW5cclxuICAgIGF3YWl0IHNlbmRUYWJNZXNzYWdlKHRhYklkLCB7IGFjdGlvbjogQUNUSU9OUy5SRVNUT1JFX1BBR0UgfSk7XHJcbiAgICBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IGFjdGlvbjogQUNUSU9OUy5PRkZTQ1JFRU5fQ0xFQU5VUCB9KTtcclxuXHJcbiAgICAvLyBJbmZvcm1hciBcdTAwRTl4aXRvIGFsIFBvcHVwXHJcbiAgICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IGFjdGlvbjogQUNUSU9OUy5DQVBUVVJFX0NPTVBMRVRFIH0pLmNhdGNoKCgpID0+IHt9KTtcclxuXHJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGR1cmFudGUgbGEgY2FwdHVyYTonLCBlcnJvcik7XHJcbiAgICBub3RpZnlFcnJvcigoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UgfHwgJ09jdXJyaVx1MDBGMyB1biBlcnJvciBpbmVzcGVyYWRvIGFsIGNhcHR1cmFyIGxhIHBcdTAwRTFnaW5hLicpO1xyXG4gICAgXHJcbiAgICAvLyBJbnRlbnRhciByZXN0YXVyYXIgbGEgcFx1MDBFMWdpbmEgZGVsIHVzdWFyaW8gcGFzZSBsbyBxdWUgcGFzZVxyXG4gICAgaWYgKGN1cnJlbnRDYXB0dXJlVGFiSWQpIHtcclxuICAgICAgc2VuZFRhYk1lc3NhZ2UoY3VycmVudENhcHR1cmVUYWJJZCwgeyBhY3Rpb246IEFDVElPTlMuUkVTVE9SRV9QQUdFIH0pLmNhdGNoKCgpID0+IHt9KTtcclxuICAgIH1cclxuICB9IGZpbmFsbHkge1xyXG4gICAgaXNDYXB0dXJlSW5Qcm9ncmVzcyA9IGZhbHNlO1xyXG4gICAgY3VycmVudENhcHR1cmVUYWJJZCA9IG51bGw7XHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogQ2FuY2VsYSBlbCBwcm9jZXNvIGRlIGNhcHR1cmEgYWN0aXZvXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVDYW5jZWxDYXB0dXJlKCkge1xyXG4gIGlmICghaXNDYXB0dXJlSW5Qcm9ncmVzcykgcmV0dXJuO1xyXG4gIFxyXG4gIGNvbnN0IHRhYklkID0gY3VycmVudENhcHR1cmVUYWJJZDtcclxuICBpc0NhcHR1cmVJblByb2dyZXNzID0gZmFsc2U7XHJcbiAgY3VycmVudENhcHR1cmVUYWJJZCA9IG51bGw7XHJcblxyXG4gIHRyeSB7XHJcbiAgICBpZiAodGFiSWQpIHtcclxuICAgICAgLy8gUmVzdGF1cmFyIGxhIHBcdTAwRTFnaW5hIGRlbCB1c3VhcmlvXHJcbiAgICAgIGF3YWl0IHNlbmRUYWJNZXNzYWdlKHRhYklkLCB7IGFjdGlvbjogQUNUSU9OUy5SRVNUT1JFX1BBR0UgfSk7XHJcbiAgICB9XHJcbiAgICAvLyBMaW1waWFyIHJlY3Vyc29zIGVuIGVsIE9mZnNjcmVlbiBEb2N1bWVudFxyXG4gICAgYXdhaXQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyBhY3Rpb246IEFDVElPTlMuT0ZGU0NSRUVOX0NMRUFOVVAgfSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgYWwgY2FuY2VsYXIgbGEgY2FwdHVyYTonLCBlKTtcclxuICB9XHJcblxyXG4gIC8vIE5vdGlmaWNhciBhbCBQb3B1cCBkZSBsYSBjYW5jZWxhY2lcdTAwRjNuXHJcbiAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyBhY3Rpb246IEFDVElPTlMuQ0FQVFVSRV9FUlJPUiwgZXJyb3I6ICdDYXB0dXJhIGNhbmNlbGFkYSBwb3IgZWwgdXN1YXJpby4nIH0pLmNhdGNoKCgpID0+IHt9KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENhcHR1cmEgbGEgcGVzdGFcdTAwRjFhIHZpc2libGUgYWN0dWFsbWVudGVcclxuICovXHJcbmZ1bmN0aW9uIGNhcHR1cmVUYWJWaXNpYmxlU2VjdGlvbih3aW5kb3dJZDogbnVtYmVyKTogUHJvbWlzZTxzdHJpbmc+IHtcclxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgY2hyb21lLnRhYnMuY2FwdHVyZVZpc2libGVUYWIoXHJcbiAgICAgIHdpbmRvd0lkLFxyXG4gICAgICB7IGZvcm1hdDogJ3BuZycgfSxcclxuICAgICAgKGRhdGFVcmwpID0+IHtcclxuICAgICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKSB7XHJcbiAgICAgICAgICByZWplY3QobmV3IEVycm9yKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvci5tZXNzYWdlKSk7XHJcbiAgICAgICAgfSBlbHNlIGlmICghZGF0YVVybCkge1xyXG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcignTm8gc2UgcHVkbyBjYXB0dXJhciBsYSB2ZW50YW5hIGFjdGl2YS4nKSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgIHJlc29sdmUoZGF0YVVybCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICApO1xyXG4gIH0pO1xyXG59XHJcblxyXG4vKipcclxuICogRW52XHUwMEVEYSB1biBtZW5zYWplIGEgdW5hIHBlc3RhXHUwMEYxYSB5IG1hbmVqYSBlcnJvcmVzIGRlIGNvbXVuaWNhY2lcdTAwRjNuIGRlIENocm9tZVxyXG4gKi9cclxuZnVuY3Rpb24gc2VuZFRhYk1lc3NhZ2UodGFiSWQ6IG51bWJlciwgbWVzc2FnZTogTWVzc2FnZVBheWxvYWQpOiBQcm9taXNlPGFueT4ge1xyXG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xyXG4gICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIG1lc3NhZ2UsIChyZXNwb25zZSkgPT4ge1xyXG4gICAgICAvLyBFdml0YXIgY3Jhc2ggc2kgbGEgcGVzdGFcdTAwRjFhIHNlIGNlcnJcdTAwRjMgbyBubyByZXNwb25kZVxyXG4gICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKSB7XHJcbiAgICAgICAgcmVzb2x2ZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yLm1lc3NhZ2UgfSk7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgcmVzb2x2ZShyZXNwb25zZSk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH0pO1xyXG59XHJcblxyXG4vKipcclxuICogRW52XHUwMEVEYSB1bmEgbm90aWZpY2FjaVx1MDBGM24gZGUgZXJyb3IgYWwgcG9wdXBcclxuICovXHJcbmZ1bmN0aW9uIG5vdGlmeUVycm9yKGVycm9yTWVzc2FnZTogc3RyaW5nKSB7XHJcbiAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2Uoe1xyXG4gICAgYWN0aW9uOiBBQ1RJT05TLkNBUFRVUkVfRVJST1IsXHJcbiAgICBlcnJvcjogZXJyb3JNZXNzYWdlXHJcbiAgfSkuY2F0Y2goKCkgPT4ge1xyXG4gICAgLy8gU2kgZWwgcG9wdXAgZXN0XHUwMEUxIGNlcnJhZG8sIHBvZGVtb3MgdXNhciB1bmEgbm90aWZpY2FjaVx1MDBGM24gZGUgQ2hyb21lXHJcbiAgICBjaHJvbWUubm90aWZpY2F0aW9ucz8uY3JlYXRlKHtcclxuICAgICAgdHlwZTogJ2Jhc2ljJyxcclxuICAgICAgaWNvblVybDogJ2ljb25zL2ljb24tNDgucG5nJyxcclxuICAgICAgdGl0bGU6ICdGdWxsU2hvdCAtIEVycm9yJyxcclxuICAgICAgbWVzc2FnZTogZXJyb3JNZXNzYWdlXHJcbiAgICB9KTtcclxuICB9KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEFjdHVhbGl6YSBlbCBlc3RhZG8gZW4gZWwgUG9wdXBcclxuICovXHJcbmZ1bmN0aW9uIG5vdGlmeVN0YXR1cyhzdGF0dXNUZXh0OiBzdHJpbmcpIHtcclxuICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7XHJcbiAgICBhY3Rpb246IEFDVElPTlMuQ0FQVFVSRV9QUk9HUkVTUyxcclxuICAgIHByb2dyZXNzOiB7IHBlcmNlbnRhZ2U6IDk1LCBjdXJyZW50U3RlcDogOSwgdG90YWxTdGVwczogMTAgfSAvLyBFc3RhZG8gZGUgcHJvY2VzYW1pZW50byBmaW5hbFxyXG4gIH0pLmNhdGNoKCgpID0+IHt9KTtcclxufVxyXG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFBTyxNQUFNLFVBQVU7QUFBQSxJQUNyQixlQUFlO0FBQUEsSUFDZixnQkFBZ0I7QUFBQSxJQUNoQixrQkFBa0I7QUFBQSxJQUNsQixrQkFBa0I7QUFBQSxJQUNsQixlQUFlO0FBQUE7QUFBQSxJQUdmLGdC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
