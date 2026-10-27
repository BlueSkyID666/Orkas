import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bootstrap-entry-'));
  fs.copyFileSync(
    path.resolve(process.cwd(), 'bootstrap.cjs'),
    path.join(root, 'bootstrap.cjs'),
  );

  const tsxRoot = path.join(root, 'node_modules', 'tsx');
  fs.mkdirSync(tsxRoot, { recursive: true });
  fs.writeFileSync(path.join(tsxRoot, 'package.json'), JSON.stringify({
    name: 'tsx',
    version: '0.0.0-test',
    exports: {
      './cjs': './cjs.cjs',
      './esm/api': './esm-api.cjs',
    },
  }));
  fs.writeFileSync(path.join(tsxRoot, 'cjs.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(tsxRoot, 'esm-api.cjs'),
    'module.exports = { register() {} };\n',
  );

  const mainRoot = path.join(root, 'src', 'main');
  fs.mkdirSync(mainRoot, { recursive: true });
  fs.mkdirSync(path.join(mainRoot, 'util'));
  fs.copyFileSync(path.join(process.cwd(), 'src/main/util/native-esm-loader.js'), path.join(mainRoot, 'util/native-esm-loader.js'));

});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('desktop bootstrap entry', () => {
  it.each([
    { platform: 'darwin', defaultApp: true, hide: '1', accessory: true },
    { platform: 'darwin', defaultApp: true, hide: '0', accessory: false },
    { platform: 'darwin', defaultApp: true, hide: '', accessory: false },
    { platform: 'darwin', defaultApp: false, hide: '1', accessory: false },
    { platform: 'win32', defaultApp: true, hide: '1', accessory: false },
  ])('sets background activation before loading Main only for hidden macOS source runs: %j', (scenario) => {
    const events: string[] = [];
    runInNewContext(fs.readFileSync(path.join(root, 'bootstrap.cjs'), 'utf8'), {
      __dirname: root,
      process: {
        platform: scenario.platform, defaultApp: scenario.defaultApp,
        env: { ORKAS_E2E_HIDE_WINDOW: scenario.hide }, argv: [], versions: {},
      },
      require(name: string) {
        if (name === 'node:fs') return fs;
        if (name === 'node:path') return path;
        if (name === 'electron') return { app: { setActivationPolicy: (policy: string) => events.push(policy) } };
        if (name === 'tsx/cjs') return {};
        if (name === 'tsx/esm/api') return { register() {} };
        if (name === './src/main/util/native-esm-loader.js') return { registerNativeEsmLoader() {} };
        if (name === './src/main') { events.push('main'); return {}; }
        throw new Error(`Unexpected bootstrap import: ${name}`);
      },
    });
    expect(events).toEqual(scenario.accessory ? ['accessory', 'main'] : ['main']);
  });

});
