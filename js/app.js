// UI без внешнего API: тянем локальные JSON из /stats
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const participants = (window.participants || []).map(p => ({
  ...p,
  bucket: Number(p.bucket ?? 2) // по умолчанию — средние
}));



  // добьём id из lestaUrl, если его забыли
  for (const p of participants) {
    if (!p.id && p.lestaUrl) {
      const m = p.lestaUrl.match(/\/accounts\/(\d+)(?:-|\/)/);
      if (m) p.id = Number(m[1]);
    }
  }

  const state = { q: "", sort: "name-asc", expanded: new Map() };

  function colorFromName(name) {
    let h = 0; for (let i=0;i<name.length;i++){ h = (h*31 + name.charCodeAt(i)) >>> 0; }
    h = h % 360; const s = 65, l = 55;
    return `linear-gradient(135deg, hsl(${h} ${s}% ${l}%), hsl(${(h+40)%360} ${s}% ${Math.max(40,l-10)}%))`;
  }
  function fmt(n, d = 0) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d });
  }

  // ======== загрузка статистики ========
  let _indexCache = null;
  async function loadFromIndex(id) {
    if (_indexCache === null) {
      try {
        const r = await fetch("stats/index.json", { cache: "no-store" });
        if (r.ok) _indexCache = await r.json();
        else _indexCache = false;
      } catch { _indexCache = false; }
    }
    if (!_indexCache) return null;

    const arr = Array.isArray(_indexCache.players) ? _indexCache.players : Array.isArray(_indexCache) ? _indexCache : [];
    return arr.find(x => Number(x.accountId) === Number(id)) || null;
  }

  async function loadStats(id) {
    // 1) пробуем общий файл
    const viaIndex = await loadFromIndex(id);
    if (viaIndex) return viaIndex;

    // 2) fallback — пофайлово
    const r = await fetch(`stats/${id}.json`, { cache: "no-store" });
    if (!r.ok) throw new Error(`Файл stats/${id}.json не найден`);
    return r.json();
  }

  // ======== поиск + сортировка ========
  function calcList() {
    let list = participants.slice();

    const q = state.q.trim().toLowerCase();
    if (q) {
      list = list.filter(p =>
        (p.name||"").toLowerCase().includes(q) ||
        (p.clan||"").toLowerCase().includes(q)
      );
    }

    const [field, dir] = state.sort.split("-");
    const k = dir === "asc" ? 1 : -1;

    if (field === "bucket") {
      list.sort((a,b) => {
        const d = (a.bucket ?? 2) - (b.bucket ?? 2);
        if (d !== 0) return d * k;
        // внутри одной корзины — как раньше по имени
        return (a.name||"").localeCompare((b.name||""), "ru") * 1;
      });
    } else {
      list.sort((a,b)=>{
        const av = (field==='clan' ? (a.clan||'') : (a.name||'')).toLocaleLowerCase('ru');
        const bv = (field==='clan' ? (b.clan||'') : (b.name||'')).toLocaleLowerCase('ru');
        if(av < bv) return dir==='asc' ? -1 : 1;
        if(av > bv) return dir==='asc' ?  1 : -1;
        return 0;
      });
    }
    return list;
  }

  // ======== dropdown ========
  (function initDropdown(){
    const dd = $("#sortDd"), btn = $("#sortBtn"), menu = $("#sortMenu"), label = $("#sortLabel");
    function setLabel() {
      const map = {
        "name-asc":"По имени (А→Я)",
        "name-desc":"По имени (Я→А)",
        "clan-asc":"По клан-тегу (А→Я)",
        "clan-desc":"По клан-тегу (Я→А)",
        "bucket-asc": "По корзине (1→3)",
        "bucket-desc": "По корзине (3→1)"
      };
      label.textContent = map[state.sort] || "Сортировка";
      [...menu.children].forEach(li => li.setAttribute("aria-selected", li.dataset.value === state.sort ? "true" : "false"));
    }
    function open(){ menu.classList.add("open"); btn.setAttribute("aria-expanded","true"); }
    function close(){ menu.classList.remove("open"); btn.setAttribute("aria-expanded","false"); }
    btn.addEventListener("click", ()=>{ menu.classList.contains("open") ? close() : open(); });
    menu.addEventListener("click", (e)=>{
      const li = e.target.closest(".dd-item"); if(!li) return;
      state.sort = li.dataset.value; setLabel(); close(); render();
    });
    document.addEventListener("click", (e)=>{ if(!dd.contains(e.target)) close(); });
    setLabel();
  })();

  function guessPlatform(u){
    try {
      const h = new URL(u).hostname;
      if (h.includes('twitch'))   return 'twitch';
      if (h.includes('youtube') || h.includes('youtu.be')) return 'youtube';
      if (h.includes('trovo'))    return 'trovo';
      if (h.includes('goodgame')) return 'goodgame';
      if (h.includes('wasd'))     return 'wasd';
      if (h.includes('kick'))     return 'kick';
      if (h.includes('vk'))       return 'vk';
    } catch {}
    return 'other';
  }
  function platformLabel(p){
    return ({
      twitch:'Twitch', youtube:'YouTube', trovo:'Trovo',
      goodgame:'GoodGame', wasd:'WASD', kick:'Kick', vk:'VK', other:'Стрим'
    })[p] || p;
  }
  function streamIcon(platform){
    // одноцветные SVG (берут цвет из currentColor)
    switch(platform){
      case 'twitch':
        return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M4 3h16v10l-5 5h-4l-2 2H7v-2H4z"/>
          <path fill="#0" d="M12 8h2v4h-2zM16 8h2v4h-2z" />
        </svg>`;
      case 'youtube':
        return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <rect x="2" y="7" width="20" height="10" rx="3" fill="currentColor"></rect>
          <path d="M10 9.5v5l5-2.5-5-2.5z" fill="#0"></path>
        </svg>`;
      case 'vk':
        return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M3 7h3l2 4 2-4h3l-3 5 3 5h-3l-2-4-2 4H3l3-5z"/>
        </svg>`;
      case 'trovo':
        return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M3 4h18l-8 8 2 8-5-5L3 4z"/>
        </svg>`;
      case 'kick':
        return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M4 4h6v6H8v4h2v6H4v-6h2v-4H4zM14 4h6v6h-2v4h2v6h-6v-6h2v-4h-2z"/>
        </svg>`;
      case 'goodgame':
        return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="currentColor"></circle>
        </svg>`;
      case 'wasd':
        return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <rect x="4"  y="4"  width="7" height="7" rx="2" fill="currentColor"></rect>
          <rect x="13" y="4"  width="7" height="7" rx="2" fill="currentColor"></rect>
          <rect x="4"  y="13" width="7" height="7" rx="2" fill="currentColor"></rect>
          <rect x="13" y="13" width="7" height="7" rx="2" fill="currentColor"></rect>
        </svg>`;
      default:
        return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M8 5v14l11-7z"></path>
        </svg>`;
    }
  }

  function normalizeStreams(p){
    const arr = [];
    if (Array.isArray(p.streams)) arr.push(...p.streams.filter(s => s && s.url));
    if (!arr.length && p.streamUrl) arr.push({ url: p.streamUrl });
    return arr.map(s => ({ url: s.url, platform: s.platform || guessPlatform(s.url) }));
  }


  function createCard(p, idx) {
    const card = document.createElement("div");
    card.className = "card"; card.tabIndex = 0;

    const initial = (p.name||"?").trim().charAt(0).toUpperCase();
    const portalLink = p.lestaUrl ? `<a class="btn secondary" href="${p.lestaUrl}" target="_blank" rel="noopener">Открыть на портале</a>` : "";
    const streams = normalizeStreams(p);

    const statsBtn  = p.id
      ? `<button class="btn secondary" data-action="toggle" data-idx="${idx}">Статистика</button>`
      : `<button class="btn" disabled title="Нет ID">Статистика</button>`;

    const portalBtn = p.lestaUrl
      ? `<a class="btn secondary" href="${p.lestaUrl}" target="_blank" rel="noopener">Открыть на портале</a>`
      : "";

    const streamBtns = streams.map(s => `
      <a class="btn secondary btn--icon" href="${s.url}" target="_blank" rel="noopener"
        title="${platformLabel(s.platform)}">
        ${streamIcon(s.platform)}<span>${platformLabel(s.platform)}</span>
      </a>
    `).join("");

    const btnCount = (p.id ? 1 : 0) + (p.lestaUrl ? 1 : 0) + streams.length;

    card.innerHTML = `
      <div class="avatar" style="background:${colorFromName(p.name)}">
        ${initial}
        <span class="bucket-badge b-${p.bucket}" title="Корзина ${p.bucket}"></span>
      </div>
      <div class="title" title="${p.name}">${p.name}</div>
      <div class="meta">${p.clan ? 'Клан: ' + p.clan : '&nbsp;'}</div>

      <div class="details" id="details-${idx}">
        <div class="actions ${btnCount === 1 ? 'only-portal' : ''}">
          ${statsBtn}
          ${portalBtn}
          ${streamBtns}
        </div>
        <div class="stats" id="stats-${idx}">
          ${!p.id ? '<div class="hint">У участника не задан id. Исправь data.participants.js</div>' : ''}
        </div>
      </div>
    `;


    card.addEventListener("click", async (e)=>{
      const btn = e.target.closest('[data-action="toggle"]');
      if(!btn) return;
      await toggleStats(idx, p, card);
    });

    return card;
  }

  function sectionTitle(k) {
    return k === 1 ? "Корзина 1"
        : k === 2 ? "Корзина 2"
        :           "Корзина 3";
  }

  // сортировка ВНУТРИ секции: если выбран bucket-режим — сортируем по имени (А→Я),
  // иначе используем текущую сортировку state.sort (name/clan asc/desc)
  function sortInsideBucket(arr) {
    const use = state.sort.startsWith("bucket-") ? "name-asc" : state.sort;
    const [field, dir] = use.split("-");
    const k = dir === "asc" ? 1 : -1;

    return arr.sort((a,b)=>{
      const av = (field==='clan' ? (a.clan||'') : (a.name||'')).toLocaleLowerCase('ru');
      const bv = (field==='clan' ? (b.clan||'') : (b.name||'')).toLocaleLowerCase('ru');
      if(av < bv) return -1*k;
      if(av > bv) return  1*k;
      return 0;
    });
  }


  // ======== рендер ========
  function render(){
    const grid = $("#grid");
    grid.innerHTML = "";

    const list = calcList();
    if(!list.length){
      grid.innerHTML = '<div class="empty" role="status">Ничего не найдено. Измените запрос.</div>';
      $("#count").textContent = 0;
      return;
    }

    // Группируем
    const buckets = {1:[],2:[],3:[]};
    for (const p of list) (buckets[p.bucket] || buckets[2]).push(p);

    // Порядок секций зависит от выбранной сортировки по корзине
    // по умолчанию 1→3, если выбран bucket-desc — 3→1
    let order = [1,2,3];
    if (state.sort === "bucket-desc") order = [3,2,1];

    let idx = 0;
    const paint = (k, arr) => {
      if(!arr.length) return;

      // внутри секции отсортируем (см. хелпер)
      sortInsideBucket(arr);

      const sec = document.createElement("section");
      sec.className = "bucket";
      sec.innerHTML = `
        <div class="bucket__header">
          <div class="bucket__title">${sectionTitle(k)}</div>
          <div class="bucket__count">Количество участников: ${arr.length}</div>
        </div>
        <div class="bucket__grid"></div>
      `;
      const wrap = sec.querySelector(".bucket__grid");

      arr.forEach(p => {
        const card = createCard(p, idx++);
        wrap.appendChild(card);
      });

      grid.appendChild(sec);
    };

    order.forEach(k => paint(k, buckets[k]));
    $("#count").textContent = list.length;
  }



  async function toggleStats(idx, p, card){
    if (!p.id) return;
    const box = card.querySelector("#stats-"+idx);
    const isOpen = state.expanded.get(idx) === true;

    if(!isOpen){
      box.innerHTML = '<div class="hint">Загружаем данные…</div>';
      try{
        const i = await loadStats(p.id);
        box.innerHTML = renderStats(i);
        state.expanded.set(idx, true);
      }catch(err){
        const msg = (err && err.message) ? err.message : "Не удалось получить данные";
        box.innerHTML = `<div class="hint" style="color:#f88">${msg}</div>`;
        state.expanded.set(idx, false);
      }
    }else{
      box.innerHTML = "";
      state.expanded.set(idx, false);
    }
  }

    // === ширина списка участников = ширина блока "Правила турнира"
  function syncGridToRules() {
    const rules = document.querySelector('.rules'); // твой блок правил
    if (!rules) return;
    const w = Math.round(rules.getBoundingClientRect().width);
    document.documentElement.style.setProperty('--rules-width', w + 'px');
  }

  window.addEventListener('resize', syncGridToRules);
  const rulesEl = document.querySelector('.rules');
  if (rulesEl) {
    const ro = new ResizeObserver(syncGridToRules);
    ro.observe(rulesEl);
  }

  syncGridToRules();


  function renderStats(i){
    return `
      <div class="row" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px">
        <span class="badge"><span class="k">Ник:</span><strong>${i.nickname || '—'}</strong></span>
        <span class="badge"><span class="k">Бои:</span><strong>${fmt(i.battles)}</strong></span>
        <span class="badge"><span class="k">Победы:</span><strong>${fmt(i.wins)}</strong></span>
        <span class="badge"><span class="k">% побед:</span><strong>${fmt(i.winRate,2)}%</strong></span>
        <span class="badge"><span class="k">СР. урон:</span><strong>${fmt(i.avgDmg,0)}</strong></span>
        <span class="badge"><span class="k">Попадания:</span><strong>${fmt(i.hitsPercents,2)}%</strong></span>
        <span class="badge"><span class="k">СР. опыт:</span><strong>${fmt(i.avgExp,0)}</strong></span>
        <span class="badge"><span class="k">Макс. опыт:</span><strong>${fmt(i.maxExp,0)}</strong></span>
        <span class="badge"><span class="k">Макс. фраги:</span><strong>${fmt(i.maxFrags,0)}</strong></span>
        <span class="badge"><span class="k">Мастер:</span><strong>${fmt(i.masterCount,0)}/${fmt(i.vehiclesCount,0)}</strong></span>
        <span class="badge"><span class="k">Рейтинг:</span><strong>${fmt(i.global_rating)}</strong></span>
      </div>
    `;
  }

  // поиск + шорткат
  $("#q").addEventListener("input", (e)=>{ state.q = e.target.value; render(); });
  window.addEventListener("keydown", (e)=>{ if(e.key === "/" && document.activeElement !== $("#q")){ e.preventDefault(); $("#q").focus(); } });

  render();
})();
