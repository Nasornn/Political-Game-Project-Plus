const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const TURN_TARGET = 8;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CLEANUP_GRACE_MS = 60000;
const AUTO_COMPLETE_DISCONNECTED_MS = 180000;
const CHAT_HISTORY_LIMIT = 120;

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
  const pendingOffers = (((room.coalition || {}).offers) || [])
    .filter((offer) => offer.status === 'pending')
    .map((offer) => ({
      offerId: offer.offerId,
      fromPlayerId: offer.fromPlayerId,
      targetPlayerId: offer.targetPlayerId,
      targetPartyId: offer.targetPartyId || null,
      offeredMinistries: offer.offeredMinistries || 0,
      status: offer.status,
      createdAt: offer.createdAt,
      respondedAt: offer.respondedAt || null
    }));

  return {
    id: room.id,
    state: room.state,
    ownerPlayerId: room.ownerPlayerId || null,
    minPlayers: room.minPlayers,
    maxPlayers: room.maxPlayers,
    campaignRequiredTurns: room.campaign.requiredTurns,
    actionOrder: room.actionOrder,
    partySelections: room.players
      .filter((p) => !!p.selectedPartyId)
      .map((p) => ({
        playerId: p.playerId,
        seat: p.seat,
        name: p.name,
        partyId: p.selectedPartyId,
        partyName: p.selectedPartyName || p.selectedPartyId
      })),
    chat: Array.isArray(room.chat) ? room.chat.slice(-40) : [],
    coalition: {
      pendingOffers
    },
    parliament: {
      sharedBillUsageBySession: ((room.parliament || {}).sharedBillUsageBySession) || {}
    },
    players: room.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      seat: p.seat,
      ready: p.ready,
      connected: p.connected,
      role: p.role || null,
      selectedPartyId: p.selectedPartyId || null,
      selectedPartyName: p.selectedPartyName || null,
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
  const ownerCtx = getSocketContext(ownerWs);
  const room = {
    id: makeRoomCode(),
    state: 'lobby',
    ownerPlayerId: ownerCtx.playerId || null,
    createdAt: now(),
    lastActivityAt: now(),
    minPlayers: MIN_PLAYERS,
    maxPlayers: Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Number(maxPlayers) || MAX_PLAYERS)),
    players: [],
    actionOrder: 0,
    chat: [],
    coalition: {
      offerSeq: 1,
      offers: []
    },
    parliament: {
      sharedBillUsageBySession: {},
      billKeysBySession: {}
    },
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
    role: null,
    selectedPartyId: null,
    selectedPartyName: null,
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

  if (!room.players.find((p) => p.playerId === room.ownerPlayerId)) {
    room.ownerPlayerId = room.players[0].playerId;
  }

  if (before !== room.players.length) {
    sendRoomUpdate(room);
  }
}

function allPlayersReady(room) {
  if (room.players.length < room.minPlayers) return false;
  return room.players.every((p) => p.ready);
}

function allPlayersSelected(room) {
  if (room.players.length < room.minPlayers) return false;
  return room.players.every((p) => !!p.selectedPartyId);
}

function sanitizePartyId(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (!/^[a-z0-9_-]{2,48}$/.test(value)) return null;
  return value;
}

function startPartySelection(room) {
  if (room.state !== 'lobby') return;
  room.state = 'party_selection';
  room.lastActivityAt = now();
  room.players.forEach((p) => {
    p.selectedPartyId = null;
    p.selectedPartyName = null;
  });

  broadcastRoom(room, {
    type: 'party_selection_started',
    room: serializeRoom(room),
    at: now()
  });

  sendRoomUpdate(room);
}

function startCampaign(room) {
  if (room.state !== 'party_selection') return;
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

  room.state = 'coalition';
  room.campaign.barrierCompletedAt = now();
  room.campaign.electionSeed = Math.floor(Math.random() * 2147483647);

  broadcastRoom(room, {
    type: 'campaign_barrier_complete',
    roomId: room.id,
    electionSeed: room.campaign.electionSeed,
    at: now()
  });

  broadcastRoom(room, {
    type: 'coalition_started',
    room: serializeRoom(room),
    at: now()
  });

  sendRoomUpdate(room);
}

function applyPartySelection(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'party_selection') {
    safeSend(ws, { type: 'error', code: 'party_selection_not_active', message: 'Party selection is not active.' });
    return;
  }

  const player = findPlayer(room, ctx.playerId);
  if (!player) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }

  const partyId = sanitizePartyId(message.partyId);
  if (!partyId) {
    safeSend(ws, { type: 'error', code: 'invalid_party_id', message: 'Invalid party id.' });
    return;
  }

  const alreadyTaken = room.players.find((p) => p.playerId !== player.playerId && p.selectedPartyId === partyId);
  if (alreadyTaken) {
    safeSend(ws, {
      type: 'error',
      code: 'party_taken',
      message: `${alreadyTaken.name} already selected this party.`
    });
    return;
  }

  player.selectedPartyId = partyId;
  player.selectedPartyName = cleanName(message.partyName || partyId, partyId);
  player.lastSeenAt = now();
  room.lastActivityAt = now();

  broadcastRoom(room, {
    type: 'party_selection_update',
    roomId: room.id,
    playerId: player.playerId,
    partyId: player.selectedPartyId,
    partyName: player.selectedPartyName,
    room: serializeRoom(room),
    at: now()
  });

  sendRoomUpdate(room);

  if (allPlayersSelected(room)) {
    startCampaign(room);
  }
}

function appendChatMessage(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room) {
    safeSend(ws, { type: 'error', code: 'room_not_found', message: 'You are not in a room.' });
    return;
  }

  const player = findPlayer(room, ctx.playerId);
  if (!player) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }

  const text = String(message.text || '').trim();
  if (!text) return;
  const clipped = text.slice(0, 280);
  const channel = String(message.channel || room.state || 'global').slice(0, 32);

  const entry = {
    id: `chat_${now()}_${Math.floor(Math.random() * 1e6)}`,
    roomId: room.id,
    playerId: player.playerId,
    seat: player.seat,
    name: player.name,
    text: clipped,
    channel,
    at: now()
  };

  room.chat.push(entry);
  if (room.chat.length > CHAT_HISTORY_LIMIT) {
    room.chat = room.chat.slice(-CHAT_HISTORY_LIMIT);
  }
  room.lastActivityAt = now();
  player.lastSeenAt = now();

  broadcastRoom(room, {
    type: 'chat_message',
    roomId: room.id,
    message: entry,
    at: now()
  });
}

function createCoalitionOffer(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'coalition') {
    safeSend(ws, { type: 'error', code: 'coalition_not_active', message: 'Coalition phase is not active.' });
    return;
  }

  const fromPlayer = findPlayer(room, ctx.playerId);
  if (!fromPlayer) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }

  const targetPlayerId = String(message.targetPlayerId || '').trim();
  const targetPlayer = findPlayer(room, targetPlayerId);
  if (!targetPlayer || targetPlayer.playerId === fromPlayer.playerId) {
    safeSend(ws, { type: 'error', code: 'invalid_target', message: 'Invalid coalition target.' });
    return;
  }

  const existingPending = (room.coalition.offers || []).find((offer) =>
    offer.status === 'pending' &&
    offer.fromPlayerId === fromPlayer.playerId &&
    offer.targetPlayerId === targetPlayer.playerId
  );
  if (existingPending) {
    safeSend(ws, { type: 'error', code: 'offer_pending', message: 'A pending offer already exists for this player.' });
    return;
  }

  const offer = {
    offerId: `off_${String(room.coalition.offerSeq++).padStart(5, '0')}`,
    fromPlayerId: fromPlayer.playerId,
    targetPlayerId: targetPlayer.playerId,
    targetPartyId: String(message.targetPartyId || targetPlayer.selectedPartyId || '').trim() || null,
    offeredMinistries: Math.max(0, Math.min(8, Math.floor(Number(message.offeredMinistries) || 0))),
    status: 'pending',
    createdAt: now(),
    respondedAt: null
  };

  room.coalition.offers.push(offer);
  room.lastActivityAt = now();

  broadcastRoom(room, {
    type: 'coalition_offer_pending',
    roomId: room.id,
    offer,
    at: now()
  });
  sendRoomUpdate(room);
}

function respondCoalitionOffer(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'coalition') {
    safeSend(ws, { type: 'error', code: 'coalition_not_active', message: 'Coalition phase is not active.' });
    return;
  }

  const offerId = String(message.offerId || '').trim();
  const offer = (room.coalition.offers || []).find((row) => row.offerId === offerId && row.status === 'pending');
  if (!offer) {
    safeSend(ws, { type: 'error', code: 'offer_not_found', message: 'Offer was not found or already resolved.' });
    return;
  }

  if (offer.targetPlayerId !== ctx.playerId) {
    safeSend(ws, { type: 'error', code: 'offer_not_yours', message: 'Only the target player can respond to this offer.' });
    return;
  }

  const accepted = !!message.accept;
  offer.status = accepted ? 'accepted' : 'rejected';
  offer.respondedAt = now();
  room.lastActivityAt = now();

  broadcastRoom(room, {
    type: 'coalition_offer_resolved',
    roomId: room.id,
    offerId: offer.offerId,
    accepted,
    offer,
    at: now()
  });
  sendRoomUpdate(room);
}

function publishSharedGovernmentBillUsage(room, sessionNumber, extra = {}) {
  const sessionKey = String(Math.max(1, Math.floor(Number(sessionNumber) || 1)));
  const used = Number((room.parliament.sharedBillUsageBySession || {})[sessionKey] || 0);
  broadcastRoom(room, {
    type: 'government_bill_shared_update',
    roomId: room.id,
    sessionNumber: Number(sessionKey),
    used,
    ...extra,
    at: now()
  });
}

function syncParliamentRole(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room) {
    safeSend(ws, { type: 'error', code: 'room_not_found', message: 'You are not in a room.' });
    return;
  }

  const player = findPlayer(room, ctx.playerId);
  if (!player) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }

  player.role = (message.role === 'government') ? 'government' : 'opposition';
  player.parliamentSessionNumber = Math.max(1, Math.floor(Number(message.sessionNumber) || 1));
  player.lastSeenAt = now();
  room.lastActivityAt = now();
  if (room.state !== 'parliament') {
    room.state = 'parliament';
  }

  publishSharedGovernmentBillUsage(room, player.parliamentSessionNumber, {
    byPlayerId: player.playerId,
    reason: 'session_sync'
  });
  sendRoomUpdate(room);
}

function reportSharedGovernmentBillPassed(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room) {
    safeSend(ws, { type: 'error', code: 'room_not_found', message: 'You are not in a room.' });
    return;
  }

  const player = findPlayer(room, ctx.playerId);
  if (!player) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }

  if (player.role !== 'government') {
    safeSend(ws, { type: 'error', code: 'role_not_allowed', message: 'Only governing players can report passed bills.' });
    return;
  }

  const sessionKey = String(Math.max(1, Math.floor(Number(message.sessionNumber) || player.parliamentSessionNumber || 1)));
  const billName = String(message.billName || '').trim().slice(0, 80) || 'unknown_bill';

  if (!room.parliament.billKeysBySession[sessionKey]) {
    room.parliament.billKeysBySession[sessionKey] = {};
  }
  if (!room.parliament.sharedBillUsageBySession[sessionKey]) {
    room.parliament.sharedBillUsageBySession[sessionKey] = 0;
  }

  const billKey = `${player.playerId}::${billName}`;
  if (room.parliament.billKeysBySession[sessionKey][billKey]) {
    publishSharedGovernmentBillUsage(room, Number(sessionKey), {
      byPlayerId: player.playerId,
      billName,
      reason: 'duplicate_ignored'
    });
    return;
  }

  room.parliament.billKeysBySession[sessionKey][billKey] = true;
  room.parliament.sharedBillUsageBySession[sessionKey] += 1;
  room.actionOrder += 1;
  player.lastSeenAt = now();
  room.lastActivityAt = now();

  publishSharedGovernmentBillUsage(room, Number(sessionKey), {
    byPlayerId: player.playerId,
    billName,
    order: room.actionOrder,
    reason: 'government_bill_passed'
  });
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
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      queue: queue.length,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      at: now()
    }));
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
        break;
      }
      case 'start_match': {
        const room = getRoomBySocket(ws);
        if (!room || room.state !== 'lobby') {
          safeSend(ws, { type: 'error', code: 'lobby_not_active', message: 'Lobby is not active.' });
          break;
        }

        const owner = room.ownerPlayerId ? findPlayer(room, room.ownerPlayerId) : null;
        const ownerAvailable = !!(owner && owner.connected);
        if (!ctx.playerId || (room.ownerPlayerId !== ctx.playerId && ownerAvailable)) {
          safeSend(ws, { type: 'error', code: 'not_room_owner', message: 'Only host can start the match.' });
          break;
        }

        if (!ownerAvailable && room.ownerPlayerId !== ctx.playerId) {
          room.ownerPlayerId = ctx.playerId;
        }

        if (!allPlayersReady(room)) {
          safeSend(ws, { type: 'error', code: 'not_all_ready', message: 'All players must be ready before starting.' });
          break;
        }

        startPartySelection(room);
        break;
      }
      case 'select_party': {
        applyPartySelection(ws, msg);
        break;
      }
      case 'chat_send': {
        appendChatMessage(ws, msg);
        break;
      }
      case 'coalition_offer_create': {
        createCoalitionOffer(ws, msg);
        break;
      }
      case 'coalition_offer_response': {
        respondCoalitionOffer(ws, msg);
        break;
      }
      case 'sync_parliament_role': {
        syncParliamentRole(ws, msg);
        break;
      }
      case 'government_bill_passed': {
        reportSharedGovernmentBillPassed(ws, msg);
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
