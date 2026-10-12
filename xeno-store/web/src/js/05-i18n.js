/* XENO STORE — 05-i18n.js: t(key, vars) with {var} interpolation and {n, plural, one{# x} other{# y}}. */
(function () {
  'use strict';
  var XS = window.XS;
  var ALL = window.XS_I18N || {};
  var dicts = {};
  var LANGS = [
    { code: 'en', name: 'English' }, { code: 'ar', name: 'العربية' }, { code: 'de', name: 'Deutsch' }, { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' }, { code: 'it', name: 'Italiano' }, { code: 'ja', name: '日本語' }, { code: 'ko', name: '한국어' },
    { code: 'nl', name: 'Nederlands' }, { code: 'pl', name: 'Polski' }, { code: 'pt-BR', name: 'Português (Brasil)' }, { code: 'ru', name: 'Русский' },
    { code: 'tr', name: 'Türkçe' }, { code: 'zh-CN', name: '简体中文' }
  ];
  var RTL = { ar: true };
  var missing = {};

  function flatten(obj, prefix, out) {
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k], key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object') flatten(v, key, out); else out[key] = String(v);
    }
    return out;
  }
  for (var code in ALL) if (Object.prototype.hasOwnProperty.call(ALL, code)) dicts[code] = flatten(ALL[code], '', {});
  if (!dicts.en) dicts.en = {};

  var i18n = {
    locale: 'en',
    dir: 'ltr',
    languages: LANGS,
    available: function (code) { return !!dicts[code]; },
    /* 'auto' → best match of navigator.language against bundled locales, else en. */
    resolve: function (pref) {
      if (pref && pref !== 'auto') return dicts[pref] ? pref : (dicts[pref.split('-')[0]] ? pref.split('-')[0] : 'en');
      var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
      for (var i = 0; i < langs.length; i++) {
        var l = String(langs[i]);
        if (dicts[l]) return l;
        var base = l.split('-')[0];
        if (dicts[base]) return base;
        for (var c in dicts) if (c.split('-')[0] === base) return c;
      }
      return 'en';
    },
    setLocale: function (pref) {
      var code = i18n.resolve(pref);
      i18n.locale = code;
      i18n.dir = RTL[code.split('-')[0]] ? 'rtl' : 'ltr';
      document.documentElement.lang = code;
      document.documentElement.dir = i18n.dir;
      try { i18n.plural = (typeof Intl !== 'undefined' && Intl.PluralRules) ? new Intl.PluralRules(code) : null; } catch (e) { i18n.plural = null; }
      return code;
    },
    has: function (key) { return (dicts[i18n.locale] && key in dicts[i18n.locale]) || key in dicts.en; },
    t: function (key, vars) {
      var d = dicts[i18n.locale] || dicts.en;
      var s = d[key];
      if (s === undefined) s = dicts.en[key];
      if (s === undefined) {
        if (!missing[key]) { missing[key] = true; console.error('[i18n] missing key: ' + key); }
        return key;
      }
      if (!vars && s.indexOf('{') < 0) return s;
      vars = vars || {};
      /* plural forms first: {n, plural, one{# game} other{# games}} */
      s = s.replace(/\{(\w+),\s*plural,((?:\s*\w+\s*\{[^{}]*\})+)\s*\}/g, function (_, name, forms) {
        var n = Number(vars[name]); if (isNaN(n)) n = 0;
        var cat = i18n.plural ? i18n.plural.select(n) : (n === 1 ? 'one' : 'other');
        var map = {}, re = /(\w+)\s*\{([^{}]*)\}/g, m;
        while ((m = re.exec(forms))) map[m[1]] = m[2];
        var form = map['=' + n] !== undefined ? map['=' + n] : (map[cat] !== undefined ? map[cat] : (map.other || ''));
        return form.replace(/#/g, formatNum(n));
      });
      return s.replace(/\{(\w+)\}/g, function (_, name) { return vars[name] === undefined ? '' : String(vars[name]); });
    },
    langName: function (code) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === code) return LANGS[i].name; return code; },
    missing: function () { return Object.keys(missing); }
  };
  function formatNum(n) { try { return n.toLocaleString(i18n.locale); } catch (e) { return String(n); } }
  i18n.setLocale('auto');
  XS.i18n = i18n;
  XS.t = i18n.t;
})();
