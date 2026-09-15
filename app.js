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
  var prog = { pos:{}, done:{}, last:null, wrong:[] };
  try {
    var got = localStorage.getItem(LS);
    if (got) prog = Object.assign(prog, JSON.parse(got));
  } catch(e){}
  if (!Array.isArray(prog.wrong)) prog.wrong = [];

  var db = null, saveTimer = null, syncNote = '';
  function persist(){
    try { localStorage.setItem(LS, JSON.stringify(prog)); } catch(e){}
    if (!db) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){
      db.doc('progress/state').set({
        pos: prog.pos, done: prog.done, last: prog.last,
        wrong: prog.wrong, at: Date.now()
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
          if (Array.isArray(r.wrong)){
            var have = {};
            prog.wrong.forEach(function(c){ have[c.w] = 1; });
            r.wrong.forEach(function(c){ if (c && c.w && !have[c.w]) prog.wrong.push(c); });
          }
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

  /* ---------------- 常错词 ---------------- */
  function wrongIdx(w){
    for (var i = 0; i < prog.wrong.length; i++) if (prog.wrong[i].w === w) return i;
    return -1;
  }
  function addWrong(c){
    if (wrongIdx(c.w) >= 0) return false;
    prog.wrong.unshift({ w:c.w, p:c.p || '', m:(c.m || []).slice(0, 3) });
    persist();
    return true;
  }
  function removeWrong(w){
    var i = wrongIdx(w);
    if (i < 0) return false;
    prog.wrong.splice(i, 1);
    persist();
    return true;
  }
  function wrongBook(){
    return { key:'wrong', title:'常错词', decks:[{ n:1, cards:prog.wrong.slice() }] };
  }

  var toastEl = null, toastTimer = null;
  function toast(msg){
    if (!toastEl){
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(function(){ toastEl.classList.add('on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('on'); }, 1500);
  }
  function buzz(){
    try { if (navigator.vibrate) navigator.vibrate(18); } catch(e){}
  }

  /* ---------------- back to top ---------------- */
  var topBtn = null;
  function ensureTopBtn(){
    if (topBtn) return topBtn;
    topBtn = document.createElement('button');
    topBtn.className = 'totop';
    topBtn.type = 'button';
    topBtn.setAttribute('aria-label', '回到顶部');
    topBtn.textContent = '↑';
    topBtn.addEventListener('click', function(){
      try { window.scrollTo({ top:0, behavior:'smooth' }); }
      catch(e){ window.scrollTo(0, 0); }
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
    document.body.appendChild(topBtn);
    return topBtn;
  }
  function setTopBtn(on){
    ensureTopBtn();
    topBtn.classList.toggle('on', !!on);
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

    rows += '<button class="book wrong" data-book="__wrong">' +
      '<span class="n">' + prog.wrong.length + ' 词</span>' +
      '<span class="t">常错词</span>' +
      '<span class="s">' + (prog.wrong.length
        ? '你自己攒的 · 长按卡片可移出'
        : '还是空的 · 背词时长按卡片加进来') + '</span>' +
    '</button>';

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
      el.addEventListener('click', function(){
        var k = el.getAttribute('data-book');
        if (k === '__wrong') openWrong(); else openBook(k);
      });
    });
    wireVoicePanel();
    setTopBtn(false);
  }

  /* ---------------- view: 常错词列表 ---------------- */
  function openWrong(){
    state.view = 'wrong';
    shelfBar();
    setTopBtn(prog.wrong.length > 8);

    if (!prog.wrong.length){
      view.innerHTML =
        '<div class="wrap">' +
          '<h2>常错词</h2>' +
          '<p class="sub">0 词</p>' +
          '<div class="empty">这里还是空的。<br>背词的时候<b>长按卡片</b>,那个词就会存进来。</div>' +
        '</div>';
      return;
    }

    var rows = prog.wrong.map(function(c, i){
      return '<div class="wrow">' +
        '<span class="wmain">' +
          '<span class="ww">' + esc(c.w) +
            (c.p ? '<span class="wp">' + esc(c.p) + '</span>' : '') + '</span>' +
          '<span class="wm">' + esc((c.m || []).join(' / ')) + '</span>' +
        '</span>' +
        '<button class="wdel" data-i="' + i + '" aria-label="移出常错词">×</button>' +
      '</div>';
    }).join('');

    view.innerHTML =
      '<div class="wrap">' +
        '<h2>常错词</h2>' +
        '<p class="sub">' + prog.wrong.length + ' 词 · 最近加的在最上面</p>' +
        '<div class="startrow"><button id="w-start">背这些词</button></div>' +
        '<div class="wlist">' + rows + '</div>' +
      '</div>';

    document.getElementById('w-start').addEventListener('click', function(){
      openDeck(wrongBook(), 1);
    });
    Array.prototype.forEach.call(view.querySelectorAll('.wdel'), function(el){
      el.addEventListener('click', function(){
        var c = prog.wrong[parseInt(el.getAttribute('data-i'), 10)];
        if (!c) return;
        removeWrong(c.w);
        toast('已移出「' + c.w + '」');
        openWrong();
      });
    });
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
    setTopBtn(true);
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
    setTopBtn(false);
    bar.innerHTML =
      '<button class="back" id="s-back">← ' + esc(b.title) + '</button>' +
      '<span class="spacer"></span>' +
      '<span class="meta" id="s-meta"></span>';
    document.getElementById('s-back').addEventListener('click', function(){
      if (b.key === 'wrong') openWrong(); else renderDecks(b);
    });

    view.innerHTML =
      '<div class="study">' +
        '<div class="rail"><i id="s-rail"></i></div>' +
        '<div class="stage" id="s-stage">' +
          '<div class="drag" id="s-drag">' +
            '<div class="inner" id="s-inner">' +
              '<div class="face front">' +
                '<span class="star" id="s-star">常错词</span>' +
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
          '<span><b>长按</b> ' + (b.key === 'wrong' ? '移出' : '存进常错词') + '</span>' +
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
    document.getElementById('s-star').classList.toggle('on',
      b.key !== 'wrong' && wrongIdx(c.w) >= 0);
    document.getElementById('s-zh').innerHTML = renderZh(c.m);
    document.getElementById('s-meta').textContent =
      (b.key === 'wrong' ? '常错词' : '第 ' + cur.n + ' 页') +
      ' · ' + (state.idx + 1) + ' / ' + cards.length;
    document.getElementById('s-rail').style.width =
      ((state.idx + 1) / cards.length * 100) + '%';
    document.getElementById('s-inner').classList.toggle('flipped', state.flipped);
    prog.pos[keyOf(b.key, cur.n)] = state.idx;
    persist();
  }

  function finish(b){
    var isWrong = b.key === 'wrong';
    if (!isWrong){
      var k = keyOf(b.key, cur.n);
      prog.done[k] = 1; prog.pos[k] = 0; persist();
    }
    document.getElementById('s-meta').textContent =
      isWrong ? '常错词 · 完成' : '第 ' + cur.n + ' 页 · 完成';
    document.getElementById('s-rail').style.width = '100%';
    document.getElementById('s-stage').outerHTML =
      '<div class="done">' +
        '<p>' + (isWrong ? '常错词过完了' : '第 ' + cur.n + ' 页过完了') +
          ' —— ' + cur.cards.length + ' 个词。</p>' +
        '<button id="s-again">再过一遍</button> ' +
        '<button id="s-next">' + (isWrong ? '回到常错词' : '下一页') + '</button>' +
      '</div>';
    document.getElementById('s-hint').style.display = 'none';
    document.getElementById('s-again').addEventListener('click', function(){
      state.idx = 0; state.flipped = false; renderStudy(b);
    });
    document.getElementById('s-next').addEventListener('click', function(){
      if (isWrong) return openWrong();
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
    var holdTimer = null, held = false;

    function clearHold(){ clearTimeout(holdTimer); holdTimer = null; }

    function onHold(){
      held = true;
      buzz();
      var c = cur.cards[state.idx];
      if (!c) return;
      if (b.key === 'wrong'){
        removeWrong(c.w);
        toast('已移出「' + c.w + '」');
        cur.cards.splice(state.idx, 1);
        if (!cur.cards.length){ openWrong(); return; }
        if (state.idx >= cur.cards.length) state.idx = cur.cards.length - 1;
        state.flipped = false;
        inner.classList.remove('flipped');
        paint(b);
      } else {
        if (addWrong(c)) toast('已存进常错词');
        else { removeWrong(c.w); toast('已移出常错词'); }
        document.getElementById('s-star').classList.toggle('on', wrongIdx(c.w) >= 0);
      }
    }

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
      active = true; moved = false; held = false;
      sx = e.clientX; sy = e.clientY; st = Date.now();
      reset(false);
      try { stage.setPointerCapture(e.pointerId); } catch(err){}
      clearHold();
      holdTimer = setTimeout(function(){ if (active && !moved) onHold(); }, 550);
    });

    stage.addEventListener('contextmenu', function(e){ e.preventDefault(); });

    stage.addEventListener('pointermove', function(e){
      if (!active) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5){ moved = true; clearHold(); }
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
      clearHold();
      var dx = e.clientX - sx, dy = e.clientY - sy;
      var dt = Date.now() - st, ax = Math.abs(dx), ay = Math.abs(dy);

      if (held){ held = false; reset(false); return; }

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
    stage.addEventListener('pointercancel', function(){
      active = false; held = false; clearHold(); reset(true);
    });

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
