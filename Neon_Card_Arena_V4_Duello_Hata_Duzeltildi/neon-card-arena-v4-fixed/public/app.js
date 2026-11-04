'use strict';
const socket = io({ reconnection: true });
const $ = id => document.getElementById(id);
const sessionKey = 'neon-arena-v4-session';
const SUPPORT_META = { dexter: { name: 'Dexter DeShawn — Tactical Boost', ram: 2, powerBonus: 2 }, johnny: { name: 'Johnny Silverhand — Rebel Surge', ram: 4, powerBonus: 4 } };
let mode = 'create';
let state = null;
let seenResult = null;
let duelTimer = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const getSession = () => { try { return JSON.parse(localStorage.getItem(sessionKey) || 'null'); } catch { return null; } };

function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $('toast').classList.remove('show'), 3800);
}

function setMode(next) {
  mode = next;
  document.querySelectorAll('[data-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === next));
  $('codeWrap').hidden = next === 'create';
  $('code').required = next !== 'create';
  $('submitRoom').textContent = next === 'create' ? 'ODA OLUŞTUR' : next === 'join' ? 'OYUNCU OLARAK KATIL' : 'İZLEYİCİ OLARAK KATIL';
}

document.querySelectorAll('[data-mode]').forEach(btn => btn.onclick = () => setMode(btn.dataset.mode));
const roomFromUrl = new URLSearchParams(location.search).get('room');
if (roomFromUrl) {
  setMode('join');
  $('code').value = roomFromUrl.toUpperCase();
}

$('roomForm').onsubmit = event => {
  event.preventDefault();
  const ev = mode === 'create' ? 'create-room' : mode === 'join' ? 'join-room' : 'spectate-room';
  const payload = { name: $('name').value, password: $('password').value, code: $('code').value };
  $('submitRoom').disabled = true;
  socket.emit(ev, payload, res => {
    $('submitRoom').disabled = false;
    if (!res?.ok) return toast(res?.error || 'Bağlantı kurulamadı.');
    localStorage.setItem(sessionKey, JSON.stringify(res));
    history.replaceState(null, '', '/?room=' + encodeURIComponent(res.code));
    $('password').value = '';
    seenResult = null;
  });
};

function action(ev, payload = {}) {
  socket.emit(ev, payload, res => {
    if (!res?.ok) toast(res?.error || 'İşlem başarısız.');
  });
}

$('copyLink').onclick = async () => {
  const url = location.origin + '/?room=' + encodeURIComponent(state.code);
  try {
    await navigator.clipboard.writeText(url);
    toast('Davet bağlantısı kopyalandı. Şifreyi ayrıca gönder.');
  } catch {
    prompt('Davet bağlantısı', url);
  }
};
$('start').onclick = () => action('start-game');
$('reset').onclick = () => { if (confirm('Yeni maça dönmek istiyor musun?')) { seenResult = null; action('reset-game'); } };
$('rollBudget').onclick = () => action('roll-budget');
$('finishTurn').onclick = () => action('finish-turn');
$('dismissDuel').onclick = () => {
  clearInterval(duelTimer);
  $('duelOverlay').hidden = true;
};

socket.on('connect', () => {
  $('connection').textContent = '● ONLINE';
  const saved = getSession();
  if (saved?.code && saved?.token) {
    socket.emit('resume-room', saved, res => {
      if (!res?.ok) {
        localStorage.removeItem(sessionKey);
        state = null;
        $('landing').hidden = false;
        $('game').hidden = true;
      }
    });
  }
});
socket.on('disconnect', () => $('connection').textContent = '○ BAĞLANTI KESİLDİ');
socket.on('session-replaced', () => { localStorage.removeItem(sessionKey); toast('Bu oyuncu başka sekmede açıldı.'); });
socket.on('state', next => {
  state = next;
  render();
  const last = next.roundHistory.at(-1);
  if (!last) {
    seenResult = null;
    return;
  }
  const key = `${next.code}-${last.round}-${last.plays.map(p => p.playerId + p.card.id + p.totalPower).join('|')}`;
  if (seenResult !== key) {
    seenResult = key;
    showDuel(last);
  }
});

function supportSpent(entry) {
  return entry.supportIds.reduce((sum, id) => sum + (SUPPORT_META[id]?.ram || 0), 0);
}

function renderDiceSummary(roll) {
  if (!roll) return '<span class="dim">Zarlar burada görünecek.</span>';
  const dice = roll.dice.map((num, idx) => `<div class="die ${roll.kind === 'attack' && idx === 0 ? 'attack' : ''}">${num}</div>`).join('');
  if (roll.kind === 'budget') return `${dice}<div class="dice-detail">3D6 TOPLAM BÜTÇE = <b>${roll.total}</b></div>`;
  return `${dice}<div class="dice-detail">1. ZAR = +${roll.attackRoll || roll.bonus} güç · 2. ZAR = RAM ${roll.ramRoll} ${roll.ramPassed ? `✓ (${roll.extraRam} EK RAM)` : '✗ (BONUS İPTAL)'}</div>`;
}

function miniMainCard(card, label, disabled) {
  return `
    <div class="hand-card main-card">
      <img src="${esc(card.image)}" alt="${esc(card.name)}" title="${esc(card.name)} · Maliyet ${card.cost} · RAM ${card.ram} · Güç ${card.power}">
      <div class="card-statline">€$${card.cost} · RAM ${card.ram} · PWR ${card.power}</div>
      <button data-play-card="${card.id}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>
    </div>`;
}

function miniSupportCard(card, label, disabled) {
  return `
    <div class="hand-card support-card ${disabled ? 'disabled' : ''}">
      <img src="${esc(card.image)}" alt="${esc(card.name)}" title="${esc(card.name)} · Destek · RAM ${card.ram} · +${card.powerBonus} Güç">
      <div class="card-type">DESTEK</div>
      <div class="card-statline">RAM ${card.ram} · +${card.powerBonus} GÜÇ</div>
      <button data-support-card="${card.id}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>
    </div>`;
}

function battleFormula(play) {
  return `${play.basePower} + ${play.bonus}${play.supportPower ? ` + ${play.supportPower}` : ''} = ${play.totalPower}`;
}

function render() {
  if (!state) return;
  const spectator = state.role === 'spectator';
  const me = state.players.find(p => p.id === state.me);
  const host = state.me === state.hostId;
  const pending = state.pending;
  const usedSupportRam = pending ? supportSpent(pending) : 0;
  const remainingSupportRam = pending ? Math.max(0, pending.extraRam - usedSupportRam) : 0;
  const canFinish = !!pending && !pending.ready;

  $('landing').hidden = true;
  $('game').hidden = false;
  $('roomCode').textContent = state.code;
  $('spectators').textContent = state.spectatorCount;
  $('phaseText').textContent = ({ lobby: 'LOBBY', draft: 'ANA KART SEÇİMİ', budget: 'BÜTÇE ZARI', playing: 'DÜELLO', finished: 'MAÇ SONU' })[state.phase];
  $('roundLabel').textContent = state.round ? `EL ${state.round} / 3` : 'EL — / 3';

  $('start').hidden = !host || state.phase !== 'lobby';
  $('start').disabled = state.players.length !== 2;
  $('reset').hidden = !host || state.phase === 'lobby';
  $('rollBudget').hidden = spectator || state.phase !== 'budget';
  $('rollBudget').disabled = !!me?.rolled;
  $('finishTurn').hidden = !canFinish;
  $('finishTurn').disabled = !canFinish;

  $('budget').textContent = spectator ? 'İZLEYİCİ' : me?.budget == null ? '—' : `${me.budget} / ${me.budgetMax}`;
  $('players').innerHTML = state.players.map(player => `
    <div class="player">
      <div class="name"><span>${esc(player.name)} ${player.id === state.hostId ? '♛' : ''}</span><span style="color:${player.online ? '#d7f85e' : '#ff7484'}">●</span></div>
      <small>${player.id === state.me ? 'SEN · ' : ''}${player.online ? 'ONLINE' : 'ÇEVRİMDIŞI'}</small>
      <div class="data">€$ ${player.budget ?? '—'}/${player.budgetMax ?? '—'} · ${player.wins} el</div>
    </div>`).join('');

  $('score').textContent = state.players.length === 2 ? `${state.players[0].wins} : ${state.players[1].wins}` : '0 : 0';

  const status = {
    lobby: 'İkinci oyuncu gelince oda sahibi maçı başlatır. İzleyiciler şifreyle giriş yapabilir.',
    draft: state.draftTurn === state.me ? 'Sıra sende. 3 ana kartından birini seç.' : 'Oyuncular sırayla ana kart seçiyor.',
    budget: spectator ? 'Oyuncular 3D6 bütçe zarı atıyor.' : me?.rolled ? 'Rakibin bütçe zarı bekleniyor.' : '3D6 at ve maçlık bütçeni oluştur.',
    playing: spectator ? 'Oyuncular kartlarını seçiyor ve 2D6 çözümlenmesini bekliyor.' : pending ? (pending.ready ? 'Hamleni kilitledin. Rakibi bekliyorsun.' : 'Destek ekleyebilir veya turunu kilitleyebilirsin.') : 'Bir ana kart oyna. 1. zar güce, 2. zar RAM kontrolüne gider.',
    finished: '3 el tamamlandı. Oda sahibi yeni maçı başlatabilir.'
  };
  $('status').textContent = status[state.phase];
  $('diceView').innerHTML = renderDiceSummary(state.roll);

  const last = state.roundHistory.at(-1);
  const revealedBattle = last ? last.plays.map((play, idx) => `${idx ? '<span class="versus">VS</span>' : ''}<div class="battle-card"><img src="${esc(play.card.image)}" alt="${esc(play.card.name)}"><strong>${esc(play.playerName)}</strong><div class="power">${battleFormula(play)} GÜÇ</div><div class="battle-ram">RAM ${play.ramRoll}/${play.card.ram} ${play.ramPassed ? `· +${play.bonus} AKTİF` : '· BONUS İPTAL'}</div></div>`).join('') : '';
  const staged = state.players.filter(player => player.played).length;
  $('battle').innerHTML = state.phase === 'playing' && staged
    ? `<div class="placeholder"><span class="flash">⚔</span><small>${staged} / 2 kart hazır · açılış bekleniyor</small></div>`
    : (revealedBattle || '<div class="placeholder">VS<small>Rakibini bekle</small></div>');

  $('previous').textContent = last
    ? `SON EL ${last.round} · ${last.tie ? 'BERABERE' : esc(last.plays.find(p => p.playerId === last.winner).playerName) + ' KAZANDI'} · ${last.plays.map(p => p.totalPower).join(' — ')} GÜÇ`
    : 'Kartlar açıldığında düello sonucu burada görünür.';

  $('handMeta').textContent = `${state.hand.length} / 3`;
  $('hand').innerHTML = spectator
    ? '<span class="dim">İzleyiciler oyuncu eli göremez.</span>'
    : state.hand.map(card => miniMainCard(card, me?.budget < card.cost ? 'YETERSİZ' : 'OYNA', state.phase !== 'playing' || !!pending || me?.budget < card.cost)).join('') || '<span class="dim">Ana kart kalmadı.</span>';
  document.querySelectorAll('[data-play-card]').forEach(btn => btn.onclick = () => action('play-card', { cardId: btn.dataset.playCard }));

  $('supportStatus').textContent = spectator
    ? 'İzleyici modunda destek eli gizli.'
    : !pending ? 'Önce bir ana kart oyna. Fazla RAM oluşursa destek bağlayabilirsin.'
    : pending.ramPassed ? `RAM başarılı. Kart RAM'i ${pending.card.ram}, 2. zar ${pending.ramRoll}. Kullanılabilir ekstra RAM: ${pending.extraRam}. Kalan destek RAM: ${remainingSupportRam}.`
      : `RAM başarısız. 2. zar ${pending.ramRoll} kaldı; ${pending.card.ram} RAM eşiğini geçemediği için güç bonusu iptal oldu.`;

  $('supports').innerHTML = spectator
    ? '<span class="dim">İzleyici desteği göremez.</span>'
    : state.supports.length
      ? state.supports.map(card => {
          const disabled = !pending || pending.ready || remainingSupportRam < card.ram;
          const label = disabled ? (pending ? 'RAM YETMİYOR' : 'ANA KART BEKLENİYOR') : 'BAĞLA';
          return miniSupportCard(card, label, disabled);
        }).join('')
      : '<span class="dim">Destek kartın kalmadı.</span>';
  document.querySelectorAll('[data-support-card]').forEach(btn => btn.onclick = () => action('attach-support', { cardId: btn.dataset.supportCard }));

  $('pendingInfo').innerHTML = pending
    ? `<div class="pending-card">AKTİF KART: <b>${esc(pending.card.name)}</b><br>Temel güç ${pending.basePower} · 1. zar +${pending.attackRoll} · ${pending.ramPassed ? 'bonus aktif' : 'bonus iptal'} · ekstra RAM ${pending.extraRam}<br>Bağlanan destek: ${pending.supportIds.length ? pending.supportIds.map(id => esc(SUPPORT_META[id]?.name || id)).join(', ') : 'yok'} · Toplam güç <b>${pending.totalPower}</b></div>`
    : '<span class="dim">Bu elde henüz kart oynamadın.</span>';

  $('history').innerHTML = state.roundHistory.map(item => `
    <div class="history-item">
      <span>EL ${item.round}</span>
      <b>${item.tie ? 'BERABERE' : esc(item.plays.find(p => p.playerId === item.winner).playerName)}</b>
      <span>${item.plays[0].totalPower}:${item.plays[1].totalPower}</span>
    </div>`).join('') || '<span class="dim">Henüz sonuç yok.</span>';

  $('draftStrip').hidden = state.phase !== 'draft';
  if (state.phase === 'draft') {
    $('draftStatus').textContent = spectator ? 'SEÇİMİ İZLİYORSUN' : state.draftTurn === state.me ? 'SIRA SENDE' : 'RAKİP SEÇİYOR';
    $('draftPool').innerHTML = state.draftPool.map(card => `
      <div class="draft-card">
        <img src="${esc(card.image)}" alt="${esc(card.name)}" title="${esc(card.name)}">
        <div class="draft-mini">€$${card.cost} · RAM ${card.ram} · PWR ${card.power}</div>
        <button data-pick="${card.id}" ${state.draftTurn !== state.me ? 'disabled' : ''}>SEÇ</button>
      </div>`).join('');
    document.querySelectorAll('[data-pick]').forEach(btn => btn.onclick = () => action('pick-card', { cardId: btn.dataset.pick }));
  }
}

function duelEntryHtml(play, reveal, randomAttack = 1, randomRam = 1, winner = false) {
  return `
    <div class="duel-entry ${winner ? 'is-winner' : ''}">
      <img src="${esc(play.card.image)}" alt="${esc(play.card.name)}">
      <div class="username">${esc(play.playerName)}</div>
      <div class="duel-cardname">${esc(play.card.name)}</div>
      <div class="duel-dice-wrap">
        <div class="duel-die attack">${reveal ? play.attackRoll : randomAttack}</div>
        <div class="duel-die ram">${reveal ? play.ramRoll : randomRam}</div>
      </div>
      <div class="ram">${reveal ? `1. ZAR +${play.attackRoll} güç · 2. ZAR ${play.ramRoll}/${play.card.ram} ${play.ramPassed ? `✓ (${play.extraRam} EK RAM)` : '✗ BONUS YOK'}` : 'Zarlar dönüyor...'}</div>
      <div class="formula ${reveal ? '' : 'concealed'}">${reveal ? `${play.basePower} + ${play.bonus}${play.supportPower ? ` + ${play.supportPower}` : ''} = ${play.totalPower} GÜÇ` : '???'}</div>
      <div class="support-line ${reveal ? '' : 'concealed'}">${reveal ? (play.supportIds.length ? `Destek +${play.supportPower}` : 'Destek yok') : 'Bekleniyor'}</div>
      ${winner ? '<div class="winner">★ EL GALİBİ ★</div>' : ''}
    </div>`;
}

function showDuel(round) {
  clearInterval(duelTimer);
  const winnerName = round.tie ? 'BERABERE!' : `${round.plays.find(play => play.playerId === round.winner).playerName} KAZANDI!`;
  $('duelHeading').textContent = winnerName;
  $('duelSub').textContent = `EL ${round.round} SONUÇLARI`;
  $('duelOverlay').hidden = false;

  const renderFrame = reveal => {
    $('duelCompare').innerHTML = round.plays.map((play, index) => {
      const winner = round.winner === play.playerId;
      const a = 1 + Math.floor(Math.random() * 6);
      const b = 1 + Math.floor(Math.random() * 6);
      return `${index ? '<div class="duel-vs">VS</div>' : ''}${duelEntryHtml(play, reveal, a, b, winner)}`;
    }).join('');
  };

  let frames = 0;
  renderFrame(false);
  duelTimer = setInterval(() => {
    frames++;
    if (frames >= 11) {
      clearInterval(duelTimer);
      renderFrame(true);
      return;
    }
    renderFrame(false);
  }, 90);
}
