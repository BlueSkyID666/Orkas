import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { createPackageFromStreams } from '@electron/asar';

const workerSourceFile = path.resolve(__dirname, '../../../bin/kb-embed-worker.cjs');
const requestFixture = path.resolve(__dirname, '../../fixtures/kb/embed-worker-request.cjs');
const { requestWorker, createWorkerSession } = createRequire(import.meta.url)(requestFixture);
const disk = createRequire(import.meta.url)('original-fs') as typeof fs;
let root: string;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-embed-worker-')); });
afterEach(async () => {
  // Remove physical archive bytes, rather than traversing Electron's ASAR view.
  await disk.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function write(relative: string, body: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const embedPackage = `
const marker = require('@fixture/tokenizer');
exports.EmbeddingModel = { BGESmallZH: 'fixture-model', CUSTOM: 'custom' };
exports.FlagEmbedding = { init: async () => ({
  async *embed(texts) { yield texts.map(() => new Float32Array(marker)); }
}) };
`;

async function request(workerDir: string, isolatedArchive = false): Promise<Record<string, any>> {
  if (!isolatedArchive) return requestWorker(workerSourceFile, workerDir, path.join(root, 'model'));
  const child = spawnSync(process.execPath, [requestFixture, workerSourceFile, workerDir, path.join(root, 'model')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 5000,
  });
  // Preserve native diagnostics for the owning test log policy.
  if (child.stderr) process.stderr.write(child.stderr);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

describe('Library embedding worker dependency loading', () => {
  it.each(['development', 'packaged'] as const)(
    'loads the full dependency graph from the %s application root', async layout => {
      const appRoot = layout === 'packaged' ? 'stage' : 'source';
      const workerRoot = layout === 'packaged' ? 'app.asar.unpacked' : 'source';
      write(`${appRoot}/package.json`, '{}');
      write(`${appRoot}/node_modules/fastembed/index.js`, embedPackage);
      write(`${appRoot}/node_modules/@fixture/tokenizer/index.js`, 'module.exports = [7, 11];');
      if (layout === 'packaged') {
        // electron-builder unpacks FastEmbed, while a JS-only transitive
        // dependency remains exclusively in the archive. A source-only test
        // cannot catch a worker resolving from the physical unpacked tree.
        const stage = path.join(root, appRoot);
        const entries: Parameters<typeof createPackageFromStreams>[1] = [
          'node_modules', 'node_modules/fastembed', 'node_modules/@fixture', 'node_modules/@fixture/tokenizer',
        ].map(relative => ({ type: 'directory', path: relative, unpacked: false }));
        for (const relative of ['package.json', 'node_modules/fastembed/index.js', 'node_modules/@fixture/tokenizer/index.js']) {
          const file = path.join(stage, relative);
          entries.push({ type: 'file', path: relative, unpacked: relative === 'node_modules/fastembed/index.js',
            stat: disk.statSync(file), streamGenerator: () => disk.createReadStream(file) });
        }
        await finished(await createPackageFromStreams(path.join(root, 'app.asar'), entries));
        expect(fs.existsSync(path.join(root, workerRoot, 'node_modules/fastembed/index.js'))).toBe(true);
        expect(fs.existsSync(path.join(root, workerRoot, 'node_modules/@fixture/tokenizer/index.js'))).toBe(false);
      }
      const result = await request(path.join(root, workerRoot, 'bin'), layout === 'packaged');
      expect(result).toEqual({ id: 17, ok: true, vectors: [[7, 11], [7, 11]] });
    },
  );

  it('fails locally without entering the SDK downloader when the bundled model is missing', async () => {
    const sdk = createRequire(import.meta.url)('fastembed');
    // Intercept the installed SDK's download boundary: no network is allowed
    // even against the original implementation that violates this invariant.
    const download = vi.spyOn(sdk.FlagEmbedding, 'downloadFileFromGCS')
      .mockRejectedValue(new Error('fixture download blocked'));
    const modelRoot = path.join(root, 'missing-resource');
    try {
      const result = await requestWorker(workerSourceFile, path.dirname(workerSourceFile), modelRoot);
      expect(download).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 17, ok: false, error: 'bundled embedding model unavailable',
        errorCode: 'E_LIBRARY_EMBED_MODEL_UNAVAILABLE',
      });
      expect(fs.existsSync(modelRoot)).toBe(false);
    } finally { download.mockRestore(); }
  });

  it.each([undefined, '', 'relative/model', '   '])(
    'rejects an invalid bundled-model root without SDK initialization (%s)', async modelRoot => {
      const sdk = createRequire(import.meta.url)('fastembed');
      const init = vi.spyOn(sdk.FlagEmbedding, 'init')
        .mockRejectedValue(new Error('fixture SDK initialization blocked'));
      try {
        expect(await requestWorker(workerSourceFile, path.dirname(workerSourceFile), modelRoot)).toEqual({
          id: 17, ok: false, error: 'bundled embedding model unavailable',
          errorCode: 'E_LIBRARY_EMBED_MODEL_UNAVAILABLE',
        });
        expect(init).not.toHaveBeenCalled();
      } finally { init.mockRestore(); }
    },
  );

  it('returns a closed diagnostic for malformed local model configuration without downloading', async () => {
    const sdk = createRequire(import.meta.url)('fastembed');
    const download = vi.spyOn(sdk.FlagEmbedding, 'downloadFileFromGCS')
      .mockRejectedValue(new Error('fixture download blocked'));
    const modelRoot = path.join(root, 'private-account-model');
    const modelDir = path.join(modelRoot, sdk.EmbeddingModel.BGESmallZH);
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'tokenizer.json'), '{}');
    fs.writeFileSync(path.join(modelDir, 'config.json'), '{private-fixture-config');
    try {
      expect(await requestWorker(workerSourceFile, path.dirname(workerSourceFile), modelRoot)).toEqual({
        id: 17, ok: false, error: 'bundled embedding model unavailable',
        errorCode: 'E_LIBRARY_EMBED_MODEL_UNAVAILABLE',
      });
      expect(download).not.toHaveBeenCalled();
    } finally { download.mockRestore(); }
  });

  it('retries a failed local initialization and keeps batching and request correlation', async () => {
    write('source/package.json', '{}');
    write('source/node_modules/fastembed/index.js', `
      const assert = require('node:assert/strict');
      const path = require('node:path');
      let attempts = 0;
      exports.EmbeddingModel = { BGESmallZH: 'fixture-model', CUSTOM: 'custom' };
      exports.FlagEmbedding = { init: async options => {
        assert.equal(options.model, 'custom');
        assert.equal(path.basename(options.modelAbsoluteDirPath), 'fixture-model');
        assert.equal(path.isAbsolute(options.modelAbsoluteDirPath), true);
        assert.equal(options.modelName, 'model_optimized.onnx');
        assert.equal(options.showDownloadProgress, false);
        if (++attempts === 1) throw new Error('private-fixture-model-failure');
        return { async *embed(texts, batchSize) {
          assert.equal(batchSize, 2);
          for (const text of texts) yield [new Float32Array([text.length, attempts])];
        } };
      } };
    `);
    const session = createWorkerSession(workerSourceFile, path.join(root, 'source/bin'), path.join(root, 'model'));
    const requests = [41, 42].map(id => session.request({ id, type: 'embed', texts: ['a', 'bb'], batchSize: 2 }));
    expect(await requests[0]).toEqual({
      id: 41, ok: false, error: 'bundled embedding model unavailable',
      errorCode: 'E_LIBRARY_EMBED_MODEL_UNAVAILABLE',
    });
    expect(await requests[1]).toEqual({ id: 42, ok: true, vectors: [[1, 2], [2, 2]] });
    expect(await session.request({ id: 43, type: 'embed', texts: ['ccc'], batchSize: 2 }))
      .toEqual({ id: 43, ok: true, vectors: [[3, 2]] });
  });

  it.each([
    ['onnxruntime', 'E_LIBRARY_NATIVE_ONNX_LOAD'],
    ['tokenizers', 'E_LIBRARY_NATIVE_TOKENIZERS_LOAD'],
  ])('preserves %s load classification inside SDK initialization', async (component, code) => {
    write('source/package.json', '{}');
    write('source/node_modules/fastembed/index.js', `
      exports.EmbeddingModel = { BGESmallZH: 'fixture-model', CUSTOM: 'custom' };
      exports.FlagEmbedding = { init: async () => {
        throw Object.assign(new Error('${component} private-fixture-path'), { code: 'ERR_DLOPEN_FAILED' });
      } };
    `);
    expect(await request(path.join(root, 'source/bin'))).toEqual({
      id: 17, ok: false, error: 'native embedding runtime failed to load', errorCode: code,
    });
  });

  it('reports a genuinely missing dependency as failure rather than empty embeddings', async () => {
    write('source/node_modules/fastembed/index.js', embedPackage);
    const result = await request(path.join(root, 'source/bin'));
    expect(result).toMatchObject({ id: 17, ok: false });
    expect(result.error).toContain("Cannot find module '@fixture/tokenizer'");
    expect(result).not.toHaveProperty('vectors');
  });

  it('preserves the existing private native-load diagnostic through the worker protocol', async () => {
    write('source/node_modules/fastembed/index.js', `
      throw Object.assign(new Error('onnxruntime native fixture failed'), { code: 'ERR_DLOPEN_FAILED' });
    `);
    expect(await request(path.join(root, 'source/bin'))).toEqual({
      id: 17, ok: false,
      error: 'native embedding runtime failed to load',
      errorCode: 'E_LIBRARY_NATIVE_ONNX_LOAD',
    });
  });
});
