#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');

console.log('Building kitchen-plugin-yot...\n');

if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(path.join(distDir, 'api'), { recursive: true });

const externals = [
  '--external:better-sqlite3',
  '--external:drizzle-orm',
  '--external:drizzle-orm/*',
  '--external:crypto',
  '--external:path',
  '--external:fs',
  '--external:fs/promises',
  '--external:os',
  '--external:node:crypto',
].join(' ');

try {
  execSync(
    `esbuild src/index.ts --bundle --platform=node --target=node18 --format=cjs --outfile=dist/index.js ${externals}`,
    { cwd: root, stdio: 'inherit' }
  );
  console.log('✓ Built dist/index.js');

  execSync(
    `esbuild src/api/handler.ts --bundle --platform=node --target=node18 --format=cjs --outfile=dist/api/handler.js ${externals}`,
    { cwd: root, stdio: 'inherit' }
  );
  console.log('✓ Built dist/api/handler.js');

  // Copy migrations
  const migSrc = path.join(root, 'db/migrations');
  const migDest = path.join(distDir, 'db/migrations');
  fs.mkdirSync(migDest, { recursive: true });
  for (const file of fs.readdirSync(migSrc)) {
    const src = path.join(migSrc, file);
    const dest = path.join(migDest, file);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dest, { recursive: true });
    else fs.copyFileSync(src, dest);
  }
  console.log('✓ Copied migrations');

  console.log('\n✅ Build complete.\n');
} catch (error) {
  console.error('✗ Build failed:', error.message);
  process.exit(1);
}
