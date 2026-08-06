/**
 * Local demo catalog + cart so the kiosk flow works without Webflow CMS/Ecommerce.
 */
(function () {
  'use strict';

  /** Catalog mirrors https://burgers-forever.webflow.io/products (CMS export). */
  var CATEGORY_STYLE = {
    burgers: { color: '#f194b3', imgWidth: 120, beerLike: false },
    beer: { color: '#f5b789', imgWidth: 42, beerLike: true },
    wine: { color: '#a5b7dc', imgWidth: 42, beerLike: true }
  };

  var PRODUCTS = {
    burgers: [
      { id: 'b1', name: 'Classic', price: 3.95, image: 'images/products/classic.png' },
      { id: 'b2', name: 'Double', price: 4.95, image: 'images/products/double.png' },
      { id: 'b3', name: 'Chicken', price: 3.5, image: 'images/products/chicken.png' }
    ],
    beer: [
      { id: 'd1', name: 'Kellerbier', price: 2.5, image: 'images/products/kellerbier.png' },
      { id: 'd2', name: 'Naturradler', price: 2.5, image: 'images/products/naturradler.png' },
      { id: 'd3', name: 'Malzbier', price: 2.5, image: 'images/products/malzbier.png' }
    ],
    wine: [
      { id: 'w1', name: 'Chardonnay', price: 8.99, image: 'images/products/chardonnay.png' },
      { id: 'w2', name: 'Blanc de Noir', price: 8.99, image: 'images/products/blanc-de-noir.png' },
      { id: 'w3', name: 'Sauvignon Blanc', price: 8.99, image: 'images/products/sauvignon-blanc.png' },
      { id: 'w4', name: 'Spaet- burgunder Rose', price: 8.99, image: 'images/products/spaetburgunder-rose.png' }
    ]
  };

  var cart = [];

  function money(n) {
    return '€\u00a0' + n.toFixed(2) + '\u00a0EUR';
  }

  function formatCartLine(item) {
    var label = item.name + ', quantity ' + item.qty;
    return (
      '<div class="demo-cart-line" data-id="' +
      item.id +
      '" data-name="' +
      escapeAttr(item.name) +
      '" data-qty="' +
      item.qty +
      '" data-price="' +
      item.price +
      '" data-kb-item tabindex="0" role="listitem" aria-label="' +
      escapeAttr(label) +
      '">' +
      '<div class="demo-cart-line-main">' +
      '<strong>' +
      item.name +
      '</strong>' +
      '<span>' +
      money(item.price * item.qty) +
      '</span>' +
      '</div>' +
      '<div class="demo-cart-line-qty">' +
      '<button type="button" class="demo-qty-btn" data-action="dec" data-id="' +
      item.id +
      '" data-name="' +
      escapeAttr(item.name) +
      '" data-qty="' +
      item.qty +
      '" data-kb-item aria-label="Decrease quantity of ' +
      escapeAttr(item.name) +
      '">−</button>' +
      '<span>' +
      item.qty +
      '</span>' +
      '<button type="button" class="demo-qty-btn" data-action="inc" data-id="' +
      item.id +
      '" data-name="' +
      escapeAttr(item.name) +
      '" data-qty="' +
      item.qty +
      '" data-kb-item aria-label="Increase quantity of ' +
      escapeAttr(item.name) +
      '">+</button>' +
      '</div>' +
      '</div>'
    );
  }

  function escapeAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function cartTotal() {
    return cart.reduce(function (sum, item) {
      return sum + item.price * item.qty;
    }, 0);
  }

  function cartCount() {
    return cart.reduce(function (sum, item) {
      return sum + item.qty;
    }, 0);
  }

  function renderCart(opts) {
    opts = opts || {};
    var qtyEl = document.querySelector('.cart-quantity-2');
    if (qtyEl) qtyEl.textContent = String(cartCount());

    var form = document.querySelector('.w-commerce-commercecartform');
    var empty = document.querySelector('.w-commerce-commercecartemptystate');
    var list = document.querySelector('.w-commerce-commercecartlist');
    var value = document.querySelector('.w-commerce-commercecartordervalue');

    if (!form || !empty || !list) return;

    if (!cart.length) {
      form.style.display = 'none';
      empty.style.display = '';
      list.innerHTML = '';
      if (value) value.textContent = money(0);
      if (!opts.skipNavRefresh && window.KeyboardNav) window.KeyboardNav.refresh();
      return;
    }

    form.style.display = '';
    empty.style.display = 'none';
    list.innerHTML = cart.map(formatCartLine).join('');
    if (value) value.textContent = money(cartTotal());

    if (!opts.skipNavRefresh && window.KeyboardNav) window.KeyboardNav.refresh();
  }

  function addToCart(product) {
    var existing = cart.find(function (item) {
      return item.id === product.id;
    });
    if (existing) {
      existing.qty += 1;
    } else {
      cart.push({
        id: product.id,
        name: product.name,
        price: product.price,
        qty: 1
      });
    }
    renderCart();
    window.dispatchEvent(
      new CustomEvent('demo-cart-add', {
        detail: { product: product, count: cartCount(), total: cartTotal() }
      })
    );
  }

  function changeQty(id, delta) {
    var item = cart.find(function (entry) {
      return entry.id === id;
    });
    if (!item) return;
    var name = item.name;
    var action = delta > 0 ? 'inc' : 'dec';
    item.qty += delta;
    var removed = item.qty <= 0;
    if (removed) {
      cart = cart.filter(function (entry) {
        return entry.id !== id;
      });
    }
    var nextQty = removed ? 0 : item.qty;
    renderCart({ skipNavRefresh: true });

    window.dispatchEvent(
      new CustomEvent('demo-cart-qty', {
        detail: {
          id: id,
          name: name,
          qty: nextQty,
          action: action,
          removed: removed,
          count: cartCount(),
          total: cartTotal()
        }
      })
    );

    if (window.KeyboardNav) {
      if (!removed) {
        var line = document.querySelector('.demo-cart-line[data-id="' + id + '"]');
        if (line) {
          window.KeyboardNav.focus(line, { force: true });
          return;
        }
      }
      window.KeyboardNav.refresh();
    }
  }

  function buildCard(template, product, style) {
    var node = template.cloneNode(true);
    node.style.display = '';
    node.setAttribute('data-kb-item', '');
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', 'Add ' + product.name + ' to basket');

    var nameEl = node.querySelector('.productnaam');
    var priceEl = node.querySelector('.productprijs');
    var img = node.querySelector('img');
    var addLink = node.querySelector('a.add-to-basket');
    var submit = node.querySelector('input[type="submit"]');
    var kop = node.querySelector('.productcontainerkop');

    if (nameEl) nameEl.textContent = product.name;
    if (priceEl) priceEl.textContent = money(product.price);
    if (img) {
      img.src = product.image;
      img.alt = product.name;
      img.width = style.imgWidth;
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
    }

    if (style.color) {
      if (kop) kop.style.backgroundColor = style.color;
      if (addLink) addLink.style.backgroundColor = style.color;
    }

    var content = node.querySelector('.productcontainercontent');
    if (content) {
      if (style.beerLike) content.classList.add('beer');
      else content.classList.remove('beer');
    }

    if (addLink) {
      addLink.href = '#';
      addLink.setAttribute('data-product-id', product.id);
      addLink.addEventListener('click', function (event) {
        event.preventDefault();
        addToCart(product);
      });
    }

    if (submit) {
      submit.value = 'Add';
      submit.addEventListener('click', function (event) {
        event.preventDefault();
        addToCart(product);
      });
    }

    var form = node.querySelector('form');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        addToCart(product);
      });
    }

    return node;
  }

  function fillCategory(listRoot, products, style) {
    if (!listRoot) return;
    var template = listRoot.querySelector('.w-dyn-item');
    var empty = listRoot.parentElement && listRoot.parentElement.querySelector('.w-dyn-empty');
    if (!template) return;

    listRoot.innerHTML = '';
    products.forEach(function (product) {
      listRoot.appendChild(buildCard(template, product, style));
    });
    if (empty) empty.style.display = 'none';
  }

  function wireCartChrome() {
    var openLink = document.querySelector('[data-node-type="commerce-cart-open-link"]');
    var closeLink = document.querySelector('[data-node-type="commerce-cart-close-link"]');
    var wrapper = document.querySelector('.w-commerce-commercecartcontainerwrapper');
    var cartHome = wrapper && wrapper.parentElement;

    function openCart(event) {
      if (event) event.preventDefault();
      if (!wrapper) return;
      // Move overlay to <body> so it escapes the narrow .cartcontainer stacking context
      // and always paints above product "Add to Basket" controls.
      if (wrapper.parentElement !== document.body) {
        document.body.appendChild(wrapper);
      }
      wrapper.style.display = 'flex';
      document.body.classList.add('cart-open');
      var finishBtn = wrapper.querySelector('a.checkoutbtn');
      if (window.KeyboardNav) {
        if (finishBtn && cart.length && finishBtn.offsetParent !== null) {
          window.KeyboardNav.focus(finishBtn, { force: true });
        } else {
          window.KeyboardNav.refresh();
        }
      }
      window.dispatchEvent(
        new CustomEvent('demo-cart-open', {
          detail: { count: cartCount(), total: cartTotal() }
        })
      );
    }

    function closeCart(event) {
      if (event) event.preventDefault();
      if (!wrapper) return;
      wrapper.style.display = 'none';
      document.body.classList.remove('cart-open');
      if (cartHome && wrapper.parentElement !== cartHome) {
        cartHome.appendChild(wrapper);
      }
      if (window.KeyboardNav) window.KeyboardNav.refresh();
      window.dispatchEvent(new CustomEvent('demo-cart-close'));
    }

    if (openLink) openLink.addEventListener('click', openCart);
    if (closeLink) closeLink.addEventListener('click', closeCart);

    document.addEventListener('click', function (event) {
      var btn = event.target.closest('.demo-qty-btn');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      var action = btn.getAttribute('data-action');
      changeQty(id, action === 'inc' ? 1 : -1);
    });
  }

  function injectCartStyles() {
    if (document.getElementById('demo-cart-styles')) return;
    var style = document.createElement('style');
    style.id = 'demo-cart-styles';
    style.textContent =
      '.demo-cart-line{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:2px solid #394394;color:#394394;}' +
      '.demo-cart-line-main{display:flex;justify-content:space-between;font-size:18px;}' +
      '.demo-cart-line-qty{display:flex;align-items:center;gap:12px;}' +
      '.demo-qty-btn{width:40px;height:40px;border:2px solid #394394;border-radius:50%;background:#e8e671;color:#394394;font-size:22px;font-weight:700;cursor:pointer;}' +
      '.demo-qty-btn.kb-focused{outline:3px solid #eb5e92;outline-offset:2px;}' +
      '.demo-cart-line.kb-focused{outline:3px solid #eb5e92;outline-offset:4px;}';
    document.head.appendChild(style);
  }

  function init() {
    var lists = document.querySelectorAll('.w-dyn-items');
    if (lists.length >= 1) fillCategory(lists[0], PRODUCTS.burgers, CATEGORY_STYLE.burgers);
    if (lists.length >= 2) fillCategory(lists[1], PRODUCTS.beer, CATEGORY_STYLE.beer);
    if (lists.length >= 3) fillCategory(lists[2], PRODUCTS.wine, CATEGORY_STYLE.wine);

    injectCartStyles();
    wireCartChrome();
    renderCart();

    if (window.KeyboardNav) window.KeyboardNav.refresh();
  }

  window.DemoStore = {
    PRODUCTS: PRODUCTS,
    cartCount: cartCount,
    cartTotal: cartTotal,
    changeQty: changeQty,
    getCart: function () {
      return cart.slice();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
