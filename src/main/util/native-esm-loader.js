'use strict';

const fs = require('node:fs');
const { registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');

// Native dependency .mjs files need no TypeScript transformation. Sending
// every edge of a large JavaScript graph to the asynchronous tsx worker makes
// Node's synchronous ESM linking block Main on hundreds of worker round trips.
// Keep package exports, typed sources and nonstandard URLs with that loader.
function ordinaryDependency(url, context) {
  return url.protocol === 'file:' && url.pathname.includes('/node_modules/')
    && url.pathname.endsWith('.mjs') && !url.search && !url.hash
    && !Object.keys(context.importAttributes || {}).length;
}

function registerNativeEsmLoader() {
  // Preserve older runtimes and explicit symlink-loader policies unchanged.
  if (typeof registerHooks !== 'function'
    || process.execArgv.some(arg => arg.startsWith('--preserve-symlinks'))
    || String(process.env.NODE_OPTIONS || '').includes('--preserve-symlinks')) return null;
  const nativeModules = new Set();
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const isImport = !context.conditions.includes('require');
      if (isImport && context.parentURL
        && (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:'))) {
        try {
          const url = new URL(specifier, context.parentURL);
          if (ordinaryDependency(url, context) && fs.statSync(url).isFile()) {
            const physical = pathToFileURL(fs.realpathSync(fileURLToPath(url)));
            if (physical.pathname.endsWith('.mjs')) {
              nativeModules.add(physical.href);
              return { url: physical.href, format: 'module', shortCircuit: true };
            }
          }
        } catch { /* The owning loader retains missing-file and URL errors. */ }
      }
      const result = nextResolve(specifier, context);
      if (isImport && result.format === 'module' && ordinaryDependency(new URL(result.url), context)) {
        nativeModules.add(result.url);
      }
      return result;
    },
    load(url, context, nextLoad) {
      if (nativeModules.has(url) && !Object.keys(context.importAttributes || {}).length) {
        try { return { format: 'module', source: fs.readFileSync(new URL(url)), shortCircuit: true }; }
        catch { /* Preserve the owning loader's filesystem failure contract. */ }
      }
      return nextLoad(url, context);
    },
  });
}

module.exports = { registerNativeEsmLoader };
