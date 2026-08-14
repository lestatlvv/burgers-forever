/**
 * Assistive speech engine for the kiosk PoC.
 *
 * At app start: synthesize every known phrase (Kokoro TTS when available),
 * cache audio blobs in memory + IndexedDB, then play from cache on demand.
 * Falls back to speechSynthesis when the TTS service is unreachable.
 *
 * Playback policy:
 * - Finish the current announcement; a newer phrase waits (latest pending only).
 * - Interrupt only when the customer presses a logical pad/keyboard button
 *   (UP/DOWN/LEFT/RIGHT/SELECT/VOLUME via `kb-command` / interrupt()).
 */
(function () {
  'use strict';

  var DEFAULTS = {
    ttsUrl: 'http://127.0.0.1:7860',
    voice: 'af_heart',
    speed: 1.05,
    enabled: true,
    dbName: 'kiosk-speech-v1',
    storeName: 'clips'
  };

  var cfg = Object.assign({}, DEFAULTS, window.KIOSK_SPEECH || {});
  var memory = Object.create(null); // phrase -> object URL
  var memoryBuffers = Object.create(null); // phrase -> ArrayBuffer (wav bytes)
  var ready = false;
  var readyPromise = null;
  var backend = 'none'; // 'kokoro' | 'speechSynthesis' | 'none'
  var playGen = 0;
  var currentAudio = null;
  var currentSource = null; // AudioBufferSourceNode when playing via AudioContext
  var currentUtterance = null;
  var dbPromise = null;
  var unlocked = false;
  var playing = false;
  var pendingParts = null; // string[] | null
  var currentText = null; // joined key of active sequence / phrase
  var sequence = null; // { parts, index, gen, key }
  var warmQueue = Promise.resolve();
  var generateInFlight = 0;
  var warmStatus = 'idle'; // 'idle' | 'warming' | 'warmed'
  var connectionStatus = 'unknown'; // 'unknown' | 'connected' | 'no-connection'
  var statusEl = null;
  var connectionProbeTimer = null;
  var HEALTH_POLL_MS = 15000;

  function log() {
    if (window.console && console.info) {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[speech]');
      console.info.apply(console, args);
    }
  }

  /** Service-tech HUD: small corner labels (readable for techs, not customer UI). */
  function ensureStatusHud() {
    if (statusEl) return statusEl;
    if (!document.body) return null;
    statusEl = document.createElement('div');
    statusEl.id = 'kiosk-tts-status';
    statusEl.className = 'kiosk-tts-status';
    statusEl.setAttribute('aria-hidden', 'true');
    // Inline fallback so the chip stays visible even if CSS cache is stale.
    statusEl.setAttribute(
      'style',
      'position:fixed;left:8px;bottom:18px;z-index:2147483646;display:inline-flex;' +
        'align-items:center;gap:3px;padding:2px 5px;border:0;border-radius:0;' +
        'background:transparent;color:rgba(30,32,38,0.55);' +
        'font:500 12px/1.2 ui-monospace,Consolas,monospace;white-space:nowrap;' +
        'pointer-events:none;user-select:none;box-shadow:none;'
    );
    statusEl.innerHTML =
      '<span class="kiosk-tts-status__conn" data-role="connection"></span>' +
      '<span class="kiosk-tts-status__warm" data-role="warmup"></span>';
    document.body.appendChild(statusEl);
    renderStatusHud();
    if (window.KioskAudioOutput && typeof window.KioskAudioOutput.mountStatusControl === 'function') {
      window.KioskAudioOutput.mountStatusControl();
    }
    return statusEl;
  }

  /** Route <audio> / AudioContext to the tech-selected output device when configured. */
  function applyOutputSink(audioEl) {
    if (window.KioskAudioOutput && typeof window.KioskAudioOutput.applyToElement === 'function') {
      return window.KioskAudioOutput.applyToElement(audioEl);
    }
    return Promise.resolve(false);
  }

  function hasCustomSink() {
    if (window.KioskAudioOutput && typeof window.KioskAudioOutput.hasCustomSink === 'function') {
      return window.KioskAudioOutput.hasCustomSink();
    }
    return !!(
      window.KioskAudioOutput &&
      typeof window.KioskAudioOutput.getSinkId === 'function' &&
      (window.KioskAudioOutput.getSinkId() ||
        (window.KioskAudioOutput.getSinkLabel && window.KioskAudioOutput.getSinkLabel()))
    );
  }

  function prepareOutputRoute() {
    if (
      window.KioskAudioOutput &&
      typeof window.KioskAudioOutput.prepareForPlayback === 'function'
    ) {
      return window.KioskAudioOutput.prepareForPlayback();
    }
    return Promise.resolve(false);
  }

  function stopRoutedOutput() {
    if (window.KioskAudioOutput && typeof window.KioskAudioOutput.stopRouted === 'function') {
      window.KioskAudioOutput.stopRouted();
    }
  }

  function connectionLabel() {
    if (connectionStatus === 'connected') return '🟢';
    if (connectionStatus === 'no-connection') return '🔴';
    return '⚪';
  }

  function warmLabel() {
    if (warmStatus === 'warming') return '⏳';
    if (warmStatus === 'warmed') return '✓';
    return '–';
  }

  function renderStatusHud() {
    if (!statusEl) return;
    var conn = statusEl.querySelector('[data-role="connection"]');
    var warm = statusEl.querySelector('[data-role="warmup"]');
    if (conn) {
      conn.textContent = connectionLabel();
      conn.setAttribute('data-state', connectionStatus);
    }
    if (warm) {
      warm.textContent = warmLabel();
      warm.setAttribute('data-state', warmStatus);
    }
    statusEl.setAttribute('data-connection', connectionStatus);
    statusEl.setAttribute('data-warmup', warmStatus);
  }

  function setConnectionStatus(next) {
    if (connectionStatus === next) return;
    connectionStatus = next;
    renderStatusHud();
    window.dispatchEvent(
      new CustomEvent('tts-status', {
        detail: { connection: connectionStatus, warmup: warmStatus }
      })
    );
  }

  function setWarmStatus(next) {
    if (warmStatus === next) return;
    warmStatus = next;
    renderStatusHud();
    window.dispatchEvent(
      new CustomEvent('tts-status', {
        detail: { connection: connectionStatus, warmup: warmStatus }
      })
    );
  }

  function beginGenerate() {
    generateInFlight += 1;
    setWarmStatus('warming');
  }

  function endGenerate() {
    generateInFlight = Math.max(0, generateInFlight - 1);
    if (generateInFlight === 0) {
      // Stay on "warming up" until the warmup/ensure batch marks ready.
      setWarmStatus(ready ? 'warmed' : 'warming');
    }
  }

  function scheduleConnectionProbe() {
    if (connectionProbeTimer) clearInterval(connectionProbeTimer);
    if (!cfg.enabled) return;
    connectionProbeTimer = setInterval(function () {
      probeKokoro().then(function (ok) {
        setConnectionStatus(ok ? 'connected' : 'no-connection');
        if (ok && backend !== 'kokoro') {
          backend = 'kokoro';
          log('backend recovered → kokoro');
        } else if (!ok && backend === 'kokoro') {
          backend = window.speechSynthesis ? 'speechSynthesis' : 'none';
          log('backend lost kokoro →', backend);
        }
      });
    }, HEALTH_POLL_MS);
  }

  function isBusy() {
    if (playing) return true;
    if (window.speechSynthesis && window.speechSynthesis.speaking) return true;
    return false;
  }

  /** Browsers block audio until a user gesture — unlock on first key/pointer. */
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    prepareOutputRoute().catch(function () {
      /* ignore */
    });
    try {
      var silent = new Audio(
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='
      );
      silent.volume = 0.01;
      applyOutputSink(silent).then(function () {
        return silent.play();
      }).catch(function () {
        /* ignore */
      });
    } catch (e) {
      /* ignore */
    }
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.resume();
      } catch (e2) {
        /* ignore */
      }
    }
  }

  function bindUnlock() {
    var once = function () {
      unlock();
      window.removeEventListener('keydown', once, true);
      window.removeEventListener('pointerdown', once, true);
      window.removeEventListener('kb-activity', once);
    };
    window.addEventListener('keydown', once, true);
    window.addEventListener('pointerdown', once, true);
    window.addEventListener('kb-activity', once);
  }

  /** Pad/keyboard button → stop current clip so the new action can speak now. */
  function bindButtonInterrupt() {
    // Prefer KeyboardNav.command() which calls interrupt() directly.
    // Also listen for adapters that only emit kb-command.
    window.addEventListener('kb-command', function (event) {
      var detail = event.detail || {};
      if (detail.speechHandled) return;
      interrupt();
    });
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    if (!window.indexedDB) {
      dbPromise = Promise.resolve(null);
      return dbPromise;
    }
    dbPromise = new Promise(function (resolve) {
      try {
        var req = indexedDB.open(cfg.dbName, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(cfg.storeName)) {
            db.createObjectStore(cfg.storeName);
          }
        };
        req.onsuccess = function () {
          resolve(req.result);
        };
        req.onerror = function () {
          resolve(null);
        };
      } catch (e) {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function cacheKey(text) {
    return cfg.voice + '|' + cfg.speed + '|' + text;
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(cfg.storeName, 'readonly');
          var req = tx.objectStore(cfg.storeName).get(key);
          req.onsuccess = function () {
            resolve(req.result || null);
          };
          req.onerror = function () {
            resolve(null);
          };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  function idbPut(key, buffer) {
    return openDb().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(cfg.storeName, 'readwrite');
          tx.objectStore(cfg.storeName).put(buffer, key);
          tx.oncomplete = function () {
            resolve();
          };
          tx.onerror = function () {
            resolve();
          };
        } catch (e) {
          resolve();
        }
      });
    });
  }

  function rememberBlob(text, blob, buffer) {
    if (memory[text]) {
      try {
        URL.revokeObjectURL(memory[text]);
      } catch (e) {
        /* ignore */
      }
    }
    memory[text] = URL.createObjectURL(blob);
    if (buffer) {
      memoryBuffers[text] = buffer;
    } else if (blob && typeof blob.arrayBuffer === 'function') {
      blob.arrayBuffer().then(function (buf) {
        memoryBuffers[text] = buf;
      });
    }
  }

  function fetchKokoroWav(text) {
    beginGenerate();
    return fetch(cfg.ttsUrl.replace(/\/$/, '') + '/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({ text: text, voice: cfg.voice, speed: cfg.speed })
    })
      .then(function (res) {
        if (!res.ok) {
          setConnectionStatus('no-connection');
          throw new Error('TTS HTTP ' + res.status);
        }
        setConnectionStatus('connected');
        return res.arrayBuffer();
      })
      .catch(function (err) {
        setConnectionStatus('no-connection');
        throw err;
      })
      .then(
        function (buf) {
          endGenerate();
          return buf;
        },
        function (err) {
          endGenerate();
          throw err;
        }
      );
  }

  function probeKokoro() {
    return fetch(cfg.ttsUrl.replace(/\/$/, '') + '/api/health', {
      method: 'GET',
      mode: 'cors'
    })
      .then(function (res) {
        var ok = res.ok;
        setConnectionStatus(ok ? 'connected' : 'no-connection');
        return ok;
      })
      .catch(function () {
        setConnectionStatus('no-connection');
        return false;
      });
  }

  function clipLabel(text) {
    if (!text) return '';
    var flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > 72 ? flat.slice(0, 69) + '…' : flat;
  }

  // Opaque string tokens — never String(object) → "[object Object]" for TTS
  var PAUSE_PREFIX = '\uE000pause:';

  function makePause(ms) {
    return PAUSE_PREFIX + Math.max(0, Math.round(Number(ms) || 0));
  }

  function isPause(part) {
    if (typeof part === 'string') return part.indexOf(PAUSE_PREFIX) === 0;
    return !!(part && typeof part === 'object' && !Array.isArray(part) && part.pauseMs != null);
  }

  function pauseMsOf(part) {
    if (typeof part === 'string' && part.indexOf(PAUSE_PREFIX) === 0) {
      return Math.max(0, parseInt(part.slice(PAUSE_PREFIX.length), 10) || 0);
    }
    if (part && typeof part === 'object' && part.pauseMs != null) {
      return Math.max(0, Math.round(Number(part.pauseMs) || 0));
    }
    return 0;
  }

  function normalizeParts(input) {
    if (input == null) return [];
    if (Array.isArray(input)) {
      var out = [];
      input.forEach(function (p) {
        if (isPause(p)) {
          out.push(makePause(pauseMsOf(p)));
          return;
        }
        if (p == null) return;
        // Never coerce plain objects — that yields "[object Object]" spoken by TTS
        if (typeof p === 'object') return;
        var s = typeof p === 'string' ? p.trim() : String(p).trim();
        if (s && s !== '[object Object]') out.push(s);
      });
      return out;
    }
    if (typeof input === 'object') return [];
    var single = String(input).trim();
    return single && single !== '[object Object]' ? [single] : [];
  }

  function partsKey(parts) {
    return parts.join('\u0001');
  }

  function partsLabel(parts) {
    return parts
      .map(function (p) {
        return isPause(p) ? '(' + pauseMsOf(p) + 'ms pause)' : p;
      })
      .join(' | ');
  }

  function partsForSynth(parts) {
    return parts
      .map(function (p) {
        // Short pause ≈ comma / breath between quantity and price
        return isPause(p) ? ',' : p;
      })
      .join(' ')
      .replace(/\s+,/g, ',');
  }

  /** Parse a PCM WAV; returns null if unsupported. */
  function parseWav(buffer) {
    if (!buffer || buffer.byteLength < 44) return null;
    var view = new DataView(buffer);
    if (view.getUint32(0, false) !== 0x52494646) return null; // RIFF
    if (view.getUint32(8, false) !== 0x57415645) return null; // WAVE
    var offset = 12;
    var fmt = null;
    var dataOffset = 0;
    var dataLength = 0;
    while (offset + 8 <= view.byteLength) {
      var id =
        String.fromCharCode(
          view.getUint8(offset),
          view.getUint8(offset + 1),
          view.getUint8(offset + 2),
          view.getUint8(offset + 3)
        );
      var size = view.getUint32(offset + 4, true);
      if (id === 'fmt ') {
        fmt = {
          audioFormat: view.getUint16(offset + 8, true),
          channels: view.getUint16(offset + 10, true),
          sampleRate: view.getUint32(offset + 12, true),
          bitsPerSample: view.getUint16(offset + 22, true)
        };
      } else if (id === 'data') {
        dataOffset = offset + 8;
        dataLength = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!fmt || !dataLength || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return null;
    return {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      pcm: new Int16Array(buffer, dataOffset, Math.floor(dataLength / 2))
    };
  }

  /** Trim leading/trailing near-silence so stitched words don't sound spaced out. */
  function trimPcm(samples) {
    if (!samples || !samples.length) return samples;
    var threshold = 400; // ~1.2% of int16 range
    var pad = Math.min(48, samples.length); // ~2ms @ 24kHz
    var start = 0;
    var end = samples.length - 1;
    while (start < end && Math.abs(samples[start]) < threshold) start++;
    while (end > start && Math.abs(samples[end]) < threshold) end--;
    start = Math.max(0, start - pad);
    end = Math.min(samples.length - 1, end + pad);
    return samples.subarray(start, end + 1);
  }

  function encodeWav(pcm, sampleRate, channels) {
    var dataLength = pcm.length * 2;
    var buffer = new ArrayBuffer(44 + dataLength);
    var view = new DataView(buffer);
    function writeStr(offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataLength, true);
    var out = new Int16Array(buffer, 44);
    out.set(pcm);
    return buffer;
  }

  /**
   * Stitch reusable WAV clips into one continuous utterance.
   * Supports pause markers (`makePause(ms)` / `{ pauseMs: N }`) for intentional gaps.
   */
  function stitchWavClips(parts) {
    var sampleRate = 0;
    var channels = 0;
    var chunks = []; // { pcm: Int16Array } | { pauseMs: number }

    for (var i = 0; i < parts.length; i++) {
      if (isPause(parts[i])) {
        chunks.push({ pauseMs: pauseMsOf(parts[i]) });
        continue;
      }
      var buf = memoryBuffers[parts[i]];
      if (!buf) return null;
      var wav = parseWav(buf);
      if (!wav) return null;
      if (!sampleRate) {
        sampleRate = wav.sampleRate;
        channels = wav.channels;
      } else if (wav.sampleRate !== sampleRate || wav.channels !== channels) {
        return null;
      }
      chunks.push({ pcm: trimPcm(wav.pcm) });
    }

    if (!sampleRate) return null;

    var joinPad = Math.round(sampleRate * 0.008);
    var pieces = [];
    var total = 0;
    var prevWasPcm = false;

    for (var k = 0; k < chunks.length; k++) {
      var chunk = chunks[k];
      if (chunk.pcm) {
        if (prevWasPcm) {
          pieces.push(new Int16Array(joinPad));
          total += joinPad;
        }
        pieces.push(chunk.pcm);
        total += chunk.pcm.length;
        prevWasPcm = true;
      } else {
        var silence = Math.round(sampleRate * (chunk.pauseMs / 1000));
        if (silence > 0) {
          pieces.push(new Int16Array(silence));
          total += silence;
        }
        prevWasPcm = false;
      }
    }

    var merged = new Int16Array(total);
    var offset = 0;
    for (var p = 0; p < pieces.length; p++) {
      merged.set(pieces[p], offset);
      offset += pieces[p].length;
    }
    return encodeWav(merged, sampleRate, channels);
  }

  function ensurePhrase(text) {
    if (!text || typeof text !== 'string' || isPause(text) || text === '[object Object]') {
      return Promise.resolve({ source: 'empty' });
    }
    if (memory[text] && memoryBuffers[text]) {
      return Promise.resolve({ source: 'memory' });
    }

    var key = cacheKey(text);
    return idbGet(key).then(function (stored) {
      if (stored) {
        rememberBlob(text, new Blob([stored], { type: 'audio/wav' }), stored);
        return { source: 'indexeddb' };
      }
      if (backend !== 'kokoro') {
        // Custom sink cannot use speechSynthesis — still try Kokoro for a routable WAV.
        if (hasCustomSink()) {
          return fetchKokoroWav(text)
            .then(function (buf) {
              rememberBlob(text, new Blob([buf], { type: 'audio/wav' }), buf);
              backend = 'kokoro';
              return idbPut(key, buf).then(function () {
                return { source: 'generated' };
              });
            })
            .catch(function (err) {
              log('kokoro unavailable for custom sink:', err && err.message);
              return { source: 'speechSynthesis' };
            });
        }
        log('no wav cache; will use speechSynthesis:', clipLabel(text));
        return { source: 'speechSynthesis' };
      }
      log('generate start (Kokoro):', clipLabel(text));
      var t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return fetchKokoroWav(text).then(function (buf) {
        rememberBlob(text, new Blob([buf], { type: 'audio/wav' }), buf);
        var ms = Math.round(
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
        );
        log('generate done (Kokoro,' + ms + 'ms,' + buf.byteLength + 'B):', clipLabel(text));
        return idbPut(key, buf).then(function () {
          return { source: 'generated' };
        });
      });
    });
  }

  /** Always produce a cached WAV when possible (required for custom audio output). */
  function ensurePhraseWav(text) {
    return ensurePhrase(text).then(function (info) {
      if (memory[text] && memoryBuffers[text]) return info;
      return fetchKokoroWav(text)
        .then(function (buf) {
          rememberBlob(text, new Blob([buf], { type: 'audio/wav' }), buf);
          backend = 'kokoro';
          return idbPut(cacheKey(text), buf).then(function () {
            return { source: 'generated' };
          });
        })
        .catch(function (err) {
          log('ensurePhraseWav failed', err && err.message);
          return info;
        });
    });
  }

  function stopPlaybackOnly() {
    playGen += 1;
    sequence = null;
    stopRoutedOutput();
    if (currentSource) {
      try {
        currentSource.onended = null;
        currentSource.stop();
      } catch (e0) {
        /* ignore */
      }
      currentSource = null;
    }
    if (currentAudio) {
      try {
        currentAudio.onended = null;
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
      } catch (e) {
        /* ignore */
      }
      currentAudio = null;
    }
    currentUtterance = null;
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {
        /* ignore */
      }
    }
    playing = false;
    currentText = null;
  }

  /** Hard stop — used on pad/keyboard button press. */
  function interrupt() {
    pendingParts = null;
    stopPlaybackOnly();
  }

  /** @deprecated alias — prefer interrupt() for button presses */
  function cancel() {
    interrupt();
  }

  function finishCurrent(gen) {
    if (gen !== playGen) return;
    playing = false;
    currentAudio = null;
    currentSource = null;
    currentUtterance = null;
    currentText = null;
    sequence = null;
    drainPending();
  }

  function drainPending() {
    if (!pendingParts || !pendingParts.length) {
      pendingParts = null;
      return;
    }
    var next = pendingParts;
    pendingParts = null;
    startSpeak(next);
  }

  function afterClip(gen, onDone) {
    if (gen !== playGen) return;
    if (typeof onDone === 'function') onDone();
  }

  function playNextInSequence() {
    if (!sequence || sequence.gen !== playGen) return;
    if (sequence.index >= sequence.parts.length) {
      log('sequence done:', clipLabel(partsLabel(sequence.parts)));
      finishCurrent(sequence.gen);
      return;
    }

    var part = sequence.parts[sequence.index++];
    var gen = sequence.gen;
    var isLast = sequence.index >= sequence.parts.length;

    function continueOrFinish() {
      if (gen !== playGen) return;
      if (isLast) {
        finishCurrent(gen);
        return;
      }
      playNextInSequence();
    }

    if (isPause(part)) {
      var wait = pauseMsOf(part);
      log('sequence pause', wait + 'ms');
      setTimeout(continueOrFinish, wait);
      return;
    }

    if (memory[part] || backend !== 'kokoro') {
      if (playOne(part, continueOrFinish)) return;
      playSynthOne(part, continueOrFinish);
      return;
    }

    ensurePhrase(part).then(function () {
      if (gen !== playGen) return;
      if (!playOne(part, continueOrFinish)) playSynthOne(part, continueOrFinish);
    });
  }

  function playbackVolume() {
    var vol = 1;
    if (window.KeyboardNav && typeof window.KeyboardNav.volumeLevel === 'function') {
      vol = window.KeyboardNav.volumeLevel();
    } else {
      var cssVol = getComputedStyle(document.documentElement).getPropertyValue('--kiosk-speech-volume');
      if (cssVol) vol = parseFloat(cssVol) || 1;
    }
    return Math.max(0, Math.min(1, vol));
  }

  /**
   * All kiosk speech WAV playback goes through KioskAudioOutput.playRouted
   * so every page honors the tech-selected output device.
   */
  function playOne(text, onEnded) {
    var url = memory[text];
    if (!url) return false;
    log('play from cache:', clipLabel(text));
    var gen = playGen;
    playing = true;
    currentAudio = null;
    currentSource = null;

    function done() {
      if (gen === playGen) afterClip(gen, onEnded);
    }

    if (!window.KioskAudioOutput || typeof window.KioskAudioOutput.playRouted !== 'function') {
      log('playRouted missing — cannot guarantee sink routing');
      var audio = new Audio(url);
      audio.volume = playbackVolume();
      currentAudio = audio;
      audio.onended = done;
      applyOutputSink(audio).then(function (ok) {
        if (hasCustomSink() && !ok) {
          log('refusing default play without playRouted');
          done();
          return;
        }
        audio.play().catch(function () {
          done();
        });
      });
      return true;
    }

    window.KioskAudioOutput.playRouted(url, {
      volume: playbackVolume(),
      requireSink: hasCustomSink()
    })
      .then(function (info) {
        log('playRouted ok sink=', (info && info.sinkId) || '(default)', (info && info.label) || '');
        done();
      })
      .catch(function (err) {
        log('playRouted failed:', err && err.message);
        // Never fall back to speechSynthesis / default when a custom sink is set.
        done();
      });
    return true;
  }

  function playSynthOne(text, onEnded) {
    // speechSynthesis ALWAYS uses the OS default device — ban it when a sink is set.
    if (hasCustomSink()) {
      log('custom sink set — forcing WAV instead of speechSynthesis:', clipLabel(text));
      ensurePhraseWav(text)
        .then(function () {
          if (!playOne(text, onEnded)) {
            log('no routable wav for custom sink; skipping unroutable speechSynthesis');
            afterClip(playGen, onEnded);
          }
        })
        .catch(function () {
          afterClip(playGen, onEnded);
        });
      return;
    }

    if (!window.speechSynthesis) {
      afterClip(playGen, onEnded);
      return;
    }
    log('play via speechSynthesis (not cached wav):', clipLabel(text));
    var gen = playGen;
    var utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.rate = 1.05;
    var voices = window.speechSynthesis.getVoices();
    for (var i = 0; i < voices.length; i++) {
      if (/en(-|_)US/i.test(voices[i].lang) && /female|zira|samantha|google us/i.test(voices[i].name)) {
        utter.voice = voices[i];
        break;
      }
    }
    if (!utter.voice) {
      for (var j = 0; j < voices.length; j++) {
        if (/^en/i.test(voices[j].lang)) {
          utter.voice = voices[j];
          break;
        }
      }
    }
    currentUtterance = utter;
    playing = true;
    utter.onend = function () {
      currentUtterance = null;
      afterClip(gen, onEnded);
    };
    utter.onerror = function () {
      currentUtterance = null;
      afterClip(gen, onEnded);
    };
    window.speechSynthesis.speak(utter);
  }

  function playStitched(parts, gen) {
    var stitched = stitchWavClips(parts);
    if (!stitched) return false;
    var url = URL.createObjectURL(new Blob([stitched], { type: 'audio/wav' }));
    log('play stitched (' + parts.length + ' parts):', clipLabel(partsLabel(parts)));
    playing = true;
    currentAudio = null;
    currentSource = null;

    function finish() {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        /* ignore */
      }
      if (gen === playGen) finishCurrent(gen);
    }

    if (!window.KioskAudioOutput || typeof window.KioskAudioOutput.playRouted !== 'function') {
      finish();
      return true;
    }

    window.KioskAudioOutput.playRouted(url, {
      volume: playbackVolume(),
      requireSink: hasCustomSink()
    })
      .then(function () {
        finish();
      })
      .catch(function (err) {
        log('stitched playRouted failed:', err && err.message);
        finish();
      });
    return true;
  }

  function startSpeak(input) {
    var parts = normalizeParts(input);
    if (!cfg.enabled || !parts.length) return;
    unlock();
    stopPlaybackOnly();

    var key = partsKey(parts);
    currentText = key;
    playing = true;
    sequence = { parts: parts, index: 0, gen: playGen, key: key };

    var gen = playGen;
    var speechParts = parts.filter(function (p) {
      return !isPause(p);
    });

    // Single speech clip (optional pauses ignored if alone)
    if (speechParts.length === 1 && parts.length === 1) {
      ensurePhrase(speechParts[0]).then(function () {
        if (gen !== playGen) return;
        if (!playOne(speechParts[0], function () {
          finishCurrent(gen);
        })) {
          playSynthOne(speechParts[0], function () {
            finishCurrent(gen);
          });
        }
      });
      return;
    }

    log('sequence prepare (' + parts.length + ' parts):', clipLabel(partsLabel(parts)));

    // Fallback TTS: one utterance; pause markers become commas
    // (skipped when a custom sink is set — speechSynthesis ignores setSinkId)
    if (backend !== 'kokoro' && !hasCustomSink()) {
      playSynthOne(partsForSynth(parts), function () {
        finishCurrent(gen);
      });
      return;
    }

    // Prefetch speech clips only, stitch (with silence for pause markers), play once
    var chain = Promise.resolve();
    speechParts.forEach(function (p) {
      chain = chain.then(function () {
        if (gen !== playGen) return;
        return ensurePhrase(p);
      });
    });
    chain
      .then(function () {
        if (gen !== playGen) return;
        if (playStitched(parts, gen)) return;
        log('stitch failed — sequential fallback');
        playNextInSequence();
      })
      .catch(function (err) {
        log('sequence prepare failed', err && err.message);
        if (gen === playGen) playNextInSequence();
      });
  }

  /**
   * Speak a phrase or an array of reusable clips.
   * Arrays may include `{ pauseMs: N }` or SpeechEngine.pause(ms) for gaps (e.g. qty → price).
   * Multi-clip arrays are stitched into one continuous WAV.
   */
  function speak(input, opts) {
    opts = opts || {};
    var parts = normalizeParts(input);
    if (!cfg.enabled || !parts.length) return;

    function run() {
      unlock();

      if (opts.interrupt) {
        interrupt();
        startSpeak(parts);
        return;
      }

      if (isBusy()) {
        if (partsKey(parts) === currentText) return;
        pendingParts = parts;
        log('queued (playing):', clipLabel(partsLabel(parts)));
        return;
      }

      startSpeak(parts);
    }

    // Custom sink: resolve live deviceId + permission before any utterance
    // (covers thank-you focus speech after navigation).
    if (hasCustomSink()) {
      prepareOutputRoute()
        .then(function (ok) {
          if (!ok) log('speak: custom sink not ready — still attempting routed play');
          run();
        })
        .catch(function (err) {
          log('speak: prepare failed', err && err.message);
          run();
        });
      return;
    }

    run();
  }

  function collectUniqueClips(phrases) {
    var unique = [];
    var seen = Object.create(null);
    function addClip(p) {
      if (!p || isPause(p) || seen[p]) return;
      if (typeof p !== 'string') return;
      seen[p] = true;
      unique.push(p);
    }
    (phrases || []).forEach(function (p) {
      if (Array.isArray(p)) {
        normalizeParts(p).forEach(addClip);
      } else {
        addClip(p);
      }
    });
    return unique;
  }

  function synthesizeClips(unique, label) {
    if (!unique.length) {
      if (generateInFlight === 0 && ready) setWarmStatus('warmed');
      return Promise.resolve({
        cached: 0,
        stats: { generated: 0, indexeddb: 0, memory: 0, other: 0 }
      });
    }
    if (backend !== 'kokoro') {
      if (window.speechSynthesis) window.speechSynthesis.getVoices();
      log(label || 'clips', 'skipped wav synth; backend=' + backend, unique.length);
      if (generateInFlight === 0) setWarmStatus('warmed');
      return Promise.resolve({
        cached: 0,
        stats: { generated: 0, indexeddb: 0, memory: 0, other: 0 }
      });
    }

    log(label || 'ensureClips', unique.length, 'clips');
    var i = 0;
    var stats = { generated: 0, indexeddb: 0, memory: 0, other: 0 };
    function next() {
      if (i >= unique.length) {
        log(
          (label || 'ensureClips') + ' done',
          unique.length,
          'generated=' + stats.generated,
          'indexeddb=' + stats.indexeddb,
          'memory=' + stats.memory
        );
        if (generateInFlight === 0) setWarmStatus('warmed');
        return { cached: unique.length, stats: stats };
      }
      var phrase = unique[i++];
      return ensurePhrase(phrase)
        .then(function (info) {
          var src = (info && info.source) || 'other';
          if (stats[src] != null) stats[src] += 1;
          else stats.other += 1;
        })
        .catch(function (err) {
          log('failed phrase', clipLabel(phrase), err && err.message);
        })
        .then(next);
    }
    return next();
  }

  /**
   * Generate/cache additional clips after the initial warmup
   * (e.g. cart stems when the cart opens). Safe to call repeatedly.
   */
  function ensureClips(phrases) {
    var unique = collectUniqueClips(phrases);
    warmQueue = warmQueue.then(function () {
      if (!cfg.enabled) return { cached: 0 };
      if (!readyPromise) {
        return warmup(unique);
      }
      return readyPromise.then(function () {
        return synthesizeClips(unique, 'ensureClips');
      });
    });
    return warmQueue;
  }

  function warmup(phrases) {
    if (readyPromise) {
      return ensureClips(phrases);
    }
    if (!cfg.enabled) {
      ready = true;
      setConnectionStatus('no-connection');
      setWarmStatus('warmed');
      readyPromise = Promise.resolve({ backend: 'none', cached: 0 });
      return readyPromise;
    }

    var unique = collectUniqueClips(phrases);
    ensureStatusHud();

    readyPromise = probeKokoro().then(function (ok) {
      backend = ok ? 'kokoro' : window.speechSynthesis ? 'speechSynthesis' : 'none';
      log('backend', backend, '(' + unique.length + ' clips)');
      scheduleConnectionProbe();

      if (backend !== 'kokoro') {
        if (window.speechSynthesis) window.speechSynthesis.getVoices();
        ready = true;
        if (generateInFlight === 0) setWarmStatus('warmed');
        return { backend: backend, cached: 0 };
      }

      return synthesizeClips(unique, 'warmup').then(function (result) {
        ready = true;
        if (generateInFlight === 0) setWarmStatus('warmed');
        return Object.assign({ backend: backend }, result);
      });
    });

    return readyPromise;
  }

  function whenReady(cb) {
    if (ready) {
      cb();
      return;
    }
    warmup([]).then(cb);
  }

  /**
   * Play a phrase strictly on the tech-selected output device.
   * Used for Finish-purchase confirmation — never speechSynthesis / never default
   * when a custom sink is configured.
   */
  function playOnSelectedOutput(text) {
    if (!text) return Promise.resolve(false);
    unlock();
    interrupt();
    playing = true;
    currentText = text;

    return ensurePhraseWav(text).then(function () {
      var url = memory[text];
      if (!url) {
        playing = false;
        currentText = null;
        return Promise.reject(new Error('no wav for: ' + clipLabel(text)));
      }
      if (!window.KioskAudioOutput || typeof window.KioskAudioOutput.playRouted !== 'function') {
        playing = false;
        currentText = null;
        return Promise.reject(new Error('playRouted unavailable'));
      }

      return window.KioskAudioOutput.resolveLiveSinkId()
        .then(function (sinkId) {
          if (!sinkId && window.KioskAudioOutput.hasCustomSink()) {
            return Promise.reject(new Error('selected output device not available'));
          }
          log('playOnSelectedOutput → sink', sinkId || '(default)', window.KioskAudioOutput.getSinkLabel());
          return window.KioskAudioOutput.playRouted(url, {
            volume: playbackVolume(),
            sinkId: sinkId || '',
            requireSink: !!sinkId || window.KioskAudioOutput.hasCustomSink()
          });
        })
        .then(function (info) {
          playing = false;
          currentText = null;
          log('playOnSelectedOutput done', info && info.label, info && info.sinkId);
          return true;
        })
        .catch(function (err) {
          playing = false;
          currentText = null;
          throw err;
        });
    });
  }

  window.SpeechEngine = {
    speak: speak,
    playOnSelectedOutput: playOnSelectedOutput,
    pause: makePause,
    cancel: cancel,
    interrupt: interrupt,
    warmup: warmup,
    ensureClips: ensureClips,
    whenReady: whenReady,
    unlock: unlock,
    isBusy: isBusy,
    isReady: function () {
      return ready;
    },
    backend: function () {
      return backend;
    },
    current: function () {
      return currentText;
    },
    pending: function () {
      return pendingParts;
    },
    status: function () {
      return {
        connection: connectionStatus,
        warmup: warmStatus,
        generating: generateInFlight > 0,
        backend: backend
      };
    },
    config: cfg
  };

  bindUnlock();
  bindButtonInterrupt();

  function mountStatusHud() {
    ensureStatusHud();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountStatusHud);
  } else {
    mountStatusHud();
  }
})();
