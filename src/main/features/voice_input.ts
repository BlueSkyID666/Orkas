import { systemPreferences } from 'electron';
import { getOrkasApiKey } from './auth';
import { getActiveUserId } from './users';
import { ORKAS_API_BASE_URL } from './orkas_api';
import { fetchAndReadWithTimeout } from '../util/abort';

type VoiceSession = { ok: true; url: string; maxSeconds: number }
  | { ok: false; error: 'E_ORKAS_API_KEY_REQUIRED' | 'E_VOICE_UNAVAILABLE' };

/** The long-lived credential never crosses IPC; only a one-use ticket does. */
export async function createVoiceSession(): Promise<VoiceSession> {
  const key = getOrkasApiKey();
  if (!key) return { ok: false, error: 'E_ORKAS_API_KEY_REQUIRED' };
  const owner = getActiveUserId();
  try {
    const { response, body } = await fetchAndReadWithTimeout<unknown>(
      ORKAS_API_BASE_URL + '/audio/transcription_sessions',
      { method: 'POST', redirect: 'error', headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      }, body: '{}' },
      60_000, undefined, 'voice session unavailable',
      async (reply) => reply.ok ? reply.json() : null,
    );
    if (owner !== getActiveUserId() || key !== getOrkasApiKey()) {
      return { ok: false, error: 'E_VOICE_UNAVAILABLE' };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'E_ORKAS_API_KEY_REQUIRED' };
    }
    const ticket = body && typeof body === 'object' && 'ticket' in body ? body.ticket : null;
    if (!response.ok || typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      return { ok: false, error: 'E_VOICE_UNAVAILABLE' };
    }
    return { ok: true, url: 'wss://orkas.ai/api/voice/asr_ws?ticket=' + ticket, maxSeconds: 120 };
  } catch {
    return { ok: false, error: 'E_VOICE_UNAVAILABLE' };
  }
}

export async function ensureMicrophoneAccess(): Promise<{ granted: boolean; status: string }> {
  if (process.platform !== 'darwin') return { granted: true, status: 'granted' };
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status !== 'not-determined') return { granted: status === 'granted', status };
  const granted = await systemPreferences.askForMediaAccess('microphone');
  return { granted, status: granted ? 'granted' : systemPreferences.getMediaAccessStatus('microphone') };
}
