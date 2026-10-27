import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openSidebarEntry, expect, test } from './fixtures/orkas';

// Real Electron/IPC/discovery/updater flow with an isolated native installer.
// No host package manager, real account or paid model is used.
test('offers CLI upgrade on creation, details and execution failures', async ({ cliOrkas }, testInfo) => {
  test.skip(process.platform === 'win32', 'Native POSIX installer fixture; Windows updater smoke is separate.');
  test.setTimeout(120_000);
  const app = cliOrkas; const page = app.page!;
  const versionFile = path.join(app.root, 'upgrade-version');
  const modeFile = path.join(app.root, 'upgrade-mode');
  const updatesFile = path.join(app.root, 'upgrade-calls');
  const bin = path.join(app.root, '.codex/packages/standalone/current/bin/codex');
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(versionFile, '0.144.0'); writeFileSync(modeFile, 'success');
  const source = `#!${process.env.ORKAS_TEST_NODE || process.execPath}\n
const fs = require('node:fs'); const cp = require('node:child_process');
const versionFile = ${JSON.stringify(versionFile)}; const modeFile = ${JSON.stringify(modeFile)};
if (process.argv.includes('--version')) console.log(fs.readFileSync(versionFile, 'utf8'));
else if (process.argv.includes('--help')) console.log('Commands:\\n  update  Upgrade Codex');
else if (process.argv.includes('update')) {
  fs.appendFileSync(${JSON.stringify(updatesFile)}, 'update\\n');
  setTimeout(() => { if (fs.readFileSync(modeFile, 'utf8') === 'failure') process.exit(7);
    fs.writeFileSync(versionFile, '0.159.3'); }, 2000);
} else {
  const child = cp.spawn(${JSON.stringify(app.fakeCodexPath)}, process.argv.slice(2), { stdio: 'inherit', env: process.env });
  child.on('exit', code => process.exit(code || 0));
}\n`;
  writeFileSync(bin, source); chmodSync(bin, 0o755);
  await app.electronApp!.evaluate((_electron, file) => { process.env.ORKAS_CODEX_PATH = file; }, bin);
  await app.invoke('localAgents.detect', { type: 'codex' });
  await page.evaluate(async () => { await (window as any).setLang('zh'); });
  await openSidebarEntry(page, '#agents-btn');
  await page.locator('#agents-connect-cli-btn').click();
  const creation = page.locator('#agent-modal-ext-cli-upgrades [data-cli="codex"]');
  await expect(creation.locator('.local-cli-upgrade-btn')).toBeVisible();
  await expect(creation.locator('button')).toHaveText('升级 CLI');
  await expect(page.locator('#agent-modal-ext-cli-upgrade-warning')).toContainText('0.144.0');
  await page.screenshot({ path: testInfo.outputPath('01-create-upgrade.png') });
  await creation.locator('button').click();
  await expect(creation.locator('button')).toHaveText('升级中…');
  await expect(creation.locator('button')).toBeDisabled();
  await expect(creation.locator('[role="status"]')).toBeEmpty();
  await page.screenshot({ path: testInfo.outputPath('02-upgrade-progress.png') });
  await expect(creation.locator('[role="status"]')).toHaveText('升级成功', { timeout: 30_000 });
  await page.locator('#agent-modal-ext-cli-select .ai-select-trigger').click();
  const codexChoice = page.locator('.ai-select-popover:visible .ai-select-item[data-value="codex"]');
  await expect(codexChoice).toContainText('0.159.3');
  await codexChoice.click();
  await expect(page.locator('#agent-modal-ext-cli-select .ai-select-trigger')).toContainText('0.159.3');
  await page.screenshot({ path: testInfo.outputPath('03-upgrade-success.png') });
  expect(readFileSync(updatesFile, 'utf8')).toBe('update\n');
  await page.locator('#agent-modal .modal-actions .btn').first().click();
  const created = await app.invoke<{ agent: { agent_id: string } }>('agents.create', {
    name: 'CodexUpgradeDemo', description: 'CLI 兼容性测试', runtime: { kind: 'cli', cli: 'codex' },
  });
  expect(created).toMatchObject({ ok: true, agent: { agent_id: expect.any(String) } });
  await page.evaluate(async id => { await (window as any).openAgentDetail(id); }, created.agent.agent_id);
  const detail = page.locator('#agents-detail-runtime .local-cli-upgrade-control');
  await expect(detail.locator('button')).toBeVisible();
  await expect(page.locator('#agents-detail-cli-settings [data-role="model"]')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('04-details-upgrade.png') });
  writeFileSync(modeFile, 'failure');
  await detail.locator('button').click();
  await expect(detail.locator('[role="status"]')).toContainText('升级失败', { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('05-upgrade-failure.png') });
  writeFileSync(versionFile, '0.144.0'); writeFileSync(modeFile, 'success');
  await app.invoke('localAgents.detect', { type: 'codex' });
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('@CodexUpgradeDemo 请检查 CLI 版本');
  await page.locator('#new-chat-send-btn').click();
  const recovery = page.locator('#chat-history .chat-message[data-failure-code="version_too_old"] .chat-bubble .chat-app-nav-row');
  await expect(recovery.locator('button')).toHaveText('升级 Codex CLI', { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('06-execution-upgrade.png') });
  await recovery.locator('button').click();
  await expect(recovery.locator('button')).toHaveText('升级中…');
  await expect(recovery.locator('[role="status"]')).toBeEmpty();
  await page.screenshot({ path: testInfo.outputPath('07-execution-progress.png') });
  await expect(recovery.locator('[role="status"]')).toHaveText('升级成功', { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('08-execution-success.png') });
  // Upgrade is maintenance only: no task replay/model request follows it.
  expect(app.readCliState().invocations).toHaveLength(0);
  expect(readFileSync(updatesFile, 'utf8').trim().split('\n')).toHaveLength(3);
  // Source/custom installations keep their owner instead of installing a second CLI.
  const customBin = path.join(app.root, 'custom-codex');
  writeFileSync(customBin, source); chmodSync(customBin, 0o755);
  await app.electronApp!.evaluate((_electron, file) => { process.env.ORKAS_CODEX_PATH = file; }, customBin);
  await app.invoke('localAgents.detect', { type: 'codex' });
  await page.evaluate(async id => { await (window as any).openAgentDetail(id); }, created.agent.agent_id);
  await detail.locator('button').click();
  await expect(detail.locator('[role="status"]')).toHaveText('升级失败');
  await expect(detail.locator('button')).toHaveText('升级 CLI');
  await expect(page.getByText('查看升级说明', { exact: true })).toHaveCount(0);
  expect(readFileSync(updatesFile, 'utf8').trim().split('\n')).toHaveLength(3);
});

test('adapts supported CLI defaults and keeps unavailable selections out of upgrade recovery', async ({ cliOrkas }, testInfo) => {
  test.skip(process.platform === 'win32', 'Native POSIX fixture.');
  const app = cliOrkas; const page = app.page!;
  const bin = path.join(app.root, '.codex/packages/standalone/current/bin/codex');
  const version = path.join(app.root, 'catalog-version'); const requests = path.join(app.root, 'catalog-rpc');
  mkdirSync(path.dirname(bin), { recursive: true }); writeFileSync(version, '0.156.1');
  writeFileSync(bin, `#!${process.env.ORKAS_TEST_NODE || process.execPath}\n
const fs = require('node:fs'); const version = ${JSON.stringify(version)};
if (process.argv.includes('--version')) { console.log(fs.readFileSync(version, 'utf8')); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Commands:\\n  update  Upgrade Codex'); process.exit(0); }
if (process.argv.includes('update')) { setTimeout(()=>fs.writeFileSync(version, '0.159.3'), 300); }
else require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (!m.method) return;
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(m) + '\\n');
  const result = m.method === 'config/read' ? { config: { model: 'gpt-6.1-sol', model_provider: 'openai' } }
    : m.method === 'account/read' ? { account: { type: 'chatgpt' } }
    : m.method === 'model/list' ? { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', isDefault: true },
      { id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol' }] }
    : m.method === 'thread/start' ? { threadId: 'compat-thread' }
    : m.method === 'turn/start' ? { turn: { id: 'compat-turn' } }
    : {};
  if (['thread/start', 'turn/start'].includes(m.method) && m.params.model !== 'gpt-6-sol') process.exit(9);
  if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
  if (m.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'compat-thread', turnId: 'compat-turn', itemId: 'answer', delta: '兼容运行成功' } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: {
      threadId: 'compat-thread', turn: { id: 'compat-turn', status: 'completed' } } }) + '\\n');
  }
});\n`); chmodSync(bin, 0o755);
  await app.electronApp!.evaluate((_electron, file) => { process.env.ORKAS_CODEX_PATH = file; }, bin);
  const detection = await app.invoke<any>('localAgents.detect', { type: 'codex' });
  expect(detection.entry).toMatchObject({ available: true, version: '0.156.1' });
  const created = await app.invoke<any>('agents.create', {
    name: 'CodexModelCompatibility', description: 'CLI model compatibility fixture',
    runtime: { kind: 'cli', cli: 'codex', model_override: 'gpt-6.1-sol' },
  });
  expect(created.ok).toBe(true);
  await page.evaluate(async () => { await (window as any).setLang('zh'); });
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('@CodexModelCompatibility 检查版本兼容性');
  await page.locator('#new-chat-send-btn').click();
  const failure = page.locator('#chat-history .chat-message[data-failure-code="model_unsupported"]');
  await expect(failure).toBeVisible({ timeout: 30_000 });
  await expect(failure).toContainText('修改运行设置');
  await expect(failure).not.toContainText('升级');
  await expect(failure.locator('.local-cli-upgrade-btn')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('09-model-settings.png') });
  const before = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(before.map(row => row.method)).toContain('account/read');
  expect(before.filter(row => ['thread/start', 'thread/resume', 'turn/start'].includes(row.method))).toEqual([]);
  const saved = await app.invoke<any>('agents.get', { agent_id: created.agent.agent_id });
  expect(saved.agent.runtime.model_override).toBe('gpt-6.1-sol');
  const inherited = await app.invoke<any>('agents.create', {
    name: 'CodexCompatibleDefault', description: 'CLI compatible defaults fixture', runtime: { kind: 'cli', cli: 'codex' },
  });
  expect(inherited.ok).toBe(true);
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('@CodexCompatibleDefault 检查版本兼容性');
  await page.locator('#new-chat-send-btn').click();
  await expect(page.locator('#chat-history .chat-bubble').filter({ hasText: '兼容运行成功' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#chat-history .local-cli-upgrade-btn')).toHaveCount(0);
  const completed = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(completed.filter(row => row.method === 'turn/start').map(row => row.params.model)).toEqual(['gpt-6-sol']);
  expect(readFileSync(version, 'utf8')).toBe('0.156.1');
  await page.screenshot({ path: testInfo.outputPath('10-compatible-default.png') });
});


test('upgrades native Claude through its advertised alias and refreshes the detail version', async ({ cliOrkas }, testInfo) => {
  test.skip(process.platform === 'win32', 'Native POSIX symlink installer fixture.');
  const app = cliOrkas; const page = app.page!;
  const directory = path.join(app.root, '.local/share/claude/versions');
  const bin = path.join(app.root, '.local/bin/claude');
  const next = path.join(directory, '2.1.113');
  const calls = path.join(app.root, 'claude-update-calls');
  mkdirSync(directory, { recursive: true }); mkdirSync(path.dirname(bin), { recursive: true });
  for (const version of ['2.1.112', '2.1.113']) {
    const file = path.join(directory, version);
    writeFileSync(file, `#!${process.env.ORKAS_TEST_NODE || process.execPath}\n
const fs = require('node:fs');
if (process.argv.includes('--version')) console.log('${version} (Claude Code)');
else if (process.argv.slice(2).join(' ') === 'update --help') console.log('Usage: claude update|upgrade [options]');
else if (process.argv.includes('--help')) console.log('Usage: claude [options] [command]\\nCommands:\\n  agents [options] List co');
else if (process.argv.slice(2).join(' ') === 'update') {
  fs.appendFileSync(${JSON.stringify(calls)}, 'update\\n');
  setTimeout(() => { fs.unlinkSync(${JSON.stringify(bin)}); fs.symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(bin)}); }, 1000);
} else process.exit(8);
`); chmodSync(file, 0o755);
  }
  symlinkSync(path.join(directory, '2.1.112'), bin);
  // Finish any startup probe before replacing its fixture executable.
  await app.invoke('localAgents.detect', { type: 'claude' });
  await app.electronApp!.evaluate((_electron, file) => { process.env.ORKAS_CLAUDE_PATH = file; }, bin);
  const detected = await app.invoke<any>('localAgents.detect', { type: 'claude' });
  expect(detected.entry).toMatchObject({ available: true, version: '2.1.112' });
  const created = await app.invoke<any>('agents.create', {
    name: 'ClaudeUpgradeDemo', description: 'Native CLI update fixture', runtime: { kind: 'cli', cli: 'claude' },
  });
  expect(created.ok).toBe(true);
  await page.evaluate(async id => {
    await (window as any).setLang('zh'); await (window as any).openAgentDetail(id);
  }, created.agent.agent_id);
  const control = page.locator('#agents-detail-runtime .local-cli-upgrade-control');
  await expect(control.locator('button')).toHaveText('升级 CLI');
  await control.locator('button').click();
  await expect(control.locator('button')).toHaveText('升级中…');
  await expect(control.locator('[role="status"]')).toHaveText('升级成功', { timeout: 30_000 });
  await expect(page.locator('#agents-detail-runtime .ai-select-trigger')).toContainText('2.1.113');
  expect(readFileSync(calls, 'utf8')).toBe('update\n');
  expect(app.readCliState().invocations).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('12-claude-upgrade-success.png') });
  // Hold discovery at the renderer boundary after a real native update. A
  // locale refresh must retain that feedback, and older completions must not
  // replace the version displayed by the latest refresh.
  const response = await app.invoke<any>('agents.get', { agent_id: created.agent.agent_id });
  await page.evaluate(agent => {
    const w = window as any;
    w.__upgradeDiscoveryOriginal = w.loadLocalCliEntries;
    w.__upgradeDiscoveries = [];
    w.loadLocalCliEntries = () => new Promise(resolve => w.__upgradeDiscoveries.push(resolve));
    w.__upgradeRefreshes = [w._renderAgentDetailRuntime(agent), w._renderAgentDetailRuntime(agent)];
  }, response.agent);
  try {
    await expect(control.locator('[role="status"]')).toHaveText('升级成功');
    await expect(page.locator('#agents-detail-runtime .ai-select-trigger')).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('13-pending-feedback-zh.png') });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.evaluate(async () => { await (window as any).setLang('en'); });
    await expect.poll(() => page.evaluate(() => (window as any).__upgradeDiscoveries.length)).toBe(3);
    await expect(control.locator('[role="status"]')).toHaveText('Upgrade successful');
    await expect(control.locator('button')).toHaveText('Upgrade CLI');
    await page.screenshot({ path: testInfo.outputPath('14-pending-feedback-en-narrow.png') });
    await page.evaluate(async () => {
      const w = window as any;
      w.__upgradeDiscoveries[2]([{ type: 'claude', available: true, version: '2.1.113' }]);
      await Promise.resolve();
      for (const resolve of w.__upgradeDiscoveries.slice(0, 2)) {
        resolve([{ type: 'claude', available: true, version: '2.1.112' }]);
      }
      await Promise.all(w.__upgradeRefreshes);
    });
    await expect(page.locator('#agents-detail-runtime .ai-select-trigger')).toContainText('2.1.113');
    await expect(control.locator('[role="status"]')).toHaveText('Upgrade successful');
    await expect(control.locator('button')).toBeEnabled();
    expect(readFileSync(calls, 'utf8')).toBe('update\n');
    expect(app.readCliState().invocations).toHaveLength(0);
  } finally {
    await page.evaluate(() => {
      const w = window as any;
      w.loadLocalCliEntries = w.__upgradeDiscoveryOriginal;
      delete w.__upgradeDiscoveryOriginal; delete w.__upgradeDiscoveries; delete w.__upgradeRefreshes;
    });
  }
});


test('keeps upgrade buttons bound to their CLI when Claude and Codex coexist', async ({ cliOrkas }) => {
  test.skip(process.platform === 'win32', 'Native POSIX updater fixtures.');
  const app = cliOrkas; const page = app.page!;
  const calls = path.join(app.root, 'upgrade-routing-calls');
  writeFileSync(calls, '');
  const versions = { claude: path.join(app.root, 'routing-claude-version'), codex: path.join(app.root, 'routing-codex-version') };
  const bins = { claude: path.join(app.root, '.local/share/claude/versions/current'),
    codex: path.join(app.root, '.codex/packages/standalone/current/bin/codex') };
  for (const cli of ['claude', 'codex'] as const) {
    mkdirSync(path.dirname(bins[cli]), { recursive: true });
    writeFileSync(versions[cli], cli === 'claude' ? '2.1.112' : '0.144.0');
    writeFileSync(bins[cli], `#!${process.env.ORKAS_TEST_NODE || process.execPath}\n
const fs = require('node:fs');
if (process.argv.includes('--version')) console.log(fs.readFileSync(${JSON.stringify(versions[cli])}, 'utf8'));
else if (process.argv.includes('--help')) console.log('Commands:\\n  update  Update CLI');
else if (process.argv.slice(2).join(' ') === 'update') {
  fs.appendFileSync(${JSON.stringify(calls)}, '${cli}\\n');
  fs.writeFileSync(${JSON.stringify(versions[cli])}, '${cli === 'claude' ? '2.1.113' : '0.159.3'}');
} else process.exit(8);
`); chmodSync(bins[cli], 0o755);
  }
  await app.electronApp!.evaluate((_electron, paths) => {
    process.env.ORKAS_CLAUDE_PATH = paths.claude; process.env.ORKAS_CODEX_PATH = paths.codex;
  }, bins);
  for (const type of ['claude', 'codex']) await app.invoke('localAgents.detect', { type });
  await page.evaluate(async () => { await (window as any).setLang('zh'); });
  await openSidebarEntry(page, '#agents-btn');
  await page.locator('#agents-connect-cli-btn').click();
  // Connection recovery targets the CLI named in the outdated-version warning.
  await expect(page.locator('#agent-modal-ext-cli-upgrade-warning')).toContainText('Codex');
  await page.locator('#agent-modal-ext-cli-upgrades button').click();
  await expect(page.locator('#agent-modal-ext-cli-upgrades [role="status"]')).toHaveText('升级成功');
  expect(readFileSync(calls, 'utf8')).toBe('codex\n');
  expect(readFileSync(versions.claude, 'utf8')).toBe('2.1.112');
  await page.locator('#agent-modal .modal-actions .btn').first().click();
  const created = await app.invoke<any>('agents.create', {
    name: 'UpgradeRouting', description: 'CLI binding fixture', runtime: { kind: 'cli', cli: 'codex' },
  });
  expect(created.ok).toBe(true);
  await page.evaluate(async id => { await (window as any).openAgentDetail(id); }, created.agent.agent_id);
  // Change the real selector and require the replacement button to use the new binding.
  await page.locator('#agents-detail-runtime .ai-select-trigger').click();
  await page.locator('.ai-select-popover:visible .ai-select-item[data-value="cli:claude"]').click();
  await expect(page.locator('#agents-detail-runtime .ai-select-trigger')).toContainText('Claude');
  const detail = page.locator('#agents-detail-runtime .local-cli-upgrade-control');
  await detail.locator('button').click();
  await expect(detail.locator('[role="status"]')).toHaveText('升级成功');
  expect(readFileSync(calls, 'utf8')).toBe('codex\nclaude\n');
  writeFileSync(versions.claude, '1.9.0');
  await app.invoke('localAgents.detect', { type: 'claude' });
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('@UpgradeRouting 检查 CLI 版本');
  await page.locator('#new-chat-send-btn').click();
  const chip = page.locator('#chat-history .chat-message[data-failure-code="version_too_old"] .chat-bubble .local-cli-upgrade-control');
  await expect(chip.locator('button')).toHaveText('升级 Claude Code CLI', { timeout: 30_000 });
  await chip.locator('button').click();
  await expect(chip.locator('[role="status"]')).toHaveText('升级成功');
  expect(readFileSync(calls, 'utf8')).toBe('codex\nclaude\nclaude\n');
  expect(readFileSync(versions.codex, 'utf8')).toBe('0.159.3');
  expect(app.readCliState().invocations).toHaveLength(0);
});
