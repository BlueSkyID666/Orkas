import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as spawnCommand from '../../../../src/main/features/local_agents/spawn-command';
import * as which from '../../../../src/main/features/local_agents/which';
import { planCliUpgrade, runUpgradeCommand, upgradeLocalCli } from '../../../../src/main/features/local_agents/upgrade';
import { invalidateCache } from '../../../../src/main/features/local_agents/registry';
const warningLog = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({
  warn: warningLog, info: vi.fn(), debug: vi.fn(), error: vi.fn(),
}) }));
const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
let root = ''; let previous: string | undefined;
function executable(file: string, source: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${TEST_NODE}\n${source}\n`); fs.chmodSync(file, 0o755); return file;
}
beforeEach(() => { warningLog.mockClear(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-upgrade-')); previous = process.env.ORKAS_CODEX_PATH; invalidateCache(); });
afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.ORKAS_CODEX_PATH; else process.env.ORKAS_CODEX_PATH = previous; invalidateCache(); fs.rmSync(root, { recursive: true, force: true }); });
describe('CLI maintenance failure evidence', () => {
  it('retains a safe spawn code without the missing path or raw error', async () => {
    const missing = path.join(root, process.platform === 'win32' ? 'private-missing.exe' : 'private-missing');
    const result = await runUpgradeCommand(missing, [], 3000);
    expect(result).toEqual({ ok: false, text: '', error: 'failed', diagnostic: { phase: 'spawn', spawn_code: 'ENOENT' } });
    expect(JSON.stringify(result)).not.toContain(missing);
    expect(warningLog).not.toHaveBeenCalled(); // Background capability probes never add warnings.
  });

  it('distinguishes a real updater exit from spawn failure without retaining output', async () => {
    const result = await runUpgradeCommand(TEST_NODE,
      ['-e', "process.stderr.write('PRIVATE_UPDATER_OUTPUT'); process.exit(7)"], 3000);
    expect(result).toEqual({ ok: false, text: '', error: 'failed', diagnostic: { phase: 'exit', exit_code: 7, signal: 'none' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_UPDATER_OUTPUT');
    expect(warningLog).not.toHaveBeenCalled();
  });
});

describe('CLI installation ownership', () => {
  it.runIf(process.platform === 'win32')('plans a real extension-less Windows npm launcher without running an installer', async () => {
    const packageRoot = path.join(root, 'node_modules', 'opencode-ai');
    const entry = path.join(packageRoot, 'bin', 'opencode');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("1.2.27");\n');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'opencode-ai' }));
    const bin = path.join(root, 'opencode.cmd');
    fs.writeFileSync(bin, '@echo off\r\nnode.exe "%~dp0node_modules\\opencode-ai\\bin\\opencode" %*\r\n');
    fs.writeFileSync(path.join(root, 'opencode.ps1'), '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n& "node.exe" "$basedir/node_modules/opencode-ai/bin/opencode" $args\r\n');
    const npm = path.join(root, 'npm.cmd');
    const marker = path.join(root, 'installer-ran');
    fs.writeFileSync(npm, `@echo off\r\necho unexpected>"${marker}"\r\nexit /b 9\r\n`);
    const saved = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, ORKAS_TEST_NODE: process.env.ORKAS_TEST_NODE };
    try {
      process.env.PATH = root; process.env.PATHEXT = '.CMD;.EXE'; process.env.ORKAS_TEST_NODE = TEST_NODE;
      expect(spawnCommand.resolveCliCommand(bin, [])).toEqual({ command: TEST_NODE, args: [entry] });
      const plan = await planCliUpgrade('opencode', bin);
      // PATHEXT may return .CMD for the same case-insensitive Windows file.
      expect(plan.command?.toLowerCase()).toBe(npm.toLowerCase());
      expect(plan).toMatchObject({ method: 'npm',
        args: ['install', '--global', 'opencode-ai@latest', '--prefix', fs.realpathSync(root), '--no-audit', '--no-fund'] });
      expect(await planCliUpgrade('claude', bin)).toEqual({ method: 'unavailable' });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  it.each(['cli.js', 'opencode'])('follows an already-validated Windows npm Node entry regardless of its extension: %s', async filename => {
    // Filesystem and package ownership are real; the resolver's Windows receipt
    // is supplied at its boundary so this contract also runs on POSIX hosts.
    const packageRoot = path.join(root, 'node_modules', 'opencode-ai');
    const entry = executable(path.join(packageRoot, 'bin', filename), '');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'opencode-ai' }));
    const bin = executable(path.join(root, 'opencode.cmd'), '');
    const npm = executable(path.join(root, 'npm.cmd'), '');
    vi.spyOn(spawnCommand, 'resolveCliCommand').mockReturnValue({ command: TEST_NODE, args: [entry] });
    vi.spyOn(which, 'whichBin').mockResolvedValue(npm);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      expect(await planCliUpgrade('opencode', bin)).toEqual({ method: 'npm', command: npm,
        args: ['install', '--global', 'opencode-ai@latest', '--prefix', fs.realpathSync(root), '--no-audit', '--no-fund'] });
      expect(await planCliUpgrade('claude', bin)).toEqual({ method: 'unavailable' });
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });

  it.skipIf(process.platform === 'win32')('keeps Homebrew ownership when its formula wraps a global npm layout', async () => {
    const prefix = path.join(root, 'Cellar', 'opencode', '1.2.27', 'libexec');
    const packageRoot = path.join(prefix, 'lib', 'node_modules', 'opencode-ai');
    const entry = executable(path.join(packageRoot, 'bin', 'opencode'), '');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'opencode-ai' }));
    executable(path.join(prefix, 'bin', 'npm'), '');
    const brew = executable(path.join(root, 'bin', 'brew'), '');
    const bin = path.join(root, 'bin', 'opencode'); fs.symlinkSync(entry, bin);
    expect(await planCliUpgrade('opencode', bin)).toEqual({ method: 'brew', command: fs.realpathSync(brew), args: ['upgrade', 'opencode'] });
    fs.unlinkSync(brew);
    expect(await planCliUpgrade('opencode', bin)).toEqual({ method: 'unavailable' });
  });

  it('does not modify source or bundled application binaries', async () => {
    for (const file of ['source/codex', 'Codex.app/Contents/bin/codex']) {
      const bin = executable(path.join(root, file), `console.log('  update Upgrade Codex');`);
      expect(await planCliUpgrade('codex', bin)).toEqual({ method: 'unavailable' });
    }
  });
  it.skipIf(process.platform === 'win32')('requires an advertised native updater', async () => {
    const bin = executable(path.join(root, '.codex/packages/standalone/current/bin/codex'), `console.log('Usage: codex');`);
    expect(await planCliUpgrade('codex', bin)).toEqual({ method: 'unavailable' });
    executable(bin, `console.log('Commands:\\n  update  Upgrade Codex');`);
    expect(await planCliUpgrade('codex', bin)).toEqual({ method: 'native', command: bin, args: ['update'] });
  });
  it.skipIf(process.platform === 'win32').each([
    ['update|upgrade', true], ['upgrade|update', true],
    ['update-all|upgrade', false], ['self-update|upgrade', false],
    ['doctor  Check update|upgrade availability', false], ['--update', false],
  ])('recognizes exact native Claude command aliases: %s', async (command, supported) => {
    const bin = executable(path.join(root, '.local/share/claude/versions/2.1.112'),
      `console.log(${JSON.stringify('Commands:\n  ' + command + '  Check for updates and install if available')});`);
    expect(await planCliUpgrade('claude', bin)).toEqual(supported
      ? { method: 'native', command: bin, args: ['update'] } : { method: 'unavailable' });
  });
  it.skipIf(process.platform === 'win32').each([
    ['Usage: claude update|upgrade [options]', 0, true],
    ['Usage: claude [options] [command] [prompt]', 0, false],
    ['Usage: claude update-all [options]', 0, false],
    ['Usage: claude update|upgrade [options]', 1, false],
  ])('uses exact short command help when root help is truncated: %s / %s', async (usage, code, supported) => {
    const bin = executable(path.join(root, '.local/share/claude/versions/2.1.112'), `
if (process.argv.slice(2).join(' ') === 'update --help') {
  console.log(${JSON.stringify(usage)}); process.exitCode = ${code};
} else if (process.argv.slice(2).join(' ') === '--help') console.log('Usage: claude [options] [command]');
else process.exit(9);`);
    expect(await planCliUpgrade('claude', bin)).toEqual(supported
      ? { method: 'native', command: bin, args: ['update'] } : { method: 'unavailable' });
  });
  it.skipIf(process.platform === 'win32')('targets the owning global npm prefix and exact known package', async () => {
    const packageRoot = path.join(root, 'lib/node_modules/@openai/codex');
    const entry = executable(path.join(packageRoot, 'bin/codex.js'), '');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    fs.mkdirSync(path.join(root, 'bin')); executable(path.join(root, 'bin/npm'), ''); const bin = path.join(root, 'bin/codex'); fs.symlinkSync(entry, bin);
    const plan = await planCliUpgrade('codex', bin);
    expect(plan.method).toBe('npm');
    expect(plan.args).toEqual(['install', '--global', '@openai/codex@latest', '--prefix', fs.realpathSync(root), '--no-audit', '--no-fund']);
    expect(await planCliUpgrade('claude', bin)).toEqual({ method: 'unavailable' });
    fs.mkdirSync(path.join(root, 'other')); const other = path.join(root, 'other/codex'); fs.symlinkSync(entry, other);
    expect(await planCliUpgrade('codex', other)).toEqual({ method: 'unavailable' });
  });
  it.skipIf(process.platform === 'win32')('uses only the owning Homebrew installation and registered formula or cask', async () => {
    const brew = executable(path.join(root, 'bin/brew'), '');
    for (const [store, args] of [['Cellar', ['upgrade', 'codex']], ['Caskroom', ['upgrade', '--cask', 'codex']]] as const) {
      const bin = executable(path.join(root, store, 'codex/0.156.1/bin/codex'), '');
      expect(await planCliUpgrade('codex', bin)).toEqual({ method: 'brew', command: fs.realpathSync(brew), args });
      expect(await planCliUpgrade('claude', bin)).toEqual({ method: 'unavailable' });
    }
    fs.unlinkSync(brew);
    expect(await planCliUpgrade('codex', path.join(root, 'Cellar/codex/0.156.1/bin/codex'))).toEqual({ method: 'unavailable' });
  });
});
describe.skipIf(process.platform === 'win32')('native CLI maintenance lifecycle', () => {
  function native(mode: string) {
    const state = path.join(root, 'version'); fs.writeFileSync(state, '0.144.0');
    const updates = path.join(root, 'updates');
    const bin = executable(path.join(root, '.codex/packages/standalone/current/bin/codex'), `
const fs = require('node:fs'); const state = ${JSON.stringify(state)};
if (process.argv.includes('--version')) console.log(fs.readFileSync(state, 'utf8'));
else if (process.argv.includes('--help')) console.log('Commands:\\n  update  Upgrade Codex');
else if (process.argv.includes('update')) {
  fs.appendFileSync(${JSON.stringify(updates)}, 'update\\n');
  setTimeout(() => { ${mode === 'failure' ? 'process.exit(7);' : `fs.writeFileSync(state, '${mode === 'unchanged' ? '0.144.0' : '0.159.3'}');`} }, 200);
} else process.exit(8);`);
    process.env.ORKAS_CODEX_PATH = bin; return { bin, updates };
  }
  it('coalesces surfaces and verifies the original executable after upgrade', async () => {
    const { bin, updates } = native('success');
    const one = upgradeLocalCli('codex'); const two = upgradeLocalCli('codex'); expect(two).toBe(one);
    const result = await one;
    expect(result).toMatchObject({ ok: true, method: 'native', version: '0.159.3', entry: { path: bin, available: true } });
    expect(fs.readFileSync(updates, 'utf8')).toBe('update\n');
  });
  it.each(['failure', 'unchanged'])('does not claim a successful upgrade for %s', async mode => {
    native(mode);
    const result = await upgradeLocalCli('codex');
    expect(result).toMatchObject({ ok: false, error_code: mode === 'failure' ? 'failed' : 'verification_failed' });
    expect(result).not.toHaveProperty('diagnostic'); // No new IPC/telemetry contract.
    if (mode === 'failure') {
      expect(warningLog).toHaveBeenCalledExactlyOnceWith('CLI upgrade command failed', {
        cli: 'codex', method: 'native', reason: 'failed', phase: 'exit', exit_code: 7, signal: 'none',
      });
    } else expect(warningLog).not.toHaveBeenCalled();
  });
  it('bounds subprocess deadlines and excessive output without exposing output', async () => {
    const hung = await runUpgradeCommand(TEST_NODE, ['-e', 'setInterval(()=>{},1000)'], 100);
    expect(hung).toMatchObject({ ok: false, error: 'timeout', text: '' });
    const large = await runUpgradeCommand(TEST_NODE, ['-e', "process.stdout.write('x'.repeat(2*1024*1024));"], 3000);
    expect(large).toMatchObject({ ok: false, error: 'output_limit', text: '' });
  });
});
