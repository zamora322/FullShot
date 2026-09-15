export const ACTIONS = {
  START_CAPTURE: 'START_CAPTURE',
  CANCEL_CAPTURE: 'CANCEL_CAPTURE',
  CAPTURE_PROGRESS: 'CAPTURE_PROGRESS',
  CAPTURE_COMPLETE: 'CAPTURE_COMPLETE',
  CAPTURE_ERROR: 'CAPTURE_ERROR',
  
  // Mensajes entre Service Worker y Content Script
  GET_DIMENSIONS: 'GET_DIMENSIONS',
  SCROLL_TO: 'SCROLL_TO',
  RESTORE_PAGE: 'RESTORE_PAGE',
  HIDE_UI: 'HIDE_UI',
  
  // Mensajes para el Offscreen Document
  OFFSCREEN_INIT_CANVAS: 'OFFSCREEN_INIT_CANVAS',
  OFFSCREEN_ADD_PART: 'OFFSCREEN_ADD_PART',
  OFFSCREEN_STITCH: 'OFFSCREEN_STITCH',
  OFFSCREEN_CLEANUP: 'OFFSCREEN_CLEANUP'
} as const;

export const OVERLAY_ID = 'fullshot-capture-overlay';
export const PROGRESS_BAR_ID = 'fullshot-progress-bar';
export const PROGRESS_TEXT_ID = 'fullshot-progress-text';
export const CANCEL_BUTTON_ID = 'fullshot-cancel-button';
export const STYLE_TAG_ID = 'fullshot-temporary-styles';
