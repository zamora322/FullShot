const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

const icons = {
  'icon-16.png': 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAc0lEQVR42mNkQAO/GRgYvv/Gz2JgYGBg+M3w/z9OLQyM+A2Aadp/vDqQATAN2E34T4QBcBqwE2kG/CeaAW8wZsDfWDEYtQFIAGB6GLURyEkgp0E2gIURTgwZDBkYGRiIUAzXwEgc+P+fgZEAALJ5P+9Gj5zKAAAAAElFTkSuQmCC',
  'icon-48.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAABQklEQVR42u2ZsU3DQBCG/xsnRJAoKCiokpJAOkpKyRDIKJAoKSAFAhUlJSV0kCgpQeIEfB13sU+2z7l3dnInnXSSc/b9/e6+uyPJT3Yp+b4e+G9vYAkYWAKWwK8ksBoc00fSg0aP9L65w60kXUhaSuqX/G/1tGjBifGvB52TNJX0wLhRkj5rY0F/XwBqwIElaCV1S3s0B40Gf8wB696a+1/sT99lX4fXw0ZSo1SggX9+7b+P+j6c2k7T4/sD8P3f3zK2e2/WJ6VeqV9rFexX4JpW0oNxb2wF7gCex2qfALpAG/AG2AsYAR54YyzwANgL2AIce2PsAJ7HUwfwAtgK2AMceGDvA4/gTwAvwI+wBjj2wd4DXoAfwAvwAu4AvAA/wh5gL/AIWAJdAAAAAElFTkSuQmCC',
  'icon-128.png': 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAALElEQVR42u3BAQEAAACAkP6v7ggKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBmD+cAAe7re20AAAAASUVORK5CYII='
};

Object.entries(icons).forEach(([filename, base64]) => {
  const filePath = path.join(iconsDir, filename);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  console.log(`Creado ${filename}`);
});
