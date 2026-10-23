/* ============================================================
   SPIRITDROP — commerce engine
   Cart · sidebar · checkout · postcode checker

   Reads every business rule from spiritdrop-data.js (window.SD).
   Nothing is duplicated here.

   PROTOTYPE STATE:
   · No payment is processed.
   · Nothing is submitted, emailed or stored.
   · Only the cart contents (flavour + quantity) persist in
     localStorage. Customer name, email, phone, DOB, address and
     recipient details are held in memory for the current page
     only and are never written to storage. When the backend
     lands they must be posted to a secure HTTPS API and all
     money recalculated server-side.
   ============================================================ */
(function () {
  "use strict";

  var R = (window.SD && window.SD.RULES) || { dispenserPrice: 200, bondPerDispenser: 50, drinksPerDispenser: 20 };
  var COPY = (window.SD && window.SD.COPY) || {};
  var ADDONS = (window.SD && window.SD.ADDONS) || [];
  var DISPENSER = R.dispenserPrice, BOND = R.bondPerDispenser, DRINKS = R.drinksPerDispenser;
  var CART_KEY = "sd_cart_v2";

  var DELIVERY_TIMES = (window.SD && window.SD.DELIVERY_SLOTS) || [];
  var COLLECTION_TIMES = (window.SD && window.SD.COLLECTION_SLOTS) || [];

  /* ---- state ---- */
  var state = { items: [] };
  /* In-memory only. Never persisted. */
  var checkout = {
    date: "", postcode: "", unit: "", street: "", suburb: "", auState: "NSW", instructions: "",
    delTime: "", colTime: "", notes: "",
    name: "", email: "", phone: "",
    dobD: "", dobM: "", dobY: "",
    recipient: "self", recipientName: "",
    ack: false, terms: false, step: 1,
    deliveryFee: 0, zoneId: "", zoneName: "", zoneOk: false
  };

  function loadState() {
    try { var s = JSON.parse(localStorage.getItem(CART_KEY)); if (s && s.items) state.items = s.items; } catch (e) {}
  }
  function saveState() { try { localStorage.setItem(CART_KEY, JSON.stringify({ items: state.items })); } catch (e) {} }

  function flavours() { return window.FLAVOURS || []; }
  function fOf(name) { return (window.SD && window.SD.flavourByName && window.SD.flavourByName(name)) || null; }
  function moodOf(name) { var f = fOf(name); return f ? f.mood : "#a855f7"; }
  function gradOf(name) { var f = fOf(name); return f ? f.grad : "linear-gradient(160deg,#a855f7,#c084fc)"; }
  function imgOf(name) { var f = fOf(name); return f && f.img ? f.img : ""; }
  function money(n) { return "$" + Number(n).toLocaleString("en-AU"); }
  function esc(s) { return (s || "").replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  /* ---- dispenser-level helpers (one flavour per dispenser) ---- */
  function dispenserList() {
    var out = [];
    state.items.forEach(function (i) { for (var n = 0; n < i.qty; n++) out.push(i.flavour); });
    return out;
  }
  function writeDispenserList(list) {
    var items = [];
    list.forEach(function (name) {
      var ex = items.filter(function (i) { return i.flavour === name; })[0];
      if (ex) ex.qty++; else items.push({ flavour: name, qty: 1 });
    });
    state.items = items; saveState();
  }
  function setDispenserFlavour(idx, name) {
    var list = dispenserList();
    if (idx < 0 || idx >= list.length) return;
    list[idx] = name; writeDispenserList(list);
  }
  function totalDispensers() { return state.items.reduce(function (s, i) { return s + i.qty; }, 0); }

  /* ---- mutations ---- */
  function addItem(flavour, qty) {
    qty = Math.max(1, qty || 1);
    var existing = state.items.filter(function (i) { return i.flavour === flavour; })[0];
    if (existing) existing.qty += qty; else state.items.push({ flavour: flavour, qty: qty });
    saveState(); renderAll();
  }
  function setQty(idx, q) {
    if (!state.items[idx]) return;
    state.items[idx].qty = Math.max(1, q); saveState(); renderAll();
  }
  function removeItem(idx) { state.items.splice(idx, 1); saveState(); renderAll(); }
  function setFlavour(idx, v) { if (state.items[idx]) { state.items[idx].flavour = v; saveState(); renderAll(); } }

  function totals() {
    var dispensers = totalDispensers();
    var sub = dispensers * DISPENSER;
    var bond = dispensers * BOND;
    /* Add-on pricing is not approved yet — add-ons contribute nothing. */
    var delivery = checkout.zoneOk ? (checkout.deliveryFee || 0) : 0;
    return {
      dispensers: dispensers, drinks: dispensers * DRINKS,
      sub: sub, bond: bond, delivery: delivery,
      grand: sub + delivery, payNow: sub + delivery + bond
    };
  }

  function checkPostcode(v) {
    if (window.SD && window.SD.checkZone) return window.SD.checkZone(v);
    return { ok: false, invalid: true, msg: "Enter a valid 4-digit postcode." };
  }

  /* ============================================================
     ICONS + DOM SHELL
     ============================================================ */
  var ICON = {
    cart: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.2 12.4a1.5 1.5 0 001.5 1.2h8.6a1.5 1.5 0 001.5-1.2L21 7H6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
    truck: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 4h13v11H1zM14 8h4l3 3v4h-7"/><circle cx="5" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V5z"/></svg>',
    id: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M13 9h5M13 13h5M5 16h7"/></svg>'
  };

  var overlay, drawer, coWrap, sticky, toastEl;

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function build() {
    overlay = el("div", "sd-overlay");
    overlay.addEventListener("click", closeDrawer);

    drawer = el("aside", "cart-drawer");
    drawer.setAttribute("aria-label", "Your cart");
    drawer.innerHTML =
      '<div class="cart-head"><div><h3>Your Cart</h3><div class="cnt" id="cart-cnt"></div></div>' +
      '<button class="cart-close" aria-label="Close cart">' + ICON.close + "</button></div>" +
      '<div class="cart-body" id="cart-body"></div>' +
      '<div class="cart-foot" id="cart-foot"></div>';
    drawer.querySelector(".cart-close").addEventListener("click", closeDrawer);

    coWrap = el("div", "checkout");
    coWrap.innerHTML =
      '<div class="checkout-card" role="dialog" aria-label="Booking request">' +
        '<div class="co-head"><div class="co-steps" id="co-steps"></div><button class="cart-close" aria-label="Close">' + ICON.close + "</button></div>" +
        '<div class="co-body" id="co-body"></div>' +
        '<div class="co-foot" id="co-foot"></div>' +
      "</div>";
    coWrap.querySelector(".cart-close").addEventListener("click", closeCheckout);
    coWrap.addEventListener("click", function (e) { if (e.target === coWrap) closeCheckout(); });

    sticky = el("div", "sticky-cart");
    toastEl = el("div", "toast");
    toastEl.setAttribute("role", "status");

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
    document.body.appendChild(coWrap);
    document.body.appendChild(sticky);
    document.body.appendChild(toastEl);
  }

  var toastT;
  function toast(html) {
    toastEl.innerHTML = '<span class="tk-ic">' + ICON.check + "</span><span>" + html + "</span>";
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 3000);
  }

  /* ---- shared blocks so cart, sidebar and checkout can't drift ---- */
  function addonPanel() {
    var rows = ADDONS.map(function (a) {
      return '<div class="addon pending"><div class="ax-main"><div class="ax-name">' + a.name + '</div><div class="ax-desc">' + a.desc + "</div></div>" +
        '<div class="ax-price">Price TBC</div></div>';
    }).join("");
    return '<div class="addons"><h4>Add-ons</h4>' + rows +
      '<p class="addon-note">Pricing and pack sizes are still being confirmed, so add-ons can\'t be purchased online yet. Mention them when you book and we\'ll confirm the cost.</p></div>';
  }
  function bondNotice(dispensers) {
    var d = dispensers || 0;
    return '<div class="notice deposit">' + ICON.shield + "<div><b>Refundable equipment bond.</b> " + money(BOND) + " per dispenser" +
      (d ? " (" + d + " × " + money(BOND) + " = " + money(d * BOND) + ")" : "") +
      ". The bond is returned after collection where the dispenser is returned without damage.</div></div>";
  }
  function deliveryNotice() {
    return '<div class="notice delivery">' + ICON.truck + "<div><b>Delivered, set up and ready to pour.</b> " +
      COPY.deliveryArea + " " + COPY.deliveryFee + " " + COPY.collection + "</div></div>";
  }
  function raNotice() {
    return '<div class="notice ra">' + ICON.info + "<div><b>" + COPY.under18 + "</b> " + COPY.responsibleSupply + "</div></div>";
  }

  /* ============================================================
     CART DRAWER (same component on desktop and mobile)
     ============================================================ */
  function renderDrawer() {
    var body = drawer.querySelector("#cart-body");
    var foot = drawer.querySelector("#cart-foot");
    var t = totals();
    drawer.querySelector("#cart-cnt").textContent = t.dispensers
      ? t.dispensers + " dispenser" + (t.dispensers > 1 ? "s" : "") + " · " + t.drinks + " ready-to-pour drinks"
      : "Empty";

    if (!state.items.length) {
      body.innerHTML =
        '<div class="cart-empty"><div class="ce-ic">' + ICON.cart + "</div>" +
        "<h4>Your cart is empty</h4><p>Choose a flavour and we'll bring the dispenser to your next event.</p>" +
        '<button class="btn btn-primary" id="empty-shop">Browse Flavours <span class="arrow">→</span></button></div>';
      body.querySelector("#empty-shop").addEventListener("click", function () { closeDrawer(); goShop(); });
      foot.innerHTML = "";
      return;
    }

    var html = "";
    state.items.forEach(function (it, i) {
      var opts = flavours().map(function (f) { return '<option value="' + f.name + '"' + (f.name === it.flavour ? " selected" : "") + ">" + f.name + " · " + f.base + "</option>"; }).join("");
      html +=
        '<div class="ci">' +
          '<div class="ci-thumb" style="--mood:' + moodOf(it.flavour) + '">' +
            (imgOf(it.flavour) ? '<img class="ci-img" src="' + imgOf(it.flavour) + '" alt="" loading="lazy">' : '<div class="fl" style="background:' + gradOf(it.flavour) + '"></div>') +
            '<div class="gl"></div><div class="led"></div></div>' +
          '<div class="ci-main">' +
            '<div class="ci-top"><div class="ci-name">LED Cocktail Dispenser<small>' + DRINKS + " ready-to-pour drinks each</small></div><div class=\"ci-price\">" + money(it.qty * DISPENSER) + "</div></div>" +
            '<div class="ci-flav"><label class="sr-only" for="ci-sel-' + i + '">Flavour for line ' + (i + 1) + '</label><select id="ci-sel-' + i + '" data-idx="' + i + '" class="ci-flav-sel">' + opts + "</select></div>" +
            '<div class="ci-foot"><div class="qty"><button type="button" data-dec="' + i + '" aria-label="Decrease quantity">−</button><span>' + it.qty + '</span><button type="button" data-inc="' + i + '" aria-label="Increase quantity">+</button></div>' +
            '<button type="button" class="ci-remove" data-rm="' + i + '">Remove</button></div>' +
          "</div>" +
        "</div>";
    });

    html += addonPanel() + bondNotice(t.dispensers) + deliveryNotice() + raNotice();
    body.innerHTML = html;

    body.querySelectorAll("[data-inc]").forEach(function (b) { b.addEventListener("click", function () { setQty(+b.dataset.inc, state.items[+b.dataset.inc].qty + 1); }); });
    body.querySelectorAll("[data-dec]").forEach(function (b) { b.addEventListener("click", function () { setQty(+b.dataset.dec, state.items[+b.dataset.dec].qty - 1); }); });
    body.querySelectorAll("[data-rm]").forEach(function (b) { b.addEventListener("click", function () { removeItem(+b.dataset.rm); }); });
    body.querySelectorAll(".ci-flav-sel").forEach(function (s) { s.addEventListener("change", function () { setFlavour(+s.dataset.idx, s.value); }); });

    foot.innerHTML =
      '<div class="totals">' +
        '<div class="trow"><span>Dispensers (' + t.dispensers + " × " + money(DISPENSER) + ")</span><span>" + money(t.sub) + "</span></div>" +
        (checkout.zoneOk
          ? '<div class="trow"><span>Delivery · ' + esc(checkout.zoneName.replace(/^Zone \d+ · /, "")) + "</span><span>" + (t.delivery ? money(t.delivery) : "No fee") + "</span></div>"
          : '<div class="trow"><span>Delivery</span><span class="tmuted">Calculated by location at checkout</span></div>') +
        '<div class="trow bond"><span>Refundable equipment bond (' + t.dispensers + " × " + money(BOND) + ")</span><span>" + money(t.bond) + "</span></div>" +
        '<div class="trow grand"><span>Estimated total</span><span class="gv">' + money(t.payNow) + "</span></div>" +
        '<p class="trow-note">' + COPY.prototype + "</p>" +
      "</div>" +
      '<button class="btn btn-primary btn-block" id="to-checkout">Start Booking Request <span class="arrow">→</span></button>';
    foot.querySelector("#to-checkout").addEventListener("click", function () { closeDrawer(); openCheckout(); });
  }

  /* ---- sticky mobile bar (same numbers as the drawer) ---- */
  function renderSticky() {
    var t = totals();
    if (t.dispensers) {
      sticky.innerHTML =
        '<div class="sc-info"><b>' + money(t.payNow) + "</b><span>" + t.dispensers + " dispenser" + (t.dispensers > 1 ? "s" : "") + " · incl. " + money(t.bond) + " bond</span></div>" +
        '<button class="btn btn-primary" id="sc-view">View Cart</button>';
      sticky.querySelector("#sc-view").addEventListener("click", openDrawer);
    } else {
      sticky.innerHTML =
        '<div class="sc-info"><b>' + money(DISPENSER) + ' per dispenser</b><span>' + DRINKS + " ready-to-pour drinks</span></div>" +
        '<button class="btn btn-primary" id="sc-shop">Order Now</button>';
      sticky.querySelector("#sc-shop").addEventListener("click", goShop);
    }
    updateStickyVisibility();
  }
  function updateStickyVisibility() {
    var past = window.scrollY > window.innerHeight * 0.7;
    var atFoot = (window.innerHeight + window.scrollY) > (document.body.offsetHeight - 240);
    sticky.classList.toggle("show", past && !atFoot && !drawer.classList.contains("open") && !coWrap.classList.contains("open"));
  }

  function renderCount() {
    var c = document.getElementById("cart-count");
    if (!c) return;
    var t = totals();
    c.textContent = t.dispensers;
    c.classList.toggle("show", t.dispensers > 0);
  }

  function renderAll() {
    renderDrawer(); renderSticky(); renderCount();
    if (window.SDBuild && window.SDBuild.refresh) window.SDBuild.refresh();
  }

  function openDrawer() { renderAll(); overlay.classList.add("open"); drawer.classList.add("open"); document.body.style.overflow = "hidden"; updateStickyVisibility(); }
  function closeDrawer() { overlay.classList.remove("open"); drawer.classList.remove("open"); document.body.style.overflow = ""; updateStickyVisibility(); }

  /* ============================================================
     CHECKOUT
     STEP 1 Your Drop · STEP 2 Event & Delivery
     STEP 3 Your Details · STEP 4 Review (no payment)
     ============================================================ */
  function openCheckout() {
    if (!state.items.length) { goShop(); return; }
    if (checkout.step > 4 || !checkout.step) checkout.step = 1;
    coWrap.classList.add("open"); document.body.style.overflow = "hidden";
    renderCheckout(); updateStickyVisibility();
  }
  function closeCheckout() { coWrap.classList.remove("open"); document.body.style.overflow = ""; updateStickyVisibility(); }

  function stepsBar() {
    var steps = [["1", "Your Drop"], ["2", "Event & Delivery"], ["3", "Your Details"], ["4", "Review"]];
    var h = "";
    steps.forEach(function (s, i) {
      var n = i + 1;
      var cls = n === checkout.step ? "active" : (n < checkout.step ? "done" : "");
      h += '<div class="co-step ' + cls + '"><span class="dot">' + (n < checkout.step ? "✓" : s[0]) + '</span><span class="lbl">' + s[1] + "</span></div>";
      if (i < steps.length - 1) h += '<span class="bar"></span>';
    });
    return h;
  }

  function scrollBodyTop() { var b = coWrap.querySelector(".co-body"); if (b) b.scrollTop = 0; }

  function renderCheckout() {
    coWrap.querySelector("#co-steps").innerHTML = stepsBar();
    var body = coWrap.querySelector("#co-body");
    var foot = coWrap.querySelector("#co-foot");
    if (checkout.step === 1) renderStepDrop(body, foot);
    else if (checkout.step === 2) renderStepDelivery(body, foot);
    else if (checkout.step === 3) renderStepDetails(body, foot);
    else renderReview(body, foot);
  }

  /* ---- STEP 1 · Your Drop — one flavour per dispenser ---- */
  function renderStepDrop(body, foot) {
    var list = dispenserList();
    var t = totals();
    var html = "<h3>Your drop</h3><p class=\"co-sub\">One flavour per dispenser — choose a different flavour for each if you like.</p>";

    html += '<div class="qty-block"><span class="qb-label">How many dispensers?</span>' +
      '<div class="qty"><button type="button" id="co-qminus" aria-label="One dispenser fewer">−</button><span id="co-qval">' + list.length + '</span><button type="button" id="co-qplus" aria-label="One dispenser more">+</button></div>' +
      '<span class="qb-note">' + COPY.drinks + "</span></div>";

    list.forEach(function (name, i) {
      var opts = flavours().map(function (f) { return '<option value="' + f.name + '"' + (f.name === name ? " selected" : "") + ">" + f.name + " · " + f.base + "</option>"; }).join("");
      html +=
        '<div class="co-drop">' +
          '<div class="cd-top"><b>Dispenser ' + (i + 1) + "</b><span>" + money(DISPENSER) + "</span></div>" +
          '<label class="sr-only" for="cd-flav-' + i + '">Flavour for dispenser ' + (i + 1) + "</label>" +
          '<select class="cd-flav" id="cd-flav-' + i + '" data-d="' + i + '">' + opts + "</select>" +
          '<div class="cd-foot"><span class="cd-note">' + DRINKS + ' ready-to-pour drinks</span>' +
          (list.length > 1 ? '<button type="button" class="ci-remove" data-drm="' + i + '">Remove</button>' : "") + "</div>" +
        "</div>";
    });

    html += addonPanel() + bondNotice(t.dispensers);
    body.innerHTML = html;

    body.querySelector("#co-qplus").addEventListener("click", function () {
      var l = dispenserList(); l.push(l[l.length - 1] || (flavours()[0] && flavours()[0].name));
      writeDispenserList(l); renderAll(); renderCheckout();
    });
    body.querySelector("#co-qminus").addEventListener("click", function () {
      var l = dispenserList(); if (l.length <= 1) return; l.pop(); writeDispenserList(l); renderAll(); renderCheckout();
    });
    body.querySelectorAll(".cd-flav").forEach(function (s) {
      s.addEventListener("change", function () { setDispenserFlavour(+s.dataset.d, s.value); renderAll(); renderCheckout(); });
    });
    body.querySelectorAll("[data-drm]").forEach(function (b) {
      b.addEventListener("click", function () {
        var l = dispenserList(); l.splice(+b.dataset.drm, 1); writeDispenserList(l);
        renderAll();
        if (!state.items.length) { closeCheckout(); openDrawer(); } else renderCheckout();
      });
    });

    foot.innerHTML = '<button class="btn btn-ghost" id="co-back">Back to cart</button><button class="btn btn-primary btn-block" id="co-next">Continue <span class="arrow">→</span></button>';
    foot.querySelector("#co-back").addEventListener("click", function () { closeCheckout(); openDrawer(); });
    foot.querySelector("#co-next").addEventListener("click", function () { checkout.step = 2; renderCheckout(); scrollBodyTop(); });
  }

  /* ---- STEP 2 · Event & delivery ---- */
  function renderStepDelivery(body, foot) {
    var minDate = window.SD.minEventDate();
    body.innerHTML =
      "<h3>Event &amp; delivery</h3><p class=\"co-sub\">When and where should we deliver? Collection is always the next day.</p>" +
      '<div class="field" id="f-date"><label for="in-date">Event date <span class="req">*</span></label>' +
        '<input type="date" id="in-date" min="' + minDate + '" value="' + esc(checkout.date) + '">' +
        '<div class="hint">The earliest event date available is ' + window.SD.formatDate(minDate) + ".</div>" +
        '<div class="errmsg">Choose an event date from ' + window.SD.formatDate(minDate) + " onwards.</div></div>" +
      '<div class="field" id="f-pc"><label for="in-pc">Delivery postcode <span class="req">*</span></label>' +
        '<div class="pc-wrap"><input type="text" id="in-pc" inputmode="numeric" maxlength="4" placeholder="e.g. 2170" value="' + esc(checkout.postcode) + '">' +
        '<button type="button" class="btn btn-ghost" id="pc-go">Check</button></div>' +
        '<div class="pc-result" id="pc-res" role="status"></div><div class="errmsg">Enter a postcode inside our delivery area.</div></div>' +
      '<div class="field" id="f-street"><label for="in-street">Street address <span class="req">*</span></label>' +
        '<input type="text" id="in-street" autocomplete="address-line1" placeholder="e.g. 24 Macquarie Street" value="' + esc(checkout.street) + '">' +
        '<div class="hint">Validated Australian address autocomplete will be connected with the backend.</div><div class="errmsg">Enter your street address.</div></div>' +
      '<div class="field-row">' +
        '<div class="field"><label for="in-unit">Unit / apartment (optional)</label><input type="text" id="in-unit" autocomplete="address-line2" placeholder="e.g. Unit 5" value="' + esc(checkout.unit) + '"></div>' +
        '<div class="field" id="f-suburb"><label for="in-suburb">Suburb <span class="req">*</span></label><input type="text" id="in-suburb" autocomplete="address-level2" placeholder="e.g. Liverpool" value="' + esc(checkout.suburb) + '"><div class="errmsg">Enter your suburb.</div></div>' +
      "</div>" +
      '<div class="field-row">' +
        '<div class="field"><label for="in-state">State</label><select id="in-state" autocomplete="address-level1">' +
          ["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"].map(function (st) { return "<option" + (checkout.auState === st ? " selected" : "") + ">" + st + "</option>"; }).join("") +
        "</select></div>" +
        '<div class="field"><label for="in-instr">Delivery instructions (optional)</label><input type="text" id="in-instr" placeholder="Gate code, side entrance…" value="' + esc(checkout.instructions) + '"></div>' +
      "</div>" +
      '<fieldset class="field" id="f-del"><legend>Preferred delivery window <span class="req">*</span></legend><div class="timepick" id="tp-del"></div><div class="errmsg">Pick a delivery window.</div></fieldset>' +
      '<fieldset class="field" id="f-col"><legend>Next-day collection window <span class="req">*</span></legend>' +
        '<p class="hint" id="col-date-note"></p><div class="timepick" id="tp-col"></div><div class="errmsg">Pick a collection window.</div></fieldset>' +
      '<div class="field"><label for="in-notes">Event notes (optional)</label><textarea id="in-notes" placeholder="Where to set up, parking, access…">' + esc(checkout.notes) + "</textarea></div>" +
      '<div class="notice delivery">' + ICON.truck + "<div><b>" + COPY.setup + "</b> " + COPY.collection + " " + COPY.windows + "</div></div>";

    buildTimepick("tp-del", "delTime", DELIVERY_TIMES);
    buildTimepick("tp-col", "colTime", COLLECTION_TIMES);
    updateCollectionNote();

    var pcRes = body.querySelector("#pc-res");
    function runPc() {
      var raw = body.querySelector("#in-pc").value;
      var r = checkPostcode(raw);
      checkout.postcode = raw.trim();
      checkout.zoneOk = !!r.ok;
      checkout.deliveryFee = r.ok ? r.fee : 0;
      checkout.zoneId = r.ok ? r.zone.id : "";
      checkout.zoneName = r.ok ? r.zone.name : "";
      pcRes.className = "pc-result show " + (r.ok ? "ok" : "no");
      pcRes.innerHTML = (r.ok ? ICON.check : ICON.info) + "<span>" + r.msg + "</span>";
      body.querySelector("#f-pc").classList.remove("err");
      renderAll();
    }
    body.querySelector("#pc-go").addEventListener("click", runPc);
    body.querySelector("#in-pc").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); runPc(); } });
    if (checkout.postcode) runPc();

    body.querySelector("#in-date").addEventListener("change", function (e) { checkout.date = e.target.value; updateCollectionNote(); });
    [["in-street", "street"], ["in-unit", "unit"], ["in-suburb", "suburb"], ["in-instr", "instructions"], ["in-notes", "notes"]].forEach(function (p) {
      body.querySelector("#" + p[0]).addEventListener("input", function (e) { checkout[p[1]] = e.target.value; });
    });
    body.querySelector("#in-state").addEventListener("change", function (e) { checkout.auState = e.target.value; });

    foot.innerHTML = '<button class="btn btn-ghost" id="co-back">Back</button><button class="btn btn-primary btn-block" id="co-next">Continue <span class="arrow">→</span></button>';
    foot.querySelector("#co-back").addEventListener("click", function () { checkout.step = 1; renderCheckout(); });
    foot.querySelector("#co-next").addEventListener("click", validateDelivery);
  }

  function updateCollectionNote() {
    var n = coWrap.querySelector("#col-date-note");
    if (!n) return;
    var cd = window.SD.collectionDate(checkout.date);
    n.textContent = cd ? "We'll collect on " + window.SD.formatDate(cd) + " — the day after your event." : "Choose your event date and we'll collect the next day.";
  }

  function buildTimepick(containerId, key, list) {
    var c = coWrap.querySelector("#" + containerId);
    if (!c) return;
    c.innerHTML = "";
    (list || []).forEach(function (tm) {
      var b = el("button", "tp" + (checkout[key] === tm.id ? " sel" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", checkout[key] === tm.id ? "true" : "false");
      b.innerHTML = "<b>" + tm.label + "</b>";
      b.addEventListener("click", function () {
        checkout[key] = tm.id;
        c.querySelectorAll(".tp").forEach(function (x) { x.classList.remove("sel"); x.setAttribute("aria-pressed", "false"); });
        b.classList.add("sel"); b.setAttribute("aria-pressed", "true");
        var f = c.closest(".field"); if (f) f.classList.remove("err");
      });
      c.appendChild(b);
    });
  }

  function validateDelivery() {
    var body = coWrap.querySelector("#co-body");
    var ok = true;
    var minDate = window.SD.minEventDate();
    checkout.date = body.querySelector("#in-date").value;
    if (!checkout.date || checkout.date < minDate) { body.querySelector("#f-date").classList.add("err"); ok = false; } else body.querySelector("#f-date").classList.remove("err");

    var pc = checkPostcode(body.querySelector("#in-pc").value);
    if (!pc.ok) { body.querySelector("#f-pc").classList.add("err"); ok = false; }

    checkout.street = (body.querySelector("#in-street").value || "").trim();
    if (!checkout.street) { body.querySelector("#f-street").classList.add("err"); ok = false; } else body.querySelector("#f-street").classList.remove("err");

    checkout.suburb = (body.querySelector("#in-suburb").value || "").trim();
    if (!checkout.suburb) { body.querySelector("#f-suburb").classList.add("err"); ok = false; } else body.querySelector("#f-suburb").classList.remove("err");

    if (!checkout.delTime) { body.querySelector("#f-del").classList.add("err"); ok = false; }
    if (!checkout.colTime) { body.querySelector("#f-col").classList.add("err"); ok = false; }

    if (ok) { checkout.step = 3; renderCheckout(); scrollBodyTop(); }
    else { var e = body.querySelector(".field.err"); if (e) coWrap.querySelector(".co-body").scrollTop = Math.max(0, e.offsetTop - 60); }
  }

  /* ---- STEP 3 · Your details (incl. DOB + recipient) ---- */
  function renderStepDetails(body, foot) {
    var years = "";
    var thisYear = new Date().getFullYear();
    for (var y = thisYear - 17; y >= thisYear - 100; y--) years += '<option value="' + y + '"' + (String(checkout.dobY) === String(y) ? " selected" : "") + ">" + y + "</option>";
    var months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"].map(function (m) {
      return '<option value="' + m + '"' + (checkout.dobM === m ? " selected" : "") + ">" + m + "</option>";
    }).join("");
    var days = "";
    for (var d = 1; d <= 31; d++) { var dd = String(d).padStart(2, "0"); days += '<option value="' + dd + '"' + (checkout.dobD === dd ? " selected" : "") + ">" + dd + "</option>"; }

    body.innerHTML =
      "<h3>Your details</h3><p class=\"co-sub\">Who should we contact about this booking?</p>" +
      '<div class="field-row">' +
        '<div class="field" id="f-name"><label for="in-name">Full name <span class="req">*</span></label><input type="text" id="in-name" autocomplete="name" value="' + esc(checkout.name) + '"><div class="errmsg">Enter your name.</div></div>' +
        '<div class="field" id="f-phone"><label for="in-phone">Phone <span class="req">*</span></label><input type="tel" id="in-phone" autocomplete="tel" value="' + esc(checkout.phone) + '"><div class="errmsg">Enter a contact number.</div></div>' +
      "</div>" +
      '<div class="field" id="f-email"><label for="in-email">Email <span class="req">*</span></label><input type="email" id="in-email" autocomplete="email" placeholder="you@email.com" value="' + esc(checkout.email) + '"><div class="errmsg">Enter a valid email address.</div></div>' +

      '<fieldset class="field" id="f-dob"><legend>Date of birth <span class="req">*</span></legend>' +
        '<div class="dob-row">' +
          '<span class="dob-f"><label for="in-dob-d">Day</label><select id="in-dob-d"><option value="">DD</option>' + days + "</select></span>" +
          '<span class="dob-f"><label for="in-dob-m">Month</label><select id="in-dob-m"><option value="">MM</option>' + months + "</select></span>" +
          '<span class="dob-f"><label for="in-dob-y">Year</label><select id="in-dob-y"><option value="">YYYY</option>' + years + "</select></span>" +
        "</div>" +
        '<div class="hint">We ask for your date of birth because alcohol can only be sold to adults 18 years and over. Full age verification happens on delivery.</div>' +
        '<div class="errmsg" id="dob-err">Enter a valid date of birth. You must be 18 or over to order.</div>' +
      "</fieldset>" +

      '<fieldset class="field" id="f-recip"><legend>Who will receive the delivery? <span class="req">*</span></legend>' +
        '<div class="radio-set">' +
          '<label class="radio' + (checkout.recipient === "self" ? " sel" : "") + '"><input type="radio" name="sd-recip" value="self"' + (checkout.recipient === "self" ? " checked" : "") + "><span>I will receive the delivery</span></label>" +
          '<label class="radio' + (checkout.recipient === "other" ? " sel" : "") + '"><input type="radio" name="sd-recip" value="other"' + (checkout.recipient === "other" ? " checked" : "") + "><span>Another adult will receive the delivery</span></label>" +
        "</div>" +
        '<div class="recip-name" id="recip-wrap"' + (checkout.recipient === "other" ? "" : ' hidden') + '>' +
          '<label for="in-recip-name">Recipient\'s full name <span class="req">*</span></label>' +
          '<input type="text" id="in-recip-name" value="' + esc(checkout.recipientName) + '">' +
          '<div class="errmsg" id="recip-err">Enter the name of the adult receiving the delivery.</div>' +
        "</div>" +
        '<p class="hint">The recipient must be 18+ and may be required to provide valid ID.</p>' +
      "</fieldset>" +

      '<div class="id-notice">' + ICON.id + '<div class="idt">' + COPY.responsibleSupply + "</div></div>" +
      '<div class="check' + (checkout.ack ? " sel" : "") + '" id="chk-ack" role="checkbox" tabindex="0" aria-checked="' + (checkout.ack ? "true" : "false") + '"><div class="box">' + ICON.check + "</div>" +
        '<div class="ct"><b>I understand my responsible-supply obligations.</b><br><small><b>' + COPY.under18 + "</b></small></div></div>" +
      '<div class="errmsg" id="err-ack">Please confirm you understand these obligations.</div>' +
      '<div class="check' + (checkout.terms ? " sel" : "") + '" id="chk-terms" role="checkbox" tabindex="0" aria-checked="' + (checkout.terms ? "true" : "false") + '"><div class="box">' + ICON.check + "</div>" +
        '<div class="ct"><b>I have read and agree to SpiritDrop\'s terms.</b><br><small>' +
        '<a href="/legal#terms" target="_blank" rel="noopener">Terms &amp; Conditions</a>, ' +
        '<a href="/legal#privacy" target="_blank" rel="noopener">Privacy Policy</a> and ' +
        '<a href="/legal#cancellation" target="_blank" rel="noopener">Cancellation &amp; Refund Policy</a>.</small></div></div>' +
      '<div class="errmsg" id="err-terms">Please agree to the terms to continue.</div>' +
      '<div class="notice ra">' + ICON.info + "<div><b>Prototype checkout.</b> " + COPY.prototype + " Your details are not saved to this browser.</div></div>";

    ["name", "phone", "email"].forEach(function (k) {
      body.querySelector("#in-" + k).addEventListener("input", function (e) { checkout[k] = e.target.value; });
    });
    [["in-dob-d", "dobD"], ["in-dob-m", "dobM"], ["in-dob-y", "dobY"]].forEach(function (p) {
      body.querySelector("#" + p[0]).addEventListener("change", function (e) { checkout[p[1]] = e.target.value; body.querySelector("#f-dob").classList.remove("err"); });
    });
    body.querySelectorAll('input[name="sd-recip"]').forEach(function (r) {
      r.addEventListener("change", function () {
        checkout.recipient = r.value;
        body.querySelectorAll(".radio").forEach(function (l) { l.classList.toggle("sel", l.contains(l.querySelector("input:checked"))); });
        body.querySelector("#recip-wrap").hidden = checkout.recipient !== "other";
      });
    });
    body.querySelector("#in-recip-name").addEventListener("input", function (e) { checkout.recipientName = e.target.value; });

    function wireCheck(boxId, errId, key) {
      var chk = body.querySelector(boxId);
      var err = body.querySelector(errId);
      err.style.display = "none";
      function toggle() {
        checkout[key] = !checkout[key];
        chk.classList.toggle("sel", checkout[key]);
        chk.setAttribute("aria-checked", checkout[key] ? "true" : "false");
        chk.classList.remove("err");
        err.style.display = "none";
      }
      chk.addEventListener("click", function (e) {
        if (e.target.tagName === "A") return; /* let policy links open */
        toggle();
      });
      chk.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
    }
    wireCheck("#chk-ack", "#err-ack", "ack");
    wireCheck("#chk-terms", "#err-terms", "terms");

    foot.innerHTML = '<button class="btn btn-ghost" id="co-prev">Back</button><button class="btn btn-primary btn-block" id="co-review">Review Order <span class="arrow">→</span></button>';
    foot.querySelector("#co-prev").addEventListener("click", function () { checkout.step = 2; renderCheckout(); });
    foot.querySelector("#co-review").addEventListener("click", validateDetails);
  }

  function ageFrom(d, m, y) {
    if (!d || !m || !y) return null;
    var dt = new Date(+y, +m - 1, +d);
    if (dt.getDate() !== +d || dt.getMonth() !== +m - 1) return null;
    var now = new Date();
    var age = now.getFullYear() - dt.getFullYear();
    var before = now.getMonth() < dt.getMonth() || (now.getMonth() === dt.getMonth() && now.getDate() < dt.getDate());
    if (before) age--;
    return age;
  }

  function validateDetails() {
    var body = coWrap.querySelector("#co-body");
    checkout.name = (body.querySelector("#in-name").value || "").trim();
    checkout.phone = (body.querySelector("#in-phone").value || "").trim();
    checkout.email = (body.querySelector("#in-email").value || "").trim();
    checkout.recipientName = (body.querySelector("#in-recip-name").value || "").trim();
    var ok = true;

    if (!checkout.name) { body.querySelector("#f-name").classList.add("err"); ok = false; } else body.querySelector("#f-name").classList.remove("err");
    if (!checkout.phone) { body.querySelector("#f-phone").classList.add("err"); ok = false; } else body.querySelector("#f-phone").classList.remove("err");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(checkout.email)) { body.querySelector("#f-email").classList.add("err"); ok = false; } else body.querySelector("#f-email").classList.remove("err");

    var age = ageFrom(checkout.dobD, checkout.dobM, checkout.dobY);
    var dobField = body.querySelector("#f-dob");
    if (age === null) { body.querySelector("#dob-err").textContent = "Enter a valid date of birth."; dobField.classList.add("err"); ok = false; }
    else if (age < 18) { body.querySelector("#dob-err").textContent = "You must be 18 or over to order alcohol."; dobField.classList.add("err"); ok = false; }
    else dobField.classList.remove("err");

    if (checkout.recipient === "other" && !checkout.recipientName) { body.querySelector("#f-recip").classList.add("err"); ok = false; } else body.querySelector("#f-recip").classList.remove("err");

    if (!checkout.ack) { body.querySelector("#chk-ack").classList.add("err"); body.querySelector("#err-ack").style.display = "block"; ok = false; }
    if (!checkout.terms) { body.querySelector("#chk-terms").classList.add("err"); body.querySelector("#err-terms").style.display = "block"; ok = false; }

    if (ok) { checkout.step = 4; renderCheckout(); scrollBodyTop(); }
    else { var e = body.querySelector(".field.err, .check.err"); if (e) coWrap.querySelector(".co-body").scrollTop = Math.max(0, e.offsetTop - 60); }
  }

  /* ---- STEP 4 · Review (no payment, nothing submitted) ---- */
  function renderReview(body, foot) {
    var t = totals(), c = checkout;
    var delLabel = (DELIVERY_TIMES.filter(function (x) { return x.id === c.delTime; })[0] || {}).label || "—";
    var colLabel = (COLLECTION_TIMES.filter(function (x) { return x.id === c.colTime; })[0] || {}).label || "—";
    var colDate = window.SD.collectionDate(c.date);
    var addrLine1 = [c.unit, c.street].filter(Boolean).join(", ");
    var addrLine2 = [c.suburb, c.auState, c.postcode].filter(Boolean).join(" ");
    var dispLines = dispenserList().map(function (name, i) {
      return '<div class="sr"><span>Dispenser ' + (i + 1) + "</span><b>" + esc(name) + " · " + DRINKS + " ready-to-pour drinks</b></div>";
    }).join("");

    body.innerHTML =
      "<h3>Review your order</h3><p class=\"co-sub\">Check everything below. Nothing is submitted or charged at this stage.</p>" +
      '<div class="co-summary">' + dispLines +
        '<div class="sr"><span>Event date</span><b>' + window.SD.formatDate(c.date) + "</b></div>" +
        '<div class="sr"><span>Delivery address</span><b>' + (esc(addrLine1) || "—") + (addrLine2 ? "<br>" + esc(addrLine2) : "") + "</b></div>" +
        (c.instructions ? '<div class="sr"><span>Instructions</span><b>' + esc(c.instructions) + "</b></div>" : "") +
        '<div class="sr"><span>Delivery window</span><b>' + delLabel + "</b></div>" +
        '<div class="sr"><span>Next-day collection</span><b>' + window.SD.formatDate(colDate) + " · " + colLabel + "</b></div>" +
        '<div class="sr"><span>Setup</span><b>Delivered, set up and ready to pour</b></div>' +
        '<div class="sr"><span>Add-ons</span><b>None — add-on pricing not yet available online</b></div>' +
        '<div class="sr"><span>Receiving delivery</span><b>' + (c.recipient === "other" ? esc(c.recipientName) + " (18+)" : esc(c.name) + " (you)") + "</b></div>" +
        '<div class="sr"><span>Contact</span><b>' + esc(c.name) + "<br>" + esc(c.email) + " · " + esc(c.phone) + "</b></div>" +
      "</div>" +
      '<div class="totals co-totals">' +
        '<div class="trow"><span>Product subtotal (' + t.dispensers + " × " + money(DISPENSER) + ")</span><span>" + money(t.sub) + "</span></div>" +
        '<div class="trow"><span>Add-ons</span><span class="tmuted">—</span></div>' +
        '<div class="trow"><span>Delivery fee' + (c.zoneName ? " · " + esc(c.zoneName.replace(/^Zone \d+ · /, "")) : "") + "</span><span>" + (t.delivery ? money(t.delivery) : "No fee") + "</span></div>" +
        '<div class="trow bond"><span>Refundable equipment bond (' + t.dispensers + " × " + money(BOND) + ")</span><span>" + money(t.bond) + "</span></div>" +
        '<div class="trow grand"><span>Total</span><span class="gv">' + money(t.payNow) + "</span></div>" +
      "</div>" +
      '<div class="notice ra">' + ICON.info + "<div><b>Prototype checkout.</b> " + COPY.prototype + " No booking reference has been created and no bond has been taken. " + COPY.responsibleSupply + "</div></div>";

    foot.innerHTML = '<button class="btn btn-ghost" id="co-prev">Back</button><button class="btn btn-primary btn-block" id="co-finish">Close</button>';
    foot.querySelector("#co-prev").addEventListener("click", function () { checkout.step = 3; renderCheckout(); });
    foot.querySelector("#co-finish").addEventListener("click", closeCheckout);
  }

  /* ---- nav helper ---- */
  function goShop() {
    var t = document.querySelector("#flavours") || document.querySelector("#shop-grid");
    if (t) window.scrollTo({ top: t.offsetTop - 50, behavior: "smooth" });
    else window.location.href = "/shop";
  }

  /* ============================================================
     PUBLIC API + wiring
     ============================================================ */
  window.SpiritCart = {
    add: function (flavour, qty) {
      addItem(flavour, qty);
      toast("<b>Added</b> · " + flavour);
      var c = document.getElementById("cart-count");
      if (c) { c.classList.add("bump"); setTimeout(function () { c.classList.remove("bump"); }, 400); }
    },
    addMany: function (list) {
      if (!list || !list.length) return;
      var cur = dispenserList().concat(list);
      writeDispenserList(cur); renderAll();
      toast("<b>" + list.length + " dispenser" + (list.length > 1 ? "s" : "") + "</b> added");
      openDrawer();
    },
    open: openDrawer,
    items: function () { return dispenserList(); },
    checkPostcode: checkPostcode
  };

  /* ---- external postcode checkers (delivery page, zones section) ---- */
  function bindPcWidgets() {
    document.querySelectorAll("[data-pc-form]").forEach(function (form) {
      var input = form.querySelector("[data-pc-input]");
      var res = form.querySelector("[data-pc-result]");
      function run(e) {
        if (e) e.preventDefault();
        var r = checkPostcode(input.value);
        res.className = "pc-result show " + (r.ok ? "ok" : "no");
        res.innerHTML = (r.ok ? ICON.check : ICON.info) + "<span>" + r.msg + "</span>";
        if (r.ok) {
          checkout.postcode = input.value.trim(); checkout.zoneOk = true;
          checkout.deliveryFee = r.fee; checkout.zoneId = r.zone.id; checkout.zoneName = r.zone.name;
          renderAll();
        }
      }
      form.addEventListener("submit", run);
      var btn = form.querySelector("[data-pc-go]"); if (btn) btn.addEventListener("click", run);
    });
  }

  /* ============================================================
     ENQUIRY + NEWSLETTER FORMS

     No backend exists yet, so neither form claims a message was
     sent. Validation is real, inline and announced; the "success"
     state states plainly that nothing was transmitted.
     ============================================================ */
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var PHONE_RE = /^[0-9+()\s-]{8,}$/;

  /* Per-field message that says what is wrong AND what to do. */
  function fieldProblem(el) {
    var v = (el.value || "").trim();
    var label = (el.closest(".field") || el).querySelector("label");
    var name = label ? label.textContent.replace(/\*/g, "").trim().toLowerCase() : "this field";
    if (el.required && !v) return "Enter your " + name + " so we can reply to your enquiry.";
    if (!v) return null;
    if (el.type === "email" && !EMAIL_RE.test(v)) return "That email address is missing an @ or a domain. Check it and try again.";
    if (el.type === "tel" && !PHONE_RE.test(v)) return "Enter a contactable phone number, digits only or with spaces.";
    return null;
  }

  function showFieldError(el, msg) {
    var wrap = el.closest(".field");
    if (!wrap) return;
    var err = wrap.querySelector(".field-err");
    if (!err) {
      err = document.createElement("p");
      err.className = "field-err";
      err.id = (el.id || "f") + "-err";
      wrap.appendChild(err);
    }
    if (msg) {
      err.textContent = msg;
      wrap.classList.add("invalid");
      el.setAttribute("aria-invalid", "true");
      el.setAttribute("aria-describedby", err.id);
    } else {
      wrap.classList.remove("invalid");
      el.removeAttribute("aria-invalid");
      el.removeAttribute("aria-describedby");
    }
  }

  function bindForms() {
    var enq = document.getElementById("enquiry-form");
    if (enq) {
      /* one live region for the summary, so a screen reader hears the
         result of a failed submit without hunting for the fields */
      var summary = enq.querySelector(".form-err");
      if (!summary) {
        summary = document.createElement("div");
        summary.className = "form-err";
        summary.setAttribute("role", "alert");
        enq.insertBefore(summary, enq.firstChild);
      }
      var fields = [].slice.call(enq.querySelectorAll("input, textarea, select"));

      /* clear a field's error as soon as the customer fixes it */
      fields.forEach(function (el) {
        el.addEventListener("input", function () {
          if (el.closest(".field") && el.closest(".field").classList.contains("invalid")) {
            if (!fieldProblem(el)) showFieldError(el, null);
          }
        });
        el.addEventListener("blur", function () {
          if ((el.value || "").trim()) showFieldError(el, fieldProblem(el));
        });
      });

      enq.addEventListener("submit", function (e) {
        e.preventDefault();
        var bad = [];
        fields.forEach(function (el) {
          var msg = fieldProblem(el);
          showFieldError(el, msg);
          if (msg) bad.push(el);
        });
        if (bad.length) {
          summary.textContent = bad.length === 1
            ? "One field needs fixing before we can take your enquiry. It is marked below."
            : bad.length + " fields need fixing before we can take your enquiry. They are marked below.";
          summary.classList.add("show");
          bad[0].focus();
          return;
        }
        summary.classList.remove("show");
        summary.textContent = "";
        /* Deliberately NOT "message sent": there is no backend to confirm it. */
        (enq.closest(".enquiry-form") || enq).classList.add("done");
      });
    }

    var nl = document.getElementById("news-form");
    if (nl) {
      var inp = nl.querySelector("input");
      var nerr = nl.querySelector(".news-err");
      if (!nerr) {
        nerr = document.createElement("p");
        nerr.className = "news-err";
        nerr.id = "nl-err";
        nerr.setAttribute("role", "alert");
        nl.appendChild(nerr);
      }
      inp.addEventListener("input", function () {
        nerr.classList.remove("show");
        inp.removeAttribute("aria-invalid");
      });
      nl.addEventListener("submit", function (e) {
        e.preventDefault();
        var v = (inp.value || "").trim();
        var msg = !v ? "Enter your email address to join the Drop List."
          : !EMAIL_RE.test(v) ? "That email address looks incomplete. Check the @ and the domain."
          : null;
        if (msg) {
          nerr.textContent = msg;
          nerr.classList.add("show");
          inp.setAttribute("aria-invalid", "true");
          inp.setAttribute("aria-describedby", nerr.id);
          inp.focus();
          return;
        }
        nerr.classList.remove("show");
        document.getElementById("news-band").classList.add("done");
      });
    }
  }

  function init() {
    loadState();
    build();
    bindPcWidgets();
    bindForms();
    var cbtn = document.getElementById("cart-btn");
    if (cbtn) cbtn.addEventListener("click", openDrawer);
    window.addEventListener("scroll", updateStickyVisibility, { passive: true });
    window.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeDrawer(); closeCheckout(); } });
    renderAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
