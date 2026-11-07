"use strict";
/* This site's own worker: deployed with Wrangler from the local worker/ folder, which is not in the public repo. */
var WORKER_URL = "https://decode-clouds.zwubbena.workers.dev/classify";
/* Cloudflare Turnstile bot check. The site key is public. Empty = check off. */
var TURNSTILE_SITEKEY = "0x4AAAAAAF1xtuj8d40wVGTB";
var tsWidget = null, tsWaiter = null, tsReady = Promise.resolve();
if (TURNSTILE_SITEKEY) {
  tsReady = new Promise(function (res) {
    var sc = document.createElement("script");
    sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    sc.async = true; sc.onload = res; sc.onerror = res;
    document.head.appendChild(sc);
  });
}
/* Resolves with a fresh single-use token ("" if the check is off or can't run). */
function getTurnstileToken() {
  if (!TURNSTILE_SITEKEY) return Promise.resolve("");
  return tsReady.then(function () {
    return new Promise(function (resolve) {
      var done = false;
      function finish(t) { if (!done) { done = true; tsWaiter = null; resolve(t || ""); } }
      tsWaiter = finish;
      /* Usually instant. If Cloudflare shows a checkbox instead, give the visitor time to click it. */
      setTimeout(function () { finish(""); }, 60000);
      if (!window.turnstile) return finish("");
      try {
        if (tsWidget === null) {
          tsWidget = window.turnstile.render("#ts", {
            sitekey: TURNSTILE_SITEKEY, execution: "execute", appearance: "interaction-only",
            callback: function (t) { if (tsWaiter) tsWaiter(t); },
            "error-callback": function () { if (tsWaiter) tsWaiter(""); },
            /* Cloudflare occasionally asks the visitor to tick a box. Bring it into view and say so,
               because by now the page has scrolled down to the results block. */
            "before-interactive-callback": function () {
              var ts = $("ts"); ts.classList.add("needs-you"); ts.scrollIntoView({ behavior: "smooth", block: "center" });
              if (!block.hidden) result.innerHTML = '<p class="loading">Please tick the box above to continue.</p>';
            },
            "after-interactive-callback": function () {
              $("ts").classList.remove("needs-you");
              if (!block.hidden) { result.innerHTML = '<p class="loading">Reading the sky&hellip; usually 5 to 15 seconds.</p>'; block.scrollIntoView({ behavior: "smooth", block: "start" }); }
            }
          });
        } else {
          window.turnstile.reset(tsWidget);
        }
        window.turnstile.execute(tsWidget);
      } catch (e) { finish(""); }
    });
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
var b64 = null, mime = null, fname = "", currentFile = null, lastTypes = null, lastConf = {}, lastFeature = null, lastReasoning = null, resultAt = null, photoAt = null;
/* Where photoAt came from ("exif" = camera date, "file" = file date) and the size of the copy that is analyzed. */
var photoSrc = null, sentW = null, sentH = null;
/* Archive: every identified photo is kept (said on the page). lastId is its archive id; exifInfo is what the camera recorded. */
var ARCHIVE_URL = WORKER_URL.replace(/\/classify$/, "");
var lastId = null, exifInfo = {}, locDone = false;
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
var CONF_LABEL = { high: "high confidence", medium: "medium confidence", low: "low confidence" };
function confHtml(c) {
  if (!Object.prototype.hasOwnProperty.call(CONF_LABEL, c)) return "";
  return '<span class="conf ' + c + '"><span class="dots"><i></i><i></i><i></i></span>' + CONF_LABEL[c] + "</span>";
}
function featureName(fe) { return FEATURE[fe.type] || String(fe.type).replace(/_/g, " "); }
function highlight(types, isResult) {
  document.querySelectorAll(".chips li[data-t]").forEach(function (el) { el.classList.toggle("hit", types.indexOf(el.getAttribute("data-t")) !== -1); });
  document.querySelectorAll(".chips li[data-f]").forEach(function (el) { el.classList.toggle("hit", !!(types.length && lastFeature && lastFeature.type === el.getAttribute("data-f"))); });
  document.querySelectorAll(".chips li[data-c]").forEach(function (el) { el.classList.toggle("hit", !!isResult && !types.length); });
}

function cardsHtml() {
  var h = "";
  if (!lastTypes.length) h += '<article class="card"><div class="row"><p class="eyebrow">No clouds</p>' + confHtml(lastConf.CLR) + '</div><h3>Clear sky</h3><p>No cloud types identified in this photo.</p></article>';
  lastTypes.forEach(function (t) {
    var i = INFO[t] || { tier: "Cloud", text: "", form: "", alt: "" };
    h += '<article class="card"><div class="row"><p class="eyebrow">' + esc(i.tier) + "</p>" + confHtml(lastConf[t]) + "</div><h3>" + esc(t) + "</h3>" +
      (i.text ? "<p>" + esc(i.text) + "</p>" : "") +
      (i.form ? '<div class="details"><p class="eyebrow">Details for your brain</p><dl><dt>Form</dt><dd>' + esc(i.form) + "</dd><dt>Altitude</dt><dd>" + esc(i.alt) + "</dd></dl></div>" : "") + "</article>";
  });
  if (lastFeature && lastFeature.type) {
    var n = featureName(lastFeature), m = n.match(/^(.*?)\s*\((.*)\)$/);
    h += '<article class="card feature"><div class="row"><p class="eyebrow">Special feature</p>' + confHtml(lastFeature.confidence) + "</div><h3>" +
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
  if (lastId) wireArchive();
  highlight(lastTypes, true);
}

/* ---- Archive line under a result: the archive number (for removal requests by email) and an optional location ---- */
function archiveHtml() {
  if (exampleKey) {
    /* Example photos are never archived; show the block greyed out so visitors see what happens with their own. */
    return '<section class="archive archive-off" id="archive" aria-disabled="true">' +
      '<p class="archive-id"><b>Example photo.</b> Examples aren’t added to the archive. Your own photos are, and this is where their archive number appears.</p>' +
      '<div class="loc-line"><button class="pill white" id="loc-btn" type="button" disabled>Use my location</button>' +
      '<span class="hint">For your own photos: adds where it was taken, rounded to about 1&nbsp;km.</span></div></section>';
  }
  if (!lastId) return "";
  var hasExifLoc = exifInfo && typeof exifInfo.lat === "number";
  return '<section class="archive" id="archive">' +
    '<p class="archive-id"><b>Thanks for contributing to science.</b> This photo is now in the open DecodeClouds archive' +
    (hasExifLoc ? ", with the location your camera recorded, rounded to about 1&nbsp;km" : "") +
    ' (#' + esc(lastId.slice(0, 8)) + ").</p>" +
    (hasExifLoc ? "" :
      '<div class="loc-line" id="loc-line"><button class="pill white" id="loc-btn" type="button">Use my location</button>' +
      '<span class="hint">Where it was taken makes it more useful, rounded to about 1&nbsp;km. Only if you’re still there.</span>' +
      '<label class="check"><input type="checkbox" id="loc-exact"> Keep the exact spot</label></div>') +
    '<p class="archive-status" id="archive-status" hidden></p></section>';
}
function fmtLoc(lat, lon, exact) {
  var d = exact ? 5 : 2;
  return Math.abs(lat).toFixed(d) + "°" + (lat < 0 ? "S" : "N") + ", " + Math.abs(lon).toFixed(d) + "°" + (lon < 0 ? "W" : "E");
}
function wireArchive() {
  var b = $("loc-btn"); if (b) b.addEventListener("click", askLocation);
}
function archiveStatus(text, cls) { var st = $("archive-status"); if (!st) return; st.textContent = text; st.className = "archive-status " + (cls || ""); st.hidden = false; }
function askLocation() {
  var b = $("loc-btn"), id = lastId, gen = photoGen;
  if (!id || locDone) return;
  if (!navigator.geolocation) { archiveStatus("Location isn’t available in this browser.", "err"); return; }
  b.disabled = true; b.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(function (pos) {
    if (gen !== photoGen) return;
    var c = pos.coords, exact = !!($("loc-exact") && $("loc-exact").checked);
    var payload = { id: id, lat: c.latitude, lon: c.longitude, exact: exact };
    if (typeof c.accuracy === "number") payload.locAccuracyM = c.accuracy;
    if (typeof c.altitude === "number" && isFinite(c.altitude)) payload.altitudeM = c.altitude;
    b.textContent = "Saving…";
    getTurnstileToken()
      .then(function (token) { payload.turnstile = token; return fetch(ARCHIVE_URL + "/locate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }, function () { return { ok: r.ok, data: {} }; }); })
      .then(function (res) {
        if (gen !== photoGen) return;
        if (!res.ok || !res.data || !res.data.ok) { b.disabled = false; b.textContent = "Use my location"; archiveStatus((res.data && res.data.message) || "Couldn’t add the location. Please try again.", "err"); return; }
        locDone = true; var line = $("loc-line"); if (line) line.hidden = true;
        archiveStatus("Location added: " + fmtLoc(res.data.lat, res.data.lon, res.data.exact) + (res.data.exact ? " (exact)" : " (rounded to about 1 km)") + ".", "ok");
      })
      .catch(function () { if (gen !== photoGen) return; b.disabled = false; b.textContent = "Use my location"; archiveStatus("Couldn’t connect. Check your signal and try again.", "err"); });
  }, function () {
    if (gen !== photoGen) return;
    b.disabled = false; b.textContent = "Use my location";
    archiveStatus("Couldn’t get your location. The photo is saved without one.", "err");
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

/* photo in */
function shrink(dataUrl, maxEdge, cb) {
  var done = false; function fin(u, t, w, h) { if (!done) { done = true; cb(u, t, w || null, h || null); } }
  setTimeout(function () { fin(dataUrl, mime); }, 20000);
  var img = new Image();
  img.onload = function () {
    try {
      var w = img.naturalWidth, h = img.naturalHeight, L = Math.max(w, h);
      if (!w || L <= maxEdge) return fin(dataUrl, mime, w, h);
      var s = maxEdge / L, c = document.createElement("canvas");
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
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
  var gen = ++photoGen; if (inFlight) { inFlight.abort(); inFlight = null; }
  exampleKey = example || null;
  go.textContent = "Identify clouds"; go.disabled = true;
  fname = f.name; mime = f.type || "image/jpeg"; currentFile = f;
  $("fname").textContent = (f.name === "image.jpg" ? "Photo ready" : f.name) + " · " + Math.round(f.size / 1024) + " KB";
  block.hidden = true; result.innerHTML = ""; lastTypes = null; highlight([]);
  lastId = null; exifInfo = {}; locDone = false;
  var r = new FileReader();
  r.onload = function () {
    if (gen !== photoGen) return;
    pvi.src = r.result; pv.hidden = false; drop.hidden = true; $("reset-btn").disabled = false;
    if (example) {
      /* Example photos go as-is; their date is not meaningful. */
      exifInfo = {}; photoAt = null; photoSrc = null; mime = f.type; b64 = r.result.split(",")[1];
      var im = new Image(); im.onload = function () { if (gen !== photoGen) return; sentW = im.naturalWidth; sentH = im.naturalHeight; go.disabled = false; }; im.onerror = function () { if (gen !== photoGen) return; go.disabled = false; }; im.src = r.result;
      return;
    }
    exifInfo = readExif(r.result);
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
  photoGen++; if (inFlight) { inFlight.abort(); inFlight = null; }
  currentFile = null; photoAt = null; photoSrc = null; sentW = null; sentH = null; go.textContent = "Identify clouds";
  lastId = null; exifInfo = {}; locDone = false; exampleKey = null; $("example").value = "";
  pick.value = ""; b64 = null; pv.hidden = true; pvi.src = ""; drop.hidden = false; go.disabled = true; $("reset-btn").disabled = true;
  block.hidden = true; result.innerHTML = ""; lastTypes = null; $("fname").textContent = ""; highlight([]);
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

go.addEventListener("click", function () {
  if (!b64) return;
  go.disabled = true; go.textContent = "Identifying…"; block.hidden = false;
  block.scrollIntoView({ behavior: "smooth", block: "start" });
  result.innerHTML = '<p class="loading">Reading the sky&hellip; usually 5 to 15 seconds.</p>';
  /* The worker gives up on the AI after 30 s and says so; this is a backstop if the network itself stalls. */
  var ctrl = typeof AbortController === "function" ? new AbortController() : null, clientTimer = null, gen = photoGen;
  inFlight = ctrl;
  getTurnstileToken()
    .then(function (token) {
      if (gen !== photoGen) throw { name: "AbortError", stale: true };
      if (ctrl) clientTimer = setTimeout(function () { ctrl.abort(); }, 40000);
      /* The photo's own facts go with it: date, size, camera, and GPS if the camera wrote one (rounded server-side). See the Disclaimer. */
      var payload = { image: b64, mediaType: mime, turnstile: token, w: sentW, h: sentH, tzOffsetMin: -new Date().getTimezoneOffset() };
      if (photoAt) { payload.taken = photoAt.toISOString(); payload.takenSource = photoSrc; }
      if (exampleKey) payload.example = exampleKey;
      if (exifInfo) {
        if (typeof exifInfo.lat === "number") { payload.lat = exifInfo.lat; payload.lon = exifInfo.lon; if (typeof exifInfo.altitude === "number") payload.altitudeM = exifInfo.altitude; }
        if (exifInfo.make) payload.cameraMake = exifInfo.make; if (exifInfo.model) payload.cameraModel = exifInfo.model;
      }
      return fetch(WORKER_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ctrl ? ctrl.signal : undefined });
    })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }, function () { return { ok: r.ok, data: {} }; }); })
    .then(function (res) {
      clearTimeout(clientTimer);
      if (gen !== photoGen) return;
      inFlight = null;
      go.disabled = false; go.textContent = "Identify clouds";
      if (!res || !res.ok) { result.innerHTML = '<p class="err">' + esc((res && res.data && res.data.message) || "Couldn’t read that one. Try another photo.") + "</p>"; return; }
      var d = res.data || {};
      if (d.notSky) {
        lastTypes = null; lastId = null; highlight([]);
        result.innerHTML = '<div class="cards"><article class="card"><div class="row"><p class="eyebrow">Not a sky photo</p></div><h3>Try a wide shot of the sky</h3><p>' + esc(d.message || "That doesn’t look like a photo of the sky.") + "</p></article></div>";
        return;
      }
      lastTypes = d.types || []; lastConf = d.confidence || {}; lastReasoning = d.reasoning || null; lastFeature = d.feature || null; resultAt = new Date();
      lastId = (!exampleKey && typeof d.id === "string" && /^[0-9a-f-]{36}$/.test(d.id)) ? d.id : null; locDone = false;
      render();
    })
    .catch(function (err) {
      clearTimeout(clientTimer);
      if (gen !== photoGen) return; /* the photo was changed or reset while this ran */
      inFlight = null;
      go.disabled = false; go.textContent = "Identify clouds";
      var timedOut = err && err.name === "AbortError";
      result.innerHTML = '<p class="err">' + (timedOut ? "Sorry it took too long. Do me a favor. Try again." : "Couldn’t connect. Check your signal and try again.") + "</p>";
    });
});

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
    '<p class="pr-meta">For educational purposes only. Cloud identification may be inaccurate or incomplete. Not for weather forecasting, aviation, or safety-critical decisions.</p>';
  var slot = $("pr-photo");
  if (pvi.src) { var im = document.createElement("img"); im.src = pvi.src; im.alt = "Sky photo"; slot.replaceWith(im); } else { slot.remove(); }
  window.print();
}

