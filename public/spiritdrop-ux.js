/* ============================================================
   SPIRITDROP — production hygiene layer
   Skip link · back to top · UTM capture · analytics consent
   scaffold · footer year.

   Everything here is additive and defensive: if this file fails
   to load, every page still works. Nothing here changes pricing,
   delivery, checkout or compliance behaviour.
   ============================================================ */
(function () {
  "use strict";

  /* ============================================================
     ANALYTICS CONFIG — deliberately empty.

     No GA4 / Clarity / Meta property has been supplied, so no
     non-essential tracking runs and NO consent banner is shown.
     Showing a cookie banner while nothing is being tracked is
     theatre, and it trains customers to dismiss real notices.

     To switch tracking on later, put the real IDs here. The
     consent notice then appears automatically and scripts only
     load after the customer accepts.
     ============================================================ */
  var ANALYTICS = {
    ga4: null,      /* e.g. "G-XXXXXXXXXX" */
    clarity: null,  /* e.g. "abcdefghij"   */
    metaPixel: null
  };

  var CONSENT_KEY = "sd_consent_v1";
  var UTM_KEY = "sd_campaign_v1";
  var UTM_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"];

  function hasTracking() {
    return !!(ANALYTICS.ga4 || ANALYTICS.clarity || ANALYTICS.metaPixel);
  }

  /* ============================================================
     1. UTM / CAMPAIGN CAPTURE
     Reads campaign parameters off the landing URL and keeps them
     for the session so a later conversion can be attributed.

     Strictly campaign metadata. Never a name, email, phone, DOB,
     address or recipient: those are typed into checkout and stay
     in memory on the page they were entered on.

     Parameters are read, not stripped, so links keep working and
     nothing here can interfere with navigation or checkout.
     ============================================================ */
  function captureCampaign() {
    var stored = {};
    try { stored = JSON.parse(sessionStorage.getItem(UTM_KEY)) || {}; } catch (e) { stored = {}; }

    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return stored; }

    var found = false;
    UTM_FIELDS.forEach(function (k) {
      var v = params.get(k);
      if (!v) return;
      /* length cap + tag strip: campaign values are short slugs, and a
         hostile value should never reach an analytics payload verbatim */
      stored[k] = String(v).replace(/[<>"']/g, "").slice(0, 120);
      found = true;
    });

    if (found) {
      stored.landing_page = window.location.pathname;
      stored.first_seen = stored.first_seen || new Date().toISOString().slice(0, 10);
      try { sessionStorage.setItem(UTM_KEY, JSON.stringify(stored)); } catch (e) {}
    }
    return stored;
  }

  var campaign = captureCampaign();

  /* Exposed so a future analytics/booking backend can attach campaign
     data to an order without re-parsing the URL. Read-only by convention. */
  window.SD = window.SD || {};
  window.SD.campaign = campaign;

  /* dataLayer is populated regardless of consent because it is only an
     in-page array; nothing leaves the browser until a tag loads. */
  window.dataLayer = window.dataLayer || [];
  if (Object.keys(campaign).length) {
    window.dataLayer.push({ event: "campaign_context", campaign: campaign });
  }

  /* ============================================================
     2. CONSENT NOTICE (only when tracking is actually configured)
     ============================================================ */
  function loadTrackers() {
    /* Real tag loading goes here once IDs exist. Kept deliberately
       inert rather than guessing property IDs. */
    window.dataLayer.push({ event: "consent_granted" });
  }

  function consentState() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }

  function initConsent() {
    if (!hasTracking()) return;              /* nothing to consent to */
    var state = consentState();
    if (state === "granted") { loadTrackers(); return; }
    if (state === "declined") return;

    var bar = document.createElement("div");
    bar.className = "consent";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Analytics cookies");
    bar.innerHTML =
      '<p>We\'d like to use analytics cookies to see which pages are useful. ' +
      'Essential cookies keep your cart working either way. ' +
      '<a href="/legal#privacy">Privacy Policy</a></p>' +
      '<div class="consent-act">' +
        '<button type="button" class="btn btn-ghost" data-consent="declined">Decline</button>' +
        '<button type="button" class="btn btn-primary" data-consent="granted">Accept</button>' +
      '</div>';
    document.body.appendChild(bar);

    bar.addEventListener("click", function (e) {
      var b = e.target.closest("[data-consent]");
      if (!b) return;
      var choice = b.getAttribute("data-consent");
      try { localStorage.setItem(CONSENT_KEY, choice); } catch (err) {}
      bar.remove();
      if (choice === "granted") loadTrackers();
    });
  }

  /* ============================================================
     3. BACK TO TOP
     Only built on pages long enough to need it, and only revealed
     after a real scroll. No bounce, no pulse: it is a button.
     ============================================================ */
  function initBackToTop() {
    var doc = document.documentElement;
    if (doc.scrollHeight < window.innerHeight * 3.2) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "to-top";
    btn.setAttribute("aria-label", "Back to top");
    btn.innerHTML = '<span aria-hidden="true">\u2191</span><span class="tt-t">Top</span>';
    document.body.appendChild(btn);

    btn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
      /* send keyboard focus back to the top of the document, otherwise
         the next Tab resumes from the footer */
      var main = document.getElementById("main");
      if (main) { main.focus({ preventScroll: true }); }
    });

    var shown = false;
    function onScroll() {
      var should = window.scrollY > window.innerHeight * 1.5;
      if (should === shown) return;
      shown = should;
      btn.classList.toggle("show", should);
      /* keep it out of the tab order while invisible */
      btn.tabIndex = should ? 0 : -1;
    }
    btn.tabIndex = -1;
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ============================================================
     4. FOOTER YEAR
     The markup carries a real year, so this only corrects it as
     time passes. No JS dependency for the copyright line.
     ============================================================ */
  function initYear() {
    var y = String(new Date().getFullYear());
    document.querySelectorAll("[data-year]").forEach(function (el) {
      if (el.textContent.trim() !== y) el.textContent = y;
    });
  }

  function init() {
    initBackToTop();
    initConsent();
    initYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
