import { expectComposerText } from './fixtures/composer';
import { expect, test as base, OrkasTestApp } from './fixtures/orkas';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';

const test = base.extend({
  voiceOrkas: async ({}, use, info) => {
    const previous = process.env.ORKAS_E2E_KEEP_LOGS;
    process.env.ORKAS_E2E_KEEP_LOGS = '1';
    const app = new OrkasTestApp(info, { voiceStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      try { await app.dispose(); }
      finally {
        if (previous === undefined) delete process.env.ORKAS_E2E_KEEP_LOGS;
        else process.env.ORKAS_E2E_KEEP_LOGS = previous;
        const log = info.outputPath('electron-main.log');
        expect(existsSync(log), 'Retain complete Electron logs on passing runs too').toBe(true);
        const analysis = analyzeWebAppLogs(readFileSync(log, 'utf8'));
        writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
        expect(analysis.passed, 'Review log-analysis.json for errors or incomplete coverage').toBe(true);
        if (analysis.requiresReview) console.warn('Voice E2E log warnings:', JSON.stringify(analysis.findings));
      }
    }
  },
});

async function expectPublicTicketTransport(app: OrkasTestApp): Promise<void> {
  expect(app.voiceSessionRequests).toEqual([{ method: 'POST', path: '/v1/audio/transcription_sessions',
    authorized: true, body: '{}' }]);
  expect(await app.electronApp!.evaluate(() => (globalThis as any).__e2eVoiceSessionUrls))
    .toEqual(['https://orkas.ai/v1/audio/transcription_sessions']);
  const urls = await app.page!.evaluate(() => (window as any).__e2eVoiceSocketUrls);
  expect(urls).toHaveLength(1);
  const socket = new URL(urls[0]);
  expect(socket.origin + socket.pathname).toBe('wss://orkas.ai/api/voice/asr_ws');
  expect(socket.searchParams.get('ticket')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Array.from(socket.searchParams.keys()).sort()).toEqual(['encoding', 'ticket']);
  expect(await app.page!.locator('#account-login-overlay').count()).toBe(0);
}

test.describe('voice input', () => {
  test('inserts the terminal transcript for review without auto-sending', async ({ voiceOrkas }, info) => {
    if (!voiceOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = voiceOrkas.page;
    await voiceOrkas.installVoiceCaptureStub();

    const input = page.locator('#new-chat-input');
    const mic = page.locator('#new-chat-mic-btn');
    await input.fill('Draft:');
    await input.evaluate((element: HTMLTextAreaElement) => {
      const w = window as any;
      w.composerSetSelection(element, w.composerText(element).length);
    });

    await mic.click();
    await expect(mic).toHaveClass(/\bis-recording\b/);
    await expect(mic).toHaveAttribute('aria-label', 'Stop recording');
    // A Windows renderer under full-suite load can take slightly over the
    // global 10s expect window to complete the local WebSocket handshake.
    await expect(mic).toHaveAttribute('data-voice-phase', 'recording', { timeout: 20_000 });
    await mic.click();

    await expectComposerText(input, 'Draft: E2E dictated launch note');
    await expect(mic).not.toHaveClass(/\bis-recording\b|\bis-busy\b/);
    await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('voice-transcript.png') });
    expect(await page.evaluate(() => (window as any).__e2eVoiceTrackStops)).toBe(1);
    await expectPublicTicketTransport(voiceOrkas);
    writeFileSync(info.outputPath('voice-session-requests.json'), JSON.stringify(voiceOrkas.voiceSessionRequests, null, 2));
  });

  test('stopping during socket negotiation never starts a stale recording', async ({ voiceOrkas }, info) => {
    if (!voiceOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = voiceOrkas.page;
    voiceOrkas.setVoiceMode('blocked-open');
    await voiceOrkas.installVoiceCaptureStub();

    const input = page.locator('#new-chat-input');
    const mic = page.locator('#new-chat-mic-btn');
    await input.fill('Keep this draft');
    await mic.click();
    await expect(mic).toHaveClass(/\bis-recording\b/);
    await expect.poll(() => page.evaluate(() => (window as any).__e2eVoiceSocketUrls.length)).toBe(1);
    await mic.click();

    await expect(mic).not.toHaveClass(/\bis-recording\b|\bis-busy\b/);
    await expectComposerText(input, 'Keep this draft');
    await expect(page.locator('.ui-dialog-overlay:visible')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__e2eVoiceTrackStops)).toBe(1);
    await expectPublicTicketTransport(voiceOrkas);
  });

  test('requires a user API key without entering an account login flow', async ({ voiceOrkas }, info) => {
    const page = voiceOrkas.page!;
    await voiceOrkas.installVoiceCaptureStub();
    await voiceOrkas.invoke('orkasApi.remove');
    await page.locator('#new-chat-input').fill('Preserve my draft');
    await page.locator('#new-chat-mic-btn').click();
    await expect(page.locator('.ui-dialog-overlay:visible')).toContainText('Enter an API Key first');
    await expectComposerText(page.locator('#new-chat-input'), 'Preserve my draft');
    await expect(page.locator('#account-login-overlay')).toHaveCount(0);
    expect(voiceOrkas.voiceSessionRequests).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).__e2eVoiceSocketUrls)).toEqual([]);
    await page.screenshot({ path: info.outputPath('voice-key-required.png') });
  });
});
