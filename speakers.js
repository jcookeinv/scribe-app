/* Scribe: grouping sentences into paragraphs and telling voices apart.
   Pure functions with no page access, so the same code runs in the app and in tests.
   A segment looks like { s, e, t, emb, ed, spk }:
     s, e   start and end in seconds
     t      text
     emb    voice fingerprint (Int8Array of 256 numbers) or missing
     ed     seconds of audio the fingerprint was made from
     spk    speaker number, 0 based (set by this file or by the user) */
(function(root){
  'use strict';

  var MIN_STRONG = 1.2;      // a fingerprint from less audio than this is only a hint
  var MAX_ITEMS = 250;       // above this many fingerprints they are pre-merged to keep it fast
  var DEFAULT_T = 0.62;      // cut height (1 minus cosine similarity) for deciding it is a new voice
  var MIN_SPK_SEC = 3;       // a "voice" with less speech than this and under 3 sentences is folded in
  var WEAK_SIM = 0.35;       // short clips are put with a voice only if at least this similar

  function unit(v){
    var s = 0, i, o = new Float32Array(v.length);
    for (i = 0; i < v.length; i++) s += v[i] * v[i];
    s = Math.sqrt(s) || 1;
    for (i = 0; i < v.length; i++) o[i] = v[i] / s;
    return o;
  }
  function pack(v){
    var u = unit(v), o = new Int8Array(u.length);
    for (var i = 0; i < u.length; i++) o[i] = Math.max(-127, Math.min(127, Math.round(u[i] * 127)));
    return o;
  }
  function unpack(a){ return unit(a); }
  function dot(a, b){ var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

  /* weighted mean of unit vectors, re-normalised */
  function centroid(vs, ws){
    var d = vs[0].length, c = new Float32Array(d), i, j;
    for (i = 0; i < vs.length; i++) for (j = 0; j < d; j++) c[j] += vs[i][j] * ws[i];
    return unit(c);
  }

  /* Average-linkage clustering of weighted unit vectors.
     Stops when the closest pair is further apart than T, or at exactly K clusters if K is given. */
  function agglomerate(vs, ws, T, K){
    var m = vs.length, i, j;
    var D = new Float64Array(m * m);
    for (i = 0; i < m; i++) for (j = i + 1; j < m; j++){ var d = 1 - dot(vs[i], vs[j]); D[i * m + j] = d; D[j * m + i] = d; }
    var W = ws.slice(), act = new Array(m), members = new Array(m), alive = m;
    for (i = 0; i < m; i++){ act[i] = true; members[i] = [i]; }
    while (alive > 1){
      var bi = -1, bj = -1, bd = Infinity;
      for (i = 0; i < m; i++){
        if (!act[i]) continue;
        for (j = i + 1; j < m; j++){
          if (act[j] && D[i * m + j] < bd){ bd = D[i * m + j]; bi = i; bj = j; }
        }
      }
      if (K ? alive <= K : bd > T) break;
      for (j = 0; j < m; j++){
        if (!act[j] || j === bi || j === bj) continue;
        var nd = (W[bi] * D[bi * m + j] + W[bj] * D[bj * m + j]) / (W[bi] + W[bj]);
        D[bi * m + j] = nd; D[j * m + bi] = nd;
      }
      W[bi] += W[bj]; act[bj] = false;
      members[bi] = members[bi].concat(members[bj]);
      alive--;
    }
    var out = [];
    for (i = 0; i < m; i++) if (act[i]) out.push(members[i]);
    return out;
  }

  /* Too many fingerprints: merge near-identical ones first (greedy, keeps order of weight). */
  function preMerge(items){
    var thr = 0.9;
    while (true){
      var order = items.map(function(_, i){ return i; }).sort(function(a, b){ return items[b].w - items[a].w; });
      var leaders = [];
      order.forEach(function(idx){
        var it = items[idx], best = -1, bs = -2;
        for (var l = 0; l < leaders.length; l++){
          var sc = dot(it.v, leaders[l].v);
          if (sc > bs){ bs = sc; best = l; }
        }
        if (best >= 0 && bs >= thr){
          var L = leaders[best];
          L.ids.push(idx); L.vs.push(it.v); L.ws.push(it.w);
          L.v = centroid(L.vs, L.ws); L.w += it.w;
        } else leaders.push({ v: it.v, w: it.w, ids: [idx], vs: [it.v], ws: [it.w] });
      });
      if (leaders.length <= MAX_ITEMS || thr <= 0.3) return leaders;
      thr -= 0.08;
    }
  }

  /* Decide a speaker number for every segment.
     opts: { count: exact number of speakers if known, threshold: cut height override }
     Returns { labels: [..], k: number of speakers }. Numbers go by first appearance. */
  function cluster(segs, opts){
    opts = opts || {};
    var T = opts.threshold != null ? opts.threshold : DEFAULT_T;
    var K = opts.count > 0 ? opts.count : 0;
    var n = segs.length, labels = new Array(n), i;
    for (i = 0; i < n; i++) labels[i] = -1;

    var items = [];
    segs.forEach(function(sg, idx){
      if (sg.emb && (sg.ed || 0) >= MIN_STRONG) items.push({ idx: idx, v: unpack(sg.emb), w: Math.min(sg.ed, 6) });
    });
    if (!items.length){ for (i = 0; i < n; i++) labels[i] = 0; return { labels: labels, k: n ? 1 : 0 }; }

    // 1. agglomerate (pre-merging when there are very many)
    var groups;   // each: array of indexes into items
    if (items.length > MAX_ITEMS){
      var leaders = preMerge(items);
      var lg = agglomerate(leaders.map(function(l){ return l.v; }), leaders.map(function(l){ return l.w; }), T, K);
      groups = lg.map(function(g){ var a = []; g.forEach(function(li){ a = a.concat(leaders[li].ids); }); return a; });
    } else {
      groups = agglomerate(items.map(function(x){ return x.v; }), items.map(function(x){ return x.w; }), T, K);
    }

    function cents(gs){
      return gs.map(function(g){ return centroid(g.map(function(x){ return items[x].v; }), g.map(function(x){ return items[x].w; })); });
    }
    function weight(g){ var w = 0; g.forEach(function(x){ w += items[x].w; }); return w; }

    // 2. fold tiny "voices" (a cough, a one-off noise) into the nearest real one
    if (!K){
      var changed = true;
      while (changed && groups.length > 1){
        changed = false;
        var cs = cents(groups);
        for (var g = 0; g < groups.length; g++){
          if (weight(groups[g]) < MIN_SPK_SEC && groups[g].length < 3){
            var bj = -1, bs = -2;
            for (var h = 0; h < groups.length; h++){
              if (h === g) continue;
              var sc = dot(cs[g], cs[h]);
              if (sc > bs){ bs = sc; bj = h; }
            }
            groups[bj] = groups[bj].concat(groups[g]);
            groups.splice(g, 1);
            changed = true;
            break;
          }
        }
      }
    }

    // 3. two rounds of "move each fingerprint to its nearest voice" to tidy early mistakes
    var cs2 = cents(groups);
    for (var round = 0; round < 2 && groups.length > 1; round++){
      var ng = groups.map(function(){ return []; });
      items.forEach(function(it, x){
        var b = 0, bsim = -2;
        for (var c = 0; c < cs2.length; c++){ var s2 = dot(it.v, cs2[c]); if (s2 > bsim){ bsim = s2; b = c; } }
        ng[b].push(x);
      });
      var kept = [];
      ng.forEach(function(g){ if (g.length) kept.push(g); });
      groups = kept;
      cs2 = cents(groups);
    }
    groups.forEach(function(g, gi){ g.forEach(function(x){ labels[items[x].idx] = gi; }); });

    // 4. short clips and clips without a fingerprint
    for (i = 0; i < n; i++){
      if (labels[i] >= 0) continue;
      var sg = segs[i];
      if (sg.emb && groups.length > 1){
        var v = unpack(sg.emb), bb = -1, bsc = -2;
        for (var c2 = 0; c2 < cs2.length; c2++){ var s3 = dot(v, cs2[c2]); if (s3 > bsc){ bsc = s3; bb = c2; } }
        if (bsc >= WEAK_SIM) labels[i] = bb;
      } else if (groups.length === 1) labels[i] = 0;
    }
    // whatever is left takes the voice of the clip just before it (or just after, at the start)
    for (i = 0; i < n; i++){
      if (labels[i] >= 0) continue;
      var p = i - 1; while (p >= 0 && labels[p] < 0) p--;
      if (p >= 0) labels[i] = labels[p];
    }
    for (i = n - 1; i >= 0; i--){
      if (labels[i] >= 0) continue;
      var q = i + 1; while (q < n && labels[q] < 0) q++;
      labels[i] = q < n ? labels[q] : 0;
    }

    // 5. number by first appearance
    var map = {}, next = 0;
    for (i = 0; i < n; i++){
      if (!(labels[i] in map)) map[labels[i]] = next++;
      labels[i] = map[labels[i]];
    }
    return { labels: labels, k: next };
  }

  /* Where is anyone speaking? Plain loudness-based pause finder, adapts to the room.
     Returns [[start, end], ...] in seconds. If the recording has no clear quiet moments it returns
     one region covering everything, so nothing gets split. */
  function speechRegions(a, rate){
    var dur = a.length / rate;
    var hop = Math.round(rate * 0.01), win = Math.round(rate * 0.02);
    var n = Math.floor((a.length - win) / hop) + 1;
    if (n < 20) return [[0, dur]];
    var db = new Float32Array(n), f, i;
    for (f = 0; f < n; f++){
      var e = 0, o = f * hop;
      for (i = 0; i < win; i += 2) e += a[o + i] * a[o + i];
      db[f] = 10 * Math.log10(e / (win / 2) + 1e-10);
    }
    var sorted = Array.prototype.slice.call(db).sort(function(x, y){ return x - y; });
    var floor = sorted[Math.floor(n * 0.1)], peak = sorted[Math.floor(n * 0.95)];
    if (peak - floor < 12) return [[0, dur]];
    var thr = floor + Math.max(8, 0.3 * (peak - floor));
    var minPause = 25, regions = [], start = -1, lastLoud = -1;   // frames of 10 ms
    for (f = 0; f < n; f++){
      if (db[f] > thr){
        if (start < 0) start = f;
        lastLoud = f;
      } else if (start >= 0 && f - lastLoud > minPause){
        regions.push([start, lastLoud]); start = -1;
      }
    }
    if (start >= 0) regions.push([start, lastLoud]);
    var out = [];
    regions.forEach(function(r){
      if ((r[1] - r[0]) < 25) return;                                   // under a quarter of a second: a click or a breath
      out.push([Math.max(0, r[0] * 0.01 - 0.05), Math.min(dur, r[1] * 0.01 + 0.07)]);
    });
    return out.length ? out : [[0, dur]];
  }

  /* One recognised sentence [start, end] with text; cut it at pauses so that each piece holds
     one stretch of speech. Pieces under MIN_PIECE seconds are joined to a neighbour.
     Words are shared out in proportion to speech time, nudged to a nearby punctuation mark.
     Returns [{ s, e, t }]. */
  var MIN_PIECE = 0.9;
  function splitAtPauses(seg, regions){
    var s0 = seg.s, e0 = seg.e, parts = [];
    regions.forEach(function(r){
      var a = Math.max(r[0], s0), b = Math.min(r[1], e0);
      if (b - a >= 0.15) parts.push({ s: a, e: b, d: b - a });
    });
    if (!parts.length) return [{ s: seg.s, e: seg.e, t: seg.t }];
    // Short pieces: at the edge of the sentence they are spill-over from the neighbouring speech
    // (timestamps are not exact), so drop them; in the middle they are joined to the nearer neighbour.
    var guard = 0;
    while (parts.length > 1 && guard++ < 100){
      var k = -1, kd = Infinity, j;
      for (j = 0; j < parts.length; j++) if (parts[j].d < MIN_PIECE && parts[j].d < kd){ k = j; kd = parts[j].d; }
      if (k < 0) break;
      if (k === 0 || k === parts.length - 1){ parts.splice(k, 1); continue; }
      var left = parts[k].s - parts[k - 1].e, right = parts[k + 1].s - parts[k].e;
      var m = left <= right ? k - 1 : k + 1, lo = Math.min(k, m), hi = Math.max(k, m);
      parts.splice(lo, 2, { s: parts[lo].s, e: parts[hi].e, d: parts[lo].d + parts[hi].d });
    }
    if (parts.length === 1) return [{ s: parts[0].s, e: parts[0].e, t: seg.t }];
    var words = seg.t.split(/\s+/).filter(Boolean), N = words.length;
    if (N < parts.length) return [{ s: seg.s, e: seg.e, t: seg.t }];
    var total = 0; parts.forEach(function(p){ total += p.d; });
    var cuts = [], cum = 0, last = 0, c;
    for (c = 0; c < parts.length - 1; c++){
      cum += parts[c].d;
      var ideal = Math.round(N * cum / total), best = ideal, bestScore = Infinity;
      for (var w = Math.max(last + 1, ideal - 3); w <= Math.min(N - (parts.length - 1 - c), ideal + 3); w++){
        var punct = /[.?!,;:]$/.test(words[w - 1]) ? 0 : 1.5;                // prefer cutting after punctuation
        var score = Math.abs(w - ideal) + punct;
        if (score < bestScore){ bestScore = score; best = w; }
      }
      best = Math.max(last + 1, Math.min(best, N - (parts.length - 1 - c)));
      cuts.push(best); last = best;
    }
    var out = [], from = 0;
    for (c = 0; c < parts.length; c++){
      var to = c < cuts.length ? cuts[c] : N;
      out.push({ s: parts[c].s, e: parts[c].e, t: words.slice(from, to).join(' ') });
      from = to;
    }
    return out;
  }

  /* Group consecutive sentences into paragraphs.
     A new paragraph starts when the speaker changes, after a long silence, or when it grows too long. */
  var GAP = 4, MAX_SEC = 75, MAX_CHARS = 900;
  function paragraphs(segs, opts){
    opts = opts || {};
    var gap = opts.gap != null ? opts.gap : GAP;
    var out = [], cur = null;
    segs.forEach(function(sg, i){
      var spk = sg.spk == null ? -1 : sg.spk;
      var split = !cur || cur.spk !== spk || (sg.s - cur.e) > gap || (sg.e - cur.s) > MAX_SEC || cur.chars > MAX_CHARS;
      if (split){
        cur = { s: sg.s, e: sg.e, spk: spk, idx: [i], chars: sg.t.length };
        out.push(cur);
      } else {
        cur.e = Math.max(cur.e, sg.e); cur.idx.push(i); cur.chars += sg.t.length + 1;
      }
    });
    return out;
  }

  var api = { pack: pack, unpack: unpack, cluster: cluster, paragraphs: paragraphs, speechRegions: speechRegions, splitAtPauses: splitAtPauses, MIN_STRONG: MIN_STRONG, DEFAULT_T: DEFAULT_T };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Spk = api;
})(typeof self !== 'undefined' ? self : this);
