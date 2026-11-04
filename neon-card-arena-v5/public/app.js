'use strict';
const $ = id => document.getElementById(id);
const socket = io({reconnection:true});
const key='neon-card-arena-v5';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let mode='create',state=null,seenHistory=null,seenDice=null,diceTimer=null,duelTimer=null,initialState=true;
const session=()=>{try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}};
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),4000)}
function setMode(v){mode=v;document.querySelectorAll('[data-mode]').forEach(el=>el.classList.toggle('active',el.dataset.mode===v));$('codeWrap').hidden=v==='create';$('code').required=v!=='create';$('submitRoom').textContent=v==='create'?'ODA OLUŞTUR':v==='join'?'OYUNCU OLARAK KATIL':'İZLEYİCİ OLARAK KATIL';}
document.querySelectorAll('[data-mode]').forEach(el=>el.onclick=()=>setMode(el.dataset.mode));
const codeFromUrl=new URLSearchParams(location.search).get('room');if(codeFromUrl){setMode('join');$('code').value=codeFromUrl.toUpperCase();}
$('roomForm').onsubmit=e=>{e.preventDefault();const ev=mode==='create'?'create-room':mode==='join'?'join-room':'spectate-room';const data={name:$('name').value,password:$('password').value,code:$('code').value};$('submitRoom').disabled=true;socket.emit(ev,data,r=>{$('submitRoom').disabled=false;if(!r?.ok)return toast(r?.error||'Bağlanılamadı');localStorage.setItem(key,JSON.stringify(r));history.replaceState(null,'','/?room='+encodeURIComponent(r.code));$('password').value='';initialState=true;});};
const action=(name,data={})=>socket.emit(name,data,r=>{if(!r?.ok)toast(r?.error||'İşlem gerçekleştirilemedi.');});
$('copyLink').onclick=async()=>{const link=location.origin+'/?room='+encodeURIComponent(state.code);try{await navigator.clipboard.writeText(link);toast('Davet linki kopyalandı. Şifreyi ayrıca gönder.');}catch{prompt('Davet linki',link);}};
$('start').onclick=()=>action('start-game');
$('reset').onclick=()=>{if(confirm('Yeni maç açılsın mı?')){seenHistory=null;initialState=true;action('reset-game');}};
$('closeRoom').onclick=()=>{if(confirm('Oda kapatılsın mı?'))action('close-room');};
$('rollBudget').onclick=()=>action('roll-budget');
$('rollAttack').onclick=()=>action('roll-attack');
$('finishTurn').onclick=()=>action('finish-turn');
$('dismissDuel').onclick=()=>{clearInterval(duelTimer);$('duelOverlay').hidden=true;};
socket.on('connect',()=>{$('connection').textContent='● ONLINE';const s=session();if(s?.code&&s?.token)socket.emit('resume-room',s,r=>{if(!r?.ok){localStorage.removeItem(key);state=null;$('landing').hidden=false;$('game').hidden=true;}})});
socket.on('disconnect',()=>{$('connection').textContent='○ BAĞLANTI KESİLDİ'});
socket.on('session-replaced',()=>{localStorage.removeItem(key);toast('Başka sekmede oturum açıldı.');});
socket.on('room-closed',()=>{localStorage.removeItem(key);state=null;$('duelOverlay').hidden=true;$('game').hidden=true;$('landing').hidden=false;history.replaceState(null,'','/');toast('Oda sahibi odayı kapattı.');});
socket.on('state',next=>{
  const prev=state;
  state=next;
  render();
  const last=next.history.at(-1);
  const histKey=last?next.code+'/'+last.round+'/'+last.plays.map(p=>p.playerId).join('/') : null;
  if(initialState){seenHistory=histKey;seenDice=next.latestDice?.nonce||null;initialState=false;return;}
  if(next.latestDice?.nonce && next.latestDice.nonce!==seenDice){seenDice=next.latestDice.nonce;rollAnimation(next.latestDice);}
  if(histKey&&histKey!==seenHistory){seenHistory=histKey;showDuel(last);}
  if(!last)seenHistory=null;
});
function cardMarkup(c,kind,button,disabled,extra=''){
  const detail=kind==='main'?`€$${c.cost} · RAM ${c.ram} · GÜÇ ${c.power}`:`RAM ${c.ram} · +${c.powerBonus} GÜÇ${c.cost?` · €$${c.cost}`:''}`;
  return `<div class="card-thumb ${kind}"><img src="${esc(c.image)}" alt="${esc(c.name)}"><div class="thumb-meta">${esc(detail)}</div><button ${extra} ${disabled?'disabled':''}>${esc(button)}</button></div>`;
}
function formula(p){if(p.skip)return 'OTOMATİK PAS';return `${p.basePower} + ${p.bonus}${p.supportPower?' + '+p.supportPower:''} = ${p.total} GÜÇ`;}
function publicCardMarkup(p){return p.skip?`<div class="fight-card skipped"><div class="skip-sign">PAS</div><b>${esc(p.playerName)}</b><small>OYNANABİLİR KART YOK</small></div>`:`<div class="fight-card"><img src="${esc(p.card.image)}" alt="${esc(p.card.name)}"><b>${esc(p.playerName)}</b><small>${esc(p.card.name)}</small></div>`;}
function lanes(plays,me){const ordered=me?[...plays].sort((a,b)=>a.playerId===me?1:b.playerId===me?-1:0):plays;return `<div class="battle-lanes">${ordered.map((p,i)=>`<div class="battle-lane ${i?'friendly':'enemy'}"><div class="lane-label">${i?'SENİN SAHAN':'RAKİP SAHASI'}</div>${publicCardMarkup(p)}</div>`).join('')}<div class="lane-divider"><span>VS</span></div></div>`;}
function render(){
  if(!state)return;
  $('landing').hidden=true;$('game').hidden=false;
  const watcher=state.role==='spectator',mine=state.players.find(p=>p.id===state.me),myPlay=state.pending,host=state.hostId===state.me;
  const gameStages=['select','roll','support'];
  $('stageLabel').textContent=({lobby:'LOBBY // WAITING',draftMain:'DRAFT // ANA KART',draftSupport:'DRAFT // DESTEK',budget:'BÜTÇE // 4D6',select:'ANA KART // GİZLİ SEÇİM',roll:'KARTLAR AÇILDI // 2D6',support:'DESTEK // RAM AŞAMASI',finished:'MATCH // COMPLETE'})[state.stage]||'---';
  $('roomCode').textContent=state.code;$('spectators').textContent=state.spectators;
  $('start').hidden=!host||state.stage!=='lobby';$('start').disabled=state.players.length<2;
  $('reset').hidden=!host||state.stage==='lobby';$('closeRoom').hidden=!host;
  $('rollBudget').hidden=watcher||state.stage!=='budget'||!!mine?.rolled;
  $('rollAttack').hidden=watcher||state.stage!=='roll'||!myPlay||myPlay.skip||myPlay.dice;
  $('finishTurn').hidden=watcher||state.stage!=='support'||!myPlay||myPlay.ready;
  $('roundLabel').textContent=state.round?`EL ${state.round} / 3`:'EL — / 3';
  $('players').innerHTML=state.players.map(p=>`<div class="player"><div class="player-top"><b>${esc(p.name)} ${p.id===state.hostId?'♛':''}</b><span class="dot ${p.online?'on':'off'}"></span></div><div class="player-sub">${p.id===state.me?'SEN · ':''}${p.online?'ONLINE':'ÇEVRİMDIŞI'}</div><div class="player-bottom">€$ ${p.budget??'—'}/${p.budgetMax??'—'} <span>${p.wins} EL</span></div></div>`).join('');
  $('score').textContent=state.players.length===2?state.players.map(p=>p.wins).join(' : '):'0 : 0';
  $('budget').textContent=watcher?'—':mine?.budget??'—';$('budgetMax').textContent=watcher?'—':mine?.budgetMax??'—';
  const st={lobby:'İkinci oyuncuyu bekliyoruz. İzleyiciler şifreyle katılabilir.',draftMain:'Sırayla 3 ana kart seçin.',draftSupport:'Sırayla 2 destek kartı seçin.',budget:'Maçlık bütçe 4D6 ile belirlenir. 10 altına +2 telafi.',select:'Ana kartını gizlice seç. İki oyuncu seçince kartlar birlikte açılacak.',roll:'Kartlar açıldı! 2D6 at: 1. zar güç, 2. zar RAM.',support:'RAM fazlan kadar destek bağla; sonra hamleni kilitle.',finished:'Maç tamamlandı. Yeni maç için oda sahibi düğmeye basabilir.'};
  $('status').textContent=st[state.stage]||'';
  if(myPlay?.skip)$('status').textContent='Oynayabileceğin ana kart yok. Bu eli otomatik kaybettin (iki taraf da pas ise beraberlik).';
  if(myPlay?.ready&&state.stage==='support')$('status').textContent='Hamlen kilitlendi. Rakibin hamlesi bekleniyor.';
  if(state.latestDice){const d=state.latestDice;$('diceBox').innerHTML=`<div class="dice-static">${d.dice.map((v,i)=>`<div class="die ${i===0?'attack':''}">${v}</div>`).join('')}</div><small>${d.kind==='budget'?`BÜTÇE ${d.total}${d.compensation?' · +2 TELAFİ':''}`:`SALDIRI +${d.bonus} · RAM ${d.dice[1]}/${d.needed} · ${d.extraRam} EK RAM`}</small>`;}else $('diceBox').innerHTML='<span>Zarlar atılınca burada görünecek.</span>';
  const latest=state.history.at(-1),latestPlays=latest?.plays||[];
  const publicCards=state.publicCards;
  if(publicCards.length){$('battle').innerHTML=lanes(publicCards,state.me);}
  else if(state.stage==='select'&&state.players.some(p=>p.selected)){$('battle').innerHTML='<div class="waiting">⟡<small>ANA KARTLAR KAPALI // RAKİP BEKLENİYOR</small></div>';}
  else if(latest){$('battle').innerHTML=lanes(latestPlays,state.me);}
  else $('battle').innerHTML='<div class="waiting">VS<small>ÇATIŞMA BEKLENİYOR</small></div>';
  $('battleFoot').textContent=latest?`SON EL ${latest.round} · ${latest.tie?'BERABERE':esc(latest.plays.find(p=>p.playerId===latest.winner).playerName)+' KAZANDI'} · ${latestPlays.map(p=>p.skip?'PAS':p.total+' GÜÇ').join(' / ')}`:'KARTLARINIZ AÇILDIKTAN SONRA 2D6 İLE ÇATIŞMA BAŞLAR';
  $('mainCount').textContent=`${state.main.length} / 3`;
  $('supportCount').textContent=`${state.support.length} / 2`;
  $('mainHand').innerHTML=watcher?'<span class="muted">İZLEYİCİ · EL GİZLİ</span>':state.main.map(c=>cardMarkup(c,'main',mine?.budget<c.cost?'BÜTÇE YOK':'ANA KART OYNA',state.stage!=='select'||!!myPlay||mine.budget<c.cost,`data-play="${c.id}"`)).join('')||'<span class="muted">ANA KARTIN KALMADI.</span>';
  document.querySelectorAll('[data-play]').forEach(btn=>btn.onclick=()=>action('play-card',{cardId:btn.dataset.play}));
  const spent=myPlay?.supports?.reduce((total,c)=>total+c.ram,0)||0;
  const remaining=myPlay?Math.max(0,myPlay.extraRam-spent):0;
  $('ramInfo').textContent=watcher?'İzleyicinin destek eli gizlidir.':!myPlay?'ANA KART BEKLENİYOR // Desteği RAM fazlasıyla oynarsın.':myPlay.skip?'OTOMATİK PAS · DESTEK OYNANAMAZ':!myPlay.dice?'2D6 BEKLENİYOR':myPlay.ramPassed?`RAM ${myPlay.ramRoll}/${myPlay.card.ram} ✓ · TOPLAM FAZLA ${myPlay.extraRam} · KALAN ${remaining}`:`RAM ${myPlay.ramRoll}/${myPlay.card.ram} ✕ · DESTEK YOK`;
  $('supportHand').innerHTML=watcher?'<span class="muted">İZLEYİCİ · EL GİZLİ</span>':state.support.map(c=>{const can=state.stage==='support'&&myPlay&&!myPlay.ready&&!myPlay.skip&&myPlay.ramPassed&&c.ram<=remaining&&c.cost<=mine.budget;return cardMarkup(c,'support',can?'DESTEK OYNA':'RAM / BÜTÇE BEKLE',!can,`data-attach="${c.copyId}"`);}).join('')||'<span class="muted">DESTEK KARTIN KALMADI.</span>';
  document.querySelectorAll('[data-attach]').forEach(btn=>btn.onclick=()=>action('attach-support',{copyId:btn.dataset.attach}));
  $('activeInfo').innerHTML=myPlay&&!myPlay.skip?`<b>AKTİF HAMLE</b><span>${esc(myPlay.card.name)} · ${myPlay.dice?`${formula(myPlay)} · EK RAM ${remaining}`:'ZAR BEKLENİYOR'}</span>`:'';
  $('history').innerHTML=state.history.map(h=>`<div class="history-row"><span>EL ${h.round}</span><b>${h.tie?'BERABERE':esc(h.plays.find(p=>p.playerId===h.winner)?.playerName||'')}</b><span>${h.plays.map(p=>p.skip?'PAS':p.total).join(':')}</span></div>`).join('')||'<span class="muted">HENÜZ SONUÇ YOK.</span>';
  const draft=state.stage==='draftMain'||state.stage==='draftSupport';$('draft').hidden=!draft;
  if(draft){const supports=state.stage==='draftSupport';$('draftTitle').textContent=supports?'2 DESTEK KARTI SEÇ':'3 ANA KART SEÇ';$('draftStatus').textContent=state.picker===state.me?'SIRA SENDE':'RAKİP SEÇİYOR';$('draftPool').innerHTML=state.pool.map(c=>`<div class="draft-card"><img src="${esc(c.image)}" alt="${esc(c.name)}"><small>${supports?`RAM ${c.ram} · +${c.powerBonus} GÜÇ`:`€$${c.cost} · RAM ${c.ram} · GÜÇ ${c.power}`}</small><button ${state.picker!==state.me?'disabled':''} data-pick="${supports?c.copyId:c.id}">SEÇ</button></div>`).join('');document.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>action('pick-card',supports?{copyId:b.dataset.pick}:{cardId:b.dataset.pick}));}
}
function rollAnimation(d){
  clearInterval(diceTimer);
  const el=$('diceOverlay');el.hidden=false;
  $('diceTitle').textContent=d.kind==='budget'?'BÜTÇE PROTOKOLÜ // 4D6':'SALDIRI PROTOKOLÜ // 2D6';
  $('diceHeadline').textContent='ZARLAR ATILIYOR';
  let n=0;
  const paint=(settled)=>{$('diceCubes').innerHTML=d.dice.map((v,i)=>`<div class="cube ${settled?'':'rolling'} ${i===0?'attack':''}">${settled?v:Math.ceil(Math.random()*6)}</div>`).join('');};
  paint(false);
  diceTimer=setInterval(()=>{n++;if(n<14){paint(false);return;}clearInterval(diceTimer);paint(true);$('diceHeadline').textContent=d.kind==='budget'?`MALİYET: ${d.total}`:d.ramPassed?'RAM BAŞARILI':'RAM BAŞARISIZ';$('diceExplanation').textContent=d.kind==='budget'?`4D6 toplam${d.compensation?' + 2 telafi':''}.`:d.ramPassed?`Saldırı +${d.bonus} GÜÇ · RAM ${d.dice[1]}/${d.needed} · ${d.extraRam} EK RAM`:`RAM ${d.dice[1]}/${d.needed} · SALDIRI BONUSU İPTAL`;setTimeout(()=>{if(el=== $('diceOverlay'))el.hidden=true;},1500);},95);
}
function showDuel(h){
  clearInterval(duelTimer);$('duelOverlay').hidden=false;
  const winner=h.plays.find(p=>p.playerId===h.winner);
  $('duelSub').textContent=`EL ${h.round} // ÇATIŞMA SONUCU`;
  $('duelHeading').textContent=h.tie?'BERABERE':`${winner?.playerName||'OYUNCU'} KAZANDI`;
  let tick=0;
  const paint=done=>{$('duelCards').innerHTML=h.plays.map((p,i)=>`${i?'<div class="duel-vs">VS</div>':''}<article class="duel-entry ${h.winner===p.playerId?'winner':''}">${p.skip?'<div class="skip-large">PAS</div>':`<img src="${esc(p.card.image)}" alt="${esc(p.card.name)}">`}<b>${esc(p.playerName)}</b><div class="duel-dice">${p.skip?'KART YOK':`<span>⚔ ${done?p.attackRoll:Math.ceil(Math.random()*6)}</span><span>RAM ${done?p.ramRoll:Math.ceil(Math.random()*6)}</span>`}</div><strong>${done?formula(p):'HESAPLANIYOR...'}</strong><small>${p.skip?'BÜTÇE / KART YETERSİZ':done?(p.ramPassed?`RAM BAŞARILI · ${p.extraRam} EK RAM · DESTEK +${p.supportPower}`:'RAM BAŞARISIZ · BONUS İPTAL'):'ZAR VERİLERİ ÇÖZÜLÜYOR'}</small></article>`).join('');};
  paint(false);duelTimer=setInterval(()=>{tick++;if(tick>=10){clearInterval(duelTimer);paint(true);}else paint(false);},90);
}
