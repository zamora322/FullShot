const DB_NAME = 'FullShotDB';
const DB_VERSION = 1;
const STORE_NAME = 'captures';
const CAPTURE_KEY = 'latest_capture';

/**
 * Abre la conexión a IndexedDB para la extensión
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

/**
 * Guarda el DataURL de la captura completa en IndexedDB
 */
export async function saveCaptureDataUrl(dataUrl: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(dataUrl, CAPTURE_KEY);
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Recupera el DataURL de la captura completa desde IndexedDB
 */
export async function getCaptureDataUrl(): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(CAPTURE_KEY);
    
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Elimina la captura actual para liberar espacio
 */
export async function clearCaptureDataUrl(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(CAPTURE_KEY);
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
