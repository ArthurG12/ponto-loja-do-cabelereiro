import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  loadEnvFile(path.join(root, '.env'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const children = [
  spawn(process.execPath, ['server/index.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: root, stdio: 'inherit' }),
];

function stop() {
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
for (const child of children) {
  child.on('exit', (code, signal) => {
    if (signal) return;
    if (code) {
      stop();
      process.exit(code);
    }
  });
}
