// Scribe transcription worker.
// Runs Whisper (transformers.js + onnxruntime-web, CPU/WASM) on this device, and a small
// voice-fingerprint model that lets the app tell speakers apart.
// It only ever receives 16 kHz mono audio samples and returns text and numbers.
importScripts('speakers.js');

var VOICE_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
var EMB_MAX_SEC = 6;       // longest stretch of one sentence used for a fingerprint
var EMB_MIN_SEC = 0.7;     // shorter than this is not enough to tell anyone apart
var RATE = 16000;

var pipe = null;
var tf = null;
var loadedModel = null;
var wasmBuf = null;
var voiceFE = null;
var voiceModel = null;

function post(msg){ self.postMessage(msg); }

async function setupRuntime(m){
  if (!tf) tf = await import(m.tfUrl);
  tf.env.allowLocalModels = false;
  tf.env.useBrowserCache = true;
  tf.env.useWasmCache = false;
  tf.env.backends.onnx.wasm.wasmPaths = {
    mjs: m.ortBase + 'ort-loader.js',
    wasm: m.ortBase + 'ort-wasm-simd-threaded.wasm'
  };
  if (!wasmBuf){
    // The engine's WebAssembly file is stored as two halves so it can be uploaded to GitHub in pieces.
    post({ type: 'status', text: 'Loading the speech engine' });
    var parts = await Promise.all(['0', '1'].map(function(n){
      return fetch(m.ortBase + 'ort-wasm-simd-threaded.wasm.' + n).then(function(r){
        if (!r.ok) throw new Error('Could not load the speech engine (' + r.status + ')');
        return r.arrayBuffer();
      });
    }));
    var joined = new Uint8Array(parts[0].byteLength + parts[1].byteLength);
    joined.set(new Uint8Array(parts[0]), 0);
    joined.set(new Uint8Array(parts[1]), parts[0].byteLength);
    wasmBuf = joined.buffer;
  }
  tf.env.backends.onnx.wasm.wasmBinary = wasmBuf;
}

function progress(files){
  return function(p){
    if (!p || !p.file) return;
    if (p.status === 'progress' && p.total){
      files[p.file] = { loaded: p.loaded, total: p.total };
      var l = 0, t = 0;
      Object.keys(files).forEach(function(k){ l += files[k].loaded; t += files[k].total; });
      post({ type: 'download', loaded: l, total: t });
    } else if (p.status === 'ready'){
      post({ type: 'status', text: 'Preparing the model' });
    }
  };
}

// One fingerprint for a stretch of audio, or null if there is too little to go on.
async function fingerprint(audio, startSec, endSec){
  var s = Math.max(0, startSec), e = Math.min(audio.length / RATE, endSec);
  if (e - s > EMB_MAX_SEC){ var mid = (s + e) / 2; s = mid - EMB_MAX_SEC / 2; e = mid + EMB_MAX_SEC / 2; }
  if (e - s < EMB_MIN_SEC) return null;
  var a = audio.subarray(Math.round(s * RATE), Math.round(e * RATE));
  var en = 0; for (var i = 0; i < a.length; i += 4) en += a[i] * a[i];
  if (Math.sqrt(en / (a.length / 4)) < 0.003) return null;
  var inputs = await voiceFE(a);
  var out = await voiceModel(inputs);
  var t = out.embeddings || out.last_hidden_state || out[Object.keys(out)[0]];
  return { emb: self.Spk.pack(t.data), ed: e - s };
}

// Messages are handled one at a time, so loading one model never overlaps with loading another.
var chain = Promise.resolve();
self.onmessage = function(e){ chain = chain.then(function(){ return handleMessage(e.data); }); };

async function handleMessage(m){
  try {
    if (m.type === 'init'){
      if (pipe && loadedModel === m.model){ post({ type: 'ready' }); return; }
      post({ type: 'status', text: 'Loading the transcription engine' });
      await setupRuntime(m);
      pipe = null; loadedModel = null;
      pipe = await tf.pipeline('automatic-speech-recognition', m.model, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: progress({})
      });
      loadedModel = m.model;
      post({ type: 'ready' });
    } else if (m.type === 'initvoice'){
      // Optional. If this fails the app carries on without speaker names.
      if (voiceModel){ post({ type: 'voiceready' }); return; }
      await setupRuntime(m);
      post({ type: 'status', text: 'Loading the voice model' });
      voiceFE = await tf.AutoFeatureExtractor.from_pretrained(VOICE_MODEL);
      voiceModel = await tf.AutoModel.from_pretrained(VOICE_MODEL, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: progress({})
      });
      post({ type: 'voiceready' });
    } else if (m.type === 'embed'){
      // Fingerprints for pieces of audio (used to find speakers in recordings made earlier).
      if (!voiceModel) throw new Error('The voice model is not loaded yet.');
      var items = [];
      for (var k = 0; k < m.pieces.length; k++){
        var piece = m.pieces[k], r = null;
        try { r = await fingerprint(piece, 0, piece.length / RATE); } catch (err2){ r = null; }
        items.push(r);
      }
      post({ type: 'result', id: m.id, items: items });
    } else if (m.type === 'run'){
      if (!pipe) throw new Error('The transcription engine is not loaded yet.');
      var audio = m.audio;
      var out = await pipe(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true
      });
      var dur = audio.length / RATE;
      var chunks = [];
      var raw = out.chunks || [];
      // With speaker recognition on, cut sentences at pauses so each piece holds one stretch of speech.
      var regions = (m.voice && voiceModel) ? self.Spk.speechRegions(audio, RATE) : null;
      for (var i = 0; i < raw.length; i++){
        var c = raw[i], ts = c.timestamp || [null, null];
        var s0 = ts[0] == null ? 0 : ts[0], e0 = ts[1] == null ? dur : ts[1];
        var pieces = [{ s: s0, e: e0, t: c.text }];
        if (regions && (c.text || '').trim()) pieces = self.Spk.splitAtPauses({ s: s0, e: e0, t: c.text.trim() }, regions);
        for (var q = 0; q < pieces.length; q++){
          var item = { text: pieces[q].t, start: pieces[q].s, end: pieces[q].e };
          if (m.voice && voiceModel){
            try {
              var fp = await fingerprint(audio, pieces[q].s, pieces[q].e);
              if (fp){ item.emb = fp.emb; item.ed = fp.ed; }
            } catch (err){ /* a failed fingerprint just means no speaker hint for this piece */ }
          }
          chunks.push(item);
        }
      }
      post({ type: 'result', id: m.id, text: out.text || '', chunks: chunks });
    }
  } catch (err){
    if (m && m.type === 'initvoice') post({ type: 'voicefail', message: String((err && err.message) || err) });
    else post({ type: 'error', id: m && m.id, message: String((err && err.message) || err) });
  }
}
