#!/usr/bin/env node
/*
Recover original source files from source maps in a repository.

Usage:
  node scripts/recover-sources.js [--root /path/to/repo] [--out ./recovered-sources] [--include-node-modules] [--dry-run] [--overwrite]

Behavior:
 - Walks the directory tree under --root (default: repo root where script lives's parent)
 - Finds .map files and files with inline source maps (data:application/json;base64,...)
 - For each source map, if `sourcesContent` is present, writes recovered sources to the output dir preserving the original source path (sanitized)
 - If `sourcesContent` is not present, tries to resolve the referenced source path relative to the map's location and copy it
 - Skips paths that would escape the output dir for safety

This script is intentionally dependency-free and uses only Node built-ins.
*/

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    root: path.resolve(path.join(__dirname, '..')),
    out: path.resolve(process.cwd(), 'recovered-sources'),
    includeNodeModules: false,
    dryRun: false,
    overwrite: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root' && args[i+1]) { opts.root = path.resolve(args[++i]); }
    else if (a === '--out' && args[i+1]) { opts.out = path.resolve(args[++i]); }
    else if (a === '--include-node-modules') { opts.includeNodeModules = true; }
    else if (a === '--dry-run') { opts.dryRun = true; }
    else if (a === '--overwrite') { opts.overwrite = true; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/recover-sources.js [--root /path] [--out /path] [--include-node-modules] [--dry-run] [--overwrite]');
      process.exit(0);
    }
  }
  return opts;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function isBinaryFileName(name) {
  return /\.(png|jpe?g|gif|svg|wasm|bin|exe|dll|dat|class|so|dylib)$/i.test(name);
}

async function walk(dir, cb, opts) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (!opts.includeNodeModules && ent.name === 'node_modules') continue;
    if (ent.isDirectory()) {
      await walk(full, cb, opts);
    } else if (ent.isFile()) {
      await cb(full);
    }
  }
}

function sanitizeSourcePath(src) {
  // Remove protocol prefixes
  src = src.replace(/^webpack:\/\//, '');
  src = src.replace(/^file:\/\//, '');
  // Remove URL like prefixes (e.g., /C:/ or C:\)
  src = src.replace(/^\/[A-Za-z]:\//, '');
  src = src.replace(/^[A-Za-z]:\\/, '');
  // Normalize separators to '/'
  src = src.replace(/\\+/g, '/');
  // Split and filter segments to prevent path traversal
  const parts = src.split('/');
  const safeParts = [];
  for (const p of parts) {
    if (!p || p === '.' ) continue;
    if (p === '..') {
      // don't allow going above root — skip popping to keep everything inside outDir
      continue;
    }
    safeParts.push(p.replace(/[:<>"|?*]/g, '_'));
  }
  return safeParts.join('/');
}

function safeJoin(base, relative) {
  const target = path.normalize(path.join(base, relative));
  if (!target.startsWith(base)) throw new Error('Path traversal detected');
  return target;
}

async function writeRecoveredFile(outDir, srcPath, content, opts) {
  const sanitized = sanitizeSourcePath(srcPath);
  const dest = safeJoin(outDir, sanitized);
  const destDir = path.dirname(dest);
  await ensureDir(destDir);
  try {
    const exists = fs.existsSync(dest);
    if (exists && !opts.overwrite) return { skipped: true, dest };
    if (!opts.dryRun) await fsp.writeFile(dest, content, 'utf8');
    return { written: true, dest };
  } catch (err) {
    return { error: err.message, dest };
  }
}

async function processSourceMap(mapObj, mapFilePath, opts, summary) {
  const sources = Array.isArray(mapObj.sources) ? mapObj.sources : [];
  const contents = Array.isArray(mapObj.sourcesContent) ? mapObj.sourcesContent : null;
  const mapDir = path.dirname(mapFilePath || opts.root);
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i] || 'unknown';
    const content = contents ? contents[i] : null;
    if (content !== null && content !== undefined) {
      const res = await writeRecoveredFile(opts.out, src, content, opts);
      if (res.written) summary.written++;
      else if (res.skipped) summary.skipped++;
      else summary.errors.push(res);
    } else {
      // Try to copy the referenced file relative to map
      const candidate = path.resolve(mapDir, src);
      try {
        if (fs.existsSync(candidate) && !isBinaryFileName(candidate)) {
          const fileContent = await fsp.readFile(candidate, 'utf8');
          const res = await writeRecoveredFile(opts.out, src, fileContent, opts);
          if (res.written) summary.copied++;
          else if (res.skipped) summary.skipped++;
          else summary.errors.push(res);
        } else {
          summary.missing.push({ source: src, map: mapFilePath });
        }
      } catch (err) {
        summary.errors.push({ source: src, error: err.message });
      }
    }
  }
}

function tryExtractInlineSourceMapFromText(text) {
  // pattern: //# sourceMappingURL=data:application/json;base64,xxxxx
  const inlineRegex = /sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=\-_]+)\b/;
  const m = text.match(inlineRegex);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    return null;
  }
}

async function main() {
  const opts = parseArgs();
  console.log('Recover sources — root:', opts.root, 'out:', opts.out);
  const summary = { maps: 0, written: 0, copied: 0, skipped: 0, missing: [], errors: [] };
  if (!opts.dryRun) await ensureDir(opts.out);

  // Walk files looking for .map files and for JS/CSS files with inline maps
  await walk(opts.root, async (file) => {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.map') {
      try {
        const raw = await fsp.readFile(file, 'utf8');
        const mapObj = JSON.parse(raw);
        summary.maps++;
        await processSourceMap(mapObj, file, opts, summary);
      } catch (err) {
        summary.errors.push({ file, error: err.message });
      }
    } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.css') {
      try {
        const raw = await fsp.readFile(file, 'utf8');
        const mapObj = tryExtractInlineSourceMapFromText(raw);
        if (mapObj) {
          summary.maps++;
          await processSourceMap(mapObj, file, opts, summary);
        }
      } catch (err) {
        // ignore binary unreadable files
      }
    }
  }, opts);

  console.log('Done. Summary:\n', JSON.stringify({ maps: summary.maps, written: summary.written, copied: summary.copied, skipped: summary.skipped, missingCount: summary.missing.length, errors: summary.errors.length }, null, 2));
  if (summary.missing.length) {
    console.log('Missing referenced sources (examples):', summary.missing.slice(0, 10));
  }
  if (summary.errors.length) {
    console.log('Errors (examples):', summary.errors.slice(0, 10));
  }
  console.log('\nTo run: node scripts/recover-sources.js --root', opts.root, '--out', opts.out, (opts.dryRun? '--dry-run':''));
}

main().catch(err => { console.error('Fatal error:', err); process.exit(2); });
