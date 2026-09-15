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
      const { clientHeight, scrollHeight } = dimensions;
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
            if (newDimensions.scrollHeight > dimensions.scrollHeight) {
              console.log(`Altura din\xE1mica detectada: aument\xF3 de ${dimensions.scrollHeight}px a ${newDimensions.scrollHeight}px.`);
              dimensions = newDimensions;
              const remainingPositions = [];
              let nextY = scrollPositions[i] + clientHeight;
              while (nextY < newDimensions.scrollHeight) {
                remainingPositions.push(nextY);
                nextY += clientHeight;
              }
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3NoYXJlZC9jb25zdGFudHMudHMiLCAiLi4vc3JjL3NoYXJlZC9zdG9yYWdlLnRzIiwgIi4uL3NyYy9iYWNrZ3JvdW5kL3NlcnZpY2Utd29ya2VyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJleHBvcnQgY29uc3QgQUNUSU9OUyA9IHtcbiAgU1RBUlRfQ0FQVFVSRTogJ1NUQVJUX0NBUFRVUkUnLFxuICBDQU5DRUxfQ0FQVFVSRTogJ0NBTkNFTF9DQVBUVVJFJyxcbiAgQ0FQVFVSRV9QUk9HUkVTUzogJ0NBUFRVUkVfUFJPR1JFU1MnLFxuICBDQVBUVVJFX0NPTVBMRVRFOiAnQ0FQVFVSRV9DT01QTEVURScsXG4gIENBUFRVUkVfRVJST1I6ICdDQVBUVVJFX0VSUk9SJyxcbiAgXG4gIC8vIE1lbnNhamVzIGVudHJlIFNlcnZpY2UgV29ya2VyIHkgQ29udGVudCBTY3JpcHRcbiAgR0VUX0RJTUVOU0lPTlM6ICdHRVRfRElNRU5TSU9OUycsXG4gIFNDUk9MTF9UTzogJ1NDUk9MTF9UTycsXG4gIFJFU1RPUkVfUEFHRTogJ1JFU1RPUkVfUEFHRScsXG4gIEhJREVfVUk6ICdISURFX1VJJyxcbiAgXG4gIC8vIE1lbnNhamVzIHBhcmEgZWwgT2Zmc2NyZWVuIERvY3VtZW50XG4gIE9GRlNDUkVFTl9JTklUX0NBTlZBUzogJ09GRlNDUkVFTl9JTklUX0NBTlZBUycsXG4gIE9GRlNDUkVFTl9BRERfUEFSVDogJ09GRlNDUkVFTl9BRERfUEFSVCcsXG4gIE9GRlNDUkVFTl9TVElUQ0g6ICdPRkZTQ1JFRU5fU1RJVENIJyxcbiAgT0ZGU0NSRUVOX0NMRUFOVVA6ICdPRkZTQ1JFRU5fQ0xFQU5VUCdcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBPVkVSTEFZX0lEID0gJ2Z1bGxzaG90LWNhcHR1cmUtb3ZlcmxheSc7XG5leHBvcnQgY29uc3QgUFJPR1JFU1NfQkFSX0lEID0gJ2Z1bGxzaG90LXByb2dyZXNzLWJhcic7XG5leHBvcnQgY29uc3QgUFJPR1JFU1NfVEVYVF9JRCA9ICdmdWxsc2hvdC1wcm9ncmVzcy10ZXh0JztcbmV4cG9ydCBjb25zdCBDQU5DRUxfQlVUVE9OX0lEID0gJ2Z1bGxzaG90LWNhbmNlbC1idXR0b24nO1xuZXhwb3J0IGNvbnN0IFNUWUxFX1RBR19JRCA9ICdmdWxsc2hvdC10ZW1wb3Jhcnktc3R5bGVzJztcbiIsICJjb25zdCBEQl9OQU1FID0gJ0Z1bGxTaG90REInO1xuY29uc3QgREJfVkVSU0lPTiA9IDE7XG5jb25zdCBTVE9SRV9OQU1FID0gJ2NhcHR1cmVzJztcbmNvbnN0IENBUFRVUkVfS0VZID0gJ2xhdGVzdF9jYXB0dXJlJztcblxuLyoqXG4gKiBBYnJlIGxhIGNvbmV4aVx1MDBGM24gYSBJbmRleGVkREIgcGFyYSBsYSBleHRlbnNpXHUwMEYzblxuICovXG5mdW5jdGlvbiBvcGVuREIoKTogUHJvbWlzZTxJREJEYXRhYmFzZT4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHJlcXVlc3QgPSBpbmRleGVkREIub3BlbihEQl9OQU1FLCBEQl9WRVJTSU9OKTtcbiAgICBcbiAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcbiAgICBcbiAgICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IChldmVudCkgPT4ge1xuICAgICAgY29uc3QgZGIgPSAoZXZlbnQudGFyZ2V0IGFzIElEQk9wZW5EQlJlcXVlc3QpLnJlc3VsdDtcbiAgICAgIGlmICghZGIub2JqZWN0U3RvcmVOYW1lcy5jb250YWlucyhTVE9SRV9OQU1FKSkge1xuICAgICAgICBkYi5jcmVhdGVPYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcbiAgICAgIH1cbiAgICB9O1xuICB9KTtcbn1cblxuLyoqXG4gKiBHdWFyZGEgZWwgRGF0YVVSTCBkZSBsYSBjYXB0dXJhIGNvbXBsZXRhIGVuIEluZGV4ZWREQlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZUNhcHR1cmVEYXRhVXJsKGRhdGFVcmw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBkYiA9IGF3YWl0IG9wZW5EQigpO1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oW1NUT1JFX05BTUVdLCAncmVhZHdyaXRlJyk7XG4gICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcbiAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUucHV0KGRhdGFVcmwsIENBUFRVUkVfS0VZKTtcbiAgICBcbiAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUoKTtcbiAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gIH0pO1xufVxuXG4vKipcbiAqIFJlY3VwZXJhIGVsIERhdGFVUkwgZGUgbGEgY2FwdHVyYSBjb21wbGV0YSBkZXNkZSBJbmRleGVkREJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldENhcHR1cmVEYXRhVXJsKCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBkYiA9IGF3YWl0IG9wZW5EQigpO1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oW1NUT1JFX05BTUVdLCAncmVhZG9ubHknKTtcbiAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXQoQ0FQVFVSRV9LRVkpO1xuICAgIFxuICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4gcmVzb2x2ZShyZXF1ZXN0LnJlc3VsdCB8fCBudWxsKTtcbiAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gIH0pO1xufVxuXG4vKipcbiAqIEVsaW1pbmEgbGEgY2FwdHVyYSBhY3R1YWwgcGFyYSBsaWJlcmFyIGVzcGFjaW9cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyQ2FwdHVyZURhdGFVcmwoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGRiID0gYXdhaXQgb3BlbkRCKCk7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihbU1RPUkVfTkFNRV0sICdyZWFkd3JpdGUnKTtcbiAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5kZWxldGUoQ0FQVFVSRV9LRVkpO1xuICAgIFxuICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4gcmVzb2x2ZSgpO1xuICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgfSk7XG59XG4iLCAiaW1wb3J0IHsgQUNUSU9OUyB9IGZyb20gJy4uL3NoYXJlZC9jb25zdGFudHMnO1xuaW1wb3J0IHsgc2F2ZUNhcHR1cmVEYXRhVXJsIH0gZnJvbSAnLi4vc2hhcmVkL3N0b3JhZ2UnO1xuaW1wb3J0IHsgTWVzc2FnZVBheWxvYWQsIFBhZ2VEaW1lbnNpb25zIH0gZnJvbSAnLi4vc2hhcmVkL3R5cGVzJztcblxubGV0IGlzQ2FwdHVyZUluUHJvZ3Jlc3MgPSBmYWxzZTtcbmxldCBjdXJyZW50Q2FwdHVyZVRhYklkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiBQYXVzYSBsYSBlamVjdWNpXHUwMEYzbiBkdXJhbnRlIE4gbWlsaXNlZ3VuZG9zXG4gKi9cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCBtcykpO1xufVxubGV0IGNyZWF0aW5nT2Zmc2NyZWVuOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG5cbi8vIEVzY3VjaGFyIGF0YWpvcyBkZSB0ZWNsYWRvIChTaG9ydGN1dHMpXG5jaHJvbWUuY29tbWFuZHMub25Db21tYW5kLmFkZExpc3RlbmVyKGFzeW5jIChjb21tYW5kKSA9PiB7XG4gIGlmIChjb21tYW5kID09PSAnY2FwdHVyZS1mdWxscGFnZScpIHtcbiAgICBjb25zdCBbdGFiXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCBjdXJyZW50V2luZG93OiB0cnVlIH0pO1xuICAgIGlmICh0YWIgJiYgdGFiLmlkKSB7XG4gICAgICBoYW5kbGVTdGFydENhcHR1cmUodGFiLmlkKTtcbiAgICB9XG4gIH1cbn0pO1xuXG4vLyBFc2N1Y2hhciBjbGljcyBlbiBlbCBpY29ubyBkZSBsYSBleHRlbnNpXHUwMEYzbiBvIG1lbnNhamVzIGRlbCBQb3B1cCAvIENvbnRlbnQgU2NyaXB0XG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2U6IE1lc3NhZ2VQYXlsb2FkLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICBpZiAobWVzc2FnZS5hY3Rpb24gPT09IEFDVElPTlMuU1RBUlRfQ0FQVFVSRSkge1xuICAgIGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCBjdXJyZW50V2luZG93OiB0cnVlIH0sICh0YWJzKSA9PiB7XG4gICAgICBjb25zdCBhY3RpdmVUYWIgPSB0YWJzWzBdO1xuICAgICAgaWYgKGFjdGl2ZVRhYiAmJiBhY3RpdmVUYWIuaWQpIHtcbiAgICAgICAgaGFuZGxlU3RhcnRDYXB0dXJlKGFjdGl2ZVRhYi5pZCk7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICdObyBzZSBlbmNvbnRyXHUwMEYzIHVuYSBwZXN0YVx1MDBGMWEgYWN0aXZhLicgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBpZiAobWVzc2FnZS5hY3Rpb24gPT09IEFDVElPTlMuQ0FOQ0VMX0NBUFRVUkUpIHtcbiAgICBoYW5kbGVDYW5jZWxDYXB0dXJlKCk7XG4gICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxufSk7XG5cbi8qKlxuICogVmFsaWRhIHNpIGxhIFVSTCBkZSBsYSBwZXN0YVx1MDBGMWEgZXMgY29tcGF0aWJsZVxuICovXG5mdW5jdGlvbiBpc1VSTENvbXBhdGlibGUodXJsPzogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghdXJsKSByZXR1cm4gZmFsc2U7XG4gIC8vIENocm9tZSByZXN0cmluZ2UgbGEgaW55ZWNjaVx1MDBGM24gZGUgc2NyaXB0cyBlbiBVUkxzIGludGVybmFzIGRlbCBuYXZlZ2Fkb3IgeSBlbiBsYSBDaHJvbWUgV2ViIFN0b3JlXG4gIGNvbnN0IHJlc3RyaWN0ZWRQcmVmaXhlcyA9IFtcbiAgICAnY2hyb21lOi8vJyxcbiAgICAnY2hyb21lLWV4dGVuc2lvbjovLycsXG4gICAgJ3ZpZXctc291cmNlOicsXG4gICAgJ2Fib3V0OicsXG4gICAgJ2Nocm9tZS5nb29nbGUuY29tL3dlYnN0b3JlJyxcbiAgICAnY2hyb21ld2Vic3RvcmUuZ29vZ2xlLmNvbSdcbiAgXTtcbiAgcmV0dXJuICFyZXN0cmljdGVkUHJlZml4ZXMuc29tZShwcmVmaXggPT4gdXJsLmluY2x1ZGVzKHByZWZpeCkpICYmIFxuICAgICAgICAgKHVybC5zdGFydHNXaXRoKCdodHRwOi8vJykgfHwgdXJsLnN0YXJ0c1dpdGgoJ2h0dHBzOi8vJykgfHwgdXJsLnN0YXJ0c1dpdGgoJ2ZpbGU6Ly8nKSk7XG59XG5cbi8qKlxuICogQ3JlYSBvIGluaWNpYWxpemEgZWwgZG9jdW1lbnRvIE9mZnNjcmVlbiBlbiBNYW5pZmVzdCBWM1xuICovXG5hc3luYyBmdW5jdGlvbiBzZXR1cE9mZnNjcmVlbigpIHtcbiAgY29uc3Qgb2Zmc2NyZWVuVXJsID0gY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdvZmZzY3JlZW4uaHRtbCcpO1xuICBcbiAgLy8gQ29tcHJvYmFyIHNpIHlhIGV4aXN0ZSB1biBkb2N1bWVudG8gb2Zmc2NyZWVuIGFiaWVydG9cbiAgY29uc3QgY29udGV4dHMgPSBhd2FpdCBjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cyh7XG4gICAgY29udGV4dFR5cGVzOiBbJ09GRlNDUkVFTl9ET0NVTUVOVCddLFxuICAgIGRvY3VtZW50VXJsczogW29mZnNjcmVlblVybF1cbiAgfSk7XG4gIFxuICBpZiAoY29udGV4dHMubGVuZ3RoID4gMCkge1xuICAgIHJldHVybjtcbiAgfVxuICBcbiAgaWYgKGNyZWF0aW5nT2Zmc2NyZWVuKSB7XG4gICAgYXdhaXQgY3JlYXRpbmdPZmZzY3JlZW47XG4gICAgcmV0dXJuO1xuICB9XG4gIFxuICBjcmVhdGluZ09mZnNjcmVlbiA9IGNocm9tZS5vZmZzY3JlZW4uY3JlYXRlRG9jdW1lbnQoe1xuICAgIHVybDogb2Zmc2NyZWVuVXJsLFxuICAgIHJlYXNvbnM6IFsnQkxPQlMnXSxcbiAgICBqdXN0aWZpY2F0aW9uOiAnUHJvY2VzYW1pZW50byBkZSBpbVx1MDBFMWdlbmVzIHkgQ2FudmFzIHBhcmEgdW5pciBjYXB0dXJhcyBkZSBwYW50YWxsYSBjb21wbGV0YSdcbiAgfSk7XG4gIFxuICBhd2FpdCBjcmVhdGluZ09mZnNjcmVlbjtcbiAgY3JlYXRpbmdPZmZzY3JlZW4gPSBudWxsO1xufVxuXG4vKipcbiAqIEluaWNpYSBlbCBmbHVqbyBkZSBjYXB0dXJhIGRlIGxhIHBcdTAwRTFnaW5hIGNvbXBsZXRhXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVN0YXJ0Q2FwdHVyZSh0YWJJZDogbnVtYmVyKSB7XG4gIGlmIChpc0NhcHR1cmVJblByb2dyZXNzKSB7XG4gICAgbm90aWZ5RXJyb3IoJ1lhIGhheSB1biBwcm9jZXNvIGRlIGNhcHR1cmEgZW4gZWplY3VjaVx1MDBGM24uJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCB0YWIgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQodGFiSWQpO1xuICAgIGlmICghaXNVUkxDb21wYXRpYmxlKHRhYi51cmwpKSB7XG4gICAgICBub3RpZnlFcnJvcignRXN0YSBwXHUwMEUxZ2luYSBubyBwdWVkZSBzZXIgY2FwdHVyYWRhIHBvciBsYSBleHRlbnNpXHUwMEYzbi4nKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpc0NhcHR1cmVJblByb2dyZXNzID0gdHJ1ZTtcbiAgICBjdXJyZW50Q2FwdHVyZVRhYklkID0gdGFiSWQ7XG5cbiAgICAvLyAxLiBBc2VndXJhciBxdWUgZWwgT2Zmc2NyZWVuIGRvY3VtZW50IGVzdFx1MDBFMSBsaXN0b1xuICAgIGF3YWl0IHNldHVwT2Zmc2NyZWVuKCk7XG4gICAgXG4gICAgLy8gTGltcGlhciByZXN0b3MgZGUgY2FwdHVyYXMgYW50ZXJpb3JlcyBlbiBlbCBPZmZzY3JlZW4gRG9jdW1lbnRcbiAgICBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IGFjdGlvbjogQUNUSU9OUy5PRkZTQ1JFRU5fQ0xFQU5VUCB9KTtcblxuICAgIC8vIDIuIElueWVjdGFyIGRpblx1MDBFMW1pY2FtZW50ZSBlbCBDb250ZW50IFNjcmlwdCBlbiBsYSBwZXN0YVx1MDBGMWEgKHBvciBzaSBubyBzZSBoYSBjYXJnYWRvIGF1dG9tXHUwMEUxdGljYW1lbnRlKVxuICAgIGF3YWl0IGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdCh7XG4gICAgICB0YXJnZXQ6IHsgdGFiSWQgfSxcbiAgICAgIGZpbGVzOiBbJ2NvbnRlbnQuanMnXVxuICAgIH0pO1xuXG4gICAgLy8gMy4gU29saWNpdGFyIGxhcyBkaW1lbnNpb25lcyBpbmljaWFsZXMgZGUgbGEgcFx1MDBFMWdpbmEgYWwgQ29udGVudCBTY3JpcHRcbiAgICBjb25zdCBkaW1lbnNpb25zUmVzcG9uc2UgPSBhd2FpdCBzZW5kVGFiTWVzc2FnZSh0YWJJZCwgeyBhY3Rpb246IEFDVElPTlMuR0VUX0RJTUVOU0lPTlMgfSk7XG4gICAgaWYgKCFkaW1lbnNpb25zUmVzcG9uc2UgfHwgIWRpbWVuc2lvbnNSZXNwb25zZS5zdWNjZXNzIHx8ICFkaW1lbnNpb25zUmVzcG9uc2UuZGltZW5zaW9ucykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGRpbWVuc2lvbnNSZXNwb25zZT8uZXJyb3IgfHwgJ05vIHNlIHB1ZGllcm9uIG9idGVuZXIgbGFzIGRpbWVuc2lvbmVzIGRlIGxhIHBcdTAwRTFnaW5hLicpO1xuICAgIH1cblxuICAgIGxldCBkaW1lbnNpb25zID0gZGltZW5zaW9uc1Jlc3BvbnNlLmRpbWVuc2lvbnMgYXMgUGFnZURpbWVuc2lvbnM7XG4gICAgY29uc3QgeyBjbGllbnRIZWlnaHQsIHNjcm9sbEhlaWdodCB9ID0gZGltZW5zaW9ucztcblxuICAgIC8vIENhbGN1bGFyIHB1bnRvcyBkZSBzY3JvbGwgWVxuICAgIGxldCBzY3JvbGxQb3NpdGlvbnM6IG51bWJlcltdID0gW107XG4gICAgbGV0IGN1cnJlbnRZID0gMDtcbiAgICBcbiAgICB3aGlsZSAoY3VycmVudFkgPCBzY3JvbGxIZWlnaHQpIHtcbiAgICAgIHNjcm9sbFBvc2l0aW9ucy5wdXNoKGN1cnJlbnRZKTtcbiAgICAgIGN1cnJlbnRZICs9IGNsaWVudEhlaWdodDtcbiAgICB9XG4gICAgXG4gICAgLy8gQXNlZ3VyYXJzZSBkZSBjYXB0dXJhciBsYSBwYXJ0ZSBpbmZlcmlvciBleGFjdGEgZGUgbGEgcFx1MDBFMWdpbmFcbiAgICBpZiAoc2Nyb2xsUG9zaXRpb25zLmxlbmd0aCA+IDEpIHtcbiAgICAgIGNvbnN0IGxhc3RQb3MgPSBzY3JvbGxIZWlnaHQgLSBjbGllbnRIZWlnaHQ7XG4gICAgICBpZiAoc2Nyb2xsUG9zaXRpb25zW3Njcm9sbFBvc2l0aW9ucy5sZW5ndGggLSAxXSAhPT0gbGFzdFBvcyAmJiBsYXN0UG9zID4gMCkge1xuICAgICAgICAvLyBSZWVtcGxhemFyIG8gYVx1MDBGMWFkaXIgbGEgXHUwMEZBbHRpbWEgcG9zaWNpXHUwMEYzbiBwYXJhIHF1ZSBzZWEgZXhhY3RhbWVudGUgZWwgYm9yZGUgaW5mZXJpb3JcbiAgICAgICAgaWYgKHNjcm9sbFBvc2l0aW9uc1tzY3JvbGxQb3NpdGlvbnMubGVuZ3RoIC0gMV0gPiBsYXN0UG9zKSB7XG4gICAgICAgICAgc2Nyb2xsUG9zaXRpb25zW3Njcm9sbFBvc2l0aW9ucy5sZW5ndGggLSAxXSA9IGxhc3RQb3M7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc2Nyb2xsUG9zaXRpb25zLnB1c2gobGFzdFBvcyk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCB0b3RhbFN0ZXBzID0gc2Nyb2xsUG9zaXRpb25zLmxlbmd0aDtcblxuICAgIC8vIDQuIEJ1Y2xlIHByb2dyZXNpdm8gZGUgc2Nyb2xsIHkgY2FwdHVyYVxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdG90YWxTdGVwczsgaSsrKSB7XG4gICAgICBpZiAoIWlzQ2FwdHVyZUluUHJvZ3Jlc3MgfHwgY3VycmVudENhcHR1cmVUYWJJZCAhPT0gdGFiSWQpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHlQb3MgPSBzY3JvbGxQb3NpdGlvbnNbaV07XG5cbiAgICAgIC8vIE9yZGVuYXIgYWwgQ29udGVudCBTY3JpcHQgaGFjZXIgc2Nyb2xsIGEgbGEgcG9zaWNpXHUwMEYzblxuICAgICAgY29uc3Qgc2Nyb2xsUmVzdWx0ID0gYXdhaXQgc2VuZFRhYk1lc3NhZ2UodGFiSWQsIHsgYWN0aW9uOiBBQ1RJT05TLlNDUk9MTF9UTywgeTogeVBvcyB9KTtcbiAgICAgIGlmICghc2Nyb2xsUmVzdWx0IHx8ICFzY3JvbGxSZXN1bHQuc3VjY2Vzcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3Ioc2Nyb2xsUmVzdWx0Py5lcnJvciB8fCAnRmFsbFx1MDBGMyBlbCBkZXNwbGF6YW1pZW50byBkZSBwXHUwMEUxZ2luYS4nKTtcbiAgICAgIH1cblxuICAgICAgLy8gTGEgcG9zaWNpXHUwMEYzbiBkZSBzY3JvbGwgcmVhbCBwdWVkZSB2YXJpYXIgbGlnZXJhbWVudGUgZGViaWRvIGFsIHJlZG9uZGVvIG8gbGF6eSBsb2FkaW5nXG4gICAgICBjb25zdCBhY3R1YWxZID0gc2Nyb2xsUmVzdWx0LnkgIT09IHVuZGVmaW5lZCA/IHNjcm9sbFJlc3VsdC55IDogeVBvcztcblxuICAgICAgLy8gRXNwZXJhciAzNTBtcyBlbnRyZSBjYWRhIGNhcHR1cmEgcGFyYSByZXNwZXRhciBlbCBsXHUwMEVEbWl0ZSBkZSBDaHJvbWVcbiAgICAgIC8vIChNQVhfQ0FQVFVSRV9WSVNJQkxFX1RBQl9DQUxMU19QRVJfU0VDT05EOiBtXHUwMEUxeGltbyB+MiBjYXB0dXJhcy9zZWd1bmRvKVxuICAgICAgYXdhaXQgc2xlZXAoMzUwKTtcblxuICAgICAgLy8gT2N1bHRhciBsYSBVSSBkZSBwcm9ncmVzbyBwYXJhIHF1ZSBubyBhcGFyZXpjYSBlbiBsYSBjYXB0dXJhXG4gICAgICBhd2FpdCBzZW5kVGFiTWVzc2FnZSh0YWJJZCwgeyBhY3Rpb246IEFDVElPTlMuSElERV9VSSB9KTtcbiAgICAgIGF3YWl0IHNsZWVwKDUwKTsgLy8gQnJldmUgZXNwZXJhIHBhcmEgYXNlZ3VyYXIgcmVwaW50YWRvIGRlbCBET01cblxuICAgICAgLy8gQ2FwdHVyYXIgbGEgc2VjY2lcdTAwRjNuIHZpc2libGUgZGUgbGEgdmVudGFuYSBhY3RpdmEgZW4gUE5HXG4gICAgICBjb25zdCBkYXRhVXJsID0gYXdhaXQgY2FwdHVyZVRhYlZpc2libGVTZWN0aW9uKHRhYi53aW5kb3dJZCk7XG4gICAgICBcbiAgICAgIC8vIEVudmlhciBsYSBjYXB0dXJhIGNhcHR1cmFkYSBhbCBkb2N1bWVudG8gT2Zmc2NyZWVuXG4gICAgICBjb25zdCBvZmZzY3JlZW5SZXN1bHQgPSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7XG4gICAgICAgIGFjdGlvbjogQUNUSU9OUy5PRkZTQ1JFRU5fQUREX1BBUlQsXG4gICAgICAgIGRhdGFVcmwsXG4gICAgICAgIHk6IGFjdHVhbFlcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoIW9mZnNjcmVlblJlc3VsdCB8fCAhb2Zmc2NyZWVuUmVzdWx0LnN1Y2Nlc3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG9mZnNjcmVlblJlc3VsdD8uZXJyb3IgfHwgJ0Vycm9yIGFsIGd1YXJkYXIgbGEgY2FwdHVyYSBlbiBlbCBvZmZzY3JlZW4gY2FudmFzLicpO1xuICAgICAgfVxuXG4gICAgICAvLyBOb3RpZmljYXIgcHJvZ3Jlc28gYWwgUG9wdXAgeSBhbCBDb250ZW50IFNjcmlwdCAob3ZlcmxheSlcbiAgICAgIGNvbnN0IHBlcmNlbnRhZ2UgPSAoKGkgKyAxKSAvIHRvdGFsU3RlcHMpICogMTAwO1xuICAgICAgY29uc3QgcHJvZ3Jlc3NQYXlsb2FkID0ge1xuICAgICAgICBhY3Rpb246IEFDVElPTlMuQ0FQVFVSRV9QUk9HUkVTUyxcbiAgICAgICAgcHJvZ3Jlc3M6IHsgcGVyY2VudGFnZSwgY3VycmVudFN0ZXA6IGkgKyAxLCB0b3RhbFN0ZXBzIH1cbiAgICAgIH07XG4gICAgICBcbiAgICAgIC8vIEVudmlhciBhIGxhIHBlc3RhXHUwMEYxYSAocGFyYSBlbCBvdmVybGF5KVxuICAgICAgYXdhaXQgc2VuZFRhYk1lc3NhZ2UodGFiSWQsIHByb2dyZXNzUGF5bG9hZCk7XG4gICAgICAvLyBFbnZpYXIgYWwgUG9wdXAgKHNpIGVzdFx1MDBFMSBhYmllcnRvKVxuICAgICAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UocHJvZ3Jlc3NQYXlsb2FkKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIElnbm9yYXIgZXJyb3Igc2kgZWwgUG9wdXAgZXN0XHUwMEUxIGNlcnJhZG9cbiAgICAgIH0pO1xuXG4gICAgICAvLyAtLS0gR2VzdGlcdTAwRjNuIERpblx1MDBFMW1pY2EgZGUgTGF6eSBMb2FkaW5nIC0tLVxuICAgICAgLy8gRGVzcHVcdTAwRTlzIGRlIGNhZGEgc2Nyb2xsLCB2b2x2ZW1vcyBhIHZlcmlmaWNhciBzaSBsYSBhbHR1cmEgZGVsIGRvY3VtZW50byBhdW1lbnRcdTAwRjNcbiAgICAgIGlmIChpIDwgdG90YWxTdGVwcyAtIDEpIHtcbiAgICAgICAgY29uc3QgY2hlY2tEaW0gPSBhd2FpdCBzZW5kVGFiTWVzc2FnZSh0YWJJZCwgeyBhY3Rpb246IEFDVElPTlMuR0VUX0RJTUVOU0lPTlMgfSk7XG4gICAgICAgIGlmIChjaGVja0RpbSAmJiBjaGVja0RpbS5zdWNjZXNzICYmIGNoZWNrRGltLmRpbWVuc2lvbnMpIHtcbiAgICAgICAgICBjb25zdCBuZXdEaW1lbnNpb25zID0gY2hlY2tEaW0uZGltZW5zaW9ucyBhcyBQYWdlRGltZW5zaW9ucztcbiAgICAgICAgICAvLyBTaSBsYSBhbHR1cmEgZGVsIGRvY3VtZW50byBhdW1lbnRcdTAwRjMgZGluXHUwMEUxbWljYW1lbnRlXG4gICAgICAgICAgaWYgKG5ld0RpbWVuc2lvbnMuc2Nyb2xsSGVpZ2h0ID4gZGltZW5zaW9ucy5zY3JvbGxIZWlnaHQpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBBbHR1cmEgZGluXHUwMEUxbWljYSBkZXRlY3RhZGE6IGF1bWVudFx1MDBGMyBkZSAke2RpbWVuc2lvbnMuc2Nyb2xsSGVpZ2h0fXB4IGEgJHtuZXdEaW1lbnNpb25zLnNjcm9sbEhlaWdodH1weC5gKTtcbiAgICAgICAgICAgIGRpbWVuc2lvbnMgPSBuZXdEaW1lbnNpb25zOyAvLyBBY3R1YWxpemFyIGRpbWVuc2lvbmVzIGRlIHJlZmVyZW5jaWFcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gUmVjYWxjdWxhciBsb3MgcHVudG9zIGRlIHNjcm9sbCByZXN0YW50ZXNcbiAgICAgICAgICAgIGNvbnN0IHJlbWFpbmluZ1Bvc2l0aW9uczogbnVtYmVyW10gPSBbXTtcbiAgICAgICAgICAgIGxldCBuZXh0WSA9IHNjcm9sbFBvc2l0aW9uc1tpXSArIGNsaWVudEhlaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgd2hpbGUgKG5leHRZIDwgbmV3RGltZW5zaW9ucy5zY3JvbGxIZWlnaHQpIHtcbiAgICAgICAgICAgICAgcmVtYWluaW5nUG9zaXRpb25zLnB1c2gobmV4dFkpO1xuICAgICAgICAgICAgICBuZXh0WSArPSBjbGllbnRIZWlnaHQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEZvcnphciBlbCBmaW5hbCBleGFjdG9cbiAgICAgICAgICAgIGNvbnN0IGxhc3RQb3MgPSBuZXdEaW1lbnNpb25zLnNjcm9sbEhlaWdodCAtIGNsaWVudEhlaWdodDtcbiAgICAgICAgICAgIGlmIChyZW1haW5pbmdQb3NpdGlvbnMubGVuZ3RoID4gMCAmJiByZW1haW5pbmdQb3NpdGlvbnNbcmVtYWluaW5nUG9zaXRpb25zLmxlbmd0aCAtIDFdICE9PSBsYXN0UG9zICYmIGxhc3RQb3MgPiAwKSB7XG4gICAgICAgICAgICAgIGlmIChyZW1haW5pbmdQb3NpdGlvbnNbcmVtYWluaW5nUG9zaXRpb25zLmxlbmd0aCAtIDFdID4gbGFzdFBvcykge1xuICAgICAgICAgICAgICAgIHJlbWFpbmluZ1Bvc2l0aW9uc1tyZW1haW5pbmdQb3NpdGlvbnMubGVuZ3RoIC0gMV0gPSBsYXN0UG9zO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJlbWFpbmluZ1Bvc2l0aW9ucy5wdXNoKGxhc3RQb3MpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlbWFpbmluZ1Bvc2l0aW9ucy5sZW5ndGggPT09IDAgJiYgbGFzdFBvcyA+IHNjcm9sbFBvc2l0aW9uc1tpXSkge1xuICAgICAgICAgICAgICByZW1haW5pbmdQb3NpdGlvbnMucHVzaChsYXN0UG9zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gUmVjb25zdHJ1aXIgbGEgbGlzdGEgZGUgcG9zaWNpb25lczogbGFzIHlhIHByb2Nlc2FkYXMgKyBsYXMgbnVldmFzIHBvc2ljaW9uZXMgY2FsY3VsYWRhc1xuICAgICAgICAgICAgc2Nyb2xsUG9zaXRpb25zID0gWy4uLnNjcm9sbFBvc2l0aW9ucy5zbGljZSgwLCBpICsgMSksIC4uLnJlbWFpbmluZ1Bvc2l0aW9uc107XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFpc0NhcHR1cmVJblByb2dyZXNzKSByZXR1cm47XG5cbiAgICAvLyA1LiBGaW5hbGl6YXI6IFN0aXRjaGluZyBkZSBsYXMgaW1cdTAwRTFnZW5lcyB5IGRlc2NhcmdhXG4gICAgbm90aWZ5U3RhdHVzKCdVbmllbmRvIGltXHUwMEUxZ2VuZXMuLi4nKTtcbiAgICBcbiAgICBjb25zdCBzdGl0Y2hSZXN1bHQgPSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7XG4gICAgICBhY3Rpb246IEFDVElPTlMuT0ZGU0NSRUVOX1NUSVRDSCxcbiAgICAgIHdpZHRoOiBkaW1lbnNpb25zLmNsaWVudFdpZHRoLFxuICAgICAgaGVpZ2h0OiBkaW1lbnNpb25zLnNjcm9sbEhlaWdodCxcbiAgICAgIGRpbWVuc2lvbnNcbiAgICB9KTtcblxuICAgIGlmICghc3RpdGNoUmVzdWx0IHx8ICFzdGl0Y2hSZXN1bHQuc3VjY2VzcyB8fCAhc3RpdGNoUmVzdWx0LmRhdGFVcmwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihzdGl0Y2hSZXN1bHQ/LmVycm9yIHx8ICdGYWxsXHUwMEYzIGxhIHVuaVx1MDBGM24gZmluYWwgZGUgbGEgY2FwdHVyYS4nKTtcbiAgICB9XG5cbiAgICAvLyBHdWFyZGFyIGxhIGltYWdlbiBlbiBJbmRleGVkREIgcGFyYSBlbCBlZGl0b3IgKGV2aXRhciBsXHUwMEVEbWl0ZXMgZGUgUkFNIGVuIG1lbnNhamVzKVxuICAgIGF3YWl0IHNhdmVDYXB0dXJlRGF0YVVybChzdGl0Y2hSZXN1bHQuZGF0YVVybCk7XG5cbiAgICAvLyBBYnJpciBsYSBwZXN0YVx1MDBGMWEgZGVsIGVkaXRvclxuICAgIGNocm9tZS50YWJzLmNyZWF0ZSh7IHVybDogY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdlZGl0b3IuaHRtbCcpIH0pO1xuXG4gICAgLy8gNi4gUmVzdGF1cmFyIGVsIGVzdGFkbyBvcmlnaW5hbCBkZSBsYSBwXHUwMEUxZ2luYSB5IGxpbXBpYXIgZWwgb2Zmc2NyZWVuXG4gICAgYXdhaXQgc2VuZFRhYk1lc3NhZ2UodGFiSWQsIHsgYWN0aW9uOiBBQ1RJT05TLlJFU1RPUkVfUEFHRSB9KTtcbiAgICBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IGFjdGlvbjogQUNUSU9OUy5PRkZTQ1JFRU5fQ0xFQU5VUCB9KTtcblxuICAgIC8vIEluZm9ybWFyIFx1MDBFOXhpdG8gYWwgUG9wdXBcbiAgICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IGFjdGlvbjogQUNUSU9OUy5DQVBUVVJFX0NPTVBMRVRFIH0pLmNhdGNoKCgpID0+IHt9KTtcblxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGR1cmFudGUgbGEgY2FwdHVyYTonLCBlcnJvcik7XG4gICAgbm90aWZ5RXJyb3IoKGVycm9yIGFzIEVycm9yKS5tZXNzYWdlIHx8ICdPY3VycmlcdTAwRjMgdW4gZXJyb3IgaW5lc3BlcmFkbyBhbCBjYXB0dXJhciBsYSBwXHUwMEUxZ2luYS4nKTtcbiAgICBcbiAgICAvLyBJbnRlbnRhciByZXN0YXVyYXIgbGEgcFx1MDBFMWdpbmEgZGVsIHVzdWFyaW8gcGFzZSBsbyBxdWUgcGFzZVxuICAgIGlmIChjdXJyZW50Q2FwdHVyZVRhYklkKSB7XG4gICAgICBzZW5kVGFiTWVzc2FnZShjdXJyZW50Q2FwdHVyZVRhYklkLCB7IGFjdGlvbjogQUNUSU9OUy5SRVNUT1JFX1BBR0UgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBpc0NhcHR1cmVJblByb2dyZXNzID0gZmFsc2U7XG4gICAgY3VycmVudENhcHR1cmVUYWJJZCA9IG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBDYW5jZWxhIGVsIHByb2Nlc28gZGUgY2FwdHVyYSBhY3Rpdm9cbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFuZGxlQ2FuY2VsQ2FwdHVyZSgpIHtcbiAgaWYgKCFpc0NhcHR1cmVJblByb2dyZXNzKSByZXR1cm47XG4gIFxuICBjb25zdCB0YWJJZCA9IGN1cnJlbnRDYXB0dXJlVGFiSWQ7XG4gIGlzQ2FwdHVyZUluUHJvZ3Jlc3MgPSBmYWxzZTtcbiAgY3VycmVudENhcHR1cmVUYWJJZCA9IG51bGw7XG5cbiAgdHJ5IHtcbiAgICBpZiAodGFiSWQpIHtcbiAgICAgIC8vIFJlc3RhdXJhciBsYSBwXHUwMEUxZ2luYSBkZWwgdXN1YXJpb1xuICAgICAgYXdhaXQgc2VuZFRhYk1lc3NhZ2UodGFiSWQsIHsgYWN0aW9uOiBBQ1RJT05TLlJFU1RPUkVfUEFHRSB9KTtcbiAgICB9XG4gICAgLy8gTGltcGlhciByZWN1cnNvcyBlbiBlbCBPZmZzY3JlZW4gRG9jdW1lbnRcbiAgICBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IGFjdGlvbjogQUNUSU9OUy5PRkZTQ1JFRU5fQ0xFQU5VUCB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGFsIGNhbmNlbGFyIGxhIGNhcHR1cmE6JywgZSk7XG4gIH1cblxuICAvLyBOb3RpZmljYXIgYWwgUG9wdXAgZGUgbGEgY2FuY2VsYWNpXHUwMEYzblxuICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IGFjdGlvbjogQUNUSU9OUy5DQVBUVVJFX0VSUk9SLCBlcnJvcjogJ0NhcHR1cmEgY2FuY2VsYWRhIHBvciBlbCB1c3VhcmlvLicgfSkuY2F0Y2goKCkgPT4ge30pO1xufVxuXG4vKipcbiAqIENhcHR1cmEgbGEgcGVzdGFcdTAwRjFhIHZpc2libGUgYWN0dWFsbWVudGVcbiAqL1xuZnVuY3Rpb24gY2FwdHVyZVRhYlZpc2libGVTZWN0aW9uKHdpbmRvd0lkOiBudW1iZXIpOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNocm9tZS50YWJzLmNhcHR1cmVWaXNpYmxlVGFiKFxuICAgICAgd2luZG93SWQsXG4gICAgICB7IGZvcm1hdDogJ3BuZycgfSxcbiAgICAgIChkYXRhVXJsKSA9PiB7XG4gICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpIHtcbiAgICAgICAgICByZWplY3QobmV3IEVycm9yKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvci5tZXNzYWdlKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoIWRhdGFVcmwpIHtcbiAgICAgICAgICByZWplY3QobmV3IEVycm9yKCdObyBzZSBwdWRvIGNhcHR1cmFyIGxhIHZlbnRhbmEgYWN0aXZhLicpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXNvbHZlKGRhdGFVcmwpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgKTtcbiAgfSk7XG59XG5cbi8qKlxuICogRW52XHUwMEVEYSB1biBtZW5zYWplIGEgdW5hIHBlc3RhXHUwMEYxYSB5IG1hbmVqYSBlcnJvcmVzIGRlIGNvbXVuaWNhY2lcdTAwRjNuIGRlIENocm9tZVxuICovXG5mdW5jdGlvbiBzZW5kVGFiTWVzc2FnZSh0YWJJZDogbnVtYmVyLCBtZXNzYWdlOiBNZXNzYWdlUGF5bG9hZCk6IFByb21pc2U8YW55PiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCBtZXNzYWdlLCAocmVzcG9uc2UpID0+IHtcbiAgICAgIC8vIEV2aXRhciBjcmFzaCBzaSBsYSBwZXN0YVx1MDBGMWEgc2UgY2Vyclx1MDBGMyBvIG5vIHJlc3BvbmRlXG4gICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKSB7XG4gICAgICAgIHJlc29sdmUoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGNocm9tZS5ydW50aW1lLmxhc3RFcnJvci5tZXNzYWdlIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufVxuXG4vKipcbiAqIEVudlx1MDBFRGEgdW5hIG5vdGlmaWNhY2lcdTAwRjNuIGRlIGVycm9yIGFsIHBvcHVwXG4gKi9cbmZ1bmN0aW9uIG5vdGlmeUVycm9yKGVycm9yTWVzc2FnZTogc3RyaW5nKSB7XG4gIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHtcbiAgICBhY3Rpb246IEFDVElPTlMuQ0FQVFVSRV9FUlJPUixcbiAgICBlcnJvcjogZXJyb3JNZXNzYWdlXG4gIH0pLmNhdGNoKCgpID0+IHtcbiAgICAvLyBTaSBlbCBwb3B1cCBlc3RcdTAwRTEgY2VycmFkbywgcG9kZW1vcyB1c2FyIHVuYSBub3RpZmljYWNpXHUwMEYzbiBkZSBDaHJvbWVcbiAgICBjaHJvbWUubm90aWZpY2F0aW9ucz8uY3JlYXRlKHtcbiAgICAgIHR5cGU6ICdiYXNpYycsXG4gICAgICBpY29uVXJsOiAnaWNvbnMvaWNvbi00OC5wbmcnLFxuICAgICAgdGl0bGU6ICdGdWxsU2hvdCAtIEVycm9yJyxcbiAgICAgIG1lc3NhZ2U6IGVycm9yTWVzc2FnZVxuICAgIH0pO1xuICB9KTtcbn1cblxuLyoqXG4gKiBBY3R1YWxpemEgZWwgZXN0YWRvIGVuIGVsIFBvcHVwXG4gKi9cbmZ1bmN0aW9uIG5vdGlmeVN0YXR1cyhzdGF0dXNUZXh0OiBzdHJpbmcpIHtcbiAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2Uoe1xuICAgIGFjdGlvbjogQUNUSU9OUy5DQVBUVVJFX1BST0dSRVNTLFxuICAgIHByb2dyZXNzOiB7IHBlcmNlbnRhZ2U6IDk1LCBjdXJyZW50U3RlcDogOSwgdG90YWxTdGVwczogMTAgfSAvLyBFc3RhZG8gZGUgcHJvY2VzYW1pZW50byBmaW5hbFxuICB9KS5jYXRjaCgoKSA9PiB7fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFBTyxNQUFNLFVBQVU7QUFBQSxJQUNyQixlQUFlO0FBQUEsSUFDZixnQkFBZ0I7QUFBQSxJQUNoQixrQkFBa0I7QUFBQSxJQUNsQixrQkFBa0I7QUFBQSxJQUNsQixlQUFlO0FBQUE7QUFBQSxJQUdmLGdCQUFnQjtBQUFBLElBQ2hCLFdBQVc7QUFBQSxJQUNYLGNBQWM7QUFBQSxJQUNkLFNBQVM7QUFBQTtBQUFBLElBR1QsdUJBQXVCO0FBQUEsSUFDdkIsb0JBQW9CO0FBQUEsSUFDcEIsa0JBQWtCO0FBQUEsSUFDbEIsbUJBQW1CO0FBQUEsRUFDckI7OztBQ2xCQSxNQUFNLFVBQVU7QUFDaEIsTUFBTSxhQUFhO0FBQ25CLE1BQU0sYUFBYTtBQUNuQixNQUFNLGNBQWM7QUFLcEIsV0FBUyxTQUErQjtBQUN0QyxXQUFPLElBQUksUUFBUSxDQUFDLFNBQVMsV0FBVztBQUN0QyxZQUFNLFVBQVUsVUFBVSxLQUFLLFNBQVMsVUFBVTtBQUVsRCxjQUFRLFVBQVUsTUFBTSxPQUFPLFFBQVEsS0FBSztBQUM1QyxjQUFRLFlBQVksTUFBTSxRQUFRLFFBQVEsTUFBTTtBQUVoRCxjQUFRLGtCQUFrQixDQUFDLFVBQVU7QUFDbkMsY0FBTSxLQUFNLE1BQU0sT0FBNEI7QUFDOUMsWUFBSSxDQUFDLEdBQUcsaUJBQWlCLFNBQVMsVUFBVSxHQUFHO0FBQzdDLGFBQUcsa0JBQWtCLFVBQVU7QUFBQSxRQUNqQztBQUFBLE1BQ0Y7QUFBQSxJQUNGLENBQUM7QUFBQSxFQUNIO0FBS0EsaUJBQXNCLG1CQUFtQixTQUFnQztBQUN2RSxVQUFNLEtBQUssTUFBTSxPQUFPO0FB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b0MsQ0FBQyxFQUFFLE1BQU0sTUFBTTtBQUFBLElBQUMsQ0FBQztBQUFBLEVBQzFIO0FBS0EsV0FBUyx5QkFBeUIsVUFBbUM7QUFDbkUsV0FBTyxJQUFJLFFBQVEsQ0FBQyxTQUFTLFdBQVc7QUFDdEMsYUFBTyxLQUFLO0FBQUEsUUFDVjtBQUFBLFFBQ0EsRUFBRSxRQUFRLE1BQU07QUFBQSxRQUNoQixDQUFDLFlBQVk7QUFDWCxjQUFJLE9BQU8sUUFBUSxXQUFXO0FBQzVCLG1CQUFPLElBQUksTUFBTSxPQUFPLFFBQVEsVUFBVSxPQUFPLENBQUM7QUFBQSxVQUNwRCxXQUFXLENBQUMsU0FBUztBQUNuQixtQkFBTyxJQUFJLE1BQU0sd0NBQXdDLENBQUM7QUFBQSxVQUM1RCxPQUFPO0FBQ0wsb0JBQVEsT0FBTztBQUFBLFVBQ2pCO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGLENBQUM7QUFBQSxFQUNIO0FBS0EsV0FBUyxlQUFlLE9BQWUsU0FBdUM7QUFDNUUsV0FBTyxJQUFJLFFBQVEsQ0FBQyxZQUFZO0FBQzlCLGFBQU8sS0FBSyxZQUFZLE9BQU8sU0FBUyxDQUFDLGFBQWE7QUFFcEQsWUFBSSxPQUFPLFFBQVEsV0FBVztBQUM1QixrQkFBUSxFQUFFLFNBQVMsT0FBTyxPQUFPLE9BQU8sUUFBUSxVQUFVLFFBQVEsQ0FBQztBQUFBLFFBQ3JFLE9BQU87QUFDTCxrQkFBUSxRQUFRO0FBQUEsUUFDbEI7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNILENBQUM7QUFBQSxFQUNIO0FBS0EsV0FBUyxZQUFZLGNBQXNCO0FBQ3pDLFdBQU8sUUFBUSxZQUFZO0FBQUEsTUFDekIsUUFBUSxRQUFRO0FBQUEsTUFDaEIsT0FBTztBQUFBLElBQ1QsQ0FBQyxFQUFFLE1BQU0sTUFBTTtBQUViLGFBQU8sZUFBZSxPQUFPO0FBQUEsUUFDM0IsTUFBTTtBQUFBLFFBQ04sU0FBUztBQUFBLFFBQ1QsT0FBTztBQUFBLFFBQ1AsU0FBUztBQUFBLE1BQ1gsQ0FBQztBQUFBLElBQ0gsQ0FBQztBQUFBLEVBQ0g7QUFLQSxXQUFTLGFBQWEsWUFBb0I7QUFDeEMsV0FBTyxRQUFRLFlBQVk7QUFBQSxNQUN6QixRQUFRLFFBQVE7QUFBQSxNQUNoQixVQUFVLEVBQUUsWUFBWSxJQUFJLGFBQWEsR0FBRyxZQUFZLEdBQUc7QUFBQTtBQUFBLElBQzdELENBQUMsRUFBRSxNQUFNLE1BQU07QUFBQSxJQUFDLENBQUM7QUFBQSxFQUNuQjsiLAogICJuYW1lcyI6IFtdCn0K
