const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watchMode = process.argv.includes('--watch');

// Función de utilidad para copiar archivos
function copyFileSync(source, target) {
  let targetFile = target;
  if (fs.existsSync(target) && fs.lstatSync(target).isDirectory()) {
    targetFile = path.join(target, path.basename(source));
  }
  fs.writeFileSync(targetFile, fs.readFileSync(source));
}

// Función de utilidad para copiar carpetas recursivamente
function copyFolderRecursiveSync(source, target) {
  let files = [];
  const targetFolder = path.join(target, path.basename(source));
  if (!fs.existsSync(targetFolder)) {
    fs.mkdirSync(targetFolder, { recursive: true });
  }
  if (fs.lstatSync(source).isDirectory()) {
    files = fs.readdirSync(source);
    files.forEach(function (file) {
      const curSource = path.join(source, file);
      if (fs.lstatSync(curSource).isDirectory()) {
        copyFolderRecursiveSync(curSource, targetFolder);
      } else {
        copyFileSync(curSource, targetFolder);
      }
    });
  }
}

// Asegurar que el directorio de salida existe
const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Copiar todos los assets estáticos
function copyAssets() {
  try {
    console.log('Copiando recursos estáticos...');
    copyFileSync(path.join(__dirname, 'manifest.json'), path.join(__dirname, 'dist/manifest.json'));
    copyFileSync(path.join(__dirname, 'src/popup/popup.html'), path.join(__dirname, 'dist/popup.html'));
    copyFileSync(path.join(__dirname, 'src/popup/popup.css'), path.join(__dirname, 'dist/popup.css'));
    copyFileSync(path.join(__dirname, 'src/offscreen/offscreen.html'), path.join(__dirname, 'dist/offscreen.html'));
    
    // Editor assets
    const editorHtmlPath = path.join(__dirname, 'src/editor/editor.html');
    if (fs.existsSync(editorHtmlPath)) {
      copyFileSync(editorHtmlPath, path.join(__dirname, 'dist/editor.html'));
    }
    const editorCssPath = path.join(__dirname, 'src/editor/editor.css');
    if (fs.existsSync(editorCssPath)) {
      copyFileSync(editorCssPath, path.join(__dirname, 'dist/editor.css'));
    }
    
    const iconsSrc = path.join(__dirname, 'icons');
    if (fs.existsSync(iconsSrc)) {
      copyFolderRecursiveSync(iconsSrc, distDir);
    }
    console.log('Recursos estáticos copiados correctamente.');
  } catch (error) {
    console.error('Error al copiar recursos estáticos:', error);
  }
}

async function run() {
  const buildOptions = {
    entryPoints: {
      'background': 'src/background/service-worker.ts',
      'content': 'src/content/page-controller.ts',
      'offscreen': 'src/offscreen/offscreen.ts',
      'popup': 'src/popup/popup.ts',
      'editor': 'src/editor/editor.ts'
    },
    outdir: 'dist',
    bundle: true,
    minify: false, // Mantener legible para depuración local
    sourcemap: 'inline',
    target: ['chrome100'],
    logLevel: 'info',
  };

  copyAssets();

  if (watchMode) {
    console.log('Modo Watch activado. Compilando y escuchando cambios...');
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    
    // Escuchar cambios adicionales en HTML/CSS/manifest
    fs.watch(path.join(__dirname, 'src'), { recursive: true }, (event, filename) => {
      if (filename && (filename.endsWith('.html') || filename.endsWith('.css'))) {
        console.log(`Cambio detectado en recurso estático: ${filename}`);
        copyAssets();
      }
    });
    
    fs.watch(path.join(__dirname, 'manifest.json'), (event, filename) => {
      if (filename) {
        console.log('Cambio detectado en manifest.json');
        copyAssets();
      }
    });
  } else {
    console.log('Compilando para producción...');
    await esbuild.build(buildOptions);
    console.log('Compilación de TypeScript completada con éxito.');
  }
}

run().catch((err) => {
  console.error('Error general durante la compilación:', err);
  process.exit(1);
});
