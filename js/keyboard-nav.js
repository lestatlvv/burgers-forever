/**
 * Kiosk spatial keyboard navigation.
 * Arrow keys / Enter map to logical commands (UP/DOWN/LEFT/RIGHT/SELECT).
 * VOLUME uses the development fallback key "V".
 *
 * Product cards are the nav targets (not absolute-positioned Add buttons),
 * because those buttons share one containing block and stack on screen.
 */
(function () {
  'use strict';

  var FOCUS_CLASS = 'kb-focused';
  /** Raw key → logical command. Storm Pad codes should only be added here. */
  var KEY_TO_COMMAND = {
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
    ArrowLeft: 'LEFT',
    ArrowRight: 'RIGHT',
    Enter: 'SELECT',
    Up: 'UP',
    Down: 'DOWN',
    Left: 'LEFT',
    Right: 'RIGHT',
    NumpadEnter: 'SELECT',
    v: 'VOLUME',
    V: 'VOLUME'
  };

  var COMMAND_TO_DIR = {
    UP: 'up',
    DOWN: 'down',
    LEFT: 'left',
    RIGHT: 'right'
  };

  var volumeLevel = 1;
  var volumeHud = null;
  var volumeHideTimer = null;
  var VOLUME_SHOW_MS = 2500;

  // Prefer whole product cards over nested absolute buttons
  var SELECTOR = [
    '.productcontainer[data-kb-item]',
    'a.startorderbtn',
    'a.screen-01',
    'a.cart-button',
    'a.close-button',
    'a.checkoutbtn',
    '.demo-cart-line[data-kb-item]',
    'button.demo-qty-btn',
    '[data-kb-item]:not(.productcontainer):not(.demo-cart-line)',
    'a.w-button:not(.add-to-basket)'
  ].join(',');

  var current = null;
  var quietUntil = 0;
  var refreshTimer = null;

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    var rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  function cartWrapper() {
    return document.querySelector('.w-commerce-commercecartcontainerwrapper');
  }

  function cartIsOpen() {
    var wrap = cartWrapper();
    return !!(wrap && isVisible(wrap));
  }

  function isInOpenCart(el) {
    var wrap = cartWrapper();
    return !!(wrap && wrap.contains(el) && isVisible(wrap));
  }

  function collectItems() {
    var open = cartIsOpen();
    var nodes = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
    var items = [];
    var seen = [];

    nodes.forEach(function (el) {
      if (!isVisible(el)) return;
      if (open) {
        if (!isInOpenCart(el)) return;
        // Cart menu uses whole product rows; qty is adjusted with Left/Right on the row
        if (el.classList.contains('demo-qty-btn')) return;
      } else if (
        el.classList.contains('close-button') ||
        el.classList.contains('checkoutbtn') ||
        el.classList.contains('demo-qty-btn') ||
        el.classList.contains('demo-cart-line')
      ) {
        return;
      }
      // Skip nested actionable children when the product card itself is a target
      if (el.closest && el.closest('.productcontainer[data-kb-item]') && !el.classList.contains('productcontainer')) {
        return;
      }
      if (seen.indexOf(el) !== -1) return;
      seen.push(el);
      items.push(el);
    });

    return items;
  }

  function bounds(el) {
    var rect = el.getBoundingClientRect();
    return {
      el: el,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      w: rect.width,
      h: rect.height
    };
  }

  function clearFocus() {
    quietUntil = Date.now() + 80;
    var focused = document.querySelectorAll('.' + FOCUS_CLASS);
    for (var i = 0; i < focused.length; i++) {
      focused[i].classList.remove(FOCUS_CLASS);
      focused[i].removeAttribute('aria-current');
    }
    current = null;
  }

  function setFocus(el, opts) {
    if (!el) return;
    opts = opts || {};
    if (current === el && el.classList.contains(FOCUS_CLASS) && !opts.force) {
      return;
    }

    quietUntil = Date.now() + 80;
    var focused = document.querySelectorAll('.' + FOCUS_CLASS);
    for (var i = 0; i < focused.length; i++) {
      focused[i].classList.remove(FOCUS_CLASS);
      focused[i].removeAttribute('aria-current');
    }

    current = el;
    el.classList.add(FOCUS_CLASS);
    el.setAttribute('aria-current', 'true');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');

    if (typeof el.focus === 'function') {
      try {
        el.focus({ preventScroll: true });
      } catch (e) {
        el.focus();
      }
    }

    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }

    window.dispatchEvent(new CustomEvent('kb-activity'));
    window.dispatchEvent(
      new CustomEvent('kb-focus', {
        detail: { el: el, force: !!opts.force }
      })
    );
  }

  function defaultFocusTarget(items) {
    // When the cart opens, land on Finish purchase — not the exit/close control
    if (cartIsOpen()) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].classList.contains('checkoutbtn')) return items[i];
      }
    }
    return items[0];
  }

  function ensureFocus() {
    var items = collectItems();
    if (!items.length) {
      clearFocus();
      return;
    }
    if (current && items.indexOf(current) !== -1 && isVisible(current)) {
      if (!current.classList.contains(FOCUS_CLASS)) setFocus(current, { force: true });
      return;
    }
    setFocus(defaultFocusTarget(items), { force: true });
  }

  function overlap(a1, a2, b1, b2) {
    return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  }

  function isProductCard(el) {
    return !!(el && el.classList && el.classList.contains('productcontainer'));
  }

  function isCartControl(el) {
    return !!(el && el.classList && el.classList.contains('cart-button'));
  }

  function isCartLine(el) {
    return !!(el && el.classList && el.classList.contains('demo-cart-line'));
  }

  /**
   * Cart menu vertical order (top → bottom): Close → product lines → Finish purchase.
   * Up/Down walk this list linearly (DOM/role order — not fragile pixel Y).
   */
  function cartMenuOrder() {
    var items = collectItems();
    var closeBtns = [];
    var lines = [];
    var finishBtns = [];
    var other = [];

    items.forEach(function (el) {
      if (el.classList.contains('close-button')) closeBtns.push(el);
      else if (el.classList.contains('demo-cart-line')) lines.push(el);
      else if (el.classList.contains('checkoutbtn')) finishBtns.push(el);
      else other.push(el);
    });

    lines.sort(function (a, b) {
      var pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return closeBtns.concat(lines, finishBtns, other);
  }

  function findInCartMenu(direction) {
    var items = cartMenuOrder();
    if (!items.length) return null;
    if (!current || items.indexOf(current) === -1) return defaultFocusTarget(items);

    var idx = items.indexOf(current);
    // Wrap: Close + Up → Finish purchase; Finish + Down → Close
    if (direction === 'up') return items[(idx - 1 + items.length) % items.length];
    if (direction === 'down') return items[(idx + 1) % items.length];
    return null;
  }

  /** Left = decrease, Right = increase for the focused cart product row. */
  function adjustFocusedCartLineQty(direction) {
    if (!isCartLine(current)) return false;
    var id = current.getAttribute('data-id');
    if (!id) return false;

    var delta = direction === 'right' ? 1 : direction === 'left' ? -1 : 0;
    if (!delta) return false;

    if (window.DemoStore && typeof window.DemoStore.changeQty === 'function') {
      window.DemoStore.changeQty(id, delta);
      return true;
    }

    var action = delta > 0 ? 'inc' : 'dec';
    var btn = current.querySelector('.demo-qty-btn[data-action="' + action + '"]');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  /**
   * Score one candidate in a travel direction. Returns Infinity if invalid.
   * sameColumnOnly: for up/down product→product moves, require real column overlap
   * so the floating cart cannot steal focus from BBQ above Stout.
   */
  function scoreCandidate(from, el, direction, sameColumnOnly) {
    if (el === current) return Infinity;
    var to = bounds(el);
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var primary;
    var secondary;
    var axisOverlap;

    if (direction === 'left') {
      if (!(to.right < from.left + from.w * 0.35 || dx < -8)) return Infinity;
      if (dx >= 0 && to.right >= from.left) return Infinity;
      primary = from.x - to.x;
      if (primary < 0) primary = from.left - to.right;
      if (primary < 0) return Infinity;
      secondary = Math.abs(dy);
      axisOverlap = overlap(from.top, from.bottom, to.top, to.bottom);
    } else if (direction === 'right') {
      if (!(to.left > from.right - from.w * 0.35 || dx > 8)) return Infinity;
      if (dx <= 0 && to.left <= from.right) return Infinity;
      primary = to.x - from.x;
      if (primary < 0) primary = to.left - from.right;
      if (primary < 0) return Infinity;
      secondary = Math.abs(dy);
      axisOverlap = overlap(from.top, from.bottom, to.top, to.bottom);
    } else if (direction === 'up') {
      // Must be visually above the current card (not merely nearer on X).
      if (to.bottom > from.top + 4 && dy >= -2) return Infinity;
      if (dy >= 0 && to.bottom >= from.top) return Infinity;
      primary = from.y - to.y;
      if (primary < 0) primary = from.top - to.bottom;
      if (primary < 0) return Infinity;
      secondary = Math.abs(dx);
      axisOverlap = overlap(from.left, from.right, to.left, to.right);
      if (sameColumnOnly && axisOverlap < Math.min(from.w, to.w) * 0.35) return Infinity;
    } else if (direction === 'down') {
      if (to.top < from.bottom - 4 && dy <= 2) return Infinity;
      if (dy <= 0 && to.top <= from.bottom) return Infinity;
      primary = to.y - from.y;
      if (primary < 0) primary = to.top - from.bottom;
      if (primary < 0) return Infinity;
      secondary = Math.abs(dx);
      axisOverlap = overlap(from.left, from.right, to.left, to.right);
      if (sameColumnOnly && axisOverlap < Math.min(from.w, to.w) * 0.35) return Infinity;
    } else {
      return Infinity;
    }

    var alignBonus = axisOverlap > 8 ? -Math.min(axisOverlap, 200) : secondary * 2;
    return primary * 10 + secondary + alignBonus;
  }

  function pickBest(items, direction, filterFn, sameColumnOnly) {
    if (!current) return null;
    var from = bounds(current);
    var best = null;
    var bestScore = Infinity;

    items.forEach(function (el) {
      if (filterFn && !filterFn(el)) return;
      var score = scoreCandidate(from, el, direction, sameColumnOnly);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    });

    return best;
  }

  /**
   * Projective spatial search.
   * From a product card, up/down stay in the product grid first (same column),
   * so Stout + Up reaches BBQ instead of the floating cart button.
   * Inside the open cart menu, Up/Down use a dedicated linear list.
   */
  function findInDirection(direction) {
    if (cartIsOpen()) {
      return findInCartMenu(direction);
    }

    var items = collectItems();
    if (!items.length) return null;
    if (!current || items.indexOf(current) === -1) return items[0];

    var vertical = direction === 'up' || direction === 'down';

    if (vertical && isProductCard(current)) {
      // 1) Same-column product above/below (BBQ ← Stout, Stout ← Rosé, etc.)
      var columnPeer = pickBest(items, direction, isProductCard, true);
      if (columnPeer) return columnPeer;

      // 2) Any product in that vertical direction
      var anyProduct = pickBest(items, direction, isProductCard, false);
      if (anyProduct) return anyProduct;

      // 3) Only then allow cart / other controls (e.g. Down from bottom row)
      return pickBest(items, direction, null, false);
    }

    // From cart, Up should return to the nearest product above — never skip the grid
    if (vertical && isCartControl(current)) {
      var productAboveOrBelow = pickBest(items, direction, isProductCard, false);
      if (productAboveOrBelow) return productAboveOrBelow;
    }

    return pickBest(items, direction, null, false);
  }

  function activate(el) {
    if (!el) return;
    window.dispatchEvent(new CustomEvent('kb-activity'));

    // Cart product row: Left/Right change qty — Enter does not dive into +/- controls
    if (el.classList.contains('demo-cart-line')) {
      return;
    }

    if (el.classList.contains('productcontainer')) {
      var addBtn =
        el.querySelector('a.add-to-basket') ||
        el.querySelector('input[type="submit"]') ||
        el.querySelector('button');
      if (addBtn) {
        addBtn.click();
        return;
      }
    }

    el.click();
  }

  function ensureVolumeHud() {
    if (volumeHud) return volumeHud;
    if (!document.body) return null;
    volumeHud = document.createElement('div');
    volumeHud.id = 'kiosk-volume-status';
    volumeHud.className = 'kiosk-volume-status';
    volumeHud.setAttribute('aria-hidden', 'true');
    volumeHud.hidden = true;
    volumeHud.setAttribute(
      'style',
      'position:fixed;left:40px;bottom:18px;z-index:2147483646;' +
        'padding:2px 5px;border:0;background:transparent;' +
        'color:rgba(30,32,38,0.55);font:500 12px/1.2 ui-monospace,Consolas,monospace;' +
        'white-space:nowrap;pointer-events:none;user-select:none;'
    );
    document.body.appendChild(volumeHud);
    return volumeHud;
  }

  function showVolumeStatus(level) {
    var el = ensureVolumeHud();
    if (!el) return;
    var pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
    el.textContent = '🔊' + pct;
    el.hidden = false;
    el.classList.add('is-visible');
    if (volumeHideTimer) clearTimeout(volumeHideTimer);
    volumeHideTimer = setTimeout(function () {
      el.classList.remove('is-visible');
      el.hidden = true;
      volumeHideTimer = null;
    }, VOLUME_SHOW_MS);
  }

  function applyVolume() {
    var pct = Math.round(volumeLevel * 100) - 15;
    if (pct < 10) pct = 100;
    volumeLevel = pct / 100;
    document.documentElement.style.setProperty('--kiosk-speech-volume', String(volumeLevel));
    showVolumeStatus(volumeLevel);
    if (window.KioskGuide && window.KioskGuide.Phrases && window.SpeechEngine) {
      window.SpeechEngine.speak(window.KioskGuide.Phrases.volume(volumeLevel));
    }
  }

  /** Splash / home screen: only the start-order CTA is active. */
  function isStartScreen() {
    var page = (location.pathname || '').split('/').pop() || 'index.html';
    if (page === '' || page === '/' || page === 'index.html') return true;
    var start = document.querySelector('a.startorderbtn');
    return !!(start && isVisible(start) && !document.querySelector('.productsmain'));
  }

  function goToMenuFromStart() {
    var startBtn = document.querySelector('a.startorderbtn');
    if (startBtn) {
      activate(startBtn);
      return;
    }
    window.location.href = 'products.html';
  }

  /** Consume a logical command (keyboard or future Storm adapter). */
  function handleCommand(command) {
    window.dispatchEvent(new CustomEvent('kb-activity'));

    // Customer button press: stop the current announcement immediately.
    if (window.SpeechEngine && typeof window.SpeechEngine.interrupt === 'function') {
      window.SpeechEngine.interrupt();
    }

    if (command === 'VOLUME') {
      applyVolume();
      window.dispatchEvent(
        new CustomEvent('kb-command', {
          detail: { command: command, level: volumeLevel, speechHandled: true }
        })
      );
      return;
    }

    window.dispatchEvent(
      new CustomEvent('kb-command', {
        detail: { command: command, speechHandled: true }
      })
    );

    // Start screen: any pad button (Up/Down/Left/Right/Enter) opens the menu
    if (
      isStartScreen() &&
      (command === 'SELECT' || command === 'UP' || command === 'DOWN' || command === 'LEFT' || command === 'RIGHT')
    ) {
      goToMenuFromStart();
      return;
    }

    if (command === 'SELECT') {
      if (!current || !isVisible(current)) ensureFocus();
      activate(current);
      return;
    }

    var direction = COMMAND_TO_DIR[command];
    if (!direction) return;

    if (!current || collectItems().indexOf(current) === -1) {
      ensureFocus();
    }

    // Cart product row: Left/Right adjust quantity instead of moving focus
    if (cartIsOpen() && (direction === 'left' || direction === 'right')) {
      if (adjustFocusedCartLineQty(direction)) return;
    }

    var next = findInDirection(direction);
    if (next) setFocus(next);
  }

  function onKeyDown(event) {
    var command = KEY_TO_COMMAND[event.key];
    if (!command) return;

    var tag = (event.target && event.target.tagName) || '';
    var type = event.target && event.target.type;
    if (
      (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') &&
      type !== 'submit' &&
      type !== 'button'
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleCommand(command);
  }

  function scheduleRefresh() {
    if (Date.now() < quietUntil) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      if (Date.now() < quietUntil) return;
      ensureFocus();
    }, 50);
  }

  function init() {
    document.documentElement.classList.add('kb-nav-enabled');
    document.addEventListener('keydown', onKeyDown, true);

    // Only react to structural DOM changes — not our own focus class toggles
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          scheduleRefresh();
          return;
        }
        if (m.type === 'attributes' && m.attributeName === 'style') {
          scheduleRefresh();
          return;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style']
    });

    // Wait a tick so demo-products can mark cards
    setTimeout(ensureFocus, 0);
    setTimeout(ensureFocus, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.KeyboardNav = {
    refresh: ensureFocus,
    focus: setFocus,
    clear: clearFocus,
    items: collectItems,
    command: handleCommand,
    volumeLevel: function () {
      return volumeLevel;
    }
  };
})();
