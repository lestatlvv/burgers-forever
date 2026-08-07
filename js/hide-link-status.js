/**
 * Hide browser bottom-left URL status labels on link hover/focus.
 * Runs on every kiosk page. Safe to include more than once.
 */
(function () {
  'use strict';

  if (window.__kioskHideLinkStatus) return;
  window.__kioskHideLinkStatus = true;

  function disarm(a) {
    if (!a || a.nodeType !== 1 || a.tagName !== 'A') return;
    if (a.hasAttribute('data-kiosk-href')) {
      if (a.hasAttribute('href')) a.removeAttribute('href');
      return;
    }
    var href = a.getAttribute('href');
    if (href == null) return;
    if (/^javascript:/i.test(href)) return;
    a.setAttribute('data-kiosk-href', href);
    a.removeAttribute('href');
    if (!a.getAttribute('role')) a.setAttribute('role', 'link');
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === 1 && root.tagName === 'A') disarm(root);
    if (!root.querySelectorAll) return;
    var links = root.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) disarm(links[i]);
  }

  document.addEventListener(
    'click',
    function (event) {
      var a =
        event.target && event.target.closest
          ? event.target.closest('a[data-kiosk-href]')
          : null;
      if (!a) return;
      var href = a.getAttribute('data-kiosk-href');
      if (href == null) return;
      // Hash / empty targets: leave click to page scripts (cart, etc.)
      if (href === '' || href === '#' || href.charAt(0) === '#') return;
      event.preventDefault();
      if (a.getAttribute('target') === '_blank') {
        window.open(href, '_blank');
      } else {
        window.location.href = href;
      }
    },
    true
  );

  function start() {
    scan(document);
    var linkObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'attributes' && m.target) {
          disarm(m.target);
          continue;
        }
        if (m.type !== 'childList') continue;
        for (var j = 0; j < m.addedNodes.length; j++) {
          if (m.addedNodes[j].nodeType === 1) scan(m.addedNodes[j]);
        }
      }
    });
    linkObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
