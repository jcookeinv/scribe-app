// Scribe meeting notes: builds a minutes-style breakdown from a transcript, entirely on the device.
// This is an extractive summary. It picks out and organises sentences that were actually said,
// it does not rewrite or invent anything. Pure functions, no DOM.
(function (root) {
  'use strict';

  var STOP = {};
  ('a about above after again against all also am an and any are aren\'t as at be because been before being below between both but by can can\'t cannot could couldn\'t did didn\'t do does doesn\'t doing don\'t down during each few for from further had hadn\'t has hasn\'t have haven\'t having he he\'d he\'ll he\'s her here here\'s hers herself him himself his how how\'s i i\'d i\'ll i\'m i\'ve if in into is isn\'t it it\'s its itself just let\'s like me more most mustn\'t my myself no nor not of off on once only or other ought our ours ourselves out over own same shan\'t she she\'d she\'ll she\'s should shouldn\'t so some such than that that\'s the their theirs them themselves then there there\'s these they they\'d they\'ll they\'re they\'ve this those through to too under until up very was wasn\'t we we\'d we\'ll we\'re we\'ve were weren\'t what what\'s when when\'s where where\'s which while who who\'s whom why why\'s with won\'t would wouldn\'t you you\'d you\'ll you\'re you\'ve your yours yourself yourselves ' +
    'thanks thank cheers check hello hi yeah yes okay ok right really actually basically just kind sort thing things stuff going got get getting gonna wanna lot bit little know think mean say said says see want need make made much many well way one two three back come came look looking something anything everything someone anyone good great sure maybe probably quite still even also then now today').split(' ').forEach(function (w) { if (w) STOP[w] = 1; });

  var DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
  var MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
  var RE_DUE = new RegExp('\\b(by|before|until|on|this|next|end of)\\s+((' + DAYS + ')|tomorrow|tonight|today|next week|next month|the end of (the )?(day|week|month|year)|(' + MONTHS + ')\\s+\\d{1,2}(st|nd|rd|th)?|\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?(' + MONTHS + '))\\b', 'i');
  var RE_ACTION = /\b(i'll|i will|i'm going to|i am going to|i can take|i can do|we'll|we will|we need to|we should|we have to|we must|i need to|i have to|you need to|you'll|needs to|has to|let's|remember to|don't forget|make sure|follow up|follow-up|action item|to do|todo|can you|could you|would you|please|going to send|going to check|will send|will check)\b/i;
  var RE_DECISION = /\b(we('ve)? decided|decided to|decision is|agreed|we agree|we're agreed|we'll go with|we will go with|let's go with|go with|the plan is|settled on|approved|signed off|confirmed|we're going to|we are going to|that's the plan|sounds like a plan|deal)\b/i;
  var RE_DUE2 = /\b(tomorrow|tonight|next week|next month|this week|this afternoon)\b/i;
  var RE_FIGURE = new RegExp('([£$€]\\s?\\d)|(\\d+(\\.\\d+)?\\s?%)|\\b\\d[\\d,.]*\\s?(k|m|bn|million|thousand|hundred|hours?|days?|weeks?|months?|years?|units?|pounds|dollars|euros|minutes)\\b|\\b(' + MONTHS + ')\\s+\\d{1,2}|\\b\\d{1,2}(st|nd|rd|th)\\s+(of\\s+)?(' + MONTHS + ')|\\b\\d{1,2}:\\d{2}\\b', 'i');

  function words(s) { return (s.toLowerCase().match(/[a-z][a-z'\-]*[a-z]|[a-z]/g) || []); }
  function contentWords(s) { return words(s).filter(function (w) { return w.length > 2 && !STOP[w]; }); }
  function clean(s) { return s.replace(/\s+/g, ' ').trim(); }
  function clock(t) {
    t = Math.max(0, Math.round(t));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return h ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  // Items are the transcript pieces: { s, e, t, spk }. Returns one entry per sentence.
  function sentences(items) {
    var out = [];
    items.forEach(function (it, idx) {
      var t = clean(it.t || '');
      if (!t) return;
      var parts = t.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [t];
      var n = parts.length, span = Math.max(0, (it.e || it.s) - it.s);
      parts.forEach(function (p, k) {
        p = clean(p);
        if (!p) return;
        out.push({ text: p, s: it.s + span * (k / n), spk: it.spk, seg: idx, n: words(p).length });
      });
    });
    return out;
  }

  function freq(list) {
    var f = {};
    list.forEach(function (sn) {
      var seen = {};
      contentWords(sn.text).forEach(function (w) { f[w] = (f[w] || 0) + 1; seen[w] = 1; });
    });
    return f;
  }

  function overlap(a, b) {
    var A = {}, n = 0, m = 0, w;
    contentWords(a).forEach(function (x) { A[x] = 1; });
    var B = contentWords(b);
    for (w in A) n++;
    B.forEach(function (x) { if (A[x]) m++; });
    var u = n + B.length - m;
    return u ? m / u : 0;
  }

  function score(sn, f) {
    if (sn.n < 6 || sn.n > 45) return 0;
    var seen = {}, sum = 0;
    contentWords(sn.text).forEach(function (w) { if (!seen[w]) { seen[w] = 1; sum += Math.min(f[w] || 0, 8); } });
    var sc = sum / Math.pow(sn.n, 0.75);
    if (RE_DECISION.test(sn.text)) sc *= 1.3;
    if (RE_ACTION.test(sn.text)) sc *= 1.15;
    if (/\?\s*$/.test(sn.text)) sc *= 0.6;
    return sc;
  }

  function pick(list, f, count, minGap) {
    var ranked = list.map(function (sn) { return { sn: sn, sc: score(sn, f) }; })
      .filter(function (x) { return x.sc > 0; })
      .sort(function (a, b) { return b.sc - a.sc; });
    var chosen = [];
    for (var i = 0; i < ranked.length && chosen.length < count; i++) {
      var ok = true;
      for (var j = 0; j < chosen.length; j++) if (overlap(ranked[i].sn.text, chosen[j].text) > (minGap || 0.45)) { ok = false; break; }
      if (ok) chosen.push(ranked[i].sn);
    }
    return chosen.sort(function (a, b) { return a.s - b.s; });
  }

  function topWords(list, globalF, chunks, n) {
    var f = freq(list), arr = [];
    Object.keys(f).forEach(function (w) {
      var g = globalF[w] || f[w];
      var spread = Math.log(1 + chunks * f[w] / g);   // words that cluster here beat words used everywhere
      arr.push({ w: w, v: f[w] * (0.5 + spread) });
    });
    arr.sort(function (a, b) { return b.v - a.v; });
    return arr.filter(function (x) { return f[x.w] >= 2 || arr.length < 6; }).slice(0, n).map(function (x) { return x.w; });
  }

  function keywords(list, n) {
    var f = freq(list), bi = {};
    list.forEach(function (sn) {
      var w = words(sn.text);
      for (var i = 0; i < w.length - 1; i++) {
        if (w[i].length > 2 && w[i + 1].length > 2 && !STOP[w[i]] && !STOP[w[i + 1]]) {
          var k = w[i] + ' ' + w[i + 1]; bi[k] = (bi[k] || 0) + 1;
        }
      }
    });
    var out = [];
    Object.keys(bi).filter(function (k) { return bi[k] >= 2; }).sort(function (a, b) { return bi[b] - bi[a]; }).slice(0, Math.ceil(n / 2)).forEach(function (k) { out.push(k); });
    var used = out.join(' ');
    Object.keys(f).filter(function (w) { return f[w] >= 2 && used.indexOf(w) < 0; }).sort(function (a, b) { return f[b] - f[a]; }).forEach(function (w) { if (out.length < n) out.push(w); });
    return out;
  }

  function ownerOf(sn, label, nameList) {
    var t = sn.text;
    if (/\b(i'll|i will|i'm going to|i am going to|i can take|i can do|i need to|i have to|i should)\b/i.test(t) && sn.spk !== undefined && sn.spk !== null) return label(sn.spk);
    for (var i = 0; i < nameList.length; i++) {
      var nm = nameList[i];
      if (new RegExp('\\b' + nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b\\s+(will|can|should|needs to|has to|is going to|to)\\b', 'i').test(t) || new RegExp('\\b(can|could|would) you,?\\s+' + nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(t)) return nm;
    }
    return '';
  }

  // input: { items:[{s,e,t,spk}], duration, flags:[sec], labelled:bool, who:function(spk)->name, names:[custom names only] }
  function build(inp) {
    var items = inp.items || [], dur = inp.duration || 0;
    var labelled = !!inp.labelled, who = inp.who || function (i) { return 'Speaker ' + (i + 1); };
    var sents = sentences(items);
    if (!dur && sents.length) dur = sents[sents.length - 1].s;
    var f = freq(sents);
    var wordsTotal = sents.reduce(function (a, b) { return a + b.n; }, 0);
    var res = { empty: sents.length < 3, duration: dur, words: wordsTotal, overview: [], topics: [], decisions: [], actions: [], questions: [], figures: [], speakers: [], flagged: [], keywords: [] };
    if (res.empty) return res;

    var nameList = [];
    if (labelled) {
      var seenN = {};
      sents.forEach(function (sn) { if (sn.spk !== undefined && sn.spk !== null && !seenN[sn.spk]) { seenN[sn.spk] = 1; } });
      Object.keys(seenN).forEach(function (k) { var nm = who(+k); if (nm && !/^Speaker \d+$/.test(nm)) nameList.push(nm); });
    }

    res.keywords = keywords(sents, 8);

    // Overview: roughly one sentence per two minutes, between three and eight.
    var want = Math.max(3, Math.min(8, Math.round(dur / 120)));
    res.overview = pick(sents, f, want, 0.4).map(function (sn) { return { t: sn.s, text: sn.text, who: labelled && sn.spk != null ? who(sn.spk) : '' }; });

    // Topics through the conversation.
    var nChunks = Math.max(1, Math.min(8, Math.round(dur / 180)));
    if (sents.length >= 12 && nChunks > 1) {
      var width = dur / nChunks, chunkSents = [];
      for (var c = 0; c < nChunks; c++) chunkSents.push([]);
      sents.forEach(function (sn) { chunkSents[Math.min(nChunks - 1, Math.floor(sn.s / width))].push(sn); });
      chunkSents.forEach(function (list, c) {
        if (list.length < 3) return;
        var tw = topWords(list, f, nChunks, 3);
        if (!tw.length) return;
        var best = pick(list, freq(list), 1, 0.5)[0];
        res.topics.push({ t: list[0].s, title: tw.map(cap).join(', '), text: best ? best.text : '' });
      });
    }

    // Decisions, action items, questions, figures.
    var seenText = {};
    function dedupe(sn) { var k = sn.text.toLowerCase(); if (seenText[k]) return false; seenText[k] = 1; return true; }
    sents.forEach(function (sn) {
      if (sn.n < 4) return;
      if (RE_DECISION.test(sn.text) && !/\?\s*$/.test(sn.text)) res.decisions.push({ t: sn.s, text: sn.text, who: labelled && sn.spk != null ? who(sn.spk) : '' });
    });
    var decKeys = {}; res.decisions.forEach(function (d) { decKeys[d.text] = 1; });
    var actKeys = {};
    sents.forEach(function (sn) {
      if (sn.n < 4 || sn.n > 60 || decKeys[sn.text]) return;
      var named = ownerOf(sn, who, nameList);
      var talk = /\b(need to|have to|should|let's|going to) (talk|discuss|look|cover|go through|speak|think)\b/i.test(sn.text);
      if ((RE_ACTION.test(sn.text) || (named && /\b(will|needs to|has to|is going to)\b/i.test(sn.text))) && !talk && !/^(if|when|because|although)\b/i.test(sn.text)) {
        actKeys[sn.text] = 1;
        // "please" and "let's" alone are weak; a question like "can you" is a request, keep it.
        var due = (sn.text.match(RE_DUE) || sn.text.match(RE_DUE2) || [''])[0];
        res.actions.push({ t: sn.s, text: sn.text, owner: ownerOf(sn, who, nameList), due: due, said: labelled && sn.spk != null ? who(sn.spk) : '' });
      }
    });
    sents.forEach(function (sn) {
      if (sn.n >= 6 && /\?\s*$/.test(sn.text)) res.questions.push({ t: sn.s, text: sn.text, who: labelled && sn.spk != null ? who(sn.spk) : '' });
    });
    sents.forEach(function (sn) {
      if (sn.n >= 5 && sn.n <= 50 && RE_FIGURE.test(sn.text) && !decKeys[sn.text] && !actKeys[sn.text]) res.figures.push({ t: sn.s, text: sn.text });
    });
    res.decisions = res.decisions.slice(0, 10);
    res.actions = res.actions.slice(0, 15);
    res.questions = res.questions.slice(0, 8);
    res.figures = res.figures.slice(0, 10);

    // Per speaker.
    if (labelled) {
      var by = {}, tot = 0;
      items.forEach(function (it) {
        if (!it.t || !(it.t + '').trim() || it.spk === undefined || it.spk === null) return;
        var d = Math.max(0, (it.e || it.s) - it.s);
        by[it.spk] = by[it.spk] || { spk: it.spk, secs: 0, sents: [] };
        by[it.spk].secs += d; tot += d;
      });
      sents.forEach(function (sn) { if (sn.spk != null && by[sn.spk]) by[sn.spk].sents.push(sn); });
      Object.keys(by).forEach(function (k) {
        var b = by[k];
        var picks = pick(b.sents, f, 2, 0.4);
        res.speakers.push({
          spk: b.spk, name: who(b.spk), secs: b.secs, share: tot ? b.secs / tot : 0,
          topics: topWords(b.sents, f, Object.keys(by).length, 4),
          points: picks.map(function (sn) { return { t: sn.s, text: sn.text }; })
        });
      });
      res.speakers.sort(function (a, b) { return b.secs - a.secs; });
    }

    // Flagged moments with what was being said at that point.
    (inp.flags || []).forEach(function (ft) {
      var near = null, nd = Infinity;
      sents.forEach(function (sn) { var d = Math.abs(sn.s - ft); if (d < nd) { nd = d; near = sn; } });
      res.flagged.push({ t: ft, text: near && nd <= 20 ? near.text : '' });
    });
    return res;
  }

  // ---------- output ----------
  function header(meta) {
    var lines = [];
    if (meta.date) lines.push('Date: ' + meta.date);
    if (meta.duration != null) lines.push('Length: ' + clock(meta.duration));
    if (meta.attendees && meta.attendees.length) lines.push('Speakers: ' + meta.attendees.join(', '));
    return lines;
  }

  function markdown(n, meta) {
    var o = ['# ' + (meta.title || 'Meeting') + ' (notes)', ''];
    header(meta).forEach(function (l) { o.push('- ' + l); });
    o.push('');
    if (n.empty) { o.push('There was not enough speech to build notes from.', ''); return o.join('\n'); }
    function who(x) { return x ? ' (' + x + ')' : ''; }
    o.push('## Summary', '');
    n.overview.forEach(function (x) { o.push('- ' + x.text + ' [' + clock(x.t) + ']'); });
    if (n.keywords.length) o.push('', '**Key terms:** ' + n.keywords.join(', '));
    if (n.topics.length) {
      o.push('', '## Topics through the conversation', '');
      n.topics.forEach(function (x) { o.push('- **' + clock(x.t) + '  ' + x.title + '.** ' + x.text); });
    }
    if (n.decisions.length) {
      o.push('', '## Decisions', '');
      n.decisions.forEach(function (x) { o.push('- ' + x.text + who(x.who) + ' [' + clock(x.t) + ']'); });
    }
    if (n.actions.length) {
      o.push('', '## Action items', '');
      n.actions.forEach(function (x) {
        o.push('- [ ] ' + x.text + (x.owner ? ' **Owner:** ' + x.owner + '.' : (x.said ? ' (said by ' + x.said + ')' : '')) + (x.due ? ' **When:** ' + x.due + '.' : '') + ' [' + clock(x.t) + ']');
      });
    }
    if (n.questions.length) {
      o.push('', '## Questions raised', '');
      n.questions.forEach(function (x) { o.push('- ' + x.text + who(x.who) + ' [' + clock(x.t) + ']'); });
    }
    if (n.figures.length) {
      o.push('', '## Numbers, dates and amounts mentioned', '');
      n.figures.forEach(function (x) { o.push('- ' + x.text + ' [' + clock(x.t) + ']'); });
    }
    if (n.speakers.length) {
      o.push('', '## By speaker', '');
      n.speakers.forEach(function (s) {
        o.push('### ' + s.name + ' (' + Math.round(s.share * 100) + '% of talking, ' + clock(s.secs) + ')', '');
        if (s.topics.length) o.push('Talked about: ' + s.topics.join(', '), '');
        s.points.forEach(function (p) { o.push('- ' + p.text + ' [' + clock(p.t) + ']'); });
        o.push('');
      });
    }
    if (n.flagged.length) {
      o.push('', '## Flagged moments', '');
      n.flagged.forEach(function (x) { o.push('- ' + clock(x.t) + (x.text ? ': ' + x.text : '')); });
    }
    o.push('', '_Notes were built on this phone by picking out sentences that were actually said. Check them against the full transcript before relying on them._', '');
    return o.join('\n');
  }

  function text(n, meta) {
    return markdown(n, meta)
      .replace(/^### (.*)$/gm, '$1').replace(/^## (.*)$/gm, '\n$1\n' + '').replace(/^# (.*)$/gm, '$1')
      .replace(/\*\*/g, '').replace(/^_(.*)_$/gm, '$1').replace(/\n{3,}/g, '\n\n');
  }

  var api = { build: build, markdown: markdown, text: text, clock: clock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Notes = api;
})(typeof self !== 'undefined' ? self : this);
