"use strict";
/* This site's own worker — deploy from ../worker (see README). */
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
      setTimeout(function () { finish(""); }, 20000);
      if (!window.turnstile) return finish("");
      try {
        if (tsWidget === null) {
          tsWidget = window.turnstile.render("#ts", {
            sitekey: TURNSTILE_SITEKEY, execution: "execute", appearance: "interaction-only",
            callback: function (t) { if (tsWaiter) tsWaiter(t); },
            "error-callback": function () { if (tsWaiter) tsWaiter(""); }
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
document.querySelector("form.tool").addEventListener("submit", function (e) { e.preventDefault(); });
var pick = $("pick"), drop = $("drop"), go = $("go"), result = $("result"), block = $("result-block"), pv = $("preview"), pvi = $("preview-img");
var b64 = null, mime = null, fname = "", lastTypes = null, lastConf = {}, lastFeature = null, lastReasoning = null, resultAt = null, photoAt = null;

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
function confHtml(c) { var L = { high: "high confidence", medium: "medium confidence", low: "low confidence" }[c]; return L ? '<span class="conf ' + c + '"><span class="dots"><i></i><i></i><i></i></span>' + L + "</span>" : ""; }
function featureName(fe) { return FEATURE[fe.type] || String(fe.type).replace(/_/g, " "); }
function highlight(types, isResult) {
  document.querySelectorAll(".chips li[data-t]").forEach(function (el) { el.classList.toggle("hit", types.indexOf(el.getAttribute("data-t")) !== -1); });
  document.querySelectorAll(".chips li[data-f]").forEach(function (el) { el.classList.toggle("hit", !!(types.length && lastFeature && lastFeature.type === el.getAttribute("data-f"))); });
  document.querySelectorAll(".chips li[data-c]").forEach(function (el) { el.classList.toggle("hit", !!isResult && !types.length); });
}

function cardsHtml() {
  var h = "";
  if (!lastTypes.length) h += '<article class="card"><div class="row"><p class="eyebrow">No clouds</p></div><h3>Clear sky</h3><p>No cloud types identified in this photo.</p></article>';
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
    '<p class="share-hint">Email and Text open your phone’s share sheet with the photo attached. Download saves a PDF.</p>';
  $("pdf-btn").addEventListener("click", downloadPdf);
  $("email-btn").addEventListener("click", function () { shareReport("email"); });
  $("text-btn").addEventListener("click", function () { shareReport("text"); });
  highlight(lastTypes, true);
}

/* photo in */
function shrink(dataUrl, maxEdge, cb) {
  var done = false; function fin(u, t) { if (!done) { done = true; cb(u, t); } }
  setTimeout(function () { fin(dataUrl, mime); }, 4000);
  var img = new Image();
  img.onload = function () {
    try {
      var w = img.naturalWidth, h = img.naturalHeight, L = Math.max(w, h);
      if (!w || L <= maxEdge) return fin(dataUrl, mime);
      var s = maxEdge / L, c = document.createElement("canvas");
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      fin(c.toDataURL("image/jpeg", 0.85), "image/jpeg");
    } catch (e) { fin(dataUrl, mime); }
  };
  img.onerror = function () { fin(dataUrl, mime); };
  img.src = dataUrl;
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
function loadFile(f) {
  if (!f || !/^image\//.test(f.type || "image/jpeg")) return;
  fname = f.name; mime = f.type || "image/jpeg";
  $("fname").textContent = (f.name === "image.jpg" ? "Photo ready" : f.name) + " · " + Math.round(f.size / 1024) + " KB";
  block.hidden = true; result.innerHTML = ""; lastTypes = null; highlight([]);
  var r = new FileReader();
  r.onload = function () {
    pvi.src = r.result; pv.hidden = false; drop.hidden = true; $("reset-btn").disabled = false;
    photoAt = exifDate(r.result) || (f.lastModified ? new Date(f.lastModified) : null);
    shrink(r.result, 1200, function (u, t) { mime = t; b64 = u.split(",")[1]; go.disabled = !b64; });
  };
  r.readAsDataURL(f);
}
pick.addEventListener("change", function (e) { loadFile(e.target.files && e.target.files[0]); });
["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
drop.addEventListener("drop", function (e) { loadFile(e.dataTransfer.files && e.dataTransfer.files[0]); });
function resetAll() {
  pick.value = ""; b64 = null; pv.hidden = true; pvi.src = ""; drop.hidden = false; go.disabled = true; $("reset-btn").disabled = true;
  block.hidden = true; result.innerHTML = ""; lastTypes = null; $("fname").textContent = ""; highlight([]);
}
$("reset-btn").addEventListener("click", resetAll);

go.addEventListener("click", function () {
  if (!b64) return;
  go.disabled = true; go.textContent = "Identifying…"; block.hidden = false;
  block.scrollIntoView({ behavior: "smooth", block: "start" });
  result.innerHTML = '<p class="loading">Reading the sky&hellip; usually 5 to 15 seconds.</p>';
  /* The worker gives up on the AI after 30 s and says so; this is a backstop if the network itself stalls. */
  var ctrl = typeof AbortController === "function" ? new AbortController() : null, clientTimer = null;
  getTurnstileToken()
    .then(function (token) {
      if (ctrl) clientTimer = setTimeout(function () { ctrl.abort(); }, 40000);
      return fetch(WORKER_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: b64, mediaType: mime, turnstile: token }), signal: ctrl ? ctrl.signal : undefined });
    })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }, function () { return { ok: r.ok, data: {} }; }); })
    .then(function (res) {
      clearTimeout(clientTimer);
      go.disabled = false; go.textContent = "Identify clouds";
      if (!res || !res.ok) { result.innerHTML = '<p class="err">' + esc((res && res.data && res.data.message) || "Couldn’t read that one. Try another photo.") + "</p>"; return; }
      var d = res.data || {};
      lastTypes = d.types || []; lastConf = d.confidence || {}; lastReasoning = d.reasoning || null; lastFeature = d.feature || null; resultAt = new Date();
      render();
    })
    .catch(function (err) {
      clearTimeout(clientTimer);
      go.disabled = false; go.textContent = "Identify clouds";
      var timedOut = err && err.name === "AbortError";
      result.innerHTML = '<p class="err">' + (timedOut ? "Identifying took too long this time. Please try again." : "Couldn’t connect. Check your signal and try again.") + "</p>";
    });
});

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
  return subjectLine() + "\n\n" + stampLines().text + "\nResult: " + namesText(false) + featureText() +
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
    (pvi.src ? '<img src="' + pvi.src + '" alt="Sky photo" />' : "") +
    "<h2>Result</h2>" + (lastTypes.length ? lastTypes.map(function (t) { var i = INFO[t] || {}; return "<h3>" + esc(t) + (lastConf[t] ? " <small>(" + lastConf[t] + " confidence)</small>" : "") + "</h3><p>" + esc(i.text || "") + "</p>"; }).join("") : "<p>Clear sky, no cloud types identified.</p>") +
    (lastFeature && lastFeature.type ? "<h3>Special feature: " + esc(featureName(lastFeature)) + "</h3><p>" + esc(lastFeature.note || "") + "</p>" : "") +
    (reasoningRows().length ? "<h2>How this was identified</h2>" + reasoningRows().map(function (x) { return "<p><b>" + x[0] + ":</b> " + esc(x[1]) + "</p>"; }).join("") : "") +
    '<p class="pr-meta">For educational purposes only. Cloud identification may be inaccurate or incomplete. Not for weather forecasting, aviation, or safety-critical decisions.</p>';
  window.print();
}

