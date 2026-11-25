import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.cjs',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode', 'node-pty'],
    sourcemap: true,
  }),
  build({
    entryPoints: ['media/webview.ts'],
    outfile: 'dist/webview.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
  }),
  copyFile('node_modules/@xterm/xterm/css/xterm.css', 'dist/xterm.css'),
  copyFile('media/webview.css', 'dist/webview.css'),
]);
