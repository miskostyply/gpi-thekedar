/* GPI Thekedar Entry - web app
 * The server (Google Apps Script) decides IN FACTORY / OUT OF FACTORY / LOCATION UNVERIFIED.
 * This page only reads GPS when the contractor presses "Record entry", during an entry window.
 * Browsers cannot read GPS in the background, so there is no automatic tracking here. */
(function () {
  'use strict';

  var APP_VERSION = '1.0.0';
  var CFG = window.GPI_CONFIG || {};
  var API = String(CFG.API_URL || '').trim();
  var K = { token: 'gpi.token', me: 'gpi.me', state: 'gpi.state', queue: 'gpi.queue' };
  var STATUS = { IN: 'IN FACTORY', OUT: 'OUT OF FACTORY', UNV: 'LOCATION UNVERIFIED' };
  var HI = {
    'IN FACTORY': 'फैक्ट्री के अंदर',
    'OUT OF FACTORY': 'फैक्ट्री के बाहर',
    'LOCATION UNVERIFIED': 'लोकेशन की पुष्टि नहीं हुई'
  };
  var RANK = { 'IN FACTORY': 3, 'OUT OF FACTORY': 2, 'LOCATION UNVERIFIED': 1 };

  // ---------------------------------------------------------------- storage
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) { } }

  var token = load(K.token, null);
  var me = load(K.me, null);
  var st = load(K.state, {});       // offsetMs, schedule, settings, today[], thisWindow, lastEntry
  var busy = false, perm = 'unknown', installEvt = null, lastBandKey = '', flushing = null;

  function queue() { return load(K.queue, []); }
  function setQueue(q) { save(K.queue, q); }
  function myQueue() { return me ? queue().filter(function (q) { return q.cid === me.id; }) : []; }
  function saveState() { save(K.state, st); }

  var $ = function (id) { return document.getElementById(id); };
  function setText(id, t) { $(id).textContent = t == null ? '' : String(t); }

  // ---------------------------------------------------------------- time helpers
  function nowServer() { return Date.now() + (st.offsetMs || 0); }
  function hhmm(ms) { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + x).slice(-2); }
  function niceTime(ms) { var d = new Date(ms); return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ', ' + hhmm(ms); }
  // Same formula as the server: windows repeat every periodMs and last windowMs.
  function windowAt(t) {
    var s = st.schedule;
    if (!s || !s.configured) return null;
    var d = ((t - s.refStartMs) % s.periodMs + s.periodMs) % s.periodMs;
    var start = t - d;
    return { inside: d < s.windowMs, startMs: start, endMs: start + s.windowMs, nextStartMs: start + s.periodMs };
  }
  function accMax() { return (st.settings && st.settings.accuracyMaxM) || 100; }

  // ---------------------------------------------------------------- server calls
  var URL_OK = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
  function post(body) {
    if (!URL_OK.test(API)) {
      return Promise.reject({ error: 'CONFIG', message: 'This app is not set up yet: the server address (API_URL in config.js) is missing or wrong. Tell the GPI administrator.' });
    }
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), cache: 'no-store', redirect: 'follow' })
      .then(function (r) {
        if (!r.ok) throw { error: 'HTTP_' + r.status };
        return r.json().catch(function () { throw { error: 'BAD_RESPONSE' }; });
      }, function () { throw { error: 'NETWORK' }; });
  }

  // ---------------------------------------------------------------- login / logout
  function showLogin(message) {
    $('loginView').classList.remove('hidden'); $('homeView').classList.add('hidden');
    setText('who', ''); setText('loginMsg', message || '');
  }
  function showHome() {
    $('loginView').classList.add('hidden'); $('homeView').classList.remove('hidden');
    setText('who', me ? me.name + ' (' + me.id + ')' : '');
    render();
  }
  function doLogin() {
    setText('loginMsg', '');
    if (!$('consent').checked) { setText('loginMsg', 'Tick "I understand and agree" before logging in.'); return; }
    var id = $('lid').value.trim().toUpperCase(), pin = $('lpin').value;
    if (!id || !pin) { setText('loginMsg', 'Enter your contractor ID and PIN.'); return; }
    $('loginBtn').disabled = true; setText('loginBtn', 'Logging in…');
    post({ action: 'login', id: id, pin: pin }).then(function (r) {
      if (!r.ok) { setText('loginMsg', r.message || 'Login failed.'); return; }
      var sameUser = me && me.id === r.id;
      token = r.token; me = { id: r.id, name: r.name };
      save(K.token, token); save(K.me, me);
      if (!sameUser) st = {};
      st.settings = r.settings; saveState();
      $('lpin').value = '';
      showHome();
      refreshStatus().then(function () { return flush(); });
    }).catch(function (e) {
      setText('loginMsg', e.error === 'CONFIG' ? e.message : 'No connection to the server. Check your internet and try again.');
    }).then(function () { $('loginBtn').disabled = false; setText('loginBtn', 'Log in'); });
  }
  function sessionEnded() {
    token = null; drop(K.token);
    showLogin('Your login has ended. Log in again. Entries saved on this phone will be sent after you log in.');
  }
  function doLogout() {
    var n = myQueue().length;
    var go = function () {
      if (me) setQueue(queue().filter(function (q) { return q.cid !== me.id; }));
      token = null; me = null; st = {};
      drop(K.token); drop(K.me); drop(K.state);
      showLogin('');
    };
    if (!n) { go(); return; }
    ask('Entries not sent yet', n + ' entr' + (n === 1 ? 'y has' : 'ies have') + ' not reached the server. If you log out now, ' + (n === 1 ? 'it' : 'they') + ' will be deleted from this phone.',
      [{ label: 'Stay logged in', main: true }, { label: 'Log out and delete', fn: go }]);
  }

  // ---------------------------------------------------------------- status from server
  function refreshStatus() {
    if (!token) return Promise.resolve();
    return post({ action: 'status', token: token }).then(function (r) {
      if (!r.ok) { if (r.error === 'AUTH') sessionEnded(); return; }
      st.offsetMs = r.serverNowMs - Date.now();
      st.schedule = r.schedule; st.today = r.today || []; st.settings = r.settings || st.settings;
      st.thisWindow = r.schedule && r.schedule.open ? { startMs: r.schedule.currentStartMs, status: r.schedule.thisWindowStatus || '' } : null;
      if (r.lastEntry && r.lastEntry.ms && (!st.lastEntry || r.lastEntry.ms > st.lastEntry.ms)) {
        st.lastEntry = { ms: r.lastEntry.ms, status: r.lastEntry.status, verification: r.lastEntry.result };
      }
      st.statusAt = Date.now();
      saveState(); render();
    }).catch(function () { render(); });
  }

  // ---------------------------------------------------------------- offline queue + sync
  function flush() {
    if (flushing) return flushing;
    flushing = (function round(n) {
      var mine = myQueue();
      if (!token || !mine.length || n > 10) return Promise.resolve(mine.length ? 'RETRY' : 'DONE');
      var batch = mine.slice(0, 20), now = nowServer();
      var recs = batch.map(function (q) { var r = JSON.parse(JSON.stringify(q.rec)); r.queued = now - r.captureMs > 60000; return r; });
      return post({ action: 'submitRecords', token: token, records: recs }).then(function (r) {
        if (!r.ok) { if (r.error === 'AUTH') { sessionEnded(); return 'AUTH'; } return 'RETRY'; }
        var done = {};
        (r.results || []).forEach(function (x) {
          done[x.recordId] = true;
          if (x.result === 'ACCEPTED') applyResult(x, batch);
        });
        if (!Object.keys(done).length) return 'RETRY';
        setQueue(queue().filter(function (q) { return !done[q.rec.recordId]; }));
        saveState();
        return round(n + 1);
      }, function () { return 'OFFLINE'; });
    })(0).then(function (res) { flushing = null; render(); return res; });
    return flushing;
  }

  function applyResult(x, batch) {
    var q = batch.filter(function (b) { return b.rec.recordId === x.recordId; })[0];
    if (!q || q.rec.type !== 'ENTRY') return;
    var cap = q.rec.captureMs;
    if (!st.lastEntry || cap >= st.lastEntry.ms) {
      st.lastEntry = { ms: cap, status: x.status, verification: x.verification, distanceM: x.distanceM, branch: x.branch, remark: x.remark };
    }
    if (x.windowStartMs) {
      var cur = st.thisWindow;
      if (cur && cur.startMs === x.windowStartMs && (RANK[x.status] || 0) > (RANK[cur.status] || 0)) cur.status = x.status;
      else if (!cur) { var w = windowAt(nowServer()); if (w && w.inside && w.startMs === x.windowStartMs) st.thisWindow = { startMs: x.windowStartMs, status: x.status }; }
      (st.today || []).forEach(function (t) { if (t.startMs === x.windowStartMs && (RANK[x.status] || 0) > (RANK[t.status] || 0)) t.status = x.status; });
    }
  }

  // ---------------------------------------------------------------- GPS
  function getFix() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) { resolve({ fail: 'NOT_SUPPORTED' }); return; }
      navigator.geolocation.getCurrentPosition(function (p) {
        perm = 'granted';
        resolve({ fix: { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ageMs: Math.max(0, Date.now() - p.timestamp) } });
      }, function (e) {
        if (e && e.code === 1) perm = 'denied';
        resolve({ fail: e && e.code === 1 ? 'PERMISSION_DENIED' : e && e.code === 3 ? 'TIMEOUT' : 'POSITION_UNAVAILABLE' });
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function deviceInfo() {
    var ua = navigator.userAgent || '', m = /\(([^)]+)\)/.exec(ua);
    return ('Web ' + APP_VERSION + ' / ' + (m ? m[1] : 'browser')).slice(0, 110);
  }

  // ---------------------------------------------------------------- ENTRY
  function doEntry() {
    var w = windowAt(nowServer());
    if (!w || !w.inside || busy) { render(); return; }
    setBusy('Finding your location… keep the phone still and stay in the open.');
    getFix().then(function (res) {
      setBusy('');
      if (!token || !me) return; // logged out (or login ended) while GPS was searching
      if (res.fail) { askFailed(res); return; }
      if (res.fix.acc > accMax()) { askInaccurate(res); return; }
      submit(res);
    });
  }

  function askFailed(res) {
    var why = {
      PERMISSION_DENIED: 'Location is blocked for this app.\nIn Chrome tap the icon left of the address bar (or menu > Settings > Site settings > Location) and choose Allow. Then try again.',
      POSITION_UNAVAILABLE: 'Your phone could not find its location.\nTurn on Location in the phone settings and move to an open area.',
      TIMEOUT: 'GPS took too long.\nMove to an open area, away from roofs and walls, and try again.',
      NOT_SUPPORTED: 'This browser cannot read GPS. Open the app in Google Chrome.'
    }[res.fail];
    ask('Location not available', why + '\n\nIf you record it now, it will be saved as LOCATION UNVERIFIED.', [
      { label: 'Try again', main: true, fn: doEntry },
      { label: 'Record as unverified', fn: function () { submit(res); } },
      { label: 'Cancel' }
    ]);
  }

  function askInaccurate(res) {
    ask('Location not accurate enough', 'Your GPS accuracy is about ' + Math.round(res.fix.acc) + ' m, but ' + accMax() + ' m or better is needed to verify your entry.\nMove to an open area and try again.\n\nIf you record it now, it will be saved as LOCATION UNVERIFIED.', [
      { label: 'Try again', main: true, fn: doEntry },
      { label: 'Record as unverified', fn: function () { submit(res); } },
      { label: 'Cancel' }
    ]);
  }

  function submit(res) {
    if (!token || !me) { showLogin('Your login has ended. Log in again, then record the entry.'); return; }
    // Server-corrected time, so a slightly wrong phone clock does not push an entry outside its window.
    var rec = { recordId: uuid(), type: 'ENTRY', captureMs: Math.round(nowServer()), device: deviceInfo(), mock: false };
    if (res.fix) {
      rec.captureResult = 'SUCCESS'; rec.lat = res.fix.lat; rec.lon = res.fix.lon; rec.accuracy = res.fix.acc; rec.fixAgeMs = res.fix.ageMs;
    } else {
      rec.captureResult = 'FAILED'; rec.failReason = res.fail;
    }
    var q = queue(); q.push({ cid: me.id, rec: rec }); setQueue(q); // saved on the phone first - never lost on a bad connection
    var before = st.lastEntry ? st.lastEntry.ms : 0;
    setBusy('Sending…');
    flush().then(function (r) {
      setBusy('');
      if (r === 'DONE' && st.lastEntry && st.lastEntry.ms > before) return; // result card shows the server's decision
      if (r === 'AUTH') return;
      ask('Saved on this phone', r === 'OFFLINE'
        ? 'There is no internet right now. Your entry is saved and will be sent automatically when the internet is back while this app is open, or the next time you open it.\nIt still counts for this window because it was recorded now.'
        : 'The server did not answer. Your entry is saved and will be sent again automatically.', [{ label: 'OK', main: true }]);
    });
  }

  // ---------------------------------------------------------------- UI
  function setBusy(t) { busy = !!t; setText('busy', t); render(); }

  function ask(title, text, buttons) {
    setText('dTitle', title); setText('dText', text);
    var box = $('dActions'); box.innerHTML = '';
    buttons.forEach(function (b) {
      var el = document.createElement('button');
      el.type = 'button'; el.textContent = b.label; if (b.main) el.className = 'main';
      el.addEventListener('click', function () { $('dialog').classList.add('hidden'); if (b.fn) b.fn(); });
      box.appendChild(el);
    });
    $('dialog').classList.remove('hidden');
    box.firstChild.focus();
  }

  function cls(status) { return status === STATUS.IN ? 'in' : status === STATUS.OUT ? 'out' : status === STATUS.UNV ? 'unv' : ''; }

  function render() {
    if (!token || !me) return;
    renderBand(); renderResult(); renderPunch(); renderChecks();
  }

  function renderBand() {
    var band = $('windowBand'), btn = $('entryBtn'), s = st.schedule, now = nowServer();
    band.classList.remove('open', 'unset');
    var label = 'Record entry', hiLabel = 'एंट्री दर्ज करें', enabled = false;
    if (!s) {
      setText('wState', 'Checking entry times…'); setText('wTime', '--:--'); setText('wHi', '');
    } else if (!s.configured) {
      band.classList.add('unset');
      setText('wState', 'Entry times are not set yet'); setText('wTime', '--:--');
      setText('wHi', 'एंट्री का समय अभी तय नहीं है। GPI से संपर्क करें।');
      label = 'Not available yet';
    } else {
      var w = windowAt(now);
      var savedHere = myQueue().some(function (q) { return w && q.rec.captureMs >= w.startMs && q.rec.captureMs < w.endMs; });
      if (w.inside) {
        band.classList.add('open');
        setText('wState', 'Entry window is open until ' + hhmm(w.endMs));
        setText('wTime', mmss(w.endMs - now) + ' left');
        setText('wHi', 'एंट्री का समय चालू है');
        var done = st.thisWindow && st.thisWindow.startMs === w.startMs ? st.thisWindow.status : '';
        if (done === STATUS.IN) { label = 'Entry done for this window'; hiLabel = 'इस समय की एंट्री हो गई'; }
        else if (savedHere) { label = 'Entry saved, waiting to send'; hiLabel = 'एंट्री फ़ोन में सेव है'; }
        else { enabled = true; if (done) label = 'Record entry again'; }
      } else {
        setText('wState', 'Next entry window opens at ' + hhmm(w.nextStartMs));
        setText('wTime', 'in ' + mmss(w.nextStartMs - now));
        setText('wHi', 'अभी एंट्री का समय नहीं है');
        label = 'Entry closed now'; hiLabel = 'अभी एंट्री बंद है';
      }
      // refresh from the server when a window opens or closes
      var key = w.inside + ':' + w.startMs;
      if (lastBandKey && key !== lastBandKey && navigator.onLine !== false) { refreshStatus(); flush(); }
      lastBandKey = key;
    }
    btn.disabled = !enabled || busy;
    setText('entryLabel', busy ? 'Please wait…' : label); setText('entryHi', hiLabel);
  }

  function renderResult() {
    var e = st.lastEntry, box = $('result');
    box.className = 'result ' + (e ? cls(e.status) : '');
    if (!e) { setText('rStatus', 'No entry yet'); setText('rHi', ''); setText('rDetail', 'Press Record entry when the entry window is open.'); return; }
    setText('rStatus', e.status || '—'); setText('rHi', HI[e.status] || '');
    var lines = [niceTime(e.ms)];
    if (e.distanceM != null && e.distanceM !== '' && e.branch) lines[0] += ' · ' + e.distanceM + ' m from ' + e.branch;
    if (e.status === STATUS.OUT) lines.push('You were outside the approved factory area.');
    if (e.status === STATUS.UNV && e.verification) lines.push(readableReason(e.verification));
    if (e.remark === 'OUTSIDE WINDOW') lines.push('Recorded outside the entry window, so it does not count for a window.');
    setText('rDetail', lines.join('\n'));
  }

  function readableReason(v) {
    var map = {
      ACCURACY_TOO_LOW: 'GPS was not accurate enough.', CAPTURE_FAILED: 'GPS location was not available.', STALE_FIX: 'The GPS reading was old.',
      CLOCK_SKEW: "Your phone's clock is wrong. Turn on automatic date and time.", DEVICE_CLOCK_AHEAD: "Your phone's clock is wrong. Turn on automatic date and time.",
      IMPLAUSIBLE_JUMP: 'The location changed too fast to be real.', ACCURACY_UNKNOWN: 'GPS accuracy was unknown.', NO_FIX_AGE: 'GPS reading time was missing.'
    };
    for (var k in map) if (v.indexOf(k) >= 0) return map[k];
    return v;
  }

  function renderPunch() {
    var ol = $('punch'); ol.innerHTML = '';
    var list = st.today || [], now = nowServer(), mine = myQueue();
    if (!list.length) { var li0 = document.createElement('li'); li0.textContent = st.schedule && !st.schedule.configured ? 'Not set yet' : 'No data yet'; ol.appendChild(li0); return; }
    list.forEach(function (t) {
      var li = document.createElement('li'), b = document.createElement('b'), status = t.status, label;
      b.textContent = hhmm(t.startMs);
      var saved = mine.some(function (q) { return q.rec.captureMs >= t.startMs && q.rec.captureMs < t.endMs; });
      if (status === 'PENDING' && now >= t.endMs) status = saved ? 'SAVED' : 'MISSED';
      if (saved && (status === 'PENDING' || status === 'MISSED')) status = 'SAVED';
      if (status === STATUS.IN) { li.className = 'in'; label = 'In'; }
      else if (status === STATUS.OUT) { li.className = 'out'; label = 'Out'; }
      else if (status === STATUS.UNV) { li.className = 'unv'; label = 'Unverified'; }
      else if (status === 'MISSED') { li.className = 'missed'; label = 'Missed'; }
      else if (status === 'PENDING') { li.className = 'now'; label = 'Open now'; }
      else if (status === 'SAVED') { li.className = 'saved'; label = 'Saved'; }
      else if (status === 'UPCOMING') { label = 'Later'; }
      else { label = '—'; }
      li.appendChild(b); li.appendChild(document.createTextNode(label));
      li.setAttribute('aria-label', hhmm(t.startMs) + ' ' + label);
      ol.appendChild(li);
    });
  }

  function renderChecks() {
    var ul = $('checks'); ul.innerHTML = '';
    function row(name, value, kind, note) {
      var li = document.createElement('li'), a = document.createElement('span'), v = document.createElement('span');
      a.textContent = name; v.className = 'v ' + kind; v.textContent = value;
      if (note) { var n = document.createElement('span'); n.className = 'note'; n.textContent = note; v.appendChild(n); }
      li.appendChild(a); li.appendChild(v); ul.appendChild(li);
    }
    var p = perm === 'granted' ? ['Allowed', 'ok', ''] : perm === 'denied' ? ['Blocked', 'bad', 'Allow it in Chrome: icon left of the address bar > Location'] : ['Asked when you record', 'warn', ''];
    row('Location permission', p[0], p[1], p[2]);
    row('Internet', navigator.onLine === false ? 'Offline' : 'Online', navigator.onLine === false ? 'bad' : 'ok', '');
    var n = myQueue().length;
    if (n) row('Waiting to send', n + ' entr' + (n === 1 ? 'y' : 'ies'), 'warn', 'Sent automatically when online');
    var off = Math.abs(st.offsetMs || 0);
    if (off > 120000) row("Phone's clock", Math.round(off / 60000) + ' min wrong', 'bad', 'Turn on automatic date and time');
    if (st.statusAt) row('Last checked with server', hhmm(st.statusAt), 'ok', '');

    // reminders: list of the day's window times
    var s = st.schedule;
    if (s && s.configured) {
      var times = [];
      for (var t = s.refStartMs; t < s.refStartMs + 86400000; t += s.periodMs) times.push(hhmm(t));
      times.sort();
      setText('alarmText', 'This app cannot remind you by itself. Set phone alarms for these times every day: ' + times.join(', ') + '. Each window stays open for ' + Math.round(s.windowMs / 60000) + ' minutes.');
    } else setText('alarmText', 'Entry times will appear here once GPI sets them.');
  }

  // ---------------------------------------------------------------- startup
  function start() {
    setText('foot', 'GPI Thekedar Entry ' + APP_VERSION);
    $('loginBtn').addEventListener('click', doLogin);
    $('lpin').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('entryBtn').addEventListener('click', doEntry);
    $('logoutBtn').addEventListener('click', doLogout);
    $('installBtn').addEventListener('click', function () { if (installEvt) { installEvt.prompt(); installEvt = null; $('installBtn').classList.add('hidden'); } });

    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; $('installBtn').classList.remove('hidden'); });
    window.addEventListener('online', function () { flush().then(refreshStatus); });
    window.addEventListener('offline', render);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && token) { refreshStatus(); flush(); } });

    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(function (p) {
        perm = p.state; render(); p.onchange = function () { perm = p.state; render(); };
      }).catch(function () { });
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { });

    if (token && me) { showHome(); refreshStatus().then(function () { return flush(); }); }
    else showLogin('');

    setInterval(function () { if (token && me && document.visibilityState !== 'hidden') renderBand(); }, 1000);
    setInterval(function () { if (token && document.visibilityState !== 'hidden') { if (myQueue().length) flush(); refreshStatus(); } }, 5 * 60000);
  }

  // test hook (harmless in production): lets automated tests drive the app
  window.__gpi = { flush: flush, refreshStatus: refreshStatus, render: render, state: function () { return st; }, queue: queue };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
