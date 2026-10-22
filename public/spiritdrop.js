/* ============================================================
   SPIRITDROP — interactions
   Nav · reveal (progressive enhancement) · flavour rail ·
   Build Your Drop configurator · delivery-zone panel · FAQ
   ============================================================ */
(function () {
  "use strict";

  var SD = window.SD || {};
  var R = SD.RULES || { dispenserPrice: 200, bondPerDispenser: 50, drinksPerDispenser: 20 };
  var money = SD.money || function (n) { return "$" + n; };

  /* ---- Nav scroll state ---- */
  var nav = document.querySelector(".nav");
  function onScroll() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 30);
    var halo = document.querySelector(".hero-stage .halo");
    if (halo) halo.style.transform = "translateY(" + (window.scrollY * 0.1) + "px)";
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---- Mobile menu ---- */
  var burger = document.querySelector(".burger");
  var menu = document.querySelector(".mobile-menu");
  if (burger && menu) {
    var setMenu = function (open) {
      burger.classList.toggle("open", open);
      menu.classList.toggle("open", open);
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.style.overflow = open ? "hidden" : "";
      /* keep the closed menu out of the tab order and off screen readers */
      menu.querySelectorAll("a").forEach(function (a) { a.tabIndex = open ? 0 : -1; });
    };
    var closeMenu = function (refocus) {
      setMenu(false);
      if (refocus) burger.focus();
    };
    setMenu(false);
    burger.addEventListener("click", function () {
      var open = !menu.classList.contains("open");
      setMenu(open);
      if (open) {
        var first = menu.querySelector("a");
        if (first) first.focus();
      }
    });
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { setMenu(false); });
    });
    /* Escape closes and returns focus to the button that opened it */
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.classList.contains("open")) closeMenu(true);
    });
    /* rotating to desktop while open must not leave the body scroll-locked */
    window.addEventListener("resize", function () {
      if (window.innerWidth > 980 && menu.classList.contains("open")) closeMenu(false);
    }, { passive: true });
  }

  /* ---- Reveal on scroll — PROGRESSIVE ENHANCEMENT ONLY.
          .reveal is only hidden while html.js is set (see the inline
          head script). A safety timer reveals everything even if a
          scroll event never fires, so content can never be stranded. ---- */
  var revealEls = [].slice.call(document.querySelectorAll(".reveal"));
  function revealInView() {
    var vh = window.innerHeight || document.documentElement.clientHeight;
    for (var i = revealEls.length - 1; i >= 0; i--) {
      var r = revealEls[i].getBoundingClientRect();
      if (r.top < vh - 50 && r.bottom > 0) { revealEls[i].classList.add("in"); revealEls.splice(i, 1); }
    }
    if (!revealEls.length) window.removeEventListener("scroll", onReveal);
  }
  var ticking = false;
  function onReveal() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { revealInView(); ticking = false; });
  }
  window.addEventListener("scroll", onReveal, { passive: true });
  window.addEventListener("resize", onReveal, { passive: true });
  window.addEventListener("load", revealInView);
  revealInView();
  setTimeout(revealInView, 200);
  setTimeout(function () {
    document.querySelectorAll(".reveal:not(.in)").forEach(function (e) { e.classList.add("in"); });
  }, 2600);

  /* ---- Flavour carousel ---- */
  var track = document.querySelector(".flav-track");
  var prevBtn = document.querySelector(".flav-prev");
  var nextBtn = document.querySelector(".flav-next");
  if (track) {
    var cardStep = function () {
      var card = track.querySelector(".flav-card");
      if (!card) return 350;
      return card.offsetWidth + (parseFloat(getComputedStyle(track).gap) || 20);
    };
    var updateArrows = function () {
      if (!prevBtn || !nextBtn) return;
      prevBtn.disabled = track.scrollLeft < 8;
      nextBtn.disabled = track.scrollLeft > track.scrollWidth - track.clientWidth - 8;
    };
    if (prevBtn) prevBtn.addEventListener("click", function () { track.scrollBy({ left: -cardStep(), behavior: "smooth" }); });
    if (nextBtn) nextBtn.addEventListener("click", function () { track.scrollBy({ left: cardStep(), behavior: "smooth" }); });
    track.addEventListener("scroll", updateArrows, { passive: true });
    updateArrows();

    var down = false, startX = 0, startScroll = 0, moved = false;
    track.addEventListener("pointerdown", function (e) { down = true; moved = false; startX = e.clientX; startScroll = track.scrollLeft; track.classList.add("drag"); });
    window.addEventListener("pointermove", function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 4) moved = true;
      track.scrollLeft = startScroll - dx;
    });
    window.addEventListener("pointerup", function () { down = false; track.classList.remove("drag"); });
    track.addEventListener("click", function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);
  }

  /* ============================================================
     BUILD YOUR DROP — quantity + one flavour per dispenser.
     Reads price / bond / drinks from window.SD.RULES only.
     ============================================================ */
  (function buildYourDrop() {
    var host = document.getElementById("build-drop");
    if (!host || !window.FLAVOURS) return;
    var FL = window.FLAVOURS;
    var draft = [FL[0].name];

    var rows = host.querySelector("#bd-rows");
    var qval = host.querySelector("#bd-qty");
    var sums = host.querySelector("#bd-sum");

    function render() {
      qval.textContent = draft.length;
      rows.innerHTML = draft.map(function (name, i) {
        var opts = FL.map(function (f) { return '<option value="' + f.name + '"' + (f.name === name ? " selected" : "") + ">" + f.name + " · " + f.base + "</option>"; }).join("");
        var f = FL.filter(function (x) { return x.name === name; })[0] || FL[0];
        return '<div class="bd-row" style="--mood:' + f.mood + '">' +
          '<span class="bd-n">' + String(i + 1).padStart(2, "0") + "</span>" +
          '<span class="bd-sel"><label class="sr-only" for="bd-f-' + i + '">Flavour for dispenser ' + (i + 1) + "</label>" +
          '<select id="bd-f-' + i + '" data-i="' + i + '">' + opts + "</select></span>" +
          '<span class="bd-drinks">' + R.drinksPerDispenser + " drinks</span>" +
          '<span class="bd-price">' + money(R.dispenserPrice) + "</span>" +
          "</div>";
      }).join("");
      rows.querySelectorAll("select").forEach(function (s) {
        s.addEventListener("change", function () { draft[+s.dataset.i] = s.value; render(); });
      });
      var n = draft.length;
      sums.innerHTML =
        '<div class="bd-line"><span>' + n + " × dispenser</span><b>" + money(n * R.dispenserPrice) + "</b></div>" +
        '<div class="bd-line"><span>Refundable equipment bond (' + n + " × " + money(R.bondPerDispenser) + ")</span><b>" + money(n * R.bondPerDispenser) + "</b></div>" +
        '<div class="bd-line"><span>Delivery fee</span><b class="soft">Calculated by location at checkout</b></div>' +
        '<div class="bd-line total"><span>' + (n * R.drinksPerDispenser) + " ready-to-pour drinks</span><b>" + money(n * R.dispenserPrice + n * R.bondPerDispenser) + "</b></div>";
    }

    host.querySelector("#bd-plus").addEventListener("click", function () { draft.push(draft[draft.length - 1] || FL[0].name); render(); });
    host.querySelector("#bd-minus").addEventListener("click", function () { if (draft.length > 1) { draft.pop(); render(); } });
    host.querySelector("#bd-add").addEventListener("click", function () {
      if (window.SpiritCart) window.SpiritCart.addMany(draft.slice());
    });
    render();
  })();

  /* ============================================================
     DELIVERY ZONE PANEL — rendered from SD.ZONES so the homepage,
     Delivery page and checkout can never disagree.
     ============================================================ */
  (function zonePanel() {
    var hosts = document.querySelectorAll("[data-zone-bands]");
    if (!hosts.length || !SD.ZONES) return;
    var html = SD.ZONES.map(function (z, i) {
      return '<div class="zb" style="--i:' + i + '">' +
        '<div class="zb-head"><span class="zb-tag">' + z.name.replace(/^Zone (\d+) · /, "Zone $1 —&nbsp;") + "</span>" +
        '<span class="zb-fee">' + (z.fee === 0 ? "No delivery fee" : money(z.fee) + " delivery") + "</span></div>" +
        '<p class="zb-blurb">' + z.blurb + "</p>" +
        "</div>";
    }).join("");
    hosts.forEach(function (h) { h.innerHTML = html; });
  })();

  /* ---- FAQ accordion ---- */
  document.querySelectorAll(".faq-item").forEach(function (item, fi) {
    var q = item.querySelector(".faq-q");
    var a = item.querySelector(".faq-a");
    if (!q || !a) return;
    /* tie the button to the panel it controls so the state is announced */
    if (!a.id) a.id = "faq-panel-" + fi;
    q.setAttribute("aria-controls", a.id);
    a.setAttribute("role", "region");
    q.setAttribute("aria-expanded", "false");
    q.addEventListener("click", function () {
      var isOpen = item.classList.contains("open");
      document.querySelectorAll(".faq-item.open").forEach(function (o) {
        o.classList.remove("open");
        o.querySelector(".faq-a").style.maxHeight = null;
        o.querySelector(".faq-q").setAttribute("aria-expanded", "false");
      });
      if (!isOpen) {
        item.classList.add("open");
        a.style.maxHeight = a.scrollHeight + "px";
        q.setAttribute("aria-expanded", "true");
      }
    });
  });

  /* ---- Smooth anchor scroll w/ nav offset ---- */
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("href");
      if (id.length < 2) return;
      var target = document.querySelector(id);
      if (target) { e.preventDefault(); window.scrollTo({ top: target.offsetTop - 50, behavior: "smooth" }); }
    });
  });
})();
