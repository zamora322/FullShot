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
  var OVERLAY_ID = "fullshot-capture-overlay";
  var PROGRESS_BAR_ID = "fullshot-progress-bar";
  var PROGRESS_TEXT_ID = "fullshot-progress-text";
  var CANCEL_BUTTON_ID = "fullshot-cancel-button";
  var STYLE_TAG_ID = "fullshot-temporary-styles";

  // src/content/page-controller.ts
  var hiddenElements = [];
  var originalScrollX = 0;
  var originalScrollY = 0;
  var currentScrollElement = null;
  var originalElementScrollTop = 0;
  var isCapturing = false;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === ACTIONS.GET_DIMENSIONS) {
      if (!isCapturing) {
        savePageState();
      }
      const dimensions = getDimensions();
      sendResponse({ success: true, dimensions });
      return true;
    }
    if (message.action === ACTIONS.SCROLL_TO && message.y !== void 0) {
      if (!isCapturing) {
        isCapturing = true;
        preparePageForCapture();
      }
      scrollToPosition(message.y).then((actualY) => {
        sendResponse({ success: true, y: actualY });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }
    if (message.action === ACTIONS.CAPTURE_PROGRESS && message.progress) {
      updateProgressUI(message.progress.percentage);
      sendResponse({ success: true });
      return true;
    }
    if (message.action === ACTIONS.HIDE_UI) {
      const overlay = document.getElementById(OVERLAY_ID);
      if (overlay)
        overlay.style.opacity = "0";
      sendResponse({ success: true });
      return true;
    }
    if (message.action === ACTIONS.RESTORE_PAGE) {
      restorePageState();
      sendResponse({ success: true });
      return true;
    }
  });
  function savePageState() {
    originalScrollX = window.scrollX || window.pageXOffset;
    originalScrollY = window.scrollY || window.pageYOffset;
    if (currentScrollElement) {
      originalElementScrollTop = currentScrollElement.scrollTop;
    }
  }
  function findScrollableElement() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const candidates = [];
    const allElements = document.querySelectorAll("*");
    allElements.forEach((node) => {
      if (!(node instanceof HTMLElement))
        return;
      if (node.id === OVERLAY_ID || node.tagName === "HTML" || node.tagName === "BODY")
        return;
      if (node.tagName === "SCRIPT" || node.tagName === "STYLE" || node.tagName === "NOSCRIPT")
        return;
      const rect = node.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100)
        return;
      if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw)
        return;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
        return;
      const overflowY = style.overflowY;
      const isOverflowScroll = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      const scrollDiff = node.scrollHeight - node.clientHeight;
      if (scrollDiff > 30) {
        let canScroll = isOverflowScroll || node.scrollTop > 0;
        if (!canScroll) {
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
          let score = viewportFraction * Math.min(scrollDiff, 5e3);
          if (isDialog) {
            score *= 3;
          }
          candidates.push({ element: node, score });
        }
      }
    });
    if (candidates.length === 0)
      return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].element;
  }
  function getDimensions() {
    const body = document.body;
    const html = document.documentElement;
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
  function scrollToPosition(y) {
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
  function preparePageForCapture() {
    if (!document.getElementById(STYLE_TAG_ID)) {
      const style = document.createElement("style");
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
    const allElements = document.querySelectorAll("*");
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    allElements.forEach((el) => {
      if (!(el instanceof HTMLElement))
        return;
      const style = window.getComputedStyle(el);
      const position = style.position;
      if (position === "fixed" || position === "sticky") {
        if (el.id === OVERLAY_ID)
          return;
        if (currentScrollElement && (el === currentScrollElement || el.contains(currentScrollElement) || currentScrollElement.contains(el))) {
          return;
        }
        const rect = el.getBoundingClientRect();
        const isVisible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
        if (isVisible) {
          const isStructuralContainer = rect.width >= viewportWidth * 0.95 && rect.height >= viewportHeight * 0.95;
          if (!isStructuralContainer) {
            hiddenElements.push({
              element: el,
              originalVisibility: el.style.visibility
            });
            el.style.setProperty("visibility", "hidden", "important");
          }
        }
      }
    });
    injectProgressUI();
  }
  function restorePageState() {
    isCapturing = false;
    const styleTag = document.getElementById(STYLE_TAG_ID);
    if (styleTag) {
      styleTag.remove();
    }
    hiddenElements.forEach((item) => {
      if (item.element) {
        item.element.style.visibility = item.originalVisibility;
      }
    });
    hiddenElements = [];
    removeProgressUI();
    if (currentScrollElement) {
      currentScrollElement.scrollTop = originalElementScrollTop;
      currentScrollElement = null;
    }
    window.scrollTo(originalScrollX, originalScrollY);
  }
  function injectProgressUI() {
    if (document.getElementById(OVERLAY_ID))
      return;
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
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
    const header = document.createElement("div");
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
    const progressContainer = document.createElement("div");
    progressContainer.style.cssText = `
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
  `;
    const progressBar = document.createElement("div");
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
    const cancelBtn = document.createElement("button");
    cancelBtn.id = CANCEL_BUTTON_ID;
    cancelBtn.textContent = "Cancelar";
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
    cancelBtn.onmouseenter = () => {
      cancelBtn.style.background = "rgba(239, 68, 68, 0.25)";
      cancelBtn.style.borderColor = "rgba(239, 68, 68, 0.5)";
    };
    cancelBtn.onmouseleave = () => {
      cancelBtn.style.background = "rgba(239, 68, 68, 0.15)";
      cancelBtn.style.borderColor = "rgba(239, 68, 68, 0.3)";
    };
    cancelBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: ACTIONS.CANCEL_CAPTURE });
    });
    overlay.appendChild(cancelBtn);
    document.body.appendChild(overlay);
  }
  function updateProgressUI(percentage) {
    const overlay = document.getElementById(OVERLAY_ID);
    const bar = document.getElementById(PROGRESS_BAR_ID);
    const text = document.getElementById(PROGRESS_TEXT_ID);
    if (overlay) {
      overlay.style.opacity = "1";
    }
    if (bar) {
      bar.style.width = `${percentage}%`;
    }
    if (text) {
      text.textContent = `Capturando... ${Math.round(percentage)}%`;
    }
  }
  function removeProgressUI() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.remove();
    }
  }
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3NoYXJlZC9jb25zdGFudHMudHMiLCAiLi4vc3JjL2NvbnRlbnQvcGFnZS1jb250cm9sbGVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJleHBvcnQgY29uc3QgQUNUSU9OUyA9IHtcclxuICBTVEFSVF9DQVBUVVJFOiAnU1RBUlRfQ0FQVFVSRScsXHJcbiAgQ0FOQ0VMX0NBUFRVUkU6ICdDQU5DRUxfQ0FQVFVSRScsXHJcbiAgQ0FQVFVSRV9QUk9HUkVTUzogJ0NBUFRVUkVfUFJPR1JFU1MnLFxyXG4gIENBUFRVUkVfQ09NUExFVEU6ICdDQVBUVVJFX0NPTVBMRVRFJyxcclxuICBDQVBUVVJFX0VSUk9SOiAnQ0FQVFVSRV9FUlJPUicsXHJcbiAgXHJcbiAgLy8gTWVuc2FqZXMgZW50cmUgU2VydmljZSBXb3JrZXIgeSBDb250ZW50IFNjcmlwdFxyXG4gIEdFVF9ESU1FTlNJT05TOiAnR0VUX0RJTUVOU0lPTlMnLFxyXG4gIFNDUk9MTF9UTzogJ1NDUk9MTF9UTycsXHJcbiAgUkVTVE9SRV9QQUdFOiAnUkVTVE9SRV9QQUdFJyxcclxuICBISURFX1VJOiAnSElERV9VSScsXHJcbiAgXHJcbiAgLy8gTWVuc2FqZXMgcGFyYSBlbCBPZmZzY3JlZW4gRG9jdW1lbnRcclxuICBPRkZTQ1JFRU5fSU5JVF9DQU5WQVM6ICdPRkZTQ1JFRU5fSU5JVF9DQU5WQVMnLFxyXG4gIE9GRlNDUkVFTl9BRERfUEFSVDogJ09GRlNDUkVFTl9BRERfUEFSVCcsXHJcbiAgT0ZGU0NSRUVOX1NUSVRDSDogJ09GRlNDUkVFTl9TVElUQ0gnLFxyXG4gIE9GRlNDUkVFTl9DTEVBTlVQOiAnT0ZGU0NSRUVOX0NMRUFOVVAnXHJcbn0gYXMgY29uc3Q7XHJcblxyXG5leHBvcnQgY29uc3QgT1ZFUkxBWV9JRCA9ICdmdWxsc2hvdC1jYXB0dXJlLW92ZXJsYXknO1xyXG5leHBvcnQgY29uc3QgUFJPR1JFU1NfQkFSX0lEID0gJ2Z1bGxzaG90LXByb2dyZXNzLWJhcic7XHJcbmV4cG9ydCBjb25zdCBQUk9HUkVTU19URVhUX0lEID0gJ2Z1bGxzaG90LXByb2dyZXNzLXRleHQnO1xyXG5leHBvcnQgY29uc3QgQ0FOQ0VMX0JVVFRPTl9JRCA9ICdmdWxsc2hvdC1jYW5jZWwtYnV0dG9uJztcclxuZXhwb3J0IGNvbnN0IFNUWUxFX1RBR19JRCA9ICdmdWxsc2hvdC10ZW1wb3Jhcnktc3R5bGVzJztcclxuIiwgImltcG9ydCB7IEFDVElPTlMsIE9WRVJMQVlfSUQsIFBST0dSRVNTX0JBUl9JRCwgUFJPR1JFU1NfVEVYVF9JRCwgQ0FOQ0VMX0JVVFRPTl9JRCwgU1RZTEVfVEFHX0lEIH0gZnJvbSAnLi4vc2hhcmVkL2NvbnN0YW50cyc7XHJcbmltcG9ydCB7IE1lc3NhZ2VQYXlsb2FkLCBQYWdlRGltZW5zaW9ucyB9IGZyb20gJy4uL3NoYXJlZC90eXBlcyc7XHJcblxyXG5pbnRlcmZhY2UgSGlkZGVuRWxlbWVudCB7XHJcbiAgZWxlbWVudDogSFRNTEVsZW1lbnQ7XHJcbiAgb3JpZ2luYWxWaXNpYmlsaXR5OiBzdHJpbmc7XHJcbn1cclxuXHJcbmxldCBoaWRkZW5FbGVtZW50czogSGlkZGVuRWxlbWVudFtdID0gW107XHJcbmxldCBvcmlnaW5hbFNjcm9sbFggPSAwO1xyXG5sZXQgb3JpZ2luYWxTY3JvbGxZID0gMDtcclxubGV0IGN1cnJlbnRTY3JvbGxFbGVtZW50OiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xyXG5sZXQgb3JpZ2luYWxFbGVtZW50U2Nyb2xsVG9wID0gMDtcclxubGV0IGlzQ2FwdHVyaW5nID0gZmFsc2U7XHJcblxyXG4vLyBFc2N1Y2hhciBtZW5zYWplcyBkZWwgU2VydmljZSBXb3JrZXJcclxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlOiBNZXNzYWdlUGF5bG9hZCwgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcclxuICBpZiAobWVzc2FnZS5hY3Rpb24gPT09IEFDVElPTlMuR0VUX0RJTUVOU0lPTlMpIHtcclxuICAgIGlmICghaXNDYXB0dXJpbmcpIHtcclxuICAgICAgLy8gR3VhcmRhciBlbCBlc3RhZG8gaW5pY2lhbCBkZSBsYSBwXHUwMEUxZ2luYSBhbnRlcyBkZSBsYSBwcmltZXJhIGNhcHR1cmFcclxuICAgICAgc2F2ZVBhZ2VTdGF0ZSgpO1xyXG4gICAgfVxyXG4gICAgXHJcbiAgICBjb25zdCBkaW1lbnNpb25zID0gZ2V0RGltZW5zaW9ucygpO1xyXG4gICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSwgZGltZW5zaW9ucyB9KTtcclxuICAgIHJldHVybiB0cnVlO1xyXG4gIH1cclxuICBcclxuICBpZiAobWVzc2FnZS5hY3Rpb24gPT09IEFDVElPTlMuU0NST0xMX1RPICYmIG1lc3NhZ2UueSAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAvLyBTaSBlcyBlbCBwcmltZXIgc2Nyb2xsLCBwb2RlbW9zIGFwbGljYXIgbG9zIGVzdGlsb3MgdGVtcG9yYWxlcyB5IG9jdWx0YXIgZml4ZWQvc3RpY2t5XHJcbiAgICBpZiAoIWlzQ2FwdHVyaW5nKSB7XHJcbiAgICAgIGlzQ2FwdHVyaW5nID0gdHJ1ZTtcclxuICAgICAgcHJlcGFyZVBhZ2VGb3JDYXB0dXJlKCk7XHJcbiAgICB9XHJcbiAgICBcclxuICAgIHNjcm9sbFRvUG9zaXRpb24obWVzc2FnZS55KVxyXG4gICAgICAudGhlbigoYWN0dWFsWSkgPT4ge1xyXG4gICAgICAgIC8vIEVudmlhciByZXNwdWVzdGEgY29uIGxhIHBvc2ljaVx1MDBGM24gZGUgc2Nyb2xsIFkgcmVhbCBwYXJhIHN0aXRjaGluZyBwcmVjaXNvXHJcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSwgeTogYWN0dWFsWSB9KTtcclxuICAgICAgfSlcclxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcclxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xyXG4gICAgICB9KTtcclxuICAgICAgXHJcbiAgICByZXR1cm4gdHJ1ZTsgLy8gQXNcdTAwRURuY3Jvbm9cclxuICB9XHJcbiAgXHJcbiAgaWYgKG1lc3NhZ2UuYWN0aW9uID09PSBBQ1RJT05TLkNBUFRVUkVfUFJPR1JFU1MgJiYgbWVzc2FnZS5wcm9ncmVzcykge1xyXG4gICAgdXBkYXRlUHJvZ3Jlc3NVSShtZXNzYWdlLnByb2dyZXNzLnBlcmNlbnRhZ2UpO1xyXG4gICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcclxuICAgIHJldHVybiB0cnVlO1xyXG4gIH1cclxuICBcclxuICBpZiAobWVzc2FnZS5hY3Rpb24gPT09IEFDVElPTlMuSElERV9VSSkge1xyXG4gICAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKE9WRVJMQVlfSUQpO1xyXG4gICAgaWYgKG92ZXJsYXkpIG92ZXJsYXkuc3R5bGUub3BhY2l0eSA9ICcwJztcclxuICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUgfSk7XHJcbiAgICByZXR1cm4gdHJ1ZTtcclxuICB9XHJcbiAgXHJcbiAgaWYgKG1lc3NhZ2UuYWN0aW9uID09PSBBQ1RJT05TLlJFU1RPUkVfUEFHRSkge1xyXG4gICAgcmVzdG9yZVBhZ2VTdGF0ZSgpO1xyXG4gICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcclxuICAgIHJldHVybiB0cnVlO1xyXG4gIH1cclxufSk7XHJcblxyXG4vKipcclxuICogR3VhcmRhIGVsIGVzdGFkbyBvcmlnaW5hbCBkZWwgc2Nyb2xsIHkgZGVsIERPTVxyXG4gKi9cclxuZnVuY3Rpb24gc2F2ZVBhZ2VTdGF0ZSgpIHtcclxuICBvcmlnaW5hbFNjcm9sbFggPSB3aW5kb3cuc2Nyb2xsWCB8fCB3aW5kb3cucGFnZVhPZmZzZXQ7XHJcbiAgb3JpZ2luYWxTY3JvbGxZID0gd2luZG93LnNjcm9sbFkgfHwgd2luZG93LnBhZ2VZT2Zmc2V0O1xyXG4gIGlmIChjdXJyZW50U2Nyb2xsRWxlbWVudCkge1xyXG4gICAgb3JpZ2luYWxFbGVtZW50U2Nyb2xsVG9wID0gY3VycmVudFNjcm9sbEVsZW1lbnQuc2Nyb2xsVG9wO1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIEJ1c2NhIHNpIGV4aXN0ZSB1biBlbGVtZW50byBwcmluY2lwYWwgZW4gbGEgcFx1MDBFMWdpbmEgcXVlIGNvbnRlbmdhIHNjcm9sbCBpbnRlcm5vIHJlbGV2YW50ZVxyXG4gKiAocG9yIGVqZW1wbG8gdW4gZGlcdTAwRTFsb2dvIG1vZGFsLCBwYW5lbCBkZSBhZG1pbmlzdHJhY2lcdTAwRjNuIG8gY29udGVuZWRvciBTUEEpXHJcbiAqL1xyXG5mdW5jdGlvbiBmaW5kU2Nyb2xsYWJsZUVsZW1lbnQoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcclxuICBjb25zdCB2dyA9IHdpbmRvdy5pbm5lcldpZHRoO1xyXG4gIGNvbnN0IHZoID0gd2luZG93LmlubmVySGVpZ2h0O1xyXG5cclxuICBjb25zdCBjYW5kaWRhdGVzOiB7IGVsZW1lbnQ6IEhUTUxFbGVtZW50OyBzY29yZTogbnVtYmVyIH1bXSA9IFtdO1xyXG4gIGNvbnN0IGFsbEVsZW1lbnRzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnKicpO1xyXG5cclxuICBhbGxFbGVtZW50cy5mb3JFYWNoKChub2RlKSA9PiB7XHJcbiAgICBpZiAoIShub2RlIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpKSByZXR1cm47XHJcbiAgICBpZiAobm9kZS5pZCA9PT0gT1ZFUkxBWV9JRCB8fCBub2RlLnRhZ05hbWUgPT09ICdIVE1MJyB8fCBub2RlLnRhZ05hbWUgPT09ICdCT0RZJykgcmV0dXJuO1xyXG4gICAgaWYgKG5vZGUudGFnTmFtZSA9PT0gJ1NDUklQVCcgfHwgbm9kZS50YWdOYW1lID09PSAnU1RZTEUnIHx8IG5vZGUudGFnTmFtZSA9PT0gJ05PU0NSSVBUJykgcmV0dXJuO1xyXG5cclxuICAgIGNvbnN0IHJlY3QgPSBub2RlLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgLy8gRGViZSB0ZW5lciB1biB0YW1hXHUwMEYxbyB2aXNpYmxlIHNpZ25pZmljYXRpdm8gKG1cdTAwRURuaW1vIDEwMHgxMDBweClcclxuICAgIGlmIChyZWN0LndpZHRoIDwgMTAwIHx8IHJlY3QuaGVpZ2h0IDwgMTAwKSByZXR1cm47XHJcbiAgICAvLyBEZWJlIGVzdGFyIGRlbnRybyBkZWwgdmlld3BvcnQgdmlzaWJsZSBhY3R1YWxcclxuICAgIGlmIChyZWN0LmJvdHRvbSA8PSAwIHx8IHJlY3QudG9wID49IHZoIHx8IHJlY3QucmlnaHQgPD0gMCB8fCByZWN0LmxlZnQgPj0gdncpIHJldHVybjtcclxuXHJcbiAgICBjb25zdCBzdHlsZSA9IHdpbmRvdy5nZXRDb21wdXRlZFN0eWxlKG5vZGUpO1xyXG4gICAgaWYgKHN0eWxlLmRpc3BsYXkgPT09ICdub25lJyB8fCBzdHlsZS52aXNpYmlsaXR5ID09PSAnaGlkZGVuJyB8fCBzdHlsZS5vcGFjaXR5ID09PSAnMCcpIHJldHVybjtcclxuXHJcbiAgICBjb25zdCBvdmVyZmxvd1kgPSBzdHlsZS5vdmVyZmxvd1k7XHJcbiAgICBjb25zdCBpc092ZXJmbG93U2Nyb2xsID0gb3ZlcmZsb3dZID09PSAnYXV0bycgfHwgb3ZlcmZsb3dZID09PSAnc2Nyb2xsJyB8fCBvdmVyZmxvd1kgPT09ICdvdmVybGF5JztcclxuICAgIGNvbnN0IHNjcm9sbERpZmYgPSBub2RlLnNjcm9sbEhlaWdodCAtIG5vZGUuY2xpZW50SGVpZ2h0O1xyXG5cclxuICAgIC8vIFNpIHRpZW5lIHNjcm9sbCB2ZXJ0aWNhbCBkZSBhbCBtZW5vcyAzMCBwXHUwMEVEeGVsZXNcclxuICAgIGlmIChzY3JvbGxEaWZmID4gMzApIHtcclxuICAgICAgbGV0IGNhblNjcm9sbCA9IGlzT3ZlcmZsb3dTY3JvbGwgfHwgbm9kZS5zY3JvbGxUb3AgPiAwO1xyXG4gICAgICBpZiAoIWNhblNjcm9sbCkge1xyXG4gICAgICAgIC8vIFBydWViYSBkZSBzY3JvbGwgYWN0aXZvXHJcbiAgICAgICAgY29uc3QgcHJldiA9IG5vZGUuc2Nyb2xsVG9wO1xyXG4gICAgICAgIG5vZGUuc2Nyb2xsVG9wID0gcHJldiArIDE7XHJcbiAgICAgICAgaWYgKG5vZGUuc2Nyb2xsVG9wICE9PSBwcmV2KSB7XHJcbiAgICAgICAgICBjYW5TY3JvbGwgPSB0cnVlO1xyXG4gICAgICAgICAgbm9kZS5zY3JvbGxUb3AgPSBwcmV2O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKGNhblNjcm9sbCkge1xyXG4gICAgICAgIGNvbnN0IGFyZWEgPSByZWN0LndpZHRoICogcmVjdC5oZWlnaHQ7XHJcbiAgICAgICAgY29uc3Qgdmlld3BvcnRGcmFjdGlvbiA9IGFyZWEgLyAodncgKiB2aCk7XHJcbiAgICAgICAgY29uc3QgaXNEaWFsb2cgPSBub2RlLmNsb3Nlc3QoJ1tyb2xlPVwiZGlhbG9nXCJdLCBbcm9sZT1cImFsZXJ0ZGlhbG9nXCJdLCBkaWFsb2csIC5tb2RhbCwgW2NsYXNzKj1cIm1vZGFsXCJdLCBbY2xhc3MqPVwiZGlhbG9nXCJdJykgIT09IG51bGw7XHJcbiAgICAgICAgXHJcbiAgICAgICAgbGV0IHNjb3JlID0gdmlld3BvcnRGcmFjdGlvbiAqIE1hdGgubWluKHNjcm9sbERpZmYsIDUwMDApO1xyXG4gICAgICAgIGlmIChpc0RpYWxvZykge1xyXG4gICAgICAgICAgc2NvcmUgKj0gMzsgLy8gUHJpb3JpZGFkIGFsdGEgcGFyYSBtb2RhbGVzIGFjdGl2b3NcclxuICAgICAgICB9XHJcbiAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHsgZWxlbWVudDogbm9kZSwgc2NvcmUgfSk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgaWYgKGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcclxuICBjYW5kaWRhdGVzLnNvcnQoKGEsIGIpID0+IGIuc2NvcmUgLSBhLnNjb3JlKTtcclxuICByZXR1cm4gY2FuZGlkYXRlc1swXS5lbGVtZW50O1xyXG59XHJcblxyXG4vKipcclxuICogT2J0aWVuZSBsYXMgZGltZW5zaW9uZXMgZGUgbGEgcFx1MDBFMWdpbmEgYWN0aXZhXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXREaW1lbnNpb25zKCk6IFBhZ2VEaW1lbnNpb25zIHtcclxuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuYm9keTtcclxuICBjb25zdCBodG1sID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xyXG5cclxuICAvLyBDYWxjdWxhbW9zIGxhIGFsdHVyYSB0b3RhbCBkZSBmb3JtYSByb2J1c3RhXHJcbiAgY29uc3Qgd2luZG93U2Nyb2xsSGVpZ2h0ID0gTWF0aC5tYXgoXHJcbiAgICBib2R5LnNjcm9sbEhlaWdodCxcclxuICAgIGJvZHkub2Zmc2V0SGVpZ2h0LFxyXG4gICAgaHRtbC5jbGllbnRIZWlnaHQsXHJcbiAgICBodG1sLnNjcm9sbEhlaWdodCxcclxuICAgIGh0bWwub2Zmc2V0SGVpZ2h0XHJcbiAgKTtcclxuXHJcbiAgY29uc3Qgd2luZG93U2Nyb2xsV2lkdGggPSBNYXRoLm1heChcclxuICAgIGJvZHkuc2Nyb2xsV2lkdGgsXHJcbiAgICBib2R5Lm9mZnNldFdpZHRoLFxyXG4gICAgaHRtbC5jbGllbnRXaWR0aCxcclxuICAgIGh0bWwuc2Nyb2xsV2lkdGgsXHJcbiAgICBodG1sLm9mZnNldFdpZHRoXHJcbiAgKTtcclxuXHJcbiAgY29uc3QgY2xpZW50V2lkdGggPSBodG1sLmNsaWVudFdpZHRoO1xyXG4gIGNvbnN0IGNsaWVudEhlaWdodCA9IGh0bWwuY2xpZW50SGVpZ2h0O1xyXG4gIGNvbnN0IGRldmljZVBpeGVsUmF0aW8gPSB3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAxO1xyXG5cclxuICBjb25zdCB3aW5kb3dTY3JvbGxEaWZmID0gd2luZG93U2Nyb2xsSGVpZ2h0IC0gY2xpZW50SGVpZ2h0O1xyXG4gIGNvbnN0IHNjcm9sbEVsID0gZmluZFNjcm9sbGFibGVFbGVtZW50KCk7XHJcblxyXG4gIC8vIFNpIGVuY29udHJhbW9zIHVuIGVsZW1lbnRvIGNvbiBzY3JvbGw6XHJcbiAgLy8gLSBTaSB3aW5kb3cgcHJcdTAwRTFjdGljYW1lbnRlIG5vIHRpZW5lIHNjcm9sbCAoPCA1MHB4IGRlIGRpZmVyZW5jaWEpLCBvXHJcbiAgLy8gLSBTaSBlbCBlbGVtZW50byBlcyB1biBtb2RhbCBhY3Rpdm8gY29uIHNjcm9sbCwgb1xyXG4gIC8vIC0gU2kgZWwgZWxlbWVudG8gdGllbmUgdW4gc2Nyb2xsIG1heW9yIHF1ZSBlbCBkZSBsYSB2ZW50YW5hXHJcbiAgaWYgKHNjcm9sbEVsKSB7XHJcbiAgICBjb25zdCBlbFNjcm9sbERpZmYgPSBzY3JvbGxFbC5zY3JvbGxIZWlnaHQgLSBzY3JvbGxFbC5jbGllbnRIZWlnaHQ7XHJcbiAgICBjb25zdCBpc01vZGFsID0gc2Nyb2xsRWwuY2xvc2VzdCgnW3JvbGU9XCJkaWFsb2dcIl0sIFtyb2xlPVwiYWxlcnRkaWFsb2dcIl0sIGRpYWxvZywgLm1vZGFsLCBbY2xhc3MqPVwibW9kYWxcIl0sIFtjbGFzcyo9XCJkaWFsb2dcIl0nKSAhPT0gbnVsbDtcclxuXHJcbiAgICBpZiAod2luZG93U2Nyb2xsRGlmZiA8IDUwIHx8IGlzTW9kYWwgfHwgZWxTY3JvbGxEaWZmID4gd2luZG93U2Nyb2xsRGlmZikge1xyXG4gICAgICBjdXJyZW50U2Nyb2xsRWxlbWVudCA9IHNjcm9sbEVsO1xyXG4gICAgICBjb25zdCByZWN0ID0gc2Nyb2xsRWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcblxyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIHNjcm9sbFdpZHRoOiB3aW5kb3dTY3JvbGxXaWR0aCxcclxuICAgICAgICBzY3JvbGxIZWlnaHQ6IHdpbmRvd1Njcm9sbEhlaWdodCxcclxuICAgICAgICBjbGllbnRXaWR0aCxcclxuICAgICAgICBjbGllbnRIZWlnaHQsXHJcbiAgICAgICAgZGV2aWNlUGl4ZWxSYXRpbyxcclxuICAgICAgICBpc0VsZW1lbnRTY3JvbGw6IHRydWUsXHJcbiAgICAgICAgZWxlbWVudFJlY3Q6IHtcclxuICAgICAgICAgIGxlZnQ6IHJlY3QubGVmdCxcclxuICAgICAgICAgIHRvcDogcmVjdC50b3AsXHJcbiAgICAgICAgICB3aWR0aDogcmVjdC53aWR0aCxcclxuICAgICAgICAgIGhlaWdodDogcmVjdC5oZWlnaHRcclxuICAgICAgICB9LFxyXG4gICAgICAgIGVsZW1lbnRTY3JvbGxIZWlnaHQ6IHNjcm9sbEVsLnNjcm9sbEhlaWdodCxcclxuICAgICAgICBlbGVtZW50Q2xpZW50SGVpZ2h0OiBzY3JvbGxFbC5jbGllbnRIZWlnaHRcclxuICAgICAgfTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIGN1cnJlbnRTY3JvbGxFbGVtZW50ID0gbnVsbDtcclxuICByZXR1cm4ge1xyXG4gICAgc2Nyb2xsV2lkdGg6IHdpbmRvd1Njcm9sbFdpZHRoLFxyXG4gICAgc2Nyb2xsSGVpZ2h0OiB3aW5kb3dTY3JvbGxIZWlnaHQsXHJcbiAgICBjbGllbnRXaWR0aCxcclxuICAgIGNsaWVudEhlaWdodCxcclxuICAgIGRldmljZVBpeGVsUmF0aW8sXHJcbiAgICBpc0VsZW1lbnRTY3JvbGw6IGZhbHNlXHJcbiAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEhhY2Ugc2Nyb2xsIGEgdW5hIHBvc2ljaVx1MDBGM24gZXNwZWNcdTAwRURmaWNhIHkgZXNwZXJhIGEgcXVlIGVsIG5hdmVnYWRvciBzZSBlc3RhYmlsaWNlXHJcbiAqL1xyXG5mdW5jdGlvbiBzY3JvbGxUb1Bvc2l0aW9uKHk6IG51bWJlcik6IFByb21pc2U8bnVtYmVyPiB7XHJcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICBpZiAoY3VycmVudFNjcm9sbEVsZW1lbnQpIHtcclxuICAgICAgY3VycmVudFNjcm9sbEVsZW1lbnQuc2Nyb2xsVG9wID0geTtcclxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYWN0dWFsWSA9IGN1cnJlbnRTY3JvbGxFbGVtZW50ID8gY3VycmVudFNjcm9sbEVsZW1lbnQuc2Nyb2xsVG9wIDogeTtcclxuICAgICAgICByZXNvbHZlKGFjdHVhbFkpO1xyXG4gICAgICB9LCAyMDApO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgd2luZG93LnNjcm9sbFRvKDAsIHkpO1xyXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICBjb25zdCBhY3R1YWxZID0gd2luZG93LnNjcm9sbFkgfHwgd2luZG93LnBhZ2VZT2Zmc2V0IHx8IHk7XHJcbiAgICAgICAgcmVzb2x2ZShhY3R1YWxZKTtcclxuICAgICAgfSwgMjAwKTtcclxuICAgIH1cclxuICB9KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFByZXBhcmEgbGEgcFx1MDBFMWdpbmEgd2ViIG9jdWx0YW5kbyBlbGVtZW50b3MgZml4ZWQvc3RpY2t5IHkgZGVzYWN0aXZhbmRvIHRyYW5zaWNpb25lc1xyXG4gKi9cclxuZnVuY3Rpb24gcHJlcGFyZVBhZ2VGb3JDYXB0dXJlKCkge1xyXG4gIC8vIDEuIElueWVjdGFyIGVzdGlsb3MgcGFyYSBkZXNhY3RpdmFyIGFuaW1hY2lvbmVzLCBzY3JvbGwgc3VhdmUgeSBvY3VsdGFyIGJhcnJhcyBkZSBzY3JvbGxcclxuICBpZiAoIWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFNUWUxFX1RBR19JRCkpIHtcclxuICAgIGNvbnN0IHN0eWxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3R5bGUnKTtcclxuICAgIHN0eWxlLmlkID0gU1RZTEVfVEFHX0lEO1xyXG4gICAgc3R5bGUudGV4dENvbnRlbnQgPSBgXHJcbiAgICAgIGh0bWwsIGJvZHkge1xyXG4gICAgICAgIHNjcm9sbC1iZWhhdmlvcjogYXV0byAhaW1wb3J0YW50O1xyXG4gICAgICB9XHJcbiAgICAgICoge1xyXG4gICAgICAgIGFuaW1hdGlvbi1wbGF5LXN0YXRlOiBwYXVzZWQgIWltcG9ydGFudDtcclxuICAgICAgICB0cmFuc2l0aW9uOiBub25lICFpbXBvcnRhbnQ7XHJcbiAgICAgICAgYW5pbWF0aW9uOiBub25lICFpbXBvcnRhbnQ7XHJcbiAgICAgICAgc2Nyb2xsYmFyLXdpZHRoOiBub25lICFpbXBvcnRhbnQ7XHJcbiAgICAgICAgLW1zLW92ZXJmbG93LXN0eWxlOiBub25lICFpbXBvcnRhbnQ7XHJcbiAgICAgIH1cclxuICAgICAgKjo6LXdlYmtpdC1zY3JvbGxiYXIge1xyXG4gICAgICAgIGRpc3BsYXk6IG5vbmUgIWltcG9ydGFudDtcclxuICAgICAgfVxyXG4gICAgYDtcclxuICAgIGRvY3VtZW50LmhlYWQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xyXG4gIH1cclxuXHJcbiAgLy8gMi4gQnVzY2FyIHkgb2N1bHRhciBlbGVtZW50b3MgZml4ZWQgeSBzdGlja3lcclxuICBjb25zdCBhbGxFbGVtZW50cyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJyonKTtcclxuICBjb25zdCB2aWV3cG9ydFdpZHRoID0gd2luZG93LmlubmVyV2lkdGg7XHJcbiAgY29uc3Qgdmlld3BvcnRIZWlnaHQgPSB3aW5kb3cuaW5uZXJIZWlnaHQ7XHJcblxyXG4gIGFsbEVsZW1lbnRzLmZvckVhY2goKGVsKSA9PiB7XHJcbiAgICBpZiAoIShlbCBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSkgcmV0dXJuO1xyXG4gICAgXHJcbiAgICBjb25zdCBzdHlsZSA9IHdpbmRvdy5nZXRDb21wdXRlZFN0eWxlKGVsKTtcclxuICAgIGNvbnN0IHBvc2l0aW9uID0gc3R5bGUucG9zaXRpb247XHJcbiAgICBcclxuICAgIGlmIChwb3NpdGlvbiA9PT0gJ2ZpeGVkJyB8fCBwb3NpdGlvbiA9PT0gJ3N0aWNreScpIHtcclxuICAgICAgLy8gSWdub3JhciBlbCBvdmVybGF5IHF1ZSBpbnllY3RhIG51ZXN0cmEgcHJvcGlhIGV4dGVuc2lcdTAwRjNuXHJcbiAgICAgIGlmIChlbC5pZCA9PT0gT1ZFUkxBWV9JRCkgcmV0dXJuO1xyXG5cclxuICAgICAgLy8gU2kgZXN0YW1vcyBjYXB0dXJhbmRvIHVuIGVsZW1lbnRvIGVzcGVjXHUwMEVEZmljbywgbm8gb2N1bHRhciBlbCBlbGVtZW50byBuaSBzdXMgYW5jZXN0cm9zIG5pIGRlc2NlbmRpZW50ZXNcclxuICAgICAgaWYgKGN1cnJlbnRTY3JvbGxFbGVtZW50ICYmIChlbCA9PT0gY3VycmVudFNjcm9sbEVsZW1lbnQgfHwgZWwuY29udGFpbnMoY3VycmVudFNjcm9sbEVsZW1lbnQpIHx8IGN1cnJlbnRTY3JvbGxFbGVtZW50LmNvbnRhaW5zKGVsKSkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGNvbnN0IHJlY3QgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgY29uc3QgaXNWaXNpYmxlID0gc3R5bGUuZGlzcGxheSAhPT0gJ25vbmUnICYmIHN0eWxlLnZpc2liaWxpdHkgIT09ICdoaWRkZW4nICYmIHN0eWxlLm9wYWNpdHkgIT09ICcwJyAmJiByZWN0LndpZHRoID4gMCAmJiByZWN0LmhlaWdodCA+IDA7XHJcbiAgICAgIFxyXG4gICAgICBpZiAoaXNWaXNpYmxlKSB7XHJcbiAgICAgICAgLy8gRXZpdGFtb3Mgb2N1bHRhciBlbGVtZW50b3MgZ2lnYW50ZXNjb3MgcXVlIGFjdFx1MDBGQWVuIGNvbW8gY29udGVuZWRvcmVzIHByaW5jaXBhbGVzIGRlIGxhIGFwcC5cclxuICAgICAgICAvLyBTaSBlbCBlbGVtZW50byBjdWJyZSBtXHUwMEUxcyBkZWwgOTUlIGRlbCB2aWV3cG9ydCwgYXN1bWltb3MgcXVlIGVzIGVsIGNvbnRlbmVkb3IgZXN0cnVjdHVyYWwgcHJpbmNpcGFsLlxyXG4gICAgICAgIGNvbnN0IGlzU3RydWN0dXJhbENvbnRhaW5lciA9IHJlY3Qud2lkdGggPj0gdmlld3BvcnRXaWR0aCAqIDAuOTUgJiYgcmVjdC5oZWlnaHQgPj0gdmlld3BvcnRIZWlnaHQgKiAwLjk1O1xyXG4gICAgICAgIFxyXG4gICAgICAgIGlmICghaXNTdHJ1Y3R1cmFsQ29udGFpbmVyKSB7XHJcbiAgICAgICAgICBoaWRkZW5FbGVtZW50cy5wdXNoKHtcclxuICAgICAgICAgICAgZWxlbWVudDogZWwsXHJcbiAgICAgICAgICAgIG9yaWdpbmFsVmlzaWJpbGl0eTogZWwuc3R5bGUudmlzaWJpbGl0eVxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgICBlbC5zdHlsZS5zZXRQcm9wZXJ0eSgndmlzaWJpbGl0eScsICdoaWRkZW4nLCAnaW1wb3J0YW50Jyk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfSk7XHJcblxyXG4gIC8vIDMuIENyZWFyIGUgaW55ZWN0YXIgZWwgb3ZlcmxheSBkZSBwcm9ncmVzb1xyXG4gIGluamVjdFByb2dyZXNzVUkoKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJlc3RhdXJhIGVsIGVzdGFkbyBvcmlnaW5hbCBkZSBsYSBwXHUwMEUxZ2luYSB3ZWIgKERPTSwgc2Nyb2xsLCBldGMuKVxyXG4gKi9cclxuZnVuY3Rpb24gcmVzdG9yZVBhZ2VTdGF0ZSgpIHtcclxuICBpc0NhcHR1cmluZyA9IGZhbHNlO1xyXG5cclxuICAvLyAxLiBSZW1vdmVyIGVzdGlsb3MgdGVtcG9yYWxlc1xyXG4gIGNvbnN0IHN0eWxlVGFnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoU1RZTEVfVEFHX0lEKTtcclxuICBpZiAoc3R5bGVUYWcpIHtcclxuICAgIHN0eWxlVGFnLnJlbW92ZSgpO1xyXG4gIH1cclxuXHJcbiAgLy8gMi4gUmVzdGF1cmFyIHZpc2liaWxpZGFkIGRlIGVsZW1lbnRvcyBmaXhlZC9zdGlja3lcclxuICBoaWRkZW5FbGVtZW50cy5mb3JFYWNoKChpdGVtKSA9PiB7XHJcbiAgICBpZiAoaXRlbS5lbGVtZW50KSB7XHJcbiAgICAgIGl0ZW0uZWxlbWVudC5zdHlsZS52aXNpYmlsaXR5ID0gaXRlbS5vcmlnaW5hbFZpc2liaWxpdHk7XHJcbiAgICB9XHJcbiAgfSk7XHJcbiAgaGlkZGVuRWxlbWVudHMgPSBbXTtcclxuXHJcbiAgLy8gMy4gUmVtb3ZlciBsYSBpbnRlcmZheiBkZSBwcm9ncmVzb1xyXG4gIHJlbW92ZVByb2dyZXNzVUkoKTtcclxuXHJcbiAgLy8gNC4gUmVzdGF1cmFyIHBvc2ljaVx1MDBGM24gb3JpZ2luYWwgZGVsIHNjcm9sbFxyXG4gIGlmIChjdXJyZW50U2Nyb2xsRWxlbWVudCkge1xyXG4gICAgY3VycmVudFNjcm9sbEVsZW1lbnQuc2Nyb2xsVG9wID0gb3JpZ2luYWxFbGVtZW50U2Nyb2xsVG9wO1xyXG4gICAgY3VycmVudFNjcm9sbEVsZW1lbnQgPSBudWxsO1xyXG4gIH1cclxuICB3aW5kb3cuc2Nyb2xsVG8ob3JpZ2luYWxTY3JvbGxYLCBvcmlnaW5hbFNjcm9sbFkpO1xyXG59XHJcblxyXG4vKipcclxuICogSW55ZWN0YSBlbCB3aWRnZXQgZGUgcHJvZ3Jlc28gZW4gbGEgcFx1MDBFMWdpbmEgYWN0aXZhXHJcbiAqL1xyXG5mdW5jdGlvbiBpbmplY3RQcm9ncmVzc1VJKCkge1xyXG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChPVkVSTEFZX0lEKSkgcmV0dXJuO1xyXG5cclxuICBjb25zdCBvdmVybGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgb3ZlcmxheS5pZCA9IE9WRVJMQVlfSUQ7XHJcbiAgXHJcbiAgLy8gRXN0aWxvIHByZW1pdW0gZGVsIG92ZXJsYXkgY29uIGdsYXNzbW9ycGhpc21cclxuICBvdmVybGF5LnN0eWxlLmNzc1RleHQgPSBgXHJcbiAgICBwb3NpdGlvbjogZml4ZWQ7XHJcbiAgICBib3R0b206IDI0cHg7XHJcbiAgICByaWdodDogMjRweDtcclxuICAgIHdpZHRoOiAyODBweDtcclxuICAgIHBhZGRpbmc6IDIwcHg7XHJcbiAgICBiYWNrZ3JvdW5kOiByZ2JhKDI4LCAyOCwgMzAsIDAuOSk7XHJcbiAgICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMTJweCk7XHJcbiAgICAtd2Via2l0LWJhY2tkcm9wLWZpbHRlcjogYmx1cigxMnB4KTtcclxuICAgIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LCAyNTUsIDI1NSwgMC4xKTtcclxuICAgIGJvcmRlci1yYWRpdXM6IDE2cHg7XHJcbiAgICBib3gtc2hhZG93OiAwIDEycHggNDBweCByZ2JhKDAsIDAsIDAsIDAuNSk7XHJcbiAgICB6LWluZGV4OiA5OTk5OTk5OTtcclxuICAgIGZvbnQtZmFtaWx5OiAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIFwiU2Vnb2UgVUlcIiwgUm9ib3RvLCBIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmO1xyXG4gICAgY29sb3I6ICNmZmZmZmY7XHJcbiAgICB1c2VyLXNlbGVjdDogbm9uZTtcclxuICAgIGJveC1zaXppbmc6IGJvcmRlci1ib3g7XHJcbiAgICBkaXNwbGF5OiBmbGV4O1xyXG4gICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcclxuICAgIGdhcDogMTJweDtcclxuICBgO1xyXG5cclxuICAvLyBUXHUwMEVEdHVsbyBlIGluZm9cclxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICBoZWFkZXIuc3R5bGUuY3NzVGV4dCA9IGBcclxuICAgIGRpc3BsYXk6IGZsZXg7XHJcbiAgICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47XHJcbiAgICBhbGlnbi1pdGVtczogY2VudGVyO1xyXG4gICAgZm9udC13ZWlnaHQ6IDYwMDtcclxuICAgIGZvbnQtc2l6ZTogMTVweDtcclxuICAgIGxldHRlci1zcGFjaW5nOiAwLjNweDtcclxuICBgO1xyXG4gIGhlYWRlci5pbm5lckhUTUwgPSBgXHJcbiAgICA8c3BhbiBzdHlsZT1cImJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsICMzYjgyZjYsICM2MGE1ZmEpOyAtd2Via2l0LWJhY2tncm91bmQtY2xpcDogdGV4dDsgLXdlYmtpdC10ZXh0LWZpbGwtY29sb3I6IHRyYW5zcGFyZW50O1wiPkZ1bGxTaG90PC9zcGFuPlxyXG4gICAgPHNwYW4gaWQ9XCIke1BST0dSRVNTX1RFWFRfSUR9XCIgc3R5bGU9XCJmb250LXNpemU6IDEzcHg7IGNvbG9yOiAjYTFhMWFhOyBmb250LXdlaWdodDogNTAwO1wiPkNhcHR1cmFuZG8uLi4gMCU8L3NwYW4+XHJcbiAgYDtcclxuICBvdmVybGF5LmFwcGVuZENoaWxkKGhlYWRlcik7XHJcblxyXG4gIC8vIEJhcnJhIGRlIHByb2dyZXNvIChjb250ZW5lZG9yKVxyXG4gIGNvbnN0IHByb2dyZXNzQ29udGFpbmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgcHJvZ3Jlc3NDb250YWluZXIuc3R5bGUuY3NzVGV4dCA9IGBcclxuICAgIHdpZHRoOiAxMDAlO1xyXG4gICAgaGVpZ2h0OiA4cHg7XHJcbiAgICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwgMjU1LCAyNTUsIDAuMSk7XHJcbiAgICBib3JkZXItcmFkaXVzOiA0cHg7XHJcbiAgICBvdmVyZmxvdzogaGlkZGVuO1xyXG4gIGA7XHJcblxyXG4gIC8vIEJhcnJhIGRlIHByb2dyZXNvIChpbnRlcm5hKVxyXG4gIGNvbnN0IHByb2dyZXNzQmFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgcHJvZ3Jlc3NCYXIuaWQgPSBQUk9HUkVTU19CQVJfSUQ7XHJcbiAgcHJvZ3Jlc3NCYXIuc3R5bGUuY3NzVGV4dCA9IGBcclxuICAgIHdpZHRoOiAwJTtcclxuICAgIGhlaWdodDogMTAwJTtcclxuICAgIGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCg5MGRlZywgIzNiODJmNiwgIzYwYTVmYSk7XHJcbiAgICBib3JkZXItcmFkaXVzOiA0cHg7XHJcbiAgICB0cmFuc2l0aW9uOiB3aWR0aCAwLjJzIGVhc2Utb3V0O1xyXG4gIGA7XHJcbiAgcHJvZ3Jlc3NDb250YWluZXIuYXBwZW5kQ2hpbGQocHJvZ3Jlc3NCYXIpO1xyXG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQocHJvZ3Jlc3NDb250YWluZXIpO1xyXG5cclxuICAvLyBCb3RcdTAwRjNuIGNhbmNlbGFyXHJcbiAgY29uc3QgY2FuY2VsQnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XHJcbiAgY2FuY2VsQnRuLmlkID0gQ0FOQ0VMX0JVVFRPTl9JRDtcclxuICBjYW5jZWxCdG4udGV4dENvbnRlbnQgPSAnQ2FuY2VsYXInO1xyXG4gIGNhbmNlbEJ0bi5zdHlsZS5jc3NUZXh0ID0gYFxyXG4gICAgd2lkdGg6IDEwMCU7XHJcbiAgICBwYWRkaW5nOiAxMHB4O1xyXG4gICAgYmFja2dyb3VuZDogcmdiYSgyMzksIDY4LCA2OCwgMC4xNSk7XHJcbiAgICBjb2xvcjogI2VmNDQ0NDtcclxuICAgIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjM5LCA2OCwgNjgsIDAuMyk7XHJcbiAgICBib3JkZXItcmFkaXVzOiA4cHg7XHJcbiAgICBmb250LXNpemU6IDEzcHg7XHJcbiAgICBmb250LXdlaWdodDogNjAwO1xyXG4gICAgY3Vyc29yOiBwb2ludGVyO1xyXG4gICAgdHJhbnNpdGlvbjogYWxsIDAuMnMgZWFzZTtcclxuICAgIG91dGxpbmU6IG5vbmU7XHJcbiAgYDtcclxuXHJcbiAgLy8gRWZlY3RvcyB2aXN1YWxlcyBkZSBob3ZlclxyXG4gIGNhbmNlbEJ0bi5vbm1vdXNlZW50ZXIgPSAoKSA9PiB7XHJcbiAgICBjYW5jZWxCdG4uc3R5bGUuYmFja2dyb3VuZCA9ICdyZ2JhKDIzOSwgNjgsIDY4LCAwLjI1KSc7XHJcbiAgICBjYW5jZWxCdG4uc3R5bGUuYm9yZGVyQ29sb3IgPSAncmdiYSgyMzksIDY4LCA2OCwgMC41KSc7XHJcbiAgfTtcclxuICBjYW5jZWxCdG4ub25tb3VzZWxlYXZlID0gKCkgPT4ge1xyXG4gICAgY2FuY2VsQnRuLnN0eWxlLmJhY2tncm91bmQgPSAncmdiYSgyMzksIDY4LCA2OCwgMC4xNSknO1xyXG4gICAgY2FuY2VsQnRuLnN0eWxlLmJvcmRlckNvbG9yID0gJ3JnYmEoMjM5LCA2OCwgNjgsIDAuMyknO1xyXG4gIH07XHJcblxyXG4gIC8vIEV2ZW50byBjYW5jZWxhclxyXG4gIGNhbmNlbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcclxuICAgIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgYWN0aW9uOiBBQ1RJT05TLkNBTkNFTF9DQVBUVVJFIH0pO1xyXG4gIH0pO1xyXG5cclxuICBvdmVybGF5LmFwcGVuZENoaWxkKGNhbmNlbEJ0bik7XHJcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChvdmVybGF5KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEFjdHVhbGl6YSBsYSBiYXJyYSBkZSBwcm9ncmVzbyBkZWwgb3ZlcmxheSBlbiBsYSBwXHUwMEUxZ2luYSB3ZWJcclxuICovXHJcbmZ1bmN0aW9uIHVwZGF0ZVByb2dyZXNzVUkocGVyY2VudGFnZTogbnVtYmVyKSB7XHJcbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKE9WRVJMQVlfSUQpO1xyXG4gIGNvbnN0IGJhciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFBST0dSRVNTX0JBUl9JRCk7XHJcbiAgY29uc3QgdGV4dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFBST0dSRVNTX1RFWFRfSUQpO1xyXG4gIFxyXG4gIGlmIChvdmVybGF5KSB7XHJcbiAgICBvdmVybGF5LnN0eWxlLm9wYWNpdHkgPSAnMSc7XHJcbiAgfVxyXG4gIGlmIChiYXIpIHtcclxuICAgIGJhci5zdHlsZS53aWR0aCA9IGAke3BlcmNlbnRhZ2V9JWA7XHJcbiAgfVxyXG4gIGlmICh0ZXh0KSB7XHJcbiAgICB0ZXh0LnRleHRDb250ZW50ID0gYENhcHR1cmFuZG8uLi4gJHtNYXRoLnJvdW5kKHBlcmNlbnRhZ2UpfSVgO1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFJlbXVldmUgZWwgb3ZlcmxheSBkZSBwcm9ncmVzbyBkZWwgRE9NXHJcbiAqL1xyXG5mdW5jdGlvbiByZW1vdmVQcm9ncmVzc1VJKCkge1xyXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChPVkVSTEFZX0lEKTtcclxuICBpZiAob3ZlcmxheSkge1xyXG4gICAgb3ZlcmxheS5yZW1vdmUoKTtcclxuICB9XHJcbn1cclxuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBQU8sTUFBTSxVQUFVO0FBQUEsSUFDckIsZUFBZTtBQUFBLElBQ2YsZ0JBQWdCO0FBQUEsSUFDaEIsa0JBQWtCO0FBQUEsSUFDbEIsa0JBQWtCO0FBQUEsSUFDbEIsZUFBZTtBQUFBO0FBQUEsSUFHZixnQkFBZ0I7QUFBQSxJQUNoQixXQUFXO0FBQUEsSUFDWCxjQUFjO0FBQUEsSUFDZCxTQUFTO0FBQUE7QUFBQSxJQUdULHVCQUF1QjtBQUFBLElBQ3ZCLG9CQUFvQjtBQUFBLElBQ3BCLGtCQUFrQjtBQUFBLElBQ2xCLG1CQUFtQjtBQUFBLEVBQ3JCO0FBRU8sTUFBTSxhQUFhO0FBQ25CLE1BQU0sa0JBQWtCO0FBQ3hCLE1BQU0sbUJBQW1CO0FBQ3pCLE1BQU0sbUJBQW1CO0FBQ3pCLE1BQU0sZUFBZTs7O0FDaEI1QixNQUFJLGlCQUFrQyxDQUFDO0FBQ3ZDLE1BQUksa0JBQWtCO0FBQ3RCLE1BQUksa0JBQWtCO0FBQ3RCLE1BQUksdUJBQTJDO0FBQy9DLE1BQUksMkJBQTJCO0FBQy9CLE1BQUksY0FBYztBQUdsQixTQUFPLFFBQVEsVUFBVSxZQUFZLENBQUMsU0FBeUIsUUFBUSxpQkFBaUI7QUFDdEYsUUFBSSxRQUFRLFdBQVcsUUFBUSxnQkFBZ0I7QUFDN0MsVUFBSSxDQUFDLGFBQWE7QUFFaEIsc0JBQWM7QUFBQSxNQUNoQjtBQUVBLFlBQU0sYUFBYSxjQUFjO0FBQ2pDLG1CQUFhLEVBQUUsU0FBUyxNQUFNLFdBQVcsQ0FBQztBQUMxQyxhQUFPO0FBQUEsSUFDVDtBQUVBLFFBQUksUUFBUSxXQUFXLFFBQVEsYUFBYSxRQUFRLE1BQU0sUUFBVztBQUVuRSxVQUFJLENBQUMsYUFBYTtBQUNoQixzQkFBYztBQUNkLDhCQUFzQjtBQUFBLE1BQ3hCO0FBRUEsdUJBQWlCLFFBQVEsQ0FBQyxFQUN2QixLQUFL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
