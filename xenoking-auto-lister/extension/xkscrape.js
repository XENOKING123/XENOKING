// ---------------------------------------------------------------------------
// XENOKING universal scraper.
//  (1) Per-car "⚡ XENOKING" button on inventory LIST pages (outside each car).
//  (2) Floating button on a single vehicle page.
//  (3) Bulk crawl (xkScrapeAll): read every car across all pages into the tool.
// Reads JSON-LD Vehicle data when present (Cars.com/AutoTrader/Dealer.com), and
// falls back to a DOM "Label : Value" reader for plain dealer sites like FM Auto
// (VIN / Mileage / Body Type / Exterior Color / Engine / Trim ...). Never
// throws into the host page.
// ---------------------------------------------------------------------------
(function () {
  'use strict';
  if (window.top !== window) return;
  // The panel proactively re-injects this file via chrome.scripting.executeScript to close a
  // race with document_idle content-script timing; guard against double init on the same page.
  if (window.__xkScrapeInit) return;
  window.__xkScrapeInit = true;
  var host = location.hostname || '';
  var onBadHost = /facebook\.com|listcentral|onrender\.com/.test(host);
  // vAuto Provision: we answer data requests here but never draw the on-page buttons.
  var onVauto = /vauto\.app\.coxautoinc\.com$|(^|\.)vauto\.com$/i.test(host);

  // ---- primitives ---------------------------------------------------------
  // Whole-number parser that survives "$5,000.00" / "192,577" / 37756 / 5000.5 (decimals are NOT digits to keep).
  var num = function (s) {
    if (typeof s === 'number') return Number.isFinite(s) ? Math.round(s) : 0;
    var t = String(s == null ? '' : s).replace(/[^\d.]/g, ''), i = t.indexOf('.');
    if (i >= 0) t = t.slice(0, i);
    var n = parseInt(t, 10); return Number.isFinite(n) ? n : 0;
  };
  var txt = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
  var first = function (o, keys) { for (var i = 0; i < keys.length; i++) { if (o && o[keys[i]] != null && o[keys[i]] !== '') return o[keys[i]]; } };
  var deref = function (v) { return v && typeof v === 'object' ? (v.name || v.value || v.url || v['@value'] || '') : v; };
  var abs = function (href, base) { try { return new URL(href, base || location.href).href; } catch (e) { return null; } };
  var typeStr = function (t) { return [].concat(t || '').join(' ').toLowerCase(); };
  var VIN17 = /\b[A-HJ-NPR-Z0-9]{17}\b/;

  // ---- JSON-LD path -------------------------------------------------------
  function ldNodes(doc) {
    var out = [], els = doc.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < els.length; i++) { try { var d = JSON.parse(els[i].textContent); var arr = Array.isArray(d) ? d : [d]; for (var j = 0; j < arr.length; j++) { var n = arr[j]; if (n && n['@graph']) out = out.concat(n['@graph']); else out.push(n); } } catch (e) {} }
    return out;
  }
  function isVehicleNode(n) { if (!n || typeof n !== 'object') return false; var t = typeStr(n['@type']); return /vehicle|car|motorcycle/.test(t) || (/product/.test(t) && (n.vehicleIdentificationNumber || n.mileageFromOdometer || n.model)); }
  function vehicleNodes(doc) { var out = []; ldNodes(doc).forEach(function (n) { if (isVehicleNode(n)) out.push(n); if (n && n.itemListElement) [].concat(n.itemListElement).forEach(function (it) { var item = it && (it.item || it); if (isVehicleNode(item)) out.push(item); }); }); return out; }
  function metaFrom(doc, sel) { var e = doc.querySelector(sel); return e ? (e.getAttribute('content') || '') : ''; }
  // Drop badges/logos/svg and keep only real photo files.
  function cleanImgs(urls) {
    var seen = {}, out = [];
    for (var i = 0; i < urls.length && out.length < 20; i++) {
      var u = urls[i];
      if (!u || typeof u !== 'string' || !/^https?:/.test(u)) continue;
      u = u.split('?')[0];
      if (/\.svg$|\.gif$/i.test(u)) continue;
      if (/logo|sprite|icon|placeholder|carfax|badge|dealer-?logo|window-?sticker|monroney|1owner|spinner|loading/i.test(u)) continue;
      if (!seen[u]) { seen[u] = 1; out.push(u); }
    }
    return out;
  }
  function imagesFromLd(node, doc) {
    var urls = [];
    if (node && node.image) [].concat(node.image).forEach(function (u) { u = deref(u); if (u) urls.push(u); });
    if (doc) doc.querySelectorAll('meta[property="og:image"]').forEach(function (m) { urls.push(m.getAttribute('content')); });
    return cleanImgs(urls);
  }
  function dedupe(urls) { return cleanImgs(urls); }

  function shape(o) {
    // Normalize a partial car into the Facebook-catalog shape the poster wants.
    var year = txt(o.year), make = txt(o.make), model = txt(o.model), trim = txt(o.trim);
    var priceNum = num(o.price);
    var images = dedupe(o.images || []);
    var title = [year, make, model, trim].filter(Boolean).join(' ') || txt(o.title);
    return {
      Title: title, Year: year, Make: make, Model: model, Trim: trim, VIN: txt(o.vin).toUpperCase(),
      Price: priceNum ? (priceNum + ' USD') : '', MileageValue: num(o.mileage) || 0, 'Mileage Unit': 'MI',
      ImageUrls: images, ExteriorColor: txt(o.extColor), InteriorColor: txt(o.intColor),
      BodyStyle: txt(o.body), Drivetrain: txt(o.drive), engine: txt(o.engine), fuel_type: txt(o.fuel),
      stock_number: txt(o.stock), StateofVehicle: /new/i.test(o.state || '') ? 'NEW' : 'USED',
      vehicle_type: txt(o.body), Description: '', Button: 'Post',
      firstImage: images[0] || '', _xkImageCount: images.length,
    };
  }
  function fromLd(node, doc) {
    var v = node || {}, offers = [].concat(v.offers || {})[0] || {};
    return shape({
      year: first(v, ['modelDate', 'vehicleModelDate', 'productionDate']) || (String(v.name || '').match(/\b(19|20)\d\d\b/) || [])[0],
      make: deref(v.brand) || first(v, ['manufacturer']), model: deref(v.model), trim: first(v, ['vehicleConfiguration', 'trim']),
      vin: first(v, ['vehicleIdentificationNumber', 'vin']),
      price: first(offers, ['price', 'lowPrice']) || first(v, ['price']) || (doc && metaFrom(doc, 'meta[property="product:price:amount"]')),
      mileage: deref(v.mileageFromOdometer) || first(v, ['mileage']),
      extColor: first(v, ['color']), intColor: first(v, ['vehicleInteriorColor']), body: first(v, ['bodyType']),
      drive: deref(v.driveWheelConfiguration), engine: deref(v.vehicleEngine), fuel: first(v, ['fuelType']),
      stock: first(v, ['sku', 'mpn', 'productID']),
      state: /newcondition/.test(String(first(offers, ['itemCondition']) || first(v, ['itemCondition']) || '').toLowerCase()) ? 'new' : 'used',
      title: v.name || (doc && metaFrom(doc, 'meta[property="og:title"]')),
      images: imagesFromLd(v, doc),
    });
  }

  // ---- DOM "Label : Value" path (FM Auto and similar) ---------------------
  function grabText(text, labels) {
    for (var i = 0; i < labels.length; i++) {
      var re = new RegExp(labels[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-]\\s*([^\\n\\r|]+)', 'i');
      var m = text.match(re); if (m && m[1].trim()) return m[1].trim();
    }
    return '';
  }
  function grabDom(el, labels) {
    var nodes = el.querySelectorAll('th,td,dt,dd,span,div,li,strong,b,label,p');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].childElementCount) continue;                    // leaf only
      var clean = (nodes[i].textContent || '').replace(/[:\-\s]+$/, '').trim().toLowerCase();
      for (var j = 0; j < labels.length; j++) {
        if (clean === labels[j].toLowerCase()) {
          var sib = nodes[i].nextElementSibling;
          if (sib && (sib.textContent || '').trim()) return (sib.textContent || '').trim();
          var par = nodes[i].parentElement;
          if (par) { var pv = (par.textContent || '').replace(nodes[i].textContent, '').replace(/^[:\-\s]+/, '').trim(); if (pv) return pv; }
        }
      }
    }
    return '';
  }
  function grab(el, text, labels) { return grabText(text, labels) || grabDom(el, labels); }

  function fromCard(el) {
    var text = (el.innerText || el.textContent || '');
    var vin = (text.match(VIN17) || [''])[0].toUpperCase();
    // Title = a "YYYY Make Model" heading, else scanned from text.
    var title = '';
    var heads = el.querySelectorAll('h1,h2,h3,h4,a,strong,b');
    for (var i = 0; i < heads.length; i++) { var s = (heads[i].innerText || heads[i].textContent || '').trim(); if (/^(19|20)\d\d\s+\S/.test(s) && s.length < 80) { title = s; break; } }
    if (!title) { var tm = text.match(/\b(19|20)\d\d\s+[A-Za-z][\w-]*(?:\s+[\w\/-]+){0,4}/); title = tm ? tm[0].trim() : ''; }
    // Price = first "$1,000+" that isn't a monthly payment.
    var price = 0;
    var pm = text.replace(/\$[\d,]+\s*(?:\/\s*mo\w*|per\s*mo\w*|month)/gi, '').match(/\$\s?([\d]{1,3}(?:,\d{3})+|\d{4,7})/);
    if (pm) price = num(pm[0]);
    var year = (title.match(/\b(19|20)\d\d\b/) || [''])[0] || grab(el, text, ['Year']);
    var rest = title.replace(/\b(19|20)\d\d\b/, '').trim().split(/\s+/).filter(Boolean);
    var make = grab(el, text, ['Make']) || rest[0] || '';
    var model = grab(el, text, ['Model']) || rest.slice(1, 4).join(' ') || '';
    var imgs = [];
    el.querySelectorAll('img').forEach(function (im) { var s = im.currentSrc || im.getAttribute('data-src') || im.src || ''; if (/^https?:/.test(s) && !/logo|sprite|icon|placeholder|carfax|badge/i.test(s)) imgs.push(s.split('?')[0]); });
    var bodyRaw = grab(el, text, ['Body/Seating', 'Body Type', 'Body Style', 'Body Seating', 'Body']);
    return shape({
      year: year, make: make, model: model, trim: grab(el, text, ['Trim']), vin: vin, price: price,
      mileage: grab(el, text, ['Odometer', 'Mileage', 'Miles']),
      extColor: grab(el, text, ['Exterior Color', 'Ext Color', 'Exterior Colour']),
      intColor: grab(el, text, ['Interior Color', 'Int Color', 'Interior Colour']),
      body: bodyRaw, drive: grab(el, text, ['Drivetrain', 'Drive Type', 'Drive Line', 'Drive']),
      engine: grab(el, text, ['Engine']), fuel: grab(el, text, ['Fuel Type', 'Fuel']),
      stock: grab(el, text, ['Stock Number', 'Stock #', 'Stock', 'Stock No']),
      state: /new/i.test(grab(el, text, ['Condition', 'Type']) || (/\/new\//.test(location.pathname) ? 'new' : '')) ? 'new' : 'used',
      title: title, images: dedupe(imgs),
    });
  }

  // Find self-contained car cards on a page (smallest container per VIN).
  function findCards(doc) {
    var byVin = {}, all = doc.querySelectorAll('div,li,article,tr,section,form');
    for (var i = 0; i < all.length; i++) {
      var el = all[i], t = el.textContent || '';
      if (t.length > 7000) continue;
      var m = t.match(VIN17); if (!m) continue;
      var vin = m[0].toUpperCase();
      if (!byVin[vin] || t.length < byVin[vin].len) byVin[vin] = { el: el, len: t.length, vin: vin };
    }
    return Object.keys(byVin).map(function (k) { return byVin[k]; });
  }

  // Best single-car read: MERGE JSON-LD (good for make/model/year/price/VIN)
  // with the DOM "overview" table (authoritative for mileage, body, colors,
  // drivetrain, engine, stock on dealer VDPs like Corwin/Dealer.com).
  function scrapeSingle() {
    var nodes = vehicleNodes(document);
    var base = nodes.length ? fromLd(nodes[0], document) : null;
    var dom = fromCard(document.body);
    if (!base) return dom;
    // DOM wins for the spec table fields when it has a value.
    ['MileageValue', 'BodyStyle', 'ExteriorColor', 'InteriorColor', 'Drivetrain', 'engine', 'stock_number', 'vehicle_type'].forEach(function (k) {
      if (dom[k] && dom[k] !== 0 && dom[k] !== '') base[k] = dom[k];
    });
    // Mileage: always trust the odometer the DOM read if it's a real number.
    if (dom.MileageValue > 0) base.MileageValue = dom.MileageValue;
    // Identity fields: fill from DOM only if JSON-LD was blank.
    ['Title', 'Make', 'Model', 'Year', 'Trim', 'VIN', 'Price'].forEach(function (k) {
      if ((!base[k] || base[k] === '') && dom[k]) base[k] = dom[k];
    });
    // Take whichever source found more real photos.
    if ((dom.ImageUrls || []).length > (base.ImageUrls || []).length) base.ImageUrls = dom.ImageUrls;
    base.firstImage = (base.ImageUrls || [])[0] || '';
    base._xkImageCount = (base.ImageUrls || []).length;
    return base;
  }

  // ---- bulk crawl ---------------------------------------------------------
  function findNext(doc, baseUrl) {
    var a = doc.querySelector('a[rel="next"], link[rel="next"]');
    if (a && a.getAttribute('href')) return abs(a.getAttribute('href'), baseUrl);
    var cand = Array.from(doc.querySelectorAll('a[href]')).find(function (x) {
      var t = (x.textContent || '').trim().toLowerCase(), al = (x.getAttribute('aria-label') || '').toLowerCase(), rel = (x.getAttribute('rel') || '').toLowerCase();
      return /(^|\s)next(\s|$|\b)/.test(t) || t === '›' || t === '»' || t.indexOf('»') >= 0 || t.indexOf('›') >= 0 || /next/.test(al) || /next/.test(rel);
    });
    return cand ? abs(cand.getAttribute('href'), baseUrl) : null;
  }
  async function xkScrapeAll(opts) {
    opts = opts || {};
    var maxPages = opts.maxPages || 30, maxCars = opts.maxCars || 500;
    var seen = {}, cars = [];
    var pushCar = function (c) { if (c && c.VIN && VIN17.test(c.VIN) && !seen[c.VIN] && cars.length < maxCars) { seen[c.VIN] = 1; cars.push(c); } };
    var progress = function () { try { chrome.runtime.sendMessage({ message: 'xkScrapeProgress', count: cars.length }); } catch (e) {} };
    var absorb = function (doc) {
      var nodes = vehicleNodes(doc);
      if (nodes.length >= 2) { nodes.forEach(function (n) { pushCar(fromLd(n, null)); }); }
      else { findCards(doc).forEach(function (c) { pushCar(fromCard(c.el)); }); if (nodes.length === 1) pushCar(fromLd(nodes[0], doc)); }
    };
    var doc = document, url = location.href, pages = 0, visited = {};
    while (doc && pages < maxPages) {
      pages++; absorb(doc); progress();
      var next = findNext(doc, url); visited[url.split('#')[0]] = 1;
      if (!next || visited[next.split('#')[0]]) break;
      url = next;
      try { var html = await (await fetch(url, { credentials: 'include' })).text(); doc = new DOMParser().parseFromString(html, 'text/html'); }
      catch (e) { break; }
    }
    if (cars.length) await chrome.storage.local.set({ vehiclesData: cars });
    return { ok: true, count: cars.length, pages: pages };
  }

  // ---- LIVE crawl (for JS-rendered sites like dealer.com / Corwin) ---------
  // Auto-scrolls the real page so lazy-loaded cars appear, scrapes the live DOM,
  // then navigates the real "next" page and repeats — accumulating into storage.
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function xkClickLoadMore() {
    var hit = false;
    Array.from(document.querySelectorAll('button,a,[role="button"]')).forEach(function (b) {
      if (hit || !(b instanceof HTMLElement) || b.offsetParent === null) return;
      var t = (b.textContent || '').trim().toLowerCase();
      if (t.length < 30 && /(load|show|view|see)\s+(more|all)|more (vehicles|results|inventory)/.test(t)) {
        try { b.click(); hit = true; } catch (e) {}
      }
    });
    return hit;
  }
  async function xkAutoScroll() {
    // Count cards; keep scrolling / clicking "load more" until the count stops growing.
    var lastCount = -1, stable = 0;
    var containers = Array.from(document.querySelectorAll('*')).filter(function (el) {
      try { var cs = getComputedStyle(el); return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 200; } catch (e) { return false; }
    }).slice(0, 4);
    for (var i = 0; i < 80; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      containers.forEach(function (el) { try { el.scrollTop = el.scrollHeight; } catch (e) {} });
      xkClickLoadMore();
      await sleep(500);
      var count = findCards(document).length;
      if (count === lastCount) { if (++stable >= 3) break; } else stable = 0;
      lastCount = count;
    }
    window.scrollTo(0, 0); await sleep(250);
  }
  function xkScrapeLive() {
    var out = [], nodes = vehicleNodes(document);
    if (nodes.length >= 2) nodes.forEach(function (n) { out.push(fromLd(n, null)); });
    findCards(document).forEach(function (c) { out.push(fromCard(c.el)); });
    return out;
  }
  async function xkMergeCars(list) {
    var st = await chrome.storage.local.get('vehiclesData');
    var have = Array.isArray(st.vehiclesData) ? st.vehiclesData : [];
    var seen = {}; have.forEach(function (c) { if (c && c.VIN) seen[c.VIN] = 1; });
    var added = 0;
    list.forEach(function (c) { if (c && c.VIN && VIN17.test(c.VIN) && !seen[c.VIN]) { seen[c.VIN] = 1; have.push(c); added++; } });
    await chrome.storage.local.set({ vehiclesData: have });
    return { total: have.length, added: added };
  }
  async function xkLiveCrawlStep() {
    await xkAutoScroll();
    var m = await xkMergeCars(xkScrapeLive());
    var stw = await chrome.storage.local.get('xk_crawl');
    var stt = (stw && stw.xk_crawl) || {};
    var pages = (stt.pages || 0) + 1;
    var visited = Array.isArray(stt.visited) ? stt.visited : [];
    var here = location.href.split('#')[0];
    var next = findNext(document, location.href);
    var nextKey = next ? next.split('#')[0] : null;
    if (next && nextKey !== here && visited.indexOf(nextKey) === -1 && pages < 40) {
      visited.push(here);
      await chrome.storage.local.set({ xk_crawl: { active: 1, pages: pages, total: m.total, visited: visited } });
      toast('✅ ' + m.total + ' cars so far — loading next page…', true);
      await sleep(400); location.href = next; return { navigating: true, total: m.total };
    }
    await chrome.storage.local.remove('xk_crawl');
    try { chrome.runtime.sendMessage({ message: 'xkShowVehicles' }); } catch (e) {}
    return { navigating: false, total: m.total, pages: pages };
  }

  // ---- vAuto Provision (Public Wholesale build) ----------------------------
  // Runs INSIDE the logged-in vAuto tab (same-origin: cookies + Referer are
  // right automatically), pulls the Vehicle Inventory grid data page by page,
  // and maps each row into the poster's record shape. The response format is
  // not documented, so field lookup is defensive: case-insensitive aliases,
  // one level of nesting, HTML stripped, and a raw sample row is returned so
  // the mapping can be tuned from a real response.
  var VAUTO_PATH = '/Va/Inventory/InventoryData.ashx';
  function pick1(o, keys) {
    if (!o || typeof o !== 'object') return undefined;
    var lower = {}; Object.keys(o).forEach(function (k) { lower[k.toLowerCase()] = k; });
    for (var i = 0; i < keys.length; i++) { var k = lower[keys[i].toLowerCase()]; if (k != null && o[k] != null && o[k] !== '') return o[k]; }
    return undefined;
  }
  function pick(o, keys) {
    var v = pick1(o, keys); if (v != null) return v;
    if (!o || typeof o !== 'object') return undefined;
    var subs = Object.keys(o).filter(function (k) { return o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]); });
    for (var s = 0; s < subs.length; s++) { var w = pick1(o[subs[s]], keys); if (w != null) return w; }
    return undefined;
  }
  function strip(s) {
    return txt(String(s == null ? '' : s).replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); }).replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&amp;/g, '&'));
  }
  function parseLoose(text) {
    var t = String(text || '').trim().replace(/^\)\]\}',?\s*/, '').replace(/^for\s*\(;;\);\s*/, '').replace(/^while\s*\(1\);\s*/, '');
    // vAuto's grid payload is not strict JSON: date columns are JavaScript literals like new Date(1700000000000).
    t = t.replace(/new\s+Date\(\s*(-?\d+)\s*\)/g, '$1').replace(/new\s+Date\([^)]*\)/g, 'null').replace(/([\[,:]\s*)(?:undefined|NaN)(?=\s*[,\]}])/g, '$1null');
    try { return JSON.parse(t); } catch (e) {}
    var a = t.indexOf('['), b = t.indexOf('{'), i = a < 0 ? b : (b < 0 ? a : Math.min(a, b));
    if (i > 0) { try { return JSON.parse(t.slice(i)); } catch (e2) {} }
    return null;
  }
  var ROW_KEYS = ['Vin', 'VIN', 'VehicleVin', 'VinNumber', 'StockNumber', 'Stock', 'StockNo'];
  var CAR_KEYS = ['Make', 'Model', 'Odometer', 'ModelYear', 'Year', 'VehicleTitle', 'ListPrice'];
  // For text fallbacks: a real VIN has both letters and digits (a 17-digit numeric id is not a VIN).
  var VIN_STRICT = /\b(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])(?=[A-HJ-NPR-Z0-9]*\d)[A-HJ-NPR-Z0-9]{17}\b/;
  // A "row" is an object that carries a VIN/stock key, a typical vehicle key, or a VIN anywhere in its text.
  function rowLike(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
    if (pick1(r, ROW_KEYS) != null || pick1(r, CAR_KEYS) != null) return true;
    try { return VIN_STRICT.test(JSON.stringify(r)); } catch (e) { return false; }
  }
  // First key whose value is a positive number (skips 0 / "N/A" so a later price/odometer alias can win).
  function pickNum(row, keys) {
    for (var i = 0; i < keys.length; i++) { var v = pick(row, [keys[i]]); if (v != null && num(v) > 0) return v; }
    return pick(row, keys);
  }
  function findRows(x, depth) {
    depth = depth || 0; if (x == null || depth > 6) return null;
    if (typeof x === 'string') { if (/^\s*[\[{]/.test(x)) { var p = parseLoose(x); return p ? findRows(p, depth + 1) : null; } return null; }
    if (Array.isArray(x)) {
      if (x.length && x[0] && typeof x[0] === 'object' && x.some(rowLike)) return x;
      for (var i = 0; i < x.length; i++) { var f = findRows(x[i], depth + 1); if (f) return f; }
      return null;
    }
    if (typeof x === 'object') {
      // vAuto's real shape (confirmed from public consumers): {"columns":[names...], "rows":[[values...], ...]}.
      // Rebuild one object per row so the rest of the mapping can work by column name.
      var col = pick1(x, ['columns', 'cols', 'headers']), rws = pick1(x, ['rows', 'data', 'values']);
      if (Array.isArray(col) && col.length && Array.isArray(rws) && rws.length && Array.isArray(rws[0])) {
        var names = col.map(function (c) { return typeof c === 'string' ? c : (c && (c.name || c.Name || c.field || c.key || c.id)) || ''; });
        var objs = rws.map(function (r) { var o = {}; names.forEach(function (nme, i) { if (nme) o[nme] = r[i]; }); return o; });
        if (objs.some(rowLike)) return objs;
      }
      var ks = Object.keys(x), pri = ks.filter(function (k) { return /^(d|data|rows|items|vehicles|records|results|inventory|list|value)$/i.test(k); });
      var order = pri.concat(ks.filter(function (k) { return pri.indexOf(k) < 0; }));
      for (var j = 0; j < order.length; j++) { var g = findRows(x[order[j]], depth + 1); if (g) return g; }
    }
    return null;
  }
  var IMG_KEYS = ['PhotoUrls', 'Photos', 'PhotoList', 'Photo Url List', 'ImageUrls', 'Images', 'ImageList', 'PhotoUrl', 'ImageUrl', 'PrimaryPhotoUrl', 'MainPhotoUrl', 'ThumbnailUrl', 'Photo', 'Image'];
  function imagesOf(row) {
    // Collect from EVERY photo alias (an empty first alias must not hide a populated later one).
    var urls = [];
    IMG_KEYS.forEach(function (k) {
      [].concat(pick(row, [k]) || []).forEach(function (u) {
        if (u && typeof u === 'object') u = u.Url || u.url || u.Href || u.href || u.Src || u.src || u.FullSize || u.Large || '';
        if (typeof u !== 'string') return;
        u.split(/[,;|\n]/).forEach(function (p) {
          p = p.trim();
          if (/^https?:\/\//i.test(p)) urls.push(p); else if (/^\/\//.test(p)) urls.push('https:' + p); else if (/^\//.test(p)) urls.push(location.origin + p);
        });
      });
    });
    return cleanImgs(urls);
  }
  function mapVautoRow(row) {
    var rowStr = ''; try { rowStr = JSON.stringify(row); } catch (e) {}
    var titleish = strip(pick(row, ['YearMakeModelTrim', 'YearMakeModel', 'VehicleDescription', 'VehicleTitle', 'Vehicle', 'Title', 'Description', 'Name']));
    // A combined cell can carry "Stock #: ... VIN: ..." after the name — cut that off before reading year/make/model.
    titleish = titleish.replace(/\s*\b(?:Stock\s*(?:#|No\.?|Number)?|VIN|Odometer|Mileage|Miles|Price|Class|Body|Colou?r|Interior|Exterior)\b\s*[:#].*$/i, '').trim();
    var m = titleish.match(/((?:19|20)\d\d)\s+([A-Za-z][\w-]*)\s+(.+?)\s*$/);
    if (!m) { var m2 = strip(rowStr).match(/\b((?:19|20)\d\d)\s+([A-Z][\w-]*)\s+([^"\\<]{2,60}?)(?=\s{2,}|\s*(?:"|\\|Stock|VIN|$))/); if (m2) m = m2; }
    var year = strip(pick(row, ['Year', 'ModelYear', 'VehicleYear'])) || (m ? m[1] : '');
    var make = strip(pick(row, ['Make', 'MakeName', 'VehicleMake'])) || (m ? m[2] : '');
    var model = strip(pick(row, ['Model', 'ModelName', 'VehicleModel'])) || (m ? m[3] : '');
    var trim = strip(pick(row, ['Trim', 'Series', 'TrimLevel', 'ModelTrim', 'VehicleTrim']));
    // Only drop the trim when the model already ENDS with it as a whole word (title-derived models), never on a substring hit.
    if (trim && model && new RegExp('(^|\\s)' + trim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i').test(model)) trim = '';
    var vin = strip(pick(row, ['Vin', 'VIN', 'VehicleVin', 'VinNumber'])) || (rowStr.match(VIN_STRICT) || [])[0] || '';
    var stock = strip(pick(row, ['StockNumber', 'Stock', 'StockNo', 'StockNum', 'Stock#'])) || (strip(rowStr).match(/Stock\s*(?:No\.?|Number)?"?\s*[:#=]+\s*"?([A-Z0-9-]{3,})/i) || [])[1] || '';
    var newUsed = String(pick(row, ['NewUsed', 'New/Used', 'NewUsedFlag', 'InventoryType', 'VehicleType', 'Type', 'Condition']) || '').toLowerCase();
    var cert = pick(row, ['Certified', 'IsCertified', 'CPO', 'CertifiedPreOwned']);
    var out = shape({
      year: year, make: make, model: model, trim: trim, vin: vin,
      price: pickNum(row, ['ListPrice', 'Price', 'InternetPrice', 'RetailPrice', 'AskingPrice', 'SellingPrice', 'VehiclePrice', 'ListedPrice', 'WebPrice', 'SalePrice']),
      mileage: pickNum(row, ['Odometer', 'Mileage', 'Miles', 'OdometerReading', 'CurrentOdometer']),
      extColor: strip(pick(row, ['ExteriorColor', 'ExtColor', 'ColorExterior', 'ExteriorColorName', 'Colour', 'ExteriorColour', 'Color'])),
      intColor: strip(pick(row, ['InteriorColor', 'IntColor', 'ColorInterior', 'InteriorColorName', 'InteriorColour'])),
      body: strip(pick(row, ['Body', 'BodyStyle', 'BodyType', 'BodyStyleDesc', 'VehicleClass', 'Class'])),
      drive: strip(pick(row, ['Drivetrain', 'DriveTrain', 'DrivetrainDesc', 'Drivetrain Desc', 'DriveType', 'Drive'])),
      engine: strip(pick(row, ['Engine', 'EngineDescription', 'EngineDesc'])),
      fuel: strip(pick(row, ['FuelType', 'Fuel'])),
      stock: stock,
      state: /^(n|new)$/.test(newUsed.trim()) ? 'new' : 'used',
      title: titleish,
      images: imagesOf(row),
    });
    out.certified = cert === true || /^(true|1|y|yes)$/i.test(String(cert == null ? '' : cert));
    out.Description = strip(pick(row, ['SellerNotes', 'Comments', 'Notes', 'WebDescription', 'InternetDescription', 'Remarks'])) || '';
    out.VehicleId = strip(pick(row, ['VehicleId', 'InventoryId', 'Id', 'ID'])) || out.VIN;
    return out;
  }
  async function xkVautoFetch(opts) {
    opts = opts || {};
    if (!onVauto) return { ok: false, error: 'Open vAuto Provision (provision.vauto.app.coxautoinc.com), log in, then try again.' };
    var pageSize = opts.pageSize || 500, maxTotal = opts.maxTotal || 3000, newUsed = opts.newUsed == null ? 'U' : String(opts.newUsed);
    var rowsAll = [], firstRec = 0, sample = null, sampleKeys = [], total = null, pages = 0, firstHead = '', topLevelKeys = [];
    while (firstRec < maxTotal && pages < 20) {
      pages++;
      var body = ['_pageSize=' + pageSize, '_sortBy=' + encodeURIComponent(opts.sortBy || 'DaysInInventory ASC'), '_firstRecord=' + firstRec,
        'InventoryStatus=' + (opts.inventoryStatus == null ? 0 : opts.inventoryStatus), 'Historical=0', 'NewUsed=' + encodeURIComponent(newUsed),
        'HqTranferEntityNotSame=false', 'SalePending=', 'PricingTargetSetId=', 'RankingBucket=', 'gridSrcName=inventoryDetail', 'switchReport='].join('&');
      var resp;
      try { resp = await fetch(VAUTO_PATH, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' }, body: body }) }
      catch (netErr) { return { ok: false, error: 'The request to vAuto itself failed (' + (netErr && netErr.message || netErr) + '). This can mean the page blocked it (CSP) or there is a network/proxy issue — reload the vAuto tab and try again.' } }
      var text = await resp.text();
      var head = text.slice(0, 4000);
      if (1 === pages) firstHead = head;
      if (resp.status === 401 || resp.status === 403 || (/<html/i.test(head) && /login|sign[- ]?in|password/i.test(head))) return { ok: false, error: 'vAuto says you are not logged in. Log into vAuto in this tab, then click Load Vehicles again.' };
      if (!resp.ok) return { ok: false, error: 'vAuto returned HTTP ' + resp.status + ' — ' + head.replace(/\s+/g, ' ').slice(0, 220) };
      var data = parseLoose(text);
      if (!data) return { ok: false, error: 'vAuto sent something that is not JSON (starts with: ' + head.replace(/\s+/g, ' ').slice(0, 220) + ')' };
      if (1 === pages && data && typeof data === 'object') try { topLevelKeys = Array.isArray(data) ? ['(array of ' + data.length + ')'] : Object.keys(data) } catch (e) {}
      var rows = findRows(data) || [];
      if (total == null && data && typeof data === 'object' && !Array.isArray(data)) { var tv = pick(data, ['TotalRecords', 'TotalCount', 'RecordCount', 'Total', 'Count']); total = (tv != null && isFinite(+tv)) ? +tv : null; }
      if (!sample && rows.length) { sample = rows[0]; sampleKeys = Object.keys(rows[0]); try { console.log('[XK vAuto] first raw row:', rows[0]); console.log('[XK vAuto] row keys:', sampleKeys.join(', ')); } catch (e) {} }
      rowsAll = rowsAll.concat(rows);
      try { chrome.runtime.sendMessage({ message: 'xkVautoProgress', count: rowsAll.length, total: total }); } catch (e) {}
      if (rows.length < pageSize) break;
      if (total != null && rowsAll.length >= total) break;
      firstRec += pageSize;
      await sleep(250);
    }
    var seen = {}, cars = [];
    rowsAll.forEach(function (r) { var c = mapVautoRow(r); if (c && c.VIN && VIN17.test(c.VIN) && !seen[c.VIN]) { seen[c.VIN] = 1; cars.push(c); } });
    if (!rowsAll.length) try { console.log('[XK vAuto] no rows found — top-level response keys:', topLevelKeys, 'first bytes:', firstHead.slice(0, 500)) } catch (e) {}
    return { ok: true, count: cars.length, rawCount: rowsAll.length, total: total, pages: pages, skipped: rowsAll.length - cars.length,
      firstHead: firstHead, topLevelKeys: topLevelKeys,
      noPhotos: cars.filter(function (c) { return !c.ImageUrls.length; }).length, sampleKeys: sampleKeys, sample: sample, vehicles: cars };
  }

  if (!onBadHost) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.message === 'xkScrapeAll') { xkScrapeAll(msg.opts || {}).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }); return true; }
      if (msg && msg.message === 'xkVautoFetch') { xkVautoFetch(msg.opts || {}).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }); return true; }
    });
  }
  if (onBadHost) return;
  if (onVauto) return;

  // Resume a multi-page crawl after each real page navigation.
  (async function () {
    try {
      var cs = await chrome.storage.local.get('xk_crawl');
      if (cs && cs.xk_crawl && cs.xk_crawl.active) {
        toast('⏳ XENOKING loading all pages… ' + (cs.xk_crawl.total || 0) + ' cars so far', true);
        await sleep(2500);
        var r = await xkLiveCrawlStep();
        if (!r.navigating) toast('✅ Done — ' + r.total + ' cars loaded. Open the XENOKING side panel.', true);
      }
    } catch (e) {}
  })();

  // ---- posting + UI -------------------------------------------------------
  async function postCar(car) {
    var pref = await chrome.storage.local.get('xkBgPost');
    // Scraped cars are always cars — make sure the FB vehicle type isn't "Other".
    await chrome.storage.local.set({ insertableVehicleData: car, vehiclesData: [car], vehicleCategory: JSON.stringify('Car/Truck') });
    chrome.runtime.sendMessage({ message: 'postToFacebook', vehicle: car, newTab: false !== pref.xkBgPost });
    try {
      var nm = await chrome.storage.local.get('salesManName'), lg = await chrome.storage.local.get('xk_postlog');
      var arr = Array.isArray(lg.xk_postlog) ? lg.xk_postlog : [];
      arr.push({ vin: car.VIN, title: car.Title, price: car.Price, name: (nm.salesManName || '').replace(/"/g, '').trim() || 'Unknown', ts: Date.now() });
      await chrome.storage.local.set({ xk_postlog: arr.slice(-5000) });
    } catch (e) {}
  }
  function toast(msg, ok) {
    var t = document.createElement('div'); t.textContent = msg;
    t.setAttribute('style', ['position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647', 'max-width:300px', 'padding:11px 15px', 'border-radius:10px', 'font:600 13px system-ui,sans-serif', 'color:#fff', 'background:' + (ok ? '#16a34a' : '#dc2626'), 'box-shadow:0 6px 24px rgba(0,0,0,.4)'].join(';'));
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, ok ? 4000 : 6000);
  }
  var BTN = 'border:none;border-radius:999px;cursor:pointer;color:#fff;font:600 13px system-ui,sans-serif;background:linear-gradient(135deg,#25e6ff 0%,#2563eb 45%,#8b5cf6 100%);box-shadow:0 4px 16px rgba(37,99,235,.5)';

  var cards = findCards(document);
  if (cards.length >= 2) {
    // LIST PAGE: a ⚡ button on every car card + a floating "Load all" panel.
    cards.forEach(function (c) {
      if (c.el.querySelector('.xk-card-btn')) return;
      var b = document.createElement('button');
      b.className = 'xk-card-btn'; b.type = 'button'; b.textContent = '⚡ Post to XENOKING';
      b.setAttribute('style', BTN + ';position:absolute;top:8px;right:8px;z-index:2147483647;padding:7px 12px');
      try { var cs = getComputedStyle(c.el); if (cs.position === 'static') c.el.style.position = 'relative'; } catch (e) {}
      b.onclick = async function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        b.disabled = true; var o = b.textContent; b.textContent = '⏳…';
        try { var car = fromCard(c.el); if (!car.VIN && !car.Make) { toast("Couldn't read this car.", false); return; } await postCar(car); toast('🚀 ' + (car.Title || car.VIN) + ' → Facebook (' + car._xkImageCount + ' photos)', true); }
        catch (e) { toast('Failed: ' + (e && e.message || e), false); }
        finally { b.disabled = false; b.textContent = o; }
      };
      c.el.appendChild(b);
    });
    var panel = document.createElement('button');
    panel.id = 'xk-scrape-fab'; panel.type = 'button';
    panel.textContent = '📥 Load ALL cars (all pages) into XENOKING';
    panel.setAttribute('style', BTN + ';position:fixed;right:18px;top:50%;transform:translateY(-50%);z-index:2147483647;padding:12px 16px;font-size:14px;max-width:190px;text-align:center;line-height:1.25');
    panel.onclick = async function () {
      panel.disabled = true; var o = panel.textContent; panel.textContent = '⏳ Loading this page & all next pages…';
      try {
        // Reset any old crawl and start fresh from this page.
        await chrome.storage.local.remove('xk_crawl');
        var r = await xkLiveCrawlStep();
        if (r.navigating) panel.textContent = '⏳ ' + r.total + ' so far — going through pages…';
        else { toast('✅ Loaded ' + r.total + ' cars. Open the XENOKING side panel → select & post.', true); panel.textContent = '✅ Loaded ' + r.total + ' — open XENOKING'; panel.disabled = false; }
      } catch (e) { toast('Load failed: ' + (e && e.message || e), false); panel.textContent = o; panel.disabled = false; }
    };
    if (document.body) document.body.appendChild(panel);
    return;
  }

  // SINGLE CAR PAGE: floating post button.
  if (document.getElementById('xk-scrape-fab')) return;
  var single = findCards(document).length === 1 || vehicleNodes(document).length || /\/(vehicle|inventory|vehicledetails|vdp|used|new|cars?)\/.+/i.test(location.pathname);
  if (!single) return;
  var fab = document.createElement('button');
  fab.id = 'xk-scrape-fab'; fab.type = 'button'; fab.innerHTML = '⚡ Post to XENOKING';
  fab.setAttribute('style', BTN + ';position:fixed;right:18px;top:50%;transform:translateY(-50%);z-index:2147483647;padding:11px 16px;font-size:14px;display:flex;align-items:center;gap:7px');
  fab.onclick = async function () {
    fab.disabled = true; var o = fab.innerHTML; fab.innerHTML = '⏳ Reading car…';
    try { var car = scrapeSingle(); if (!car.VIN && !car.Make) { toast("Couldn't read this page as a vehicle.", false); return; } await postCar(car); toast('🚀 ' + (car.Title || car.VIN) + ' → Facebook (' + car._xkImageCount + ' photos)', true); }
    catch (e) { console.error('[XENOKING scrape]', e); toast('Failed: ' + (e && e.message || e), false); }
    finally { fab.disabled = false; fab.innerHTML = o; }
  };
  var mount = function () { if (document.body && !document.getElementById('xk-scrape-fab')) document.body.appendChild(fab); };
  mount(); var tries = 0, iv = setInterval(function () { tries++; mount(); if (tries > 20) clearInterval(iv); }, 700);
})();
