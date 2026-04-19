const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const TURN_TARGET = 8;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 4;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CLEANUP_GRACE_MS = 60000;
const AUTO_COMPLETE_DISCONNECTED_MS = 180000;

const rooms = new Map();
const queue = [];

let globalPlayerSeq = 1;
let globalResumeSeq = 1;

function now() {
  return Date.now();
}

function generatePlayerId() {
  const id = String(globalPlayerSeq++).padStart(6, '0');
  return `p_${id}`;
}

function generateResumeToken() {
  const id = String(globalResumeSeq++).padStart(6, '0');
  return `r_${id}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

function makeRoomCode() {
  let code = randomCode();
  while (rooms.has(code)) {
    code = randomCode();
  }
  return code;
}

function cleanName(raw, fallback = 'Player') {
  const s = String(raw || '').trim().slice(0, 24);
  return s || fallback;
}

function serializeRoom(room) {
  return {
    id: room.id,
    state: room.state,
    minPlayers: room.minPlayers,
    maxPlayers: room.maxPlayers,
    campaignRequiredTurns: room.campaign.requiredTurns,
    actionOrder: room.actionOrder,
    players: room.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      seat: p.seat,
      ready: p.ready,
      connected: p.connected,
      turnsCompleted: p.turnsCompleted,
      campaignComplete: p.campaignComplete
    }))
  };
}

function buildProgress(room) {
  return room.players.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    seat: p.seat,
    turnsCompleted: p.turnsCompleted,
    completed: p.campaignComplete,
    connected: p.connected
  }));
}

function publishCampaignProgress(room, reason = 'turn_complete', extra = {}) {
  broadcastRoom(room, {
    type: 'campaign_progress',
    roomId: room.id,
    order: room.actionOrder,
    reason,
    progress: buildProgress(room),
    ...extra,
    at: now()
  });
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcastRoom(room, payload) {
  room.players.forEach((player) => {
    if (player.ws && player.connected) {
      safeSend(player.ws, payload);
    }
  });
}

function sendRoomUpdate(room) {
  broadcastRoom(room, {
    type: 'room_update',
    room: serializeRoom(room),
    at: now()
  });
}

function removeFromQueueByPlayer(playerId) {
  let idx = queue.findIndex((x) => x.playerId === playerId);
  while (idx !== -1) {
    queue.splice(idx, 1);
    idx = queue.findIndex((x) => x.playerId === playerId);
  }
}

function removeFromQueueByResumeToken(resumeToken) {
  if (!resumeToken) return;
  let idx = queue.findIndex((x) => x.resumeToken === resumeToken);
  while (idx !== -1) {
    queue.splice(idx, 1);
    idx = queue.findIndex((x) => x.resumeToken === resumeToken);
  }
}

function tryCleanupRoom(room) {
  if (!room) return;
  const active = room.players.filter((p) => p.connected).length;
  if (active > 0) return;
  if ((now() - room.lastActivityAt) < ROOM_CLEANUP_GRACE_MS) return;
  rooms.delete(room.id);
}

function setSocketContext(ws, context) {
  ws._ctx = { ...(ws._ctx || {}), ...context };
}

function getSocketContext(ws) {
  return ws._ctx || {};
}

function getRoomBySocket(ws) {
  const ctx = getSocketContext(ws);
  if (!ctx.roomId) return null;
  return rooms.get(ctx.roomId) || null;
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.playerId === playerId) || null;
}

function assignSeat(room) {
  const used = new Set(room.players.map((p) => p.seat));
  for (let seat = 1; seat <= room.maxPlayers; seat++) {
    if (!used.has(seat)) return seat;
  }
  return null;
}

function createRoom(ownerWs, name, maxPlayers = MAX_PLAYERS) {
  const room = {
    id: makeRoomCode(),
    state: 'lobby',
    createdAt: now(),
    lastActivityAt: now(),
    minPlayers: MIN_PLAYERS,
    maxPlayers: Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Number(maxPlayers) || MAX_PLAYERS)),
    players: [],
    actionOrder: 0,
    campaign: {
      requiredTurns: TURN_TARGET,
      startedAt: null,
      barrierCompletedAt: null,
      electionSeed: null
    }
  };

  rooms.set(room.id, room);
  joinRoom(ownerWs, room.id, name);
  return room;
}

function tryResumeSession(ws, resumeToken, preferredName) {
  const token = String(resumeToken || '').trim();
  if (!token) {
    safeSend(ws, { type: 'resume_failed', code: 'missing_token', message: 'Missing resume token.' });
    return false;
  }

  for (const room of rooms.values()) {
    const player = room.players.find((p) => p.resumeToken === token);
    if (!player) continue;

    if (player.connected && player.ws && player.ws !== ws) {
      safeSend(ws, {
        type: 'resume_failed',
        code: 'already_connected',
        message: 'Session is already connected from another device.'
      });
      return false;
    }

    player.connected = true;
    player.ws = ws;
    player.lastSeenAt = now();
    if (preferredName) {
      player.name = cleanName(preferredName, player.name);
    }
    room.lastActivityAt = now();

    setSocketContext(ws, {
      playerId: player.playerId,
      resumeToken: player.resumeToken,
      roomId: room.id,
      seat: player.seat
    });

    safeSend(ws, {
      type: 'session_resumed',
      roomId: room.id,
      self: {
        playerId: player.playerId,
        seat: player.seat,
        resumeToken: player.resumeToken
      },
      at: now()
    });

    safeSend(ws, {
      type: 'room_joined',
      room: serializeRoom(room),
      self: {
        playerId: player.playerId,
        seat: player.seat,
        resumeToken: player.resumeToken
      },
      at: now()
    });

    sendRoomUpdate(room);
    if (room.state === 'campaign') {
      publishCampaignProgress(room, 'resume_sync');
    }
    return true;
  }

  safeSend(ws, {
    type: 'resume_failed',
    code: 'session_not_found',
    message: 'No resumable session found for this token.'
  });
  return false;
}

function joinRoom(ws, roomId, name) {
  const room = rooms.get(String(roomId || '').toUpperCase());
  if (!room) {
    safeSend(ws, { type: 'error', code: 'room_not_found', message: 'Room not found.' });
    return null;
  }

  if (room.state !== 'lobby') {
    safeSend(ws, { type: 'error', code: 'room_locked', message: 'Room already started.' });
    return null;
  }

  const ctx = getSocketContext(ws);
  const playerId = ctx.playerId;

  if (!playerId) {
    safeSend(ws, { type: 'error', code: 'no_player_id', message: 'Missing player identity.' });
    return null;
  }

  if (room.players.length >= room.maxPlayers) {
    safeSend(ws, { type: 'error', code: 'room_full', message: 'Room is full.' });
    return null;
  }

  const seat = assignSeat(room);
  if (!seat) {
    safeSend(ws, { type: 'error', code: 'seat_unavailable', message: 'No seat available.' });
    return null;
  }

  const player = {
    playerId,
    resumeToken: ctx.resumeToken,
    name: cleanName(name, `Player ${seat}`),
    seat,
    ready: false,
    connected: true,
    ws,
    turnsCompleted: 0,
    campaignComplete: false,
    joinedAt: now(),
    lastSeenAt: now()
  };

  room.players.push(player);
  room.lastActivityAt = now();

  setSocketContext(ws, { roomId: room.id, seat });

  safeSend(ws, {
    type: 'room_joined',
    room: serializeRoom(room),
    self: {
      playerId,
      seat,
      resumeToken: player.resumeToken
    },
    at: now()
  });

  sendRoomUpdate(room);
  return room;
}

function leaveRoom(ws) {
  const ctx = getSocketContext(ws);
  if (!ctx.roomId || !ctx.playerId) return;

  const room = rooms.get(ctx.roomId);
  if (!room) {
    setSocketContext(ws, { roomId: null, seat: null });
    return;
  }

  const before = room.players.length;
  room.players = room.players.filter((p) => p.playerId !== ctx.playerId);
  room.lastActivityAt = now();

  setSocketContext(ws, { roomId: null, seat: null });

  if (room.players.length === 0) {
    rooms.delete(room.id);
    return;
  }

  if (before !== room.players.length) {
    sendRoomUpdate(room);
  }
}

function allPlayersReady(room) {
  if (room.players.length < room.minPlayers) return false;
  return room.players.every((p) => p.ready);
}

function startCampaign(room) {
  if (room.state !== 'lobby') return;
  room.state = 'campaign';
  room.campaign.startedAt = now();
  room.campaign.barrierCompletedAt = null;
  room.campaign.electionSeed = null;
  room.actionOrder = 0;

  room.players.forEach((p) => {
    p.turnsCompleted = 0;
    p.campaignComplete = false;
  });

  broadcastRoom(room, {
    type: 'campaign_started',
    room: serializeRoom(room),
    at: now()
  });

  publishCampaignProgress(room, 'campaign_started');

  sendRoomUpdate(room);
}

function maybeCompleteBarrier(room) {
  if (room.state !== 'campaign') return;
  const allDone = room.players.length >= room.minPlayers && room.players.every((p) => p.campaignComplete);
  if (!allDone) return;

  room.state = 'election';
  room.campaign.barrierCompletedAt = now();
  room.campaign.electionSeed = Math.floor(Math.random() * 2147483647);

  broadcastRoom(room, {
    type: 'campaign_barrier_complete',
    roomId: room.id,
    electionSeed: room.campaign.electionSeed,
    at: now()
  });

  broadcastRoom(room, {
    type: 'election_started',
    roomId: room.id,
    electionSeed: room.campaign.electionSeed,
    at: now()
  });

  sendRoomUpdate(room);
}

function applyCampaignTurnComplete(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'campaign') {
    safeSend(ws, { type: 'error', code: 'campaign_not_active', message: 'Campaign is not active.' });
    return;
  }

  const player = findPlayer(room, ctx.playerId);
  if (!player) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }

  if (player.campaignComplete) {
    safeSend(ws, { type: 'error', code: 'already_completed', message: 'Player already completed campaign turns.' });
    return;
  }

  const requested = Number(message.turnsCompleted);
  const nextTurns = Number.isFinite(requested)
    ? Math.max(player.turnsCompleted + 1, Math.min(TURN_TARGET, Math.floor(requested)))
    : Math.min(TURN_TARGET, player.turnsCompleted + 1);

  room.actionOrder += 1;
  player.turnsCompleted = Math.min(TURN_TARGET, nextTurns);
  player.campaignComplete = player.turnsCompleted >= TURN_TARGET;
  player.lastSeenAt = now();
  room.lastActivityAt = now();

  publishCampaignProgress(room, 'turn_complete');

  sendRoomUpdate(room);
  maybeCompleteBarrier(room);
}

function applyCampaignAction(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'campaign') {
    safeSend(ws, { type: 'error', code: 'campaign_not_active', message: 'Campaign is not active.' });
    return;
  }

  const player = findPlayer(room, ctx.playerId);
  if (!player) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }
  if (player.campaignComplete) {
    safeSend(ws, { type: 'error', code: 'already_completed', message: 'Player already completed campaign turns.' });
    return;
  }

  room.actionOrder += 1;
  room.lastActivityAt = now();
  player.lastSeenAt = now();

  broadcastRoom(room, {
    type: 'action_applied',
    roomId: room.id,
    order: room.actionOrder,
    playerId: player.playerId,
    actionType: String(message.actionType || 'unknown'),
    payload: message.payload || {},
    at: now()
  });
}

function processMatchmaking() {
  const active = queue.filter((entry) => {
    if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) return false;
    return true;
  });
  queue.length = 0;
  queue.push(...active);

  if (queue.length < MIN_PLAYERS) return;

  const batchSize = Math.min(MAX_PLAYERS, queue.length);
  if (batchSize < MIN_PLAYERS) return;

  const batch = queue.splice(0, batchSize);
  const owner = batch[0];
  const room = createRoom(owner.ws, owner.name, batchSize);
  if (!room) return;

  for (let i = 1; i < batch.length; i++) {
    joinRoom(batch[i].ws, room.id, batch[i].name);
  }

  room.players.forEach((p) => {
    if (p.connected && p.ws) {
      safeSend(p.ws, {
        type: 'match_found',
        room: serializeRoom(room),
        at: now()
      });
    }
  });
}

function autoCompleteDisconnectedCampaignPlayers() {
  const ts = now();
  for (const room of rooms.values()) {
    if (room.state !== 'campaign') continue;

    let changed = false;
    for (const player of room.players) {
      if (player.campaignComplete) continue;
      if (player.connected) continue;

      const idleFor = ts - Number(player.lastSeenAt || room.campaign.startedAt || ts);
      if (idleFor < AUTO_COMPLETE_DISCONNECTED_MS) continue;

      player.turnsCompleted = TURN_TARGET;
      player.campaignComplete = true;
      player.lastSeenAt = ts;
      room.actionOrder += 1;
      changed = true;

      broadcastRoom(room, {
        type: 'campaign_player_auto_completed',
        roomId: room.id,
        order: room.actionOrder,
        playerId: player.playerId,
        name: player.name,
        reason: 'disconnected_timeout',
        at: ts
      });
    }

    if (!changed) continue;
    room.lastActivityAt = ts;
    publishCampaignProgress(room, 'auto_complete_timeout');
    sendRoomUpdate(room);
    maybeCompleteBarrier(room);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, queue: queue.length, at: now() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, message: 'Not found' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const playerId = generatePlayerId();
  const resumeToken = generateResumeToken();
  setSocketContext(ws, { playerId, resumeToken, roomId: null, seat: null });

  safeSend(ws, {
    type: 'connected',
    playerId,
    resumeToken,
    turnTarget: TURN_TARGET,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    at: now()
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw || '{}'));
    } catch (err) {
      safeSend(ws, { type: 'error', code: 'bad_json', message: 'Invalid JSON payload.' });
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    const kind = String(msg.type || '');
    const ctx = getSocketContext(ws);

    switch (kind) {
      case 'create_room': {
        leaveRoom(ws);
        removeFromQueueByPlayer(ctx.playerId);
        removeFromQueueByResumeToken(ctx.resumeToken);
        createRoom(ws, cleanName(msg.name, 'Host'), msg.maxPlayers || MAX_PLAYERS);
        break;
      }
      case 'join_room': {
        leaveRoom(ws);
        removeFromQueueByPlayer(ctx.playerId);
        removeFromQueueByResumeToken(ctx.resumeToken);
        joinRoom(ws, msg.roomId, cleanName(msg.name, 'Player'));
        break;
      }
      case 'join_matchmaking': {
        leaveRoom(ws);
        removeFromQueueByPlayer(ctx.playerId);
        removeFromQueueByResumeToken(ctx.resumeToken);
        queue.push({
          ws,
          playerId: ctx.playerId,
          resumeToken: ctx.resumeToken,
          name: cleanName(msg.name, 'Player'),
          queuedAt: now()
        });
        safeSend(ws, { type: 'matchmaking_queued', queuedAt: now() });
        processMatchmaking();
        break;
      }
      case 'resume_session': {
        const token = String(msg.resumeToken || '').trim();
        const preferredName = cleanName(msg.name || '', 'Player');
        tryResumeSession(ws, token, preferredName);
        break;
      }
      case 'leave_room': {
        leaveRoom(ws);
        break;
      }
      case 'set_ready': {
        const room = getRoomBySocket(ws);
        if (!room || room.state !== 'lobby') {
          safeSend(ws, { type: 'error', code: 'lobby_not_active', message: 'Lobby is not active.' });
          break;
        }
        const player = findPlayer(room, ctx.playerId);
        if (!player) {
          safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
          break;
        }
        player.ready = !!msg.ready;
        player.lastSeenAt = now();
        room.lastActivityAt = now();
        sendRoomUpdate(room);
        if (allPlayersReady(room)) {
          startCampaign(room);
        }
        break;
      }
      case 'campaign_turn_complete': {
        applyCampaignTurnComplete(ws, msg);
        break;
      }
      case 'campaign_action': {
        applyCampaignAction(ws, msg);
        break;
      }
      case 'heartbeat': {
        const room = getRoomBySocket(ws);
        if (room) {
          const player = findPlayer(room, ctx.playerId);
          if (player) {
            player.lastSeenAt = now();
            player.connected = true;
            room.lastActivityAt = now();
          }
        }
        safeSend(ws, { type: 'heartbeat_ack', at: now() });
        break;
      }
      default:
        safeSend(ws, { type: 'error', code: 'unknown_type', message: `Unknown message type: ${kind}` });
        break;
    }
  });

  ws.on('close', () => {
    const ctx = getSocketContext(ws);
    removeFromQueueByPlayer(ctx.playerId);
    removeFromQueueByResumeToken(ctx.resumeToken);

    const room = getRoomBySocket(ws);
    if (room) {
      const player = findPlayer(room, ctx.playerId);
      if (player) {
        player.connected = false;
        player.ws = null;
        player.lastSeenAt = now();
        room.lastActivityAt = now();
        sendRoomUpdate(room);
      }
      setTimeout(() => tryCleanupRoom(room), ROOM_CLEANUP_GRACE_MS + 5000);
    }
  });
});

setInterval(() => {
  autoCompleteDisconnectedCampaignPlayers();
}, 10000);

server.listen(PORT, () => {
  console.log(`[multiplayer] listening on :${PORT}`);
});
