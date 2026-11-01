/* Țomapant engine: normalisation, lookup, inflection fallback, scoring.
 * Pure functions, no DOM. Works in the browser (inlined) and in Node (tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TomapantEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CATEGORIES = [
    { id: 'tari', label: 'Țări', icon: '🌍', color: 'c-tari' },
    { id: 'orase', label: 'Orașe', icon: '🏙️', color: 'c-orase' },
    { id: 'munti', label: 'Munți', icon: '⛰️', color: 'c-munti' },
    { id: 'ape', label: 'Ape', icon: '🌊', color: 'c-ape' },
    { id: 'plante', label: 'Plante', icon: '🌿', color: 'c-plante' },
    { id: 'animale', label: 'Animale', icon: '🐾', color: 'c-animale' },
    { id: 'nume', label: 'Nume', icon: '🙂', color: 'c-nume' }
  ];

  /* Generic leading words, stripped only at the start of an answer.
   * Stored as diacritic-free keys so that "raul" and "râul" both match. */
  var GENERIC_SOURCE = {
    tari: ['republica', 'regatul', 'statul', 'principatul', 'ducatul'],
    orase: ['orașul', 'municipiul', 'comuna', 'satul'],
    munti: ['munții', 'muntele', 'masivul', 'vârful', 'vf', 'culmea', 'dealul', 'dealurile'],
    ape: ['râul', 'raul', 'fluviul', 'pârâul', 'lacul', 'marea', 'oceanul', 'golful',
      'strâmtoarea', 'canalul', 'cascada', 'delta', 'balta']
  };

  var DEFAULT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'U', 'V', 'Z'];
  var HARD_LETTERS = ['K', 'Ș', 'Ț'];

  function fixCedilla(s) {
    return s.replace(/ş/g, 'ș').replace(/ţ/g, 'ț').replace(/Ş/g, 'Ș').replace(/Ţ/g, 'Ț');
  }

  /* Step 1 to 3 of the normalisation: cedilla fix, trim, collapse spaces,
   * hyphens to spaces, punctuation removed, lowercase. Diacritics are kept. */
  function normalise(text) {
    if (text == null) return '';
    var s = fixCedilla(String(text)).normalize('NFC');
    s = s.replace(/[‐-―\-_\/]/g, ' ');
    s = s.replace(/[.,'’‘`"“”!?;:()\[\]{}*+<>«»ʻ]/g, '');
    s = s.replace(/\s+/g, ' ').trim().toLowerCase();
    return s;
  }

  /* Step 4: lookup key. Strip diacritics (NFD, remove combining marks), fold a
   * few letters that NFD does not decompose, and remove spaces. */
  function foldKey(s) {
    var k = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    k = k.replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o')
      .replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ð/g, 'd').replace(/þ/g, 'th').replace(/ı/g, 'i');
    return k.replace(/[^a-z0-9]/g, '');
  }

  var GENERIC = {};
  Object.keys(GENERIC_SOURCE).forEach(function (cat) {
    GENERIC[cat] = {};
    GENERIC_SOURCE[cat].forEach(function (w) { GENERIC[cat][foldKey(w)] = true; });
  });

  /* Remove generic leading words (repeatedly) from an already normalised string. */
  function stripGeneric(clean, cat) {
    var table = GENERIC[cat];
    if (!table) return clean;
    var words = clean.split(' ');
    while (words.length > 1 && table[foldKey(words[0])]) words.shift();
    return words.join(' ');
  }

  function keyOf(text, cat) {
    return foldKey(stripGeneric(normalise(text), cat));
  }

  /* Fast path used when loading the library: entries are already clean
   * (no punctuation to speak of, single spaces), so only lowercasing,
   * generic-word stripping and diacritic folding are needed. */
  var CHAR_FOLD = {};
  function foldChar(ch) {
    var f = CHAR_FOLD[ch];
    if (f === undefined) { f = foldKey(ch); CHAR_FOLD[ch] = f; }
    return f;
  }
  function entryKey(text, cat) {
    var s = text.toLowerCase();
    var table = GENERIC[cat];
    if (table) {
      var sp = s.indexOf(' ');
      while (sp > 0 && table[foldKey(s.slice(0, sp))]) { s = s.slice(sp + 1); sp = s.indexOf(' '); }
    }
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) out += s[i];
      else if (c > 127) out += foldChar(s[i]);
    }
    return out;
  }

  /* The letter a (normalised, generic-stripped) text starts with. Ă and Â count
   * as A, Î as I. Ș and Ț stay separate letters. Returns an uppercase letter. */
  function firstLetter(stripped) {
    if (!stripped) return '';
    var ch = stripped.charAt(0);
    if (ch === 'ă' || ch === 'â') return 'A';
    if (ch === 'î') return 'I';
    if (ch === 'ș') return 'Ș';
    if (ch === 'ț') return 'Ț';
    var up = ch.toUpperCase();
    var folded = foldKey(ch).toUpperCase();
    return folded || up;
  }

  /* Library: per category a Map from key to { c: canonical, t: matched text }. */
  function buildLibrary(packed) {
    var lib = {};
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    Object.keys(packed).forEach(function (cat) {
      var map = new Map();
      var entries = packed[cat] ? packed[cat].split('|') : [];
      for (var i = 0; i < entries.length; i++) {
        var parts = entries[i].split('=');
        var canonical = parts[0];
        for (var j = 0; j < parts.length; j++) {
          var k = entryKey(parts[j], cat);
          if (k && !map.has(k)) map.set(k, { c: canonical, t: parts[j] });
        }
      }
      lib[cat] = map;
    });
    var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    lib.__buildMs = t1 - t0;
    return lib;
  }

  /* Inflection fallback candidates, applied to the diacritic-free key. */
  function articleCandidates(k) {
    var out = [];
    function add(v) { if (v && v.length >= 2 && out.indexOf(v) < 0) out.push(v); }
    if (/ul$/.test(k)) { add(k.slice(0, -2)); add(k.slice(0, -1)); }
    if (/le$/.test(k)) { add(k.slice(0, -2)); }
    if (/lui$/.test(k)) { add(k.slice(0, -3)); }
    if (/ua$/.test(k)) { add(k.slice(0, -2)); }
    if (/a$/.test(k)) { add(k.slice(0, -1)); }
    return out;
  }

  var PLURAL_RULES = [
    [/uri$/, ''], [/urile$/, ''],
    [/ori$/, 'oare'], [/orile$/, 'oare'],
    [/ese$/, 'easa'], [/esele$/, 'easa'],
    [/ele$/, 'ea'], [/ele$/, 'a'], [/ile$/, 'a'], [/ile$/, 'e'],
    [/ii$/, ''], [/ii$/, 'ie'], [/ii$/, 'iu'],
    [/zi$/, 'd'], [/sti$/, 'ste'], [/ste$/, 'sca'], [/ere$/, 'ar'],
    [/oi$/, 'oaie'], [/ai$/, 'al'], [/oi$/, 'ou'],
    [/i$/, ''], [/i$/, 'e'], [/i$/, 'a'], [/i$/, 'u'],
    [/e$/, 'a'], [/e$/, '']
  ];

  function pluralCandidates(k) {
    var out = [];
    for (var i = 0; i < PLURAL_RULES.length; i++) {
      var re = PLURAL_RULES[i][0];
      if (re.test(k)) {
        var v = k.replace(re, PLURAL_RULES[i][1]);
        if (v.length >= 2 && out.indexOf(v) < 0) out.push(v);
      }
    }
    return out;
  }

  function fallbackCandidates(k, cat) {
    var cands = [];
    if (cat !== 'nume') cands = cands.concat(articleCandidates(k));
    if (cat === 'plante' || cat === 'animale') {
      cands = cands.concat(pluralCandidates(k));
      // plural of an article form, e.g. "lupii" -> "lupi" -> "lup"
      articleCandidates(k).forEach(function (a) {
        pluralCandidates(a).forEach(function (p) { if (cands.indexOf(p) < 0) cands.push(p); });
      });
    }
    return cands.filter(function (c) { return c !== k; });
  }

  function findEntry(lib, cat, k) {
    var map = lib[cat];
    if (!map) return null;
    if (map.has(k)) return { entry: map.get(k), inflected: false };
    var cands = fallbackCandidates(k, cat);
    for (var i = 0; i < cands.length; i++) {
      if (map.has(cands[i])) return { entry: map.get(cands[i]), inflected: true };
    }
    return null;
  }

  /* Evaluate a single answer before review.
   * accepted: optional lookup function (cat, key) -> true if previously accepted.
   * Returns { status, canonical, key, clean, letter, reason }
   *   status: 'blank' | 'wrongLetter' | 'valid' | 'unknown'
   */
  function evaluate(lib, cat, letter, answer, accepted) {
    var clean = normalise(answer);
    if (!clean) return { status: 'blank', canonical: null, key: '', clean: '', letter: '', reason: 'gol' };
    var stripped = stripGeneric(clean, cat);
    var k = foldKey(stripped);
    var found = findEntry(lib, cat, k);
    var want = letter ? letter.toUpperCase() : '';
    if (found) {
      var matchedText = found.entry.t;
      var matchedLetter = firstLetter(stripGeneric(normalise(matchedText), cat));
      if (want && matchedLetter !== want) {
        return { status: 'wrongLetter', canonical: found.entry.c, key: k, clean: clean, letter: matchedLetter, reason: 'nu începe cu litera ' + want };
      }
      return { status: 'valid', canonical: found.entry.c, key: k, clean: clean, letter: matchedLetter, reason: 'găsit în dicționar', inflected: found.inflected };
    }
    var typedLetter = firstLetter(stripped);
    if (want && typedLetter !== want) {
      return { status: 'wrongLetter', canonical: null, key: k, clean: clean, letter: typedLetter, reason: 'nu începe cu litera ' + want };
    }
    if (accepted && accepted(cat, k)) {
      return { status: 'valid', canonical: '~' + k, key: k, clean: clean, letter: typedLetter, reason: 'acceptat anterior' };
    }
    return { status: 'unknown', canonical: '~' + k, key: k, clean: clean, letter: typedLetter, reason: '' };
  }

  function isValid(answer) { return answer && answer.status === 'valid'; }

  /* Score one category across all players.
   * results: { playerId: evaluation (status, canonical, ...) } after review
   * (an accepted unknown has status 'valid'; a rejected one has status 'rejected').
   * Returns { playerId: points } and marks shared answers.
   */
  function scoreCategory(results) {
    var ids = Object.keys(results);
    var count = {};
    ids.forEach(function (id) {
      var r = results[id];
      if (isValid(r)) count[r.canonical] = (count[r.canonical] || 0) + 1;
    });
    var points = {};
    var shared = {};
    ids.forEach(function (id) {
      var r = results[id];
      if (!isValid(r)) { points[id] = 0; shared[id] = false; return; }
      var n = count[r.canonical];
      points[id] = n > 1 ? 5 : 10;
      shared[id] = n > 1;
    });
    return { points: points, shared: shared };
  }

  /* Score a whole round. answers: { playerId: { cat: evaluation } } */
  function scoreRound(answers) {
    var ids = Object.keys(answers);
    var out = {};
    ids.forEach(function (id) { out[id] = { cells: {}, total: 0 }; });
    CATEGORIES.forEach(function (c) {
      var per = {};
      ids.forEach(function (id) { per[id] = answers[id][c.id] || { status: 'blank' }; });
      var sc = scoreCategory(per);
      ids.forEach(function (id) {
        out[id].cells[c.id] = { points: sc.points[id], shared: sc.shared[id] };
        out[id].total += sc.points[id];
      });
    });
    return out;
  }

  function sumTotals(rounds, playerId) {
    var t = 0;
    for (var i = 0; i < rounds.length; i++) {
      var r = rounds[i];
      if (r && r.scores && r.scores[playerId]) t += r.scores[playerId].total;
    }
    return t;
  }

  /* Letters available for a game. */
  function letterPool(includeHard) {
    return includeHard ? DEFAULT_LETTERS.concat(HARD_LETTERS) : DEFAULT_LETTERS.slice();
  }

  return {
    CATEGORIES: CATEGORIES,
    GENERIC_SOURCE: GENERIC_SOURCE,
    DEFAULT_LETTERS: DEFAULT_LETTERS,
    HARD_LETTERS: HARD_LETTERS,
    fixCedilla: fixCedilla,
    normalise: normalise,
    foldKey: foldKey,
    stripGeneric: stripGeneric,
    keyOf: keyOf,
    entryKey: entryKey,
    firstLetter: firstLetter,
    buildLibrary: buildLibrary,
    fallbackCandidates: fallbackCandidates,
    findEntry: findEntry,
    evaluate: evaluate,
    scoreCategory: scoreCategory,
    scoreRound: scoreRound,
    sumTotals: sumTotals,
    letterPool: letterPool
  };
});
