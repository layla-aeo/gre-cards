(function(){
  "use strict";

  var BOOKS = window.__index || [];
  var cache = {}, waiting = {};
  window.__deck = function(payload){
    cache[payload.key] = payload;
    (waiting[payload.key] || []).forEach(function(fn){ fn(payload); });
    waiting[payload.key] = [];
  };

  function loadBook(key){
    return new Promise(function(res, rej){
      if (cache[key]) return res(cache[key]);
      (waiting[key] = waiting[key] || []).push(res);
      if (document.querySelector('script[data-book="' + key + '"]')) return;
      var s = document.createElement('script');
      s.src = 'decks/' + key + '.js';
      s.setAttribute('data-book', key);
      s.onerror = function(){ rej(new Error('load failed')); };
      document.head.appendChild(s);
    });
  }

  /* ---------------- progress: local first, synced when db exists -------- */
  var LS = 'gre-cards-v1';
  var prog = { pos:{}, done:{}, last:null };
  try {
    var got = localStorage.getItem(LS);
    if (got) prog = Object.assign(prog, JSON.parse(got));
  } catch(e){}

  var db = null, saveTimer = null, syncNote = '';
  function persist(){
    try { localStorage.setItem(LS, JSON.stringify(prog)); } catch(e){}
    if (!db) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){
      db.doc('progress/state').set({
        pos: prog.pos, done: prog.done, last: prog.last, at: Date.now()
      }).catch(function(){});
    }, 900);
  }

  if (window.claude && typeof window.claude.use === 'function'){
    window.claude.use('db').then(function(d){
      if (!d) return;
      db = d;
      return d.doc('progress/state').get().then(function(snap){
        if (snap.exists){
          var r = snap.data() || {};
          prog.pos = Object.assign({}, r.pos || {}, prog.pos);
          prog.done = Object.assign({}, r.done || {}, prog.done);
          prog.last = prog.last || r.last || null;
          try { localStorage.setItem(LS, JSON.stringify(prog)); } catch(e){}
        }
        syncNote = '进度已跨设备同步';
        if (state.view === 'shelf') renderShelf();
      });
    }).catch(function(){});
  }

  /* ---------------- speech: British English ---------------- */
  var VOICE_LS = 'gre-cards-voice';
  var voice = null, enVoices = [];
  var PREFER = ['Daniel','Serena','Kate','Arthur','Martha','Oliver','Stephanie','Jamie','Malcolm'];

  function rank(v){
    var s = 0;
    if (/^en[-_]GB/i.test(v.lang)) s += 100;
    else if (/^en[-_](AU|IE|IN|ZA)/i.test(v.lang)) s += 20;
    if (/premium|enhanced/i.test(v.name)) s += 40;
    if (/siri/i.test(v.name)) s += 25;
    if (/google uk/i.test(v.name)) s += 30;
    var i = PREFER.indexOf(String(v.name).split(' ')[0].replace(/[()]/g, ''));
    if (i >= 0) s += 20 - i;
    if (/compact|eloquence|novelty|whisper|bells|bad news|good news/i.test(v.name)) s -= 60;
    return s;
  }

  function pickVoice(){
    try {
      var vs = speechSynthesis.getVoices() || [];
      enVoices = vs.filter(function(v){ return /^en/i.test(v.lang); })
                   .sort(function(a, b){ return rank(b) - rank(a); });
      var saved = null;
      try { saved = localStorage.getItem(VOICE_LS); } catch(e){}
      voice = (saved && enVoices.filter(function(v){ return v.name === saved; })[0])
            || enVoices[0] || null;
    } catch(e){}
  }

  if (window.speechSynthesis){
    pickVoice();
    speechSynthesis.onvoiceschanged = function(){
      pickVoice();
      if (state.view === 'shelf') renderShelf();
    };
  }

  function setVoice(name){
    voice = enVoices.filter(function(v){ return v.name === name; })[0] || voice;
    try { localStorage.setItem(VOICE_LS, name); } catch(e){}
  }

  function speak(w){
    if (!window.speechSynthesis) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(w);
      u.voice = voice || null;
      u.lang = (voice && voice.lang) || 'en-GB';
      u.rate = .82; u.pitch = 1;
      speechSynthesis.speak(u);
    } catch(e){}
  }

  /* ---------------- state / routing ---------------- */
  var state = { view:'shelf', book:null, deck:0, idx:0, flipped:false };
  var bar = document.getElementById('bar');
  var view = document.getElementById('view');

  function esc(s){
    return String(s).replace(/[&<>"]/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
    });
  }
  function keyOf(bk, dk){ return bk + ':' + dk; }

  function bookStats(b){
    var n = 0;
    for (var i = 1; i <= b.decks; i++) if (prog.done[keyOf(b.key, i)]) n++;
    return n;
  }

  /* ---------------- view: shelf ---------------- */
  function renderShelf(){
    state.view = 'shelf';
    var totalCards = BOOKS.reduce(function(a, b){ return a + b.cards; }, 0);
    var totalDecks = BOOKS.reduce(function(a, b){ return a + b.decks; }, 0);
    bar.innerHTML = '';

    var rows = BOOKS.map(function(b){
      var d = bookStats(b);
      var pct = b.decks ? Math.round(d / b.decks * 100) : 0;
      return '<button class="book" data-book="' + esc(b.key) + '">' +
        '<span class="n">' + b.cards + ' 词</span>' +
        '<span class="t">' + esc(b.title) + '</span>' +
        '<span class="s">' + esc(b.sub) + ' · ' + b.decks + ' 个板块' +
          (d ? ' · 已过 ' + d : '') + '</span>' +
        '<span class="track"><i style="width:' + pct + '%"></i></span>' +
      '</button>';
    }).join('');

    var resume = '';
    if (prog.last){
      var lb = BOOKS.filter(function(b){ return b.key === prog.last.book; })[0];
      if (lb) resume = '<p style="margin-top:10px">上次读到 ' + esc(lb.title) +
        ' 第 ' + prog.last.deck + ' 页。</p>';
    }

    view.innerHTML =
      '<div class="shelf">' +
        '<div class="masthead">' +
          '<h1>GRE 词卡</h1>' +
          '<p>' + totalCards + ' 张卡片 · ' + totalDecks + ' 个板块,按原书页码分组,页内乱序。<br>' +
          '左滑下一个 · 右滑上一个 · 上滑看中文 · 点一下发音。</p>' +
          resume +
        '</div>' +
        '<div class="books">' + rows + '</div>' +
        voicePanel() +
      '</div>' +
      '<div class="sync">' + (syncNote ? esc(syncNote) + ' · ' : '') +
        '版本 ' + esc(window.__build || 'artifact') + '</div>';

    Array.prototype.forEach.call(view.querySelectorAll('.book'), function(el){
      el.addEventListener('click', function(){ openBook(el.getAttribute('data-book')); });
    });
    wireVoicePanel();
  }

  function voicePanel(){
    if (!window.speechSynthesis) return '';
    if (!enVoices.length){
      return '<div class="voice"><span class="vl">发音</span><span class="vn">正在载入语音…</span></div>';
    }
    var opts = enVoices.map(function(v){
      var tag = /^en[-_]GB/i.test(v.lang) ? '英音'
              : /^en[-_]US/i.test(v.lang) ? '美音'
              : /^en[-_]AU/i.test(v.lang) ? '澳音'
              : /^en[-_]IE/i.test(v.lang) ? '爱尔兰' : v.lang;
      return '<option value="' + esc(v.name) + '"' +
        (voice && v.name === voice.name ? ' selected' : '') + '>' +
        esc(v.name) + ' · ' + tag + '</option>';
    }).join('');
    return '<div class="voice">' +
      '<span class="vl">发音</span>' +
      '<select id="v-sel">' + opts + '</select>' +
      '<button id="v-try" class="vtry">试听</button>' +
    '</div>' +
    '<p class="vtip">想要更自然的英音:iPhone 设置 → 辅助功能 → 朗读内容 → 声音 → 英语(英国) → 下载 Daniel 或 Serena 的「增强/高级」版,回来在这里选它。</p>';
  }

  function wireVoicePanel(){
    var sel = document.getElementById('v-sel');
    if (!sel) return;
    sel.addEventListener('change', function(){ setVoice(sel.value); speak('vocabulary'); });
    document.getElementById('v-try').addEventListener('click', function(){ speak('meticulous'); });
  }

  /* ---------------- view: deck grid ---------------- */
  function shelfBar(){
    bar.innerHTML = '<button class="back" id="b-back">← 书架</button>';
    document.getElementById('b-back').addEventListener('click', renderShelf);
  }

  function openBook(key){
    state.book = key;
    view.innerHTML = '<div class="loading">载入词库…</div>';
    shelfBar();
    loadBook(key).then(renderDecks).catch(function(){
      view.innerHTML = '<div class="loading">词库载入失败,刷新再试。</div>';
    });
  }

  function renderDecks(b){
    state.view = 'decks';
    shelfBar();
    var cells = b.decks.map(function(d){
      var k = keyOf(b.key, d.n);
      var n = d.cards.length;
      var at = prog.pos[k] || 0;
      var done = prog.done[k] ? 1 : 0;
      var pct = done ? 100 : Math.round(at / n * 100);
      return '<button class="deck" data-n="' + d.n + '" data-done="' + done + '">' +
        (pct ? '<span class="p" style="width:' + pct + '%"></span>' : '') +
        '<span class="np">' + d.n + '</span>' +
        '<span class="nc">' + n + ' 词</span>' +
      '</button>';
    }).join('');

    var total = b.decks.reduce(function(a, d){ return a + d.cards.length; }, 0);
    view.innerHTML =
      '<div class="decks">' +
        '<h2>' + esc(b.title) + '</h2>' +
        '<p class="sub">' + b.decks.length + ' 个板块 · ' + total + ' 词 · 按原书页码分组</p>' +
        '<div class="grid">' + cells + '</div>' +
      '</div>';

    Array.prototype.forEach.call(view.querySelectorAll('.deck'), function(el){
      el.addEventListener('click', function(){
        openDeck(b, parseInt(el.getAttribute('data-n'), 10));
      });
    });
  }

  /* ---------------- view: study ---------------- */
  var cur = null;
  function openDeck(b, n){
    state.view = 'study'; state.deck = n; state.flipped = false;
    cur = b.decks.filter(function(d){ return d.n === n; })[0];
    var k = keyOf(b.key, n);
    var at = prog.pos[k] || 0;
    state.idx = (prog.done[k] || at >= cur.cards.length) ? 0 : at;
    prog.last = { book:b.key, deck:n };
    persist();
    renderStudy(b);
  }

  function renderStudy(b){
    bar.innerHTML =
      '<button class="back" id="s-back">← ' + esc(b.title) + '</button>' +
      '<span class="spacer"></span>' +
      '<span class="meta" id="s-meta"></span>';
    document.getElementById('s-back').addEventListener('click', function(){ renderDecks(b); });

    view.innerHTML =
      '<div class="study">' +
        '<div class="rail"><i id="s-rail"></i></div>' +
        '<div class="stage" id="s-stage">' +
          '<div class="drag" id="s-drag">' +
            '<div class="inner" id="s-inner">' +
              '<div class="face front">' +
                '<div class="word" id="s-word"></div>' +
                '<div class="ipa" id="s-ipa"></div>' +
              '</div>' +
              '<div class="face back">' +
                '<div class="echo" id="s-echo"></div>' +
                '<div class="zh" id="s-zh"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="hint" id="s-hint">' +
          '<span><b>←</b> 下一个</span><span><b>→</b> 上一个</span>' +
          '<span><b>↑</b> 中文</span><span><b>点</b> 发音</span>' +
        '</div>' +
      '</div>';

    paint(b);
    wireGestures(b);
  }

  var POS_RE = /^((?:adj|adv|vt|vi|v|n|conj|prep|pron|int|abbr|num|art)\.)\s*(.*)$/;
  function renderZh(list){
    return (list || []).map(function(s){
      var m = String(s).match(POS_RE);
      return '<span class="sense">' +
        (m ? '<span class="pos">' + esc(m[1]) + '</span>' + esc(m[2]) : esc(s)) +
      '</span>';
    }).join('');
  }

  function paint(b){
    var cards = cur.cards;
    if (state.idx >= cards.length) return finish(b);
    var c = cards[state.idx];
    var w = document.getElementById('s-word');
    w.textContent = c.w;
    w.className = 'word' + (c.w.length > 17 ? ' xlong' : c.w.length > 11 ? ' long' : '');
    document.getElementById('s-ipa').textContent = c.p || '';
    document.getElementById('s-echo').textContent = c.w;
    document.getElementById('s-zh').innerHTML = renderZh(c.m);
    document.getElementById('s-meta').textContent =
      '第 ' + cur.n + ' 页 · ' + (state.idx + 1) + ' / ' + cards.length;
    document.getElementById('s-rail').style.width =
      ((state.idx + 1) / cards.length * 100) + '%';
    document.getElementById('s-inner').classList.toggle('flipped', state.flipped);
    prog.pos[keyOf(b.key, cur.n)] = state.idx;
    persist();
  }

  function finish(b){
    var k = keyOf(b.key, cur.n);
    prog.done[k] = 1; prog.pos[k] = 0; persist();
    document.getElementById('s-meta').textContent = '第 ' + cur.n + ' 页 · 完成';
    document.getElementById('s-rail').style.width = '100%';
    document.getElementById('s-stage').outerHTML =
      '<div class="done">' +
        '<p>第 ' + cur.n + ' 页过完了 —— ' + cur.cards.length + ' 个词。</p>' +
        '<button id="s-again">再过一遍</button> <button id="s-next">下一页</button>' +
      '</div>';
    document.getElementById('s-hint').style.display = 'none';
    document.getElementById('s-again').addEventListener('click', function(){
      state.idx = 0; state.flipped = false; renderStudy(b);
    });
    document.getElementById('s-next').addEventListener('click', function(){
      var nx = b.decks.filter(function(d){ return d.n === cur.n + 1; })[0];
      if (nx) openDeck(b, nx.n); else renderDecks(b);
    });
  }

  /* ---------------- gestures ---------------- */
  function wireGestures(b){
    var stage = document.getElementById('s-stage');
    var drag = document.getElementById('s-drag');
    var inner = document.getElementById('s-inner');
    var hint = document.getElementById('s-hint');
    var sx = 0, sy = 0, st = 0, moved = false, active = false, used = false;

    function reset(anim){
      drag.style.transition = anim ? 'transform .28s cubic-bezier(.3,.7,.3,1)' : 'none';
      drag.style.transform = '';
      drag.style.opacity = '';
    }
    function fade(){ if (!used){ used = true; hint.classList.add('dim'); } }

    function advance(dir){
      fade();
      var out = dir > 0 ? -1 : 1;
      drag.style.transition = 'transform .2s ease-out, opacity .2s ease-out';
      drag.style.transform = 'translateX(' + (out * 120) + '%) rotate(' + (out * 6) + 'deg)';
      drag.style.opacity = '0';
      setTimeout(function(){
        var next = state.idx + dir;
        if (next < 0){ reset(false); return; }
        state.idx = next;
        state.flipped = false;
        inner.style.transition = 'none';
        inner.classList.remove('flipped');
        drag.style.transition = 'none';
        drag.style.transform = 'translateX(' + (-out * 60) + '%)';
        drag.style.opacity = '0';
        if (state.idx >= cur.cards.length){ finish(b); return; }
        paint(b);
        requestAnimationFrame(function(){
          inner.style.transition = '';
          drag.style.transition = 'transform .22s cubic-bezier(.3,.7,.3,1), opacity .22s ease';
          drag.style.transform = '';
          drag.style.opacity = '1';
        });
      }, 175);
    }

    function flip(){
      fade();
      state.flipped = !state.flipped;
      inner.style.transition = '';
      inner.classList.toggle('flipped', state.flipped);
    }

    stage.addEventListener('pointerdown', function(e){
      active = true; moved = false;
      sx = e.clientX; sy = e.clientY; st = Date.now();
      reset(false);
      try { stage.setPointerCapture(e.pointerId); } catch(err){}
    });

    stage.addEventListener('pointermove', function(e){
      if (!active) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (Math.abs(dx) >= Math.abs(dy)){
        drag.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 26) + 'deg)';
      } else if (dy < 0){
        drag.style.transform = 'translateY(' + (dy / 3) + 'px)';
      } else {
        drag.style.transform = 'translateY(' + (dy / 5) + 'px)';
      }
    });

    function release(e){
      if (!active) return;
      active = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      var dt = Date.now() - st, ax = Math.abs(dx), ay = Math.abs(dy);

      if (!moved && dt < 500){
        reset(false);
        speak(cur.cards[state.idx].w);
        fade();
        return;
      }
      if (ax >= ay && ax > 55){
        if (dx < 0) advance(1);
        else if (state.idx > 0) advance(-1);
        else reset(true);
        return;
      }
      if (ay > ax && ay > 45){ reset(true); flip(); return; }
      reset(true);
    }

    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', function(){ active = false; reset(true); });

    document.onkeydown = function(e){
      if (state.view !== 'study') return;
      if (e.key === 'ArrowLeft'){ e.preventDefault(); advance(1); }
      else if (e.key === 'ArrowRight'){ e.preventDefault(); if (state.idx > 0) advance(-1); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown'){ e.preventDefault(); flip(); }
      else if (e.key === ' '){ e.preventDefault(); speak(cur.cards[state.idx].w); }
    };
  }

  renderShelf();
})();
