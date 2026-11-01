/* Țomapant application: transport, host game loop, guest mirror, UI. */
(function () {
  'use strict';
  var E = window.TomapantEngine;
  var CATS = E.CATEGORIES;
  var PROTOCOL_VERSION = 1;
  var PEER_PREFIX = 'tomapant-ro-';
  var MAX_PLAYERS = 5;
  var LS_NAME = 'tomapant_nume';
  var LS_ACCEPTED = 'tomapant_cuvinte_acceptate';
  var LS_MUTE = 'tomapant_mut';
  var SS_SESSION = 'tomapant_sesiune';
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var params = new URLSearchParams(location.search);
  var TRANSPORT_KIND = params.get('transport') === 'local' ? 'local' : 'peer';
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function show(node, on) { node.style.display = on ? '' : 'none'; }
  function now() { return Date.now(); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function randomCode() {
    var arr = new Uint32Array(5); crypto.getRandomValues(arr);
    var s = ''; for (var i = 0; i < 5; i++) s += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
    return s;
  }
  function randomIndex(n) { var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function fmtTime(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function catById(id) { for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i]; return null; }
  function joinNames(names) {
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' și ' + names[names.length - 1];
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; show(t, true);
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { show(t, false); }, 2600);
  }

  /* ---------- library ---------- */
  var LIB = E.buildLibrary(window.TOMAPANT_DATA || {});
  window.__tomapantLibraryBuildMs = LIB.__buildMs;

  /* ---------- accepted words (device memory) ---------- */
  var deviceAccepted = {};
  (function loadAccepted() {
    try { var raw = lsGet(LS_ACCEPTED); if (raw) deviceAccepted = JSON.parse(raw) || {}; } catch (e) { deviceAccepted = {}; }
  })();
  function rememberAccepted(cat, key) {
    if (!deviceAccepted[cat]) deviceAccepted[cat] = [];
    if (deviceAccepted[cat].indexOf(key) < 0) { deviceAccepted[cat].push(key); lsSet(LS_ACCEPTED, JSON.stringify(deviceAccepted)); }
  }

  /* ---------- sound, vibration, wake lock ---------- */
  var muted = lsGet(LS_MUTE) === '1';
  var audioCtx = null;
  function tick() {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.08, audioCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
      o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.13);
    } catch (e) { /* no audio */ }
  }
  function vibrate(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* ignore */ } }
  var wakeLock = null;
  function requestWakeLock() {
    try { if (navigator.wakeLock && !wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; l.addEventListener('release', function () { wakeLock = null; }); }).catch(function () { }); } catch (e) { /* ignore */ }
  }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
  function updateMuteButton() { $('btn-mute').textContent = muted ? '🔕' : '🔔'; $('btn-mute').setAttribute('aria-label', muted ? 'Pornește sunetul' : 'Oprește sunetul'); }

  /* ---------- transport layer ----------
   * A transport exposes:
   *   host(code) -> Promise<{ onConnection(fn), close() }>
   *   join(code) -> Promise<conn>
   * A conn exposes: send(obj), onMessage(fn), onClose(fn), close(), open (bool), id
   */
  function makeConn(id, sendImpl, closeImpl) {
    var handlers = { msg: [], close: [] };
    var conn = {
      id: id, open: true,
      send: function (obj) { if (conn.open) { try { sendImpl(obj); } catch (e) { /* dropped */ } } },
      onMessage: function (fn) { handlers.msg.push(fn); },
      onClose: function (fn) { handlers.close.push(fn); },
      _deliver: function (obj) { handlers.msg.forEach(function (fn) { fn(obj); }); },
      _closed: function () { if (!conn.open) return; conn.open = false; handlers.close.forEach(function (fn) { fn(); }); },
      close: function () { try { closeImpl(); } catch (e) { /* ignore */ } conn._closed(); }
    };
    return conn;
  }

  var PeerTransport = {
    _peer: null,
    _errorInfo: function (err) {
      var type = err && err.type;
      if (type === 'peer-unavailable') return { code: 'no-room', message: 'Camera nu există sau gazda nu mai e conectată' };
      if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') return { code: 'offline', message: 'Nu există conexiune la internet sau serverul de conectare nu răspunde.' };
      if (type === 'webrtc' || type === 'disconnected') return { code: 'blocked', message: 'Conexiunea directă între telefoane e blocată de rețea. Încercați amândoi pe Wi-Fi.' };
      if (type === 'browser-incompatible') return { code: 'browser', message: 'Browserul acesta nu suportă conexiuni directe. Încearcă Safari, Chrome sau Firefox.' };
      return { code: 'unknown', message: 'Nu s-a putut face conexiunea. Verifică internetul și încearcă din nou.' };
    },
    _newPeer: function (id) {
      return new window.Peer(id, {
        debug: 0,
        config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] }
      });
    },
    _wrap: function (dc) {
      var conn = makeConn(dc.peer, function (obj) { dc.send(obj); }, function () { dc.close(); });
      dc.on('data', function (d) { conn._deliver(d); });
      dc.on('close', function () { conn._closed(); });
      dc.on('error', function () { conn._closed(); });
      return conn;
    },
    host: function (code) {
      var self = this;
      return new Promise(function (resolve, reject) {
        var peer = self._newPeer(PEER_PREFIX + code.toLowerCase());
        var settled = false;
        var connHandlers = [];
        peer.on('open', function () {
          settled = true; self._peer = peer;
          resolve({
            onConnection: function (fn) { connHandlers.push(fn); },
            close: function () { try { peer.destroy(); } catch (e) { /* ignore */ } self._peer = null; }
          });
        });
        peer.on('connection', function (dc) {
          dc.on('open', function () { var c = self._wrap(dc); connHandlers.forEach(function (fn) { fn(c); }); });
        });
        peer.on('error', function (err) {
          if (!settled) {
            settled = true;
            try { peer.destroy(); } catch (e) { /* ignore */ }
            var info = self._errorInfo(err);
            if (err && err.type === 'unavailable-id') info = { code: 'unavailable-id', message: 'Codul e ocupat' };
            reject(info);
          }
        });
        peer.on('disconnected', function () { try { if (!peer.destroyed) peer.reconnect(); } catch (e) { /* ignore */ } });
      });
    },
    join: function (code) {
      var self = this;
      return new Promise(function (resolve, reject) {
        var peer = self._newPeer(undefined);
        var settled = false;
        var timer = setTimeout(function () { if (!settled) { settled = true; try { peer.destroy(); } catch (e) { /* ignore */ } reject({ code: 'blocked', message: 'Conexiunea directă între telefoane e blocată de rețea. Încercați amândoi pe Wi-Fi.' }); } }, 20000);
        peer.on('open', function () {
          var dc = peer.connect(PEER_PREFIX + code.toLowerCase(), { reliable: true });
          dc.on('open', function () {
            if (settled) return; settled = true; clearTimeout(timer);
            var conn = self._wrap(dc);
            conn.onClose(function () { try { peer.destroy(); } catch (e) { /* ignore */ } });
            resolve(conn);
          });
          dc.on('error', function (err) { if (!settled) { settled = true; clearTimeout(timer); try { peer.destroy(); } catch (e) { /* ignore */ } reject(self._errorInfo(err)); } });
        });
        peer.on('error', function (err) {
          if (!settled) { settled = true; clearTimeout(timer); try { peer.destroy(); } catch (e) { /* ignore */ } reject(self._errorInfo(err)); }
        });
      });
    }
  };

  /* BroadcastChannel transport for automated tests on one machine (?transport=local). */
  var LocalTransport = {
    _chan: function (code) { return new BroadcastChannel('tomapant-local-' + code.toUpperCase()); },
    host: function (code) {
      var self = this;
      return new Promise(function (resolve) {
        var ch = self._chan(code);
        var connHandlers = [];
        var conns = {};
        ch.onmessage = function (ev) {
          var m = ev.data || {};
          if (m.op === 'connect') {
            var gid = m.from;
            var conn = makeConn(gid, function (obj) { ch.postMessage({ op: 'msg', to: gid, data: obj }); }, function () { ch.postMessage({ op: 'close', to: gid }); });
            conns[gid] = conn;
            ch.postMessage({ op: 'accept', to: gid });
            connHandlers.forEach(function (fn) { fn(conn); });
          } else if (m.op === 'msg' && m.to === 'host' && conns[m.from]) {
            conns[m.from]._deliver(m.data);
          } else if (m.op === 'close' && m.to === 'host' && conns[m.from]) {
            conns[m.from]._closed(); delete conns[m.from];
          } else if (m.op === 'probe') {
            ch.postMessage({ op: 'alive' });
          }
        };
        resolve({ onConnection: function (fn) { connHandlers.push(fn); }, close: function () { ch.close(); } });
      });
    },
    join: function (code) {
      var self = this;
      return new Promise(function (resolve, reject) {
        var ch = self._chan(code);
        var gid = 'g' + Math.random().toString(36).slice(2, 10);
        var conn = null;
        var timer = setTimeout(function () { ch.close(); reject({ code: 'no-room', message: 'Camera nu există sau gazda nu mai e conectată' }); }, 1500);
        ch.onmessage = function (ev) {
          var m = ev.data || {};
          if (m.op === 'accept' && m.to === gid) {
            clearTimeout(timer);
            conn = makeConn('host', function (obj) { ch.postMessage({ op: 'msg', from: gid, to: 'host', data: obj }); }, function () { ch.postMessage({ op: 'close', from: gid, to: 'host' }); ch.close(); });
            resolve(conn);
          } else if (conn && m.op === 'msg' && m.to === gid) {
            conn._deliver(m.data);
          } else if (conn && m.op === 'close' && m.to === gid) {
            conn._closed(); ch.close();
          }
        };
        ch.postMessage({ op: 'connect', from: gid });
      });
    }
  };
  var transport = TRANSPORT_KIND === 'local' ? LocalTransport : PeerTransport;

  /* ---------- game state ---------- */
  var me = { name: '', id: null, isHost: false };
  var room = { code: '', server: null, conn: null, conns: {} };
  var state = null;     // full game state (host authoritative, guest mirrored)
  var local = {         // per-device ephemeral
    deadline: 0, closeAt: 0, rtt: 0, finished: false, locked: false, answers: {},
    draftTimer: null, timerInterval: null, lastTickSecond: -1, revealShown: -1,
    reconnectTimer: null, reconnectUntil: 0, sheetTab: null, myReviews: {}, lastRoundShown: -1,
    hostTimers: {}, pingTimer: null, disconnectedSince: {}, closeFallbackTimer: null, finalWaiting: null, reviewAutoTimers: {}
  };

  function freshState(settings) {
    return {
      version: 1, phase: 'lobby', players: [], settings: settings || { roundSeconds: 120, graceSeconds: 10, rounds: 10, hardLetters: false },
      roundIndex: -1, totalRounds: 0, lettersUsed: [], rounds: [], accepted: {}, note: ''
    };
  }

  function currentRound() { return state && state.roundIndex >= 0 ? state.rounds[state.roundIndex] : null; }
  function playerById(id) { if (!state) return null; for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i]; return null; }
  function playerName(id) { var p = playerById(id); return p ? p.name : '?'; }
  function otherPlayers() { return state ? state.players.filter(function (p) { return p.id !== me.id; }) : []; }
  function grandTotal(pid) { return state ? E.sumTotals(state.rounds, pid) : 0; }
  function sessionAccepted(cat, key) {
    if (state && state.accepted[cat] && state.accepted[cat].indexOf(key) >= 0) return true;
    return !!(deviceAccepted[cat] && deviceAccepted[cat].indexOf(key) >= 0);
  }

  /* ---------- persistence (refresh resume) ---------- */
  function saveSession() {
    if (!state) { ssSet(SS_SESSION, null); return; }
    ssSet(SS_SESSION, JSON.stringify({ role: me.isHost ? 'host' : 'guest', code: room.code, name: me.name, playerId: me.id, state: me.isHost ? state : null, answers: local.answers, roundIndex: state.roundIndex }));
  }
  function loadSession() { try { var raw = ssGet(SS_SESSION); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

  /* ---------- messaging ---------- */
  function msg(type, data) { var m = data || {}; m.v = PROTOCOL_VERSION; m.t = type; return m; }
  function sendToHost(type, data) { if (room.conn) room.conn.send(msg(type, data)); }
  function sendTo(pid, type, data) { var c = room.conns[pid]; if (c && c.open) c.send(msg(type, data)); }
  function broadcast(type, data, except) {
    Object.keys(room.conns).forEach(function (pid) { if (pid !== except) sendTo(pid, type, data); });
  }
  function publicState() {
    // Everything guests need. Answers are included only for closed rounds (results are public).
    return state;
  }

  /* ---------- screens ---------- */
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.toggle('active', s.id === 'screen-' + name); });
    window.scrollTo(0, 0);
    if (name === 'round') requestWakeLock(); else releaseWakeLock();
  }
  function setConnBar(text, isError) {
    var b = $('conn-bar');
    if (!text) { show(b, false); return; }
    b.textContent = text; b.classList.toggle('error', !!isError); show(b, true);
  }

  /* ---------- START SCREEN ---------- */
  function initStart() {
    var saved = lsGet(LS_NAME); if (saved) $('player-name').value = saved;
    var cod = params.get('cod'); if (cod) $('join-code').value = cod.toUpperCase().slice(0, 5);
    $('btn-create').addEventListener('click', createRoom);
    $('btn-join').addEventListener('click', function () { joinRoom($('join-code').value); });
    $('join-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinRoom($('join-code').value); });
    $('btn-help').addEventListener('click', function () { $('dlg-help').showModal(); });
    $('help-close').addEventListener('click', function () { $('dlg-help').close(); });
    var sess = loadSession();
    if (sess && sess.code) {
      show($('btn-resume'), true);
      $('btn-resume').addEventListener('click', function () { resumeSession(sess); });
      if (!cod) setTimeout(function () { resumeSession(sess); }, 50);
    }
  }
  function startError(text) { var n = $('start-error'); n.textContent = text; show(n, !!text); }
  function readName() {
    var n = $('player-name').value.trim().slice(0, 24);
    if (!n) { startError('Scrie-ți numele mai întâi.'); $('player-name').focus(); return null; }
    lsSet(LS_NAME, n); startError(''); return n;
  }

  /* ---------- HOST ---------- */
  function createRoom() {
    var name = readName(); if (!name) return;
    $('btn-create').disabled = true;
    hostWithCode(randomCode(), 0).then(function () {
      me = { name: name, id: 'p1', isHost: true };
      state = freshState();
      state.players.push({ id: 'p1', name: name, connected: true });
      enterLobby();
      saveSession();
    }).catch(function (err) {
      $('btn-create').disabled = false;
      startError(err && err.message ? err.message : 'Nu s-a putut crea camera.');
    });
  }
  function hostWithCode(code, attempt) {
    return transport.host(code).then(function (server) {
      room.code = code; room.server = server;
      server.onConnection(onGuestConnection);
      return server;
    }).catch(function (err) {
      if (err && err.code === 'unavailable-id' && attempt < 8) return hostWithCode(randomCode(), attempt + 1);
      throw err;
    });
  }

  function onGuestConnection(conn) {
    var pid = null;
    conn.onMessage(function (m) {
      if (!m || m.v !== PROTOCOL_VERSION) return;
      if (m.t === 'hello') {
        pid = hostHandleHello(conn, m);
        return;
      }
      if (!pid) return;
      hostHandleMessage(pid, m);
    });
    conn.onClose(function () { if (pid) hostGuestClosed(pid, conn); });
  }

  function hostHandleHello(conn, m) {
    var pid = null;
    var existing = m.playerId ? playerById(m.playerId) : null;
    if (existing && existing.id !== 'p1') {
      pid = existing.id;
      existing.name = String(m.name || existing.name).slice(0, 24) || existing.name;
      existing.connected = true;
      delete local.disconnectedSince[pid];
      if (room.conns[pid] && room.conns[pid] !== conn) { try { room.conns[pid].close(); } catch (e) { /* ignore */ } }
    } else {
      if (state.players.length >= MAX_PLAYERS || state.phase !== 'lobby') {
        conn.send(msg('refused', { reason: state.phase !== 'lobby' ? 'Jocul a început deja în această cameră.' : 'Camera e plină (maximum 5 jucători).' }));
        setTimeout(function () { conn.close(); }, 300);
        return null;
      }
      var n = 2; while (playerById('p' + n)) n++;
      pid = 'p' + n;
      state.players.push({ id: pid, name: String(m.name || 'Jucător').slice(0, 24) || 'Jucător', connected: true });
    }
    room.conns[pid] = conn;
    conn.send(msg('welcome', { playerId: pid, state: publicState(), remainingMs: hostRemainingMs(), closeInMs: hostCloseInMs() }));
    broadcast('roster', { players: state.players }, pid);
    if (existing) {
      // resume: resend the per-phase information the guest needs
      if (state.phase === 'review') sendTo(pid, 'reviewRequest', { roundIndex: state.roundIndex, items: hostReviewItemsFor(pid) });
    }
    refreshPlayersUI();
    saveSession();
    return pid;
  }

  function hostGuestClosed(pid, conn) {
    if (room.conns[pid] !== conn) return; // replaced by a newer connection
    delete room.conns[pid];
    var p = playerById(pid); if (p) p.connected = false;
    local.disconnectedSince[pid] = now();
    broadcast('roster', { players: state.players });
    refreshPlayersUI();
    if (state.phase === 'review') hostScheduleAutoAccept(pid);
  }

  function hostHandleMessage(pid, m) {
    var r = currentRound();
    switch (m.t) {
      case 'ping': sendTo(pid, 'pong', { ts: m.ts, remainingMs: hostRemainingMs(), closeInMs: hostCloseInMs(), phase: state.phase, roundIndex: state.roundIndex }); break;
      case 'answersDraft':
        if (r && m.roundIndex === state.roundIndex && !r.closed) r.drafts[pid] = sanitizeAnswers(m.answers);
        break;
      case 'answersFinal':
        if (r && m.roundIndex === state.roundIndex) {
          r.drafts[pid] = sanitizeAnswers(m.answers);
          if (local.finalWaiting) { local.finalWaiting[pid] = true; hostCheckFinalsComplete(); }
        }
        break;
      case 'finish':
        if (r && m.roundIndex === state.roundIndex && !r.closed) { if (m.answers) r.drafts[pid] = sanitizeAnswers(m.answers); hostPlayerFinished(pid); }
        break;
      case 'reviewDecision':
        if (r && m.roundIndex === state.roundIndex && state.phase === 'review') hostApplyDecisions(pid, m.decisions || []);
        break;
      default: break; // unknown message types are ignored
    }
  }
  function sanitizeAnswers(a) {
    var out = {}; if (!a || typeof a !== 'object') return out;
    CATS.forEach(function (c) { out[c.id] = typeof a[c.id] === 'string' ? a[c.id].slice(0, 60) : ''; });
    return out;
  }
  function hostRemainingMs() { return state && state.phase === 'round' ? Math.max(0, local.deadline - now()) : 0; }
  function hostCloseInMs() { return state && state.phase === 'round' && local.closeAt ? Math.max(0, local.closeAt - now()) : 0; }

  /* --- lobby & settings --- */
  function readSettings() {
    var rounds = $('set-rounds').value;
    return { roundSeconds: +$('set-round').value, graceSeconds: +$('set-grace').value, rounds: rounds === 'all' ? 'all' : +rounds, hardLetters: $('set-hard').checked };
  }
  function applySettingsUI(s) {
    $('set-round').value = String(s.roundSeconds); $('set-grace').value = String(s.graceSeconds);
    $('set-rounds').value = s.rounds === 'all' ? 'all' : String(s.rounds); $('set-hard').checked = !!s.hardLetters;
  }
  function hostSettingsChanged() {
    state.settings = readSettings();
    broadcast('settings', { settings: state.settings });
    updateLobbyNote(); saveSession();
  }
  function plannedRounds(s) {
    var pool = E.letterPool(s.hardLetters).length;
    return s.rounds === 'all' ? pool : Math.min(s.rounds, pool);
  }
  function updateLobbyNote() {
    var s = state.settings; var n = plannedRounds(s);
    var note = '';
    if (s.rounds !== 'all' && n < s.rounds) note = 'Sunt doar ' + n + ' litere disponibile, așa că jocul va avea ' + n + ' runde.';
    else if (s.rounds === 'all') note = 'Jocul va avea ' + n + ' runde, câte una pentru fiecare literă.';
    $('lobby-note').textContent = note; show($('lobby-note'), !!note);
  }

  function enterLobby() {
    $('room-code').textContent = room.code;
    var isHttp = /^https?:$/.test(location.protocol);
    var link = isHttp ? location.origin + location.pathname + '?cod=' + room.code : '';
    show($('btn-share-link'), isHttp); show($('lobby-link'), isHttp);
    $('lobby-link').textContent = link;
    $('btn-share-link').onclick = function () {
      if (navigator.share) navigator.share({ title: 'Țomapant', text: 'Hai să jucăm Țomapant! Codul camerei: ' + room.code, url: link }).catch(function () { });
      else copyText(link, 'Linkul a fost copiat');
    };
    ['set-round', 'set-grace', 'set-rounds', 'set-hard'].forEach(function (id) { $(id).disabled = !me.isHost; });
    show($('btn-start'), me.isHost); show($('lobby-guest-wait'), !me.isHost);
    applySettingsUI(state.settings); updateLobbyNote();
    refreshPlayersUI();
    showScreen('lobby');
  }
  function copyText(text, okMsg) {
    var done = function () { toast(okMsg); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) { /* ignore */ } document.body.removeChild(ta);
  }
  function refreshPlayersUI() {
    if (!state) return;
    var ul = $('lobby-players'); ul.innerHTML = '';
    state.players.forEach(function (p, i) {
      var li = el('li'); var dot = el('span', 'dot' + (p.connected ? '' : ' off')); li.appendChild(dot);
      li.appendChild(el('span', null, p.name + (p.id === me.id ? ' (tu)' : '')));
      li.appendChild(el('span', 'tag', i === 0 ? 'gazdă' : (p.connected ? 'conectat' : 'deconectat')));
      ul.appendChild(li);
    });
    var others = state.players.length - 1;
    $('lobby-wait').textContent = others === 0 ? 'Se așteaptă adversarul...' : (others === 1 ? 'Conectat cu ' + state.players[1].name + '. Mai pot intra încă ' + (MAX_PLAYERS - state.players.length) + ' jucători.' : 'Conectat cu ' + joinNames(state.players.slice(1).map(function (p) { return p.name; })) + '.');
    if (me.isHost) $('btn-start').disabled = state.players.filter(function (p) { return p.connected; }).length < 2;
    renderOppStatus();
  }

  /* --- round lifecycle (host) --- */
  function hostStartGame() {
    state.settings = readSettings();
    state.totalRounds = plannedRounds(state.settings);
    if (TRANSPORT_KIND === 'local' && params.get('rounds')) state.totalRounds = Math.max(1, Math.min(state.totalRounds, parseInt(params.get('rounds'), 10) || 1));
    state.rounds = []; state.lettersUsed = []; state.roundIndex = -1; state.accepted = {};
    hostStartRound();
  }
  function hostStartRound() {
    var pool = E.letterPool(state.settings.hardLetters).filter(function (l) { return state.lettersUsed.indexOf(l) < 0; });
    if (!pool.length || state.roundIndex + 1 >= state.totalRounds) { hostGameOver(); return; }
    var letter = pool[randomIndex(pool.length)];
    state.lettersUsed.push(letter);
    state.roundIndex += 1;
    state.rounds.push({ letter: letter, drafts: {}, answers: {}, evals: {}, reviews: {}, scores: null, finishedBy: [], closed: false, autoAccepted: [], closeReason: '' });
    state.phase = 'round';
    local.deadline = now() + state.settings.roundSeconds * 1000;
    local.closeAt = 0;
    clearTimeout(local.hostTimers.close);
    local.hostTimers.close = setTimeout(hostCloseRound, state.settings.roundSeconds * 1000);
    broadcast('roundStart', { roundIndex: state.roundIndex, letter: letter, totalRounds: state.totalRounds, remainingMs: state.settings.roundSeconds * 1000, players: state.players, settings: state.settings });
    clearInterval(local.hostTimers.sync);
    local.hostTimers.sync = setInterval(function () { if (state.phase === 'round') broadcast('timeSync', { roundIndex: state.roundIndex, remainingMs: hostRemainingMs(), closeInMs: hostCloseInMs() }); }, 10000);
    beginRoundUI();
    saveSession();
  }
  function hostPlayerFinished(pid) {
    var r = currentRound(); if (!r || r.closed) return;
    if (r.finishedBy.indexOf(pid) < 0) r.finishedBy.push(pid);
    var allIn = state.players.every(function (p) { return !p.connected || r.finishedBy.indexOf(p.id) >= 0; });
    if (allIn) { hostCloseRound(); return; }
    if (!local.closeAt) {
      local.closeAt = Math.min(local.deadline, now() + state.settings.graceSeconds * 1000);
      clearTimeout(local.hostTimers.close);
      local.hostTimers.close = setTimeout(hostCloseRound, Math.max(0, local.closeAt - now()));
    }
    broadcast('playerFinished', { roundIndex: state.roundIndex, playerId: pid, closeInMs: Math.max(0, local.closeAt - now()), finishedBy: r.finishedBy });
    onPlayerFinishedUI(pid, Math.max(0, local.closeAt - now()));
  }
  function hostCloseRound() {
    var r = currentRound(); if (!r || r.closed) return;
    r.closed = true;
    clearTimeout(local.hostTimers.close); clearInterval(local.hostTimers.sync);
    r.closeReason = local.closeAt && local.closeAt < local.deadline ? 'gata' : 'timp';
    broadcast('roundClose', { roundIndex: state.roundIndex });
    lockRoundUI();
    r.drafts[me.id] = sanitizeAnswers(local.answers);
    local.finalWaiting = {};
    state.players.forEach(function (p) { if (p.id !== me.id && p.connected) local.finalWaiting[p.id] = false; });
    clearTimeout(local.closeFallbackTimer);
    local.closeFallbackTimer = setTimeout(function () { if (local.finalWaiting) hostEvaluateRound(); }, 3000);
    hostCheckFinalsComplete();
  }
  function hostCheckFinalsComplete() {
    if (!local.finalWaiting) return;
    var pending = Object.keys(local.finalWaiting).filter(function (pid) { return !local.finalWaiting[pid]; });
    if (!pending.length) hostEvaluateRound();
  }
  function hostEvaluateRound() {
    var r = currentRound(); if (!r || r.evals && Object.keys(r.evals).length) { local.finalWaiting = null; return; }
    local.finalWaiting = null; clearTimeout(local.closeFallbackTimer);
    state.players.forEach(function (p) {
      r.answers[p.id] = sanitizeAnswers(r.drafts[p.id] || {});
      r.evals[p.id] = {};
      CATS.forEach(function (c) { r.evals[p.id][c.id] = E.evaluate(LIB, c.id, r.letter, r.answers[p.id][c.id], sessionAccepted); });
    });
    // review items: unknown answers, reviewed by every other player
    r.reviews = {};
    state.players.forEach(function (p) {
      CATS.forEach(function (c) {
        if (r.evals[p.id][c.id].status === 'unknown') {
          r.reviews[p.id + ':' + c.id] = { targetId: p.id, cat: c.id, word: r.answers[p.id][c.id], key: r.evals[p.id][c.id].key, votes: {} };
        }
      });
    });
    if (Object.keys(r.reviews).length === 0) { hostFinishScoring(); return; }
    state.phase = 'review';
    state.players.forEach(function (p) { if (p.id !== me.id) sendTo(p.id, 'reviewRequest', { roundIndex: state.roundIndex, items: hostReviewItemsFor(p.id) }); });
    state.players.forEach(function (p) { if (!p.connected && p.id !== me.id) hostScheduleAutoAccept(p.id); });
    enterReviewUI(hostReviewItemsFor(me.id));
    saveSession();
  }
  function hostReviewItemsFor(reviewerId) {
    var r = currentRound(); var items = [];
    Object.keys(r.reviews).forEach(function (k) {
      var it = r.reviews[k];
      if (it.targetId !== reviewerId) items.push({ targetId: it.targetId, targetName: playerName(it.targetId), cat: it.cat, word: it.word, decided: it.votes[reviewerId] });
    });
    return items;
  }
  function hostApplyDecisions(reviewerId, decisions) {
    var r = currentRound(); if (!r || state.phase !== 'review') return;
    decisions.forEach(function (d) {
      var it = r.reviews[d.targetId + ':' + d.cat];
      if (it && it.targetId !== reviewerId && typeof d.accept === 'boolean' && it.votes[reviewerId] == null) it.votes[reviewerId] = d.accept;
    });
    hostCheckReviewComplete();
  }
  function hostReviewersFor(targetId) { return state.players.filter(function (p) { return p.id !== targetId; }).map(function (p) { return p.id; }); }
  function hostCheckReviewComplete() {
    var r = currentRound();
    var complete = Object.keys(r.reviews).every(function (k) {
      var it = r.reviews[k];
      return hostReviewersFor(it.targetId).every(function (rid) { return it.votes[rid] != null; });
    });
    if (complete) hostFinishScoring();
    else broadcast('reviewProgress', { roundIndex: state.roundIndex });
  }
  function hostScheduleAutoAccept(pid) {
    clearTimeout(local.reviewAutoTimers[pid]);
    var since = local.disconnectedSince[pid] || now();
    var wait = Math.max(0, since + 60000 - now());
    local.reviewAutoTimers[pid] = setTimeout(function () {
      var r = currentRound(); if (!r || state.phase !== 'review') return;
      var p = playerById(pid); if (!p || p.connected) return;
      var changed = false;
      Object.keys(r.reviews).forEach(function (k) {
        var it = r.reviews[k];
        if (it.targetId !== pid && it.votes[pid] == null) { it.votes[pid] = true; changed = true; }
      });
      if (changed) { r.autoAccepted.push(pid); hostCheckReviewComplete(); }
    }, wait);
  }
  function hostFinishScoring() {
    var r = currentRound();
    Object.keys(local.reviewAutoTimers).forEach(function (k) { clearTimeout(local.reviewAutoTimers[k]); });
    // apply review outcomes
    Object.keys(r.reviews).forEach(function (k) {
      var it = r.reviews[k];
      var reviewers = hostReviewersFor(it.targetId);
      var acc = reviewers.filter(function (rid) { return it.votes[rid] === true; });
      var rej = reviewers.filter(function (rid) { return it.votes[rid] === false; });
      var ev = r.evals[it.targetId][it.cat];
      if (acc.length >= rej.length) {
        ev.status = 'valid'; ev.reason = 'acceptat de ' + joinNames(acc.map(playerName));
        if (!state.accepted[it.cat]) state.accepted[it.cat] = [];
        if (state.accepted[it.cat].indexOf(it.key) < 0) state.accepted[it.cat].push(it.key);
      } else {
        ev.status = 'rejected'; ev.reason = 'respins de ' + joinNames(rej.map(playerName));
      }
    });
    var scores = E.scoreRound(r.evals);
    Object.keys(scores).forEach(function (pid) {
      CATS.forEach(function (c) {
        var cell = scores[pid].cells[c.id]; var ev = r.evals[pid][c.id];
        cell.word = r.answers[pid][c.id] || '';
        cell.reason = ev.reason + (cell.shared ? (ev.reason ? ', ' : '') + 'același răspuns' : '');
      });
    });
    r.scores = scores;
    state.phase = 'results';
    var note = r.autoAccepted.length ? 'Cuvintele de verificat de ' + joinNames(r.autoAccepted.map(playerName)) + ' au fost acceptate automat, pentru că jucătorul nu a mai fost conectat.' : '';
    r.note = note;
    broadcast('roundResult', { roundIndex: state.roundIndex, round: r, accepted: state.accepted, players: state.players });
    enterResultsUI();
    saveSession();
  }
  function hostNextRound() {
    if (state.phase !== 'results') return;
    if (state.roundIndex + 1 >= state.totalRounds) hostGameOver(); else hostStartRound();
  }
  function hostGameOver() {
    state.phase = 'gameover';
    broadcast('gameOver', { state: publicState() });
    enterGameOverUI();
    saveSession();
  }
  function hostRematch() {
    var settings = state.settings;
    var players = state.players;
    state = freshState(settings); state.players = players;
    broadcast('rematch', { state: publicState() });
    hostStartGame();
  }

  /* ---------- GUEST ---------- */
  function joinRoom(codeRaw) {
    var name = readName(); if (!name) return;
    var code = (codeRaw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (code.length !== 5) { startError('Codul camerei are 5 caractere.'); return; }
    $('btn-join').disabled = true; startError('');
    transport.join(code).then(function (conn) {
      me = { name: name, id: me.id && !me.isHost ? me.id : null, isHost: false };
      room.code = code; room.conn = conn;
      attachGuestConn(conn);
      conn.send(msg('hello', { name: name, playerId: me.id }));
    }).catch(function (err) {
      $('btn-join').disabled = false;
      startError(err && err.message ? err.message : 'Nu s-a putut intra în cameră.');
    });
  }
  function attachGuestConn(conn) {
    conn.onMessage(guestHandleMessage);
    conn.onClose(function () { if (room.conn === conn) guestLostConnection(); });
    clearInterval(local.pingTimer);
    local.pingTimer = setInterval(function () { sendToHost('ping', { ts: now() }); }, 5000);
  }
  function guestLostConnection() {
    room.conn = null;
    if (!state || state.phase === 'gameover') { if (state) setConnBar('Gazda a închis camera.', true); return; }
    setConnBar('Conexiunea s-a întrerupt. Se încearcă reconectarea...');
    local.reconnectUntil = now() + 90000;
    clearTimeout(local.reconnectTimer);
    local.reconnectTimer = setTimeout(guestTryReconnect, 2000);
  }
  function guestTryReconnect() {
    clearTimeout(local.reconnectTimer);
    if (room.conn) return;
    if (now() > local.reconnectUntil) { setConnBar('Camera nu există sau gazda nu mai e conectată', true); return; }
    transport.join(room.code).then(function (conn) {
      room.conn = conn; attachGuestConn(conn);
      conn.send(msg('hello', { name: me.name, playerId: me.id }));
    }).catch(function () {
      local.reconnectTimer = setTimeout(guestTryReconnect, 2000);
    });
  }
  function guestApplyTiming(remainingMs, closeInMs) {
    var half = local.rtt / 2;
    if (typeof remainingMs === 'number') local.deadline = now() + remainingMs - half;
    if (typeof closeInMs === 'number' && closeInMs > 0) local.closeAt = now() + closeInMs - half; else if (closeInMs === 0) local.closeAt = 0;
  }
  function guestHandleMessage(m) {
    if (!m || m.v !== PROTOCOL_VERSION) return;
    switch (m.t) {
      case 'refused': setConnBar(m.reason || 'Nu poți intra în această cameră.', true); $('btn-join').disabled = false; startError(m.reason || ''); break;
      case 'welcome': {
        var resuming = !!me.id;
        me.id = m.playerId;
        state = m.state;
        setConnBar('');
        $('btn-join').disabled = false;
        guestApplyTiming(m.remainingMs, m.closeInMs);
        guestRestoreView(resuming);
        saveSession();
        break;
      }
      case 'roster': if (state) { state.players = m.players; refreshPlayersUI(); } break;
      case 'settings': if (state) { state.settings = m.settings; applySettingsUI(state.settings); updateLobbyNote(); } break;
      case 'pong': {
        local.rtt = clamp(now() - m.ts, 0, 5000);
        if (state && state.phase === 'round' && m.phase === 'round' && m.roundIndex === state.roundIndex) guestApplyTiming(m.remainingMs, m.closeInMs);
        break;
      }
      case 'timeSync': if (state && state.phase === 'round' && m.roundIndex === state.roundIndex) guestApplyTiming(m.remainingMs, m.closeInMs); break;
      case 'roundStart': {
        if (!state) return;
        if (m.players) state.players = m.players;
        if (m.settings) state.settings = m.settings;
        state.totalRounds = m.totalRounds;
        if (m.roundIndex === state.rounds.length) {
          state.rounds.push({ letter: m.letter, answers: {}, evals: {}, reviews: {}, scores: null, finishedBy: [], closed: false });
        } else if (m.roundIndex < state.rounds.length) {
          state.rounds[m.roundIndex] = { letter: m.letter, answers: {}, evals: {}, reviews: {}, scores: null, finishedBy: [], closed: false };
          state.rounds.length = m.roundIndex + 1;
        }
        state.roundIndex = m.roundIndex; state.phase = 'round';
        state.lettersUsed.push(m.letter);
        local.closeAt = 0; guestApplyTiming(m.remainingMs, 0);
        beginRoundUI(); saveSession();
        break;
      }
      case 'playerFinished': {
        var r = currentRound(); if (!r || m.roundIndex !== state.roundIndex) return;
        r.finishedBy = m.finishedBy || r.finishedBy;
        guestApplyTiming(undefined, m.closeInMs);
        onPlayerFinishedUI(m.playerId, Math.max(0, local.closeAt - now()));
        break;
      }
      case 'roundClose': {
        var rc = currentRound(); if (!rc || m.roundIndex !== state.roundIndex) return;
        rc.closed = true; lockRoundUI();
        sendToHost('answersFinal', { roundIndex: state.roundIndex, answers: local.answers });
        break;
      }
      case 'reviewRequest': {
        if (!state || m.roundIndex !== state.roundIndex) return;
        state.phase = 'review'; var cr = currentRound(); if (cr) cr.closed = true;
        lockRoundUI();
        enterReviewUI(m.items); saveSession();
        break;
      }
      case 'reviewProgress': break;
      case 'roundResult': {
        if (!state || m.roundIndex !== state.roundIndex) return;
        if (m.players) state.players = m.players;
        state.rounds[m.roundIndex] = m.round; state.accepted = m.accepted || state.accepted; state.phase = 'results';
        enterResultsUI(); saveSession();
        break;
      }
      case 'gameOver': if (state) { state = m.state; enterGameOverUI(); saveSession(); } break;
      case 'rematch': if (state) { state = m.state; local.lastRoundShown = -1; enterLobby(); saveSession(); } break;
      case 'stateSnapshot': if (state) { state = m.state; guestApplyTiming(m.remainingMs, m.closeInMs); guestRestoreView(true); saveSession(); } break;
      default: break;
    }
  }
  function guestRestoreView(resuming) {
    refreshPlayersUI();
    switch (state.phase) {
      case 'lobby': enterLobby(); break;
      case 'round': beginRoundUI(resuming); break;
      case 'review': {
        var r = currentRound();
        if (r && r.reviews) { lockRoundUI(); enterReviewUI(reviewItemsFromState(me.id)); }
        else { lockRoundUI(); enterReviewUI([]); }
        break;
      }
      case 'results': enterResultsUI(true); break;
      case 'gameover': enterGameOverUI(); break;
      default: enterLobby();
    }
  }
  function reviewItemsFromState(reviewerId) {
    var r = currentRound(); var items = [];
    if (!r || !r.reviews) return items;
    Object.keys(r.reviews).forEach(function (k) {
      var it = r.reviews[k];
      if (it.targetId !== reviewerId) items.push({ targetId: it.targetId, targetName: playerName(it.targetId), cat: it.cat, word: it.word, decided: it.votes ? it.votes[reviewerId] : undefined });
    });
    return items;
  }

  /* ---------- resume after refresh ---------- */
  function resumeSession(sess) {
    me = { name: sess.name, id: sess.playerId, isHost: sess.role === 'host' };
    lsSet(LS_NAME, sess.name);
    local.lastRoundShown = typeof sess.roundIndex === 'number' ? sess.roundIndex : -1;
    show($('btn-resume'), false);
    if (sess.role === 'host' && sess.state) {
      state = sess.state;
      local.answers = sess.answers || {};
      hostWithCode(sess.code, 99).then(function () {
        state.players.forEach(function (p, i) { if (i > 0) p.connected = false; });
        if (state.phase === 'round') {
          // the round timer is lost on refresh: close the round now with the saved drafts
          var r = currentRound(); if (r) { r.closed = true; }
          state.phase = 'review';
          lockRoundUI();
          hostEvaluateRoundAfterResume();
        } else if (state.phase === 'review') {
          enterReviewUI(hostReviewItemsFor(me.id));
          state.players.forEach(function (p) { if (p.id !== me.id) hostScheduleAutoAccept(p.id); });
        } else if (state.phase === 'results') enterResultsUI(true);
        else if (state.phase === 'gameover') enterGameOverUI();
        else enterLobby();
        saveSession();
      }).catch(function (err) { startError(err && err.message ? err.message : 'Nu s-a putut relua camera.'); ssSet(SS_SESSION, null); show($('btn-resume'), false); });
    } else {
      room.code = sess.code; state = null; local.answers = sess.answers || {};
      setConnBar('Conexiunea s-a întrerupt. Se încearcă reconectarea...');
      local.reconnectUntil = now() + 90000;
      guestTryReconnect();
    }
  }
  function hostEvaluateRoundAfterResume() {
    var r = currentRound();
    if (r && !(r.evals && Object.keys(r.evals).length)) { local.finalWaiting = {}; hostEvaluateRound(); }
    else if (state.phase === 'review') enterReviewUI(hostReviewItemsFor(me.id));
  }

  /* ---------- ROUND UI ---------- */
  var fieldInputs = {};
  function buildFields() {
    var form = $('fields'); form.innerHTML = ''; fieldInputs = {};
    CATS.forEach(function (c, i) {
      var row = el('div', 'field-row ' + c.color);
      var lab = el('label'); lab.setAttribute('for', 'f-' + c.id); lab.textContent = c.icon + ' ' + c.label;
      var inp = el('input', 'input'); inp.id = 'f-' + c.id; inp.type = 'text'; inp.maxLength = 60;
      inp.setAttribute('autocomplete', 'off'); inp.setAttribute('autocorrect', 'off'); inp.setAttribute('autocapitalize', 'words'); inp.setAttribute('spellcheck', 'false');
      inp.setAttribute('enterkeyhint', i < CATS.length - 1 ? 'next' : 'done');
      inp.dataset.cat = c.id;
      var mark = el('span', 'mark'); mark.id = 'm-' + c.id; mark.setAttribute('aria-hidden', 'true');
      row.appendChild(lab); row.appendChild(inp); row.appendChild(mark); form.appendChild(row);
      fieldInputs[c.id] = inp;
      inp.addEventListener('input', function () { local.answers[c.id] = inp.value; updateMark(c.id); scheduleDraft(); renderSheetLive(); });
      inp.addEventListener('blur', function () { sendDraftNow(); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); var next = CATS[i + 1]; if (next) fieldInputs[next.id].focus(); else inp.blur(); }
      });
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); });
  }
  function updateMark(catId) {
    var r = currentRound(); var mark = $('m-' + catId); if (!r || !mark) return;
    var v = local.answers[catId] || '';
    if (!E.normalise(v)) { mark.className = 'mark'; mark.textContent = ''; mark.title = ''; return; }
    var ev = E.evaluate(LIB, catId, r.letter, v, sessionAccepted);
    if (ev.status === 'valid') { mark.className = 'mark ok'; mark.textContent = '✓'; mark.title = 'În dicționar'; }
    else if (ev.status === 'wrongLetter') { mark.className = 'mark warn'; mark.textContent = '!'; mark.title = 'Nu începe cu litera ' + r.letter; }
    else { mark.className = 'mark neutral'; mark.textContent = '?'; mark.title = 'Nu e în dicționar, va fi verificat de adversar'; }
  }
  function scheduleDraft() {
    if (me.isHost) { var r = currentRound(); if (r) r.drafts[me.id] = sanitizeAnswers(local.answers); saveSession(); return; }
    if (!local.draftTimer) local.draftTimer = setTimeout(sendDraftNow, 3000);
  }
  function sendDraftNow() {
    clearTimeout(local.draftTimer); local.draftTimer = null;
    saveSession();
    if (!me.isHost && state && state.phase === 'round') sendToHost('answersDraft', { roundIndex: state.roundIndex, answers: local.answers });
  }

  function beginRoundUI(resuming) {
    var r = currentRound(); if (!r) return;
    if (!resuming || local.lastRoundShown !== state.roundIndex) { local.answers = {}; local.finished = false; local.locked = false; }
    local.lastRoundShown = state.roundIndex;
    buildFields();
    CATS.forEach(function (c) { fieldInputs[c.id].value = local.answers[c.id] || ''; updateMark(c.id); });
    $('round-letter').textContent = r.letter; $('round-letter-text').textContent = r.letter;
    $('round-num').textContent = String(state.roundIndex + 1); $('round-total').textContent = String(state.totalRounds);
    $('round-grand').textContent = String(grandTotal(me.id));
    var lb = $('round-letter'); lb.classList.remove('reveal'); void lb.offsetWidth; if (!reducedMotion) lb.classList.add('reveal');
    show($('round-banner'), false);
    $('btn-finish').disabled = false; $('btn-finish').textContent = 'Gata!';
    renderOppStatus();
    renderSheetLive();
    var wide = window.matchMedia('(min-width: 980px)').matches;
    show($('round-sheet-wide'), wide); show($('round-sheet-panel'), !wide);
    showScreen('round');
    if (local.finished || local.locked) lockInputs();
    clearInterval(local.timerInterval); local.lastTickSecond = -1;
    local.timerInterval = setInterval(timerTick, 200); timerTick();
    if (r.finishedBy && r.finishedBy.length) { var others = r.finishedBy.filter(function (id) { return id !== me.id; }); if (others.length && local.closeAt) onPlayerFinishedUI(others[0], Math.max(0, local.closeAt - now())); }
    vibrate(40);
    setTimeout(function () { if (!local.locked && fieldInputs.tari) fieldInputs.tari.focus({ preventScroll: true }); }, 350);
  }
  function timerTick() {
    if (!state || state.phase !== 'round') { clearInterval(local.timerInterval); return; }
    var end = local.closeAt ? Math.min(local.closeAt, local.deadline) : local.deadline;
    var ms = Math.max(0, end - now());
    var t = $('timer'); t.textContent = fmtTime(ms);
    var urgent = ms <= 10000 && ms > 0;
    t.classList.toggle('urgent', urgent);
    var sec = Math.ceil(ms / 1000);
    if (urgent && sec !== local.lastTickSecond) { local.lastTickSecond = sec; tick(); }
    if (ms === 0 && !local.locked) {
      if (me.isHost) hostCloseRound(); else { $('timer').textContent = '0:00'; show($('round-banner'), true); $('round-banner').textContent = 'Timpul a expirat'; $('round-banner').classList.add('closed'); }
    }
  }
  function renderOppStatus() {
    var box = $('opp-status'); if (!box) return; box.innerHTML = '';
    var r = currentRound();
    otherPlayers().forEach(function (p) {
      var done = r && r.finishedBy && r.finishedBy.indexOf(p.id) >= 0;
      var chip = el('span', 'chip' + (done ? ' done' : '') + (!p.connected ? ' off' : ''));
      chip.textContent = p.name + ': ' + (!p.connected ? 'deconectat' : (done ? 'a terminat' : 'scrie...'));
      box.appendChild(chip);
    });
  }
  function onPlayerFinishedUI(pid, closeInMs) {
    renderOppStatus();
    if (pid === me.id) return;
    var b = $('round-banner');
    var secs = Math.max(1, Math.round(closeInMs / 1000));
    b.classList.remove('closed');
    b.textContent = (otherPlayers().length === 1 ? 'Adversarul a terminat!' : playerName(pid) + ' a terminat!') + ' Mai ai ' + secs + ' ' + plural(secs, 'secundă', 'secunde');
    show(b, !local.finished);
    vibrate([60, 40, 60]);
  }
  function lockInputs() {
    local.locked = true;
    CATS.forEach(function (c) { if (fieldInputs[c.id]) fieldInputs[c.id].disabled = true; });
    $('btn-finish').disabled = true;
  }
  function lockRoundUI() {
    lockInputs();
    clearInterval(local.timerInterval);
    if ($('timer')) $('timer').classList.remove('urgent');
    var b = $('round-banner');
    if (state && state.phase === 'round' || !local.finished) { b.textContent = 'Timpul a expirat'; b.classList.add('closed'); show(b, true); }
    sendDraftNow();
  }
  function pressFinish() {
    if (local.finished || local.locked) return;
    var empty = CATS.some(function (c) { return !E.normalise(local.answers[c.id] || ''); });
    if (empty) {
      $('confirm-text').textContent = 'Ai câmpuri goale. Termini oricum?';
      var dlg = $('dlg-confirm');
      $('confirm-yes').onclick = function () { dlg.close(); doFinish(); };
      $('confirm-no').onclick = function () { dlg.close(); };
      dlg.showModal();
    } else doFinish();
  }
  function doFinish() {
    local.finished = true; lockInputs();
    $('btn-finish').textContent = 'Ai terminat';
    show($('round-banner'), false);
    if (me.isHost) { var r = currentRound(); if (r) r.drafts[me.id] = sanitizeAnswers(local.answers); hostPlayerFinished(me.id); }
    else { clearTimeout(local.draftTimer); local.draftTimer = null; sendToHost('finish', { roundIndex: state.roundIndex, answers: local.answers }); }
    vibrate(30);
  }

  /* ---------- SCORE SHEET ---------- */
  function sheetTitle(pid) { return pid === me.id ? 'Foaia mea' : playerName(pid); }
  function buildSheetTable(pid, opts) {
    opts = opts || {};
    var wrap = el('div', 'sheet-wrap'); wrap.dataset.player = pid;
    var title = el('div', 'sheet-title');
    title.appendChild(el('span', null, sheetTitle(pid)));
    title.appendChild(el('span', 'muted small', 'Total general: ' + grandTotal(pid)));
    wrap.appendChild(title);
    var scroll = el('div', 'sheet-scroll');
    var table = el('table', 'sheet'); table.setAttribute('aria-label', 'Foaia de joc a jucătorului ' + playerName(pid));
    var cg = el('colgroup'); cg.appendChild(el('col', 'c-letter'));
    CATS.forEach(function () { cg.appendChild(el('col', 'c-cat')); });
    cg.appendChild(el('col', 'c-total')); table.appendChild(cg);
    var thead = el('thead'); var trh = el('tr');
    trh.appendChild(el('th', null, 'Litera'));
    CATS.forEach(function (c) { var th = el('th', c.color); th.textContent = c.icon + ' ' + c.label; trh.appendChild(th); });
    trh.appendChild(el('th', null, 'Total'));
    thead.appendChild(trh); table.appendChild(thead);
    var tbody = el('tbody');
    var rounds = state.rounds;
    var animateIndex = typeof opts.animateRound === 'number' ? opts.animateRound : -1;
    var grand = 0;
    rounds.forEach(function (r, idx) {
      var tr = el('tr'); tr.dataset.round = String(idx);
      var scored = !!(r.scores && r.scores[pid]);
      var isCurrent = idx === state.roundIndex && !scored;
      if (isCurrent) tr.classList.add('current');
      tr.appendChild(el('td', null, r.letter));
      CATS.forEach(function (c) {
        var td = el('td', 'cell ' + c.color); td.dataset.cat = c.id;
        var word = '';
        if (scored) word = r.scores[pid].cells[c.id].word || '';
        else if (r.answers && r.answers[pid]) word = r.answers[pid][c.id] || '';
        else if (isCurrent && pid === me.id) word = local.answers[c.id] || '';
        var w = el('span', 'w', word || (scored ? '—' : '')); td.appendChild(w);
        if (scored) {
          var pts = r.scores[pid].cells[c.id].points;
          var ps = el('span', 'pts p' + pts, ' ' + pts);
          if (idx === animateIndex && !reducedMotion) { ps.style.visibility = 'hidden'; td.dataset.animate = '1'; }
          td.appendChild(ps);
          td.dataset.reason = r.scores[pid].cells[c.id].reason || '';
          td.dataset.word = word;
          td.title = word;
        } else { td.dataset.word = word; td.title = word; }
        tr.appendChild(td);
      });
      var tdT = el('td', null, scored ? String(r.scores[pid].total) : '');
      if (scored && idx === animateIndex && !reducedMotion) { tdT.textContent = ''; tdT.dataset.animateTotal = String(r.scores[pid].total); }
      tr.appendChild(tdT);
      if (scored) grand += r.scores[pid].total;
      tbody.appendChild(tr);
    });
    var trg = el('tr', 'grand');
    trg.appendChild(el('td', null, 'Total general'));
    CATS.forEach(function () { trg.appendChild(el('td', null, '')); });
    var tdG = el('td', null, String(grand));
    if (animateIndex >= 0 && rounds[animateIndex] && rounds[animateIndex].scores && !reducedMotion) {
      tdG.textContent = String(grand - rounds[animateIndex].scores[pid].total); tdG.dataset.animateGrand = String(grand);
    }
    trg.appendChild(tdG);
    tbody.appendChild(trg);
    table.appendChild(tbody); scroll.appendChild(table); wrap.appendChild(scroll);
    return wrap;
  }
  function animateSheet(wrap, done) {
    var cells = Array.prototype.slice.call(wrap.querySelectorAll('td[data-animate]'));
    var totalCell = wrap.querySelector('td[data-animate-total]');
    var grandCell = wrap.querySelector('td[data-animate-grand]');
    var i = 0;
    function nextCell() {
      if (i < cells.length) {
        var td = cells[i++]; var ps = td.querySelector('.pts'); ps.style.visibility = ''; td.classList.add('filling');
        setTimeout(nextCell, 220);
      } else if (totalCell) {
        countUp(totalCell, 0, +totalCell.dataset.animateTotal, 600, function () {
          if (grandCell) countUp(grandCell, +grandCell.textContent, +grandCell.dataset.animateGrand, 700, done); else if (done) done();
        });
      } else if (done) done();
    }
    nextCell();
  }
  function countUp(node, from, to, dur, done) {
    var start = performance.now();
    function step(t) {
      var p = clamp((t - start) / dur, 0, 1); var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = String(Math.round(from + (to - from) * eased));
      if (p < 1) requestAnimationFrame(step); else if (done) done();
    }
    requestAnimationFrame(step);
  }
  var popover = null;
  function closePopover() { if (popover) { popover.remove(); popover = null; } }
  document.addEventListener('click', function (e) {
    var td = e.target.closest && e.target.closest('td.cell');
    closePopover();
    if (!td) return;
    var word = td.dataset.word || ''; var reason = td.dataset.reason || '';
    if (!word && !reason) return;
    popover = el('div', 'cell-popover');
    var pw = el('div', 'pw', word || '(gol)'); popover.appendChild(pw);
    if (reason) popover.appendChild(el('div', 'muted small', reason));
    document.body.appendChild(popover);
    var rect = td.getBoundingClientRect();
    var top = rect.bottom + 6; var left = clamp(rect.left, 8, window.innerWidth - popover.offsetWidth - 8);
    if (top + popover.offsetHeight > window.innerHeight - 8) top = rect.top - popover.offsetHeight - 6;
    popover.style.top = top + 'px'; popover.style.left = left + 'px';
    e.stopPropagation();
  });
  /* Renders tabs + one sheet (phones) or all sheets side by side (wide). */
  function renderSheets(container, opts) {
    opts = opts || {};
    container.innerHTML = '';
    if (!state) return;
    var ids = state.players.map(function (p) { return p.id; });
    var wide = opts.forceAll || (window.matchMedia('(min-width: 900px)').matches && ids.length <= 3) || (opts.sideBySide && window.matchMedia('(min-width: 900px)').matches);
    if (wide) {
      var grid = el('div', 'sheets side-by-side');
      ids.forEach(function (pid) { grid.appendChild(buildSheetTable(pid, opts)); });
      container.appendChild(grid);
      if (opts.animateRound != null && !reducedMotion) grid.querySelectorAll('.sheet-wrap').forEach(function (w) { animateSheet(w); });
      return;
    }
    if (!local.sheetTab || ids.indexOf(local.sheetTab) < 0) local.sheetTab = me.id;
    var tabs = el('div', 'tabs'); tabs.setAttribute('role', 'tablist');
    ids.forEach(function (pid) {
      var b = el('button', null, sheetTitle(pid)); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(pid === local.sheetTab));
      b.addEventListener('click', function () { local.sheetTab = pid; renderSheets(container, Object.assign({}, opts, { animateRound: null })); });
      tabs.appendChild(b);
    });
    container.appendChild(tabs);
    var holder = el('div', 'sheets'); var w = buildSheetTable(local.sheetTab, opts); holder.appendChild(w); container.appendChild(holder);
    if (opts.animateRound != null && !reducedMotion) animateSheet(w);
  }
  function renderSheetLive() {
    if (!state || state.phase !== 'round') return;
    var wide = window.matchMedia('(min-width: 980px)').matches;
    var target = wide ? $('round-sheet-wide') : $('round-sheet');
    if (!wide && !$('round-sheet-panel').open) { $('round-sheet-panel').dataset.dirty = '1'; return; }
    renderSheets(target, { sideBySide: false });
  }
  $('round-sheet-panel').addEventListener('toggle', function () { if ($('round-sheet-panel').open) renderSheetLive(); });

  /* ---------- REVIEW UI ---------- */
  function enterReviewUI(items) {
    local.myReviews = {};
    $('review-round-label').textContent = 'Runda ' + (state.roundIndex + 1) + ' din ' + state.totalRounds + ' · Litera ' + currentRound().letter;
    var list = $('review-list'); list.innerHTML = '';
    var pending = items.filter(function (it) { return it.decided == null; });
    if (!items.length) {
      list.appendChild(el('p', 'muted', 'Nu ai nimic de verificat.'));
    }
    var byTarget = {};
    items.forEach(function (it) { (byTarget[it.targetId] = byTarget[it.targetId] || []).push(it); });
    Object.keys(byTarget).forEach(function (tid) {
      var g = el('div', 'review-group');
      if (state.players.length > 2) g.appendChild(el('h3', null, playerName(tid)));
      byTarget[tid].forEach(function (it) {
        var c = catById(it.cat);
        var row = el('div', 'review-item'); row.dataset.target = it.targetId; row.dataset.cat = it.cat;
        var left = el('div'); left.appendChild(el('div', 'word', it.word)); left.appendChild(el('div', 'cat', c.icon + ' ' + c.label + (state.players.length <= 2 ? '' : ' · ' + playerName(it.targetId))));
        var actions = el('div', 'actions');
        var bA = el('button', 'btn ok', 'Acceptă'); bA.type = 'button'; var bR = el('button', 'btn danger', 'Respinge'); bR.type = 'button';
        bA.addEventListener('click', function () { decide(row, it, true); }); bR.addEventListener('click', function () { decide(row, it, false); });
        actions.appendChild(bA); actions.appendChild(bR);
        row.appendChild(left); row.appendChild(actions);
        if (it.decided != null) markDecided(row, it.decided);
        g.appendChild(row);
      });
      list.appendChild(g);
    });
    show($('btn-accept-all'), pending.length > 0);
    $('btn-accept-all').onclick = function () {
      list.querySelectorAll('.review-item:not(.decided)').forEach(function (row) {
        decide(row, { targetId: row.dataset.target, cat: row.dataset.cat }, true, true);
      });
      flushDecisions();
    };
    show($('review-wait'), pending.length === 0);
    renderSheets($('review-sheet'), {});
    showScreen('review');
  }
  function markDecided(row, accept) {
    row.classList.add('decided', accept ? 'acc' : 'rej');
    row.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
  }
  function decide(row, it, accept, deferFlush) {
    if (row.classList.contains('decided')) return;
    markDecided(row, accept);
    local.myReviews[it.targetId + ':' + it.cat] = { targetId: it.targetId, cat: it.cat, accept: accept };
    if (!deferFlush) flushDecisions();
  }
  function flushDecisions() {
    var decisions = Object.keys(local.myReviews).map(function (k) { return local.myReviews[k]; });
    if (!decisions.length) return;
    var remaining = $('review-list').querySelectorAll('.review-item:not(.decided)').length;
    if (remaining === 0) { show($('btn-accept-all'), false); show($('review-wait'), true); }
    if (me.isHost) hostApplyDecisions(me.id, decisions);
    else sendToHost('reviewDecision', { roundIndex: state.roundIndex, decisions: decisions });
  }

  /* ---------- RESULTS UI ---------- */
  function renderTotals(container, opts) {
    container.innerHTML = '';
    var r = currentRound();
    var totals = state.players.map(function (p) { return { id: p.id, name: p.name, round: r && r.scores && r.scores[p.id] ? r.scores[p.id].total : 0, grand: grandTotal(p.id) }; });
    var best = Math.max.apply(null, totals.map(function (t) { return t.grand; }));
    totals.forEach(function (t) {
      var box = el('div', 'total-box' + (t.id === me.id ? ' me' : '') + (opts && opts.final && t.grand === best ? ' winner' : ''));
      box.appendChild(el('div', 'name', t.name));
      box.appendChild(el('div', 'round', String(opts && opts.final ? t.grand : t.round)));
      box.appendChild(el('div', 'grand', opts && opts.final ? 'Total general' : 'Total general: ' + t.grand));
      container.appendChild(box);
    });
  }
  function enterResultsUI(noAnimate) {
    var r = currentRound();
    $('results-round-label').textContent = 'Runda ' + (state.roundIndex + 1) + ' din ' + state.totalRounds + ' · Litera ' + r.letter;
    renderTotals($('results-totals'), {});
    $('results-note').textContent = r.note || ''; show($('results-note'), !!r.note);
    show($('btn-next-round'), me.isHost); show($('results-wait'), !me.isHost);
    $('btn-next-round').textContent = state.roundIndex + 1 >= state.totalRounds ? 'Vezi rezultatul final' : 'Runda următoare';
    renderSheets($('results-sheet'), { animateRound: noAnimate ? null : state.roundIndex, sideBySide: true });
    showScreen('results');
    if (r.scores && r.scores[me.id]) rememberAcceptedFromRound(r);
    vibrate(30);
  }
  function rememberAcceptedFromRound(r) {
    Object.keys(r.reviews || {}).forEach(function (k) {
      var it = r.reviews[k]; var ev = r.evals && r.evals[it.targetId] && r.evals[it.targetId][it.cat];
      if (ev && ev.status === 'valid') rememberAccepted(it.cat, it.key);
    });
  }
  function enterGameOverUI() {
    var totals = state.players.map(function (p) { return { id: p.id, grand: grandTotal(p.id) }; });
    var best = Math.max.apply(null, totals.map(function (t) { return t.grand; }));
    var winners = totals.filter(function (t) { return t.grand === best; });
    var v = $('verdict'); v.className = 'verdict';
    var iWin = winners.some(function (w) { return w.id === me.id; });
    if (winners.length > 1 && iWin) { v.textContent = 'Egalitate!'; v.classList.add('tie'); }
    else if (iWin) { v.textContent = 'Ai câștigat!'; v.classList.add('win'); if (!reducedMotion) confetti(); }
    else { v.textContent = 'Ai pierdut'; v.classList.add('lose'); }
    if (!iWin) v.textContent += ' · A câștigat ' + joinNames(winners.map(function (w) { return playerName(w.id); }));
    renderTotals($('final-totals'), { final: true });
    show($('btn-rematch'), me.isHost); show($('gameover-wait'), !me.isHost);
    renderSheets($('final-sheet'), { sideBySide: true });
    showScreen('gameover');
    var lastRound = state.rounds[state.rounds.length - 1]; if (lastRound) rememberAcceptedFromRound(lastRound);
    vibrate(iWin ? [80, 60, 80, 60, 120] : 60);
  }
  function confetti() {
    var cv = $('confetti'); var ctx = cv.getContext('2d'); if (!ctx) return;
    cv.width = window.innerWidth; cv.height = window.innerHeight; show(cv, true);
    var colors = ['#c2410c', '#1d4ed8', '#15803d', '#be185d', '#f59e0b', '#0e7490'];
    var parts = []; for (var i = 0; i < 140; i++) parts.push({ x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.5, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3, s: 6 + Math.random() * 6, c: colors[i % colors.length], r: Math.random() * Math.PI });
    var start = performance.now();
    function frame(t) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      parts.forEach(function (p) { p.x += p.vx; p.y += p.vy; p.r += 0.05; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore(); });
      if (t - start < 3500) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, cv.width, cv.height); show(cv, false); }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- leaving ---------- */
  function newGame() {
    try { if (room.conn) room.conn.close(); } catch (e) { /* ignore */ }
    try { if (room.server) room.server.close(); } catch (e) { /* ignore */ }
    Object.keys(room.conns).forEach(function (k) { try { room.conns[k].close(); } catch (e) { /* ignore */ } });
    Object.keys(local.hostTimers).forEach(function (k) { clearTimeout(local.hostTimers[k]); clearInterval(local.hostTimers[k]); });
    clearInterval(local.pingTimer); clearInterval(local.timerInterval); clearTimeout(local.reconnectTimer);
    room = { code: '', server: null, conn: null, conns: {} };
    state = null; me = { name: me.name, id: null, isHost: false };
    local.answers = {}; local.lastRoundShown = -1; local.sheetTab = null;
    ssSet(SS_SESSION, null); setConnBar('');
    show($('btn-resume'), false);
    $('btn-create').disabled = false; $('btn-join').disabled = false;
    showScreen('start');
  }

  /* ---------- wiring ---------- */
  function wire() {
    initStart();
    ['set-round', 'set-grace', 'set-rounds', 'set-hard'].forEach(function (id) { $(id).addEventListener('change', function () { if (me.isHost) hostSettingsChanged(); }); });
    $('btn-start').addEventListener('click', function () { if (me.isHost) hostStartGame(); });
    $('btn-copy-code').addEventListener('click', function () { copyText(room.code, 'Codul a fost copiat'); });
    $('lobby-leave').addEventListener('click', newGame);
    $('btn-finish').addEventListener('click', pressFinish);
    $('btn-mute').addEventListener('click', function () { muted = !muted; lsSet(LS_MUTE, muted ? '1' : '0'); updateMuteButton(); if (!muted) tick(); });
    updateMuteButton();
    $('btn-next-round').addEventListener('click', function () { if (me.isHost) hostNextRound(); });
    $('btn-rematch').addEventListener('click', function () { if (me.isHost) hostRematch(); });
    $('btn-new-game').addEventListener('click', newGame);
    window.addEventListener('resize', function () { if (state && state.phase === 'round') { var wide = window.matchMedia('(min-width: 980px)').matches; show($('round-sheet-wide'), wide); show($('round-sheet-panel'), !wide); renderSheetLive(); } });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && state && state.phase === 'round') requestWakeLock(); });
    window.addEventListener('pagehide', function () { saveSession(); });
  }
  wire();

  /* Hidden hooks for automated tests only. */
  window.__tomapantDev = {
    transport: TRANSPORT_KIND,
    getState: function () { return state; },
    getMe: function () { return me; },
    getLocal: function () { return { deadline: local.deadline, closeAt: local.closeAt, rtt: local.rtt, finished: local.finished, locked: local.locked, answers: local.answers }; },
    disconnect: function () { if (room.conn) room.conn.close(); },
    libraryBuildMs: LIB.__buildMs,
    librarySizes: (function () { var o = {}; CATS.forEach(function (c) { o[c.id] = LIB[c.id] ? LIB[c.id].size : 0; }); return o; })()
  };
})();
