import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ key: 'test-speech-key', uid: 'local-owner' }));
vi.mock('../../../src/main/features/auth', () => ({ getOrkasApiKey: () => state.key }));
vi.mock('../../../src/main/features/users', () => ({ getActiveUserId: () => state.uid }));
vi.mock('electron', () => ({ systemPreferences: {
  getMediaAccessStatus: vi.fn(() => 'granted'), askForMediaAccess: vi.fn(async () => true),
} }));

import { createVoiceSession } from '../../../src/main/features/voice_input';

const ticket = 't'.repeat(43);
describe('API-key voice session', () => {
  beforeEach(() => { state.key = 'test-speech-key'; state.uid = 'local-owner'; });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('exchanges a main-process credential for a fixed-origin ticket without exposing the key', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ticket, expires_in: 30, max_seconds: 120 })));
    vi.stubGlobal('fetch', fetcher);
    const result = await createVoiceSession();
    expect(result).toEqual({ ok: true, url: `wss://orkas.ai/api/voice/asr_ws?ticket=${ticket}`, maxSeconds: 120 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://orkas.ai/v1/audio/transcription_sessions');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', body: '{}',
      headers: { Authorization: 'Bearer test-speech-key', 'Content-Type': 'application/json' } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain(state.key);
  });

  it('requires a configured key before making any request', async () => {
    state.key = '';
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await createVoiceSession()).toEqual({ ok: false, error: 'E_ORKAS_API_KEY_REQUIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])('returns a bounded public failure for HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private upstream error', { status })));
    const result = await createVoiceSession();
    expect(result).toEqual({ ok: false, error: status === 401 || status === 403 ? 'E_ORKAS_API_KEY_REQUIRED' : 'E_VOICE_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    { ticket: 'short' }, { ticket: 'x'.repeat(44) }, { ticket: `${'x'.repeat(42)}&` },
    { url: 'wss://untrusted.example/asr', ticket: '' }, { ticket: 123 },
  ])('rejects malformed ticket responses without constructing an arbitrary transport', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    expect(await createVoiceSession()).toEqual({ ok: false, error: 'E_VOICE_UNAVAILABLE' });
  });

  it.each(['key', 'uid'])('discards a late ticket when the local %s changes', async (field) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = createVoiceSession();
    state[field as 'key' | 'uid'] = 'replacement';
    finish(new Response(JSON.stringify({ ticket })));
    expect(await pending).toEqual({ ok: false, error: 'E_VOICE_UNAVAILABLE' });
  });

  it('keeps the timeout active until the control response body finishes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    })));
    const pending = createVoiceSession();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await pending).toEqual({ ok: false, error: 'E_VOICE_UNAVAILABLE' });
  });
});
