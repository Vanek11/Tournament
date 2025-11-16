// js/teams.render.js
(function () {
  const GRID = document.getElementById('teams-grid');
  const COUNT = document.getElementById('teams-count');
  if (!GRID) return;

  const URL = 'data/teams.json';

  fetch(`${URL}?v=${Date.now()}`, { cache: 'no-store' })
    .then(r => r.json())
    .then(data => render(Array.isArray(data?.teams) ? data.teams : []))
    .catch(() => render([]));

  function render(teams) {
    // сортируем по seed (посеву)
    teams.sort((a,b) => (a.seed??999) - (b.seed??999));

    COUNT && (COUNT.textContent = teams.length);
    GRID.innerHTML = teams.map(teamCard).join('');
  }

  function teamCard(t) {
    const name = t.name || `Команда #${t.seed ?? ''}`;
    const players = (t.players || []).map(p => `<span class="tag">${esc(p)}</span>`).join('') || '<span class="tag">TBD</span>';
    return `
      <article class="team-card" role="listitem">
        <div class="team-title">
          <span class="seed-badge" title="Посев">${esc(name)}</span>
        </div>
        <div class="player-tags">${players}</div>
      </article>
    `;
  }

  function esc(s){ return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
})();
