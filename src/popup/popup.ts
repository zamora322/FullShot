import { ACTIONS } from '../shared/constants';
import { MessagePayload } from '../shared/types';

// Elementos de la interfaz
const stateInitial = document.getElementById('state-initial') as HTMLDivElement;
const stateCapturing = document.getElementById('state-capturing') as HTMLDivElement;
const stateMessage = document.getElementById('state-message') as HTMLDivElement;

const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const okBtn = document.getElementById('ok-btn') as HTMLButtonElement;

const progressBarFill = document.getElementById('progress-bar-fill') as HTMLDivElement;
const progressPercentage = document.getElementById('progress-percentage') as HTMLSpanElement;

const messageIcon = document.getElementById('message-icon') as HTMLDivElement;
const messageText = document.getElementById('message-text') as HTMLParagraphElement;

// Inicialización de Eventos
captureBtn.addEventListener('click', () => {
  showState('capturing');
  chrome.runtime.sendMessage({ action: ACTIONS.START_CAPTURE }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      showError(chrome.runtime.lastError?.message || response?.error || 'No se pudo iniciar la captura.');
    }
  });
});

cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: ACTIONS.CANCEL_CAPTURE });
  showState('initial');
});

okBtn.addEventListener('click', () => {
  showState('initial');
});

// Escuchar actualizaciones de progreso y finalización desde el Service Worker
chrome.runtime.onMessage.addListener((message: MessagePayload) => {
  if (message.action === ACTIONS.CAPTURE_PROGRESS && message.progress) {
    showState('capturing');
    const percent = Math.round(message.progress.percentage);
    progressBarFill.style.width = `${percent}%`;
    progressPercentage.textContent = `${percent}%`;
  }
  
  if (message.action === ACTIONS.CAPTURE_COMPLETE) {
    showSuccess(`Screenshot saved successfully!<br><span style="font-size: 11px; word-break: break-all; color: #8e8e93;">${message.filename || ''}</span>`);
  }
  
  if (message.action === ACTIONS.CAPTURE_ERROR) {
    showError(message.error || 'Ocurrió un error inesperado.');
  }
});

/**
 * Cambia el estado visual del popup
 */
function showState(state: 'initial' | 'capturing' | 'message') {
  stateInitial.classList.add('hidden');
  stateCapturing.classList.add('hidden');
  stateMessage.classList.add('hidden');
  
  if (state === 'initial') {
    stateInitial.classList.remove('hidden');
    // Resetear barra de progreso
    progressBarFill.style.width = '0%';
    progressPercentage.textContent = '0%';
  } else if (state === 'capturing') {
    stateCapturing.classList.remove('hidden');
  } else if (state === 'message') {
    stateMessage.classList.remove('hidden');
  }
}

/**
 * Muestra el mensaje de éxito en la interfaz
 */
function showSuccess(htmlText: string) {
  showState('message');
  messageIcon.className = 'message-icon success';
  messageText.innerHTML = htmlText;
}

/**
 * Muestra el mensaje de error en la interfaz
 */
function showError(errorText: string) {
  showState('message');
  messageIcon.className = 'message-icon error';
  messageText.textContent = errorText;
}
