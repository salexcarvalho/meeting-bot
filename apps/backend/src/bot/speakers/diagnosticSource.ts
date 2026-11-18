// Modo de diagnóstico (BOT_SPEAKER_DIAGNOSTIC, desligado por padrão): roda DENTRO da página e devolve só a
// ESTRUTURA dos quadros da chamada, sem texto, nomes, áudio ou vídeo, para calibrar os seletores numa reunião
// real (T001). Nomes, rótulos e ids viram "forma" (palavras → W, dígitos → 9, ids → hash); só as palavras de
// estado conhecidas (mute, microphone, speaking…) aparecem por extenso. Texto em string pelo mesmo motivo do probeSource.

export const DIAGNOSTIC_SOURCE = String.raw`
(function (limits) {
  var KEEP = ["role", "data-tid", "data-stream-type", "aria-hidden", "aria-pressed", "aria-checked", "aria-live", "aria-selected", "jsname", "type", "tabindex"];
  var SHAPE = ["aria-label", "data-self-name", "title", "alt", "aria-description"];
  var HASH = ["data-participant-id", "id", "data-uid", "data-ssrc"];
  var WORDS = /^(mute|muted|unmute|unmuted|microphone|mic|camera|video|speaking|people|participants|presenting|you|guest|pinned|spotlight|raised|hand|on|off|and|is|are|has|in|of|to|turn)$/i;
  var STYLE = ["outline-style", "outline-width", "outline-color", "box-shadow", "animation-name", "opacity", "visibility", "transform", "border-color"];

  function hash(v) {
    var h = 5381;
    for (var i = 0; i < v.length; i++) h = ((h << 5) + h + v.charCodeAt(i)) | 0;
    return "h" + (h >>> 0).toString(16);
  }
  function shape(text) {
    var t = String(text || "").slice(0, 200);
    var words = t.split(/([^\p{L}\p{N}]+)/u);
    var out = "";
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (/^[^\p{L}\p{N}]+$/u.test(w)) out += w;
      else if (WORDS.test(w)) out += w.toLowerCase();
      else if (/^\p{N}+$/u.test(w)) out += "9";
      else out += "W";
    }
    return out.slice(0, 100);
  }
  function interesting(el) {
    if (el.getAttribute("role") || el.getAttribute("aria-label")) return true;
    for (var i = 0; i < el.attributes.length; i++) if (el.attributes[i].name.indexOf("data-") === 0) return true;
    return el.tagName === "VIDEO" || el.tagName === "CANVAS";
  }
  function pathOf(el) {
    var parts = [];
    var n = el;
    for (var d = 0; n && n.nodeType === 1 && d < 6; d++) {
      var role = n.getAttribute("role");
      var tid = n.getAttribute("data-tid");
      parts.unshift(n.tagName.toLowerCase() + (role ? "[" + role + "]" : "") + (tid ? "{" + tid + "}" : ""));
      n = n.parentElement;
    }
    return parts.join(">");
  }
  function describe(el) {
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (KEEP.indexOf(a.name) >= 0) attrs[a.name] = String(a.value).slice(0, 60);
      else if (SHAPE.indexOf(a.name) >= 0) attrs[a.name] = shape(a.value);
      else if (HASH.indexOf(a.name) >= 0) attrs[a.name] = hash(a.value);
      else if (a.name.indexOf("data-") === 0) attrs[a.name] = "(presente)";
    }
    var cs = window.getComputedStyle(el);
    var style = {};
    for (var s = 0; s < STYLE.length; s++) style[STYLE[s]] = cs.getPropertyValue(STYLE[s]);
    var rect = el.getBoundingClientRect();
    var own = "";
    for (var c = 0; c < el.childNodes.length; c++) if (el.childNodes[c].nodeType === 3) own += el.childNodes[c].nodeValue;
    return {
      path: pathOf(el),
      tag: el.tagName.toLowerCase(),
      classes: String(el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 8),
      attrs: attrs,
      style: style,
      size: [Math.round(rect.width), Math.round(rect.height)],
      children: el.children.length,
      hasMedia: !!el.querySelector("video, canvas, img"),
      ownTextShape: shape(own)
    };
  }
  var out = [];
  var all = document.querySelectorAll("*");
  for (var i = 0; i < all.length && out.length < limits.maxNodes; i++) {
    var el = all[i];
    if (el.closest("script, style, head")) continue;
    if (interesting(el)) out.push(describe(el));
  }
  return { host: location.hostname, at: Date.now(), total: all.length, nodes: out };
})
`;
