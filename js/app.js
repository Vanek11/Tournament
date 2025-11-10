// UI без API: тянем готовый JSON из /stats по accountId
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const participants = window.participants || [];
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

  // ======== сортировка + поиск ========
  function calcList() {
    let list = participants.slice();
    const q = state.q.trim().toLowerCase();
    if (q) list = list.filter(p => (p.name||"").toLowerCase().includes(q) || (p.clan||"").toLowerCase().includes(q));
    const [field, dir] = state.sort.split("-");
    list.sort((a,b)=>{
      const av = (field==='clan' ? (a.clan||'') : (a.name||'')).toLocaleLowerCase('ru');
      const bv = (field==='clan' ? (b.clan||'') : (b.name||'')).toLocaleLowerCase('ru');
      if(av < bv) return dir==='asc' ? -1 : 1;
      if(av > bv) return dir==='asc' ? 1 : -1;
      return 0;
    });
    return list;
  }

  // ======== кастомный dropdown ========
  (function initDropdown(){
    const dd = $("#sortDd"), btn = $("#sortBtn"), menu = $("#sortMenu"), label = $("#sortLabel");
    function setLabel() {
      const map = {
        "name-asc":"По имени (А→Я)",
        "name-desc":"По имени (Я→А)",
        "clan-asc":"По клан-тегу (А→Я)",
        "clan-desc":"По клан-тегу (Я→А)"
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

  // ======== помощники ========
  function getAccountIdFromUrl(url) {
    const m = (url || "").match(/\/accounts\/(\d+)-/);
    return m ? m[1] : null;
  }
async function loadStatsJson(accountId) {
  if (!accountId) throw new Error("Не найден accountId");
  const v = Date.now();
  const base = window.CONFIG?.STATS_JSON_BASE || "stats/";
  let res = await fetch(`${base}${accountId}.json?ts=${v}`, { cache: "no-store" });
  if (!res.ok && window.CONFIG?.RAW_FALLBACK) {
    res = await fetch(`${window.CONFIG.RAW_FALLBACK}${accountId}.json?ts=${v}`, { cache: "no-store" });
  }
  if (!res.ok) throw new Error(`stats ${res.status}`);

  const data = await res.json();
  if (data && data.error) throw new Error(data.error);   // <-- покажем реальную причину
  return data;
}


  // ======== рендер ========
  function render(){
    const grid = $("#grid");
    grid.innerHTML = "";
    const list = calcList();
    if(!list.length){ grid.innerHTML = '<div class="empty" role="status">Ничего не найдено. Измените запрос.</div>'; }
    list.forEach((p, idx)=>{
      const card = document.createElement("div");
      card.className = "card"; card.tabIndex = 0;

      const initial = (p.name||"?").trim().charAt(0).toUpperCase();
      const portalLink = p.lestaUrl ? `<a class="btn secondary" href="${p.lestaUrl}" target="_blank" rel="noopener">Открыть на портале</a>` : "";

      card.innerHTML = `
        <div class="avatar" style="background:${colorFromName(p.name)}">${initial}</div>
        <div class="title" title="${p.name}">${p.name}</div>
        <div class="meta">${p.clan ? 'Клан: ' + p.clan : '&nbsp;'}</div>

        <div class="details" id="details-${idx}">
          <div class="actions">
            <button class="btn" data-action="toggle" data-idx="${idx}">Статистика</button>
            ${portalLink}
          </div>
          <div class="stats" id="stats-${idx}"></div>
        </div>
      `;

      card.addEventListener("click", async (e)=>{
        const btn = e.target.closest('[data-action="toggle"]');
        if(!btn) return;
        await toggleStats(idx, p, card);
      });

      $("#grid").appendChild(card);
    });
    $("#count").textContent = list.length;
  }

  async function toggleStats(idx, p, card){
    const box = card.querySelector("#stats-"+idx);
    const isOpen = state.expanded.get(idx) === true;

    if(!isOpen){
      box.innerHTML = '<div class="row"><span class="spinner"></span><span>Загружаем данные…</span></div>';
      try{
        const accountId = p.accountId || getAccountIdFromUrl(p.lestaUrl);
        const info = await loadStatsJson(accountId);
        box.innerHTML = renderStats(info);
        state.expanded.set(idx, true);
      }catch(err){
        const msg = (err && err.message) ? err.message : "Не удалось получить данные";
        box.innerHTML = '<div class="error">'+msg+'</div>';
        state.expanded.set(idx, false);
      }
    }else{
      box.innerHTML = "";
      state.expanded.set(idx, false);
    }
  }

  function renderStats(i){
    return `
      <div class="row" style="margin-top:8px">
        <span class="badge"><span class="k">Ник:</span><strong>${i.nickname || '—'}</strong></span>
        <span class="badge"><span class="k">Бои:</span><strong>${fmt(i.battles)}</strong></span>
        <span class="badge"><span class="k">Победы:</span><strong>${fmt(i.wins)}</strong></span>
        <span class="badge"><span class="k">% побед:</span><strong>${fmt(i.winRate,1)}%</strong></span>
        <span class="badge"><span class="k">СР. урон:</span><strong>${fmt(i.avgDmg,0)}</strong></span>
        <span class="badge"><span class="k">СР. фраги:</span><strong>${fmt(i.avgFrags,2)}</strong></span>
        <span class="badge"><span class="k">Выжил:</span><strong>${fmt(i.surviveRate,1)}%</strong></span>
        <span class="badge"><span class="k">Попадания:</span><strong>${fmt(i.hitsPercents,0)}%</strong></span>
      </div>
      <div class="row" style="margin-top:8px">
        <span class="badge"><span class="k">Рейтинг:</span><strong>${fmt(i.global_rating)}</strong></span>
      </div>
    `;
  }

  // поиск + шорткат
  $("#q").addEventListener("input", (e)=>{ state.q = e.target.value; render(); });
  window.addEventListener("keydown", (e)=>{ if(e.key === "/" && document.activeElement !== $("#q")){ e.preventDefault(); $("#q").focus(); } });

  render();
})();
