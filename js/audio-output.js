/**
 * Kiosk audio output routing.
 *
 * Persists a preferred HTMLMediaElement sinkId (speaker/headset) and applies it
 * to every Audio element before playback. Used by speech-engine.js and the
 * tech settings page (audio-output-test.html).
 *
 * speechSynthesis cannot be routed — only WAV / <audio> playback respects sinkId.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'kiosk-audio-output-sink-id';
  var LABEL_KEY = 'kiosk-audio-output-sink-label';
  var SETTINGS_PAGE = 'audio-output-test.html';
  var DEFAULT_PIN = '1111';
  var PIN_STORAGE_KEY = 'kiosk-tech-pin';
  var UNLOCK_SESSION_KEY = 'kiosk-tech-unlocked';
  var pinOverlayEl = null;
  var pinStylesReady = false;
  var permissionPromise = null;
  var permissionOk = false;
  var audioCtx = null;
  var resolvedSinkId = null; // live deviceId for this page (after re-resolve by label)
  var resolveSinkPromise = null;

  function ensurePinStyles() {
    if (pinStylesReady || document.getElementById('kiosk-tech-pin-styles')) {
      pinStylesReady = true;
      return;
    }
    var style = document.createElement('style');
    style.id = 'kiosk-tech-pin-styles';
    style.textContent =
      '.kiosk-tech-pin-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;' +
      'align-items:center;justify-content:center;background:rgba(10,12,16,.72);padding:24px}' +
      '.kiosk-tech-pin{width:min(320px,100%);background:#24272c;border:1px solid #3a3f47;' +
      'border-radius:12px;padding:22px 20px 18px;color:#e8eaed;' +
      'font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
      '.kiosk-tech-pin__title{margin:0 0 14px;font-size:1.05rem;font-weight:650}' +
      '.kiosk-tech-pin__input{width:100%;box-sizing:border-box;border:1px solid #3a3f47;' +
      'border-radius:8px;background:#1a1c1f;color:#e8eaed;font-size:1.35rem;' +
      'letter-spacing:.35em;text-align:center;padding:12px 14px;margin-bottom:8px}' +
      '.kiosk-tech-pin__input:focus{outline:2px solid #7eb6ff;outline-offset:2px}' +
      '.kiosk-tech-pin__error{margin:0 0 10px;min-height:1.2em;font-size:.85rem;color:#f31260}' +
      '.kiosk-tech-pin__actions{display:flex;gap:10px;margin-top:8px}' +
      '.kiosk-tech-pin__actions button{flex:1;border:0;border-radius:8px;padding:11px 14px;' +
      'font-size:.95rem;font-weight:600;cursor:pointer}' +
      '.kiosk-tech-pin__cancel{background:transparent;color:#e8eaed;border:1px solid #3a3f47!important}' +
      '.kiosk-tech-pin__ok{background:#3d8bfd;color:#fff}' +
      '.kiosk-tech-pin__ok:hover{background:#5a9fff}';
    document.head.appendChild(style);
    pinStylesReady = true;
  }

  function log() {
    if (window.console && console.info) {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[audio-out]');
      console.info.apply(console, args);
    }
  }

  function getConfiguredPin() {
    try {
      var stored = localStorage.getItem(PIN_STORAGE_KEY);
      if (stored) return String(stored);
    } catch (e) {
      /* ignore */
    }
    if (window.KIOSK_TECH_PIN != null && String(window.KIOSK_TECH_PIN)) {
      return String(window.KIOSK_TECH_PIN);
    }
    return DEFAULT_PIN;
  }

  function isTechUnlocked() {
    try {
      return sessionStorage.getItem(UNLOCK_SESSION_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setTechUnlocked(on) {
    try {
      if (on) sessionStorage.setItem(UNLOCK_SESSION_KEY, '1');
      else sessionStorage.removeItem(UNLOCK_SESSION_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function closePinOverlay() {
    if (pinOverlayEl && pinOverlayEl.parentNode) {
      pinOverlayEl.parentNode.removeChild(pinOverlayEl);
    }
    pinOverlayEl = null;
  }

  /**
   * Tech PIN dialog (not customer UI). Resolves true on success, false on cancel.
   */
  function promptPin(options) {
    options = options || {};
    return new Promise(function (resolve) {
      closePinOverlay();
      ensurePinStyles();

      var overlay = document.createElement('div');
      overlay.id = 'kiosk-tech-pin-overlay';
      overlay.className = 'kiosk-tech-pin-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Technician PIN');
      overlay.innerHTML =
        '<form class="kiosk-tech-pin" autocomplete="off">' +
        '<p class="kiosk-tech-pin__title">Technician PIN</p>' +
        '<input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" ' +
        'class="kiosk-tech-pin__input" name="pin" autocomplete="off" aria-label="PIN" />' +
        '<p class="kiosk-tech-pin__error" hidden></p>' +
        '<div class="kiosk-tech-pin__actions">' +
        '<button type="button" class="kiosk-tech-pin__cancel" data-action="cancel">Cancel</button>' +
        '<button type="submit" class="kiosk-tech-pin__ok">OK</button>' +
        '</div>' +
        '</form>';

      document.body.appendChild(overlay);
      pinOverlayEl = overlay;

      var form = overlay.querySelector('form');
      var input = overlay.querySelector('.kiosk-tech-pin__input');
      var err = overlay.querySelector('.kiosk-tech-pin__error');
      var cancelBtn = overlay.querySelector('[data-action="cancel"]');
      var settled = false;

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }

      function finish(ok) {
        if (settled) return;
        settled = true;
        window.removeEventListener('keydown', onKey, true);
        closePinOverlay();
        resolve(ok);
      }

      function showError(msg) {
        err.hidden = false;
        err.textContent = msg;
        input.value = '';
        input.focus();
      }

      cancelBtn.addEventListener('click', function () {
        finish(false);
      });

      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) finish(false);
      });

      window.addEventListener('keydown', onKey, true);

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var entered = String(input.value || '').trim();
        if (!entered) {
          showError('Enter PIN');
          return;
        }
        if (entered === getConfiguredPin()) {
          setTechUnlocked(true);
          if (typeof options.onSuccess === 'function') options.onSuccess();
          finish(true);
        } else {
          showError('Incorrect PIN');
        }
      });

      setTimeout(function () {
        input.focus();
      }, 0);
    });
  }

  function requirePinThen(navigateHref) {
    if (isTechUnlocked()) {
      if (navigateHref) location.href = navigateHref;
      return Promise.resolve(true);
    }
    return promptPin().then(function (ok) {
      if (ok && navigateHref) location.href = navigateHref;
      return ok;
    });
  }

  /** Gate the settings page — show PIN until unlocked this session. */
  function gateSettingsPage() {
    var main = document.querySelector('main');
    if (isTechUnlocked()) {
      if (main) main.hidden = false;
      return Promise.resolve(true);
    }
    if (main) main.hidden = true;
    return promptPin().then(function (ok) {
      if (ok) {
        if (main) main.hidden = false;
        return true;
      }
      var params = new URLSearchParams(location.search);
      var from = params.get('from') || 'index.html';
      if (from.indexOf('://') !== -1) from = 'index.html';
      location.href = from;
      return false;
    });
  }

  function supportsSinkId() {
    return (
      typeof HTMLMediaElement !== 'undefined' &&
      typeof HTMLMediaElement.prototype.setSinkId === 'function'
    );
  }

  function getSinkId() {
    if (resolvedSinkId) return resolvedSinkId;
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function getSinkLabel() {
    try {
      return localStorage.getItem(LABEL_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setSink(deviceId, label) {
    var id = deviceId || '';
    resolvedSinkId = id || null;
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEY, id);
        localStorage.setItem(LABEL_KEY, label || '');
      } else {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LABEL_KEY);
      }
    } catch (e) {
      log('persist failed', e && e.message);
    }
    window.dispatchEvent(
      new CustomEvent('kiosk-audio-output-changed', {
        detail: { sinkId: id, label: label || '' }
      })
    );
    return id;
  }

  function clearSink() {
    return setSink('', '');
  }

  function hasCustomSink() {
    return !!(getSinkId() || getSinkLabel());
  }

  /**
   * deviceId can change after USB replug / browser restart.
   * Re-enumerate and match saved id, then exact label, then fuzzy label.
   */
  function resolveLiveSinkId() {
    if (resolveSinkPromise) return resolveSinkPromise;
    var savedId = '';
    var savedLabel = '';
    try {
      savedId = localStorage.getItem(STORAGE_KEY) || '';
      savedLabel = localStorage.getItem(LABEL_KEY) || '';
    } catch (e) {
      /* ignore */
    }
    if (!savedId && !savedLabel) {
      resolvedSinkId = null;
      return Promise.resolve('');
    }

    resolveSinkPromise = listOutputDevices()
      .then(function (devices) {
        var match = null;
        if (savedId) {
          for (var i = 0; i < devices.length; i++) {
            if (devices[i].deviceId === savedId) {
              match = devices[i];
              break;
            }
          }
        }
        if (!match && savedLabel) {
          for (var j = 0; j < devices.length; j++) {
            if (devices[j].label === savedLabel) {
              match = devices[j];
              break;
            }
          }
        }
        if (!match && savedLabel) {
          var needle = savedLabel.toLowerCase();
          for (var k = 0; k < devices.length; k++) {
            var lab = (devices[k].label || '').toLowerCase();
            if (lab && (lab.indexOf(needle) !== -1 || needle.indexOf(lab) !== -1)) {
              match = devices[k];
              break;
            }
          }
        }
        if (!match && savedLabel && /usb/i.test(savedLabel)) {
          for (var u = 0; u < devices.length; u++) {
            if (/usb/i.test(devices[u].label || '') && /audio/i.test(devices[u].label || '')) {
              match = devices[u];
              break;
            }
          }
        }

        if (match) {
          if (match.deviceId !== savedId || match.label !== savedLabel) {
            log('resolved sink by label/id →', match.label);
            setSink(match.deviceId, match.label || savedLabel);
          } else {
            resolvedSinkId = match.deviceId;
          }
          return match.deviceId;
        }

        log('saved sink not found among', devices.length, 'outputs; label=', savedLabel);
        resolvedSinkId = savedId || null;
        return savedId;
      })
      .catch(function (err) {
        log('resolveLiveSinkId failed', err && err.message);
        resolvedSinkId = savedId || null;
        return savedId;
      })
      .then(function (id) {
        resolveSinkPromise = null;
        return id || '';
      });

    return resolveSinkPromise;
  }

  /**
   * Chrome requires a prior media permission grant before setSinkId reliably
   * routes to a non-default device (especially after a full page navigation).
   */
  function ensureOutputPermission() {
    if (permissionOk) return Promise.resolve(true);
    if (permissionPromise) return permissionPromise;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.resolve(false);
    }
    permissionPromise = navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then(function (stream) {
        stream.getTracks().forEach(function (t) {
          t.stop();
        });
        permissionOk = true;
        permissionPromise = null;
        return true;
      })
      .catch(function (err) {
        log('output permission failed', err && err.message);
        permissionPromise = null;
        return false;
      });
    return permissionPromise;
  }

  function getAudioContext() {
    if (!audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    return audioCtx;
  }

  function applySinkToContext(ctx) {
    return resolveLiveSinkId().then(function (sinkId) {
      if (!sinkId || !ctx) return false;
      if (typeof ctx.setSinkId !== 'function') {
        log('AudioContext.setSinkId not supported');
        return false;
      }
      return ensureOutputPermission().then(function (ok) {
        if (!ok) log('permission missing before AudioContext.setSinkId');
        return ctx.setSinkId(sinkId).then(
          function () {
            log('AudioContext sink set', (getSinkLabel() || sinkId).slice(0, 40));
            return true;
          },
          function (err) {
            log('AudioContext.setSinkId failed', err && err.message);
            return false;
          }
        );
      });
    });
  }

  /**
   * Apply persisted sink to an HTMLMediaElement before play().
   * Resolves true only when the sink was applied successfully.
   */
  function applyToElement(audioEl) {
    if (!audioEl || typeof audioEl.setSinkId !== 'function') {
      return Promise.resolve(false);
    }

    return resolveLiveSinkId().then(function (sinkId) {
      if (!sinkId) return true; // system default
      return ensureOutputPermission()
        .then(function () {
          return audioEl.setSinkId(sinkId);
        })
        .then(function () {
          var applied = audioEl.sinkId === sinkId;
          if (!applied) {
            log('sinkId mismatch after set', audioEl.sinkId, 'expected', sinkId.slice(0, 12));
          } else {
            log('<audio> sink set', (getSinkLabel() || sinkId).slice(0, 40));
          }
          return applied;
        })
        .catch(function (err) {
          log('setSinkId failed', err && err.message);
          return false;
        });
    });
  }

  /** Warm permission + sink while a user gesture is available (pad/click). */
  function prepareForPlayback() {
    return resolveLiveSinkId().then(function (id) {
      if (!id) return false;
      return ensureOutputPermission().then(function (ok) {
        if (!ok) return false;
        var ctx = getAudioContext();
        if (ctx && ctx.state === 'suspended') {
          return ctx.resume().then(function () {
            return applySinkToContext(ctx);
          });
        }
        return applySinkToContext(ctx);
      });
    });
  }

  function ensureDeviceLabels() {
    return ensureOutputPermission();
  }

  function listOutputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return Promise.resolve([]);
    }
    return ensureDeviceLabels().then(function () {
      return navigator.mediaDevices.enumerateDevices().then(function (devices) {
        return devices.filter(function (d) {
          return d.kind === 'audiooutput';
        });
      });
    });
  }

  function createTestWavBlob(durationSec, freqHz, sampleRate) {
    durationSec = durationSec || 0.85;
    freqHz = freqHz || 880;
    sampleRate = sampleRate || 44100;

    var numSamples = Math.floor(sampleRate * durationSec);
    var dataSize = numSamples * 2;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);

    function writeStr(offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    for (var i = 0; i < numSamples; i++) {
      var t = i / sampleRate;
      var env = 1;
      var attack = 0.02;
      var release = 0.08;
      if (t < attack) env = t / attack;
      else if (t > durationSec - release) env = Math.max(0, (durationSec - t) / release);
      var sample = Math.sin(2 * Math.PI * freqHz * t) * 0.35 * env;
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  var routedAudio = null;
  var routedToken = 0;

  function stopRouted() {
    routedToken += 1;
    if (!routedAudio) return;
    try {
      routedAudio.onended = null;
      routedAudio.onerror = null;
      routedAudio.pause();
      routedAudio.removeAttribute('src');
      routedAudio.load();
    } catch (e) {
      /* ignore */
    }
    routedAudio = null;
  }

  /**
   * Single playback path for the whole kiosk.
   * Sets sinkId BEFORE assigning src (more reliable in Chromium), then plays.
   * If a custom sink is configured and cannot be applied, rejects (no default leak).
   */
  function playRouted(url, opts) {
    opts = opts || {};
    stopRouted();
    var token = routedToken;
    var audio = new Audio();
    audio.preload = 'auto';
    audio.volume = opts.volume != null ? opts.volume : 1;
    routedAudio = audio;

    var sinkPromise = opts.sinkId
      ? Promise.resolve(opts.sinkId)
      : resolveLiveSinkId();

    return sinkPromise
      .then(function (sinkId) {
        var wantCustom = !!(sinkId || getSinkLabel() || opts.requireSink);
        return ensureOutputPermission().then(function () {
          if (token !== routedToken) return Promise.reject(new Error('cancelled'));

          var ready = Promise.resolve();
          if (sinkId) {
            if (typeof audio.setSinkId !== 'function') {
              return Promise.reject(new Error('setSinkId unsupported'));
            }
            // Sink first, then src — required for reliable routing on some Chromium builds.
            ready = audio.setSinkId(sinkId);
          } else if (wantCustom) {
            return Promise.reject(new Error('custom sink unresolved'));
          }

          return ready.then(function () {
            if (token !== routedToken) return Promise.reject(new Error('cancelled'));
            audio.src = url;
            log(
              'playRouted →',
              audio.sinkId ? audio.sinkId.slice(0, 10) + '…' : '(default)',
              getSinkLabel() || opts.sinkId || ''
            );
            if (sinkId && audio.sinkId && audio.sinkId !== sinkId) {
              return Promise.reject(new Error('sinkId mismatch after set'));
            }
            return audio.play();
          });
        });
      })
      .then(function () {
        return new Promise(function (resolve, reject) {
          if (token !== routedToken) {
            reject(new Error('cancelled'));
            return;
          }
          audio.onended = function () {
            if (routedAudio === audio) routedAudio = null;
            resolve({ sinkId: audio.sinkId || '', label: getSinkLabel() });
          };
          audio.onerror = function () {
            if (routedAudio === audio) routedAudio = null;
            reject(new Error('playback error'));
          };
        });
      });
  }

  function playTestTone(sinkId) {
    var blob = createTestWavBlob();
    var url = URL.createObjectURL(blob);
    var id = sinkId != null ? sinkId : getSinkId();
    return playRouted(url, { volume: 0.9, sinkId: id || '', requireSink: !!id })
      .then(function (info) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          /* ignore */
        }
        return info;
      })
      .catch(function (err) {
        try {
          URL.revokeObjectURL(url);
        } catch (e2) {
          /* ignore */
        }
        throw err;
      });
  }

  function settingsHref() {
    var here = (location.pathname.split('/').pop() || 'index.html') + location.search + location.hash;
    return SETTINGS_PAGE + '?from=' + encodeURIComponent(here);
  }

  function updateStatusControlLabel() {
    var link = document.querySelector('#kiosk-tts-status [data-role="audio-out"]');
    if (!link) return;
    var label = getSinkLabel();
    if (label) {
      var short = label.length > 18 ? label.slice(0, 16) + '…' : label;
      link.textContent = '♪';
      link.title = 'Audio output: ' + label + ' (PIN)';
      link.setAttribute('data-sink', short);
    } else {
      link.textContent = '♪';
      link.title = 'Audio output settings (PIN)';
      link.removeAttribute('data-sink');
    }
  }

  /** Append a discreet tech control to the TTS status HUD (pointer-events on link only). */
  function mountStatusControl() {
    var hud = document.getElementById('kiosk-tts-status');
    if (!hud) return false;
    if (hud.querySelector('[data-role="audio-out"]')) {
      updateStatusControlLabel();
      return true;
    }

    var link = document.createElement('a');
    link.className = 'kiosk-tts-status__audio';
    link.setAttribute('data-role', 'audio-out');
    link.href = settingsHref();
    link.title = 'Audio output settings (PIN)';
    link.setAttribute('aria-label', 'Audio output settings');
    link.textContent = '♪';
    // Allow click while parent HUD stays pointer-events:none
    link.style.cssText =
      'pointer-events:auto;cursor:pointer;color:inherit;text-decoration:none;' +
      'margin-left:4px;opacity:0.7;';
    link.addEventListener('click', function (e) {
      e.preventDefault();
      requirePinThen(settingsHref());
    });
    hud.appendChild(link);
    updateStatusControlLabel();
    return true;
  }

  function watchStatusHud() {
    if (mountStatusControl()) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', watchStatusHud);
      return;
    }
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (mountStatusControl() || tries > 40) clearInterval(timer);
    }, 250);
  }

  window.KioskAudioOutput = {
    STORAGE_KEY: STORAGE_KEY,
    SETTINGS_PAGE: SETTINGS_PAGE,
    DEFAULT_PIN: DEFAULT_PIN,
    supportsSinkId: supportsSinkId,
    hasCustomSink: hasCustomSink,
    resolveLiveSinkId: resolveLiveSinkId,
    getSinkId: getSinkId,
    getSinkLabel: getSinkLabel,
    setSink: setSink,
    clearSink: clearSink,
    applyToElement: applyToElement,
    applySinkToContext: applySinkToContext,
    getAudioContext: getAudioContext,
    ensureOutputPermission: ensureOutputPermission,
    prepareForPlayback: prepareForPlayback,
    playRouted: playRouted,
    stopRouted: stopRouted,
    listOutputDevices: listOutputDevices,
    playTestTone: playTestTone,
    settingsHref: settingsHref,
    mountStatusControl: mountStatusControl,
    updateStatusControlLabel: updateStatusControlLabel,
    promptPin: promptPin,
    requirePinThen: requirePinThen,
    gateSettingsPage: gateSettingsPage,
    isTechUnlocked: isTechUnlocked,
    getConfiguredPin: getConfiguredPin
  };

  watchStatusHud();

  window.addEventListener('kiosk-audio-output-changed', function () {
    updateStatusControlLabel();
  });

  // Eagerly re-resolve saved USB/device sink on every page (deviceId can change).
  if (hasCustomSink()) {
    resolveLiveSinkId()
      .then(function (id) {
        updateStatusControlLabel();
        if (!id) return;
        return ensureOutputPermission();
      })
      .catch(function () {});

    var warmOnce = function () {
      window.removeEventListener('pointerdown', warmOnce, true);
      window.removeEventListener('keydown', warmOnce, true);
      window.removeEventListener('kb-activity', warmOnce);
      prepareForPlayback().catch(function () {});
    };
    window.addEventListener('pointerdown', warmOnce, true);
    window.addEventListener('keydown', warmOnce, true);
    window.addEventListener('kb-activity', warmOnce);
  }
})();
