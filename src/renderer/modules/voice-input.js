// API-key voice input. Audio capture and editor transactions follow the shared composer.
(function () {
  'use strict';


  const VOICE_MAX_DURATION_MS = 120 * 1000;
  const voiceLog = (() => {
    try { return typeof createLogger === 'function' ? createLogger('voice-input') : null; } catch { return null; }
  })();

  function _errorInfo(e) { return { name: String(e && e.name || 'Error') }; }

  // ── Low-level streaming-ASR client (VolcEngine binary protocol). ──────────
  // Ported from the AIBase web client; the wire framing matches the Server
  // proxy's `biz/voice/asr.py`.
  class AsrClient {
    constructor(wsUrl, callbacks) {
      this._url = wsUrl;
      this._cb = callbacks || {};
      this._ws = null;
      this._running = false;
      this._pendingClose = false;
      this._cancelledBeforeOpen = false;
      this._lastText = '';
      this._audioCtx = null;
      this._mediaStream = null;
      this._source = null;
      this._workletNode = null;
      this._scriptNode = null;
      this._captureNode = null;
      this._workletModuleURL = null;
      this._silentGain = null;
      this._inRate = 0;
      this._chunkMs = 200;
      this._chunkFrames = 0;
      this._useGzip = false;
      this._connectTimer = null;
      this._finishTimer = null;
      this._closeEmitted = false;
    }

    emit(name, ...args) {
      const fn = this._cb[name];
      if (typeof fn === 'function') {
        try { fn(...args); } catch (e) { /* renderer callback threw */ }
      }
    }

    connectUrl() {
      try {
        const u = new URL(this._url);
        u.searchParams.set('encoding', this._useGzip ? 'gzip' : 'raw');
        return u.toString();
      } catch {
        return this._url + (this._url.includes('?') ? '&' : '?') + 'encoding=' + (this._useGzip ? 'gzip' : 'raw');
      }
    }

    async start() {
      if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;
      // Acquire the mic FIRST so a permission denial fails before we open the
      // socket (cleaner than tearing down a live WS in the error path).
      let mediaStream;
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        try { if (voiceLog) voiceLog.error('getUserMedia failed', _errorInfo(e)); } catch {}
        this.emit('onError', e);
        return;
      }
      if (this._pendingClose) {
        try { mediaStream.getTracks().forEach((tr) => { try { tr.stop(); } catch {} }); } catch {}
        this.emitCloseOnce();
        return;
      }
      this._mediaStream = mediaStream;
      let ws;
      try {
        if (typeof this._url === 'function') this._url = await this._url();
        if (this._pendingClose) { this.teardownCapture(); return; }
        ws = new WebSocket(this.connectUrl());
      } catch (e) {
        try { if (voiceLog) voiceLog.error('ASR websocket constructor failed', _errorInfo(e)); } catch {}
        this.teardownCapture();
        this.emit('onError', e);
        return;
      }
      this._ws = ws;
      this._connectTimer = setTimeout(() => { this.emit('onError', Object.assign(new Error(), { code: 'network' })); this.close(); }, 60_000);
      this._cancelledBeforeOpen = false;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        // stop() can run while the browser is still negotiating the socket.
        // In that case opening is only a transport completion, not fresh user
        // consent to start recording. Close immediately and never reacquire
        // capture resources that stop() has already released.
        if (this._pendingClose) {
          this._running = false;
          this.teardownCapture();
          try { this.close(); } catch {}
          return;
        }
        try { if (voiceLog) voiceLog.info('ASR websocket open'); } catch {}
        this._running = true;
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') { this.handleJSON(ev.data); return; }
        this.emit('onError', Object.assign(new Error(), { code: 'protocol_error' }));
      };
      ws.onerror = (e) => {
        // Chromium reports close() on a CONNECTING socket through onerror.
        // That is the expected result of the user's explicit cancellation,
        // not an ASR outage that should surface an error dialog.
        if (this._cancelledBeforeOpen) return;
        try { if (voiceLog) voiceLog.error('ASR websocket error', _errorInfo(e)); } catch {}
        // Browser WebSocket error events intentionally omit the HTTP handshake
        // status and usually have no name/message. Preserve a stable,
        // actionable transport category instead of reporting `unknown`.
        const err = new Error('websocket_error');
        err.name = 'WebSocketError';
        err.cause = e;
        this.emit('onError', err);
      };
      ws.onclose = (ev) => {
        try { if (voiceLog) voiceLog.info('ASR websocket close', { code: ev && ev.code, wasClean: ev && ev.wasClean }); } catch {}
        this._running = false;
        this._pendingClose = false;
        this.teardownCapture();
        this.emitCloseOnce();
      };
    }

    handleJSON(s) {
      let obj;
      try { obj = JSON.parse(String(s || '{}')); } catch { return; }
      if (obj && obj.event === 'ready') {
        if (!this._running || this._pendingClose || this._captureStarted) return;
        this._captureStarted = true;
        clearTimeout(this._connectTimer);
        this.emit('onOpen');
        this.startCapture();
        return;
      }
      if (obj && obj.event === 'timeout') {
        const err = Object.assign(new Error(), { code: 'timeout' });
        err.maxSeconds = Number(obj.max_seconds || obj.maxSeconds || 0) || undefined;
        this.emit('onError', err);
        this._running = false;
        this._pendingClose = false;
        return;
      }
      if (obj && obj.event === 'error') {
        const err = Object.assign(new Error(), { code: String(obj.reason || 'unavailable') });
        try { if (voiceLog) voiceLog.warn('ASR server rejected voice input'); } catch {}
        this.emit('onError', err);
        this._running = false;
        this._pendingClose = false;
        return;
      }
      const body = (obj && (obj.payload_msg || obj.body)) || obj || {};
      const result = body.result || body.data || {};
      const text = String(result.text || result.punctuated_text || '');
      this._lastText = text || this._lastText;
      const isLast = !!((obj && obj.is_last_package) || result.last);
      this.emit('onResult', { text: this._lastText, last: isLast });
      if (isLast) {
        this._running = false;
        if (this._pendingClose) { try { this.close(); } catch {} }
      }
    }

    sendAudio(bytes, last) {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        if (this._ws.bufferedAmount > 256 * 1024) {
          this.emit('onError', Object.assign(new Error(), { code: 'network' }));
          this.close(); return;
        }
        try { this._ws.send(bytes); if (last) this._ws.send('__END__'); }
        catch { this.emit('onError', Object.assign(new Error(), { code: 'network' })); }
      }
      if (last) this._running = false;
    }

    async startCapture() {
      if (!this._running) return;
      try {
        const ms = this._mediaStream;
        if (!ms) throw new Error('no_media_stream');
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this._audioCtx = new Ctx();
        try { if (this._audioCtx.state === 'suspended') await this._audioCtx.resume(); } catch {}
        if (!this._running) return;
        this._source = this._audioCtx.createMediaStreamSource(ms);
        this._inRate = this._audioCtx.sampleRate || 48000;
        this._chunkFrames = Math.max(1, Math.floor((this._inRate * this._chunkMs) / 1000));
        let captureReady = false;
        if (this._audioCtx.audioWorklet && typeof window.AudioWorkletNode === 'function') {
          let url = '';
          try {
            const code = `class C extends AudioWorkletProcessor{constructor(){super();this.n=1024;this.b=new Float32Array(this.n);this.i=0;this.port.onmessage=e=>{const d=e.data||{};if(typeof d.n==='number'&&d.n>0){this.n=d.n|0;this.b=new Float32Array(this.n);this.i=0;}};}process(inp,out){const a=inp&&inp[0]&&inp[0][0];const o=out&&out[0]&&out[0][0];if(o){for(let i=0;i<o.length;i++)o[i]=0;}if(!a||a.length===0)return true;for(let i=0;i<a.length;i++){this.b[this.i++]=a[i];if(this.i>=this.n){const c=new Float32Array(this.b);this.port.postMessage({b:c},[c.buffer]);this.i=0;}}return true;}}registerProcessor('orkas-asr-capture',C);`;
            const blob = new Blob([code], { type: 'application/javascript' });
            url = URL.createObjectURL(blob);
            this._workletModuleURL = url;
            await this._audioCtx.audioWorklet.addModule(url);
            this._workletNode = new AudioWorkletNode(this._audioCtx, 'orkas-asr-capture', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            });
            this._workletNode.port.onmessage = (ev) => {
              const buf = ev.data && ev.data.b;
              if (!buf) return;
              const f32 = buf instanceof Float32Array ? buf : new Float32Array(buf);
              this.sendAudio(this.resampleTo16k(f32, this._inRate), false);
            };
            try { this._workletNode.port.postMessage({ n: this._chunkFrames }); } catch {}
            this._source.connect(this._workletNode);
            this._captureNode = this._workletNode;
            captureReady = true;
          } catch (workletError) {
            try { if (voiceLog) voiceLog.warn('AudioWorklet capture failed; falling back to ScriptProcessor', _errorInfo(workletError)); } catch {}
            try { if (this._workletNode) this._workletNode.disconnect(); } catch {}
            this._workletNode = null;
            if (this._workletModuleURL) { try { URL.revokeObjectURL(this._workletModuleURL); } catch {} this._workletModuleURL = null; }
            else if (url) { try { URL.revokeObjectURL(url); } catch {} }
          }
        } else {
          try { if (voiceLog) voiceLog.warn('AudioWorklet unavailable; using ScriptProcessor fallback'); } catch {}
        }
        if (!captureReady) {
          const mk = this._audioCtx.createScriptProcessor || this._audioCtx.createJavaScriptNode;
          if (typeof mk !== 'function') throw new Error('audio_capture_unsupported');
          const node = mk.call(this._audioCtx, 4096, 1, 1);
          node.onaudioprocess = (ev) => {
            const ch = ev.inputBuffer.getChannelData(0);
            this.sendAudio(this.resampleTo16k(ch, this._inRate), false);
          };
          this._source.connect(node);
          this._scriptNode = node;
          this._captureNode = node;
        }
        // Capture-node output must reach the destination or process()/onaudioprocess
        // won't be pumped — route it through a muted gain so nothing is audible.
        this._silentGain = this._audioCtx.createGain();
        try { this._silentGain.gain.value = 0; } catch {}
        this._captureNode.connect(this._silentGain);
        this._silentGain.connect(this._audioCtx.destination);
      } catch (e) {
        try { if (voiceLog) voiceLog.error('audio capture start failed', _errorInfo(e)); } catch {}
        this.emit('onError', e);
      }
    }

    teardownCapture() {
      try { if (this._workletNode) this._workletNode.port.onmessage = null; } catch {}
      try { if (this._scriptNode) this._scriptNode.onaudioprocess = null; } catch {}
      try { if (this._workletNode) this._workletNode.disconnect(); } catch {}
      try { if (this._scriptNode) this._scriptNode.disconnect(); } catch {}
      try { if (this._source) this._source.disconnect(); } catch {}
      try { if (this._silentGain) this._silentGain.disconnect(); } catch {}
      try { if (this._audioCtx) { const p = this._audioCtx.close(); if (p && p.then) p.then(() => {}).catch(() => {}); } } catch {}
      this._workletNode = null;
      this._scriptNode = null;
      this._captureNode = null;
      this._source = null;
      this._silentGain = null;
      this._audioCtx = null;
      if (this._workletModuleURL) { try { URL.revokeObjectURL(this._workletModuleURL); } catch {} this._workletModuleURL = null; }
      if (this._mediaStream) {
        try { this._mediaStream.getTracks().forEach((tr) => { try { tr.stop(); } catch {} }); } catch {}
      }
      this._mediaStream = null;
    }

    emitCloseOnce() {
      clearTimeout(this._connectTimer);
      clearTimeout(this._finishTimer);
      if (this._closeEmitted) return;
      this._closeEmitted = true;
      this._running = false;
      this.emit('onClose');
    }

    resampleTo16k(f32, inRate) {
      const rate = Math.max(1, inRate || 48000);
      const ratio = rate / 16000;
      const outLen = Math.max(1, Math.floor(f32.length / ratio));
      const u8 = new Uint8Array(outLen * 2);
      const dv = new DataView(u8.buffer);
      for (let i = 0; i < outLen; i++) {
        let s = f32[Math.floor(i * ratio)] || 0;
        if (s > 1) s = 1; else if (s < -1) s = -1;
        dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return u8;
    }

    stop() {
      this.teardownCapture();
      this._running = false;
      this._pendingClose = true;
      if (!this._ws) {
        this.emitCloseOnce();
        return;
      }
      this._cancelledBeforeOpen = this._ws.readyState === WebSocket.CONNECTING;
      try { this.sendAudio(new Uint8Array(0), true); } catch {}
      // Bound finalization without dropping slower terminal responses immediately.
      try {
        this._finishTimer = setTimeout(() => { if (this._pendingClose) { try { this.close(); } catch {} } }, 10_000);
      } catch {}
    }

    close() {
      clearTimeout(this._connectTimer);
      clearTimeout(this._finishTimer);
      this._pendingClose = true;
      this._running = false;
      this.teardownCapture();
      const ws = this._ws;
      this._ws = null;
      try { if (ws) ws.close(); } catch {}
      this.emitCloseOnce();
    }
  }


  let active = null;
  let introShown = false;
  const tr = (key) => t('chat.mic_' + key);
  const invoke = (name) => window.orkas.invoke('voice.' + name);

  async function openKeySettings(create) {
    if (typeof loadRendererFeature === 'function') await loadRendererFeature('settings');
    setView('settings');
    if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
    const input = document.getElementById('settings-orkas-api-key-input');
    input?.scrollIntoView?.({ block: 'center' });
    input?.focus();
    if (create) document.getElementById('settings-orkas-api-create-key')?.click();
  }

  async function guidance(code) {
    if (['api_key_required', 'invalid_api_key', 'insufficient_scope', 'unauthorized'].includes(code)) {
      const message = code === 'api_key_required' ? 'key_required' : code === 'insufficient_scope' ? 'scope_required' : 'invalid_key';
      const choice = await uiChoice({ title: tr('title'), message: tr(message),
        choices: [{ id: 'configure', label: t('settings.orkas_api.configure') }],
        leadingChoices: [{ id: 'create', label: t('settings.orkas_api.create_key'), style: '' }] });
      if (choice) await openKeySettings(choice === 'create');
      return;
    }
    if (code === 'insufficient_quota') {
      const choice = await uiChoice({ title: tr('title'), message: tr('insufficient_credits'),
        choices: [{ id: 'credits', label: tr('manage_credits') }] });
      if (choice === 'credits') {
        const url = new URL('https://orkas.ai/views/account/account.html');
        url.searchParams.set('lang', typeof getLang === 'function' ? getLang() : 'en');
        const result = await window.orkas.invoke('auth.openExternal', { url: url.toString() });
        if (!result?.ok) await uiAlert(tr('error_unavailable'));
      }
      return;
    }
    const errors = { NotAllowedError: 'error_permission', SecurityError: 'error_permission',
      NotFoundError: 'error_no_device', DevicesNotFoundError: 'error_no_device',
      NotReadableError: 'error_busy', TrackStartError: 'error_busy', restricted: 'error_restricted',
      network: 'error_unavailable', rate_limit_exceeded: 'rate_limited', empty_transcript: 'empty',
      incomplete_transcript: 'incomplete', timeout: 'limit_reached' };
    await uiAlert(tr(errors[code] || 'error_unavailable').replace('{seconds}', '120'));
  }

  function attach(button, editor) {
    if (!button || !editor || button.dataset.voiceBound === '1') return;
    button.dataset.voiceBound = '1';
    let attempt = null;
    let phase = 'idle';
    const phaseText = document.createElement ? document.createElement('span') : null;
    if (phaseText) {
      phaseText.className = 'chat-mic-status'; phaseText.setAttribute('role', 'status');
      phaseText.setAttribute('aria-live', 'polite'); phaseText.hidden = true;
      button.parentNode?.insertBefore(phaseText, button);
    }
    function paint(next) {
      phase = next;
      button.dataset.voicePhase = phase;
      button.classList.toggle('is-recording', phase === 'recording');
      button.classList.toggle('is-busy', phase === 'connecting' || phase === 'finalizing');
      button.title = tr(phase === 'idle' ? 'title' : phase === 'finalizing' ? 'finalizing' : 'stop_title');
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(phase === 'recording'));
      if (phaseText) {
        phaseText.hidden = phase === 'idle';
        phaseText.textContent = phase === 'recording' ? tr('recording') + ' ' + new Date(Date.now() - attempt.started).toISOString().slice(14, 19)
          : tr(phase === 'finalizing' ? 'finalizing' : 'connecting');
      }
    }
    function reset(current) {
      clearTimeout(current.limit); clearInterval(current.timer);
      current.insertion?.dispose();
      if (attempt !== current) return;
      attempt = null;
      if (active === cancel) active = null;
      paint('idle');
    }
    function cancel() {
      if (!attempt) return;
      const current = attempt;
      reset(current);
      current.client?.close();
    }
    async function refreshHint() {
      if (phase !== 'idle') return;
      try {
        const status = await invoke('status');
        if (phase !== 'idle' || !status?.ok) return;
        button.title = tr(status.configured ? 'title' : 'key_required');
        button.setAttribute('aria-label', button.title);
      } catch { /* The click path reports a recoverable status failure. */ }
    }
    button.addEventListener('mouseenter', refreshHint);
    button.addEventListener('focus', refreshHint);
    editor.addEventListener('composer-owner-change', cancel);
    window.addEventListener('beforeunload', cancel);
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && attempt) cancel(); });
    window.addEventListener('i18n-change', () => paint(phase));

    async function start() {
      if (active) active();
      const current = { client: null, insertion: composerInsertion(editor), started: 0, limit: null, timer: null, terminal: false, text: '', stopped: false };
      attempt = current; active = cancel; paint('connecting');
      const before = composerText(editor).slice(0, composerSelection(editor).start);
      try {
        const status = await invoke('status');
        if (attempt !== current) return;
        if (!status?.ok) { reset(current); await guidance('unavailable'); return; }
        if (!status.configured) { reset(current); await guidance('api_key_required'); return; }
        if (!introShown) {
          const agreed = await uiConfirm({ message: tr('intro'), okLabel: tr('start') });
          if (attempt !== current) return;
          if (!agreed) { cancel(); return; }
          introShown = true;
        }
        const permission = await invoke('ensureMicrophoneAccess');
        if (attempt !== current) return;
        if (!permission?.ok || !permission.granted) {
          reset(current); await guidance(permission?.status === 'restricted' ? 'restricted' : 'NotAllowedError'); return;
        }
        const client = new AsrClient(async () => {
          const session = await invoke('createSession');
          if (!session?.ok || !session.url) throw Object.assign(new Error(), { code: session?.code || 'unavailable' });
          return session.url;
        }, {
          onOpen() {
            if (attempt !== current) { client.close(); return; }
            current.started = Date.now(); paint('recording');
            current.timer = setInterval(() => {
              if (attempt !== current) return;
              if (editor.getClientRects().length === 0) { cancel(); return; }
              paint(phase);
            }, 1000);
            current.limit = setTimeout(() => {
              if (attempt !== current) return;
              uiToast(tr('limit_reached').replace('{seconds}', '120'));
              stop();
            }, VOICE_MAX_DURATION_MS);
          },
          onResult({ text, last }) {
            if (attempt !== current) return;
            if (text && !current.insertion.replace((before && !/\s$/.test(before) ? ' ' : '') + text)) { cancel(); return; }
            current.text = text;
            if (last) { current.terminal = true; reset(current); client.close(); if (!text.trim()) guidance('empty_transcript'); }
          },
          onError(error) {
            if (attempt !== current) { client.close(); return; }
            reset(current); client.close(); guidance(error?.code || error?.name || 'unavailable');
          },
          onClose() {
            if (attempt !== current) return;
            reset(current);
            if (!current.terminal) guidance('incomplete_transcript');
          },
        });
        current.client = client;
        await client.start();
      } catch {
        if (attempt !== current) return;
        cancel(); await guidance('unavailable');
      }
    }
    function stop() {
      if (!attempt || phase === 'finalizing') return;
      if (phase === 'connecting') { cancel(); return; }
      clearTimeout(attempt.limit);
      paint('finalizing');
      attempt.client.stop();
    }
    button.addEventListener('click', () => { if (attempt) stop(); else start(); });
    paint('idle');
  }
  window.VoiceInput = { attach, cancel: () => active?.(), createClient: (url, callbacks) => new AsrClient(url, callbacks) };
  document.addEventListener('DOMContentLoaded', () => {
    for (const [button, input] of [['new-chat-mic-btn', 'new-chat-input'], ['chat-mic-btn', 'chat-input'],
      ['project-chat-mic-btn', 'project-chat-input'], ['auto-mic-btn', 'auto-task-input']]) {
      attach(document.getElementById(button), document.getElementById(input));
    }
  });
})();
