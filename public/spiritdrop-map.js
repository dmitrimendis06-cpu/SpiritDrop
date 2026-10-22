/* ============================================================
   SPIRITDROP — interactive Australia map (brand / expansion)

   GEOMETRY: real longitude/latitude coordinate arrays projected
   with an equirectangular projection corrected for the mean
   latitude of Australia, so proportions read correctly instead
   of being horizontally stretched. Coastline vertices are real
   coastal points (capes, gulfs, peninsulas); state borders use
   Australia's actual surveyed meridians and parallels:

     WA | NT, WA | SA          129°E
     NT | SA, SA | QLD          26°S
     SA | QLD, SA | NSW, SA|VIC 141°E
     NT | QLD                  138°E
     QLD | NSW                 ~29°S (river/range line)
     NSW | VIC                 Murray River → Cape Howe

   AUTHORITY: this map does NOT decide delivery eligibility or
   price. That is SD.ZONES + the postcode checker, which sit
   ABOVE this section on the Delivery page. NSW "operating" means
   SpiritDrop operates in NSW within selected zones — never that
   it delivers to every NSW address. City markers indicate
   geography only, never service availability.
   ============================================================ */
(function () {
  "use strict";

  /* ---- projection ---- */
  var LON0 = 112.2, LAT0 = -9.2, K = 13.6, XS = 0.9; /* XS ≈ cos(26°) */
  function px(lon) { return (lon - LON0) * K * XS; }
  function py(lat) { return (LAT0 - lat) * K; }
  function poly(coords) {
    return coords.map(function (c, i) { return (i ? "L" : "M") + px(c[0]).toFixed(1) + " " + py(c[1]).toFixed(1); }).join(" ") + " Z";
  }

  /* ---- states: real coastline points + surveyed borders ---- */
  var WA = [
    [129,-14.85],[128.5,-14.9],[127.8,-14.0],[126.9,-13.7],[125.9,-14.3],[125.0,-14.5],[124.3,-16.0],[123.6,-16.4],
    [122.9,-16.5],[122.2,-18.0],[121.0,-19.6],[119.5,-20.1],[117.9,-20.7],[116.0,-20.6],[114.9,-21.4],[114.1,-21.8],
    [113.6,-22.6],[114.1,-24.0],[113.4,-26.1],[114.1,-27.4],[114.6,-28.8],[115.0,-30.0],[115.7,-31.3],[115.86,-32.0],
    [115.6,-33.3],[115.1,-34.37],[116.5,-35.1],[117.9,-35.02],[119.9,-34.0],[121.9,-33.86],[123.5,-33.9],[125.5,-32.6],
    [127.0,-32.0],[129,-31.7],[129,-14.85]
  ];
  var NT = [
    [129,-14.85],[129.7,-14.9],[130.2,-13.0],[130.85,-12.46],[131.5,-12.2],[132.5,-11.4],[133.5,-11.6],[134.4,-12.0],
    [135.4,-12.2],[136.5,-12.0],[136.9,-12.5],[136.7,-13.7],[135.9,-14.9],[135.4,-15.5],[136.3,-16.0],[137.0,-16.1],
    [138.0,-16.55],[138,-26],[129,-26],[129,-14.85]
  ];
  var QLD = [
    [138.0,-16.55],[139.5,-17.6],[140.8,-17.5],[141.6,-15.0],[141.5,-13.0],[142.0,-11.0],[142.53,-10.7],[143.2,-12.0],
    [143.9,-14.5],[145.3,-15.0],[145.77,-16.92],[146.8,-19.26],[148.0,-20.1],[149.2,-21.1],[150.5,-22.4],[151.0,-23.9],
    [151.9,-24.5],[153.1,-25.3],[153.05,-27.47],[153.55,-28.2],[152.5,-28.2],[151.0,-28.9],[149.0,-28.9],[145.0,-29.0],
    [141.0,-29.0],[141,-26],[138,-26],[138.0,-16.55]
  ];
  var NSW = [
    [153.55,-28.2],[153.4,-29.4],[153.0,-30.3],[152.9,-31.4],[152.5,-32.4],[151.8,-32.9],[151.21,-33.87],[150.9,-34.6],
    [150.2,-35.6],[150.1,-36.4],[149.97,-37.5],[148.2,-36.5],[147.0,-36.0],[146.0,-35.9],[144.6,-35.9],[143.3,-34.8],
    [142.0,-34.2],[141.0,-34.0],[141.0,-29.0],[145.0,-29.0],[149.0,-28.9],[151.0,-28.9],[152.5,-28.2],[153.55,-28.2]
  ];
  var VIC = [
    [141.0,-34.0],[141.0,-38.06],[142.5,-38.4],[143.5,-38.8],[144.6,-38.4],[144.96,-38.1],[145.5,-38.7],[146.4,-39.1],
    [147.5,-38.1],[148.5,-37.8],[149.97,-37.5],[148.2,-36.5],[147.0,-36.0],[146.0,-35.9],[144.6,-35.9],[143.3,-34.8],
    [142.0,-34.2],[141.0,-34.0]
  ];
  var SA = [
    [129,-31.7],[130.5,-31.5],[132.0,-31.9],[134.0,-32.7],[135.0,-34.0],[135.9,-34.7],[136.9,-35.3],[137.0,-34.0],
    [137.6,-35.2],[138.1,-34.2],[138.5,-35.0],[139.3,-35.6],[140.0,-37.5],[141.0,-38.06],[141,-26],[129,-26],[129,-31.7]
  ];
  var TAS = [
    [144.7,-40.7],[145.3,-40.8],[146.5,-41.1],[148.0,-40.75],[148.3,-41.9],[148.0,-42.6],[147.9,-43.2],[147.0,-43.6],
    [146.0,-43.55],[145.2,-42.5],[144.6,-41.5],[144.7,-40.7]
  ];
  /* ACT drawn at true size (~0.6° tall) — deliberately small, with a
     larger invisible hit target so it stays tappable. */
  var ACT = [[148.76,-35.12],[149.4,-35.12],[149.4,-35.92],[148.76,-35.92],[148.76,-35.12]];

  var STATES = [
    { id: "nsw", name: "New South Wales", short: "NSW", live: true, status: "Selected zones operating",
      note: "Currently operating within selected NSW delivery zones.", path: NSW },
    { id: "vic", name: "Victoria", short: "VIC", live: false, status: "Coming soon", note: "Coming soon.", path: VIC },
    { id: "qld", name: "Queensland", short: "QLD", live: false, status: "Coming soon", note: "Coming soon.", path: QLD },
    { id: "sa", name: "South Australia", short: "SA", live: false, status: "Coming soon", note: "Coming soon.", path: SA },
    { id: "wa", name: "Western Australia", short: "WA", live: false, status: "Coming soon", note: "Coming soon.", path: WA },
    { id: "tas", name: "Tasmania", short: "TAS", live: false, status: "Coming soon", note: "Coming soon.", path: TAS },
    { id: "nt", name: "Northern Territory", short: "NT", live: false, status: "Coming soon", note: "Coming soon.", path: NT },
    { id: "act", name: "Australian Capital Territory", short: "ACT", live: false, status: "Coming soon", note: "Coming soon.", path: ACT }
  ];

  /* Geography only — a marker never implies SpiritDrop operates there. */
  var CITIES = [
    { name: "Sydney", lon: 151.21, lat: -33.87, home: true, dx: 8, dy: 4 },
    { name: "Brisbane", lon: 153.03, lat: -27.47, dx: 8, dy: 4 },
    { name: "Melbourne", lon: 144.96, lat: -37.81, dx: -8, dy: 13, anchor: "end" },
    { name: "Adelaide", lon: 138.6, lat: -34.93, dx: -8, dy: 4, anchor: "end" },
    { name: "Perth", lon: 115.86, lat: -31.95, dx: 8, dy: 4 },
    { name: "Hobart", lon: 147.33, lat: -42.88, dx: 8, dy: 4 },
    { name: "Darwin", lon: 130.85, lat: -12.46, dx: 8, dy: -3 },
    { name: "Canberra", lon: 149.13, lat: -35.28, dx: 8, dy: 12 }
  ];

  var NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function init() {
    var host = document.getElementById("au-map");
    if (!host) return;
    var canvas = host.querySelector("#au-canvas");
    var statusEl = host.querySelector("#au-status");
    var listEl = host.querySelector("#au-list");
    var tip = host.querySelector("#au-tip");

    var W = px(154.6), H = py(-44.6);
    var svg = el("svg", {
      viewBox: "0 0 " + W.toFixed(0) + " " + H.toFixed(0),
      class: "aum-svg", role: "img",
      "aria-label": "Map of Australia. New South Wales is currently operating within selected delivery zones. All other states and territories are coming soon."
    });

    var gStates = el("g", { class: "aum-states" });
    var gCities = el("g", { class: "aum-cities" });
    svg.appendChild(gStates);
    svg.appendChild(gCities);

    function setStatus(s) {
      statusEl.innerHTML =
        '<span class="aus-dot' + (s.live ? " live" : "") + '" aria-hidden="true"></span>' +
        '<span class="aus-txt"><b>' + s.name + "</b>" +
        '<span class="aus-state">' + (s.live ? "Operating" : "Coming soon") + "</span>" + s.note + "</span>";
    }
    function select(s) {
      setStatus(s);
      gStates.querySelectorAll(".aum-state").forEach(function (p) { p.classList.toggle("on", p.dataset.id === s.id); });
      listEl.querySelectorAll(".aul").forEach(function (b) {
        var on = b.dataset.id === s.id;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    function showTip(s, evt) {
      tip.innerHTML = "<b>" + s.name + "</b><span>" + s.status + "</span>";
      tip.classList.add("show");
      var r = canvas.getBoundingClientRect();
      var x = evt.clientX - r.left, y = evt.clientY - r.top;
      tip.style.left = Math.max(4, Math.min(r.width - 4, x)) + "px";
      tip.style.top = Math.max(0, y - 14) + "px";
    }
    function hideTip() { tip.classList.remove("show"); }

    STATES.forEach(function (s) {
      var d = poly(s.path);
      var p = el("path", { d: d, class: "aum-state" + (s.live ? " live" : "") + (s.id === "act" ? " tiny" : "") });
      p.dataset.id = s.id;
      p.appendChild(el("title", {})).textContent = s.name + " — " + s.status;
      /* ACT is genuinely small: give it a wider invisible hit path. */
      if (s.id === "act") {
        var hit = el("path", { d: d, class: "aum-hit" });
        hit.dataset.id = s.id;
        bind(hit, s);
        gStates.appendChild(p);
        gStates.appendChild(hit);
      } else {
        bind(p, s);
        gStates.appendChild(p);
      }
    });

    function bind(node, s) {
      node.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse") { select(s); showTip(s, e); } });
      node.addEventListener("pointermove", function (e) { if (e.pointerType === "mouse") showTip(s, e); });
      node.addEventListener("pointerleave", hideTip);
      node.addEventListener("click", function (e) { select(s); showTip(s, e); setTimeout(hideTip, 1800); });
    }

    CITIES.forEach(function (c) {
      var x = px(c.lon), y = py(c.lat);
      if (c.home) {
        gCities.appendChild(el("circle", { cx: x, cy: y, r: 9, class: "aum-pulse" }));
        gCities.appendChild(el("circle", { cx: x, cy: y, r: 3.4, class: "aum-city home" }));
      } else {
        gCities.appendChild(el("circle", { cx: x, cy: y, r: 2.2, class: "aum-city" }));
      }
      var t = el("text", {
        x: x + c.dx, y: y + c.dy, class: "aum-clabel" + (c.home ? " home" : ""),
        "text-anchor": c.anchor === "end" ? "end" : "start"
      });
      t.textContent = c.name;
      gCities.appendChild(t);
    });

    canvas.appendChild(svg);

    /* Keyboard-accessible equivalent of the SVG paths. */
    STATES.slice().sort(function (a, b) { return a.live === b.live ? 0 : (a.live ? -1 : 1); }).forEach(function (s) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "aul" + (s.live ? " live" : "");
      b.dataset.id = s.id;
      b.setAttribute("aria-pressed", "false");
      b.innerHTML = '<span class="aul-s">' + s.short + "</span>";
      b.addEventListener("click", function () { select(s); });
      b.addEventListener("focus", function () { select(s); });
      listEl.appendChild(b);
    });

    select(STATES[0]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
