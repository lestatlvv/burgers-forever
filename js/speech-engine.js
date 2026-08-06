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
  var currentUtterance = null;
  var dbPromise = null;
  var unlocked = false;
  var playing = false;
  var pendingParts = null; // string[] | null
  var currentText = null; // joined key of active sequence / phrase
  var sequence = null; // { parts, index, gen, key }
  var warmQueue = Promise.resolve();

  function log() {
    if (window.console && console.info) {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[speech]');
      console.info.apply(console, args);
    }
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
    try {
      var silent = new Audio(
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='
      );
      silent.volume = 0.01;
      silent.play().catch(function () {
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
    return fetch(cfg.ttsUrl.replace(/\/$/, '') + '/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({ text: text, voice: cfg.voice, speed: cfg.speed })
    }).then(function (res) {
      if (!res.ok) throw new Error('TTS HTTP ' + res.status);
      return res.arrayBuffer();
    });
  }

  function probeKokoro() {
    return fetch(cfg.ttsUrl.replace(/\/$/, '') + '/api/health', {
      method: 'GET',
      mode: 'cors'
    })
      .then(function (res) {
        return res.ok;
      })
      .catch(function () {
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
      log('cache hit (memory):', clipLabel(text));
      return Promise.resolve({ source: 'memory' });
    }

    var key = cacheKey(text);
    return idbGet(key).then(function (stored) {
      if (stored) {
        rememberBlob(text, new Blob([stored], { type: 'audio/wav' }), stored);
        log('cache hit (IndexedDB → memory):', clipLabel(text));
        return { source: 'indexeddb' };
      }
      if (backend !== 'kokoro') {
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

  function stopPlaybackOnly() {
    playGen += 1;
    sequence = null;
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

  function playOne(text, onEnded) {
    var url = memory[text];
    if (!url) return false;
    log('play from cache:', clipLabel(text));
    var gen = playGen;
    var audio = new Audio(url);
    audio.volume = playbackVolume();
    currentAudio = audio;
    playing = true;
    var playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(function (err) {
        log('playback blocked', err && err.message);
        var retry = function () {
          window.removeEventListener('kb-activity', retry);
          if (gen !== playGen) return;
          if (!playOne(text, onEnded)) afterClip(gen, onEnded);
        };
        window.addEventListener('kb-activity', retry);
      });
    }
    audio.onended = function () {
      if (currentAudio === audio) currentAudio = null;
      afterClip(gen, onEnded);
    };
    return true;
  }

  function playSynthOne(text, onEnded) {
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
    var audio = new Audio(url);
    audio.volume = playbackVolume();
    currentAudio = audio;
    playing = true;
    var playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(function (err) {
        log('playback blocked', err && err.message);
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          /* ignore */
        }
      });
    }
    audio.onended = function () {
      try {
        URL.revokeObjectURL(url);
      } catch (e2) {
        /* ignore */
      }
      if (currentAudio === audio) currentAudio = null;
      finishCurrent(gen);
    };
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
    if (backend !== 'kokoro') {
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
      return Promise.resolve({
        cached: 0,
        stats: { generated: 0, indexeddb: 0, memory: 0, other: 0 }
      });
    }
    if (backend !== 'kokoro') {
      if (window.speechSynthesis) window.speechSynthesis.getVoices();
      log(label || 'clips', 'skipped wav synth; backend=' + backend, unique.length);
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
      readyPromise = Promise.resolve({ backend: 'none', cached: 0 });
      return readyPromise;
    }

    var unique = collectUniqueClips(phrases);

    readyPromise = probeKokoro().then(function (ok) {
      backend = ok ? 'kokoro' : window.speechSynthesis ? 'speechSynthesis' : 'none';
      log('backend', backend, '(' + unique.length + ' clips)');

      if (backend !== 'kokoro') {
        if (window.speechSynthesis) window.speechSynthesis.getVoices();
        ready = true;
        return { backend: backend, cached: 0 };
      }

      return synthesizeClips(unique, 'warmup').then(function (result) {
        ready = true;
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

  window.SpeechEngine = {
    speak: speak,
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
    config: cfg
  };

  bindUnlock();
  bindButtonInterrupt();
})();
