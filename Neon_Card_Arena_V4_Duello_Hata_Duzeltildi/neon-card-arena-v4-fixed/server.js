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

const MAIN_CARDS = [
  { id: 'v', name: 'V — Streetkid', cost: 5, ram: 2, power: 6, image: '/cards/v.png' },
  { id: 'royce', name: 'Royce — Psycho on the Edge', cost: 6, ram: 2, power: 6, image: '/cards/royce.png' },
  { id: 'adam', name: 'Adam Smasher — Ender of Legends', cost: 9, ram: 2, power: 9, image: '/cards/adam.png' },
  { id: 'japantown', name: 'Japantown Ronin', cost: 2, ram: 2, power: 0, image: '/cards/japantown.png' },
  { id: 'ruthless', name: 'Ruthless Lowlife', cost: 2, ram: 1, power: 4, image: '/cards/ruthless.png' },
  { id: 'llorona', name: 'La Llorona — Ghost of the Past', cost: 3, ram: 1, power: 3, image: '/cards/llorona.png' }
];

const SUPPORT_CARDS = [
  { id: 'dexter', name: 'Dexter DeShawn — Tactical Boost', ram: 2, powerBonus: 2, image: '/cards/dexter.png', description: '+2 güç sağlar.' },
  { id: 'johnny', name: 'Johnny Silverhand — Rebel Surge', ram: 4, powerBonus: 4, image: '/cards/johnny.png', description: '+4 güç sağlar.' }
];

const mainCard = id => MAIN_CARDS.find(c => c.id === id);
const supportCard = id => SUPPORT_CARDS.find(c => c.id === id);
const roll = n => Array.from({ length: n }, () => crypto.randomInt(1, 7));
const sum = arr => arr.reduce((a, b) => a + b, 0);
const randCode = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const hash = (pass, salt) => crypto.scryptSync(pass, salt, 32).toString('hex');
const cleanName = value => String(value || '').trim().slice(0, 24);
const reply = (cb, ok, error, extra = {}) => {
  if (typeof cb === 'function') cb({ ok, ...(error ? { error } : {}), ...extra });
};

function log(room, message) {
  room.log.unshift({ id: crypto.randomUUID(), time: Date.now(), message });
  room.log = room.log.slice(0, 60);
}

function roomOf(socket) {
  const room = rooms.get(socket.data.room);
  const player = room?.players.get(socket.data.playerId);
  return player?.socketId === socket.id ? { room, player } : null;
}

function spectatorOf(socket) {
  const room = rooms.get(socket.data.room);
  const spectator = room?.spectators.get(socket.data.spectatorId);
  return spectator?.socketId === socket.id ? { room, spectator } : null;
}

function newPlayer(name) {
  return {
    id: crypto.randomUUID(),
    name,
    token: crypto.randomBytes(24).toString('hex'),
    socketId: null,
    hand: [],
    supports: [],
    rolled: false,
    budgetMax: null,
    budget: null,
    wins: 0,
    lastRoll: null
  };
}

function newSpectator(name) {
  return {
    id: crypto.randomUUID(),
    name,
    token: crypto.randomBytes(24).toString('hex'),
    socketId: null
  };
}

function attachPlayer(socket, room, player) {
  if (socket.data.room) socket.leave(socket.data.room);
  if (player.socketId && player.socketId !== socket.id) {
    io.to(player.socketId).emit('session-replaced');
    io.sockets.sockets.get(player.socketId)?.disconnect(true);
  }
  player.socketId = socket.id;
  socket.data.room = room.code;
  socket.data.playerId = player.id;
  socket.data.spectatorId = null;
  socket.join(room.code);
  broadcast(room);
}

function attachSpectator(socket, room, spectator) {
  if (socket.data.room) socket.leave(socket.data.room);
  spectator.socketId = socket.id;
  socket.data.room = room.code;
  socket.data.playerId = null;
  socket.data.spectatorId = spectator.id;
  socket.join(room.code);
  broadcast(room);
}

function view(room, player) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    role: player ? 'player' : 'spectator',
    me: player?.id || null,
    spectatorCount: room.spectators.size,
    round: room.round,
    draftTurn: room.phase === 'draft' ? room.order[room.draftIndex % 2] : null,
    draftPool: room.phase === 'draft' ? room.deck.map(mainCard) : [],
    players: room.order.map(id => {
      const p = room.players.get(id);
      return {
        id: p.id,
        name: p.name,
        online: !!p.socketId,
        selected: p.hand.length,
        budget: p.budget,
        budgetMax: p.budgetMax,
        rolled: p.rolled,
        played: !!room.pending[p.id],
        wins: p.wins,
        handCount: p.hand.length,
        score: p.wins
      };
    }),
    hand: player ? player.hand.map(mainCard) : [],
    supports: player ? player.supports.map(supportCard) : [],
    pending: player ? room.pending[player.id] || null : null,
    roundHistory: room.history,
    roll: player ? player.lastRoll : null,
    log: room.log,
    supportsAvailable: SUPPORT_CARDS.length
  };
}

function broadcast(room) {
  for (const player of room.players.values()) {
    if (player.socketId) io.to(player.socketId).emit('state', view(room, player));
  }
  for (const spectator of room.spectators.values()) {
    if (spectator.socketId) io.to(spectator.socketId).emit('state', view(room, null));
  }
}

function supportSpent(entry) {
  return entry.supportIds.reduce((total, id) => total + (supportCard(id)?.ram || 0), 0);
}

function finishRound(room) {
  const entries = room.order.map(id => room.pending[id]);
  const [a, b] = entries;
  const winner = a.totalPower === b.totalPower ? null : (a.totalPower > b.totalPower ? a.playerId : b.playerId);
  if (winner) room.players.get(winner).wins++;

  room.history.push({ round: room.round, plays: entries, winner, tie: !winner });
  log(
    room,
    `EL ${room.round}: ${entries[0].playerName} ${a.totalPower} — ${b.totalPower} ${entries[1].playerName}. ${winner ? room.players.get(winner).name + ' kazandı.' : 'Berabere.'}`
  );

  room.pending = {};
  if (room.round === 3) {
    room.phase = 'finished';
    const [p1, p2] = room.order.map(id => room.players.get(id));
    log(room, p1.wins === p2.wins ? 'Maç berabere bitti.' : `MAÇ GALİBİ: ${(p1.wins > p2.wins ? p1 : p2).name}`);
  } else {
    room.round++;
    log(room, `${room.round}. el başladı.`);
  }
}

io.on('connection', socket => {
  socket.on('create-room', (body = {}, cb) => {
    try {
      const name = cleanName(body.name);
      const password = String(body.password || '');
      if (!name || password.length < 4 || password.length > 64) return reply(cb, false, 'İsim ve en az 4 karakterli şifre gerekli.');

      let code;
      do code = randCode(); while (rooms.has(code));

      const salt = crypto.randomBytes(16).toString('hex');
      const player = newPlayer(name);
      const room = {
        code,
        salt,
        passwordHash: hash(password, salt),
        hostId: player.id,
        players: new Map([[player.id, player]]),
        spectators: new Map(),
        order: [player.id],
        phase: 'lobby',
        round: 0,
        deck: [],
        draftIndex: 0,
        pending: {},
        history: [],
        log: [],
        created: Date.now()
      };
      rooms.set(code, room);
      log(room, `${name} odayı oluşturdu.`);
      attachPlayer(socket, room, player);
      reply(cb, true, null, { code, token: player.token, playerId: player.id });
    } catch {
      reply(cb, false, 'Oda oluşturulamadı.');
    }
  });

  socket.on('join-room', (body = {}, cb) => {
    try {
      const code = String(body.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      const name = cleanName(body.name);
      const password = String(body.password || '');
      if (!room || !name) return reply(cb, false, 'Oda veya oyuncu adı bulunamadı.');
      const expected = Buffer.from(room.passwordHash, 'hex');
      const actual = Buffer.from(hash(password, room.salt), 'hex');
      if (!crypto.timingSafeEqual(expected, actual)) return reply(cb, false, 'Şifre yanlış.');
      if (room.phase !== 'lobby') return reply(cb, false, 'Maç başladı; yeni oyuncu alınmıyor.');
      if (room.players.size >= 2) return reply(cb, false, 'Bu oyun iki kişilik; oda dolu.');
      if ([...room.players.values()].some(p => p.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'))) return reply(cb, false, 'Bu isim zaten kullanılıyor.');
      const player = newPlayer(name);
      room.players.set(player.id, player);
      room.order.push(player.id);
      log(room, `${name} katıldı.`);
      attachPlayer(socket, room, player);
      reply(cb, true, null, { code, token: player.token, playerId: player.id });
    } catch {
      reply(cb, false, 'Odaya girilemedi.');
    }
  });

  socket.on('spectate-room', (body = {}, cb) => {
    try {
      const code = String(body.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      const name = cleanName(body.name) || 'İzleyici';
      const password = String(body.password || '');
      if (!room) return reply(cb, false, 'Oda bulunamadı.');
      const expected = Buffer.from(room.passwordHash, 'hex');
      const actual = Buffer.from(hash(password, room.salt), 'hex');
      if (!crypto.timingSafeEqual(expected, actual)) return reply(cb, false, 'Şifre yanlış.');
      if (room.spectators.size >= 40) return reply(cb, false, 'İzleyici limiti dolu.');
      const spectator = newSpectator(name);
      room.spectators.set(spectator.id, spectator);
      log(room, `${name} izleyici olarak katıldı.`);
      attachSpectator(socket, room, spectator);
      reply(cb, true, null, { code, token: spectator.token, spectatorId: spectator.id, role: 'spectator' });
    } catch {
      reply(cb, false, 'İzleyici girişi başarısız.');
    }
  });

  socket.on('resume-room', (body = {}, cb) => {
    const room = rooms.get(String(body.code || '').trim().toUpperCase());
    if (!room) return reply(cb, false, 'Oda bulunamadı.');

    if (body.role === 'spectator') {
      const spectator = room.spectators.get(body.spectatorId);
      if (!spectator || spectator.token !== body.token) return reply(cb, false, 'İzleyici oturumu bulunamadı.');
      attachSpectator(socket, room, spectator);
      return reply(cb, true, null, { code: room.code, token: spectator.token, spectatorId: spectator.id, role: 'spectator' });
    }

    const player = room.players.get(body.playerId);
    if (!player || typeof body.token !== 'string' || player.token !== body.token) return reply(cb, false, 'Oturum bulunamadı.');
    attachPlayer(socket, room, player);
    reply(cb, true, null, { code: room.code, token: player.token, playerId: player.id });
  });

  socket.on('start-game', (_, cb) => {
    const current = roomOf(socket);
    if (!current) return reply(cb, false, 'Odaya gir.');
    const { room, player } = current;
    if (player.id !== room.hostId || room.phase !== 'lobby' || room.players.size !== 2) return reply(cb, false, 'Sadece oda sahibi, iki oyuncu hazırken başlatabilir.');

    room.phase = 'draft';
    room.round = 0;
    room.deck = MAIN_CARDS.map(c => c.id);
    room.draftIndex = 0;
    room.pending = {};
    room.history = [];
    for (const p of room.players.values()) {
      p.hand = [];
      p.supports = SUPPORT_CARDS.map(card => card.id);
      p.rolled = false;
      p.budgetMax = null;
      p.budget = null;
      p.wins = 0;
      p.lastRoll = null;
    }
    log(room, 'Kart seçimi başladı. Ana kartlardan sırayla 3 kart seçin. Destek kartları ayrı verildi.');
    broadcast(room);
    reply(cb, true);
  });

  socket.on('pick-card', (body = {}, cb) => {
    const current = roomOf(socket);
    if (!current) return reply(cb, false, 'Odaya gir.');
    const { room, player } = current;
    if (room.phase !== 'draft') return reply(cb, false, 'Seçim aşaması değil.');
    if (room.order[room.draftIndex % 2] !== player.id) return reply(cb, false, 'Seçim sırası rakibinde.');
    if (!room.deck.includes(body.cardId)) return reply(cb, false, 'Kart artık destede yok.');

    player.hand.push(body.cardId);
    room.deck = room.deck.filter(id => id !== body.cardId);
    room.draftIndex++;
    log(room, `${player.name} ${player.hand.length}. ana kartını seçti.`);

    if (room.draftIndex === 6) {
      room.phase = 'budget';
      log(room, 'Ana kart seçimi bitti. Şimdi iki oyuncu da 3D6 bütçe zarı atmalı.');
    }

    broadcast(room);
    reply(cb, true);
  });

  socket.on('roll-budget', (_, cb) => {
    const current = roomOf(socket);
    if (!current) return reply(cb, false, 'Odaya gir.');
    const { room, player } = current;
    if (room.phase !== 'budget' || player.rolled) return reply(cb, false, 'Bütçe zarını şu anda atamazsın.');

    const dice = roll(3);
    player.rolled = true;
    player.budgetMax = sum(dice);
    player.budget = player.budgetMax;
    player.lastRoll = { kind: 'budget', dice, total: player.budget };
    log(room, `${player.name}: 3D6 (${dice.join('+')}) = ${player.budget} bütçe.`);

    if (room.order.every(id => room.players.get(id).rolled)) {
      room.phase = 'playing';
      room.round = 1;
      log(room, '1. el başladı. Kartlar gizli seçilir, sonra birlikte açılır.');
    }

    broadcast(room);
    reply(cb, true);
  });

  socket.on('play-card', (body = {}, cb) => {
    const current = roomOf(socket);
    if (!current) return reply(cb, false, 'Odaya gir.');
    const { room, player } = current;
    if (room.phase !== 'playing') return reply(cb, false, 'Oyun aşaması değil.');
    if (room.pending[player.id]) return reply(cb, false, 'Bu elde zaten kart oynadın.');

    const card = mainCard(body.cardId);
    if (!card || !player.hand.includes(card.id)) return reply(cb, false, 'Bu kart elinde yok.');
    if (card.cost > player.budget) return reply(cb, false, `Bütçe yetersiz. ${card.cost} gerekir, ${player.budget} kaldı.`);

    const dice = roll(2);
    const attackRoll = dice[0];
    const ramRoll = dice[1];
    const ramPassed = ramRoll >= card.ram;
    const bonus = ramPassed ? attackRoll : 0;
    const extraRam = ramPassed ? ramRoll - card.ram : 0;

    player.budget -= card.cost;
    player.hand = player.hand.filter(id => id !== card.id);

    const entry = {
      playerId: player.id,
      playerName: player.name,
      card,
      basePower: card.power,
      attackRoll,
      ramRoll,
      ramPassed,
      bonus,
      extraRam,
      supportIds: [],
      supportPower: 0,
      totalPower: card.power + bonus,
      costPaid: card.cost,
      ready: false
    };

    const canUseSupport = extraRam > 0 && player.supports.some(id => (supportCard(id)?.ram || 999) <= extraRam);
    if (!canUseSupport) entry.ready = true;

    room.pending[player.id] = entry;
    player.lastRoll = {
      kind: 'attack',
      dice,
      attackRoll,
      ramRoll,
      ramPassed,
      bonus,
      total: entry.totalPower,
      extraRam
    };

    log(room, `${player.name}, ${room.round}. el için kart oynadı. ${ramPassed ? `RAM başarılı, +${bonus} güç ve ${extraRam} ekstra RAM.` : 'RAM yetersiz, bonus iptal.'}`);

    if (room.order.every(id => room.pending[id]?.ready)) finishRound(room);
    broadcast(room);
    reply(cb, true);
  });

  socket.on('attach-support', (body = {}, cb) => {
    const current = roomOf(socket);
    if (!current) return reply(cb, false, 'Odaya gir.');
    const { room, player } = current;
    const entry = room.pending[player.id];
    const support = supportCard(body.cardId);
    if (room.phase !== 'playing' || !entry || !support || !player.supports.includes(support.id)) return reply(cb, false, 'Bu destek kartını oynayamazsın.');

    const spent = supportSpent(entry);
    if (spent + support.ram > entry.extraRam) return reply(cb, false, 'Fazladan RAM yetersiz.');

    entry.supportIds.push(support.id);
    entry.supportPower += support.powerBonus;
    entry.totalPower += support.powerBonus;
    player.supports = player.supports.filter(id => id !== support.id);
    log(room, `${player.name}, ${support.name} desteğini bağladı (+${support.powerBonus} güç).`);
    broadcast(room);
    reply(cb, true);
  });

  socket.on('finish-turn', (_, cb) => {
    const current = roomOf(socket);
    if (!current) return reply(cb, false, 'Odaya gir.');
    const { room, player } = current;
    const entry = room.pending[player.id];
    if (room.phase !== 'playing' || !entry || entry.ready) return reply(cb, false, 'Tamamlanacak hamle yok.');
    entry.ready = true;
    log(room, `${player.name} hamlesini kilitledi.`);

    if (room.order.every(id => room.pending[id]?.ready)) finishRound(room);
    broadcast(room);
    reply(cb, true);
  });

  socket.on('reset-game', (_, cb) => {
    const current = roomOf(socket);
    if (!current) return reply(cb, false, 'Odaya gir.');
    const { room, player } = current;
    if (player.id !== room.hostId) return reply(cb, false, 'Sadece oda sahibi sıfırlayabilir.');

    room.phase = 'lobby';
    room.round = 0;
    room.deck = [];
    room.draftIndex = 0;
    room.pending = {};
    room.history = [];
    for (const p of room.players.values()) {
      p.hand = [];
      p.supports = [];
      p.rolled = false;
      p.budgetMax = null;
      p.budget = null;
      p.wins = 0;
      p.lastRoll = null;
    }
    log(room, 'Oyun sıfırlandı.');
    broadcast(room);
    reply(cb, true);
  });

  socket.on('disconnect', () => {
    const current = roomOf(socket);
    if (current) {
      current.player.socketId = null;
      broadcast(current.room);
      return;
    }
    const watching = spectatorOf(socket);
    if (watching) {
      watching.room.spectators.delete(watching.spectator.id);
      broadcast(watching.room);
    }
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.created > 24 * 3600e3 && ![...room.players.values()].some(p => p.socketId) && room.spectators.size === 0) {
      rooms.delete(code);
    }
  }
}, 3600e3).unref();

server.listen(process.env.PORT || 3000, () => console.log('Neon Card Arena hazır.'));
