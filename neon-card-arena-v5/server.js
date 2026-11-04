'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

const MAIN = [
  {id:'v', name:'V — Streetkid', cost:5, ram:2, power:6, image:'/cards/v.png', type:'main'},
  {id:'royce', name:'Royce — Psycho on the Edge', cost:6, ram:2, power:6, image:'/cards/royce.png', type:'main'},
  {id:'adam', name:'Adam Smasher — Ender of Legends', cost:9, ram:2, power:9, image:'/cards/adam.png', type:'main'},
  {id:'japantown', name:'Japantown Ronin', cost:2, ram:2, power:0, image:'/cards/japantown.png', type:'main'},
  {id:'ruthless', name:'Ruthless Lowlife', cost:2, ram:1, power:4, image:'/cards/ruthless.png', type:'main'},
  {id:'llorona', name:'La Llorona — Ghost of the Past', cost:3, ram:1, power:3, image:'/cards/llorona.png', type:'main'}
];
// The pictured cost-less cards are light supports. Their combat effects are provisional.
// Future heavy supports can use a positive cost, which is charged only when attached.
const SUPPORT = [
  {id:'dexter', name:'Dexter DeShawn — Off the Grid', cost:0, ram:2, powerBonus:2, image:'/cards/dexter.png', type:'support', description:'Hafif destek · +2 güç'},
  {id:'johnny', name:'Johnny Silverhand — Rocking Renegade', cost:0, ram:2, powerBonus:4, image:'/cards/johnny.png', type:'support', description:'Hafif destek · +4 güç'}
];
const mainById = id => MAIN.find(c => c.id === id);
const supportById = id => SUPPORT.find(c => c.id === id);
const roll = n => Array.from({length:n}, () => crypto.randomInt(1,7));
const sum = arr => arr.reduce((a,b) => a+b,0);
const codeGen = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const hash = (password,salt) => crypto.scryptSync(password,salt,32).toString('hex');
const cleanName = n => String(n||'').trim().slice(0,24);
const reply = (cb, ok, error, extra={}) => {if(typeof cb==='function') cb({ok,...(error?{error}:{}),...extra});};
const getRoom = socket => rooms.get(socket.data.room);
function membership(socket) {
  const r=getRoom(socket),p=r?.players.get(socket.data.playerId);
  return p && p.socketId === socket.id ? {r,p} : null;
}
function spectator(socket) {
  const r=getRoom(socket),p=r?.spectators.get(socket.data.spectatorId);
  return p && p.socketId === socket.id ? {r,p} : null;
}
function event(r,message) {r.log.unshift({message,time:Date.now()});r.log.length= Math.min(r.log.length,50);}
function player(name){return {id:crypto.randomUUID(),name,token:crypto.randomBytes(24).toString('hex'),socketId:null,main:[],support:[],budgetMax:null,budget:null,wins:0,lastDice:null,rolled:false};}
function audience(name){return {id:crypto.randomUUID(),name,token:crypto.randomBytes(24).toString('hex'),socketId:null};}
function attach(socket,r,p,role) {
  if(socket.data.room) socket.leave(socket.data.room);
  if(p.socketId && p.socketId!==socket.id) {
    io.to(p.socketId).emit('session-replaced');
    io.sockets.sockets.get(p.socketId)?.disconnect(true);
  }
  p.socketId=socket.id;
  socket.data.room=r.code;
  socket.data.playerId=role==='player'?p.id:null;
  socket.data.spectatorId=role==='spectator'?p.id:null;
  socket.join(r.code);
  broadcast(r);
}
const spentSupportRam = play => play.supports.reduce((n,s)=>n+s.ram,0);
function stateFor(r,p) {
  const selfId=p?.id||null;
  const reveal = r.stage==='roll'||r.stage==='support'||r.stage==='finished';
  const pendingMine=r.plays[selfId]||null;
  const selections=reveal?r.order.map(id=>r.plays[id]).filter(Boolean).map(pl=>({playerId:pl.playerId,playerName:pl.playerName,card:pl.card,skip:pl.skip})) : [];
  return {
    code:r.code,hostId:r.hostId,me:selfId,role:p?'player':'spectator',stage:r.stage,round:r.round,
    spectators:r.spectators.size,players:r.order.map(id=>{const q=r.players.get(id);return {id:q.id,name:q.name,online:!!q.socketId,budget:q.budget,budgetMax:q.budgetMax,wins:q.wins,mainCount:q.main.length,supportCount:q.support.length,rolled:q.rolled,selected:!!r.plays[q.id],diceRolled:!!r.plays[q.id]?.dice,locked:!!r.plays[q.id]?.ready};}),
    pool:r.stage==='draftMain'?r.mainDeck.map(mainById):r.stage==='draftSupport'?r.supportDeck.map(v=>({...supportById(v.id),copyId:v.copyId})):[],
    picker:(r.stage==='draftMain'||r.stage==='draftSupport')?r.order[r.draftIndex%2]:null,
    main:p?p.main.map(mainById):[],support:p?p.support.map(v=>({...supportById(v.id),copyId:v.copyId})):[],
    pending:pendingMine,publicCards:selections,
    history:r.history,latestDice:p?p.lastDice:null,
    log:r.log.slice(0,6)
  };
}
function broadcast(r) {
  for(const p of r.players.values()) if(p.socketId) io.to(p.socketId).emit('state',stateFor(r,p));
  for(const v of r.spectators.values()) if(v.socketId) io.to(v.socketId).emit('state',stateFor(r,null));
}
function finishMatch(r) {
  r.stage='finished';
  const [a,b]=r.order.map(id=>r.players.get(id));
  event(r,a.wins===b.wins?'Maç berabere!':`${a.wins>b.wins?a.name:b.name} maçı kazandı!`);
}
function finishRound(r) {
  const plays=r.order.map(id=>r.plays[id]);
  const [a,b]=plays;
  const win = a.skip&&b.skip ? null : a.skip ? b.playerId : b.skip ? a.playerId : a.total===b.total ? null : (a.total>b.total?a.playerId:b.playerId);
  if(win) r.players.get(win).wins++;
  r.history.push({round:r.round,plays,winner:win,tie:!win});
  event(r,`EL ${r.round}: ${a.playerName} ${a.skip?'PAS':a.total} - ${b.skip?'PAS':b.total} ${b.playerName}; ${win?r.players.get(win).name+' kazandı':'berabere'}.`);
  r.plays={};
  if(r.round===3 || r.order.some(id=>r.players.get(id).wins>=2)) return finishMatch(r);
  r.round++;
  r.stage='select';
  beginSelection(r);
}
function maybeFinishRound(r) {
  if(r.stage==='support' && r.order.every(id=>r.plays[id]?.ready)) finishRound(r);
}
function maybeFinishRolls(r) {
  if(r.stage!=='roll') return;
  if(r.order.every(id=>r.plays[id]?.dice)) {
    r.stage='support';
    for(const id of r.order) {
      const play=r.plays[id],p=r.players.get(id);
      if(play.skip){play.ready=true;continue;}
      const extra=play.extraRam;
      if(!p.support.some(s=>{const c=supportById(s.id);return c.ram<=extra&&c.cost<=p.budget})) play.ready=true;
    }
    maybeFinishRound(r);
  }
}
function beginSelection(r) {
  // Auto-pass when no affordable main card remains; only the rival can win that round.
  for(const id of r.order) {
    const p=r.players.get(id);
    if(!p.main.some(cardId=>mainById(cardId).cost<=p.budget)) {
      r.plays[id]={playerId:id,playerName:p.name,card:null,skip:true,basePower:0,attackRoll:null,ramRoll:null,ramPassed:false,bonus:0,extraRam:0,supports:[],supportPower:0,total:0,costPaid:0,dice:true,ready:true};
      event(r,`${p.name}, EL ${r.round}: oynanabilir kartı yok, otomatik pas.`);
    }
  }
  if(r.order.every(id=>r.plays[id])) {
    r.stage='support';
    finishRound(r);
  }
}
function resetGame(r) {
  r.stage='lobby';r.round=0;r.mainDeck=[];r.supportDeck=[];r.draftIndex=0;r.plays={};r.history=[];
  for(const p of r.players.values()) {p.main=[];p.support=[];p.budget=null;p.budgetMax=null;p.wins=0;p.lastDice=null;p.rolled=false;}
}

io.on('connection',socket=>{
  socket.on('create-room',(b={},cb)=>{
    try {
      const name=cleanName(b.name),password=String(b.password||'');
      if(!name||password.length<4||password.length>64) return reply(cb,false,'Ad ve en az 4 karakterli şifre gerekli.');
      let code;do{code=codeGen();}while(rooms.has(code));
      const salt=crypto.randomBytes(16).toString('hex'),p=player(name);
      const r={code,salt,passwordHash:hash(password,salt),hostId:p.id,players:new Map([[p.id,p]]),spectators:new Map(),order:[p.id],stage:'lobby',round:0,mainDeck:[],supportDeck:[],draftIndex:0,plays:{},history:[],log:[],created:Date.now()};
      rooms.set(code,r);event(r,`${name} odayı kurdu.`);attach(socket,r,p,'player');reply(cb,true,null,{code,playerId:p.id,token:p.token,role:'player'});
    }catch{reply(cb,false,'Oda kurulamadı.');}
  });
  socket.on('join-room',(b={},cb)=>{
    try {
      const code=String(b.code||'').trim().toUpperCase(),r=rooms.get(code),name=cleanName(b.name),password=String(b.password||'');
      if(!r||!name) return reply(cb,false,'Oda veya isim bulunamadı.');
      if(!crypto.timingSafeEqual(Buffer.from(r.passwordHash,'hex'),Buffer.from(hash(password,r.salt),'hex'))) return reply(cb,false,'Şifre yanlış.');
      if(r.stage!=='lobby'||r.players.size>=2) return reply(cb,false,'Oda iki oyuncu ile dolu veya oyun başladı; izleyici girebilirsin.');
      const p=player(name);r.players.set(p.id,p);r.order.push(p.id);event(r,`${name} odaya katıldı.`);attach(socket,r,p,'player');reply(cb,true,null,{code,playerId:p.id,token:p.token,role:'player'});
    }catch{reply(cb,false,'Odaya katılamadın.');}
  });
  socket.on('spectate-room',(b={},cb)=>{
    try {
      const code=String(b.code||'').trim().toUpperCase(),r=rooms.get(code),password=String(b.password||''),name=cleanName(b.name)||'İzleyici';
      if(!r) return reply(cb,false,'Oda bulunamadı.');
      if(!crypto.timingSafeEqual(Buffer.from(r.passwordHash,'hex'),Buffer.from(hash(password,r.salt),'hex'))) return reply(cb,false,'Şifre yanlış.');
      if(r.spectators.size>=40) return reply(cb,false,'İzleyici limiti dolu.');
      const p=audience(name);r.spectators.set(p.id,p);attach(socket,r,p,'spectator');reply(cb,true,null,{code,spectatorId:p.id,token:p.token,role:'spectator'});
    }catch{reply(cb,false,'İzleyici girişi başarısız.');}
  });
  socket.on('resume-room',(b={},cb)=>{
    const r=rooms.get(String(b.code||'').trim().toUpperCase());
    if(!r) return reply(cb,false,'Oda bulunamadı.');
    const spect=b.role==='spectator',p=spect?r.spectators.get(b.spectatorId):r.players.get(b.playerId);
    if(!p||p.token!==b.token) return reply(cb,false,'Oturum bulunamadı.');
    attach(socket,r,p,spect?'spectator':'player');reply(cb,true);
  });
  socket.on('start-game',(_,cb)=>{
    const m=membership(socket);if(!m) return reply(cb,false,'Oyuncu değilsin.');
    const {r,p}=m;
    if(r.hostId!==p.id||r.stage!=='lobby'||r.players.size!==2) return reply(cb,false,'İki oyuncu hazırken oda sahibi başlatabilir.');
    resetGame(r);r.stage='draftMain';r.mainDeck=MAIN.map(c=>c.id);r.supportDeck=SUPPORT.flatMap(c=>[0,1].map(n=>({id:c.id,copyId:c.id+'-'+n})));event(r,'3 ana kart seçimi başladı.');broadcast(r);reply(cb,true);
  });
  socket.on('pick-card',(b={},cb)=>{
    const m=membership(socket);if(!m) return reply(cb,false,'Oyuncu değilsin.');
    const {r,p}=m;
    if(!['draftMain','draftSupport'].includes(r.stage)||r.order[r.draftIndex%2]!==p.id) return reply(cb,false,'Şu an seçim sırası sende değil.');
    if(r.stage==='draftMain') {
      if(!r.mainDeck.includes(b.cardId)) return reply(cb,false,'Ana kart destede yok.');
      p.main.push(b.cardId);r.mainDeck=r.mainDeck.filter(id=>id!==b.cardId);r.draftIndex++;
      if(r.draftIndex===6){r.stage='draftSupport';r.draftIndex=0;event(r,'Şimdi ikişer destek kartı seçin.');}
    }else{
      const chosen=r.supportDeck.find(c=>c.copyId===b.copyId);
      if(!chosen) return reply(cb,false,'Destek kartı destede yok.');
      p.support.push(chosen);r.supportDeck=r.supportDeck.filter(c=>c.copyId!==chosen.copyId);r.draftIndex++;
      if(r.draftIndex===4){r.stage='budget';event(r,'Kart seçimi tamamlandı. 4D6 bütçe atılacak.');}
    }
    broadcast(r);reply(cb,true);
  });
  socket.on('roll-budget',(_,cb)=>{
    const m=membership(socket);if(!m) return reply(cb,false,'Oyuncu değilsin.');
    const {r,p}=m;if(r.stage!=='budget'||p.rolled) return reply(cb,false,'Bütçe zarı atamazsın.');
    const dice=roll(4),raw=sum(dice),compensation=raw<10?2:0;
    p.budgetMax=raw+compensation;p.budget=p.budgetMax;p.rolled=true;p.lastDice={kind:'budget',dice,total:p.budget,compensation,nonce:crypto.randomUUID()};
    event(r,`${p.name} bütçe: ${raw}${compensation?' +2 telafi':''} = ${p.budget}.`);
    if(r.order.every(id=>r.players.get(id).rolled)){r.stage='select';r.round=1;beginSelection(r);}
    broadcast(r);reply(cb,true);
  });
  socket.on('play-card',(b={},cb)=>{
    const m=membership(socket);if(!m) return reply(cb,false,'Oyuncu değilsin.');
    const {r,p}=m;
    if(r.stage!=='select'||r.plays[p.id]) return reply(cb,false,'Bu elde ana kart seçemezsin.');
    const c=mainById(b.cardId);
    if(!c||!p.main.includes(c.id)||c.cost>p.budget) return reply(cb,false,'Kart elinde değil veya bütçen yetersiz.');
    p.budget-=c.cost;p.main=p.main.filter(id=>id!==c.id);
    r.plays[p.id]={playerId:p.id,playerName:p.name,card:c,skip:false,basePower:c.power,attackRoll:null,ramRoll:null,ramPassed:false,bonus:0,extraRam:0,supports:[],supportPower:0,total:c.power,costPaid:c.cost,dice:false,ready:false};
    event(r,`${p.name} ana kartını gizli seçti.`);
    if(r.order.every(id=>r.plays[id])) {r.stage='roll';event(r,'İki ana kart açıldı. 2D6 atın.');maybeFinishRolls(r);}
    broadcast(r);reply(cb,true);
  });
  socket.on('roll-attack',(_,cb)=>{
    const m=membership(socket);if(!m) return reply(cb,false,'Oyuncu değilsin.');
    const {r,p}=m,play=r.plays[p.id];
    if(r.stage!=='roll'||!play||play.skip||play.dice) return reply(cb,false,'Şu an 2D6 atamazsın.');
    const dice=roll(2);play.dice=true;play.attackRoll=dice[0];play.ramRoll=dice[1];play.ramPassed=dice[1]>=play.card.ram;
    play.bonus=play.ramPassed?dice[0]:0;play.extraRam=play.ramPassed?dice[1]-play.card.ram:0;play.total=play.basePower+play.bonus;
    p.lastDice={kind:'attack',dice,ramPassed:play.ramPassed,bonus:play.bonus,extraRam:play.extraRam,needed:play.card.ram,nonce:crypto.randomUUID()};
    event(r,`${p.name} zar attı: +${play.bonus} güç, ${play.extraRam} ekstra RAM.`);
    maybeFinishRolls(r);broadcast(r);reply(cb,true);
  });
  socket.on('attach-support',(b={},cb)=>{
    const m=membership(socket);if(!m) return reply(cb,false,'Oyuncu değilsin.');
    const {r,p}=m,play=r.plays[p.id];
    if(r.stage!=='support'||!play||play.ready||play.skip) return reply(cb,false,'Şu an destek oynayamazsın.');
    const copy=p.support.find(v=>v.copyId===b.copyId),c=copy&&supportById(copy.id);
    if(!c) return reply(cb,false,'Destek kartı sende yok.');
    if(!play.ramPassed||c.ram>play.extraRam-spentSupportRam(play)) return reply(cb,false,'RAM kontrolü başarısız veya ekstra RAM yetersiz.');
    if(c.cost>p.budget) return reply(cb,false,'Destek için bütçen yetersiz.');
    p.budget-=c.cost;
    p.support=p.support.filter(v=>v.copyId!==copy.copyId);
    play.supports.push({...c,copyId:copy.copyId});play.supportPower+=c.powerBonus;play.total+=c.powerBonus;
    event(r,`${p.name} ${c.name} desteğini bağladı: +${c.powerBonus} güç.`);
    broadcast(r);reply(cb,true);
  });
  socket.on('finish-turn',(_,cb)=>{
    const m=membership(socket);if(!m) return reply(cb,false,'Oyuncu değilsin.');
    const {r,p}=m,play=r.plays[p.id];
    if(r.stage!=='support'||!play||play.ready) return reply(cb,false,'Kilitleyebileceğin hamle yok.');
    play.ready=true;event(r,`${p.name} hamlesini kilitledi.`);maybeFinishRound(r);broadcast(r);reply(cb,true);
  });
  socket.on('reset-game',(_,cb)=>{
    const m=membership(socket);if(!m||m.r.hostId!==m.p.id) return reply(cb,false,'Sadece oda sahibi yeni maç açabilir.');
    resetGame(m.r);event(m.r,'Maç sıfırlandı.');broadcast(m.r);reply(cb,true);
  });
  socket.on('close-room',(_,cb)=>{
    const m=membership(socket);if(!m||m.r.hostId!==m.p.id) return reply(cb,false,'Odayı yalnızca sahibi kapatabilir.');
    io.to(m.r.code).emit('room-closed');rooms.delete(m.r.code);reply(cb,true);
  });
  socket.on('disconnect',()=>{
    const m=membership(socket);if(m){m.p.socketId=null;broadcast(m.r);return;}
    const v=spectator(socket);if(v){v.p.socketId=null;v.r.spectators.delete(v.p.id);broadcast(v.r);}
  });
});
setInterval(()=>{for(const [code,r] of rooms){if(Date.now()-r.created>24*3600e3&&![...r.players.values()].some(p=>p.socketId)&&r.spectators.size===0)rooms.delete(code);}},3600e3).unref();
server.listen(process.env.PORT||3000,()=>console.log('Neon Card Arena v5 running'));
