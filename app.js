"use strict";
/* This site's own worker: deployed with Wrangler from the local worker/ folder, which is not in the public repo. */
var WORKER_URL = "https://decode-clouds.zwubbena.workers.dev/classify";
/* Cloudflare Turnstile bot check. The site key is public. Empty = check off. */
var TURNSTILE_SITEKEY = "0x4AAAAAAF1xtuj8d40wVGTB";
var tsWidget = null, tsWaiter = null, tsLoading = null, tsQueue = Promise.resolve(), tsStop = null;
/* Why the last bot check gave no token: a Cloudflare error code, or "script" (Cloudflare's script
   did not load), "timeout", "interaction" (a box was shown and not ticked in time), "unsupported",
   "exception" or "cancelled". The error message shows it, so a screenshot says what happened. */
var tsFail = "";
/* Loads Cloudflare's script. Resolves true once window.turnstile exists. A load that failed (a phone
   with no signal when the page opened) is tried again the next time this is called. */
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(true);
  if (!tsLoading) {
    tsLoading = new Promise(function (res) {
      var sc = document.createElement("script");
      sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      sc.async = true;
      sc.onload = function () { if (!window.turnstile) tsLoading = null; res(!!window.turnstile); };
      sc.onerror = function () { tsLoading = null; if (sc.parentNode) sc.parentNode.removeChild(sc); res(false); };
      document.head.appendChild(sc);
    });
  }
  return tsLoading;
}
if (TURNSTILE_SITEKEY) loadTurnstile();
var TS_OPTIONS = {
  sitekey: TURNSTILE_SITEKEY, execution: "execute", appearance: "interaction-only",
  /* tsOnce below runs the retries itself, so they stop when the page gives up. A token is asked for
     only when one is needed, so an idle page does not keep refreshing tokens on its own. */
  retry: "never", "refresh-expired": "never",
  callback: function (t) { if (tsWaiter) tsWaiter.token(t); },
  "error-callback": function (code) { if (tsWaiter) tsWaiter.error(code); return true; },
  "timeout-callback": function () { if (tsWaiter) tsWaiter.stop("interaction"); },
  "unsupported-callback": function () { if (tsWaiter) tsWaiter.stop("unsupported"); },
  /* Cloudflare occasionally asks the visitor to tick a box. Bring it into view and say so,
     because by now the page has scrolled down to the results block. */
  "before-interactive-callback": function () {
    var ts = $("ts"); ts.classList.add("needs-you"); ts.scrollIntoView({ behavior: "smooth", block: "center" });
    if (tsWaiter) tsWaiter.box(true);
  },
  "after-interactive-callback": function () {
    $("ts").classList.remove("needs-you");
    if (tsWaiter) tsWaiter.box(false);
  }
};
/* Resolves with a fresh single-use token, or "" when the check is off or could not be completed
   (tsFail then says why). Requests run one at a time. onBox(showing), when given, is told when
   Cloudflare's tick box appears and goes away. */
function getTurnstileToken(onBox) {
  if (!TURNSTILE_SITEKEY) { tsFail = ""; return Promise.resolve(""); }
  var p = tsQueue.then(function () { return tsOnce(onBox); });
  tsQueue = p;
  return p;
}
/* One token request. Cloudflare's check can fail once on a weak phone signal and pass a moment
   later, so a failed check is run again: three tries in all, 1.5 s apart, 45 s at most. */
function tsOnce(onBox) {
  tsFail = "";
  return new Promise(function (resolve) {
    var done = false, errors = 0, timer = null;
    function finish(token, why) {
      if (done) return;
      done = true; clearTimeout(timer); tsWaiter = null; tsStop = null;
      if (!token) { tsFail = why; try { if (tsWidget !== null) window.turnstile.reset(tsWidget); } catch (e) {} }
      resolve(token || "");
    }
    function wait(ms) { clearTimeout(timer); timer = setTimeout(function () { finish("", tsFail || "timeout"); }, ms); }
    function run() {
      try {
        if (tsWidget === null) tsWidget = window.turnstile.render("#ts", TS_OPTIONS);
        else window.turnstile.reset(tsWidget);
        window.turnstile.execute(tsWidget);
      } catch (e) { finish("", "exception"); }
    }
    tsWaiter = {
      token: function (t) { finish(t, "empty"); },
      error: function (code) {
        tsFail = String(code || "error");
        if (++errors < 3) setTimeout(function () { if (!done) run(); }, 1500);
        else finish("", tsFail);
      },
      /* While the tick box is showing, wait as long as Cloudflare does (120 s) for the tick. */
      box: function (showing) { if (showing) wait(125000); if (onBox) onBox(showing); },
      stop: function (why) { finish("", why); }
    };
    tsStop = function () { finish("", "cancelled"); };
    wait(45000);
    loadTurnstile().then(function (ok) { if (done) return; if (ok) run(); else finish("", "script"); });
  });
}
var $ = function (id) { return document.getElementById(id); };
/* Contact link: the address is assembled here rather than written in the HTML, so simple spam scrapers miss it. */
(function () {
  var addr = ["hello", "decodeclouds.com"].join("@");
  var a = $("contact-link"); if (a) a.href = "mailto:" + addr + "?subject=" + encodeURIComponent("DecodeClouds");
  var d = $("disclaimer-mail"); if (d) { d.href = "mailto:" + addr + "?subject=" + encodeURIComponent("Remove photo"); d.textContent = addr; }
})();
document.querySelector("form.tool").addEventListener("submit", function (e) { e.preventDefault(); });
var pick = $("pick"), drop = $("drop"), go = $("go"), result = $("result"), block = $("result-block"), pv = $("preview"), pvi = $("preview-img");
var b64 = null, mime = null, fname = "", currentFile = null, origSha256 = null, lastTypes = null, lastConf = {}, lastFeature = null, lastReasoning = null, resultAt = null, photoAt = null;
/* Where photoAt came from ("exif" = camera date, "file" = file date) and the size of the copy that is analyzed. */
var photoSrc = null, sentW = null, sentH = null;
/* Archive: every identified photo is kept (said on the page). lastId is its archive id; exifInfo is what the camera recorded. */
var ARCHIVE_URL = WORKER_URL.replace(/\/classify$/, "");
var lastId = null, exifInfo = {}, locSent = null; /* locSent: "exif" | "device" | "failed" | null, for the archive line */
var lastFlagged = false, flaggedTypes = {}, flagBusy = {}; /* the misidentification flags, one per result card */
/* Set when the photo came from the "try an example" menu: sent as-is (no shrink) so the worker can recognize it and not archive it. */
var exampleKey = null;

var INFO = {
  "Cirrus":           { tier: "High level · above 20,000 ft", form: "cirrus = curl of hair; thin wisps and streaks", alt: "high tier, above 20,000 ft", text: "Thin white brushstrokes, often curled at one end. Fair weather today; sometimes the first hint of a change in a day or two." },
  "Cirrocumulus":     { tier: "High level · above 20,000 ft", form: "cumulus = heap, here fine grains and ripples", alt: "cirro- = high tier, above 20,000 ft", text: "High-altitude clouds in small, white, rippled patches resembling fish scales. Often precede fair weather but can signal change." },
  "Cirrostratus":     { tier: "High level · above 20,000 ft", form: "stratus = layer, here a thin veil", alt: "cirro- = high tier, above 20,000 ft", text: "A thin sheet that turns the whole sky pale and puts a halo around the sun or moon. Rain often follows within a day." },
  "Altocumulus":      { tier: "Mid level · 6,500 to 20,000 ft", form: "cumulus = heap, in patches and rows", alt: "alto- = mid tier, 6,500 to 20,000 ft", text: "White or gray cotton patches, often lined up in waves. On a warm, humid morning they can hint at afternoon storms." },
  "Altostratus":      { tier: "Mid level · 6,500 to 20,000 ft", form: "stratus = layer, a gray sheet", alt: "alto- = mid tier, 6,500 to 20,000 ft", text: "A gray sheet across the sky; the sun shows as a dim disk with no shadows. Steady rain may be a few hours out." },
  "Nimbostratus":     { tier: "Spans multiple levels", form: "nimbus = rain + stratus = layer", alt: "base is low; the layer reaches into the mid tier", text: "Dark, featureless, and low enough to feel close. If it isn’t raining or snowing yet, it’s about to, and for a while." },
  "Stratus":          { tier: "Low level · below 6,500 ft", form: "stratus = layer", alt: "low tier, below 6,500 ft", text: "A flat, uniform gray layer, like fog that lifted a few hundred feet. Drizzle at most." },
  "Stratocumulus":    { tier: "Low level · below 6,500 ft", form: "stratus = layer + cumulus = heap; lumpy rolls", alt: "low tier, below 6,500 ft", text: "Low, rounded gray masses with some blue between. Looks threatening, rarely delivers more than a sprinkle." },
  "Cumulus":          { tier: "Low level · below 6,500 ft", form: "cumulus = heap", alt: "low tier, below 6,500 ft", text: "Puffy, flat-bottomed, bright white on top. The fair-weather cloud of postcards." },
  "Towering Cumulus": { tier: "Spans multiple levels", form: "cumulus = heap, building upward (congestus)", alt: "base low; top reaches the mid tier or higher", text: "A cumulus that has started building upward, taller than it is wide. Showers possible. If it keeps growing it becomes a cumulonimbus." },
  "Cumulonimbus":     { tier: "Spans multiple levels", form: "cumulus = heap + nimbus = rain", alt: "base low; top can reach 40,000 ft or more", text: "A tower that flattens into an anvil at the top. Lightning, heavy rain, gusts, sometimes hail. Head indoors." }
};
var FEATURE = { fallstreak_hole: "Fallstreak hole (hole punch cloud)" };

function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function p2(n) { return (n < 10 ? "0" : "") + n; }
/* ---- Error messages. Each one ends with a code, and the first digit of the code names the side:
   1 = your conditions (your photo, your device or browser, your connection); 2 = the web application
   (DecodeClouds or a service DecodeClouds runs on). docs/messages.csv lists every message, the User
   Guide prints that list, and worker/test/messages-check.cjs fails when a message here is not in it. */
var ERR = {
  format:   ["11", "That photo format isn’t supported. Please use a JPEG or PNG."],
  large:    ["12", "Image is too large. Please use a photo under 7 MB."],
  box:      ["13", "The box wasn’t ticked in time. Try again."],
  rate:     ["14", "Too many requests. Please wait a moment and try again."],
  offline:  ["15", "Couldn’t connect. Check your signal and try again."],
  slowYou:  ["16", "Sorry it took too long. Check your signal and try again."],
  person:   ["17", "Couldn’t confirm you’re a person. Reload the page and try again."],
  lateFlag: ["18", "Too late to flag this one."],
  server:   ["21", "Your connection works, but the DecodeClouds server can’t be reached. Try again in a few minutes."],
  slowUs:   ["22", "Sorry it took too long. Do me a favor. Try again."],
  analyze:  ["23", "DecodeClouds could not analyze the photo. The problem is on our side. Try again."],
  botDown:  ["24", "The bot check is unavailable right now. Please try again in a moment."],
  setup:    ["25", "DecodeClouds could not run the bot check. The problem is on our side. Try again later."],
  refused:  ["26", "Couldn’t confirm you’re a person. Reload the page and try again."],
  flagSave: ["27", "Couldn’t save. Try again."],
  odd:      ["29", "Couldn’t read that one. Try another photo."]
};
/* The Worker names each refusal with an id. The page shows its own words and code for that id. */
var WORKER_ERR = { unsupported_type: "format", image_too_large: "large", rate_limited: "rate", timeout: "slowUs", server_error: "analyze", bot_check_unavailable: "botDown", bot_check_failed: "refused" };
/* Cloudflare's codes for a site key or hostname that is set up wrongly: the web application's side. */
var TS_SETUP = ["110100", "110110", "110200", "400020", "400021", "400070"];
/* "Words. (Code 23)", or "Words. (Code 17-600010)" when Cloudflare's own code or word follows. */
function errLine(key, detail, words) { var e = ERR[key]; return (words || e[1]) + " (Code " + e[0] + (detail ? "-" + detail : "") + ")"; }
function errHtml(key, detail, words) { return '<p class="err">' + esc(errLine(key, detail, words)) + "</p>"; }
/* Asked after a photo could not be sent or no answer came back: does decodeclouds.com itself still
   answer? Yes means the visitor's connection works, so the trouble is on the web application's side.
   Resolves true or false within 5 s; never rejects. */
function connectionWorks() {
  return new Promise(function (resolve) {
    var done = false;
    function fin(v) { if (!done) { done = true; resolve(v); } }
    setTimeout(function () { fin(false); }, 5000);
    try {
      fetch("/robots.txt?t=" + Date.now(), { method: "HEAD", cache: "no-store" }).then(function (r) { fin(!!r.ok); }, function () { fin(false); });
    } catch (e) { fin(false); }
  });
}
var CONF_LABEL = { high: "high confidence", medium: "medium confidence", low: "low confidence" };
function confHtml(c) {
  if (!Object.prototype.hasOwnProperty.call(CONF_LABEL, c)) return "";
  return '<span class="conf ' + c + '"><span class="dots"><i></i><i></i><i></i></span>' + CONF_LABEL[c] + "</span>";
}
/* A red misidentification flag beside the confidence pill on every result card. Hover: "Report
   misidentification"; one click flags the photo (is_flagged, and the flagged type in flagged_types)
   and the icon fills. Only for archived photos. */
var FLAG_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="flag-fill" d="M4 21V4h11l1 2h4v10h-7l-1-2H5"/><path d="M4 21V4"/></svg>';
function confWithFlag(c, type) {
  var conf = confHtml(c);
  if (!lastId) return conf;
  var on = !!flaggedTypes[type];
  return '<span class="conf-wrap">' + conf + '<button class="flag-btn' + (on ? " flagged" : "") + '" type="button" data-type="' + esc(type) + '" aria-pressed="' + (on ? "true" : "false") +
    '" aria-label="Flag issue" data-tip="' + (on ? TIP_ON : TIP_OFF) + '">' + FLAG_SVG + "</button></span>";
}
function featureName(fe) { return FEATURE[fe.type] || String(fe.type).replace(/_/g, " "); }
function highlight(types, isResult) {
  document.querySelectorAll(".chips li[data-t]").forEach(function (el) { el.classList.toggle("hit", types.indexOf(el.getAttribute("data-t")) !== -1); });
  document.querySelectorAll(".chips li[data-f]").forEach(function (el) { el.classList.toggle("hit", !!(types.length && lastFeature && lastFeature.type === el.getAttribute("data-f"))); });
  document.querySelectorAll(".chips li[data-c]").forEach(function (el) { el.classList.toggle("hit", !!isResult && !types.length); });
}

function cardsHtml() {
  var h = "";
  if (!lastTypes.length) h += '<article class="card"><div class="row"><p class="eyebrow">No clouds</p>' + confWithFlag(lastConf.CLR, "Clear sky") + '</div><h3>Clear sky</h3><p>No cloud types identified in this photo.</p></article>';
  lastTypes.forEach(function (t) {
    var i = INFO[t] || { tier: "Cloud", text: "", form: "", alt: "" };
    h += '<article class="card"><div class="row"><p class="eyebrow">' + esc(i.tier) + "</p>" + confWithFlag(lastConf[t], t) + "</div><h3>" + esc(t) + "</h3>" +
      (i.text ? "<p>" + esc(i.text) + "</p>" : "") +
      (i.form ? '<div class="details"><p class="eyebrow">Details for your brain</p><dl><dt>Form</dt><dd>' + esc(i.form) + "</dd><dt>Altitude</dt><dd>" + esc(i.alt) + "</dd></dl></div>" : "") + "</article>";
  });
  if (lastFeature && lastFeature.type) {
    var n = featureName(lastFeature), m = n.match(/^(.*?)\s*\((.*)\)$/);
    h += '<article class="card feature"><div class="row"><p class="eyebrow">Special feature</p>' + confWithFlag(lastFeature.confidence, m ? m[1] : n) + "</div><h3>" +
      (m ? esc(m[1]) + "<small>(" + esc(m[2]) + ")</small>" : esc(n)) + "</h3>" + (lastFeature.note ? "<p>" + esc(lastFeature.note) + "</p>" : "") + "</article>";
  }
  return '<div class="cards">' + h + "</div>";
}
function reasoningRows() {
  var r = lastReasoning; if (!r) return [];
  return [["How high it looked", r.perceivedAltitude], ["Texture", Array.isArray(r.texture) ? r.texture.join(", ") : r.texture], ["Light and shading", r.opacityShading], ["Notes", r.notes]].filter(function (x) { return x[1]; });
}
function reasoningHtml() {
  var rows = reasoningRows(); if (!rows.length) return "";
  return '<details class="how"><summary>How this was identified</summary><ul>' + rows.map(function (x) { return "<li><b>" + x[0] + ":</b> " + esc(x[1]) + "</li>"; }).join("") + "</ul></details>";
}
function render() {
  result.innerHTML = cardsHtml() + reasoningHtml() +
    '<div class="actions"><button class="pill white" id="pdf-btn" type="button">Download</button><button class="pill white" id="email-btn" type="button">Email</button><button class="pill white" id="text-btn" type="button">Text</button>' +
    '</div>' +
    '<p class="share-hint">On a phone, Email and Text open the share sheet with the photo attached. Download opens the print dialog, where you can save a PDF.</p>' +
    archiveHtml();
  $("pdf-btn").addEventListener("click", downloadPdf);
  $("email-btn").addEventListener("click", function () { shareReport("email"); });
  $("text-btn").addEventListener("click", function () { shareReport("text"); });
  document.querySelectorAll(".flag-btn").forEach(function (b) { b.addEventListener("click", flagResult); b.addEventListener("mouseleave", function () { b.classList.remove("quiet"); }); b.addEventListener("blur", function () { b.classList.remove("quiet"); }); });
  highlight(lastTypes, true);
}

/* ---- Archive line under a result: the archive number (for removal requests by email). ---- */
function archiveHtml() {
  if (exampleKey) {
    /* Example photos are never archived; show the block greyed out so visitors see what happens with their own. */
    return '<section class="archive archive-off" id="archive" aria-disabled="true">' +
      '<p class="archive-id"><b>Example photo.</b> Examples aren’t added to the archive. Your own photos are, and this is where their archive number appears.</p></section>';
  }
  if (!lastId) return "";
  return '<section class="archive" id="archive">' +
    '<p class="archive-id"><b>Thanks for contributing!</b> This photo is now in the DecodeClouds archive' +
    (locSent === "exif" ? ", with the location your camera recorded, rounded to about 1&nbsp;km" :
     locSent === "device" ? ", with your location, rounded to about 1&nbsp;km" :
     locSent === "failed" ? " (your location wasn’t available, so it went in without one)" : "") +
    ' (#' + esc(lastId.slice(0, 8)) + ").</p></section>";
}
function postFlag(payload) {
  return getTurnstileToken()
    .then(function (token) {
      /* No token means the Worker would refuse the flag, so it is not sent. */
      if (!token && TURNSTILE_SITEKEY) throw { name: "NoToken" };
      payload.turnstile = token;
      return fetch(ARCHIVE_URL + "/flag", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
        .catch(function () { throw { name: "NetFail" }; });
    })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }, function () { return { ok: r.ok, data: {} }; }); });
}
/* A flag icon: one click reports that result as a misidentification; clicking the filled flag
   takes it back. The icon changes at once; the archive records which results are flagged. */
var TIP_OFF = "Flag issue", TIP_ON = "Flagged";
function setFlag(btn, on) { btn.classList.toggle("flagged", on); btn.setAttribute("aria-pressed", on ? "true" : "false"); }
function flagResult(e) {
  var btn = e.currentTarget, type = btn.getAttribute("data-type"), id = lastId, gen = photoGen;
  if (!id || !type || flagBusy[type]) return;
  var undo = !!flaggedTypes[type];
  flagBusy[type] = true;
  setFlag(btn, !undo); showTip(btn, undo ? "Unflagged" : "Flagged");
  postFlag(undo ? { id: id, disputed: type, undo: true } : { id: id, disputed: type })
    .then(function (res) {
      if (gen !== photoGen) return;
      flagBusy[type] = false;
      if (!res.ok || !res.data || !res.data.ok) {
        /* Not saved. The bubble is small, so it keeps short words; the code says why (same codes as above). */
        var why = res.data && res.data.error, code = why === "rate_limited" ? "14" : why === "bot_check_failed" ? "26" : why === "bot_check_unavailable" ? "24" : "27";
        setFlag(btn, undo);
        showTip(btn, why === "expired" ? errLine("lateFlag") : ERR.flagSave[1] + " (Code " + code + ")", true);
        return;
      }
      flaggedTypes[type] = !undo;
    })
    .catch(function (err) {
      if (gen !== photoGen) return;
      flagBusy[type] = false; setFlag(btn, undo);
      if (err && err.name === "NoToken") { showTip(btn, ERR.flagSave[1] + " (Code 17)", true); return; }
      connectionWorks().then(function (works) { if (gen === photoGen) showTip(btn, "Couldn’t connect. Try again. (Code " + (works ? "21" : "15") + ")", true); });
    });
}
/* A short confirmation, then nothing: the hover label stays hidden until the pointer leaves the flag. */
function showTip(btn, text, isError) {
  btn.setAttribute("data-tip", text); btn.classList.add("show-tip", "quiet"); btn.classList.toggle("tip-err", !!isError);
  clearTimeout(btn._tipTimer);
  btn._tipTimer = setTimeout(function () {
    btn.classList.remove("show-tip", "tip-err");
    btn.setAttribute("data-tip", btn.classList.contains("flagged") ? TIP_ON : TIP_OFF);
  }, isError ? 4000 : 1200); /* an error stays long enough to read its code */
}

/* ---- "Add my location" (upload card): asked for when Identify clouds is clicked, sent with the photo. ---- */
var locCheck = $("loc-check"), locOpt = $("loc-opt"), locText = $("loc-text");
/* locWanted is the visitor's own tick; a camera location forces the box on without changing it. */
var locWanted = false;
locCheck.addEventListener("change", function () { if (!locCheck.disabled) locWanted = locCheck.checked; });
function setLocOption() {
  var hasExif = !exampleKey && exifInfo && typeof exifInfo.lat === "number";
  locOpt.hidden = !!exampleKey;
  locCheck.disabled = hasExif;
  locText.textContent = hasExif ? "Location found in the photo" : "Add my location";
  locCheck.checked = hasExif || locWanted;
}
/* After an error the same photo may be tried again. */
function unlockIdentify() { go.disabled = false; go.textContent = "Identify clouds"; setLocOption(); }
/* Resolves to the browser position or null; never rejects. The fix itself gets 8 s; the 25 s limit
   also covers the time a visitor takes to answer the browser's permission question. The caller
   decides whether a position is wanted. */
function devicePosition() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var done = false;
    function finish(p) { if (!done) { done = true; resolve(p); } }
    try {
      navigator.geolocation.getCurrentPosition(function (pos) { finish(pos.coords); }, function () { finish(null); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 120000 });
    } catch (e) { finish(null); }
    setTimeout(function () { finish(null); }, 25000);
  });
}

/* photo in */
function shrink(dataUrl, maxEdge, cb) {
  var done = false; function fin(u, t, w, h) { if (!done) { done = true; cb(u, t, w || null, h || null); } }
  setTimeout(function () { fin(dataUrl, mime); }, 20000);
  var img = new Image();
  img.onload = function () {
    try {
      var w = img.naturalWidth, h = img.naturalHeight, L = Math.max(w, h);
      if (!w) return fin(dataUrl, mime, w, h);
      /* Always redrawn, even when no resize is needed: the copy that leaves the device carries no EXIF. */
      var s = Math.min(1, maxEdge / L), c = document.createElement("canvas");
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      var g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      fin(c.toDataURL("image/jpeg", 0.85), "image/jpeg", c.width, c.height);
    } catch (e) { fin(dataUrl, mime); }
  };
  img.onerror = function () { fin(dataUrl, mime); };
  img.src = dataUrl;
}
/* EXIF in plain JS: camera date, its time-zone offset, GPS, camera make and model. Read from the
   original file, because the shrink below re-encodes the image and drops all of this. Note that
   iPhone Safari removes the GPS block from photos a web page picks, so lat/lon is rarely present. */
function readExif(dataUrl) {
  var out = {};
  try {
    if (dataUrl.indexOf("data:image/jpeg") !== 0) return out;
    var bin = atob((dataUrl.split(",")[1] || "").slice(0, 262144)), n = bin.length, buf = new Uint8Array(n);
    for (var i = 0; i < n; i++) buf[i] = bin.charCodeAt(i);
    var dv = new DataView(buf.buffer);
    if (n < 4 || dv.getUint16(0) !== 0xFFD8) return out;
    var p = 2, tiff = -1;
    while (p + 4 <= n) {
      var marker = dv.getUint16(p); if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      var len = dv.getUint16(p + 2);
      if (marker === 0xFFE1 && p + 10 <= n && dv.getUint32(p + 4) === 0x45786966) { tiff = p + 10; break; }
      p += 2 + len;
    }
    if (tiff < 0 || tiff + 8 > n) return out;
    var le = dv.getUint16(tiff) === 0x4949;
    if (dv.getUint16(tiff + 2, le) !== 0x2A) return out;
    var u16 = function (o) { return dv.getUint16(o, le); }, u32 = function (o) { return dv.getUint32(o, le); };
    var ascii = function (o, c) { var s = ""; for (var k = 0; k < c && o + k < n; k++) { var ch = buf[o + k]; if (!ch) break; s += String.fromCharCode(ch); } return s; };
    var SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
    var readIfd = function (off, want) {
      if (off < 8 || off + 2 > n) return;
      var cnt = Math.min(u16(off), 200);
      for (var k = 0; k < cnt; k++) {
        var e = off + 2 + k * 12; if (e + 12 > n) break;
        var tag = u16(e), type = u16(e + 2), count = u32(e + 4), total = (SIZE[type] || 1) * count;
        var vo = total <= 4 ? e + 8 : tiff + u32(e + 8);
        var h = want[tag]; if (!h || vo + total > n || count > 4096) continue;
        if (type === 2) h(ascii(vo, count));
        else if (type === 3) h(u16(vo));
        else if (type === 4) h(u32(vo));
        else if (type === 1) h(buf[vo]);
        else if (type === 5) { var arr = []; for (var r = 0; r < count; r++) { var num = u32(vo + r * 8), den = u32(vo + r * 8 + 4); arr.push(den ? num / den : 0); } h(arr); }
      }
    };
    var exifOff = 0, gpsOff = 0;
    readIfd(tiff + u32(tiff + 4), {
      0x010F: function (v) { out.make = v.trim(); }, 0x0110: function (v) { out.model = v.trim(); }, 0x0112: function (v) { out.orientation = v; },
      0x8769: function (v) { exifOff = v; }, 0x8825: function (v) { gpsOff = v; }
    });
    if (exifOff) readIfd(tiff + exifOff, { 0x9003: function (v) { out.dateTime = v; }, 0x9011: function (v) { out.offset = v.trim(); } });
    if (gpsOff) {
      var latRef = "N", lonRef = "E", lat = null, lon = null, altRef = 0, alt = null;
      readIfd(tiff + gpsOff, { 1: function (v) { latRef = v; }, 2: function (v) { lat = v; }, 3: function (v) { lonRef = v; }, 4: function (v) { lon = v; }, 5: function (v) { altRef = v; }, 6: function (v) { alt = v; } });
      var dms = function (a) { return a && a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : NaN; };
      var la = dms(lat), lo = dms(lon);
      if (isFinite(la) && isFinite(lo) && (la !== 0 || lo !== 0) && la <= 90 && lo <= 180) { out.lat = (latRef.charAt(0) === "S" ? -1 : 1) * la; out.lon = (lonRef.charAt(0) === "W" ? -1 : 1) * lo; }
      if (alt && alt.length && isFinite(alt[0])) out.altitude = (altRef === 1 ? -1 : 1) * alt[0];
    }
  } catch (e) {}
  return out;
}
/* The camera's "YYYY:MM:DD HH:MM:SS" plus, when present, its "+HH:MM" offset, as a Date. */
function exifInstant(ex) {
  if (!ex || !ex.dateTime) return null;
  var m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(ex.dateTime); if (!m || m[1] === "0000") return null;
  var iso = m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + m[6];
  var d = new Date(/^[+-]\d{2}:\d{2}$/.test(ex.offset || "") ? iso + ex.offset : iso);
  return (isNaN(d.getTime()) || d.getFullYear() < 2000 || d > new Date(Date.now() + 86400000)) ? null : d;
}
function exifDate(dataUrl) {
  try {
    if (dataUrl.indexOf("data:image/jpeg") !== 0) return null;
    var bin = atob((dataUrl.split(",")[1] || "").slice(0, 174764));
    var m = bin.match(/(19|20)\d{2}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/g); if (!m) return null;
    m.sort(); var t = m[0];
    var d = new Date(t.slice(0, 4) + "-" + t.slice(5, 7) + "-" + t.slice(8, 10) + "T" + t.slice(11));
    return (isNaN(d.getTime()) || d.getFullYear() < 2000 || d > new Date()) ? null : d;
  } catch (e) { return null; }
}
/* Each new photo (or Reset) bumps this, so a slow shrink or a reply for an earlier photo is ignored. */
var photoGen = 0, inFlight = null;
function loadFile(f, example) {
  if (!f || !/^image\//.test(f.type || "image/jpeg")) return;
  var gen = ++photoGen; if (inFlight) { inFlight.abort(); inFlight = null; } if (tsStop) tsStop();
  exampleKey = example || null;
  go.textContent = "Identify clouds"; go.disabled = true;
  fname = f.name; mime = f.type || "image/jpeg"; currentFile = f; origSha256 = null;
  /* Fingerprint of the original bytes (the worker uses it to recognise the site's own example photos). */
  if (window.crypto && crypto.subtle && f.arrayBuffer) {
    f.arrayBuffer().then(function (buf) { return crypto.subtle.digest("SHA-256", buf); })
      .then(function (d) { if (gen !== photoGen) return; origSha256 = Array.prototype.map.call(new Uint8Array(d), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); })
      .catch(function () {});
  }
  $("fname").textContent = (f.name === "image.jpg" ? "Photo ready" : f.name) + " · " + Math.round(f.size / 1024) + " KB";
  block.hidden = true; result.innerHTML = ""; lastTypes = null; highlight([]);
  lastId = null; exifInfo = {}; locSent = null; lastFlagged = false; flaggedTypes = {}; flagBusy = {};
  var r = new FileReader();
  r.onload = function () {
    if (gen !== photoGen) return;
    pvi.src = r.result; pv.hidden = false; drop.hidden = true; $("reset-btn").disabled = false;
    if (example) {
      /* Example photos go as-is; their date is not meaningful. */
      exifInfo = {}; photoAt = null; photoSrc = null; mime = f.type; b64 = r.result.split(",")[1]; setLocOption();
      var im = new Image(); im.onload = function () { if (gen !== photoGen) return; sentW = im.naturalWidth; sentH = im.naturalHeight; go.disabled = false; }; im.onerror = function () { if (gen !== photoGen) return; go.disabled = false; }; im.src = r.result;
      return;
    }
    exifInfo = readExif(r.result); setLocOption();
    var ex = exifInstant(exifInfo) || exifDate(r.result);
    photoAt = ex || (f.lastModified ? new Date(f.lastModified) : null); photoSrc = ex ? "exif" : (photoAt ? "file" : null);
    shrink(r.result, 1200, function (u, t, w, h) { if (gen !== photoGen) return; mime = t; b64 = u.split(",")[1]; sentW = w; sentH = h; go.disabled = !b64; });
  };
  r.readAsDataURL(f);
}
pick.addEventListener("change", function (e) { $("example").value = ""; loadFile(e.target.files && e.target.files[0]); });
/* "Or try an example": fetch one of the site's own photos and treat it as the chosen file. */
$("example").addEventListener("change", function () {
  var key = this.value, p = PHOTOS[key]; if (!p) return;
  var sel = this; sel.disabled = true;
  fetch(p.src).then(function (r) { if (!r.ok) throw new Error("fetch"); return r.blob(); })
    .then(function (blob) {
      var name = "example-" + key.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".jpg";
      loadFile(new File([blob], name, { type: blob.type || "image/jpeg" }), key);
      $("fname").textContent = "Example: " + (INFO[key] ? key : (PHOTO_EXTRA[key] ? PHOTO_EXTRA[key].name : key));
    })
    .catch(function () { sel.value = ""; })
    .then(function () { sel.disabled = false; });
});
["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
drop.addEventListener("drop", function (e) { loadFile(e.dataTransfer.files && e.dataTransfer.files[0]); });
function resetAll() {
  photoGen++; if (inFlight) { inFlight.abort(); inFlight = null; } if (tsStop) tsStop();
  currentFile = null; photoAt = null; photoSrc = null; sentW = null; sentH = null; go.textContent = "Identify clouds";
  lastId = null; exifInfo = {}; locSent = null; lastFlagged = false; flaggedTypes = {}; flagBusy = {}; exampleKey = null; $("example").value = "";
  pick.value = ""; b64 = null; origSha256 = null; locWanted = false; pv.hidden = true; pvi.src = ""; drop.hidden = false; go.disabled = true; $("reset-btn").disabled = true;
  block.hidden = true; result.innerHTML = ""; lastTypes = null; $("fname").textContent = ""; highlight([]);
  setLocOption();
}
$("reset-btn").addEventListener("click", resetAll);

/* Save the original photo, before or after decoding, so a shot taken in the page isn't lost. */
function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
function savePhoto() {
  if (!currentFile) return;
  var type = currentFile.type || "image/jpeg";
  var ext = type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : type === "image/heic" ? ".heic" : ".jpg";
  var name = currentFile.name && !/^image\.(jpe?g|png|heic)$/i.test(currentFile.name) ? currentFile.name
    : "decodeclouds-sky_" + stampParts(photoAt || new Date()).iso + ext;
  var file = new File([currentFile], name, { type: type });
  try {
    if (isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch(function () {});
      return;
    }
  } catch (e) {}
  var url = URL.createObjectURL(file), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
}
$("save-btn").addEventListener("click", savePhoto);

/* ---- Progress while a photo is identified: four dots in a square beside the status line, one dot
   per step. Step 1 is the visitor's location, step 2 the bot check, step 3 sending the photo, step 4
   reading the sky. A filled dot is a finished step, the pulsing dot is the step that is running, an
   outlined dot is a step still to come. The line names the running step; `words` stands in for that
   name during a moment that belongs to the step (the tick box, a dropped connection). The dots say
   which step is running, not how far along it is: the identification service reports no progress.
   The box and its dots are built once and then updated in place, so the pulse does not restart and
   a screen reader hears each new line (role="status"). ---- */
var STEP_WORDS = ["Finding your location…", "Checking you’re a person…", "Sending the photo…", "Reading the sky… usually 5 to 15 seconds."];
function showStep(n, words) {
  var box = result.querySelector(".progress");
  if (!box) {
    result.innerHTML = '<div class="progress" role="status"><span class="steps" aria-hidden="true"><i></i><i></i><i></i><i></i></span><p class="loading"></p></div>';
    box = result.querySelector(".progress");
  }
  var dots = box.querySelectorAll(".steps i");
  for (var k = 0; k < dots.length; k++) dots[k].className = k < n - 1 ? "done" : k === n - 1 ? "now" : "";
  box.querySelector(".loading").textContent = words || STEP_WORDS[n - 1];
}
/* Identify clouds. The location comes first when it is wanted, so a phone's permission question is
   answered before anything else starts; then the bot check; then the photo is sent. */
go.addEventListener("click", function () {
  if (!b64) return;
  var gen = photoGen;
  /* Read the location option before the lock below disables the box. */
  var wantLoc = !exampleKey && locCheck.checked && !(exifInfo && typeof exifInfo.lat === "number");
  /* The button and the location option belong to this analysis: both lock now and stay locked
     after a result (no re-runs of the same photo); a new photo, Reset or an error unlocks them. */
  go.disabled = true; go.textContent = "Identifying…"; locCheck.disabled = true; block.hidden = false;
  block.scrollIntoView({ behavior: "smooth", block: "start" });
  locSent = null;
  /* With no location to ask for, step 1 is finished at once: identify() opens at step 2. */
  if (!wantLoc) { identify(gen, false, null, 1); return; }
  showStep(1);
  devicePosition().then(function (pos) { if (gen !== photoGen) return; identify(gen, true, pos, 1); });
});
/* Sends the photo to the Worker and resolves to { ok, data }. XMLHttpRequest rather than fetch,
   because only XMLHttpRequest says when the upload itself is finished: onSent runs once the browser
   has handed the last byte of the photo to the network, which is where step 3 ends and step 4
   begins. Rejects with { name: "AbortError" } when the request is stopped (Reset, a new photo, or the
   40 s limit) and with { name: "NetFail" } when the connection fails. */
function sendPhoto(payload, signal, onSent) {
  var body = JSON.stringify(payload);
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest(), sent = false, over = false;
    /* Nothing is reported once the request has ended: a late upload event must not touch a result. */
    function markSent() { if (!sent && !over) { sent = true; onSent(); } }
    xhr.upload.onload = markSent;
    xhr.onload = function () {
      over = true;
      var data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, data: data });
    };
    xhr.onerror = function () { over = true; reject({ name: "NetFail" }); };
    xhr.onabort = function () { over = true; reject({ name: "AbortError" }); };
    if (signal) signal.addEventListener("abort", function () { if (!over) xhr.abort(); });
    try {
      xhr.open("POST", WORKER_URL);
      xhr.setRequestHeader("content-type", "application/json");
      xhr.send(body);
    } catch (e) { over = true; reject({ name: "NetFail" }); }
  });
}
/* The bot check, then the photo. If the connection drops as the photo is sent (a phone between
   networks), the page tries once more by itself: tryNo 2, with a fresh token. */
function identify(gen, wantLoc, pos, tryNo) {
  /* The worker gives up on the AI after 30 s and says so; this is a backstop if the network itself stalls. */
  var ctrl = typeof AbortController === "function" ? new AbortController() : null, clientTimer = null, sentAt = 0;
  inFlight = ctrl;
  showStep(2);
  getTurnstileToken(function (boxShowing) {
    if (gen !== photoGen || block.hidden) return;
    showStep(2, boxShowing ? "Please tick the box above to continue." : "");
    if (!boxShowing) block.scrollIntoView({ behavior: "smooth", block: "start" });
  })
    .then(function (token) {
      if (gen !== photoGen) throw { name: "AbortError", stale: true };
      /* No token means the worker would refuse the photo, so it is not sent. */
      if (!token && TURNSTILE_SITEKEY) throw { name: "NoToken", why: tsFail };
      if (ctrl) clientTimer = setTimeout(function () { ctrl.abort(); }, 40000);
      /* The photo's own facts go with it: date, size, camera, and a location if the camera wrote one or the
         visitor ticked "Add my location" (rounded server-side to about 1 km). See the Disclaimer. */
      var payload = { image: b64, mediaType: mime, turnstile: token, w: sentW, h: sentH, tzOffsetMin: -new Date().getTimezoneOffset() };
      if (photoAt) { payload.taken = photoAt.toISOString(); payload.takenSource = photoSrc; }
      if (exampleKey) payload.example = exampleKey;
      if (origSha256) payload.origSha256 = origSha256;
      if (exifInfo) {
        if (typeof exifInfo.lat === "number") { payload.lat = exifInfo.lat; payload.lon = exifInfo.lon; payload.locSource = "exif"; if (typeof exifInfo.altitude === "number") payload.altitudeM = exifInfo.altitude; locSent = "exif"; }
        if (exifInfo.make) payload.cameraMake = exifInfo.make; if (exifInfo.model) payload.cameraModel = exifInfo.model;
      }
      if (!payload.lat && wantLoc) {
        if (pos && typeof pos.latitude === "number") {
          payload.lat = pos.latitude; payload.lon = pos.longitude; payload.locSource = "device";
          if (typeof pos.accuracy === "number") payload.locAccuracyM = pos.accuracy;
          if (typeof pos.altitude === "number" && isFinite(pos.altitude)) payload.altitudeM = pos.altitude;
          locSent = "device";
        } else {
          locSent = "failed";
        }
      }
      sentAt = Date.now();
      showStep(3);
      return sendPhoto(payload, ctrl ? ctrl.signal : null, function () { if (gen === photoGen) showStep(4); });
    })
    .then(function (res) {
      clearTimeout(clientTimer);
      if (gen !== photoGen) return;
      inFlight = null;
      if (!res || !res.ok) {
        /* The Worker refused. Its id picks the page's words and code; for an id the page does not know,
           the Worker's own words are shown under the code for the unexpected. */
        var refusal = (res && res.data) || {}, key = WORKER_ERR[refusal.error];
        unlockIdentify();
        result.innerHTML = key ? errHtml(key) : errHtml("odd", "", typeof refusal.message === "string" ? refusal.message : "");
        return;
      }
      var d = res.data || {};
      go.disabled = true; go.textContent = d.notSky || d.rejected ? "Done" : "Identified";
      if (d.rejected) {
        lastTypes = null; lastId = null; highlight([]);
        result.innerHTML = '<div class="cards"><article class="card"><div class="row"><p class="eyebrow">Photo not accepted</p></div><h3>Please choose a photo of the sky</h3><p>' + esc(d.message || "That photo can’t be used here.") + "</p></article></div>";
        return;
      }
      if (d.notSky) {
        lastTypes = null; lastId = null; highlight([]);
        result.innerHTML = '<div class="cards"><article class="card"><div class="row"><p class="eyebrow">Not a sky photo</p></div><h3>Try a wide shot of the sky</h3><p>' + esc(d.message || "That doesn’t look like a photo of the sky.") + "</p></article></div>";
        return;
      }
      lastTypes = d.types || []; lastConf = d.confidence || {}; lastReasoning = d.reasoning || null; lastFeature = d.feature || null; resultAt = new Date();
      lastId = (!exampleKey && typeof d.id === "string" && /^[0-9a-f-]{36}$/.test(d.id)) ? d.id : null; lastFlagged = false; flaggedTypes = {}; flagBusy = {};
      render();
    })
    .catch(function (err) {
      clearTimeout(clientTimer);
      if (gen !== photoGen) return; /* the photo was changed or reset while this ran */
      inFlight = null;
      var name = err && err.name;
      /* A connection that drops at once usually works a moment later. One more try, not more:
         after 5 s the photo may already be with the worker, and a second copy would be a duplicate. */
      if (name === "NetFail" && tryNo === 1 && Date.now() - sentAt < 5000) {
        /* The second try starts over at the bot check, so the dots go back to step 2. */
        showStep(2, "Connection dropped. Trying again…");
        setTimeout(function () { if (gen === photoGen) identify(gen, wantLoc, pos, 2); }, 1500);
        return;
      }
      var why = name === "NoToken" ? String(err.why || "unknown") : "";
      function show(key, detail) { if (gen !== photoGen) return; unlockIdentify(); result.innerHTML = errHtml(key, detail); }
      if (why === "interaction") return show("box");
      if (TS_SETUP.indexOf(why) !== -1) return show("setup", why);
      if (why && why !== "script" && why !== "timeout") return show("person", why);
      /* Anything else that is not a network failure or a time-out is a fault in the page itself. */
      if (!why && name !== "NetFail" && name !== "AbortError") return show("odd");
      /* The rest turns on one question: does the visitor's own connection still work? */
      connectionWorks().then(function (works) {
        if (why) show(works ? "person" : "offline", works ? why : "");
        else if (name === "AbortError") show(works ? "slowUs" : "slowYou");
        else show(works ? "server" : "offline");
      });
    });
}

/* Real-photo examples for the reference list. Freely licensed photos from Wikimedia Commons,
   resized copies served from this site's /photos/ folder; each is credited in the pop-up. */
var PHOTOS = {
  "Cirrus": {
    "src": "/photos/cirrus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:Cirrus_clouds_with_3D_look.jpg",
    "author": "Simon A. Eugster",
    "license": "CC BY-SA 3.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/3.0/",
    "alt": "Thin white streaks of cirrus sweeping across a deep blue sky",
    "w": 1280,
    "h": 851
  },
  "Cirrocumulus": {
    "src": "/photos/cirrocumulus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:Cirrocumulus_clouds_Thousand_Oaks_July_2010.jpg",
    "author": "King of Hearts",
    "license": "CC BY-SA 3.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/3.0/",
    "alt": "Rows of tiny white cloudlets, like fish scales, across a blue sky",
    "w": 1280,
    "h": 819
  },
  "Cirrostratus": {
    "src": "/photos/cirrostratus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:Cs_nebulosus_with_faint_halo.jpg",
    "author": "Rollcloud",
    "license": "Public domain",
    "licUrl": "https://commons.wikimedia.org/wiki/File:Cs_nebulosus_with_faint_halo.jpg",
    "alt": "A milky veil of cirrostratus across the sky, with the sun glowing through it and a faint halo",
    "w": 1280,
    "h": 960
  },
  "Altocumulus": {
    "src": "/photos/altocumulus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:V%C3%A1%C5%A1a_pond_near_Milevsko_%286%29.JPG",
    "author": "Chmee2",
    "license": "CC BY 3.0",
    "licUrl": "https://creativecommons.org/licenses/by/3.0/",
    "alt": "Rows of small rounded altocumulus patches with gray shading, above a pond and trees",
    "w": 1280,
    "h": 820,
    "pos": "50% 0%"
  },
  "Altostratus": {
    "src": "/photos/altostratus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:2020-12-31_16_06_58_Altostratus_with_a_wavy_undulating_base_above_the_Dulles_section_of_Sterling%2C_Loudoun_County%2C_Virginia.jpg",
    "author": "Famartin",
    "license": "CC BY-SA 4.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
    "alt": "A gray sheet of altostratus with a wavy, rippled underside",
    "w": 1280,
    "h": 960
  },
  "Nimbostratus": {
    "src": "/photos/nimbostratus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:20151123Hockenheim1.jpg",
    "author": "AnRo0002",
    "license": "CC0",
    "licUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "alt": "A dark, low, gray rain-cloud layer covering the sky",
    "w": 1280,
    "h": 960
  },
  "Stratus": {
    "src": "/photos/stratus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:Stratus-Opacus-Uniformis.jpg",
    "author": "PiccoloNamek",
    "license": "CC BY-SA 3.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/3.0/",
    "alt": "A flat, uniform gray layer of low stratus hanging over a field",
    "w": 1280,
    "h": 889
  },
  "Stratocumulus": {
    "src": "/photos/stratocumulus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:Stratocumulus_lacunosus.jpg",
    "author": "Berrucomons",
    "license": "CC BY-SA 3.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/3.0/",
    "alt": "Dark gray lumps and rolls of stratocumulus with lighter gaps between them, above trees",
    "w": 1280,
    "h": 853
  },
  "Cumulus": {
    "src": "/photos/cumulus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:Cumulus_humilis_clouds.jpg",
    "author": "Toby Hudson",
    "license": "CC BY-SA 3.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/3.0/",
    "alt": "Puffy white cumulus clouds with flat bases over open country",
    "w": 1280,
    "h": 909
  },
  "Towering Cumulus": {
    "src": "/photos/towering-cumulus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:Cumulus_congestus_cloud.jpg",
    "author": "Bidgee",
    "license": "CC BY-SA 3.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/3.0/",
    "alt": "A cumulus cloud building tall, its top bulging upward like a cauliflower",
    "pos": "50% 10%",
    "w": 1000,
    "h": 930
  },
  "Cumulonimbus": {
    "src": "/photos/cumulonimbus.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:Cumulonimbus_incus_over_Warsaw%2C_Poland.jpg",
    "author": "Kamil Nowacki",
    "license": "CC BY-SA 4.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
    "alt": "A huge thunderstorm cloud with a flat, spreading anvil top over a city",
    "w": 1280,
    "h": 854
  },
  "fallstreak_hole": {
    "src": "/photos/fallstreak-hole.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:HolePunchCloud.jpg",
    "author": "H. Raab (User:Vesta)",
    "license": "CC BY-SA 3.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/3.0/",
    "alt": "A round hole in a thin cloud layer with a wispy trail of falling ice in its center",
    "w": 1024,
    "h": 682
  },
  "clear": {
    "src": "/photos/clear-sky.jpg",
    "page": "https://commons.wikimedia.org/wiki/File:Cloudless_blue_sky_in_November_-_geograph.org.uk_-_8289272.jpg",
    "author": "Jaggery",
    "license": "CC BY-SA 2.0",
    "licUrl": "https://creativecommons.org/licenses/by-sa/2.0/",
    "alt": "A cloudless blue sky above trees",
    "pos": "50% 0%",
    "w": 960,
    "h": 1028
  }
};
var PHOTO_EXTRA = {
  fallstreak_hole: { tier: "Special feature", name: "Fallstreak hole (hole punch cloud)", text: "A round gap punched in a thin layer of cloud, often with wispy streaks of falling ice hanging in the middle. It forms when supercooled droplets suddenly freeze, frequently set off by a passing airplane." },
  clear: { tier: "No clouds", name: "Clear sky", text: "No clouds in view. The sky looks deepest blue overhead and paler toward the horizon." }
};
(function () {
  var dlg = $("photo-dialog");
  if (!dlg || typeof dlg.showModal !== "function") return;
  var img = $("pd-img"), miss = $("pd-missing");
  /* If the photo server refuses or drops the request, show a short note instead of a broken image. */
  img.addEventListener("error", function () {
    if (img.complete && !img.naturalWidth && img.getAttribute("src")) { img.hidden = true; miss.hidden = false; }
  });
  img.addEventListener("load", function () { img.hidden = false; miss.hidden = true; });
  function link(href, text) { var a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = text; return a; }
  function openPhoto(key) {
    var p = PHOTOS[key]; if (!p) return;
    var info = INFO[key], extra = PHOTO_EXTRA[key];
    $("pd-tier").textContent = info ? info.tier : extra.tier;
    $("pd-title").textContent = info ? key : extra.name;
    $("pd-text").textContent = info ? info.text : extra.text;
    img.hidden = false; miss.hidden = true; miss.style.aspectRatio = p.w + " / " + p.h; $("pd-missing-link").href = p.page;
    img.removeAttribute("src"); img.style.aspectRatio = p.w + " / " + p.h; img.style.objectPosition = p.pos || "50% 50%"; img.alt = p.alt; img.src = p.src;
    var c = $("pd-credit"); c.textContent = "Photo: " + p.author + " · ";
    c.appendChild(link(p.licUrl, p.license)); c.appendChild(document.createTextNode(" · via ")); c.appendChild(link(p.page, "Wikimedia Commons"));
    dlg.showModal();
  }
  document.querySelectorAll(".chips li").forEach(function (li) {
    var key = li.getAttribute("data-t") || li.getAttribute("data-f") || li.getAttribute("data-c");
    if (!PHOTOS[key]) return;
    li.setAttribute("role", "button"); li.setAttribute("tabindex", "0"); li.setAttribute("aria-haspopup", "dialog");
    li.setAttribute("title", "See a photo");
    li.addEventListener("click", function () { openPhoto(key); });
    li.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPhoto(key); } });
  });
  $("pd-close").addEventListener("click", function () { dlg.close(); });
  /* Click on the dark backdrop closes; a click on the dialog's own scrollbar does not. */
  dlg.addEventListener("click", function (e) {
    if (e.target !== dlg) return;
    var r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
})();

/* stamps, filenames, share, print */
function stampParts(d) {
  return { iso: d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "_T" + p2(d.getHours()) + p2(d.getMinutes()),
    local: d.toLocaleString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
    zulu: p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + "Z " + d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate()) };
}
function typeSlug() { return lastTypes && lastTypes.length ? lastTypes.slice().sort().map(function (t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-"); }).join("-") : "clear"; }
function stampLines() {
  var t = stampParts(resultAt || new Date());
  if (photoAt && stampParts(photoAt).iso !== t.iso) { var pt = stampParts(photoAt); return { text: "Photo taken: " + pt.local + " · " + pt.zulu + "\nIdentified: " + t.local + " · " + t.zulu, iso: t.iso }; }
  return { text: "Snapped and identified: " + t.local + " · " + t.zulu, iso: t.iso };
}
function subjectLine() { var st = stampLines(); return "DecodeClouds — " + st.iso.replace("_T", " ").replace(/(\d\d)(\d\d)$/, "$1:$2") + " · " + typeSlug(); }
function namesText(short) { return lastTypes.length ? lastTypes.map(function (t) { var c = lastConf[t]; return t + (c ? " (" + c + (short ? "" : " confidence") + ")" : ""); }).join(", ") : "Clear sky, no cloud types identified"; }
function featureText() { return lastFeature && lastFeature.type ? "\nSpecial feature: " + featureName(lastFeature) + (lastFeature.confidence ? " (" + lastFeature.confidence + ")" : "") + (lastFeature.note ? "\n" + lastFeature.note : "") : ""; }
function summaryText() {
  var rows = reasoningRows();
  return subjectLine() + "\n\n" + stampLines().text + "\nResults: " + namesText(false) + featureText() +
    (rows.length ? "\n\nHow this was identified:\n" + rows.map(function (x) { return "- " + x[0] + ": " + x[1]; }).join("\n") : "") + "\n\ndecodeclouds.com · Educational only.";
}
function textMessageBody() { return subjectLine() + "\n" + namesText(true) + (lastFeature && lastFeature.type ? "\nSpecial feature: " + featureName(lastFeature) : "") + "\n" + stampLines().text.split("\n")[0] + "\ndecodeclouds.com"; }
function shareReport(mode) {
  if (lastTypes === null) return;
  var st = stampLines(), subject = subjectLine(), body = mode === "text" ? textMessageBody() : summaryText(), shared = false;
  try {
    if (navigator.canShare && pvi.src.indexOf("data:") === 0) {
      var parts = pvi.src.split(","), m = (parts[0].match(/data:([^;]+)/) || [null, "image/jpeg"])[1], bin = atob(parts[1]), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var photo = new File([arr], "decodeclouds_" + typeSlug() + "_" + st.iso + (m === "image/png" ? ".png" : ".jpg"), { type: m });
      if (navigator.canShare({ files: [photo] })) { shared = true; navigator.share({ files: [photo], title: subject, text: body }).catch(function () {}); }
    }
  } catch (e) { shared = false; }
  if (!shared) location.href = mode === "text" ? "sms:?&body=" + encodeURIComponent(body) : "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
}
function downloadPdf() {
  if (lastTypes === null) return;
  var st = stampLines(), prev = document.title;
  document.title = "decodeclouds_" + typeSlug() + "_" + st.iso;
  function restore() { document.title = prev; window.removeEventListener("afterprint", restore); }
  window.addEventListener("afterprint", restore); setTimeout(restore, 3000);
  $("print").innerHTML = "<p><b>DecodeClouds</b> · decodeclouds.com</p>" +
    '<p class="pr-meta">' + esc(st.text).replace("\n", "<br>") + "</p>" +
    '<span id="pr-photo"></span>' +
    "<h2>Results</h2>" + (lastTypes.length ? lastTypes.map(function (t) { var i = INFO[t] || {}; return "<h3>" + esc(t) + (lastConf[t] ? " <small>(" + esc(lastConf[t]) + " confidence)</small>" : "") + "</h3><p>" + esc(i.text || "") + "</p>"; }).join("") : "<p>Clear sky, no cloud types identified.</p>") +
    (lastFeature && lastFeature.type ? "<h3>Special feature: " + esc(featureName(lastFeature)) + "</h3><p>" + esc(lastFeature.note || "") + "</p>" : "") +
    (reasoningRows().length ? "<h2>How this was identified</h2>" + reasoningRows().map(function (x) { return "<p><b>" + x[0] + ":</b> " + esc(x[1]) + "</p>"; }).join("") : "") +
    '<p class="pr-meta">For educational purposes only. Cloud identification may be inaccurate or incomplete.</p>';
  var slot = $("pr-photo");
  if (pvi.src) { var im = document.createElement("img"); im.src = pvi.src; im.alt = "Sky photo"; slot.replaceWith(im); } else { slot.remove(); }
  window.print();
}

