import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function element() {
  const events: Record<string, Function> = {};
  const classes = new Set<string>();
  return { id: 'new-chat-mic-btn', value: 'Draft:', dataset: {} as any, title: '', hidden: false,
    classList: { toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
      contains: (name: string) => classes.has(name) },
    parentNode: { insertBefore: vi.fn() }, setAttribute: vi.fn(), getClientRects: () => [1],
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
    document: { addEventListener: vi.fn(), getElementById: () => input, createElement: () => element(), hidden: false },
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
  it('uses the Orkas icon-only active and finishing states throughout dictation', async () => {
    vi.useFakeTimers();
    const h = load();
    const expectState = (phase: string, recording: boolean, busy: boolean) => {
      expect(h.button.dataset.voicePhase).toBe(phase);
      expect(h.button.classList.contains('is-recording')).toBe(recording);
      expect(h.button.classList.contains('is-busy')).toBe(busy);
      expect(h.button.parentNode.insertBefore).not.toHaveBeenCalled();
    };
    expectState('idle', false, false);
    await h.button.dispatch('click'); await flush();
    expectState('connecting', true, false);
    expect(h.button.title).toBe('chat.mic_stop_title');
    h.socket().open(); await flush();
    expectState('recording', true, false);
    await h.button.dispatch('click'); await flush();
    expectState('finalizing', false, true);
    h.socket().result('spoken note', true);
    expectState('idle', false, false);
    expect(h.button.title).toBe('chat.mic_title');
  });
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
  it.each(['success', 'unresponsive', 'cancelled'])(
    'drains the speech tail or cancels incomplete capture safely: %s', async (scenario) => {
    vi.useFakeTimers();
    const h = load();
    let processor: any, Processor: any, blob: Blob;
    let mainPort: any;
    class WorkletProcessor {
      port = { onmessage: null as any, postMessage: (data: any) => {
        queueMicrotask(() => mainPort.onmessage?.({ data }));
      } };
    }
    class WorkletNode {
      port = mainPort = { onmessage: null as any, postMessage: (data: any) => {
        if (data.flush && scenario !== 'success') return;
        queueMicrotask(() => processor.port.onmessage?.({ data }));
      } };
      constructor() { processor = new Processor(); }
      connect() {}
      disconnect() {}
    }
    const BaseContext = h.context.window.AudioContext;
    h.context.window.AudioContext = class extends BaseContext {
      sampleRate = 16000;
      audioWorklet = { addModule: async () => {
        vm.runInNewContext(await blob.text(), {
          AudioWorkletProcessor: WorkletProcessor,
          registerProcessor: (_: string, value: any) => { Processor = value; },
        });
      } };
    };
    h.context.window.AudioWorkletNode = h.context.AudioWorkletNode = WorkletNode;
    h.context.Blob = Blob;
    h.context.URL = class extends URL {
      static createObjectURL(value: Blob) { blob = value; return 'blob:voice-test'; }
      static revokeObjectURL() {}
    };
    await h.button.dispatch('click'); await flush();
    const socket = h.socket(); socket.open(); await flush();
    // At 16kHz, this is 200ms of complete packets plus a 40ms speech tail.
    for (let i = 0; i < 30; i++) {
      processor.process([[new Float32Array(128).fill(i < 25 ? .25 : -.5)]], [[new Float32Array(128)]]);
    }
    await flush();
    await h.button.dispatch('click'); await flush();
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    if (scenario !== 'success') {
      expect(socket.send.mock.calls.some((call: any[]) => call[0] === '__END__')).toBe(false);
      if (scenario === 'cancelled') h.context.window.VoiceInput.cancel();
      await vi.advanceTimersByTimeAsync(500);
      await flush();
      expect(socket.send.mock.calls.some((call: any[]) => call[0] === '__END__')).toBe(false);
      expect(h.button.dataset.voicePhase).toBe('idle');
      expect(h.input.value).toBe('Draft:');
      if (scenario === 'unresponsive') {
        expect(h.context.uiAlert).toHaveBeenCalledWith('chat.mic_incomplete');
      } else {
        expect(h.context.uiAlert).not.toHaveBeenCalled();
      }
      return;
    }
    const sent = socket.send.mock.calls.map((call: any[]) => call[0]);
    const audio = sent.filter((data: any) => ArrayBuffer.isView(data) && data.byteLength > 0);
    expect(audio.reduce((n: number, data: any) => n + data.byteLength, 0)).toBe(7680);
    expect(Array.from(audio.at(-1).slice(-2))).toEqual([0, 192]);
    expect(sent.filter((value: any) => value === '__END__')).toHaveLength(1);
    expect(sent.at(-1)).toBe('__END__');
    socket.result('complete spoken note', true);
    expect(h.input.value).toBe('Draft: complete spoken note');
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
    expect(h.button.classList.contains('is-recording')).toBe(false);
    expect(h.button.classList.contains('is-busy')).toBe(false);
  });
  it('does not resurrect capture when stopped during worklet initialization', async () => {
    vi.useFakeTimers();
    const h = load();
    let ready: () => void = () => {};
    const BaseContext = h.context.window.AudioContext;
    h.context.window.AudioContext = class extends BaseContext {
      audioWorklet = { addModule: () => new Promise<void>((resolve) => { ready = resolve; }) };
    };
    h.context.Blob = Blob;
    const WorkletNode = vi.fn();
    h.context.window.AudioWorkletNode = h.context.AudioWorkletNode = WorkletNode;
    await h.button.dispatch('click'); await flush();
    const socket = h.socket(); socket.open(); await flush();
    await h.button.dispatch('click'); await flush();
    ready(); await flush();
    expect(WorkletNode).not.toHaveBeenCalled();
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.context.uiAlert).not.toHaveBeenCalled();
    socket.result('review this note', true);
    expect(h.input.value).toBe('Draft: review this note');
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
