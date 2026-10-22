import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ownFixtureServer } from './fixtures/server-cleanup';
import { expect, test } from './fixtures/orkas';
import { expectComposerText } from './fixtures/composer';

const cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

test.describe('API-key voice input', () => {
  test('guides configuration without microphone access and preserves the draft', async ({ appPage }, testInfo) => {
    await appPage.locator('#new-chat-input').fill('Keep this draft');
    await appPage.locator('#new-chat-mic-btn').click();
    const dialog = appPage.locator('.ui-dialog-overlay.open');
    await expect(dialog).toContainText('Orkas API');
    await appPage.screenshot({ path: testInfo.outputPath('voice-key-guidance-en.png') });
    await dialog.locator('[data-act="choice"][data-id="configure"]').click();
    await expect(appPage.locator('#settings-orkas-api-key-input')).toBeFocused();
    await appPage.evaluate(() => (window as any).setView('new-chat'));
    await expectComposerText(appPage.locator('#new-chat-input'), 'Keep this draft');
    await appPage.setViewportSize({ width: 760, height: 600 });
    await appPage.evaluate(async () => { await (window as any).setLang('zh'); });
    await appPage.locator('#new-chat-mic-btn').click();
    await expect(dialog).toContainText('语音输入需要 Orkas API Key');
    await appPage.screenshot({ path: testInfo.outputPath('voice-key-guidance-zh-narrow.png') });
    const bounds = await dialog.locator('.modal').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(760);
    await dialog.locator('[data-act="cancel"]').click();
  });

  test('completes the real IPC and composer journey using a controlled recognition service', async ({ orkas }, testInfo) => {
    const page = orkas.page!;
    await orkas.electronApp!.evaluate(({ systemPreferences }) => {
      systemPreferences.getMediaAccessStatus = () => 'granted';
      const original = globalThis.fetch;
      globalThis.fetch = async (input, options) => String(input).endsWith('/audio/transcription_sessions')
        ? new Response(JSON.stringify({ ticket: 't'.repeat(43), expires_in: 30 }), { status: 200 })
        : original(input, options);
    });
    await page.evaluate(async () => {
      await (window as any).orkas.invoke('orkasApi.save', { apiKey: 'synthetic-voice-e2e-key' });
      const w = window as any;
      w.__voiceStops = 0;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => ({ getTracks: () => [{ stop() { w.__voiceStops++; } }] }) });
      const node = () => ({ connect() {}, disconnect() {} });
      w.AudioContext = class {
        state = 'running'; sampleRate = 48000; destination = {};
        audioWorklet = { addModule: async () => {} };
        createMediaStreamSource = node;
        createGain = () => ({ ...node(), gain: { value: 0 } });
        close = async () => {};
      };
      w.AudioWorkletNode = class {
        port = { onmessage: null as any, postMessage: (data: any) => {
          if (data.flush) queueMicrotask(() => this.port.onmessage?.({ data: { flushed: true } }));
        } };
        connect() {} disconnect() {}
      };
    });
    // Electron's CDP bridge does not intercept WebSockets through Playwright.
    // Use a real loopback peer; only the transport constructor is redirected.
    const server = createServer();
    const cleanup = ownFixtureServer(server);
    cleanups.push(cleanup);
    server.on('upgrade', (request, socket) => {
      const key = String(request.headers['sec-websocket-key']);
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      const ready = Buffer.from('{"event":"ready"}');
      socket.write(Buffer.concat([Buffer.from([0x81, ready.length]), ready]));
      let buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 6) {
          const size = buffer[1] & 127;
          if (size >= 126) { socket.destroy(); return; }
          if (buffer.length < size + 6) return;
          const payload = Buffer.from(buffer.subarray(6, size + 6));
          for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[2 + i % 4];
          const opcode = buffer[0] & 15;
          buffer = buffer.subarray(size + 6);
          if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
          if (opcode !== 1 || payload.toString() !== '__END__') continue;
          const result = Buffer.from(JSON.stringify({ is_last_package: true, payload_msg: { result: { text: 'E2E dictated note' } } }));
          socket.write(Buffer.concat([Buffer.from([0x81, result.length]), result]));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await page.evaluate(port => {
      const Native = window.WebSocket;
      (window as any).WebSocket = class extends Native {
        constructor(url: string, protocols?: string | string[]) {
          if (!url.startsWith('wss://orkas.ai/api/voice/asr_ws?ticket=')) throw new Error('Unexpected voice destination');
          super('ws://127.0.0.1:' + port + '/api/voice/asr_ws', protocols);
        }
      };
    }, (server.address() as AddressInfo).port);
    await page.locator('#new-chat-input').fill('Draft:');
    await page.locator('#new-chat-input').evaluate(element => {
      const w = window as any; w.composerSetSelection(element, w.composerText(element).length);
    });
    await page.locator('#new-chat-mic-btn').click();
    await page.locator('.ui-dialog-overlay.open [data-act="ok"]').click();
    await expect(page.locator('#new-chat-mic-btn')).toHaveAttribute('data-voice-phase', 'recording');
    await page.screenshot({ path: testInfo.outputPath('voice-recording-en.png') });
    await page.setViewportSize({ width: 760, height: 600 });
    await page.evaluate(async () => { await (window as any).setLang('zh'); });
    await expect(page.locator('.chat-mic-status:visible')).toContainText('正在录音');
    await page.screenshot({ path: testInfo.outputPath('voice-recording-zh-narrow.png') });
    await page.locator('#new-chat-mic-btn').click();
    await expectComposerText(page.locator('#new-chat-input'), 'Draft: E2E dictated note');
    await expect(page.locator('#new-chat-mic-btn')).toHaveAttribute('data-voice-phase', 'idle');
    expect(await page.evaluate(() => (window as any).__voiceStops)).toBe(1);
    await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(0);
  });
});
