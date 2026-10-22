/* ============================================================
   SPIRITDROP - MEET YOUR DROP
   Real dispenser renders, one per flavour, swapped by a keyboard
   accessible flavour selector. Two stacked <img> layers give a
   fast crossfade; no carousel, no autoplay, no slideshow.
   Reads the shared data layer - no prices or copy live here.
   ============================================================ */
(function () {
  "use strict";
  var root = document.getElementById("mydrop");
  if (!root || !window.FLAVOURS || !window.SD) return;
  var F = window.FLAVOURS.filter(function (f) { return f.disp; });
  if (!F.length) return;

  var info = root.querySelector(".md-info");
  var selWrap = root.querySelector(".md-sel");
  var layers = [root.querySelector(".md-a"), root.querySelector(".md-b")];
  var front = 0, cur = -1;
  var R = window.SD.RULES;

  F.forEach(function (f, i) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "md-chip";
    b.textContent = f.name;
    b.setAttribute("aria-pressed", "false");
    b.dataset.i = i;
    b.addEventListener("click", function () { show(i); });
    b.addEventListener("keydown", function (e) {
      var n = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0);
      if (!n) return;
      e.preventDefault();
      var j = (i + n + F.length) % F.length;
      show(j);
      selWrap.children[j].focus();
    });
    selWrap.appendChild(b);
  });

  function show(i) {
    if (i === cur) return;
    var f = F[i], d = window.SD.dispenserFor(f);
    var next = layers[1 - front];
    next.onload = null;
    next.src = d.src;
    next.srcset = d.srcset;
    next.alt = d.alt;
    next.classList.add("on");
    layers[front].classList.remove("on");
    front = 1 - front;
    root.style.setProperty("--mood", f.mood);
    info.innerHTML =
      '<span class="md-k">' + f.base + ' base</span>' +
      '<h3>' + f.name + '</h3>' +
      '<p class="md-profile">' + f.profile + '</p>' +
      '<dl class="md-facts">' +
        '<div><dt>Per dispenser</dt><dd>' + R.drinksPerDispenser + ' ready-to-pour drinks</dd></div>' +
        '<div><dt>Price</dt><dd>' + window.SD.money(R.dispenserPrice) + ' per dispenser</dd></div>' +
        '<div><dt>Bond</dt><dd>' + window.SD.money(R.bondPerDispenser) + ' refundable, per dispenser</dd></div>' +
      '</dl>' +
      '<div class="md-cta">' +
        '<a class="btn btn-primary" href="/product?flavour=' + f.slug + '">View ' + f.name + ' <span class="arrow">&rarr;</span></a>' +
        '<a class="btn btn-ghost" href="#build">Build Your Drop</a>' +
      '</div>';
    Array.prototype.forEach.call(selWrap.children, function (b, j) {
      b.classList.toggle("on", j === i);
      b.setAttribute("aria-pressed", j === i ? "true" : "false");
    });
    cur = i;
  }
  show(0);
})();
