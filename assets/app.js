(function(){
  "use strict";

  var CATALOG = window.__books || [];
  var cache = {}, waiting = {};
  window.__book = function(b){
    cache[b.key] = b;
    (waiting[b.key] || []).forEach(function(fn){ fn(b); });
    waiting[b.key] = [];
  };

  function loadBook(key){
    return new Promise(function(res, rej){
      if (cache[key]) return res(cache[key]);
      (waiting[key] = waiting[key] || []).push(res);
      if (document.querySelector('script[data-book="' + key + '"]')) return;
      var s = document.createElement('script');
      s.src = 'books/' + key + '.js';
      s.setAttribute('data-book', key);
      s.onerror = function(){ rej(new Error('load failed')); };
      document.head.appendChild(s);
    });
  }

  // 一个义项可能挂多个词性:"vt. vi. 散发"
  var POS_RE = /^((?:(?:adj|adv|vt|vi|v|n|conj|prep|pron|int|abbr|num|art)\.\s*)+)(.*)$/;

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
    });
  }

  /* ================= account + storage ================= */
  var auth = null, store = null, me = null, authReady = false, authErr = '';

  var blank = { myBook:null, pos:{}, done:{}, last:null, wrong:[] };
  var data = JSON.parse(JSON.stringify(blank));

  function lsKey(){ return 'gre-cards:' + (me ? me.uid : 'local'); }

  function loadLocal(){
    var d = JSON.parse(JSON.stringify(blank));
    try {
      var raw = localStorage.getItem(lsKey());
      if (raw) d = Object.assign(d, JSON.parse(raw));
    } catch(e){}
    if (!Array.isArray(d.wrong)) d.wrong = [];
    data = d;
  }

  var saveTimer = null;
  function persist(){
    try { localStorage.setItem(lsKey(), JSON.stringify(data)); } catch(e){}
    if (!store || !me) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){
      store.collection('users').doc(me.uid).set({
        myBook: data.myBook, pos: data.pos, done: data.done,
        last: data.last, wrong: data.wrong, at: Date.now()
      }).catch(function(){});
    }, 900);
  }

  function mergeRemote(r){
    if (!r) return;
    data.pos = Object.assign({}, r.pos || {}, data.pos);
    data.done = Object.assign({}, r.done || {}, data.done);
    data.last = data.last || r.last || null;
    data.myBook = data.myBook || r.myBook || null;
    if (Array.isArray(r.wrong)){
      var have = {};
      data.wrong.forEach(function(c){ have[c.w] = 1; });
      r.wrong.forEach(function(c){ if (c && c.w && !have[c.w]) data.wrong.push(c); });
    }
    try { localStorage.setItem(lsKey(), JSON.stringify(data)); } catch(e){}
  }

  function initFirebase(){
    var cfg = window.__firebase;
    if (!cfg || typeof firebase === 'undefined'){ authReady = true; return; }
    try {
      firebase.initializeApp(cfg);
      auth = firebase.auth();
      store = firebase.firestore();
      auth.onAuthStateChanged(function(u){
        authReady = true;
        me = u ? { uid:u.uid, email:u.email } : null;
        loadLocal();
        render();
        if (!me || !store) return;
        store.collection('users').doc(me.uid).get().then(function(snap){
          if (snap.exists) mergeRemote(snap.data());
          render();
        }).catch(function(){});
      });
    } catch(e){
      authErr = e.message || '初始化失败';
      authReady = true;
    }
  }

  /* ================= pronunciation ================= */
  var VOICE_LS = 'gre-cards-voice', AUDIO_LS = 'gre-cards-audio';
  var voice = null, enVoices = [];
  var useAudio = true;
  try { useAudio = localStorage.getItem(AUDIO_LS) !== '0'; } catch(e){}

  var PREFER = ['Daniel','Serena','Kate','Arthur','Martha','Oliver','Stephanie'];
  function rank(v){
    var s = 0;
    if (/^en[-_]GB/i.test(v.lang)) s += 100;
    else if (/^en[-_](AU|IE|IN|ZA)/i.test(v.lang)) s += 20;
    if (/premium|enhanced/i.test(v.name)) s += 40;
    if (/siri/i.test(v.name)) s += 25;
    if (/google uk/i.test(v.name)) s += 30;
    var i = PREFER.indexOf(String(v.name).split(' ')[0].replace(/[()]/g, ''));
    if (i >= 0) s += 20 - i;
    if (/compact|eloquence|novelty|whisper|bells/i.test(v.name)) s -= 60;
    return s;
  }
  function pickVoice(){
    try {
      enVoices = (speechSynthesis.getVoices() || [])
        .filter(function(v){ return /^en/i.test(v.lang); })
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
      if (tab === 'home') render();
    };
  }

  function speakSynth(text){
    if (!window.speechSynthesis) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.voice = voice || null;
      u.lang = (voice && voice.lang) || 'en-GB';
      u.rate = .84; u.pitch = 1;
      speechSynthesis.speak(u);
    } catch(e){}
  }

  // Recorded British audio from the Youdao dictionary; falls back to the
  // device voice when the network or the entry is unavailable.
  var player = null;
  function speak(text, forceSynth){
    var one = /^[A-Za-z][A-Za-z'\- ]*$/.test(text) && text.split(' ').length <= 3;
    if (forceSynth || !useAudio || !one) return speakSynth(text);
    try {
      if (!player){ player = new Audio(); player.preload = 'none'; }
      player.pause();
      player.src = 'https://dict.youdao.com/dictvoice?type=1&audio=' +
                   encodeURIComponent(text);
      player.onerror = function(){ speakSynth(text); };
      var p = player.play();
      if (p && p.catch) p.catch(function(){ speakSynth(text); });
    } catch(e){ speakSynth(text); }
  }

  /* ================= shared chrome ================= */
  var tab = 'vocab';
  var bar = document.getElementById('bar');
  var view = document.getElementById('view');
  var nav = document.getElementById('nav');

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
    toastTimer = setTimeout(function(){ toastEl.classList.remove('on'); }, 1600);
  }
  function buzz(){ try { if (navigator.vibrate) navigator.vibrate(18); } catch(e){} }

  var topBtn = null;
  function setTopBtn(on){
    if (!topBtn){
      topBtn = document.createElement('button');
      topBtn.className = 'totop';
      topBtn.textContent = '↑';
      topBtn.setAttribute('aria-label', '回到顶部');
      topBtn.addEventListener('click', function(){
        try { window.scrollTo({ top:0, behavior:'smooth' }); } catch(e){ window.scrollTo(0,0); }
        document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
      });
      document.body.appendChild(topBtn);
    }
    topBtn.classList.toggle('on', !!on);
  }

  var NAV = [
    { k:'vocab', ic:'◆', t:'词汇' },
    { k:'books', ic:'▤', t:'词书' },
    { k:'home',  ic:'◉', t:'主页' }
  ];
  function renderNav(){
    nav.innerHTML = '<div class="inner">' + NAV.map(function(n){
      return '<button data-tab="' + n.k + '"' +
        (tab === n.k ? ' aria-current="page"' : '') + '>' +
        '<span class="ic">' + n.ic + '</span>' + n.t + '</button>';
    }).join('') + '</div>';
    Array.prototype.forEach.call(nav.querySelectorAll('button'), function(el){
      el.addEventListener('click', function(){ go(el.getAttribute('data-tab')); });
    });
  }

  function go(t){
    tab = t;
    sub = null;
    closePull();
    window.scrollTo(0, 0);
    render();
  }

  /* ================= 常错词 ================= */
  function wrongIdx(w){
    for (var i = 0; i < data.wrong.length; i++) if (data.wrong[i].w === w) return i;
    return -1;
  }
  function addWrong(c){
    if (wrongIdx(c.w) >= 0) return false;
    var e = { w:c.w, p:c.p || '', m:(c.m || []).slice(0, 3) };
    if (c.x) e.x = c.x;
    data.wrong.unshift(e);
    persist();
    return true;
  }
  function removeWrong(w){
    var i = wrongIdx(w);
    if (i < 0) return false;
    data.wrong.splice(i, 1);
    persist();
    return true;
  }
  function wrongBook(){
    return { key:'wrong', title:'常错词',
             decks:[{ n:1, name:'常错词', cards:data.wrong.slice() }] };
  }

  /* ================= router ================= */
  // sub = {view:'decks'|'study'|'wronglist'|'preview', book, deck, idx, flipped, sflip}
  var sub = null;

  function render(){
    renderNav();
    setTopBtn(false);
    if (sub) return sub.draw();
    if (tab === 'books') return viewBooks();
    if (tab === 'home') return viewHome();
    return viewVocab();
  }

  function key(bk, dk){ return bk + ':' + dk; }

  /* ---------------- 词汇 ---------------- */
  function viewVocab(){
    bar.innerHTML = '';
    var picked = data.myBook;
    var meta = CATALOG.filter(function(b){ return b.key === picked; })[0];

    var wrongRow =
      '<button class="book wrong" data-open="wrong">' +
        '<span class="n">' + data.wrong.length + ' 词</span>' +
        '<span class="t">常错词</span>' +
        '<span class="s">' + (data.wrong.length
          ? '你自己攒的 · 长按卡片可移出' : '还是空的 · 背词时长按卡片加进来') + '</span>' +
      '</button>';

    if (!meta){
      view.innerHTML =
        '<div class="pad">' +
          '<div class="masthead"><h1>我的词汇</h1>' +
            '<p>还没有选词书。去「词书」挑一本加进来,就能开始背了。</p></div>' +
          '<div class="empty">词汇是空的<br><br>' +
            '<button class="btn pri" id="v-go">去词书看看</button></div>' +
          '<div style="height:18px"></div>' + wrongRow +
        '</div>';
      document.getElementById('v-go').addEventListener('click', function(){ go('books'); });
      wireOpen();
      return;
    }

    view.innerHTML = '<div class="loading">载入词库…</div>';
    loadBook(picked).then(function(b){
      // A book made of parts (GRE) lists its source books first.
      if (b.parts) return drawParts(b, meta, wrongRow);
      drawDecks(b, meta.cards, wrongRow, null);
    }).catch(function(){
      view.innerHTML = '<div class="loading">词库载入失败,刷新再试。</div>';
    });
  }

  function partStats(p){
    var done = 0;
    for (var i = 1; i <= p.decks; i++) if (data.done[key(p.key, i)]) done++;
    return done;
  }

  function drawParts(b, meta, wrongRow){
    view.innerHTML =
      '<div class="pad">' +
        '<div class="masthead"><h1>' + esc(b.title) + '</h1>' +
          '<p>' + meta.cards + ' 词 · ' + b.parts.length + ' 本原书 · ' +
            meta.decks + ' 页</p></div>' +
        wrongRow +
        '<div style="height:18px"></div>' +
        '<div class="books">' + b.parts.map(function(p){
          var d = partStats(p);
          var pct = Math.round(d / p.decks * 100);
          return '<button class="book" data-p="' + esc(p.key) + '">' +
            '<span class="n">' + p.cards + ' 词</span>' +
            '<span class="t">' + esc(p.title) + '</span>' +
            '<span class="s">' + esc(p.sub) + ' · ' + p.decks + ' 页' +
              (d ? ' · 已过 ' + d : '') + '</span>' +
            '<span class="track"><i style="width:' + pct + '%"></i></span>' +
          '</button>';
        }).join('') + '</div>' +
      '</div>';
    Array.prototype.forEach.call(view.querySelectorAll('.book'), function(el){
      el.addEventListener('click', function(){ openPart(el.getAttribute('data-p')); });
    });
    wireOpen();
    setTopBtn(true);
  }

  function openPart(pkey){
    sub = { view:'part', pkey:pkey, draw:function(){ drawPart(pkey); } };
    drawPart(pkey);
  }

  function drawPart(pkey){
    renderNav();
    bar.innerHTML = '<button class="back" id="b-back">← 词汇</button>';
    document.getElementById('b-back').addEventListener('click', function(){ sub = null; render(); });
    view.innerHTML = '<div class="loading">载入…</div>';
    loadBook(pkey).then(function(p){
      drawDecks(p, null, '', function(){ sub = null; render(); });
    }).catch(function(){
      view.innerHTML = '<div class="loading">载入失败,刷新再试。</div>';
    });
  }

  function drawDecks(b, totalWords, wrongRow, back){
    var doneN = 0;
    b.decks.forEach(function(d){ if (data.done[key(b.key, d.n)]) doneN++; });
    var pct = Math.round(doneN / b.decks.length * 100);
    var total = totalWords != null ? totalWords :
      b.decks.reduce(function(a, d){ return a + d.cards.length; }, 0);
    var byPage = /^第 \d+ 页$/.test(b.decks[0].name);

    var resume = '';
    if (data.last && data.last.book === b.key){
      var ld = b.decks.filter(function(d){ return d.n === data.last.deck; })[0];
      if (ld) resume = '<button class="btn pri" id="v-resume">继续 ' +
        esc(ld.name.split(' · ').slice(-1)[0]) + '</button>';
    }

    view.innerHTML =
      '<div class="pad">' +
        '<div class="masthead"><h1>' + esc(b.title) + '</h1>' +
          '<p>' + total + ' 词 · ' + b.decks.length + (byPage ? ' 页' : ' 个板块') +
          (doneN ? ' · 已过 ' + doneN : '') + '</p>' +
          '<div class="track" style="margin-top:12px"><i style="width:' + pct + '%"></i></div>' +
          (resume ? '<div style="margin-top:14px">' + resume + '</div>' : '') +
        '</div>' +
        (wrongRow ? wrongRow + '<div style="height:18px"></div>' : '') +
        '<div class="grid">' + b.decks.map(function(d){
          var k = key(b.key, d.n);
          var at = data.pos[k] || 0, done = data.done[k] ? 1 : 0;
          var p = done ? 100 : Math.round(at / d.cards.length * 100);
          var short = d.name.split(' · ').slice(-1)[0];
          return '<button class="deck" data-n="' + d.n + '" data-done="' + done + '">' +
            (p ? '<span class="p" style="width:' + p + '%"></span>' : '') +
            '<span class="np' + (byPage ? '' : ' sm') + '">' +
              esc(byPage ? d.n : short) + '</span>' +
            '<span class="nc">' + d.cards.length + ' 词</span>' +
          '</button>';
        }).join('') + '</div>' +
      '</div>';

    if (resume){
      document.getElementById('v-resume').addEventListener('click', function(){
        openDeck(b, data.last.deck, back);
      });
    }
    Array.prototype.forEach.call(view.querySelectorAll('.deck'), function(el){
      el.addEventListener('click', function(){
        openDeck(b, parseInt(el.getAttribute('data-n'), 10), back);
      });
    });
    wireOpen();
    setTopBtn(true);
  }

  function wireOpen(){
    Array.prototype.forEach.call(view.querySelectorAll('[data-open="wrong"]'), function(el){
      el.addEventListener('click', openWrongList);
    });
  }

  /* ---------------- 常错词列表 ---------------- */
  function openWrongList(){
    sub = { view:'wronglist', draw:drawWrongList };
    drawWrongList();
  }
  function drawWrongList(){
    renderNav();
    bar.innerHTML = '<button class="back" id="b-back">← 词汇</button>';
    document.getElementById('b-back').addEventListener('click', function(){ sub = null; render(); });
    setTopBtn(data.wrong.length > 8);

    if (!data.wrong.length){
      view.innerHTML = '<div class="wrap"><h2>常错词</h2><p class="sub">0 词</p>' +
        '<div class="empty">这里还是空的。<br>背词的时候<b>长按单词卡</b>,那个词就会存进来。</div></div>';
      return;
    }
    view.innerHTML =
      '<div class="wrap"><h2>常错词</h2>' +
        '<p class="sub">' + data.wrong.length + ' 词 · 最近加的在最上面</p>' +
        '<div class="row" style="margin-bottom:16px">' +
          '<button class="btn gho" id="w-start">背这些词</button></div>' +
        '<div class="wlist">' + data.wrong.map(function(c, i){
          return '<div class="wrow"><span class="wmain">' +
            '<span class="ww">' + esc(c.w) +
              (c.p ? '<span class="wp">' + esc(c.p) + '</span>' : '') + '</span>' +
            '<span class="wm">' + esc((c.m || []).join(' / ')) + '</span></span>' +
            '<button class="wdel" data-i="' + i + '" aria-label="移出">×</button></div>';
        }).join('') + '</div></div>';

    document.getElementById('w-start').addEventListener('click', function(){
      openDeck(wrongBook(), 1);
    });
    Array.prototype.forEach.call(view.querySelectorAll('.wdel'), function(el){
      el.addEventListener('click', function(){
        var c = data.wrong[parseInt(el.getAttribute('data-i'), 10)];
        if (!c) return;
        removeWrong(c.w);
        toast('已移出「' + c.w + '」');
        drawWrongList();
      });
    });
  }

  /* ---------------- 词书 ---------------- */
  function viewBooks(){
    bar.innerHTML = '';
    view.innerHTML =
      '<div class="pad">' +
        '<div class="masthead"><h1>词书</h1>' +
          '<p>选一本加进「词汇」,就能开始背。同一时间学一本,随时可以换。</p></div>' +
        groupedBooks() +
      '</div>';
    Array.prototype.forEach.call(view.querySelectorAll('.book'), function(el){
      el.addEventListener('click', function(){ preview(el.getAttribute('data-b')); });
    });
  }

  function groupedBooks(){
    var groups = [], byKey = {};
    CATALOG.forEach(function(b){
      var g = b.group || '其他';
      if (!byKey[g]){ byKey[g] = []; groups.push(g); }
      byKey[g].push(b);
    });
    return groups.map(function(g){
      var n = byKey[g].reduce(function(a, b){ return a + b.cards; }, 0);
      return '<div class="ghead">' + esc(g) +
             '<span>' + byKey[g].length + ' 本 · ' + n + ' 词</span></div>' +
        '<div class="books">' + byKey[g].map(function(b){
          var on = data.myBook === b.key;
          return '<button class="book" data-b="' + esc(b.key) + '">' +
            '<span class="n">' + b.cards + ' 词</span>' +
            '<span class="t">' + esc(b.title) +
              (on ? '<span class="tag">我的词汇</span>' : '') + '</span>' +
            '<span class="s">' + esc(b.sub) + ' · ' + b.decks + ' 个板块' +
              (b.ex ? ' · ' + b.ex + ' 条例句' : '') + '</span>' +
          '</button>';
        }).join('') + '</div>';
    }).join('');
  }

  function preview(k){
    var meta = CATALOG.filter(function(b){ return b.key === k; })[0];
    if (!meta) return;
    sub = { view:'preview', key:k, draw:function(){ drawPreview(meta); } };
    drawPreview(meta);
  }

  function drawPreview(meta){
    renderNav();
    bar.innerHTML = '<button class="back" id="b-back">← 词书</button>';
    document.getElementById('b-back').addEventListener('click', function(){ sub = null; render(); });
    view.innerHTML = '<div class="loading">载入…</div>';

    loadBook(meta.key).then(function(b){
      // A book of parts carries no decks itself; sample from its first part.
      if (b.parts) return loadBook(b.parts[0].key).then(function(p){ return [b, p.decks]; });
      return [b, b.decks];
    }).then(function(pair){
      var b = pair[0], decks = pair[1];
      var on = data.myBook === b.key;
      var sample = [];
      for (var i = 0; i < decks.length && sample.length < 6; i += Math.max(1, (decks.length / 6) | 0)){
        var c = decks[i].cards[0];
        if (c) sample.push(c);
      }
      view.innerHTML =
        '<div class="wrap">' +
          '<h2>' + esc(b.title) + '</h2>' +
          '<p class="sub">' + esc(b.sub) + '</p>' +
          '<div class="card">' +
            '<div class="kv"><span>收词</span><b>' + meta.cards + '</b></div>' +
            (b.parts ? '<div class="kv"><span>原书</span><b>' + b.parts.length + ' 本</b></div>' : '') +
            '<div class="kv"><span>' + (b.parts ? '总页数' : '板块') + '</span><b>' +
              meta.decks + '</b></div>' +
            '<div class="kv"><span>带例句</span><b>' + (meta.ex || 0) + '</b></div>' +
            '<div class="row" style="margin-top:16px">' +
              (on ? '<button class="btn" id="p-go">去背这本</button>' +
                    '<button class="btn gho" id="p-off">从词汇移出</button>'
                  : '<button class="btn pri" id="p-add">添加为我的词汇</button>') +
            '</div>' +
          '</div>' +
          '<div class="card"><h3>随便看几个</h3>' +
            '<div class="wlist">' + sample.map(function(c){
              return '<div class="wrow"><span class="wmain">' +
                '<span class="ww">' + esc(c.w) +
                  (c.p ? '<span class="wp">' + esc(c.p) + '</span>' : '') + '</span>' +
                '<span class="wm">' + esc((c.m || []).join(' / ')) + '</span></span></div>';
            }).join('') + '</div>' +
          '</div>' +
        '</div>';

      var add = document.getElementById('p-add');
      if (add) add.addEventListener('click', function(){
        data.myBook = b.key; persist();
        toast('已添加到词汇');
        sub = null; go('vocab');
      });
      var off = document.getElementById('p-off');
      if (off) off.addEventListener('click', function(){
        data.myBook = null; persist();
        toast('已从词汇移出');
        drawPreview(meta);
      });
      var gob = document.getElementById('p-go');
      if (gob) gob.addEventListener('click', function(){ sub = null; go('vocab'); });
    }).catch(function(){
      view.innerHTML = '<div class="loading">载入失败,刷新再试。</div>';
    });
  }

  /* ---------------- 主页 ---------------- */
  function viewHome(){
    bar.innerHTML = '';
    var cfgMissing = !window.__firebase;
    var body;

    if (cfgMissing){
      body = '<div class="card"><h3>账号</h3>' +
        '<p class="note" style="margin-top:0">还没有接入账号服务,数据只保存在这台设备上。' +
        '配置好 Firebase 之后,这里就能用邮箱注册登录,并在多设备之间同步。</p></div>';
    } else if (!authReady){
      body = '<div class="card"><h3>账号</h3><p class="note" style="margin-top:0">正在连接…</p></div>';
    } else if (me){
      body = '<div class="card">' +
          '<div class="who">' +
            '<span class="av">' + esc((me.email || '?')[0].toUpperCase()) + '</span>' +
            '<span><span class="em">' + esc(me.email) + '</span>' +
            '<span class="st">已登录 · 多设备同步中</span></span>' +
          '</div>' +
          '<div class="row" style="margin-top:14px">' +
            '<button class="btn" id="h-out">退出登录</button></div>' +
        '</div>';
    } else {
      body = '<div class="card"><h3>登录 / 注册</h3>' +
          '<div id="h-msg"></div>' +
          '<div class="field"><label for="h-em">邮箱</label>' +
            '<input id="h-em" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com"></div>' +
          '<div class="field"><label for="h-pw">密码</label>' +
            '<input id="h-pw" type="password" autocomplete="current-password" placeholder="至少 6 位"></div>' +
          '<div class="row">' +
            '<button class="btn pri" id="h-in">登录</button>' +
            '<button class="btn" id="h-up">注册新账号</button></div>' +
          '<p class="note">不同账号的词汇、进度、常错词互相独立,互不可见。</p>' +
        '</div>';
    }

    var stats = '<div class="card"><h3>我的数据</h3>' +
      '<div class="kv"><span>当前词书</span><b>' +
        esc((CATALOG.filter(function(b){ return b.key === data.myBook; })[0] || {}).title || '未选择') +
      '</b></div>' +
      '<div class="kv"><span>已过板块</span><b>' + Object.keys(data.done).length + '</b></div>' +
      '<div class="kv"><span>常错词</span><b>' + data.wrong.length + '</b></div>' +
      '<div class="row" style="margin-top:14px">' +
        '<button class="btn" id="bk-out">导出备份码</button>' +
        '<button class="btn" id="bk-in">导入备份码</button>' +
      '</div>' +
      '<div id="bk-area"></div>' +
      '<p class="note">登不上账号时(比如国内网络连不上 Google)用这个在设备之间搬进度:' +
      '在旧设备导出,把那串码发到新设备粘贴导入。</p>' +
    '</div>';

    var voiceOpts = enVoices.map(function(v){
      var t = /^en[-_]GB/i.test(v.lang) ? '英音' : /^en[-_]US/i.test(v.lang) ? '美音'
            : /^en[-_]AU/i.test(v.lang) ? '澳音' : v.lang;
      return '<option value="' + esc(v.name) + '"' +
        (voice && v.name === voice.name ? ' selected' : '') + '>' +
        esc(v.name) + ' · ' + t + '</option>';
    }).join('');

    var sound = '<div class="card"><h3>发音</h3>' +
      '<div class="row">' +
        '<button class="btn' + (useAudio ? ' pri' : '') + '" id="s-rec">真人录音</button>' +
        '<button class="btn' + (useAudio ? '' : ' pri') + '" id="s-syn">设备语音</button>' +
        '<button class="btn gho" id="s-try">试听</button>' +
      '</div>' +
      (voiceOpts ? '<div class="voice"><span class="vl">设备语音</span>' +
        '<select id="s-sel">' + voiceOpts + '</select></div>' : '') +
      '<p class="note">真人录音取自有道词典的英式发音,重音清晰,需要联网;' +
      '拉不到时自动回退到设备语音。离线背词请切到设备语音。</p></div>';

    var dict = '<div class="card dict">' +
      '<h3>查词</h3>' +
      dictMarkup('d') +
    '</div>';

    view.innerHTML = '<div class="pad"><div class="masthead"><h1>主页</h1></div>' +
      dict + body + stats + sound + '</div>';

    var el;
    wireDict();
    wireBackup();
    if ((el = document.getElementById('h-out')))
      el.addEventListener('click', function(){ auth.signOut(); });
    if ((el = document.getElementById('h-in'))) el.addEventListener('click', function(){ doAuth(false); });
    if ((el = document.getElementById('h-up'))) el.addEventListener('click', function(){ doAuth(true); });
    if ((el = document.getElementById('s-rec'))) el.addEventListener('click', function(){
      useAudio = true; try { localStorage.setItem(AUDIO_LS, '1'); } catch(e){} render();
    });
    if ((el = document.getElementById('s-syn'))) el.addEventListener('click', function(){
      useAudio = false; try { localStorage.setItem(AUDIO_LS, '0'); } catch(e){} render();
    });
    if ((el = document.getElementById('s-try'))) el.addEventListener('click', function(){
      speak('meticulous');
    });
    wireBackup();
    if ((el = document.getElementById('s-sel'))) el.addEventListener('change', function(){
      voice = enVoices.filter(function(v){ return v.name === this.value; }.bind(this))[0] || voice;
      try { localStorage.setItem(VOICE_LS, this.value); } catch(e){}
      speakSynth('vocabulary');
    });
  }

  /* ---------------- 查词 ----------------
     ECDICT 精简版,按首字母分片,查到哪个字母才下载哪片。 */
  var shards = {}, shardWait = {};

  function loadShard(letter){
    if (shards[letter]) return Promise.resolve(shards[letter]);
    if (shardWait[letter]) return shardWait[letter];
    shardWait[letter] = fetch('dict/' + letter + '.json')
      .then(function(r){ if (!r.ok) throw new Error('miss'); return r.json(); })
      .then(function(j){ shards[letter] = j; return j; })
      .catch(function(){ shards[letter] = {}; return {}; });
    return shardWait[letter];
  }

  function lookup(word){
    var w = String(word || '').trim().toLowerCase();
    if (!w) return Promise.resolve(null);
    return loadShard(w[0]).then(function(sh){
      var hit = sh[w];
      if (typeof hit === 'string'){          // 词形变化,指向原形
        var base = hit;
        return loadShard(base[0]).then(function(s2){
          var e = s2[base];
          return e && typeof e === 'object' ? { w:base, from:w, e:e } : null;
        });
      }
      return hit ? { w:w, e:hit } : null;
    });
  }

  function suggest(prefix, limit){
    var p = String(prefix || '').trim().toLowerCase();
    if (p.length < 1) return Promise.resolve([]);
    return loadShard(p[0]).then(function(sh){
      var out = [];
      for (var k in sh){
        if (k.lastIndexOf(p, 0) === 0){
          out.push(k);
          if (out.length > 400) break;
        }
      }
      out.sort(function(a, b){ return a.length - b.length || (a < b ? -1 : 1); });
      return out.slice(0, limit || 8);
    });
  }

  function dictCard(hit, idp){
    idp = idp || 'd';
    var e = hit.e;
    var senses = (e.t || []).map(function(s){
      var m = String(s).match(POS_RE);
      return '<span class="sense">' +
        (m ? '<span class="pos">' + esc(m[1].trim()) + '</span>' + esc(m[2]) : esc(s)) +
      '</span>';
    }).join('');
    var inWrong = wrongIdx(hit.w) >= 0;
    return '<div class="dres">' +
      '<div class="dhead">' +
        '<span class="dw">' + esc(hit.w) + '</span>' +
        (e.p ? '<span class="dp">' + esc(e.p) + '</span>' : '') +
        (e.o ? '<span class="dox">牛津核心</span>' : '') +
      '</div>' +
      (hit.from ? '<p class="dfrom">' + esc(hit.from) + ' → ' + esc(hit.w) + '</p>' : '') +
      '<div class="dsenses">' + senses + '</div>' +
      '<div class="row" style="margin-top:12px">' +
        '<button class="btn gho" id="' + idp + '-say">朗读</button>' +
        '<button class="btn" id="' + idp + '-add">' +
          (inWrong ? '移出常错词' : '加入常错词') + '</button>' +
      '</div>' +
    '</div>';
  }

  /* 下拉唤出的查词面板:在列表页从顶部往下拉即可 */
  var pullEl, pullBox, pullOpen = false;

  function dictMarkup(idp){
    return '<div class="dwrap">' +
      '<input id="' + idp + 'q" type="search" autocomplete="off" autocapitalize="off" ' +
        'autocorrect="off" spellcheck="false" placeholder="查词:输入英文单词">' +
      '<div class="dsug" id="' + idp + 'sug" hidden></div>' +
    '</div><div id="' + idp + 'out"></div>';
  }

  function initPull(){
    pullEl = document.getElementById('pull');
    pullBox = document.getElementById('pullbox');
    if (!pullEl) return;
    pullBox.innerHTML =
      '<div class="pullhead"><span class="grab"></span>' +
        '<button class="pclose" id="pclose">收起</button></div>' +
      dictMarkup('p');
    document.getElementById('pclose').addEventListener('click', closePull);
    wireDict('p');

    var sy = 0, dy = 0, pulling = false, armed = false;

    function canPull(){
      return !pullOpen && (!sub || sub.view !== 'study') &&
             (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
    }

    document.addEventListener('pointerdown', function(e){
      if (e.target.closest('#pull') || e.target.closest('.nav')) return;
      armed = canPull();
      sy = e.clientY; dy = 0; pulling = false;
    }, { passive:true });

    document.addEventListener('pointermove', function(e){
      if (!armed) return;
      dy = e.clientY - sy;
      if (dy <= 0){
        if (pulling){ pullEl.style.height = '0px'; pulling = false; }
        return;
      }
      if (!pulling && dy < 8) return;
      pulling = true;
      pullEl.classList.add('drag');
      pullEl.style.height = Math.min(dy * 0.55, 120) + 'px';
    }, { passive:true });

    // 触摸时要主动挡下页面的橡皮筋滚动,否则下拉会被浏览器抢走
    document.addEventListener('touchmove', function(e){
      if (pulling && e.cancelable) e.preventDefault();
    }, { passive:false });

    function end(){
      if (!pulling){ armed = false; return; }
      pulling = false; armed = false;
      pullEl.classList.remove('drag');
      if (parseFloat(pullEl.style.height) > 46) openPull();
      else pullEl.style.height = '0px';
    }
    document.addEventListener('pointerup', end, { passive:true });
    document.addEventListener('pointercancel', end, { passive:true });
  }

  function openPull(){
    if (!pullEl) return;
    pullOpen = true;
    pullEl.classList.add('open');
    pullEl.setAttribute('aria-hidden', 'false');
    pullEl.style.height = pullBox.offsetHeight + 'px';
    var q = document.getElementById('pq');
    if (q) setTimeout(function(){ q.focus(); }, 60);
  }

  function closePull(){
    if (!pullEl) return;
    pullOpen = false;
    pullEl.classList.remove('open', 'drag');
    pullEl.setAttribute('aria-hidden', 'true');
    pullEl.style.height = '0px';
    var q = document.getElementById('pq');
    if (q){ q.blur(); q.value = ''; }
    var o = document.getElementById('pout');
    if (o) o.innerHTML = '';
    var s = document.getElementById('psug');
    if (s) s.hidden = true;
  }

  function growPull(){
    if (pullOpen && pullEl) pullEl.style.height = pullBox.offsetHeight + 'px';
  }

  function wireDict(idp){
    idp = idp || 'd';
    var box = document.getElementById(idp + 'q');
    if (!box) return;
    var sug = document.getElementById(idp + 'sug');
    var res = document.getElementById(idp + 'out');
    var timer = null, seq = 0;

    function showWord(w){
      box.value = w;
      sug.hidden = true;
      var my = ++seq;
      lookup(w).then(function(hit){
        if (my !== seq) return;
        if (!hit){
          res.innerHTML = '<p class="dnone">词典里没有「' + esc(w) + '」</p>';
          growPull();
          return;
        }
        res.innerHTML = dictCard(hit, idp);
        growPull();
        document.getElementById(idp + '-say').addEventListener('click', function(){ speak(hit.w); });
        document.getElementById(idp + '-add').addEventListener('click', function(){
          if (wrongIdx(hit.w) >= 0){
            removeWrong(hit.w);
            toast('已移出常错词');
          } else {
            addWrong({ w:hit.w, p:hit.e.p || '', m:(hit.e.t || []).slice(0, 3) });
            toast('已加入常错词');
          }
          showWord(hit.w);
        });
        speak(hit.w);
      });
    }

    box.addEventListener('input', function(){
      clearTimeout(timer);
      var v = box.value.trim();
      if (!v){ sug.hidden = true; res.innerHTML = ''; return; }
      timer = setTimeout(function(){
        var my = ++seq;
        suggest(v, 8).then(function(list){
          if (my !== seq) return;
          if (!list.length){ sug.hidden = true; return; }
          sug.innerHTML = list.map(function(w){
            return '<button data-w="' + esc(w) + '">' + esc(w) + '</button>';
          }).join('');
          sug.hidden = false;
          growPull();
          Array.prototype.forEach.call(sug.querySelectorAll('button'), function(el){
            el.addEventListener('click', function(){ showWord(el.getAttribute('data-w')); });
          });
        });
      }, 140);
    });

    box.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ e.preventDefault(); showWord(box.value.trim()); }
      else if (e.key === 'Escape'){ sug.hidden = true; }
    });
    box.addEventListener('blur', function(){ setTimeout(function(){ sug.hidden = true; }, 180); });
  }

  /* ---------------- 备份码 ----------------
     A self-contained transfer format, so progress can move between devices
     without reaching any service that may be unreachable. */
  function b64enc(bytes){
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64dec(str){
    var s = str.replace(/[-]/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function squeeze(bytes, mode){
    var S = mode === 'in' ? window.DecompressionStream : window.CompressionStream;
    if (!S) return null;
    var st = new S('gzip');
    var w = st.writable.getWriter();
    w.write(bytes); w.close();
    var chunks = [], rd = st.readable.getReader();
    for (;;){
      var r = await rd.read();
      if (r.done) break;
      chunks.push(r.value);
    }
    var len = chunks.reduce(function(a, c){ return a + c.length; }, 0);
    var out = new Uint8Array(len), at = 0;
    chunks.forEach(function(c){ out.set(c, at); at += c.length; });
    return out;
  }

  async function makeCode(){
    var payload = { v:1, myBook:data.myBook, pos:data.pos, done:data.done,
                    last:data.last, wrong:data.wrong };
    var raw = new TextEncoder().encode(JSON.stringify(payload));
    var gz = await squeeze(raw, 'out');
    return (gz ? 'C1.' + b64enc(gz) : 'P1.' + b64enc(raw));
  }

  async function readCode(code){
    code = (code || '').trim();
    var m = code.match(/^(C1|P1)\.([\s\S]+)$/);
    if (!m) throw new Error('这串码看起来不完整');
    var bytes = b64dec(m[2]);
    if (m[1] === 'C1'){
      bytes = await squeeze(bytes, 'in');
      if (!bytes) throw new Error('这台设备的浏览器太旧,解不开压缩的备份码');
    }
    var obj = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || typeof obj !== 'object') throw new Error('备份码内容不对');
    return obj;
  }

  function applyCode(r){
    var before = Object.keys(data.done).length + data.wrong.length;
    data.pos = Object.assign({}, data.pos, r.pos || {});
    data.done = Object.assign({}, data.done, r.done || {});
    data.myBook = r.myBook || data.myBook;
    data.last = r.last || data.last;
    if (Array.isArray(r.wrong)){
      var have = {};
      data.wrong.forEach(function(c){ have[c.w] = 1; });
      r.wrong.forEach(function(c){ if (c && c.w && !have[c.w]) data.wrong.push(c); });
    }
    persist();
    return Object.keys(data.done).length + data.wrong.length - before;
  }

  function wireBackup(){
    var area = document.getElementById('bk-area');
    if (!area) return;
    var out = document.getElementById('bk-out');
    var inn = document.getElementById('bk-in');

    out.addEventListener('click', function(){
      makeCode().then(function(code){
        area.innerHTML =
          '<div class="bk">' +
            '<label for="bk-t">把下面整串复制走(已包含词书、进度和常错词)</label>' +
            '<textarea id="bk-t" readonly rows="4"></textarea>' +
            '<div class="row"><button class="btn gho" id="bk-copy">复制</button>' +
            '<span class="bkn" id="bk-n"></span></div>' +
          '</div>';
        var ta = document.getElementById('bk-t');
        ta.value = code;
        document.getElementById('bk-n').textContent = code.length + ' 字符';
        document.getElementById('bk-copy').addEventListener('click', function(){
          ta.select(); ta.setSelectionRange(0, code.length);
          var ok = false;
          try { ok = document.execCommand('copy'); } catch(e){}
          if (navigator.clipboard) navigator.clipboard.writeText(code).catch(function(){});
          toast(ok || navigator.clipboard ? '已复制' : '请手动长按选中复制');
        });
      }).catch(function(e){ toast('导出失败:' + e.message); });
    });

    inn.addEventListener('click', function(){
      area.innerHTML =
        '<div class="bk">' +
          '<label for="bk-p">把另一台设备导出的备份码粘贴进来</label>' +
          '<textarea id="bk-p" rows="4" placeholder="C1...."></textarea>' +
          '<div class="row"><button class="btn pri" id="bk-go">导入</button></div>' +
        '</div>';
      document.getElementById('bk-go').addEventListener('click', function(){
        var v = document.getElementById('bk-p').value;
        readCode(v).then(function(r){
          var added = applyCode(r);
          toast(added > 0 ? '导入成功,新增 ' + added + ' 项' : '导入成功(内容已存在)');
          render();
        }).catch(function(e){ toast('导入失败:' + e.message); });
      });
    });
  }

  var AUTH_MSG = {
    'auth/invalid-email': '邮箱格式不对',
    'auth/missing-password': '请填密码',
    'auth/weak-password': '密码太短,至少 6 位',
    'auth/email-already-in-use': '这个邮箱已经注册过了,直接登录',
    'auth/invalid-credential': '邮箱或密码不对',
    'auth/wrong-password': '密码不对',
    'auth/user-not-found': '没有这个账号,先注册',
    'auth/too-many-requests': '尝试太频繁,过一会儿再试',
    'auth/network-request-failed': '连不上服务器,检查网络'
  };

  function doAuth(isNew){
    var em = (document.getElementById('h-em').value || '').trim();
    var pw = document.getElementById('h-pw').value || '';
    var msg = document.getElementById('h-msg');
    msg.innerHTML = '';
    if (!em || !pw){ msg.innerHTML = '<p class="msg">邮箱和密码都要填</p>'; return; }
    var fn = isNew ? 'createUserWithEmailAndPassword' : 'signInWithEmailAndPassword';
    auth[fn](em, pw).catch(function(e){
      msg.innerHTML = '<p class="msg">' + esc(AUTH_MSG[e.code] || e.message) + '</p>';
    });
  }

  /* ---------------- 学习 ---------------- */
  var cur = null, book = null, backTo = null;
  var st = { idx:0, flipped:false, sflip:false };

  function leaveStudy(){
    if (book.key === 'wrong') return openWrongList();
    if (book.key.indexOf('.') > 0) return openPart(book.key);
    sub = null; render();
  }

  function openDeck(b, n, back){
    book = b;
    backTo = back || null;
    cur = b.decks.filter(function(d){ return d.n === n; })[0];
    if (!cur) return;
    var k = key(b.key, n);
    var at = data.pos[k] || 0;
    var redo = !!data.done[k];
    st.idx = (redo || at >= cur.cards.length) ? 0 : at;
    // 重新过一遍时状态回到「进行中」,而不是一直停在「完成」
    if (redo){ delete data.done[k]; data.pos[k] = 0; }
    st.flipped = false; st.sflip = false;
    if (b.key !== 'wrong'){ data.last = { book:b.key, deck:n }; persist(); }
    sub = { view:'study', draw:drawStudy };
    drawStudy();
  }

  function drawStudy(){
    renderNav();
    setTopBtn(false);
    closePull();
    bar.innerHTML =
      '<button class="back" id="s-back">← ' + esc(book.title) + '</button>' +
      '<span class="spacer"></span><span class="meta" id="s-meta"></span>';
    document.getElementById('s-back').addEventListener('click', leaveStudy);

    view.innerHTML =
      '<div class="study">' +
        '<div class="rail"><i id="s-rail"></i></div>' +
        '<div class="stage" id="s-stage"><div class="drag" id="s-drag">' +
          '<div class="inner" id="s-inner">' +
            '<div class="face front"><span class="star" id="s-star">常错词</span>' +
              '<div id="s-fw"><div class="word" id="s-word"></div>' +
                '<div class="ipa" id="s-ipa"></div></div>' +
              '<div id="s-fe" hidden><p class="endt" id="s-endt"></p>' +
                '<div class="row" style="justify-content:center">' +
                  '<button class="btn" id="d-again">再过一遍</button>' +
                  '<button class="btn pri" id="d-next"></button></div>' +
                '<p class="endh">右滑回去复习</p></div></div>' +
            '<div class="face back"><div class="echo" id="s-echo"></div>' +
              '<div class="zh" id="s-zh"></div></div>' +
          '</div>' +
        '</div></div>' +
        '<div class="sent" id="s-sent"><div class="sinner" id="s-sinner">' +
          '<div class="sface" id="s-sf"><span class="cue" id="s-cue">点一下看例句</span></div>' +
          '<div class="sface b" id="s-sb">' +
            '<div class="sen" id="s-sen"></div><div class="szh" id="s-szh"></div></div>' +
        '</div></div>' +
        '<div class="hint" id="s-hint">' +
          '<span><b>←</b> 下一个</span><span><b>→</b> 上一个</span>' +
          '<span><b>↑</b> 中文</span><span><b>点</b> 发音</span>' +
          '<span><b>长按</b> ' + (book.key === 'wrong' ? '移出' : '存进常错词') + '</span>' +
        '</div>' +
      '</div>';

    paint();
    wire();
  }

  // 考研书里一个义项可能挂多个词性:"vt. vi. 散发"
  function renderZh(list){
    return (list || []).map(function(s){
      var m = String(s).match(POS_RE);
      return '<span class="sense">' +
        (m ? '<span class="pos">' + esc(m[1]) + '</span>' + esc(m[2]) : esc(s)) + '</span>';
    }).join('');
  }

  function atEnd(){ return cur && st.idx >= cur.cards.length; }

  function paint(){
    var cards = cur.cards;
    document.getElementById('s-fw').hidden = atEnd();
    document.getElementById('s-fe').hidden = !atEnd();
    document.getElementById('s-sent').style.visibility = atEnd() ? 'hidden' : '';
    if (atEnd()) return paintEnd();
    var c = cards[st.idx];

    var w = document.getElementById('s-word');
    w.textContent = c.w;
    w.className = 'word' + (c.w.length > 17 ? ' xlong' : c.w.length > 11 ? ' long' : '');
    document.getElementById('s-ipa').textContent = c.p || '';
    document.getElementById('s-echo').textContent = c.w;
    document.getElementById('s-zh').innerHTML = renderZh(c.m);
    document.getElementById('s-star').classList.toggle('on',
      book.key !== 'wrong' && wrongIdx(c.w) >= 0);
    document.getElementById('s-meta').textContent =
      (book.key === 'wrong' ? '常错词' : cur.name) + ' · ' + (st.idx + 1) + ' / ' + cards.length;
    document.getElementById('s-rail').style.width = ((st.idx + 1) / cards.length * 100) + '%';
    document.getElementById('s-inner').classList.toggle('flipped', st.flipped);

    var sf = document.getElementById('s-sf');
    var si = document.getElementById('s-sinner');
    si.classList.toggle('flipped', st.sflip);
    if (c.x){
      sf.classList.remove('none');
      document.getElementById('s-cue').textContent = '点一下看例句';
      document.getElementById('s-sen').textContent = c.x.en;
      document.getElementById('s-szh').textContent = c.x.zh || '';
    } else {
      sf.classList.add('none');
      document.getElementById('s-cue').textContent = '暂无例句';
      document.getElementById('s-sen').textContent = '';
      document.getElementById('s-szh').textContent = '';
    }

    data.pos[key(book.key, cur.n)] = st.idx;
    persist();
  }

  function paintEnd(){
    var isW = book.key === 'wrong';
    if (!isW){
      var k = key(book.key, cur.n);
      data.done[k] = 1; data.pos[k] = 0; persist();
    }
    document.getElementById('s-meta').textContent = (isW ? '常错词' : cur.name) + ' · 完成';
    document.getElementById('s-rail').style.width = '100%';
    document.getElementById('s-star').classList.remove('on');
    document.getElementById('s-endt').textContent =
      '过完了 —— ' + cur.cards.length + ' 个词';
    var nx = isW ? null : book.decks.filter(function(d){ return d.n === cur.n + 1; })[0];
    document.getElementById('d-next').textContent =
      isW ? '回到常错词' : nx ? '下一组' : '回到列表';
    document.getElementById('s-inner').classList.remove('flipped');
    st.flipped = false;
  }

  function wire(){
    var stage = document.getElementById('s-stage');
    var drag = document.getElementById('s-drag');
    var inner = document.getElementById('s-inner');
    var hint = document.getElementById('s-hint');
    var sx = 0, sy = 0, t0 = 0, moved = false, active = false, used = false;
    var holdTimer = null, held = false;

    function clearHold(){ clearTimeout(holdTimer); holdTimer = null; }
    function reset(anim){
      drag.style.transition = anim ? 'transform .28s cubic-bezier(.3,.7,.3,1)' : 'none';
      drag.style.transform = ''; drag.style.opacity = '';
    }
    function fade(){ if (!used){ used = true; hint.classList.add('dim'); } }

    function onHold(){
      if (atEnd()) return;
      held = true; buzz();
      var c = cur.cards[st.idx];
      if (!c) return;
      if (book.key === 'wrong'){
        removeWrong(c.w);
        toast('已移出「' + c.w + '」');
        cur.cards.splice(st.idx, 1);
        if (!cur.cards.length) return openWrongList();
        if (st.idx >= cur.cards.length) st.idx = cur.cards.length - 1;
        st.flipped = false; st.sflip = false;
        inner.classList.remove('flipped');
        paint();
      } else {
        if (addWrong(c)) toast('已存进常错词');
        else { removeWrong(c.w); toast('已移出常错词'); }
        document.getElementById('s-star').classList.toggle('on', wrongIdx(c.w) >= 0);
      }
    }

    function advance(dir){
      fade();
      if (dir > 0 && atEnd()) { reset(true); return; }
      var out = dir > 0 ? -1 : 1;
      drag.style.transition = 'transform .2s ease-out, opacity .2s ease-out';
      drag.style.transform = 'translateX(' + (out * 120) + '%) rotate(' + (out * 6) + 'deg)';
      drag.style.opacity = '0';
      setTimeout(function(){
        var next = st.idx + dir;
        if (next < 0){ reset(false); return; }
        st.idx = next; st.flipped = false; st.sflip = false;
        inner.style.transition = 'none';
        inner.classList.remove('flipped');
        drag.style.transition = 'none';
        drag.style.transform = 'translateX(' + (-out * 60) + '%)';
        drag.style.opacity = '0';
        paint();
        requestAnimationFrame(function(){
          inner.style.transition = '';
          drag.style.transition = 'transform .22s cubic-bezier(.3,.7,.3,1), opacity .22s ease';
          drag.style.transform = ''; drag.style.opacity = '1';
        });
      }, 175);
    }

    function flip(){
      if (atEnd()) return;
      fade();
      st.flipped = !st.flipped;
      inner.style.transition = '';
      inner.classList.toggle('flipped', st.flipped);
    }

    stage.addEventListener('pointerdown', function(e){
      if (e.target.closest('button')){ active = false; return; }
      active = true; moved = false; held = false;
      sx = e.clientX; sy = e.clientY; t0 = Date.now();
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
      if (Math.abs(dx) >= Math.abs(dy))
        drag.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 26) + 'deg)';
      else drag.style.transform = 'translateY(' + (dy / (dy < 0 ? 3 : 5)) + 'px)';
    });
    function release(e){
      if (!active) return;
      active = false; clearHold();
      var dx = e.clientX - sx, dy = e.clientY - sy;
      var dt = Date.now() - t0, ax = Math.abs(dx), ay = Math.abs(dy);
      if (held){ held = false; reset(false); return; }
      if (!moved && dt < 500){
        reset(false);
        if (!atEnd()){ speak(cur.cards[st.idx].w); fade(); }
        return;
      }
      if (ax >= ay && ax > 55){
        if (dx < 0) advance(1);
        else if (st.idx > 0) advance(-1);
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

    document.getElementById('d-again').addEventListener('click', function(){
      st.idx = 0; st.flipped = false; st.sflip = false;
      var k = key(book.key, cur.n);
      delete data.done[k]; data.pos[k] = 0; persist();
      paint();
    });
    document.getElementById('d-next').addEventListener('click', function(){
      if (book.key === 'wrong') return openWrongList();
      var nx = book.decks.filter(function(d){ return d.n === cur.n + 1; })[0];
      if (nx) openDeck(book, nx.n, backTo); else leaveStudy();
    });

    document.getElementById('s-sent').addEventListener('click', function(){
      var c = cur.cards[st.idx];
      if (!c || !c.x) return;
      st.sflip = !st.sflip;
      document.getElementById('s-sinner').classList.toggle('flipped', st.sflip);
      if (st.sflip) speak(c.x.en, true);
    });

    document.onkeydown = function(e){
      if (!sub || sub.view !== 'study') return;
      if (e.key === 'ArrowLeft'){ e.preventDefault(); advance(1); }
      else if (e.key === 'ArrowRight'){ e.preventDefault(); if (st.idx > 0) advance(-1); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown'){ e.preventDefault(); flip(); }
      else if (e.key === ' '){ e.preventDefault(); if (!atEnd()) speak(cur.cards[st.idx].w); }
      else if (e.key === 'Enter'){ e.preventDefault(); document.getElementById('s-sent').click(); }
    };
  }

  /* ================= boot ================= */
  loadLocal();
  initFirebase();
  initPull();
  render();
})();
