// Código que roda DENTRO da página da chamada (Teams/Meet): lê os quadros (tiles) dos participantes e
// registra as bordas do indicador de fala. Fica como texto de propósito: o tsx/esbuild reescreve funções
// com auxiliares (`__name`) que não existem na página, e `page.evaluate` serializa o código-fonte da função.
// Só devolve para o Node as MUDANÇAS de estado (subida/descida), em lote, quando o Node pergunta (`drain`).
//
// Sem rede, sem escrita na página, sem clique: leitura passiva do que o convidado já vê (spec 006, FR-002).

export const PROBE_VERSION = 1;

export const PROBE_SOURCE = String.raw`
(function (cfg) {
  var existing = window.__mbSpk;
  if (existing && existing.version === cfg.version) return existing.stats();
  if (existing && existing.stop) existing.stop();

  var edges = [];
  var state = new Map();
  var styleStore = new WeakMap();
  var stats = { tiles: 0, layer: -1, errors: 0, polls: 0, speaking: 0, layerName: "", lastError: "" };
  var tileCache = { at: 0, layer: -1, list: [] };
  var dirty = true;
  var timer = null;
  var observer = null;
  var currentInterval = 0;

  function text(el) {
    var t = el && el.textContent ? el.textContent : "";
    return t.replace(/\s+/g, " ").trim().slice(0, 400);
  }

  function shortestText(tile) {
    var best = "";
    var nodes = tile.querySelectorAll("span, div, p");
    for (var i = 0; i < nodes.length && i < 60; i++) {
      var n = nodes[i];
      if (n.children.length > 0) continue;
      var t = text(n);
      if (t && t.length <= 60 && (!best || t.length > best.length)) best = t;
    }
    return best;
  }

  function readName(tile, sources) {
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var el = s.sel ? tile.querySelector(s.sel) : s.self ? tile : null;
      var value = "";
      if (s.shortest) value = shortestText(tile);
      else if (el && s.attr) value = el.getAttribute(s.attr) || "";
      else if (el && s.text) value = text(el);
      value = (value || "").trim();
      if (value) return value.slice(0, 400);
    }
    return "";
  }

  function isShown(el) {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
    var cs = window.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0;
  }

  function styleSignature(el, props) {
    var cs = window.getComputedStyle(el);
    var out = [];
    for (var i = 0; i < props.length; i++) out.push(cs.getPropertyValue(props[i]));
    return out.join("|");
  }

  function styleSpeaking(tile, el, rule) {
    var sig = styleSignature(el, rule.props);
    var rec = styleStore.get(tile);
    if (!rec) { rec = { counts: new Map(), total: 0 }; styleStore.set(tile, rec); }
    rec.counts.set(sig, (rec.counts.get(sig) || 0) + 1);
    rec.total++;
    if (rec.total < rule.minObservations) return false;
    var restSig = ""; var restN = -1;
    rec.counts.forEach(function (n, k) { if (n > restN) { restN = n; restSig = k; } });
    return sig !== restSig;
  }

  function ruleSpeaking(tile, rule) {
    var el = rule.sel ? tile.querySelector(rule.sel) : tile;
    if (!el) return false;
    if (rule.mode === "present") return isShown(el);
    if (rule.mode === "attr") {
      var v = el.getAttribute(rule.attr);
      return v !== null && new RegExp(rule.match, "i").test(v);
    }
    if (rule.mode === "style") return styleSpeaking(tile, el, rule);
    return false;
  }

  function isSpeaking(tile, layer) {
    for (var i = 0; i < layer.indicators.length; i++) if (ruleSpeaking(tile, layer.indicators[i])) return true;
    return false;
  }

  function discover(layerIndex) {
    var layer = cfg.layers[layerIndex];
    var nodes = document.querySelectorAll(layer.tile);
    var out = [];
    for (var i = 0; i < nodes.length && out.length < cfg.maxTiles; i++) {
      var n = nodes[i];
      if (layer.requires && !n.querySelector(layer.requires)) continue;
      out.push(n);
    }
    return out;
  }

  function readTiles(layerIndex, tiles) {
    var layer = cfg.layers[layerIndex];
    var out = [];
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (!tile.isConnected) continue;
      var raw = readName(tile, layer.nameFrom);
      if (!raw) continue;
      var id = layer.idAttr ? tile.getAttribute(layer.idAttr) || "" : "";
      out.push({ id: id, raw: raw, speaking: isSpeaking(tile, layer) });
    }
    return out;
  }

  function snapshot() {
    var now = Date.now();
    var useCache = !dirty && now - tileCache.at < cfg.cacheMs && tileCache.layer >= 0;
    if (useCache) {
      var cached = readTiles(tileCache.layer, tileCache.list);
      if (cached.length) return { layer: tileCache.layer, tiles: cached };
    }
    dirty = false;
    for (var li = 0; li < cfg.layers.length; li++) {
      var list = discover(li);
      var read = readTiles(li, list);
      if (read.length) {
        tileCache = { at: now, layer: li, list: list };
        return { layer: li, tiles: read };
      }
    }
    tileCache = { at: now, layer: -1, list: [] };
    return { layer: -1, tiles: [] };
  }

  function pageKey(t) { return t.id ? "id:" + t.id : "n:" + t.raw; }

  function poll() {
    stats.polls++;
    try {
      var snap = snapshot();
      var at = Date.now();
      var seen = new Set();
      var speaking = 0;
      for (var i = 0; i < snap.tiles.length; i++) {
        var t = snap.tiles[i];
        var k = pageKey(t);
        seen.add(k);
        if (t.speaking) speaking++;
        var prev = state.get(k);
        var was = prev ? prev.speaking : false;
        if (!prev || prev.raw !== t.raw) state.set(k, { speaking: was, raw: t.raw, id: t.id });
        if (t.speaking !== was) {
          edges.push({ id: t.id, raw: t.raw, speaking: t.speaking, at: at });
          state.get(k).speaking = t.speaking;
        }
      }
      state.forEach(function (rec, key) {
        if (seen.has(key)) return;
        if (rec.speaking) edges.push({ id: rec.id, raw: rec.raw, speaking: false, at: at });
        state.delete(key);
      });
      if (edges.length > cfg.maxEdges) edges.splice(0, edges.length - cfg.maxEdges);
      stats.tiles = snap.tiles.length;
      stats.layer = snap.layer;
      stats.layerName = snap.layer >= 0 ? cfg.layers[snap.layer].name : "";
      stats.speaking = speaking;
      var wanted = snap.tiles.length > cfg.largeTiles ? cfg.largeIntervalMs : cfg.intervalMs;
      if (wanted !== currentInterval) schedule(wanted);
    } catch (e) {
      stats.errors++;
      stats.lastError = String(e && e.name ? e.name : "erro").slice(0, 40);
    }
  }

  function schedule(ms) {
    if (timer) clearInterval(timer);
    currentInterval = ms;
    timer = setInterval(poll, ms);
  }

  function snapshotStats() {
    return { tiles: stats.tiles, layer: stats.layer, layerName: stats.layerName, errors: stats.errors, polls: stats.polls, speaking: stats.speaking, lastError: stats.lastError };
  }

  var api = {
    version: cfg.version,
    stats: snapshotStats,
    drain: function () {
      var out = edges;
      edges = [];
      return { now: Date.now(), edges: out, stats: snapshotStats() };
    },
    stop: function () {
      if (timer) clearInterval(timer);
      if (observer) observer.disconnect();
      timer = null; observer = null;
    }
  };
  window.__mbSpk = api;

  try {
    // Só uma dica barata: mudança na estrutura invalida o cache de quadros; quem decide a fala é o poll.
    observer = new MutationObserver(function () { dirty = true; });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { stats.errors++; }
  schedule(cfg.intervalMs);
  return snapshotStats();
})
`;
