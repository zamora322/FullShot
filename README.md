# FullShot - Extensión de Captura de Pantalla Completa

FullShot es una extensión para Google Chrome basada en Manifest V3 y desarrollada en TypeScript. Permite realizar capturas de pantalla de páginas web completas de manera rápida, confiable y 100% local, gestionando dinámicamente elementos sticky/fixed y el retardo necesario para la carga progresiva de contenido (lazy loading).

## Requisitos Previos

* Node.js (versión 16 o superior recomendado)
* npm (incluido con Node.js)
* Google Chrome

## Instalación y Desarrollo Local

Sigue estos pasos para compilar e instalar la extensión en tu navegador Chrome local:

### 1. Clonar o acceder al directorio del proyecto

Asegúrate de estar en el directorio raíz del proyecto:
`/Users/zamora322/Documentos/FullShot`

### 2. Instalar dependencias de desarrollo

Instala TypeScript y esbuild ejecutando en la terminal:
```bash
npm install
```

### 3. Compilar el proyecto

Compila el código TypeScript a JavaScript empaquetado:
```bash
npm run build
```
Esto creará una carpeta `dist/` en la raíz del proyecto que contendrá todos los archivos compilados listos para su ejecución (`manifest.json`, scripts de JS empaquetados, HTML, CSS e iconos).

### 4. Modo de compilación continua (Watch Mode)

Si deseas realizar modificaciones en el código fuente de forma interactiva y que se compile automáticamente al guardar cambios:
```bash
npm run watch
```

### 5. Cargar la extensión en Google Chrome

1. Abre Google Chrome y navega a la página de extensiones escribiendo en la barra de direcciones:
   `chrome://extensions/`
2. En la esquina superior derecha, activa el interruptor de **Modo de desarrollador**.
3. Haz clic en el botón **Cargar descomprimida** (Load unpacked) situado en la barra superior izquierda.
4. En el diálogo del sistema de archivos, selecciona la carpeta `dist` ubicada dentro del directorio del proyecto (`/Users/zamora322/Documentos/FullShot/dist`).
5. La extensión FullShot aparecerá instalada en tu lista de extensiones de Chrome.

## Cómo Usar FullShot

La extensión te ofrece dos métodos sencillos para realizar una captura completa:

* **Método 1 (Popup)**: Haz clic en el icono de FullShot en la barra de extensiones de Chrome y presiona el botón **Capture Full Page**.
* **Método 2 (Shortcut)**: Pulsa la combinación de teclas en tu teclado:
  * Windows / Linux: `Ctrl + Shift + F`
  * macOS: `Command + Shift + F`

Durante la captura, aparecerá un panel de progreso en la esquina inferior derecha de la página. Puedes hacer clic en **Cancelar** en cualquier momento para abortar la captura y restaurar la página a su estado original de inmediato.

## Arquitectura de la Extensión

El proyecto está diseñado de forma modular y desacoplada siguiendo las recomendaciones de Manifest V3:

* **manifest.json**: Configura los permisos estrictos y declara los puntos de entrada para el background worker, popup y recursos.
* **src/background/service-worker.ts**: Actúa como el orquestador general de la captura. Coordina los comandos del shortcut, los mensajes con el content script, realiza las capturas físicas de los viewports visibles y gestiona el flujo de descarga de imágenes.
* **src/content/page-controller.ts**: Inyectado en el contexto de la página activa. Es responsable de calcular las dimensiones de la página, ejecutar el scroll de forma controlada paso a paso, ocultar y restaurar la visibilidad de elementos `fixed` y `sticky`, e inyectar el overlay de progreso.
* **src/offscreen/offscreen.ts**: Documento offscreen que corre en un hilo separado con acceso a la API del DOM y Canvas. Almacena las capturas parciales y realiza el stitching (unión) final en un elemento HTML5 Canvas en memoria, controlando los límites físicos del navegador para páginas extremadamente largas.
* **src/popup/**: Interfaz de usuario pequeña, minimalista y moderna (popup.html, popup.css, popup.ts) para iniciar o monitorizar la captura.
* **src/shared/**: Constantes comunes y tipados de TypeScript (`constants.ts`, `types.ts`) para una comunicación libre de errores.

## Gestión de Casos de Borde

* **Elementos Fixed/Sticky**: El controlador detecta elementos CSS con `position: fixed` o `position: sticky` y los oculta visualmente (con `visibility: hidden !important`) para que no se dupliquen repetidamente a lo largo de la imagen capturada. Se excluyen contenedores estructurales de gran tamaño para evitar dejar secciones en blanco.
* **Lazy Loading**: En cada paso de scroll, el controlador espera 150ms a que la página cargue los nuevos elementos o imágenes dinámicas y notifica al Service Worker si la altura de la página aumentó dinámicamente (`scrollHeight` cambiante) para recalcular los pasos.
* **Límites de Canvas**: Si la altura total física supera los límites de hardware del Canvas de Chrome (32,767px), el motor reduce automáticamente el pixel ratio de la captura para preservar la integridad de la imagen y evitar que devuelva un lienzo vacío.
* **Restauración de Estado**: El controlador utiliza un mecanismo equivalente a `try/finally` para asegurar que el scroll y los estilos originales se restablezcan inmediatamente tanto si la captura finaliza con éxito, si se cancela, o si ocurre algún error.
