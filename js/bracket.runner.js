(function(){
  const DATA_URL  = 'data/playoff12.json';
  const CAN_EDIT  = !!window.BRACKET_CAN_EDIT;     // false на публичном сайте
  const EXT_RES   = window.BRACKET_RESULTS || null; // приоритет над JSON

  const $ = (s, r=document) => r.querySelector(s);
  const byId = id => document.getElementById(id);
  const el = (t,c,h) => { const n=document.createElement(t); if(c) n.className=c; if(h!=null) n.innerHTML=h; return n; };
  const esc = s => String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const slotHtml = (t) => t ? `
      <div class="seed">#${t.seed}</div>
      <div class="team-name">${esc(t.name)}</div>
      <div class="players">${(t.players||[]).map(esc).join(', ')}</div>
    ` : `<div class="team-name">—</div>`;

  const MATCH_IDS = [
    'W-R1-M1','W-R1-M2','W-R1-M3','W-R1-M4',
    'W-Q1','W-Q2','W-Q3','W-Q4',
    'W-S1','W-S2',
    'W-F',
    'L-R1-M1','L-R1-M2','L-R1-M3','L-R1-M4',
    'L-R2-M1','L-R2-M2',
    'L-R3-M1','L-R3-M2',
    'L-F',
    'GF','P3'
  ];

  const FLOW = {
    // Winners R1
    'W-R1-M1': { win:{id:'W-Q2',slot:2}, lose:{id:'L-R1-M2',slot:2} }, // 5v12
    'W-R1-M2': { win:{id:'W-Q3',slot:2}, lose:{id:'L-R1-M3',slot:2} }, // 6v11
    'W-R1-M3': { win:{id:'W-Q4',slot:2}, lose:{id:'L-R1-M4',slot:2} }, // 7v10
    'W-R1-M4': { win:{id:'W-Q1',slot:2}, lose:{id:'L-R1-M1',slot:2} }, // 8v9

    // Winners QF -> SF; losers -> LB-R1 (slot1)
    'W-Q1': { win:{id:'W-S1',slot:1}, lose:{id:'L-R1-M4',slot:1} },
    'W-Q2': { win:{id:'W-S1',slot:2}, lose:{id:'L-R1-M1',slot:1} },
    'W-Q3': { win:{id:'W-S2',slot:1}, lose:{id:'L-R1-M2',slot:1} },
    'W-Q4': { win:{id:'W-S2',slot:2}, lose:{id:'L-R1-M3',slot:1} },

    // Winners SF -> W-F; losers -> LB-R3 slot1
    'W-S1': { win:{id:'W-F',slot:1}, lose:{id:'L-R3-M1',slot:1} },
    'W-S2': { win:{id:'W-F',slot:2}, lose:{id:'L-R3-M2',slot:1} },

    // Winners Final -> GF slot1; loser -> P3 slot1
    'W-F':  { win:{id:'GF',slot:1}, lose:{id:'P3',slot:1} },

    // Losers bracket progression
    'L-R1-M1': { win:{id:'L-R2-M1',slot:1} },
    'L-R1-M2': { win:{id:'L-R2-M1',slot:2} },
    'L-R1-M3': { win:{id:'L-R2-M2',slot:1} },
    'L-R1-M4': { win:{id:'L-R2-M2',slot:2} },

    'L-R2-M1': { win:{id:'L-R3-M1',slot:2} },
    'L-R2-M2': { win:{id:'L-R3-M2',slot:2} },

    'L-R3-M1': { win:{id:'L-F',slot:1} },
    'L-R3-M2': { win:{id:'L-F',slot:2} },

    // Lower final → GF slot2; loser → P3 slot2
    'L-F':  { win:{id:'GF',slot:2}, lose:{id:'P3',slot:2} }
  };

  const board = {}; // matchId -> {el, slots:[{el,team,origin}, {…}], winner}
  let teamsBySeed = {};

  document.addEventListener('DOMContentLoaded', () => {
    setupBoard();
    fetch(DATA_URL)
      .then(r=>r.json())
      .then(data=>{
        teamsBySeed = Object.fromEntries((data.teams||[]).map(t=>[t.seed, t]));
        seedInitialTeams();
        // применяем результаты: сначала глобалка, затем JSON (или наоборот?)
        // Выберем приоритет глобалки:
        const res = Object.assign({}, data.results||{}, EXT_RES||{});
        applyResults(res);
      })
      .catch(err=>console.error('Bracket JSON load error', err));
  });

  function setupBoard(){
    MATCH_IDS.forEach(id=>{
      const m = byId(id);
      if(!m) return;
      m.classList.add('match');
      m.innerHTML = '';
      const s1 = el('div','slot'); const s2 = el('div','slot');
      m.appendChild(s1); m.appendChild(s2);
      board[id] = {
        el: m,
        slots: [
          { el: s1, team: null, origin: null },
          { el: s2, team: null, origin: null }
        ],
        winner: null
      };
      if (CAN_EDIT) {
        s1.style.cursor = 'pointer';
        s2.style.cursor = 'pointer';
        s1.title = 'Клик: выбрать победителя';
        s2.title = 'Клик: выбрать победителя';
        s1.addEventListener('click', ()=>toggleWin(id,1));
        s2.addEventListener('click', ()=>toggleWin(id,2));
      } else {
        s1.style.cursor = 'default';
        s2.style.cursor = 'default';
        s1.title = '';
        s2.title = '';
      }
    });
  }

  // начальные пары (12 команд)
  function seedInitialTeams(){
    putTeam('W-R1-M1', 1, pick(5),  {from:'seed', id:5});
    putTeam('W-R1-M1', 2, pick(12), {from:'seed', id:12});

    putTeam('W-R1-M2', 1, pick(6),  {from:'seed', id:6});
    putTeam('W-R1-M2', 2, pick(11), {from:'seed', id:11});

    putTeam('W-R1-M3', 1, pick(7),  {from:'seed', id:7});
    putTeam('W-R1-M3', 2, pick(10), {from:'seed', id:10});

    putTeam('W-R1-M4', 1, pick(8),  {from:'seed', id:8});
    putTeam('W-R1-M4', 2, pick(9),  {from:'seed', id:9});

    // 1/4 — 1,4,3,2 в slot-1
    putTeam('W-Q1', 1, pick(1), {from:'seed', id:1});
    putTeam('W-Q2', 1, pick(4), {from:'seed', id:4});
    putTeam('W-Q3', 1, pick(3), {from:'seed', id:3});
    putTeam('W-Q4', 1, pick(2), {from:'seed', id:2});
  }

  function pick(seed){ return teamsBySeed[seed] || null; }

  function putTeam(matchId, slot, team, origin){
    if(!board[matchId]) return;
    const s = board[matchId].slots[slot-1];
    s.team = team || null;
    s.origin = origin || null;
    renderSlot(matchId, slot);
  }

  function renderSlot(matchId, slot){
    const s = board[matchId].slots[slot-1];
    s.el.classList.remove('win','lose');
    s.el.innerHTML = slotHtml(s.team);
  }

  function clearDownstream(matchId){
    for(const [mid, m] of Object.entries(board)){
      m.slots.forEach((s, idx)=>{
        if(s.origin && s.origin.from === matchId){
          s.team = null;
          s.origin = null;
          renderSlot(mid, idx+1);
          clearDownstream(mid);
          if(m.winner && m.slots[m.winner-1].team==null){
            setWinner(mid, null, false);
          }
        }
      });
    }
  }

  function setWinner(matchId, winnerSlot, propagate=true){
    const m = board[matchId];
    if(!m) return;
    m.winner = winnerSlot || null;

    // визуал
    m.slots[0].el.classList.toggle('win',  winnerSlot===1);
    m.slots[1].el.classList.toggle('win',  winnerSlot===2);
    m.slots[0].el.classList.toggle('lose', winnerSlot===2);
    m.slots[1].el.classList.toggle('lose', winnerSlot===1);

    if(!propagate) return;

    clearDownstream(matchId);

    const winnerTeam = winnerSlot ? m.slots[winnerSlot-1].team : null;
    const loserSlot  = winnerSlot ? (winnerSlot===1?2:1) : null;
    const loserTeam  = loserSlot ? m.slots[loserSlot-1].team : null;

    const edge = FLOW[matchId];
    if(edge && winnerSlot && edge.win){
      putTeam(edge.win.id, edge.win.slot, winnerTeam, {from:matchId, type:'win'});
    }
    if(edge && loserSlot && edge.lose){
      putTeam(edge.lose.id, edge.lose.slot, loserTeam, {from:matchId, type:'lose'});
    }
  }

  function toggleWin(matchId, slot){
    if(!CAN_EDIT) return;
    const m = board[matchId];
    if(!m || !m.slots[slot-1].team) return;
    const newW = (m.winner === slot) ? null : slot;
    setWinner(matchId, newW, true);
  }

  // применяем заранее заданные результаты по топологии (от ранних к поздним)
  function applyResults(results){
    const order = [
      'W-R1-M1','W-R1-M2','W-R1-M3','W-R1-M4',
      'W-Q1','W-Q2','W-Q3','W-Q4',
      'W-S1','W-S2',
      'W-F',
      'L-R1-M1','L-R1-M2','L-R1-M3','L-R1-M4',
      'L-R2-M1','L-R2-M2',
      'L-R3-M1','L-R3-M2',
      'L-F',
      'GF','P3'
    ];
    order.forEach(id=>{
      if(results && (id in results)) {
        const v = Number(results[id]);
        if(v===1 || v===2) setWinner(id, v, true);
        else setWinner(id, null, true);
      }
    });
  }
})();
