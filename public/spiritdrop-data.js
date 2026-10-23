/* ============================================================
   SPIRITDROP — SHARED PUBLIC DATA LAYER
   Single source of truth for every page, cart, sidebar and
   checkout step. Loaded BEFORE spiritdrop-cart.js and any page
   render script.

   PUBLIC / CUSTOMER-FACING DATA ONLY.
   Production recipes, ingredient quantities, mL ratios, batch
   formulations and internal fleet data are INTERNAL and must
   never be added to this file.

   Prices calculated here are for DISPLAY ONLY. When the backend
   lands, all money (product, bond, delivery, add-ons, total)
   must be recalculated and validated server-side.
   ============================================================ */
(function () {
  "use strict";

  window.SD = window.SD || {};

  /* ============================================================
     1. MASTER BUSINESS RULES — every component reads these
     ============================================================ */
  window.SD.RULES = {
    dispenserPrice: 200,          /* $200 per dispenser, no quantity discounts */
    bondPerDispenser: 50,         /* $50 refundable equipment bond, PER dispenser */
    drinksPerDispenser: 20,       /* "20 ready-to-pour drinks per dispenser" */
    bondTerm: "Refundable Equipment Bond",
    basePostcode: "2170",         /* Liverpool base */
    collection: "next-day",       /* collection is ALWAYS next day */
    setupIncluded: true           /* basic setup included: delivered, set up, ready to pour */
  };

  /* Approved customer-facing wording. Use these instead of re-writing
     compliance / delivery copy per page. */
  window.SD.COPY = {
    drinks: "20 ready-to-pour drinks per dispenser",
    bond: "$50 refundable equipment bond per dispenser",
    setup: "Delivered, set up and ready to pour.",
    collection: "Next-day collection included.",
    deliveryFee: "Delivery fee calculated based on location.",
    deliveryArea: "We deliver to selected zones around our Liverpool (2170) base.",
    windows: "Available delivery windows are shown during checkout.",
    outsideArea: "This location is currently outside our standard delivery area. Contact SpiritDrop to discuss availability.",
    responsibleSupply: "The person receiving the delivery must be 18+ and may be required to provide valid ID. The purchaser is responsible for ensuring alcohol supplied by SpiritDrop is not unlawfully supplied to minors and is consumed in accordance with NSW liquor laws.",
    /* Approved NSW online notice — shown prominently in the cart, checkout and footer. */
    under18: "No Alcohol can be sold or supplied to anyone under 18. It's against the law.",
    licence: "NSW Packaged Liquor Licence: LIQP770018577",
    licensee: "Licensee: Dmitri Mendis",
    abn: "ABN 84 187 494 574",
    email: "spiritdropjd@gmail.com",
    prototype: "Prototype — no payment is taken and nothing is submitted, emailed or stored at this stage."
  };

  /* ============================================================
     2. FLAVOUR RANGE — exactly 12 current flavours
     Fields are public: id, name, slug, base, profile, image,
     accent colour, price. No recipes.
     ============================================================ */
  var P = window.SD.RULES.dispenserPrice;

  window.FLAVOURS = [
    {
      id: "sd-01", name: "Tropical Sunset", slug: "tropical-sunset", disp: "orange", img: "/images/tropical-sunset.jpeg",
      base: "Vodka", baseKey: "vodka", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Tropical, fruity and bright with peach, mango, pineapple and orange notes.",
      feel: "Easy-drinking and refreshing, for anyone who likes a classic tropical pour.",
      notes: ["Peach", "Mango", "Pineapple", "Orange"],
      best: "Golden-hour backyard gatherings",
      grad: "linear-gradient(160deg,#ffb54d,#ff6a2f)", mood: "#ff9a3d",
      badges: ["tropical"], cats: ["tropical", "fruity"]
    },
    {
      id: "sd-02", name: "Pineberry Spirit", slug: "pineberry-spirit", disp: "berry", img: "/images/pineberry-spirit.jpeg",
      base: "Vodka", baseKey: "vodka", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Sweet berry flavours balanced with tropical pineapple and watermelon.",
      feel: "Fruity and vibrant — a little richer than Tropical Sunset.",
      notes: ["Berry", "Pineapple", "Watermelon"],
      best: "Engagement parties",
      grad: "linear-gradient(160deg,#ff6a72,#c02234)", mood: "#ef4a58",
      badges: ["sweet"], cats: ["fruity", "sweet"]
    },
    {
      id: "sd-03", name: "Sweetmelon Vodka", slug: "sweetmelon-vodka", disp: "coral", img: "/images/sweet-melon.jpeg",
      base: "Vodka", baseKey: "vodka", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Sweet watermelon with vanilla softness and a cooling mint finish.",
      feel: "Fresh, smooth and distinctly melon-forward.",
      notes: ["Watermelon", "Vanilla", "Mint"],
      best: "Summer house parties",
      grad: "linear-gradient(160deg,#ff8a94,#e04a5e)", mood: "#ff6f80",
      badges: ["refreshing"], cats: ["refreshing", "fruity"]
    },
    {
      id: "sd-04", name: "Strawberry Cream", slug: "strawberry-cream", disp: "blush", img: "/images/strawberry-cream.jpeg",
      base: "Baileys", baseKey: "baileys", available: true, price: P,
      allergens: ["Milk"], allergensVerified: true,
      profile: "Creamy strawberry with a rich Baileys character.",
      feel: "Sweet, smooth and dessert-like.",
      notes: ["Strawberry", "Cream"],
      best: "21st birthdays",
      grad: "linear-gradient(160deg,#ffd0da,#ff7093)", mood: "#ff8fae",
      badges: ["creamy"], cats: ["creamy", "sweet"]
    },
    {
      id: "sd-05", name: "Fruit Fizz", slug: "fruit-fizz", disp: "orange", img: "/images/fruit-fizz.jpeg",
      base: "Malibu", baseKey: "malibu", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Tropical coconut, pineapple and mango with a fresh lime finish.",
      feel: "Bright, tropical and refreshing.",
      notes: ["Coconut", "Pineapple", "Mango", "Lime"],
      best: "Celebrations and milestones",
      grad: "linear-gradient(160deg,#ffd06b,#ff8f3d)", mood: "#ffb03d",
      badges: ["tropical"], cats: ["tropical", "refreshing"]
    },
    {
      id: "sd-06", name: "Coconut Fix", slug: "coconut-fix", disp: "cream", img: "/images/coconut-fix.jpeg",
      base: "Malibu", baseKey: "malibu", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Coconut and lychee paired with tropical pineapple.",
      feel: "Smooth and exotic, with a noticeable lychee character.",
      notes: ["Coconut", "Lychee", "Pineapple"],
      best: "Summer entertaining",
      grad: "linear-gradient(160deg,#fbf0d2,#e8cf96)", mood: "#f0dcaa",
      badges: ["creamy", "tropical"], cats: ["creamy", "tropical"]
    },
    {
      id: "sd-07", name: "Mint Mojito", slug: "mint-mojito", disp: "mint", img: "/images/mint-mojito.jpeg",
      base: "Bacardi", baseKey: "bacardi", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Fresh mint and lime with a crisp mojito-style citrus finish.",
      feel: "Clean and refreshing — a classic mojito profile.",
      notes: ["Mint", "Lime", "Citrus"],
      best: "Warm-weather hosting",
      grad: "linear-gradient(160deg,#c8f09a,#7ec95e)", mood: "#a8d68f",
      badges: ["refreshing"], cats: ["refreshing"]
    },
    {
      id: "sd-08", name: "Fresh Melon", slug: "fresh-melon", disp: "coral", img: "/images/fresh-melon.jpeg",
      base: "Vodka", baseKey: "vodka", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Fresh watermelon with a cooling mint finish.",
      feel: "Light and refreshing — less sweet than Sweetmelon Vodka.",
      notes: ["Watermelon", "Mint"],
      best: "Daytime events",
      grad: "linear-gradient(160deg,#ff96a4,#e8566d)", mood: "#ff7a8f",
      badges: ["refreshing"], cats: ["refreshing", "fruity"]
    },
    {
      id: "sd-09", name: "Apple on Fire", slug: "apple-on-fire", disp: "amber", img: "/images/apple-on-fire.jpeg",
      base: "Fireball", baseKey: "fireball", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Sweet apple with warm cinnamon spice and salted caramel notes.",
      feel: "Rich, warming and slightly spiced.",
      notes: ["Apple", "Cinnamon", "Salted caramel"],
      best: "Cooler-night gatherings",
      grad: "linear-gradient(160deg,#f0b862,#b86a24)", mood: "#e0993d",
      badges: ["bold"], cats: ["bold"]
    },
    {
      id: "sd-10", name: "Wow Grape", slug: "wow-grape", disp: "purple", img: "/images/wow-grape.jpeg",
      base: "Vodka", baseKey: "vodka", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Bold grape and blackcurrant flavour.",
      feel: "Sweet, fruity and straightforward, with a strong grape profile.",
      notes: ["Grape", "Blackcurrant"],
      best: "House parties",
      grad: "linear-gradient(160deg,#a855f7,#6d28d9)", mood: "#9b5cf6",
      badges: ["sweet"], cats: ["sweet", "fruity"]
    },
    {
      id: "sd-11", name: "Piña Colada", slug: "pina-colada", disp: "cream", img: "/images/pina-colada.jpeg",
      base: "Vodka", baseKey: "vodka", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Tropical pineapple with a classic Piña Colada flavour profile.",
      feel: "Sweet, tropical and familiar.",
      notes: ["Pineapple"],
      best: "Poolside and rooftop celebrations",
      grad: "linear-gradient(160deg,#fdf4dc,#efd79c)", mood: "#f5e3b0",
      badges: ["tropical"], cats: ["creamy", "tropical"]
    },
    {
      id: "sd-12", name: "Slurp Juice", slug: "slurp-juice", disp: "blue", img: "/images/slurp-juice.jpeg",
      base: "Alizé", baseKey: "alize", available: true, price: P,
      allergens: [], allergensVerified: false,
      profile: "Sweet blackcurrant and lemonade character with an Alizé base.",
      feel: "Sweet and fruit-forward over an Alizé base.",
      notes: ["Blackcurrant", "Lemonade"],
      best: "Birthdays and celebrations",
      grad: "linear-gradient(160deg,#8bdcff,#2f8fd6)", mood: "#5cc4f5",
      badges: ["sweet", "bold"], cats: ["sweet", "bold"]
    }
  ];

  /* ALLERGENS
     allergens: declared allergens to show as "Contains: …" on the product page.
     allergensVerified: false means the allergen review for that flavour is NOT
     complete — the product page shows a "being confirmed" line instead of an
     all-clear, because absence of data is not the same as absence of allergens.
     Strawberry Cream is confirmed as containing Milk (Baileys). */

  /* Flavour descriptors only — no popularity or sales claims. */
  window.BADGE_LABEL = { sweet: "Sweet", tropical: "Tropical", creamy: "Creamy", refreshing: "Refreshing", bold: "Bold" };

  /* filters map to the customer-facing alcohol base */
  window.FLAVOUR_FILTERS = [
    { id: "all", label: "All" },
    { id: "vodka", label: "Vodka" },
    { id: "malibu", label: "Malibu" },
    { id: "baileys", label: "Baileys" },
    { id: "bacardi", label: "Bacardi" },
    { id: "fireball", label: "Fireball" },
    { id: "alize", label: "Alizé" }
  ];

  window.SD.flavourBySlug = function (slug) {
    return window.FLAVOURS.filter(function (f) { return f.slug === slug; })[0] || null;
  };
  window.SD.flavourByName = function (name) {
    return window.FLAVOURS.filter(function (f) { return f.name === name; })[0] || null;
  };
  window.SD.money = function (n) { return "$" + Number(n).toLocaleString("en-AU"); };

  /* ============================================================
     2b. DISPENSER RENDERS
     Real SpiritDrop dispenser photography with the SPIRIT DROP tube
     branding. White studio background keyed out and every render
     normalised to ONE canonical silhouette: same lid width, same
     crop, same vertical alignment, same 640x1060 image box. Only the
     liquid colour differs between flavours, so the switcher never
     shows visibly inconsistent versions of the product.

     Nine renders cover twelve flavours: flavours that pour the same
     colour share one. Colours follow the actual base ingredients, not
     the flavour's name -- Sweetmelon and Fresh Melon contain mint syrup
     but pour watermelon pink, so neither uses the green render.

     These are approximate. Final colour is settled by physical recipe
     testing, so nothing on the site claims an exact match.

     These are representative flavour visuals. Natural ingredients
     and batch variation mean the poured colour may differ slightly,
     so no page claims an exact colour match.
     ============================================================ */
  /* Alt text names the liquid colour AND the flavour actually selected.
     Renders are shared between flavours, so the colour word comes from the
     render and the flavour name comes from the flavour. */
  var DISP_COLOUR = {
    orange: "golden orange", berry: "berry red", coral: "watermelon pink",
    blush: "creamy blush pink", cream: "pale creamy yellow", mint: "pale lime green",
    amber: "golden amber", purple: "deep grape purple", blue: "electric blue"
  };
  window.SD.dispenserFor = function (f) {
    if (!f || !f.disp) return null;
    var colour = DISP_COLOUR[f.disp] || "";
    return {
      src: "/images/dispensers/" + f.disp + "-640.webp",
      srcset: "/images/dispensers/" + f.disp + "-320.webp 320w, images/dispensers/" + f.disp + "-640.webp 640w",
      alt: "SpiritDrop cocktail dispenser filled with " + (colour ? colour + " " : "") + f.name + " cocktail",
      w: 640, h: 1060
    };
  };

  /* ============================================================
     3. ADD-ONS — approved TYPES only.
     PRICES AND PACK SIZES ARE NOT YET APPROVED, so purchasing
     controls are disabled and nothing is added to any total.
     Set pending:false and add a numeric price once the owner
     confirms pricing and quantities.
     ============================================================ */
  window.SD.ADDONS = [
    { id: "cups", name: "Cocktail Cups", desc: "Pack size to be confirmed. Cup branding is not finalised.", price: null, pending: true },
    { id: "garnish", name: "Dried Garnishes", desc: "Dried orange, lemon, lime, grapefruit or blood orange. Pack structure to be confirmed.", price: null, pending: true },
    { id: "ice", name: "Ice Bags (optional)", desc: "Optional extra. Each dispenser already has a removable cooling tube fitted in the lid.", price: null, pending: true }
  ];

  /* ============================================================
     4. DELIVERY ZONES — configured bands radiating out from the
     Liverpool 2170 base. First matching 3-digit prefix wins.

     There is NO all-NSW fallback. A postcode that does not match
     a configured band is OUTSIDE the standard delivery area and
     is never given an invented price.
     ============================================================ */
  window.SD.BASE_POSTCODE = window.SD.RULES.basePostcode;
  window.SD.ZONES = [
    {
      id: "z1", name: "Zone 1 · Liverpool Local", tag: "Our home turf",
      blurb: "Liverpool, Casula, Moorebank, Prestons, Cabramatta, Fairfield, Bankstown & surrounds.",
      fee: 0,
      prefixes: ["216", "217", "218", "219", "220"],
      colourPending: "Representative colour only. Final appearance depends on the exact Alizé variant used and is still to be confirmed."
    },
    {
      id: "z2", name: "Zone 2 · South-West & Parramatta", tag: "Just out from base",
      blurb: "Parramatta, Auburn, Macarthur, Campbelltown, Camden, Penrith & St Marys.",
      fee: 19,
      prefixes: ["214", "215", "255", "256", "274", "275", "276", "277"]
    },
    {
      id: "z3", name: "Zone 3 · Sydney Metro", tag: "City, East, North & Inner West",
      blurb: "CBD, Eastern Suburbs, Inner West, Lower North Shore, Northern Beaches & St George.",
      fee: 29,
      prefixes: ["200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "213", "221", "222", "223"]
    },
    {
      id: "z4", name: "Zone 4 · Outer Metro & Fringe", tag: "Coast & Illawarra",
      blurb: "Central Coast, Hawkesbury, Blue Mountains, Wollongong & the Illawarra.",
      fee: 39,
      prefixes: ["225", "226", "227", "245", "248", "250", "251", "252", "253", "278"]
    }
  ];

  /* Returns { ok, zone, fee, msg } — ok:false means no delivery price
     is available for that postcode and checkout must not proceed. */
  window.SD.checkZone = function (raw) {
    var v = (raw || "").trim();
    if (!/^\d{4}$/.test(v)) return { ok: false, invalid: true, msg: "Enter a valid 4-digit postcode." };
    var p3 = v.slice(0, 3);
    var z = window.SD.ZONES.filter(function (zone) { return zone.prefixes.indexOf(p3) > -1; })[0];
    if (!z) return { ok: false, outside: true, msg: window.SD.COPY.outsideArea };
    var feeTxt = z.fee === 0 ? "no delivery fee" : window.SD.money(z.fee) + " delivery fee";
    return { ok: true, zone: z, fee: z.fee, msg: z.name + " — " + feeTxt + ", next-day collection included." };
  };

  /* ============================================================
     5. DATES & WINDOWS
     No same-day delivery. Earliest event date is the next day.
     Collection is ALWAYS the next day after the event date.
     Window times below are the selectable options only — the site
     makes no claim about licensed trading hours.
     ============================================================ */
  function iso(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  window.SD.minEventDate = function () {
    var d = new Date(); d.setDate(d.getDate() + 1); return iso(d);
  };
  window.SD.collectionDate = function (eventISO) {
    if (!eventISO) return "";
    var d = new Date(eventISO + "T00:00");
    if (isNaN(d)) return "";
    d.setDate(d.getDate() + 1);
    return iso(d);
  };
  window.SD.formatDate = function (isoStr) {
    if (!isoStr) return "—";
    var d = new Date(isoStr + "T00:00");
    if (isNaN(d)) return "—";
    return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  };

  function hourlyWindows(startHour, endHour) {
    var out = [];
    function label(x) { var ap = x >= 12 ? "PM" : "AM"; var hh = x % 12 === 0 ? 12 : x % 12; return hh + ":00 " + ap; }
    for (var h = startHour; h <= endHour; h++) {
      out.push({ id: "h" + h, label: label(h) + " – " + label(h + 1), short: label(h) });
    }
    return out;
  }
  window.SD.DELIVERY_SLOTS = hourlyWindows(10, 20);
  window.SD.COLLECTION_SLOTS = hourlyWindows(9, 19);
})();
