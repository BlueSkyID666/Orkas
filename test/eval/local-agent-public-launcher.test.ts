import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { attachLocalAgentReports, runLocalAgentLauncher } from '../../scripts/local-agent-live-launcher.mjs';
import { localAgentChildEnv, parseMacOSSystemProxy } from '../../scripts/local-agent-live-proxy-env.mjs';
import { createModelEvalLogCollector } from '../../scripts/model-eval-log-policy.mjs';

const options = () => ({ argv: ['--no-install', '--agents', 'codex'], childEnv: { ELECTRON_RUN_AS_NODE: '', SENTINEL: 'kept' },
  electronBin: '/fixture/electron', electronEntry: '/fixture/entry.mjs', runner: '/fixture/runner.mts',
  cwd: process.cwd(), reportsDir: path.join(process.cwd(), 'test-results/local-agents') });

describe('public local CLI launcher isolation', () => {
  it.each([false, true])('prepares the normal product runtime and cleans isolated state (failure: %s)', async failed => {
    const calls: any[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const run = vi.fn(async (command, args, settings) => {
        calls.push({ command, args, settings });
        expect(fs.existsSync(settings.env.ORKAS_WORKSPACE_ROOT)).toBe(true);
        return { code: failed ? 2 : 0 };
      });
      expect(await runLocalAgentLauncher({ ...options(), run })).toBe(failed ? 78 : 0);
      expect(calls).toHaveLength(failed ? 1 : 2);
      expect(calls[0].args).toEqual([path.join(process.cwd(), 'scripts/ensure-dev-dependencies.cjs')]);
      expect(calls[0].settings.env.SENTINEL).toBe('kept');
      expect(calls[0].settings.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(fs.existsSync(calls[0].settings.env.ORKAS_WORKSPACE_ROOT)).toBe(false);
      if (!failed) {
        expect(calls[1].args).toEqual(['--disable-gpu', '/fixture/entry.mjs', '--no-install', '--agents', 'codex']);
        expect(calls[1].settings.env.ORKAS_LOCAL_AGENT_RUNNER).toBe('/fixture/runner.mts');
        expect(calls[1].settings.env.ORKAS_LOCAL_AGENT_USER_DATA_DIR).toContain('orkas-local-agent-live-');
      }
    } finally { write.mockRestore(); }
  });

  it('does not turn a signaled child into success and cleans up when launching throws', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let data = '';
    try {
      let count = 0;
      expect(await runLocalAgentLauncher({ ...options(), run: async (_command, _args, settings) => {
        data = settings.env.ORKAS_WORKSPACE_ROOT;
        return ++count === 1 ? { code: 0 } : { code: 0, signal: 'SIGTERM' };
      } })).toBe(1);
      expect(fs.existsSync(data)).toBe(false);
      await expect(runLocalAgentLauncher({ ...options(), run: async (_command, _args, settings) => {
        data = settings.env.ORKAS_WORKSPACE_ROOT; throw new Error('fixture spawn failure');
      } })).rejects.toThrow('fixture spawn failure');
      expect(fs.existsSync(data)).toBe(false);
    } finally { write.mockRestore(); }
  });

  it('keeps native failures and output scores while refusing outside or symlink reports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-cli-reports-'));
    const inside = path.join(root, 'reports'); fs.mkdirSync(inside);
    const report = { aggregate: { score: 17 }, results: [{ cliLogAnalysis: { passed: false, coveragePassed: true, levelCounts: { warn: 0, error: 1 } } }] };
    const outsideDir = path.join(root, 'outside'); fs.mkdirSync(outsideDir);
    const file = path.join(inside, 'report.json'), outside = path.join(outsideDir, 'report.json');
    const linkDir = path.join(inside, 'linked'), link = path.join(linkDir, 'report.json');
    fs.writeFileSync(file, JSON.stringify(report)); fs.writeFileSync(outside, JSON.stringify(report));
    fs.symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const collector = createModelEvalLogCollector('runtime');
    collector.ingest('stdout', `report=${file}\nreport=${outside}\nreport=${link}\n`);
    try {
      expect(attachLocalAgentReports({ analysis: collector.finish(), cwd: root, reportsDir: inside })).toBe(false);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ aggregate: { score: 17 }, logAcceptance: { passed: false }, processLogAnalysis: { passed: true } });
      expect(JSON.parse(fs.readFileSync(outside, 'utf8'))).toEqual(report);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('boots the real isolated Electron entry with a model-free TypeScript runner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-cli-electron-'));
    const runner = path.join(root, 'fixture.mts'), evidence = path.join(root, 'evidence.json');
    const data = path.join(root, 'data'), userData = path.join(root, 'profile');
    fs.mkdirSync(data); fs.mkdirSync(userData);
    fs.writeFileSync(runner, `import fs from 'node:fs';
import { app } from 'electron';
export async function main(argv) { fs.writeFileSync(process.env.PUBLIC_CLI_EVIDENCE, JSON.stringify({ argv, workspace:process.env.ORKAS_WORKSPACE_ROOT, profile:app.getPath('userData'), electron:!!process.versions.electron })); return 0; }`);
    const env = { ...process.env, ORKAS_LOCAL_AGENT_RUNNER: runner, ORKAS_LOCAL_AGENT_USER_DATA_DIR: userData,
      ORKAS_WORKSPACE_ROOT: data, PUBLIC_CLI_EVIDENCE: evidence };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
    try {
      const node = process.env.ORKAS_TEST_NODE;
      if (!node) throw new Error('The test launcher must provide standalone Node');
      const result = spawnSync(node, ['--input-type=module', '-e',
        `import { createRequire } from 'node:module'; import { spawnSync } from 'node:child_process'; import path from 'node:path'; const require=createRequire(import.meta.url); const child=spawnSync(require('electron'), ['--disable-gpu', path.resolve('scripts/local-agent-live-electron-entry.mjs'), '--fixture', 'literal value'], {env:process.env, encoding:'utf8', timeout:20000}); process.stdout.write(child.stdout||''); process.stderr.write(child.stderr||''); process.exitCode=child.status??1;`],
        { cwd: process.cwd(), env, encoding: 'utf8', timeout: 25000 });
      const diagnostics = createModelEvalLogCollector('runtime');
      diagnostics.ingest('stdout', result.stdout); diagnostics.ingest('stderr', result.stderr);
      expect(diagnostics.finish()).toMatchObject({ passed: true, requiresReview: false, coveragePassed: true });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(evidence, 'utf8'))).toEqual({ argv: ['--fixture', 'literal value'], workspace: data, profile: userData, electron: true });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it('preserves explicit proxy selection and parses static macOS proxy settings without model calls', () => {
    expect(localAgentChildEnv({ HTTPS_PROXY: 'http://proxy.invalid:8080' }, { platform: 'win32' }))
      .toMatchObject({ ORKAS_PROXY_MODE: 'env', ORKAS_PROXY_HTTPS_URL: 'http://proxy.invalid:8080' });
    expect(localAgentChildEnv({ ORKAS_PROXY_MODE: 'direct', HTTPS_PROXY: 'http://ignored.invalid:1' }))
      .toMatchObject({ ORKAS_PROXY_MODE: 'direct' });
    expect(parseMacOSSystemProxy('HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 8123\n'))
      .toMatchObject({ httpProxy: 'http://localhost:8123' });
  });
});
