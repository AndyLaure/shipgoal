/* ShipGoal / Versandziel – Storefront-Widget
 * Rendert den Fortschrittsbalken und aktualisiert ihn bei Warenkorb-Änderungen.
 * Erkennung: fetch/XHR-Abfangen auf /cart/add|change|update|clear + gängige Theme-Events.
 */
(function () {
  'use strict';

  var el = document.getElementById('shipgoal-bar');
  if (!el) return;

// App-Embeds landen am Ende des <body> – bei Position "top" nach oben verschieben
  if (el.classList.contains('shipgoal--top')) {
    document.body.insertBefore(el, document.body.firstChild);
  }

  var threshold = parseInt(el.dataset.threshold, 10) || 0;
  var currency = el.dataset.currency || 'EUR';
  var locale = (el.dataset.locale || 'de').replace('_', '-');
  var fmt;
  try {
    fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: currency });
  } catch (e) {
    fmt = { format: function (v) { return v.toFixed(2) + ' ' + currency; } };
  }

  var textEl = el.querySelector('.shipgoal__text');
  var fillEl = el.querySelector('.shipgoal__fill');
  fillEl.style.setProperty('display', 'block', 'important');
  var reached = false;

  function msg(name, amountCents) {
    var template = el.getAttribute('data-msg-' + name) || '';
    return template.replace('{amount}', fmt.format(amountCents / 100));
  }

  function render(totalCents) {
    if (!threshold) { el.hidden = true; return; }

    var remaining = Math.max(0, threshold - totalCents);
    var pct = Math.min(100, Math.round((totalCents / threshold) * 100));

    if (totalCents <= 0) {
      if (el.dataset.hideEmpty === 'true') { el.hidden = true; return; }
      textEl.textContent = msg('empty', threshold);
      reached = false;
    } else if (remaining > 0) {
      textEl.textContent = msg('progress', remaining);
      reached = false;
    } else {
      textEl.textContent = el.getAttribute('data-msg-reached') || '';
      if (!reached && el.dataset.confetti === 'true') burst();
      reached = true;
    }

    el.hidden = false;
    fillEl.style.width = pct + '%';
    el.classList.toggle('shipgoal--reached', reached);
  }

  function refresh() {
    fetch('/cart.js', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (cart) { render(cart.total_price || 0); })
      .catch(function () { /* still – Leiste bleibt auf letztem Stand */ });
  }

  function burst() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (var i = 0; i < 18; i++) {
      var p = document.createElement('span');
      p.className = 'shipgoal__confetti';
      p.style.left = (50 + (Math.random() * 60 - 30)) + '%';
      p.style.setProperty('--sg-dx', (Math.random() * 160 - 80) + 'px');
      p.style.setProperty('--sg-hue', String(Math.floor(Math.random() * 360)));
      p.style.animationDelay = (Math.random() * 0.2) + 's';
      el.appendChild(p);
      (function (node) { setTimeout(function () { node.remove(); }, 1600); })(p);
    }
  }

  // --- Warenkorb-Änderungen erkennen ---------------------------------------
  var CART_RE = /\/cart\/(add|change|update|clear)(\.js)?/;

  var origFetch = window.fetch;
  window.fetch = function () {
    var url = '';
    if (typeof arguments[0] === 'string') url = arguments[0];
    else if (arguments[0] && arguments[0].url) url = arguments[0].url;
    var promise = origFetch.apply(this, arguments);
    if (CART_RE.test(url)) {
      promise.then(function () { setTimeout(refresh, 120); }).catch(function () {});
    }
    return promise;
  };

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (CART_RE.test(url || '')) {
      this.addEventListener('load', function () { setTimeout(refresh, 120); });
    }
    return origOpen.apply(this, arguments);
  };

  ['cart:updated', 'cart:refresh', 'cart:change', 'cart:build'].forEach(function (evt) {
    document.addEventListener(evt, refresh);
  });

  // Initial mit dem serverseitig gerenderten Warenkorbwert starten,
  // danach einmal frisch nachladen (falls die Seite aus dem Cache kam).
  render(parseInt(el.dataset.total, 10) || 0);
  refresh();
})();
