import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function element() {
  const events: Record<string, Function> = {};
  return { id: 'new-chat-mic-btn', value: 'Draft:', dataset: {} as any, title: '', hidden: false,
    classList: { toggle: vi.fn() }, setAttribute: vi.fn(), getClientRects: () => [1],
    addEventListener: (name: string, fn: Function) => { events[name] = fn; },
    dispatch: (name: string) => events[name]?.(), focus: vi.fn() };
}
function load(overrides: Record<string, any> = {}) {
  const button = element(), input = element();
  let socket: any;
  const track = { stop: vi.fn() };
  const invoke = vi.fn(async (channel: string) => channel === 'voice.status' ? { ok: true, configured: true }
    : channel === 'voice.ensureMicrophoneAccess' ? { ok: true, granted: true, status: 'granted' }
      : { ok: true, url: 'wss://orkas.ai/api/voice/asr_ws?ticket=synthetic' });
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; bufferedAmount = 0;
    onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor() { socket = this; }
    send = vi.fn();
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    open() { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: '{"event":"ready"}' }); }
    result(text: string, last: boolean) { this.onmessage?.({ data: JSON.stringify({ is_last_package: last, payload_msg: { result: { text } } }) }); }
  }
  const node = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    state = 'running'; sampleRate = 48000; destination = {};
    createMediaStreamSource = node;
    createScriptProcessor = () => ({ ...node(), onaudioprocess: null });
    createGain = () => ({ ...node(), gain: { value: 1 } });
    close = async () => {};
  }
  const context: any = {
    window: { orkas: { invoke }, AudioContext, addEventListener: vi.fn(), localStorage: { getItem: () => null, setItem: vi.fn() } },
    document: { addEventListener: vi.fn(), getElementById: () => input, hidden: false },
    navigator: { mediaDevices: { getUserMedia } }, WebSocket: Socket,
    composerText: () => input.value, composerSelection: () => ({ start: input.value.length }),
    composerInsertion: () => ({ valid: () => true, replace: (text: string) => { input.value = 'Draft:' + text; return true; }, dispose() {} }),
    t: (key: string) => key, uiConfirm: vi.fn(async () => true), uiChoice: vi.fn(async () => null),
    uiAlert: vi.fn(), uiToast: vi.fn(), setView: vi.fn(),
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Event, Date,
    createLogger: () => ({ info() {}, warn() {}, error() {} }),
    ...overrides,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(readFileSync(path.join(__dirname, '../../src/renderer/modules/voice-input.js'), 'utf8'), context);
  context.window.VoiceInput.attach(button, input);
  return { context, button, input, invoke, getUserMedia, track, socket: () => socket };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe('voice input user journey', () => {
  it('guides a missing key before requesting the microphone', async () => {
    const h = load();
    h.invoke.mockResolvedValue({ ok: true, configured: false } as any);
    await h.button.dispatch('click'); await flush();
    expect(h.context.uiChoice).toHaveBeenCalledWith(expect.objectContaining({ message: 'chat.mic_key_required' }));
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(h.input.value).toBe('Draft:');
  });
  it('does not contact recognition after OS permission denial', async () => {
    const h = load();
    h.invoke.mockImplementation(async (channel: string) => channel === 'voice.status' ? { ok: true, configured: true } : { ok: true, granted: false, status: 'denied' } as any);
    await h.button.dispatch('click'); await flush();
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(h.invoke.mock.calls.map(c => c[0])).not.toContain('voice.createSession');
    expect(h.context.uiAlert).toHaveBeenCalledWith('chat.mic_error_permission');
  });
  it('does not misreport an unavailable credential status as an absent key', async () => {
    const h = load();
    h.invoke.mockResolvedValue({ ok: false } as any);
    await h.button.dispatch('click'); await flush();
    expect(h.context.uiAlert).toHaveBeenCalledWith('chat.mic_error_unavailable');
    expect(h.context.uiChoice).not.toHaveBeenCalled();
    expect(h.getUserMedia).not.toHaveBeenCalled();
  });
  it('preserves the draft when the microphone is absent or busy', async () => {
    for (const name of ['NotFoundError', 'NotReadableError']) {
      const h = load(); h.getUserMedia.mockRejectedValue(Object.assign(new Error(), { name }));
      await h.button.dispatch('click'); await flush();
      expect(h.invoke.mock.calls.map(c => c[0])).not.toContain('voice.createSession');
      expect(h.input.value).toBe('Draft:');
      expect(h.context.uiAlert).toHaveBeenCalledWith(name === 'NotFoundError' ? 'chat.mic_error_no_device' : 'chat.mic_error_busy');
    }
  });
  it('inserts recognized text for review and releases the microphone on stop', async () => {
    vi.useFakeTimers();
    const h = load(); await h.button.dispatch('click'); await flush();
    h.socket().open(); await flush();
    h.socket().result('spoken note', false);
    expect(h.input.value).toBe('Draft: spoken note');
    await h.button.dispatch('click'); await flush();
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    h.socket().result('spoken note.', true);
    expect(h.input.value).toBe('Draft: spoken note.');
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.invoke.mock.calls.map(c => c[0])).not.toContain('groupChat.send');
  });
  it('cancels a pending permission request without resurrecting recording', async () => {
    vi.useFakeTimers();
    const h = load(); let grant: any;
    h.getUserMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    await h.button.dispatch('click'); await flush();
    await h.button.dispatch('click');
    grant({ getTracks: () => [h.track] }); await flush();
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.socket()).toBeUndefined();
    expect(h.button.dataset.voicePhase).toBe('idle');
  });
  it('keeps the selected draft untouched when recognition produces no speech', async () => {
    vi.useFakeTimers();
    const h = load();
    const replace = vi.fn(() => true);
    h.context.composerInsertion = () => ({ replace, dispose() {} });
    await h.button.dispatch('click'); await flush();
    h.socket().open(); await flush();
    h.socket().result('', true);
    expect(replace).not.toHaveBeenCalled();
    expect(h.context.uiAlert).toHaveBeenCalledWith('chat.mic_empty');
    expect(h.track.stop).toHaveBeenCalledTimes(1);
  });
  it('releases capture and ignores late transcripts after the composer changes owner', async () => {
    vi.useFakeTimers();
    const h = load();
    await h.button.dispatch('click'); await flush();
    const socket = h.socket(); socket.open(); await flush();
    h.input.dispatch('composer-owner-change');
    socket.result('a previous conversation', true);
    expect(h.input.value).toBe('Draft:');
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('idle');
  });
});
