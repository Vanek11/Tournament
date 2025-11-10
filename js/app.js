// Простой список: поиск + сортировка + «Открыть на портале».
// Никакой статистики — только ссылка на официальный профиль.

(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const participants = (window.participants || []).map(p => ({
    name: p.name || p.nickname || "",
    clan: p.clan || "",
    lestaUrl: p.lestaUrl || p.url || "",
  }));

  const state = { q: "", sort: "name-asc" };

  function colorFromName(name) {
    let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    h = h % 360; const s = 65, l = 55;
    return `linear-gradient(135deg, hsl(${h} ${s}% ${l}%), hsl(${(h + 40) % 360} ${s}% ${Math.max(40, l - 10)}%))`;
  }

  function calcList() {
    let list = participants.slice();
    const q = state.q.trim().toLowerCase();
    if (q) list = list.filter(p =>
      (p.name || "").toLowerCase().includes(q) ||
      (p.clan || "").toLowerCase().includes(q)
    );
    const [field, dir] = state.sort.split("-");
    list.sort((a, b) => {
      const av = (field === "clan" ? (a.clan || "") : (a.name || "")).toLocaleLowerCase("ru");
      const bv = (field === "clan" ? (b.clan || "") : (b.name || "")).toLocaleLowerCase("ru");
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  }

  // ===== dropdown сортировки =====
  (function initDropdown() {
    const dd = $("#sortDd"), btn = $("#sortBtn"), menu = $("#sortMenu"), label = $("#sortLabel");
    const map = {
      "name-asc": "По имени (А→Я)",
      "name-desc": "По имени (Я→А)",
      "clan-asc": "По клан-тегу (А→Я)",
      "clan-desc": "По клан-тегу (Я→А)"
    };
    function setLabel() {
      label.textContent = map[state.sort] || "Сортировка";
      [...menu.children].forEach(li => li.setAttribute("aria-selected", li.dataset.value === state.sort ? "true" : "false"));
    }
    function open() { menu.classList.add("open"); btn.setAttribute("aria-expanded", "true"); }
    function close() { menu.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }
    btn.addEventListener("click", () => menu.classList.contains("open") ? close() : open());
    menu.addEventListener("click", (e) => {
      const li = e.target.closest(".dd-item"); if (!li) return;
      state.sort = li.dataset.value; setLabel(); close(); render();
    });
    document.addEventListener("click", (e) => { if (!dd.contains(e.target)) close(); });
    setLabel();
  })();

  function render() {
    const grid = $("#grid");
    grid.innerHTML = "";
    const list = calcList();

    if (!list.length) {
      grid.innerHTML = '<div class="empty" role="status">Ничего не найдено. Измените запрос.</div>';
    }

    list.forEach((p) => {
      const card = document.createElement("div");
      card.className = "card"; card.tabIndex = 0;

      const initial = (p.name || "?").trim().charAt(0).toUpperCase();
      const portalLink = p.lestaUrl
        ? `<a class="btn secondary" href="${p.lestaUrl}" target="_blank" rel="noopener">Открыть на портале</a>`
        : `<span class="hint">Ссылка на профиль не указана</span>`;

      card.innerHTML = `
        <div class="avatar" style="background:${colorFromName(p.name)}">${initial}</div>
        <div class="title" title="${p.name}">${p.name}</div>
        <div class="meta">${p.clan ? 'Клан: ' + p.clan : '&nbsp;'}</div>
        <div class="actions only-portal">
          ${portalLink}
        </div>
      `;

      grid.appendChild(card);
    });

    $("#count").textContent = list.length;
  }

  // поиск + шорткат
  $("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); $("#q").focus(); }
  });

  render();
})();
