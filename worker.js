// Scribe transcription worker.
// Runs Whisper (transformers.js + onnxruntime-web, CPU/WASM) on this device.
// It only ever receives 16 kHz mono audio samples and returns text.
var pipe = null;
var tf = null;
var loadedModel = null;
var wasmBuf = null;

function post(msg){ self.postMessage(msg); }

self.onmessage = async function(e){
  var m = e.data;
  try {
    if (m.type === 'init'){
      if (pipe && loadedModel === m.model){ post({ type: 'ready' }); return; }
      post({ type: 'status', text: 'Loading the transcription engine' });
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
      pipe = null; loadedModel = null;
      var files = {};
      pipe = await tf.pipeline('automatic-speech-recognition', m.model, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: function(p){
          if (!p || !p.file) return;
          if (p.status === 'progress' && p.total){
            files[p.file] = { loaded: p.loaded, total: p.total };
            var l = 0, t = 0;
            Object.keys(files).forEach(function(k){ l += files[k].loaded; t += files[k].total; });
            post({ type: 'download', loaded: l, total: t });
          } else if (p.status === 'ready'){
            post({ type: 'status', text: 'Preparing the model' });
          }
        }
      });
      loadedModel = m.model;
      post({ type: 'ready' });
    } else if (m.type === 'run'){
      if (!pipe) throw new Error('The transcription engine is not loaded yet.');
      var out = await pipe(m.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true
      });
      var chunks = (out.chunks || []).map(function(c){
        var ts = c.timestamp || [null, null];
        return { text: c.text, start: ts[0], end: ts[1] };
      });
      post({ type: 'result', id: m.id, text: out.text || '', chunks: chunks });
    }
  } catch (err){
    post({ type: 'error', id: m && m.id, message: String((err && err.message) || err) });
  }
};
