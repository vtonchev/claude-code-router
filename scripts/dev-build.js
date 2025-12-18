#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIST_CLI = 'dist/cli.js';
const DIST_UI = 'dist/index.html';
const UI_SRC = 'ui/src';
const SRC_DIR = 'src';
const LLMS_SRC = 'llms/src';
const LLMS_DIST = 'llms/dist';

function getNewestMtime(dir) {
  if (!fs.existsSync(dir)) return 0;
  
  let newest = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, getNewestMtime(fullPath));
    } else {
      const stat = fs.statSync(fullPath);
      newest = Math.max(newest, stat.mtimeMs);
    }
  }
  return newest;
}

function getMtime(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.statSync(file).mtimeMs;
}

// Check if LLMS needs rebuild
const llmsSrcMtime = getNewestMtime(LLMS_SRC);
const llmsDistMtime = getNewestMtime(LLMS_DIST);

if (llmsSrcMtime > llmsDistMtime) {
  console.log('📦 Building LLMS...');
  execSync('cd llms && pnpm run build', { stdio: 'inherit' });
} else {
  console.log('✅ LLMS is up to date');
}

// Check if CLI needs rebuild
const srcMtime = Math.max(getNewestMtime(SRC_DIR), getNewestMtime('plugins'));
const cliMtime = getMtime(DIST_CLI);

if (srcMtime > cliMtime) {
  console.log('🔨 Building CLI...');
  execSync('esbuild src/cli.ts --bundle --platform=node --outfile=dist/cli.js', { stdio: 'inherit' });
} else {
  console.log('✅ CLI is up to date');
}

// Check if UI needs rebuild
const uiSrcMtime = getNewestMtime(UI_SRC);
const uiDistMtime = getMtime(DIST_UI);

if (uiSrcMtime > uiDistMtime) {
  console.log('🎨 Building UI...');
  if (!fs.existsSync('ui/node_modules')) {
    console.log('Installing UI dependencies...');
    execSync('cd ui && pnpm install', { stdio: 'inherit' });
  }
  execSync('cd ui && pnpm run build', { stdio: 'inherit' });
  execSync('shx cp ui/dist/index.html dist/index.html', { stdio: 'inherit' });
} else {
  console.log('✅ UI is up to date');
}

console.log('🚀 Starting server...');
