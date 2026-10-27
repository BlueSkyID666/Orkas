import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ key: '', status: 'not-determined', ask: vi.fn(), fetch: vi.fn() }));
vi.mock('../../../src/main/features/auth', () => ({ getOrkasApiKey: () => mocks.key }));
vi.mock('electron', () => ({ systemPreferences: {
  getMediaAccessStatus: () => mocks.status,
  askForMediaAccess: mocks.ask,
} }));
import { createVoiceSession, ensureMicrophoneAccess, getVoiceStatus } from '../../../src/main/features/voice_input';

describe('API-key voice input', () => {
  beforeEach(() => { mocks.key = ''; vi.clearAllMocks(); vi.stubGlobal('fetch', mocks.fetch); });
  it('requires the shared key before contacting the service', async () => {
    expect(getVoiceStatus()).toEqual({ configured: false });
    expect(await createVoiceSession()).toMatchObject({ ok: false, code: 'api_key_required' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('keeps the key in main and returns only the fixed-origin ticket URL', async () => {
    mocks.key = 'synthetic-private-key';
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ticket: 't'.repeat(43), expires_in: 30 }), { status: 200 }));
    const result = await createVoiceSession();
    expect(result).toMatchObject({ ok: true, url: 'wss://orkas.ai/api/voice/asr_ws?ticket=' + 't'.repeat(43) });
    expect(JSON.stringify(result)).not.toContain(mocks.key);
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer ' + mocks.key } });
  });
  it('maps authorization and temporary failures without exposing provider text', async () => {
    mocks.key = 'synthetic-private-key';
    for (const [status, code] of [[401, 'invalid_api_key'], [403, 'insufficient_scope'], [503, 'unavailable']] as const) {
      mocks.fetch.mockResolvedValue(new Response('private server detail', { status }));
      expect(await createVoiceSession()).toEqual({ ok: false, code });
    }
  });
  it('does not repeat a rejected macOS permission request', async () => {
    mocks.status = 'denied';
    expect(await ensureMicrophoneAccess('darwin')).toEqual({ granted: false, status: 'denied' });
    expect(mocks.ask).not.toHaveBeenCalled();
    mocks.status = 'not-determined'; mocks.ask.mockResolvedValue(true);
    expect(await ensureMicrophoneAccess('darwin')).toEqual({ granted: true, status: 'granted' });
    expect(mocks.ask).toHaveBeenCalledWith('microphone');
    expect(await ensureMicrophoneAccess('win32')).toEqual({ granted: true, status: 'unknown' });
  });
});
