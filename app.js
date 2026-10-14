(function(){
'use strict';

var APP_VERSION = 'scribe-v1';
var RATE = 16000;
var LIVE_MIN = 12 * RATE;       // live slices are cut at a quiet point between 12 and 18 seconds
var LIVE_MAX = 18 * RATE;
var FILE_SLICE = 240 * RATE;    // imported audio is cut into slices of about 4 minutes
var SILENCE_RMS = 0.0035;
var NOISE_TAG = /^\s*[\[\(][^\]\)]*[\]\)]\s*$/;

var MODELS = {
  tiny:  { id: 'onnx-community/whisper-tiny.en',  label: 'Tiny',  size: 'about 43 MB',  note: 'Fastest, roughest. Fine for clear speech.' },
  base:  { id: 'onnx-community/whisper-base.en',  label: 'Base',  size: 'about 80 MB',  note: 'Balanced. Recommended.' },
  small: { id: 'onnx-community/whisper-small.en', label: 'Small', size: 'about 250 MB', note: 'Most accurate. Slow on most phones.' }
};

/* ---------- small helpers ---------- */
function $(id){ return document.getElementById(id); }
function el(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function abs(path){ return new URL(path, location.href).href; }
function pad(n){ return (n < 10 ? '0' : '') + n; }
function clock(sec){
  sec = Math.max(0, Math.floor(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}
function srtTime(sec){
  var ms = Math.round((sec || 0) * 1000);
  var h = Math.floor(ms / 3600000); ms -= h * 3600000;
  var m = Math.floor(ms / 60000); ms -= m * 60000;
  var s = Math.floor(ms / 1000); ms -= s * 1000;
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + (ms < 100 ? (ms < 10 ? '00' : '0') : '') + ms;
}
function dateLabel(ms){
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function concat(list){
  var n = 0; list.forEach(function(a){ n += a.length; });
  var out = new Float32Array(n), o = 0;
  list.forEach(function(a){ out.set(a, o); o += a.length; });
  return out;
}
function rms(a){
  var e = 0, c = 0;
  for (var i = 0; i < a.length; i += 4){ e += a[i] * a[i]; c++; }
  return c ? Math.sqrt(e / c) : 0;
}
// Quietest 0.3 s window between samples from and to; returns the cut position.
function quietCut(a, from, to){
  var win = 4800, hop = 1600, best = Math.min(to, a.length), bestE = Infinity;
  for (var i = from; i + win <= a.length && i <= to; i += hop){
    var e = 0;
    for (var k = i; k < i + win; k += 4) e += a[k] * a[k];
    if (e < bestE){ bestE = e; best = i + (win >> 1); }
  }
  return Math.min(best, a.length);
}

var LIVE_EMPTY = $('liveEmpty');
var toastTimer = null;
function toast(msg, ms){
  var t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.classList.remove('show'); }, ms || 3600);
}

function sheet(title, body, buttons){
  return new Promise(function(resolve){
    var wrap = $('sheetwrap'), box = $('sheet');
    box.innerHTML = '';
    box.appendChild(el('h3', '', title));
    if (body){ var p = el('p', 'muted', body); box.appendChild(p); }
    function close(v){ wrap.classList.remove('open'); wrap.onclick = null; resolve(v); }
    buttons.forEach(function(b, i){
      var btn = el('button', 'btn' + (b.primary ? ' primary' : ''), b.label);
      btn.addEventListener('click', function(ev){ ev.stopPropagation(); close(b.value !== undefined ? b.value : i); });
      box.appendChild(btn);
    });
    wrap.onclick = function(ev){ if (ev.target === wrap) close(null); };
    wrap.classList.add('open');
  });
}

/* ---------- settings ---------- */
var Settings = {
  data: { model: 'base', keepAudio: true },
  load: function(){
    try { var s = JSON.parse(localStorage.getItem('scribe.settings') || '{}'); if (s.model && MODELS[s.model]) this.data.model = s.model; if (typeof s.keepAudio === 'boolean') this.data.keepAudio = s.keepAudio; } catch (e) {}
  },
  save: function(){ try { localStorage.setItem('scribe.settings', JSON.stringify(this.data)); } catch (e) {} }
};
function modelReady(k){ try { return localStorage.getItem('scribe.ready.' + k) === '1'; } catch (e) { return false; } }

/* ---------- storage (IndexedDB) ---------- */
var DB = (function(){
  var dbp = null;
  function open(){
    if (!dbp) dbp = new Promise(function(res, rej){
      var r = indexedDB.open('scribe', 1);
      r.onupgradeneeded = function(){
        var d = r.result;
        d.createObjectStore('recs', { keyPath: 'id' });
        d.createObjectStore('blobs');
        d.createObjectStore('chunks');
      };
      r.onsuccess = function(){ res(r.result); };
      r.onerror = function(){ rej(r.error); };
    });
    return dbp;
  }
  function req(store, mode, fn){
    return open().then(function(db){
      return new Promise(function(res, rej){
        var t = db.transaction(store, mode), s = t.objectStore(store), r = fn(s);
        t.oncomplete = function(){ res(r ? r.result : undefined); };
        t.onerror = function(){ rej(t.error); };
        t.onabort = function(){ rej(t.error); };
      });
    });
  }
  function chunkKey(id, i){ return id + ':' + ('000000' + i).slice(-6); }
  return {
    putRec: function(rec){ return req('recs', 'readwrite', function(s){ return s.put(rec); }); },
    getRec: function(id){ return req('recs', 'readonly', function(s){ return s.get(id); }); },
    allRecs: function(){ return req('recs', 'readonly', function(s){ return s.getAll(); }); },
    delRec: function(id){
      return Promise.all([
        req('recs', 'readwrite', function(s){ return s.delete(id); }),
        req('blobs', 'readwrite', function(s){ return s.delete(id); }),
        req('chunks', 'readwrite', function(s){ return s.delete(IDBKeyRange.bound(id + ':', id + ':￿')); })
      ]);
    },
    putBlob: function(id, blob){ return req('blobs', 'readwrite', function(s){ return s.put(blob, id); }); },
    getBlob: function(id){ return req('blobs', 'readonly', function(s){ return s.get(id); }); },
    delBlob: function(id){ return req('blobs', 'readwrite', function(s){ return s.delete(id); }); },
    putChunk: function(id, i, blob){ return req('chunks', 'readwrite', function(s){ return s.put(blob, chunkKey(id, i)); }); },
    getChunks: function(id){ return req('chunks', 'readonly', function(s){ return s.getAll(IDBKeyRange.bound(id + ':', id + ':￿')); }); },
    delChunks: function(id){ return req('chunks', 'readwrite', function(s){ return s.delete(IDBKeyRange.bound(id + ':', id + ':￿')); }); },
    wipe: function(){
      return Promise.all(['recs', 'blobs', 'chunks'].map(function(n){ return req(n, 'readwrite', function(s){ return s.clear(); }); }));
    }
  };
})();

/* ---------- transcription engine (worker) ---------- */
var Engine = (function(){
  var worker = null, readyKey = null, loadingKey = null, loadPromise = null;
  var initRes = null, initRej = null, nextId = 1, runs = {};
  var hooks = { download: null, status: null };
  function handle(e){
    var m = e.data;
    if (m.type === 'download'){ if (hooks.download) hooks.download(m.loaded, m.total); }
    else if (m.type === 'status'){ if (hooks.status) hooks.status(m.text); }
    else if (m.type === 'ready'){ if (initRes) initRes(); }
    else if (m.type === 'result'){ var r = runs[m.id]; if (r){ delete runs[m.id]; r.resolve(m); } }
    else if (m.type === 'error'){
      if (m.id != null && runs[m.id]){ var q = runs[m.id]; delete runs[m.id]; q.reject(new Error(m.message)); }
      else if (initRej) initRej(new Error(m.message));
    }
  }
  function spawn(){
    if (worker) return;
    worker = new Worker('worker.js');
    worker.onmessage = handle;
    worker.onerror = function(e){
      var err = new Error('The transcription engine failed to start' + (e && e.message ? ': ' + e.message : ''));
      if (initRej) initRej(err);
      Object.keys(runs).forEach(function(k){ runs[k].reject(err); delete runs[k]; });
      worker = null; readyKey = null; loadingKey = null; loadPromise = null;
    };
  }
  return {
    hooks: hooks,
    isReady: function(k){ return readyKey === k; },
    isLoading: function(){ return !!loadingKey && readyKey !== loadingKey; },
    ensure: function(key){
      if (readyKey === key) return Promise.resolve();
      if (loadingKey === key && loadPromise) return loadPromise;
      spawn();
      loadingKey = key;
      loadPromise = new Promise(function(res, rej){
        initRes = function(){ readyKey = key; try { localStorage.setItem('scribe.ready.' + key, '1'); } catch (e) {} res(); };
        initRej = function(err){ loadingKey = null; loadPromise = null; rej(err); };
      });
      worker.postMessage({ type: 'init', model: MODELS[key].id, tfUrl: abs('vendor/transformers.min.js'), ortBase: abs('vendor/') });
      return loadPromise;
    },
    run: function(samples){
      return new Promise(function(resolve, reject){
        var id = nextId++;
        runs[id] = { resolve: resolve, reject: reject };
        worker.postMessage({ type: 'run', id: id, audio: samples }, [samples.buffer]);
      });
    }
  };
})();

/* serial queue of audio slices to transcribe */
var Queue = (function(){
  var jobs = [], busy = false, listener = null;
  function clean(t){ return (t || '').replace(/\s+/g, ' ').trim(); }
  async function pump(){
    if (busy) return;
    busy = true;
    while (jobs.length){
      var j = jobs.shift();
      notify();
      try { j.resolve(await process(j)); } catch (e){ j.reject(e); }
    }
    busy = false;
    notify();
  }
  async function process(j){
    var dur = j.samples.length / RATE;
    if (rms(j.samples) < SILENCE_RMS) return [];
    var key = Settings.data.model;
    await Engine.ensure(key);
    var r = await Engine.run(j.samples);
    var segs = [];
    (r.chunks || []).forEach(function(c){
      var t = clean(c.text);
      if (!t || NOISE_TAG.test(t)) return;
      var s = j.start + (c.start == null ? 0 : c.start);
      var e = j.start + (c.end == null ? dur : c.end);
      segs.push({ s: s, e: Math.max(e, s), t: t });
    });
    return segs;
  }
  function notify(){ if (listener) listener(jobs.length + (busy ? 1 : 0)); }
  return {
    add: function(samples, startSec){
      return new Promise(function(resolve, reject){
        jobs.push({ samples: samples, start: startSec, resolve: resolve, reject: reject });
        notify();
        pump();
      });
    },
    count: function(){ return jobs.length + (busy ? 1 : 0); },
    onChange: function(fn){ listener = fn; }
  };
})();

/* ---------- audio helpers ---------- */
function Resampler(inRate, outRate){
  this.ratio = inRate / outRate;
  this.pos = 0;
  this.buf = new Float32Array(0);
  var H = 16, fc = 0.45 * outRate / inRate;
  this.H = H;
  this.h = new Float32Array(2 * H + 1);
  var sum = 0, k;
  for (k = -H; k <= H; k++){
    var s = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    var w = 0.54 + 0.46 * Math.cos(Math.PI * k / H);
    this.h[k + H] = s * w; sum += s * w;
  }
  for (k = 0; k < this.h.length; k++) this.h[k] /= sum;
}
Resampler.prototype.push = function(x){
  var H = this.H, h = this.h, ratio = this.ratio;
  var b = new Float32Array(this.buf.length + x.length);
  b.set(this.buf); b.set(x, this.buf.length);
  var out = [], p = this.pos;
  while (Math.round(p) + H < b.length){
    var c = Math.round(p), acc = 0;
    for (var k = -H; k <= H; k++){ var i = c + k; if (i >= 0) acc += b[i] * h[k + H]; }
    out.push(acc);
    p += ratio;
  }
  var keep = Math.max(0, Math.round(p) - H);
  this.buf = b.slice(keep);
  this.pos = p - keep;
  return Float32Array.from(out);
};

async function decodeTo16k(blob){
  var buf = await blob.arrayBuffer();
  var audio = null;
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
    audio = await ctx.decodeAudioData(buf.slice(0));
    ctx.close();
    if (audio.sampleRate !== RATE) audio = null;
  } catch (e) { audio = null; }
  if (!audio){
    var ctx2 = new (window.AudioContext || window.webkitAudioContext)();
    var dec = await ctx2.decodeAudioData(buf.slice(0));
    ctx2.close();
    var off = new OfflineAudioContext(1, Math.ceil(dec.duration * RATE), RATE);
    var src = off.createBufferSource();
    src.buffer = dec; src.connect(off.destination); src.start();
    audio = await off.startRendering();
  }
  var n = audio.numberOfChannels, out = new Float32Array(audio.length), c, i;
  for (c = 0; c < n; c++){
    var d = audio.getChannelData(c);
    for (i = 0; i < out.length; i++) out[i] += d[i] / n;
  }
  return out;
}

/* ---------- recording session ---------- */
var Rec = null;      // the active recording session, or null
var level = 0;       // latest microphone level for the waveform

function setStatus(text, recording){
  $('statusText').textContent = text;
  $('view-record').classList.toggle('recording', !!recording);
  $('recBtn').setAttribute('aria-label', recording ? 'Stop recording' : 'Start recording');
}

async function startRecording(){
  if (Rec) return;
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    toast('This browser cannot record audio. Try Safari on iPhone or Chrome on Android.'); return;
  }
  var ctx = new AC();
  try { ctx.resume(); } catch (e) {}
  var key = Settings.data.model;
  if (!modelReady(key)){
    var go = await sheet('Download the ' + MODELS[key].label + ' model?',
      'First use needs a one-time download (' + MODELS[key].size + '). Wi-Fi is best. You can record straight away and captions will catch up once it has downloaded.',
      [{ label: 'Download and record', primary: true, value: true }, { label: 'Cancel', value: false }]);
    if (!go){ ctx.close(); return; }
  }
  var stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch (e){
    ctx.close();
    toast('Microphone access was blocked. Allow it in your browser settings and try again.', 5000);
    return;
  }
  try { await ctx.audioWorklet.addModule('pcm-tap.js'); }
  catch (e){ stream.getTracks().forEach(function(t){ t.stop(); }); ctx.close(); toast('Could not start the audio recorder: ' + e.message, 5000); return; }

  var now = Date.now();
  var rec = { id: uid(), title: 'Recording ' + dateLabel(now), createdAt: now, duration: 0, mime: '', model: key, status: 'recording', segments: [], flags: [], notes: [], hasAudio: false, source: 'recording' };
  Rec = { rec: rec, ctx: ctx, stream: stream, resampler: new Resampler(ctx.sampleRate, RATE), pending: [], pendingLen: 0, dispatched: 0, total: 0, jobs: [], errors: 0, chunkIdx: 0, chunkWrites: [], stopping: false, hiddenAt: 0, wake: null, timer: null };
  var src = ctx.createMediaStreamSource(stream);
  var node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  var mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);
  Rec.src = src; Rec.node = node; Rec.mute = mute;
  node.port.onmessage = function(e){ if (Rec && !Rec.stopping) feed(Rec.resampler.push(e.data), e.data); };

  try {
    var types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    var mime = '';
    if (window.MediaRecorder){
      for (var i = 0; i < types.length; i++){ if (MediaRecorder.isTypeSupported(types[i])){ mime = types[i]; break; } }
      var mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      rec.mime = mr.mimeType || mime || 'audio/webm';
      mr.ondataavailable = function(ev){
        if (ev.data && ev.data.size){
          var idx = Rec ? Rec.chunkIdx++ : 0;
          var p = DB.putChunk(rec.id, idx, ev.data).catch(function(){});
          if (Rec) Rec.chunkWrites.push(p);
        }
      };
      mr.start(5000);
      Rec.mr = mr;
      rec.hasAudio = true;
    }
  } catch (e){ rec.hasAudio = false; rec.notes.push('Audio could not be saved on this browser. Only the transcript was kept.'); }

  await DB.putRec(rec);
  lockScreen();
  $('wakeBanner').hidden = false;
  if (!('wakeLock' in navigator)) $('wakeBanner').textContent = 'Keep this screen on while recording. This browser cannot do it automatically, so set your phone auto-lock to Never for now.';
  LIVE_EMPTY.hidden = true;
  $('live').textContent = '';
  $('flagBtn').disabled = false;
  $('importBtn').disabled = true;
  setStatus('Recording', true);
  Rec.timer = setInterval(tick, 250);
  Engine.ensure(key).catch(function(err){ toast('Captions are paused: ' + friendlyError(err), 6000); updateEngineLine(); });
  updateEngineLine();
}

function friendlyError(err){
  var m = (err && err.message) || String(err);
  if (/fetch|network|load failed|failed to load|offline/i.test(m)) return 'the model could not be downloaded. Connect to the internet once, then use Re-transcribe on the recording.';
  return m;
}

function feed(samples16k, raw){
  if (!Rec) return;
  var e = 0; for (var i = 0; i < raw.length; i += 8) e += raw[i] * raw[i];
  level = Math.sqrt(e / (raw.length / 8));
  if (!samples16k.length) return;
  Rec.pending.push(samples16k);
  Rec.pendingLen += samples16k.length;
  Rec.total += samples16k.length;
  while (Rec.pendingLen >= LIVE_MAX) dispatchSlice(false);
}

function dispatchSlice(final){
  var all = concat(Rec.pending);
  var cut = final ? all.length : quietCut(all, LIVE_MIN, LIVE_MAX);
  var slice = all.slice(0, cut);
  var rest = all.slice(cut);
  Rec.pending = rest.length ? [rest] : [];
  Rec.pendingLen = rest.length;
  var start = Rec.dispatched / RATE;
  Rec.dispatched += cut;
  if (slice.length < RATE * 0.4) return;
  var session = Rec;
  var p = Queue.add(slice, start).then(function(segs){
    if (!segs.length) return;
    segs.forEach(function(sg){ session.rec.segments.push(sg); addLiveLine(sg); });
    session.rec.duration = session.total / RATE;
    DB.putRec(session.rec).catch(function(){});
  }).catch(function(err){
    session.errors++;
    if (session.errors === 1) toast('Captions are paused: ' + friendlyError(err), 6000);
  });
  Rec.jobs.push(p);
}

function addLiveLine(sg){
  var box = $('live');
  var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  var row = el('div', 'line');
  row.appendChild(el('div', 'ts', clock(sg.s)));
  row.appendChild(el('div', 'tx', sg.t));
  box.appendChild(row);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function tick(){
  if (!Rec) return;
  $('timer').textContent = clock(Rec.total / RATE);
  updateEngineLine();
}

async function lockScreen(){
  try {
    if ('wakeLock' in navigator && Rec){ Rec.wake = await navigator.wakeLock.request('screen'); }
  } catch (e) {}
}

document.addEventListener('visibilitychange', function(){
  if (!Rec || Rec.stopping) return;
  if (document.visibilityState === 'hidden'){ Rec.hiddenAt = Date.now(); return; }
  try { Rec.ctx.resume(); } catch (e) {}
  lockScreen();
  if (Rec.hiddenAt){
    var gap = Math.round((Date.now() - Rec.hiddenAt) / 1000);
    Rec.hiddenAt = 0;
    if (gap > 3){
      Rec.rec.notes.push('The app was in the background for about ' + gap + ' seconds around ' + clock(Rec.total / RATE) + '. That part may not have been recorded.');
      toast('The app was in the background for ' + gap + ' s. That part may not have been recorded.', 6000);
    }
  }
});

async function stopRecording(){
  if (!Rec || Rec.stopping) return;
  var S = Rec;
  S.stopping = true;
  clearInterval(S.timer);
  $('recBtn').disabled = true;
  $('flagBtn').disabled = true;
  $('wakeBanner').hidden = true;
  setStatus('Finishing', false);
  try { S.node.disconnect(); S.src.disconnect(); } catch (e) {}
  S.stream.getTracks().forEach(function(t){ t.stop(); });
  try { if (S.wake) S.wake.release(); } catch (e) {}
  var stopped = Promise.resolve();
  if (S.mr && S.mr.state !== 'inactive'){
    stopped = new Promise(function(res){ S.mr.onstop = function(){ res(); }; });
    try { S.mr.stop(); } catch (e) {}
  }
  try { S.ctx.close(); } catch (e) {}
  Rec = S;
  if (S.pendingLen > 0) dispatchSlice(true);
  await stopped;
  await Promise.all(S.chunkWrites);
  S.rec.duration = S.total / RATE;

  var waiting = setInterval(updateEngineLine, 400);
  await Promise.all(S.jobs);
  clearInterval(waiting);

  var rec = S.rec;
  var failed = S.errors > 0;
  if (rec.hasAudio){
    var chunks = await DB.getChunks(rec.id);
    if (chunks.length && (Settings.data.keepAudio || failed)){
      await DB.putBlob(rec.id, new Blob(chunks, { type: rec.mime || 'audio/webm' }));
    } else { rec.hasAudio = false; }
    await DB.delChunks(rec.id);
  }
  if (failed){ rec.notes.push('Some parts could not be transcribed. Use Re-transcribe to fill the gaps.'); }
  rec.status = 'done';
  await DB.putRec(rec);

  Rec = null;
  level = 0;
  $('timer').textContent = '00:00';
  $('recBtn').disabled = false;
  $('importBtn').disabled = false;
  setStatus('Ready', false);
  $('live').textContent = '';
  LIVE_EMPTY.hidden = false;
  $('live').appendChild(LIVE_EMPTY);
  updateEngineLine();
  toast(rec.segments.length ? 'Saved to your library.' : 'Saved. No speech was picked up.');
  openDetail(rec.id);
}

$('recBtn').addEventListener('click', function(){ if (Rec) stopRecording(); else startRecording(); });
$('flagBtn').addEventListener('click', function(){
  if (!Rec) return;
  var t = Rec.total / RATE;
  Rec.rec.flags.push(t);
  DB.putRec(Rec.rec).catch(function(){});
  var row = el('div', 'flag');
  row.appendChild(el('span', '', 'Flagged at ' + clock(t)));
  $('live').appendChild(row);
  $('live').scrollTop = $('live').scrollHeight;
  if (navigator.vibrate) navigator.vibrate(30);
});

/* ---------- engine status line and model download UI ---------- */
function updateEngineLine(){
  var key = Settings.data.model, M = MODELS[key], line = $('engine');
  var n = Queue.count();
  if (Rec && Rec.stopping){ line.textContent = n ? 'Finishing the transcript: ' + n + (n === 1 ? ' part' : ' parts') + ' left' : 'Saving'; return; }
  if (Rec){
    if (Engine.isLoading() && !Engine.isReady(key)) line.textContent = 'Getting the ' + M.label + ' model ready. Captions will catch up.';
    else line.textContent = n ? 'Transcribing: ' + n + (n === 1 ? ' part' : ' parts') + ' behind' : 'Captions are up to date';
    return;
  }
  line.textContent = modelReady(key) ? M.label + ' model is on this phone' : M.label + ' model not downloaded yet (' + M.size + ')';
}
Queue.onChange(updateEngineLine);

Engine.hooks.download = function(loaded, total){
  var pct = total ? Math.min(100, Math.round(loaded / total * 100)) : 0;
  [['dlbar', 'dlfill'], ['sBar', 'sFill']].forEach(function(p){
    $(p[0]).hidden = pct >= 100; $(p[1]).style.width = pct + '%';
  });
  var mb = (loaded / 1048576).toFixed(0) + ' of ' + (total / 1048576).toFixed(0) + ' MB';
  $('sStatus').textContent = pct >= 100 ? 'Download finished.' : 'Downloading: ' + mb;
  if (Rec && !Rec.stopping) $('engine').textContent = 'Downloading the model: ' + pct + '%. Recording continues.';
  else if (!Rec) $('engine').textContent = 'Downloading the model: ' + pct + '%';
  if (detailBusy) $('dProgText').textContent = 'Downloading the model: ' + pct + '%';
};
Engine.hooks.status = function(text){ $('sStatus').textContent = text; };

/* ---------- waveform ---------- */
var wave = $('wave'), wctx = wave.getContext('2d'), bars = [];
function drawWave(){
  var dpr = window.devicePixelRatio || 1;
  var w = wave.clientWidth, h = wave.clientHeight;
  if (wave.width !== Math.round(w * dpr)){ wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, w, h);
  var step = 5, count = Math.floor(w / step);
  if (!$('view-record').classList.contains('active')){ requestAnimationFrame(drawWave); return; }
  var cs = getComputedStyle(document.documentElement);
  var live = !!Rec && !Rec.stopping;
  wctx.fillStyle = live ? cs.getPropertyValue('--wave') : cs.getPropertyValue('--wave-idle');
  bars.push(live ? Math.min(1, level * 7) : 0);
  while (bars.length > count) bars.shift();
  for (var i = 0; i < bars.length; i++){
    var bh = Math.max(3, bars[i] * (h - 6));
    var x = w - (bars.length - i) * step;
    wctx.fillRect(x, (h - bh) / 2, 3, bh);
  }
  setTimeout(function(){ requestAnimationFrame(drawWave); }, 45);
}

/* ---------- transcribing an audio blob (imports and re-transcribe) ---------- */
var detailBusy = false;

async function transcribeBlob(blob, onProgress){
  var pcm = await decodeTo16k(blob);
  var total = pcm.length;
  var segs = [], pos = 0;
  while (pos < total){
    var end = Math.min(total, pos + FILE_SLICE);
    if (end < total) end = quietCut(pcm, pos + FILE_SLICE - 20 * RATE, pos + FILE_SLICE);
    var slice = pcm.slice(pos, end);
    var r = await Queue.add(slice, pos / RATE);
    segs = segs.concat(r);
    pos = end;
    onProgress(pos / total);
  }
  return { segments: segs, duration: total / RATE };
}

async function runTranscription(rec, blob){
  detailBusy = true;
  var key = Settings.data.model;
  rec.status = 'transcribing'; rec.model = key;
  await DB.putRec(rec);
  renderDetail(rec);
  try {
    var res = await transcribeBlob(blob, function(f){
      $('dProg').hidden = false; $('dProgFill').style.width = Math.round(f * 100) + '%';
      $('dProgText').textContent = 'Transcribing with the ' + MODELS[key].label + ' model: ' + Math.round(f * 100) + '%';
    });
    rec.segments = res.segments;
    rec.duration = rec.duration || res.duration;
    rec.status = 'done';
    rec.notes = rec.notes.filter(function(n){ return !/Re-transcribe/.test(n); });
    await DB.putRec(rec);
    toast(res.segments.length ? 'Transcript ready.' : 'No speech was picked up.');
  } catch (err){
    rec.status = 'done';
    rec.notes.push('Transcription stopped: ' + friendlyError(err));
    await DB.putRec(rec);
    toast('Transcription stopped: ' + friendlyError(err), 7000);
  }
  detailBusy = false;
  if (current && current.id === rec.id) renderDetail(rec);
}

$('importBtn').addEventListener('click', function(){ if (!Rec) $('fileInput').click(); });
$('fileInput').addEventListener('change', async function(){
  var f = this.files && this.files[0];
  this.value = '';
  if (!f || Rec || detailBusy) return;
  if (f.size > 200 * 1048576){
    var ok = await sheet('Large file', 'This file is over 200 MB. Phones often run out of memory decoding files this big. Try anyway?', [{ label: 'Try anyway', value: true }, { label: 'Cancel', value: false }]);
    if (!ok) return;
  }
  var key = Settings.data.model;
  if (!modelReady(key)){
    var go = await sheet('Download the ' + MODELS[key].label + ' model?', 'First use needs a one-time download (' + MODELS[key].size + '). Wi-Fi is best.', [{ label: 'Download and transcribe', primary: true, value: true }, { label: 'Cancel', value: false }]);
    if (!go) return;
  }
  var now = Date.now();
  var rec = { id: uid(), title: f.name.replace(/\.[^.]+$/, '') || ('Import ' + dateLabel(now)), createdAt: now, duration: 0, mime: f.type || '', model: key, status: 'transcribing', segments: [], flags: [], notes: [], hasAudio: true, source: 'import' };
  await DB.putRec(rec);
  await DB.putBlob(rec.id, f);
  await openDetail(rec.id);
  runTranscription(rec, f).then(function(){
    if (!Settings.data.keepAudio){ rec.hasAudio = false; DB.delBlob(rec.id).then(function(){ return DB.putRec(rec); }); }
  });
});

/* ---------- library ---------- */
async function renderLibrary(){
  var q = $('libSearch').value.trim().toLowerCase();
  var list = await DB.allRecs();
  list.sort(function(a, b){ return b.createdAt - a.createdAt; });
  var box = $('libList');
  box.innerHTML = '';
  var shown = 0;
  list.forEach(function(r){
    var hay = (r.title + ' ' + r.segments.map(function(s){ return s.t; }).join(' ')).toLowerCase();
    if (q && hay.indexOf(q) < 0) return;
    shown++;
    var b = el('button', 'item');
    var t = el('div', 't', r.title);
    if (r.status === 'transcribing') t.appendChild(el('span', 'tag', 'Transcribing'));
    if (r.status === 'recording') t.appendChild(el('span', 'tag', 'Unfinished'));
    b.appendChild(t);
    b.appendChild(el('div', 'm', dateLabel(r.createdAt) + ', ' + clock(r.duration)));
    if (r.segments.length) b.appendChild(el('div', 'snip', r.segments.slice(0, 3).map(function(s){ return s.t; }).join(' ')));
    b.addEventListener('click', function(){ openDetail(r.id); });
    box.appendChild(b);
  });
  if (!shown) box.appendChild(el('div', 'empty', q ? 'Nothing matches that search.' : 'No recordings yet. Record a meeting or import a voice memo and it will show up here.'));
}
$('libSearch').addEventListener('input', renderLibrary);

/* ---------- detail ---------- */
var current = null, editing = false, audioUrl = null;

async function openDetail(id){
  var rec = await DB.getRec(id);
  if (!rec) return;
  current = rec; editing = false;
  if (audioUrl){ URL.revokeObjectURL(audioUrl); audioUrl = null; }
  var player = $('player');
  player.removeAttribute('src');
  player.hidden = true;
  if (rec.hasAudio){
    var blob = await DB.getBlob(id);
    if (blob){ audioUrl = URL.createObjectURL(blob); player.src = audioUrl; player.hidden = false; }
  }
  showView('detail');
  renderDetail(rec);
}

function renderDetail(rec){
  if (!current || current.id !== rec.id) return;
  current = rec;
  $('dTitle').textContent = rec.title;
  $('dMeta').textContent = dateLabel(rec.createdAt) + ', ' + clock(rec.duration) + (rec.model ? ', ' + MODELS[rec.model].label + ' model' : '');
  var busy = rec.status === 'transcribing';
  $('dProg').hidden = !busy;
  if (!busy) $('dProgText').textContent = '';
  var acts = $('dActions');
  acts.innerHTML = '';
  function chip(label, fn, cls){ var b = el('button', 'chip' + (cls ? ' ' + cls : ''), label); b.addEventListener('click', fn); acts.appendChild(b); return b; }
  chip('Copy', function(){ copyText(plainText(rec)); });
  chip('Share', function(){ shareRec(rec); });
  chip('Export', function(){ exportSheet(rec); });
  chip(editing ? 'Done' : 'Edit', function(){ editing = !editing; renderDetail(rec); });
  if (rec.hasAudio && !busy) chip('Re-transcribe', function(){ retranscribe(rec); });
  chip('Delete', function(){ removeRec(rec); }, 'danger');
  renderSegments(rec);
}

function renderSegments(rec){
  var q = $('dSearch').value.trim();
  var box = $('dSegs');
  box.innerHTML = '';
  var rows = rec.segments.map(function(s, i){ return { kind: 'seg', t: s.s, seg: s, i: i }; })
    .concat((rec.flags || []).map(function(f){ return { kind: 'flag', t: f }; }));
  rows.sort(function(a, b){ return a.t - b.t; });
  rec.notes.forEach(function(n){ box.appendChild(el('div', 'banner', n)); });
  if (!rows.length){
    box.appendChild(el('div', 'empty', rec.status === 'transcribing' ? 'Working on it. The transcript will appear here when it is ready.' : 'No transcript yet.'));
    return;
  }
  var re = null;
  if (q){ re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'); }
  rows.forEach(function(r){
    if (r.kind === 'flag'){
      var f = el('div', 'flag');
      var fb = el('button', '', 'Flagged at ' + clock(r.t));
      fb.addEventListener('click', function(){ seekTo(r.t); });
      f.appendChild(fb); box.appendChild(f); return;
    }
    if (q && r.seg.t.toLowerCase().indexOf(q.toLowerCase()) < 0) return;
    var row = el('div', 'seg'); row.dataset.s = r.seg.s; row.dataset.e = r.seg.e;
    var ts = el('button', 'ts', clock(r.seg.s));
    ts.addEventListener('click', function(){ seekTo(r.seg.s); });
    var tx = el('div', 'tx');
    if (re){
      r.seg.t.split(re).forEach(function(part, idx){
        if (idx % 2 === 1){ var m = el('mark', '', part); tx.appendChild(m); } else tx.appendChild(document.createTextNode(part));
      });
    } else tx.textContent = r.seg.t;
    if (editing){
      tx.contentEditable = 'true';
      tx.addEventListener('blur', function(){
        var v = tx.textContent.replace(/\s+/g, ' ').trim();
        if (v && v !== r.seg.t){ r.seg.t = v; DB.putRec(rec); }
      });
    }
    row.appendChild(ts); row.appendChild(tx); box.appendChild(row);
  });
}
$('dSearch').addEventListener('input', function(){ if (current) renderSegments(current); });

function seekTo(t){
  var p = $('player');
  if (p.hidden) return;
  try { p.currentTime = Math.max(0, t - 0.2); p.play(); } catch (e) {}
}
$('player').addEventListener('loadedmetadata', function(){
  var p = this;
  if (p.duration === Infinity){
    p.currentTime = 1e101;
    p.addEventListener('timeupdate', function fix(){ p.removeEventListener('timeupdate', fix); p.currentTime = 0; });
  }
});
$('player').addEventListener('timeupdate', function(){
  var t = this.currentTime, rows = $('dSegs').querySelectorAll('.seg'), hit = null;
  rows.forEach(function(r){ if (t >= parseFloat(r.dataset.s) - 0.1 && t < parseFloat(r.dataset.e) + 0.3) hit = r; });
  rows.forEach(function(r){ r.classList.toggle('active', r === hit); });
});

$('dTitle').addEventListener('click', async function(){
  if (!current) return;
  var v = prompt('Rename recording', current.title);
  if (v && v.trim()){ current.title = v.trim(); await DB.putRec(current); renderDetail(current); }
});
$('backBtn').addEventListener('click', function(){ showView('library'); });

function plainText(rec){
  var out = [rec.title, dateLabel(rec.createdAt) + ', ' + clock(rec.duration), ''];
  rec.segments.forEach(function(s){ out.push('[' + clock(s.s) + '] ' + s.t); });
  if ((rec.flags || []).length) out.push('', 'Flagged moments: ' + rec.flags.map(clock).join(', '));
  return out.join('\n');
}
function mdText(rec){
  var out = ['# ' + rec.title, '', dateLabel(rec.createdAt) + ', ' + clock(rec.duration), ''];
  rec.segments.forEach(function(s){ out.push('**' + clock(s.s) + '** ' + s.t, ''); });
  if ((rec.flags || []).length) out.push('## Flagged moments', '', rec.flags.map(function(f){ return '- ' + clock(f); }).join('\n'), '');
  return out.join('\n');
}
function srtText(rec){
  return rec.segments.map(function(s, i){
    return (i + 1) + '\n' + srtTime(s.s) + ' --> ' + srtTime(Math.max(s.e, s.s + 1)) + '\n' + s.t + '\n';
  }).join('\n');
}
function fileName(rec, ext){ return (rec.title || 'recording').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.' + ext; }
function download(name, text, type){
  var url = URL.createObjectURL(new Blob([text], { type: type }));
  var a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
}
async function copyText(text){
  try { await navigator.clipboard.writeText(text); toast('Copied.'); }
  catch (e){
    var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied.'); } catch (e2) { toast('Could not copy. Use Export instead.'); }
    ta.remove();
  }
}
async function shareRec(rec){
  var text = plainText(rec);
  if (navigator.share){
    try { await navigator.share({ title: rec.title, text: text }); } catch (e) {}
  } else copyText(text);
}
async function exportSheet(rec){
  var choice = await sheet('Export transcript', '', [
    { label: 'Text file (.txt)', value: 'txt' }, { label: 'Markdown (.md)', value: 'md' }, { label: 'Subtitles (.srt)', value: 'srt' },
    { label: 'Cancel', value: null }
  ]);
  if (choice === 'txt') download(fileName(rec, 'txt'), plainText(rec), 'text/plain');
  if (choice === 'md') download(fileName(rec, 'md'), mdText(rec), 'text/markdown');
  if (choice === 'srt') download(fileName(rec, 'srt'), srtText(rec), 'application/x-subrip');
}
async function removeRec(rec){
  var ok = await sheet('Delete this recording?', 'The audio and transcript will be removed from this phone. This cannot be undone.', [{ label: 'Delete', primary: true, value: true }, { label: 'Keep it', value: false }]);
  if (!ok) return;
  await DB.delRec(rec.id);
  current = null;
  showView('library');
  toast('Deleted.');
}
async function retranscribe(rec){
  if (Rec || detailBusy){ toast('Wait for the current job to finish first.'); return; }
  var key = Settings.data.model;
  var go = await sheet('Re-transcribe with the ' + MODELS[key].label + ' model?', 'This replaces the current transcript, including any edits you made. You can change the model in Settings first.', [{ label: 'Re-transcribe', primary: true, value: true }, { label: 'Cancel', value: false }]);
  if (!go) return;
  var blob = await DB.getBlob(rec.id);
  if (!blob){ toast('The audio for this recording is not stored.'); return; }
  runTranscription(rec, blob);
}

/* ---------- settings view ---------- */
function renderSettings(){
  var box = $('modelOpts');
  box.innerHTML = '';
  Object.keys(MODELS).forEach(function(k){
    var M = MODELS[k];
    var lab = el('label', 'opt');
    var inp = document.createElement('input'); inp.type = 'radio'; inp.name = 'model'; inp.value = k; inp.checked = Settings.data.model === k;
    inp.disabled = !!Rec || detailBusy;
    inp.addEventListener('change', function(){ Settings.data.model = k; Settings.save(); updateEngineLine(); renderSettings(); });
    var span = el('span');
    span.appendChild(el('span', 't', M.label + ', ' + M.size));
    span.appendChild(document.createElement('br'));
    span.appendChild(el('span', 'muted small', M.note + (modelReady(k) ? ' On this phone.' : '')));
    lab.appendChild(inp); lab.appendChild(span); box.appendChild(lab);
  });
  $('keepAudio').checked = Settings.data.keepAudio;
  $('verInfo').textContent = 'Scribe, ' + APP_VERSION;
  if (navigator.storage && navigator.storage.estimate){
    navigator.storage.estimate().then(function(e){
      var mb = function(n){ return (n / 1048576).toFixed(0) + ' MB'; };
      $('storageInfo').textContent = 'Using ' + mb(e.usage || 0) + ' of roughly ' + mb(e.quota || 0) + ' available to this app. Models are included in that figure.';
    }).catch(function(){});
  }
}
$('keepAudio').addEventListener('change', function(){ Settings.data.keepAudio = this.checked; Settings.save(); });
$('dlModelBtn').addEventListener('click', async function(){
  var key = Settings.data.model;
  if (Engine.isReady(key) || modelReady(key)){
    $('sStatus').textContent = 'Checking the ' + MODELS[key].label + ' model.';
  }
  $('sStatus').textContent = 'Starting the download';
  try { await Engine.ensure(key); $('sStatus').textContent = MODELS[key].label + ' model is ready and works offline.'; renderSettings(); updateEngineLine(); }
  catch (e){ $('sStatus').textContent = 'Failed: ' + friendlyError(e); }
});
$('persistBtn').addEventListener('click', async function(){
  if (navigator.storage && navigator.storage.persist){
    var ok = await navigator.storage.persist();
    toast(ok ? 'Done. The browser will keep your recordings.' : 'The browser declined. Installing the app to your home screen usually helps.', 5000);
  } else toast('This browser does not support that.');
});
$('wipeBtn').addEventListener('click', async function(){
  if (Rec || detailBusy){ toast('Wait for the current job to finish first.'); return; }
  var ok = await sheet('Delete all recordings?', 'Every recording and transcript on this phone will be removed. Downloaded models stay.', [{ label: 'Delete everything', primary: true, value: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  await DB.wipe(); current = null; toast('All recordings deleted.'); renderLibrary();
});
var deferredInstall = null;
window.addEventListener('beforeinstallprompt', function(e){ e.preventDefault(); deferredInstall = e; $('installBtn').hidden = false; });
$('installBtn').addEventListener('click', async function(){
  if (!deferredInstall) return;
  deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBtn').hidden = true;
});

/* ---------- navigation ---------- */
function showView(name){
  ['record', 'library', 'detail', 'settings'].forEach(function(v){ $('view-' + v).classList.toggle('active', v === name); });
  var tab = name === 'detail' ? 'library' : name;
  document.querySelectorAll('#tabbar button').forEach(function(b){ b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'); });
  if (name === 'library') renderLibrary();
  if (name === 'settings') renderSettings();
  if (name === 'record') updateEngineLine();
}
document.querySelectorAll('#tabbar button').forEach(function(b){ b.addEventListener('click', function(){ showView(b.dataset.tab); }); });

/* ---------- start up ---------- */
async function recoverUnfinished(){
  try {
    var list = await DB.allRecs();
    var n = 0;
    for (var i = 0; i < list.length; i++){
      var r = list[i];
      if (r.status === 'transcribing' && !detailBusy){
        r.status = 'done';
        r.notes.push('Transcription was interrupted when the app closed. Use Re-transcribe to run it again.');
        await DB.putRec(r);
        continue;
      }
      if (r.status !== 'recording' || (Rec && Rec.rec.id === r.id)) continue;
      if (r.hasAudio){
        var chunks = await DB.getChunks(r.id);
        if (chunks.length){ await DB.putBlob(r.id, new Blob(chunks, { type: r.mime || 'audio/webm' })); } else { r.hasAudio = false; }
        await DB.delChunks(r.id);
      }
      r.status = 'done';
      r.notes.push('This recording was cut short when the app closed. ' + (r.hasAudio ? 'Use Re-transcribe to fill in the rest.' : 'Only the transcript captured so far was kept.'));
      await DB.putRec(r);
      n++;
    }
    if (n) toast('Recovered ' + n + (n === 1 ? ' unfinished recording' : ' unfinished recordings') + '. Find it in Library.', 6000);
  } catch (e) {}
}

Settings.load();
updateEngineLine();
drawWave();
recoverUnfinished();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')){
  navigator.serviceWorker.register('sw.js').catch(function(){});
}
window.__scribe = { version: APP_VERSION };
})();
