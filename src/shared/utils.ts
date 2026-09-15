/**
 * Genera un nombre de archivo amigable basado en la URL de la página
 */
export function generateFilename(urlStr: string, format: string = 'png'): string {
  try {
    const url = new URL(urlStr);
    const domain = url.hostname
      .replace(/^www\./, '')
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
      
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    
    return `FullShot-${domain || 'page'}-${dateStr}.${format}`;
  } catch {
    return `FullShot-page-${Date.now()}.${format}`;
  }
}
