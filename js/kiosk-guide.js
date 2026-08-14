/**
 * Centralized English phrase generation + navigation announcements.
 * Generates/caches all known clips at page start via SpeechEngine,
 * then speaks from cache as the user moves through the kiosk.
 */
(function () {
  'use strict';

  var lastCategory = null;
  var lastFocusKey = null;
  var lastAnnouncedEl = null;
  var announceTimer = null;
  var cartAudioReady = false;
  var cartAudioPromise = null;

  var CATEGORY_BY_INDEX = ['Burgers', 'Beer', 'Wine'];

  /** Mirrors demo-products.js so every page can pre-generate the same clips. */
  var CATALOG = {
    burgers: [
      { name: 'Classic', price: 3.95 },
      { name: 'Double', price: 4.95 },
      { name: 'Chicken', price: 3.5 }
    ],
    beer: [
      { name: 'Kellerbier', price: 2.5 },
      { name: 'Naturradler', price: 2.5 },
      { name: 'Malzbier', price: 2.5 }
    ],
    wine: [
      { name: 'Chardonnay', price: 8.99 },
      { name: 'Blanc de Noir', price: 8.99 },
      { name: 'Sauvignon Blanc', price: 8.99 },
      { name: 'Spaet- burgunder Rose', price: 8.99 }
    ]
  };

  function moneySpeak(n) {
    var euros = Math.floor(n);
    var cents = Math.round((n - euros) * 100);
    if (cents === 0) return euros + (euros === 1 ? ' euro' : ' euros');
    if (cents < 10) return euros + ' euros 0' + cents;
    return euros + ' euros ' + cents;
  }

  /** Money as reusable clips: ["8", "euros", "50"] */
  function moneyParts(n) {
    var euros = Math.floor(n);
    var cents = Math.round((n - euros) * 100);
    var parts = [String(euros), euros === 1 ? 'euro' : 'euros'];
    if (cents > 0) parts.push(String(cents));
    return parts;
  }

  var CartStems = {
    decreaseOf: 'Decrease quantity of',
    increaseOf: 'Increase quantity of',
    currentQuantity: 'Current quantity',
    quantity: 'quantity',
    addedToCart: 'added to cart',
    removedFromCart: 'removed from cart',
    cartOpened: 'Cart opened',
    cartEmpty: 'Cart is empty',
    item: 'item',
    items: 'items',
    total: 'Total',
    openCart: 'Open cart',
    closeCart: 'Close cart',
    finishPurchase: 'Finish purchase'
  };

  var Phrases = {
    welcome: function () {
      return 'Welcome to Burgers Forever. Press Enter to start ordering.';
    },
    startOrder: function () {
      return 'Press here to order.';
    },
    menuReady: function () {
      return 'Product menu.';
    },
    category: function (name) {
      return name + '.';
    },
    product: function (name, price) {
      return name + ', ' + moneySpeak(price) + '.';
    },
    productFocus: function (category, name, price) {
      return category + '. ' + name + ', ' + moneySpeak(price) + '.';
    },
    /** Cart clips are arrays of reusable segments. */
    added: function (name) {
      return [name, CartStems.addedToCart];
    },
    cartOpen: function (count, total) {
      if (!count) return [CartStems.cartOpened, CartStems.cartEmpty];
      return [CartStems.cartOpened, String(count), count === 1 ? CartStems.item : CartStems.items, CartStems.total].concat(
        moneyParts(total)
      );
    },
    cartButton: function (count) {
      if (!count) return [CartStems.openCart];
      return [CartStems.openCart, String(count), count === 1 ? CartStems.item : CartStems.items];
    },
    closeCart: function () {
      return [CartStems.closeCart];
    },
    finishPurchase: function (total) {
      if (typeof total !== 'number') return [CartStems.finishPurchase];
      return [CartStems.finishPurchase, CartStems.total].concat(moneyParts(total));
    },
    cartItem: function (name, qty, lineTotal) {
      var parts = [name, CartStems.quantity, String(qty)];
      if (typeof lineTotal === 'number') {
        // Short breath between quantity and price while browsing cart lines
        parts.push({ pauseMs: 300 });
        parts = parts.concat(moneyParts(lineTotal));
      }
      return parts;
    },
    qtyIncrease: function (name, qty) {
      if (!name) return [CartStems.increaseOf];
      var parts = [CartStems.increaseOf, name];
      if (typeof qty === 'number') parts.push(CartStems.currentQuantity, String(qty));
      return parts;
    },
    qtyDecrease: function (name, qty) {
      if (!name) return [CartStems.decreaseOf];
      var parts = [CartStems.decreaseOf, name];
      if (typeof qty === 'number') parts.push(CartStems.currentQuantity, String(qty));
      return parts;
    },
    qtyChanged: function (name, qty) {
      return [name, CartStems.quantity, String(qty)];
    },
    removedFromCart: function (name) {
      return [name, CartStems.removedFromCart];
    },
    orderConfirmed: function () {
      return (
        'Your order has been completed successfully using the kiosk accessibility feature. ' +
        'To restart the demo, please select the button below.'
      );
    },
    anotherPurchase: function () {
      return 'Make another purchase.';
    },
    volume: function (level) {
      if (typeof level === 'number') return 'Volume ' + Math.round(level * 100) + ' percent.';
      return 'Volume.';
    }
  };

  function catalogPhrases() {
    // Product-menu clips only. Cart stems / qty digits warm when the cart opens.
    var list = [
      Phrases.welcome(),
      Phrases.startOrder(),
      Phrases.menuReady(),
      Phrases.orderConfirmed(),
      Phrases.anotherPurchase(),
      Phrases.volume(),
      Phrases.volume(1),
      Phrases.volume(0.85),
      Phrases.volume(0.7),
      Phrases.volume(0.55),
      Phrases.volume(0.4),
      Phrases.volume(0.25),
      Phrases.volume(0.1)
    ];

    CATEGORY_BY_INDEX.forEach(function (cat) {
      list.push(Phrases.category(cat));
    });

    var products = (window.DemoStore && window.DemoStore.PRODUCTS) || CATALOG;
    if (products) {
      Object.keys(products).forEach(function (key) {
        var catName =
          key === 'burgers' ? 'Burgers' : key === 'beer' ? 'Beer' : key === 'wine' ? 'Wine' : key;
        products[key].forEach(function (p) {
          list.push(p.name);
          list.push(Phrases.product(p.name, p.price));
          list.push(Phrases.productFocus(catName, p.name, p.price));
        });
      });
    }

    return list;
  }

  /** Pre-generate when the cart menu opens: stems, qty digits 1–10, and money clips for qty 1–10. */
  function cartMenuClips() {
    var list = [];
    var seen = Object.create(null);
    function add(clip) {
      if (!clip || seen[clip]) return;
      seen[clip] = true;
      list.push(clip);
    }

    Object.keys(CartStems).forEach(function (k) {
      add(CartStems[k]);
    });
    add('euro');
    add('euros');

    // Quantity digits — must be cached before Left/Right qty changes
    for (var q = 1; q <= 10; q++) {
      add(String(q));
    }

    var products = (window.DemoStore && window.DemoStore.PRODUCTS) || CATALOG;
    if (products) {
      Object.keys(products).forEach(function (key) {
        products[key].forEach(function (p) {
          add(p.name);
          for (var qty = 1; qty <= 10; qty++) {
            moneyParts(p.price * qty).forEach(add);
          }
        });
      });
    }

    if (window.DemoStore && typeof window.DemoStore.getCart === 'function') {
      window.DemoStore.getCart().forEach(function (item) {
        add(item.name);
        for (var qty = 1; qty <= 10; qty++) {
          moneyParts(item.price * qty).forEach(add);
          add(String(qty));
        }
      });
    }

    return list;
  }

  function categoryForProductEl(el) {
    var list = el && el.closest && el.closest('.w-dyn-items');
    if (!list) return null;
    var lists = document.querySelectorAll('.productsmaincontainer .w-dyn-items');
    for (var i = 0; i < lists.length; i++) {
      if (lists[i] === list) return CATEGORY_BY_INDEX[i] || null;
    }
    return null;
  }

  function productInfo(el) {
    if (!el || !el.classList.contains('productcontainer')) return null;
    var nameEl = el.querySelector('.productnaam');
    var priceEl = el.querySelector('.productprijs');
    var name = nameEl ? nameEl.textContent.trim() : '';
    var priceText = priceEl ? priceEl.textContent.trim() : '';
    var price = 0;
    var match = priceText.replace(/\s/g, '').match(/([\d]+)[,.]([\d]{2})/);
    if (match) price = parseInt(match[1], 10) + parseInt(match[2], 10) / 100;
    var category = categoryForProductEl(el);
    return { name: name, price: price, category: category };
  }

  function announce(text, opts) {
    opts = opts || {};
    if (!window.SpeechEngine) return;
    var empty = !text || (Array.isArray(text) && !text.length);
    if (empty) return;
    if (announceTimer) {
      clearTimeout(announceTimer);
      announceTimer = null;
    }
    var delay = opts.immediate ? 0 : 90;
    announceTimer = setTimeout(function () {
      announceTimer = null;
      // Default: do not barge in — finish current clip; button presses call interrupt().
      window.SpeechEngine.speak(text, opts.interrupt ? { interrupt: true } : undefined);
    }, delay);
  }

  /** Speak only after cart qty digits / money clips are cached (no generate pause). */
  function announceCart(text, opts) {
    if (cartAudioReady) {
      announce(text, opts);
      return;
    }
    warmCartAudio().then(function () {
      announce(text, opts);
    });
  }

  function warmCartAudio() {
    if (cartAudioReady) return Promise.resolve();
    if (cartAudioPromise) return cartAudioPromise;
    var clips = cartMenuClips();
    if (window.console && console.info) {
      console.info(
        '[kiosk-guide] warming cart audio:',
        clips.length,
        'clips (stems + qty 1–10 + line totals)'
      );
    }
    cartAudioPromise = window.SpeechEngine.ensureClips(clips).then(function () {
      cartAudioReady = true;
      cartAudioPromise = null;
      if (window.console && console.info) {
        console.info('[kiosk-guide] cart audio ready — qty 1–10 served from cache');
      }
    });
    return cartAudioPromise;
  }

  function cartItemFromEl(el) {
    if (!el) return null;
    var line = el.classList.contains('demo-cart-line')
      ? el
      : el.closest && el.closest('.demo-cart-line');
    if (!line) return null;

    var id = line.getAttribute('data-id') || el.getAttribute('data-id');
    var name = line.getAttribute('data-name') || el.getAttribute('data-name') || '';
    var qty = parseInt(line.getAttribute('data-qty') || el.getAttribute('data-qty') || '0', 10);
    var price = parseFloat(line.getAttribute('data-price') || '0');

    // Prefer live cart state when available
    if (window.DemoStore && typeof window.DemoStore.getCart === 'function') {
      var live = window.DemoStore.getCart().find(function (item) {
        return item.id === id;
      });
      if (live) {
        name = live.name;
        qty = live.qty;
        price = live.price;
      }
    }

    if (!name) {
      var strong = line.querySelector('strong');
      if (strong) name = strong.textContent.trim();
    }

    return {
      id: id,
      name: name,
      qty: qty,
      price: price,
      lineTotal: price * qty
    };
  }

  function announceFocus(el) {
    if (!el) return;

    // Returning from Close/Finish (or any other control) must re-announce the
    // cart line even when id+qty are unchanged — lastFocusKey alone is not enough.
    var elChanged = el !== lastAnnouncedEl;
    lastAnnouncedEl = el;

    if (el.classList.contains('startorderbtn')) {
      var page = (location.pathname || '').split('/').pop() || '';
      lastFocusKey = 'start|' + page;
      if (page.indexOf('thank-you') !== -1) {
        // Completion phrase is spoken on Finish purchase; do not also say
        // "Make another purchase" / old order-confirmed lines here.
        try {
          if (sessionStorage.getItem('kiosk-order-confirmed-spoken') === '1') {
            sessionStorage.removeItem('kiosk-order-confirmed-spoken');
            return;
          }
        } catch (e) {
          /* ignore */
        }
        announce(Phrases.orderConfirmed());
      } else {
        announce(Phrases.startOrder());
      }
      return;
    }

    if (el.classList.contains('cart-button')) {
      var count =
        (window.DemoStore && window.DemoStore.cartCount && window.DemoStore.cartCount()) || 0;
      lastFocusKey = 'open-cart|' + count;
      announce(Phrases.cartButton(count));
      return;
    }

    if (el.classList.contains('close-button')) {
      lastFocusKey = 'cart-close';
      announceCart(Phrases.closeCart());
      return;
    }

    if (el.classList.contains('checkoutbtn')) {
      var total =
        (window.DemoStore && window.DemoStore.cartTotal && window.DemoStore.cartTotal()) || 0;
      lastFocusKey = 'cart-checkout|' + total;
      announceCart(Phrases.finishPurchase(total));
      return;
    }

    if (el.classList.contains('demo-cart-line')) {
      var lineItem = cartItemFromEl(el);
      if (lineItem && lineItem.name) {
        var lineKey = 'cart-line|' + lineItem.id + '|' + lineItem.qty;
        if (!elChanged && lineKey === lastFocusKey) return;
        lastFocusKey = lineKey;
        announceCart(Phrases.cartItem(lineItem.name, lineItem.qty, lineItem.lineTotal));
      }
      return;
    }

    if (el.classList.contains('demo-qty-btn')) {
      var action = el.getAttribute('data-action');
      var qtyItem = cartItemFromEl(el);
      var name = (qtyItem && qtyItem.name) || el.getAttribute('data-name') || '';
      var qty = qtyItem ? qtyItem.qty : parseInt(el.getAttribute('data-qty') || '0', 10);
      var qtyKey = 'cart-qty|' + (qtyItem && qtyItem.id) + '|' + action + '|' + qty;
      if (!elChanged && qtyKey === lastFocusKey) return;
      lastFocusKey = qtyKey;
      announceCart(
        action === 'inc' ? Phrases.qtyIncrease(name, qty) : Phrases.qtyDecrease(name, qty)
      );
      return;
    }

    var info = productInfo(el);
    if (info && info.name) {
      var key = (info.category || '') + '|' + info.name + '|' + info.price;
      if (!elChanged && key === lastFocusKey) return;
      lastFocusKey = key;

      if (info.category && info.category !== lastCategory) {
        lastCategory = info.category;
        announce(Phrases.productFocus(info.category, info.name, info.price));
      } else {
        announce(Phrases.product(info.name, info.price));
      }
    }
  }

  function onKbFocus(event) {
    announceFocus(event.detail && event.detail.el);
  }

  function onCartAdd(event) {
    lastFocusKey = null;
    lastAnnouncedEl = null;
    var product = event.detail && event.detail.product;
    if (product && product.name) announce(Phrases.added(product.name), { immediate: true });
  }

  function onCartOpen(event) {
    lastFocusKey = null;
    lastAnnouncedEl = null;
    cartAudioReady = false;
    cartAudioPromise = null;
    var detail = event.detail || {};
    var phrase = Phrases.cartOpen(detail.count || 0, detail.total || 0);
    warmCartAudio().then(function () {
      announce(phrase, { immediate: true });
    });
  }

  function onCartClose() {
    lastFocusKey = null;
    lastAnnouncedEl = null;
    setTimeout(function () {
      var focused = document.querySelector('.kb-focused');
      if (focused) announceFocus(focused);
    }, 120);
  }

  function onCartQty(event) {
    lastFocusKey = null;
    lastAnnouncedEl = null;
    var detail = event.detail || {};
    if (detail.removed && detail.name) {
      announceCart(Phrases.removedFromCart(detail.name), { immediate: true });
      return;
    }
    // Focus is restored onto the cart line; kb-focus announces via announceCart (cached qty).
  }

  function pageBootPhrase() {
    var page = (location.pathname || '').split('/').pop() || 'index.html';
    if (!page || page === '/' || page === 'index.html') return Phrases.welcome();
    if (page.indexOf('products') !== -1) return Phrases.menuReady();
    if (page.indexOf('thank-you') !== -1) {
      // Already spoken on Finish purchase (user-gesture + sink routing).
      try {
        if (sessionStorage.getItem('kiosk-order-confirmed-spoken') === '1') {
          // Keep flag until focus handler clears it, so start-button focus stays silent.
          return null;
        }
      } catch (e) {
        /* ignore */
      }
      return Phrases.orderConfirmed();
    }
    return null;
  }

  function init() {
    if (!window.SpeechEngine) {
      console.warn('[kiosk-guide] SpeechEngine missing');
      return;
    }

    window.addEventListener('kb-focus', onKbFocus);
    window.addEventListener('demo-cart-add', onCartAdd);
    window.addEventListener('demo-cart-open', onCartOpen);
    window.addEventListener('demo-cart-close', onCartClose);
    window.addEventListener('demo-cart-qty', onCartQty);

    var phrases = catalogPhrases();
    var boot = pageBootPhrase();
    if (boot) phrases.push(boot);

    window.SpeechEngine.warmup(phrases).then(function (result) {
      if (boot) announce(boot, { immediate: true });
      // After menu announcement, speak current focus once ready
      if ((location.pathname || '').indexOf('products') !== -1) {
        // Prefetch qty digits early so the first cart Left/Right has no generate pause
        window.SpeechEngine.ensureClips([
          '1',
          '2',
          '3',
          '4',
          '5',
          '6',
          '7',
          '8',
          '9',
          '10',
          'euro',
          'euros'
        ]);
        setTimeout(function () {
          var focused = document.querySelector('.kb-focused');
          if (focused) announceFocus(focused);
        }, 700);
      }
      if (result) {
        console.info('[kiosk-guide] speech ready via', result.backend, 'cached', result.cached);
      }
    });
  }

  window.KioskGuide = {
    Phrases: Phrases,
    announce: announce,
    catalogPhrases: catalogPhrases,
    cartMenuClips: cartMenuClips
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
