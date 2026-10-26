import { composerAccessorSource } from './composer-test-source';
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';

function makeButton(id: string) {
  const listeners: Record<string, Function> = {};
  const classes = new Set<string>();
  return {
    id,
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    title: '',
    classList: {
      toggle(name: string, active: boolean) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute() {},
    addEventListener(name: string, handler: Function) { listeners[name] = handler; },
    click() { return listeners.click?.(); },
  };
}

function makeTextarea() {
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange() {},
    dispatchEvent() {},
    addEventListener() {},
    focus() {},
  };
}

function loadVoiceInput(voice: any, _unused?: undefined, options: {
  sourcePath?: string;
  globals?: Record<string, unknown>;
} = {}) {
  const alerts: string[] = [];
  const windowObject: any = {
    orkas: { voiceInput: voice },
    alert(message: string) { alerts.push(String(message)); },
  };
  const context: any = {
    console,
    window: windowObject,
    document: { addEventListener() {}, getElementById: () => null },
    navigator: {},
    composerInsertion: () => ({ valid: () => true, replace: () => true, dispose() {} }),
    setTimeout,
    clearTimeout,
    URL,
    Date,
    Math,
    Event: class {},
    ...options.globals,
  };
  windowObject.window = windowObject;
  vm.createContext(context);
  vm.runInContext(composerAccessorSource, context);
  const source = fs.readFileSync(options.sourcePath || path.join(__dirname, '../../src/renderer/modules/voice-input.js'), 'utf8');
  vm.runInContext(source, context);
  return { context, alerts };
}

function installAudioCaptureStub(context: any) {
  const node = () => ({ connect() {}, disconnect() {} });
  const captures: any[] = [];
  context.window.AudioContext = class {
    state = 'running';
    sampleRate = 48_000;
    destination = {};
    createMediaStreamSource() { return node(); }
    createScriptProcessor() {
      const capture = { ...node(), onaudioprocess: null };
      captures.push(capture);
      return capture;
    }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    close() { return Promise.resolve(); }
  };
  return captures;
}

function loadCompressedCapture(sourcePath: string, failCompression = false) {
  let releaseFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let compressions = 0;
  // Driver completion is controlled; compression bytes use real gzip. This
  // exercises capture -> production transport -> wire without a microphone.
  class Compression {
    constructor(_format: string) {
      if (failCompression) throw new Error('synthetic gzip failure');
    }
  }
  class AudioBlob {
    constructor(private parts: Uint8Array[]) {}
    stream() {
      return {
        pipeThrough: () => gzipSync(Buffer.concat(this.parts.map((part) => Buffer.from(part)))),
      };
    }
  }
  class AudioResponse {
    constructor(private bytes: Buffer) {}
    async arrayBuffer() {
      if (++compressions === 1) await first;
      return Uint8Array.from(this.bytes).buffer;
    }
  }
  const { context } = loadVoiceInput({}, undefined, {
    sourcePath,
    globals: { CompressionStream: Compression, DecompressionStream: class {}, Blob: AudioBlob, Response: AudioResponse },
  });
  const sockets: any[] = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = Socket.CONNECTING;
    frames: (Buffer | string)[] = [];
    onopen?: () => void;
    onclose?: () => void;
    constructor(readonly url: string) { sockets.push(this); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    send(value: Uint8Array | string) {
      if (this.readyState !== Socket.OPEN) throw new Error('socket is closed');
      this.frames.push(typeof value === 'string' ? value : Buffer.from(value));
    }
    close() { this.readyState = Socket.CLOSED; this.onclose?.(); }
  }
  context.WebSocket = Socket;
  context.setTimeout = () => 1;
  context.navigator.mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  };
  const captures = installAudioCaptureStub(context);
  const errors: Error[] = [];
  const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
    onError: (error: Error) => errors.push(error),
  });
  const capture = (sample: number) => captures.at(-1).onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array([sample, sample, sample]) },
  });
  const decode = (frames: (Buffer | string)[]) => frames.map((value) => (
    typeof value === 'string' ? value : Array.from(gunzipSync(value))
  ));
  return { client, sockets, errors, capture, decode, releaseFirst };
}

function loadWorkletCapture(sourcePath: string, options: {
  delayedModule?: boolean;
  delayedPermission?: boolean;
  dropFlush?: boolean;
} = {}) {
  const modules = new Map<string, string>();
  let releaseModule: () => void = () => {};
  const moduleGate = new Promise<void>((resolve) => { releaseModule = resolve; });
  let grantPermission: (value: any) => void = () => {};
  const permission = new Promise((resolve) => { grantPermission = resolve; });
  class WorkletBlob {
    constructor(readonly parts: string[]) {}
  }
  class WorkletURL extends URL {
    static createObjectURL(blob: WorkletBlob) {
      const url = `blob:worklet-${modules.size}`;
      modules.set(url, blob.parts.join(''));
      return url;
    }
    static revokeObjectURL(_url: string) {}
  }
  const { context } = loadVoiceInput({}, undefined, {
    sourcePath, globals: { Blob: WorkletBlob, URL: WorkletURL },
  });
  const nodes: any[] = [];
  const sockets: any[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  let tracksStopped = 0;
  let Processor: any;
  let channel: any;
  class WorkletNode {
    port = {
      onmessage: null as any,
      postMessage: (data: any) => {
        if (options.dropFlush && data.flush) return;
        queueMicrotask(() => this.processor.port.onmessage?.({ data }));
      },
    };
    processor: any;
    constructor() {
      channel = this.port;
      this.processor = new Processor();
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
  }
  class CaptureContext {
    state = 'running';
    sampleRate = 16_000;
    destination = {};
    audioWorklet = {
      addModule: async (url: string) => {
        if (options.delayedModule) await moduleGate;
        const source = modules.get(url);
        if (!source) throw new Error('missing owned worklet module');
        vm.runInNewContext(source, {
          AudioWorkletProcessor: class {
            port: any;
            constructor() {
              const owner = channel;
              // Resolve the node's port when it is constructed, after module
              // registration. Production processor messages remain unchanged.
              this.port = {
                onmessage: null,
                postMessage: (data: any) => queueMicrotask(() => owner.onmessage?.({ data })),
              };
            }
          },
          registerProcessor: (_name: string, implementation: any) => { Processor = implementation; },
        });
      },
    };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    close() { return Promise.resolve(); }
  }
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = Socket.CONNECTING;
    frames: (Buffer | string)[] = [];
    onopen?: () => void;
    onclose?: () => void;
    constructor(_url: string) { sockets.push(this); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    send(value: Uint8Array | string) {
      this.frames.push(typeof value === 'string' ? value : Buffer.from(value));
    }
    close() { this.readyState = Socket.CLOSED; this.onclose?.(); }
  }
  const stream = { getTracks: () => [{ stop: () => { tracksStopped++; } }] };
  context.WebSocket = Socket;
  context.AudioWorkletNode = WorkletNode;
  context.window.AudioWorkletNode = WorkletNode;
  context.window.AudioContext = CaptureContext;
  context.navigator.mediaDevices = {
    getUserMedia: () => options.delayedPermission ? permission : Promise.resolve(stream),
  };
  context.setTimeout = (callback: () => void, delay: number) => {
    timers.set(++timerId, { callback, delay });
    return timerId;
  };
  context.clearTimeout = (id: number) => timers.delete(id);
  const errors: Error[] = [];
  const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
    onError: (error: Error) => errors.push(error),
  });
  const processSamples = (count: number) => {
    for (let offset = 0; offset < count; offset += 128) {
      nodes.at(-1).processor.process(
        [[new Float32Array(Math.min(128, count - offset)).fill(0.25)]],
        [[new Float32Array(128)]],
      );
    }
  };
  return {
    client, nodes, sockets, errors, timers, processSamples, releaseModule,
    grantPermission: () => grantPermission(stream),
    tracksStopped: () => tracksStopped,
  };
}

function loadDelayedTranscript(sourcePath: string) {
  let releaseFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let decodes = 0;
  let tracksStopped = 0;
  class Compression {}
  class Decompression {}
  class IncomingBlob {
    constructor(private parts: Uint8Array[]) {}
    stream() {
      return { pipeThrough: (codec: any) => {
        const input = Buffer.concat(this.parts.map((part) => Buffer.from(part)));
        const incoming = codec instanceof Decompression;
        return { incoming, bytes: incoming ? gunzipSync(input) : gzipSync(input) };
      } };
    }
  }
  class IncomingResponse {
    constructor(private payload: { incoming: boolean; bytes: Buffer }) {}
    async arrayBuffer() {
      if (this.payload.incoming && ++decodes === 1) await first;
      return Uint8Array.from(this.payload.bytes).buffer;
    }
  }
  const { context } = loadVoiceInput({}, undefined, {
    sourcePath,
    globals: {
      CompressionStream: Compression, DecompressionStream: Decompression,
      Blob: IncomingBlob, Response: IncomingResponse, TextDecoder,
    },
  });
  const sockets: any[] = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = Socket.CONNECTING;
    onopen?: () => void;
    onmessage?: (event: any) => void;
    onclose?: (event: any) => void;
    constructor(_url: string) { sockets.push(this); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    receive(text: string, terminal = false) {
      const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text } })));
      const frame = Buffer.alloc(12 + payload.length);
      frame.set([0x11, terminal ? 0x93 : 0x91, 0x11, 0]);
      frame.writeInt32BE(terminal ? -2 : 1, 4);
      frame.writeUInt32BE(payload.length, 8);
      payload.copy(frame, 12);
      this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) });
    }
    send() {}
    close() {
      this.readyState = Socket.CLOSED;
      this.onclose?.({ code: 1000, reason: '', wasClean: true });
    }
  }
  context.WebSocket = Socket;
  context.navigator.mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => { tracksStopped++; } }] }),
  };
  installAudioCaptureStub(context);
  const timeline: any[] = [];
  const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
    onResult: ({ text, last }: { text: string; last: boolean }) => timeline.push(['result', text, last]),
    onClose: () => timeline.push(['close']),
    onError: (error: Error) => timeline.push(['error', error.message]),
  });
  return { client, sockets, timeline, releaseFirst, tracksStopped: () => tracksStopped };
}

describe.each([
  ['desktop', path.join(__dirname, '../../src/renderer/modules/voice-input.js')],
])('%s compressed transcript ordering', (_platform, sourcePath) => {
  it('delivers partial then terminal text in wire order despite different decode completion times', async () => {
    const fixture = loadDelayedTranscript(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.sockets[0].receive('partial');
    fixture.sockets[0].receive('terminal', true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const whileFirstPending = [...fixture.timeline];
    fixture.releaseFirst();
    await vi.waitFor(() => expect(fixture.timeline).toHaveLength(2));
    expect(whileFirstPending).toEqual([]);
    expect(fixture.timeline).toEqual([['result', 'partial', false], ['result', 'terminal', true]]);
    fixture.client.close();
  });

  it.each([false, true])('delivers terminal before natural close with immediate device release (stopped=%s)', async (stopped) => {
    const fixture = loadDelayedTranscript(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    if (stopped) {
      fixture.client.stop();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    fixture.sockets[0].receive('terminal', true);
    fixture.sockets[0].close(); // The peer closes after sending its final frame.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const whilePending = [...fixture.timeline];
    expect(fixture.tracksStopped()).toBe(1);
    fixture.releaseFirst();
    await vi.waitFor(() => expect(fixture.timeline).toHaveLength(2));
    expect(whilePending).toEqual([]);
    expect(fixture.timeline).toEqual([['result', 'terminal', true], ['close']]);
  });

  it('starts a new recognition without reusing the previous connection transcript', async () => {
    const fixture = loadDelayedTranscript(sourcePath);
    fixture.releaseFirst();
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.sockets[0].receive('previous recognition', true);
    await vi.waitFor(() => expect(fixture.timeline).toContainEqual(['result', 'previous recognition', true]));
    fixture.client.close();
    await fixture.client.start();
    fixture.sockets[1].open();
    fixture.sockets[1].receive('', true);
    await vi.waitFor(() => expect(fixture.timeline).toHaveLength(3));
    expect(fixture.timeline[2]).toEqual(['result', '', true]);
    fixture.client.close();
  });

  it('discards an explicitly cancelled decode without blocking a replacement connection', async () => {
    const fixture = loadDelayedTranscript(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.sockets[0].receive('cancelled terminal', true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.client.close();
    await fixture.client.start();
    fixture.sockets[1].open();
    fixture.sockets[1].receive('new terminal', true);
    await vi.waitFor(() => expect(fixture.timeline).toContainEqual(['result', 'new terminal', true]));
    fixture.releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.timeline).toEqual([['close'], ['result', 'new terminal', true]]);
    fixture.client.close();
  });
});

describe.each([
  ['desktop', path.join(__dirname, '../../src/renderer/modules/voice-input.js')],
])('%s worklet capture ownership', (_platform, sourcePath) => {
  it('flushes the final partial 200ms packet before END and releases the microphone immediately', async () => {
    const fixture = loadWorkletCapture(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.nodes).toHaveLength(1);
    fixture.processSamples(3840); // Independently specified 240ms at16kHz.
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.client.stop();
    expect(fixture.tracksStopped()).toBe(1);
    await vi.waitFor(() => expect(fixture.sockets[0].frames.at(-1)).toBe('__END__'));
    const pcm = Buffer.concat(fixture.sockets[0].frames.filter(Buffer.isBuffer));
    const expected = Buffer.alloc(7680);
    for (let offset = 0; offset < expected.length; offset += 2) expected.writeInt16LE(0x1fff, offset);
    expect(pcm.length).toBe(7680);
    expect(pcm).toEqual(expected);
    expect(fixture.errors).toEqual([]);
    fixture.client.close();
  });

  it('does not create capture resources after a pending worklet load is stopped', async () => {
    const fixture = loadWorkletCapture(sourcePath, { delayedModule: true });
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.client.stop();
    fixture.releaseModule();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.nodes).toEqual([]);
    expect(fixture.errors).toEqual([]);
    expect(fixture.tracksStopped()).toBe(1);
    fixture.client.close();
  });

  it('releases a late permission grant after close without opening a recording socket', async () => {
    const fixture = loadWorkletCapture(sourcePath, { delayedPermission: true });
    const starting = fixture.client.start();
    fixture.client.close();
    fixture.grantPermission();
    await starting;
    expect(fixture.sockets).toEqual([]);
    expect(fixture.tracksStopped()).toBe(1);
    expect(fixture.errors).toEqual([]);
  });

  it('reports incomplete capture instead of END when the processor never acknowledges flush', async () => {
    const fixture = loadWorkletCapture(sourcePath, { dropFlush: true });
    await fixture.client.start();
    fixture.sockets[0].open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.processSamples(128);
    fixture.client.stop();
    const deadline = [...fixture.timers.values()].find((timer) => timer.delay === 1500);
    expect(deadline).toBeDefined();
    deadline!.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.sockets[0].frames).not.toContain('__END__');
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.errors[0].message).toBe('incomplete_capture');
    expect(fixture.tracksStopped()).toBe(1);
  });

  it('cancels a pending flush without a late END or an error after explicit close', async () => {
    const fixture = loadWorkletCapture(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.processSamples(128);
    fixture.client.stop();
    fixture.client.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.sockets[0].frames).not.toContain('__END__');
    expect(fixture.errors).toEqual([]);
    expect(fixture.tracksStopped()).toBe(1);
  });
});

describe.each([
  ['desktop', path.join(__dirname, '../../src/renderer/modules/voice-input.js')],
])('%s compressed audio transport', (_platform, sourcePath) => {
  it('keeps captured speech in order and sends END only after all accepted audio', async () => {
    const fixture = loadCompressedCapture(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.capture(0.25);
    fixture.capture(0.5);
    fixture.client.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const framesWhileFirstPending = [...fixture.sockets[0].frames];
    fixture.releaseFirst();
    await vi.waitFor(() => expect(fixture.sockets[0].frames).toHaveLength(4));

    expect(framesWhileFirstPending).toEqual([]);
    expect(fixture.decode(fixture.sockets[0].frames)).toEqual([
      [0xff, 0x1f], [0xff, 0x3f], [], '__END__',
    ]);
    expect(fixture.errors).toEqual([]);
    fixture.client.close();
  });

  it('discards compression owned by a closed socket without leaking it into a restarted connection', async () => {
    const fixture = loadCompressedCapture(sourcePath);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.capture(0.25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.client.close();
    await fixture.client.start();
    fixture.sockets[1].open();
    fixture.capture(0.5);
    await vi.waitFor(() => expect(fixture.sockets[1].frames).toHaveLength(1));
    fixture.releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.sockets[0].frames).toEqual([]);
    expect(fixture.decode(fixture.sockets[1].frames)).toEqual([[0xff, 0x3f]]);
    expect(fixture.errors).toEqual([]);
    fixture.client.close();
  });

  it('reports compression failure instead of sending raw PCM through a gzip connection', async () => {
    const fixture = loadCompressedCapture(sourcePath, true);
    await fixture.client.start();
    fixture.sockets[0].open();
    fixture.capture(0.25);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.errors).toHaveLength(1);
    expect(fixture.errors[0].message).toBe('synthetic gzip failure');
    expect(fixture.sockets[0].frames).toEqual([]);
    fixture.client.close();
  });
});

describe('voice capture interruption', () => {
  it('does not start capture when the user stops while the socket is connecting', async () => {
    const stoppedTracks: string[] = [];
    const opened: string[] = [];
    const errors: string[] = [];
    let socket: any;
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FakeWebSocket.CONNECTING;
      binaryType = '';
      onopen: Function | null = null;
      onmessage: Function | null = null;
      onerror: Function | null = null;
      onclose: Function | null = null;

      constructor(_url: string) {
        socket = this;
      }

      send() {}

      close() {
        // Chromium emits an error when a CONNECTING socket is closed by the
        // client. It must remain an intentional cancellation to the UI.
        this.onerror?.({ type: 'error' });
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code: 1000, reason: '', wasClean: true });
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }
    }

    const { context } = loadVoiceInput({
      createSession: async () => ({ ok: true, url: 'wss://example.test/asr' }),
    });
    context.WebSocket = FakeWebSocket;
    context.navigator.mediaDevices = {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: () => stoppedTracks.push('stopped') }],
      }),
    };
    // The close fallback is irrelevant to this deterministic socket and
    // should not keep the test process alive.
    context.setTimeout = () => 1;

    const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
      onOpen: () => opened.push('opened'),
      onError: (error: Error) => errors.push(error.message),
    });
    await client.start();
    client.stop();
    socket.open();

    expect(opened).toEqual([]);
    expect(errors).toEqual([]);
    expect(stoppedTracks).toEqual(['stopped']);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('settles once and releases a late microphone grant after an early stop', async () => {
    let grantMicrophone: Function = () => {};
    const stoppedTracks: string[] = [];
    const closed: string[] = [];
    const { context } = loadVoiceInput({
      createSession: async () => ({ ok: true, url: 'wss://example.test/asr' }),
    });
    context.navigator.mediaDevices = {
      getUserMedia: () => new Promise((resolve) => { grantMicrophone = resolve; }),
    };
    context.setTimeout = () => 1;

    const client = context.window.VoiceInput.createClient('wss://example.test/asr', {
      onClose: () => closed.push('closed'),
    });
    const starting = client.start();
    client.stop();
    grantMicrophone({
      getTracks: () => [{ stop: () => stoppedTracks.push('stopped') }],
    });
    await starting;

    expect(closed).toEqual(['closed']);
    expect(stoppedTracks).toEqual(['stopped']);
  });
});


// Controller tests keep ticket, microphone and socket boundaries deterministic;
// the capture/wire cases above own audio framing. No account or telemetry facade.
function controllerHarness(voiceOverrides: Record<string, unknown> = {}) {
  const voice = {
    createSession: vi.fn(async () => ({ ok: true, url: 'wss://example.test/asr?ticket=one-use' })),
    ensureMicrophoneAccess: vi.fn(async () => ({ ok: true, granted: true })),
    ...voiceOverrides,
  };
  const { context, alerts } = loadVoiceInput(voice);
  const sockets: any[] = [];
  const stopped = vi.fn();
  const send = vi.fn();
  const timers = new Map<number, Function>();
  let nextTimer = 0;
  context.setTimeout = (callback: Function) => { timers.set(++nextTimer, callback); return nextTimer; };
  context.clearTimeout = (id: number) => timers.delete(id);
  context.sendMessage = send;
  context.sendNewChat = send;
  const listeners: Record<string, Function> = {};
  const textarea = { ...makeTextarea(), value: 'Keep this draft', selectionStart: 15, selectionEnd: 15,
    addEventListener: (name: string, callback: Function) => { listeners[name] = callback; },
    dispatchEvent: vi.fn(),
  };
  let valid = true;
  const replacements: string[] = [];
  context.composerInsertion = () => {
    const from = textarea.selectionStart;
    let to = textarea.selectionEnd;
    let disposed = false;
    return {
      valid: () => valid && !disposed,
      replace(text: string) {
        if (!valid || disposed) return false;
        replacements.push(text);
        textarea.value = textarea.value.slice(0, from) + text + textarea.value.slice(to);
        to = from + text.length;
        return true;
      },
      dispose() { disposed = true; },
    };
  };
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    readyState = Socket.CONNECTING;
    onopen: Function | null = null; onmessage: Function | null = null;
    onerror: Function | null = null; onclose: Function | null = null;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = Socket.CLOSED; this.onclose?.({code:1000}); });
    constructor(readonly url: string) { sockets.push(this); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    result(text: string, last = false) { this.onmessage?.({data:JSON.stringify({result:{text,last}})}); }
    error(reason: string) { this.onmessage?.({data:JSON.stringify({event:'error',reason})}); }
  }
  context.WebSocket = Socket;
  const capture = vi.fn(async () => ({getTracks: () => [{stop:stopped}]}));
  context.navigator.mediaDevices = {getUserMedia:capture};
  installAudioCaptureStub(context);
  const button = makeButton('chat-mic-btn');
  context.window.VoiceInput.attach(button, textarea);
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const start = async () => { button.click(); await settle(); };
  const ownerChange = () => listeners['composer-owner-change']?.();
  return { context, voice, alerts, button, textarea, sockets, capture, stopped, send,
    replacements, timers, start, settle, ownerChange, invalidate: () => { valid = false; } };
}

describe('voice input controller ticket and composer ownership', () => {
  it('requests an API key without capturing audio or changing the draft', async () => {
    const h = controllerHarness({createSession:vi.fn(async () => ({ok:false,error:'E_ORKAS_API_KEY_REQUIRED'}))});
    await h.start();
    expect(h.alerts).toEqual(['Enter an API Key first.']);
    expect(h.voice.ensureMicrophoneAccess).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.sockets).toEqual([]);
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('honors microphone preflight denial before capture and leaves the draft editable', async () => {
    const h = controllerHarness({ensureMicrophoneAccess:vi.fn(async () => ({ok:false,granted:false}))});
    await h.start();
    expect(h.alerts).toEqual(['Microphone access was blocked. Allow it in your system settings to use voice input.']);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.sockets).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
  });

  it('reports rejected ticket requests without exposing server errors or consuming the draft', async () => {
    const h = controllerHarness({createSession:vi.fn(async () => { throw new Error('private-ticket-url-and-key'); })});
    await h.start();
    expect(h.alerts).toEqual(['Voice input is unavailable right now.']);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
  });

  it('cancels a pending ticket and permits a new attempt while the old response is outstanding', async () => {
    let resolveTicket: Function = () => {};
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveTicket = resolve; }))
      .mockResolvedValue({ok:true,url:'wss://example.test/asr?ticket=new'});
    const h = controllerHarness({createSession:request});
    await h.start();
    h.button.click();
    expect(h.button.dataset.voicePhase).toBe('idle');
    await h.start();
    expect(h.sockets).toHaveLength(1);
    resolveTicket({ok:true,url:'wss://example.test/asr?ticket=stale'});
    await h.settle();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toContain('ticket=new');
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('connecting');
    expect(h.alerts).toEqual([]);
    h.ownerChange();
  });

  it('abandons pending microphone preflight when the user stops', async () => {
    let allow: Function = () => {};
    const h = controllerHarness({ensureMicrophoneAccess:vi.fn(() => new Promise(resolve => {allow=resolve;}))});
    await h.start();
    h.button.click();
    allow({ok:true,granted:true});
    await h.settle();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.sockets).toEqual([]);
    expect(h.alerts).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
  });

  it('does not attach an outstanding ticket to a new composer owner', async () => {
    let resolveTicket: Function = () => {};
    const h = controllerHarness({createSession:vi.fn(() => new Promise(resolve => {resolveTicket=resolve;}))});
    await h.start();
    h.ownerChange();
    h.textarea.value = 'Other task draft';
    resolveTicket({ok:true,url:'wss://example.test/asr?ticket=stale'});
    await h.settle();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.sockets).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Other task draft');
  });

  it('closes recording on owner changes and ignores late transcripts', async () => {
    const h = controllerHarness();
    await h.start();
    const socket = h.sockets[0]; socket.open();
    h.ownerChange();
    h.textarea.value = 'New owner draft';
    socket.result('stale transcript', true);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.replacements).toEqual([]);
    expect(h.textarea.value).toBe('New owner draft');
    expect(h.timers.size).toBe(0);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('ignores a prior socket close while a later attempt is connecting', async () => {
    const h = controllerHarness();
    await h.start();
    const old = h.sockets[0];
    h.button.click();
    await h.start();
    const current = h.sockets[1];
    old.onclose?.({code:1000});
    expect(h.button.dataset.voicePhase).toBe('connecting');
    expect(current.close).not.toHaveBeenCalled();
    expect(h.alerts).toEqual([]);
    current.open();
    expect(h.button.dataset.voicePhase).toBe('recording');
    h.ownerChange();
  });

  it('recovers from socket handshake failure with no raw ticket error in the UI', async () => {
    const h = controllerHarness();
    await h.start();
    h.sockets[0].onerror?.({type:'error',message:'private-ticket'});
    expect(h.alerts).toEqual(['Voice input is unavailable right now.']);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.sockets[0].close).toHaveBeenCalledTimes(1);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.textarea.value).toBe('Keep this draft');
  });

  it.each([['session_expired','Enter an API Key first.'],
    ['insufficient_quota','Not enough credits for voice input.']])('keeps %s failures recoverable without sending', async (reason,message) => {
    const h = controllerHarness();
    await h.start(); h.sockets[0].open(); h.sockets[0].error(reason);
    expect(h.alerts).toEqual([message]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.timers.size).toBe(0);
    expect(h.textarea.value).toBe('Keep this draft');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('retains a partial transcript for review if the socket closes before a terminal result', async () => {
    const h = controllerHarness();
    await h.start(); const socket = h.sockets[0]; socket.open();
    socket.result('partial words');
    socket.close(); await h.settle();
    expect(h.textarea.value).toBe('Keep this draft partial words');
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.textarea.dispatchEvent).not.toHaveBeenCalled();
  });

  it('replaces the owned transcript range and keeps final words for explicit send', async () => {
    const h = controllerHarness();
    await h.start(); const socket = h.sockets[0]; socket.open();
    socket.result('first words');
    h.button.click();
    expect(h.button.dataset.voicePhase).toBe('finalizing');
    socket.result('corrected final words',true); await h.settle();
    expect(h.textarea.value).toBe('Keep this draft corrected final words');
    expect(h.replacements).toEqual([' first words',' corrected final words']);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.textarea.dispatchEvent).not.toHaveBeenCalled();
    expect(h.alerts).toEqual([]);
  });

  it('does not overwrite a range invalidated by an intervening user edit', async () => {
    const h = controllerHarness();
    await h.start(); const socket = h.sockets[0]; socket.open();
    h.invalidate(); h.textarea.value = 'Manually corrected draft';
    socket.result('late words',true);
    expect(h.textarea.value).toBe('Manually corrected draft');
    expect(h.replacements).toEqual([]);
    expect(h.button.dataset.voicePhase).toBe('idle');
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });
});
