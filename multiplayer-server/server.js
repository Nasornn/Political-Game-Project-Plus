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
const CAMPAIGN_EMERGENT_PARTY_BASE_CHANCE = 0.14;
const CAMPAIGN_EMERGENT_PARTY_MAX = 4;
const CAMPAIGN_EMERGENT_PARTY_MIN_TURN = 3;
const CAMPAIGN_ACTION_EMERGENT_PARTY_TYPE = 'campaign_emergent_party_spawned';
const CAMPAIGN_ACTION_PAYLOAD_MAX_BYTES = 4096;
const PARLIAMENT_PATCH_MAX_BYTES = 65536;
const GOVERNMENT_BILL_QUEUE_LIMIT = 24;

const CAMPAIGN_EMERGENT_DIFFICULTY_CHANCE = {
  easy: 0.09,
  medium: 0.14,
  hard: 0.2
};

const CAMPAIGN_EMERGENT_SCENARIO_BONUS = {
  realistic: 0,
  balanced: 0.02,
  custom: 0
};

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

function clampNumber(value, minValue, maxValue, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < minValue) return minValue;
  if (n > maxValue) return maxValue;
  return n;
}

function normalizeDifficultyMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'easy' || value === 'hard') return value;
  return 'medium';
}

function normalizeScenarioMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'balanced' || value === 'custom') return value;
  return 'realistic';
}

function sanitizeRoomConfig(rawConfig) {
  const config = (rawConfig && typeof rawConfig === 'object') ? rawConfig : {};
  const difficultyMode = normalizeDifficultyMode(config.difficultyMode);
  const scenarioMode = normalizeScenarioMode(config.scenarioMode);
  const customChanceRaw = Number(config.emergentPartyChance);
  const emergentPartyChance = Number.isFinite(customChanceRaw)
    ? Math.max(0, Math.min(0.8, customChanceRaw))
    : null;

  return {
    difficultyMode,
    scenarioMode,
    emergentPartyChance
  };
}

function getCampaignEmergentPartyChance(room) {
  const config = sanitizeRoomConfig((room && room.config) || {});
  if (Number.isFinite(config.emergentPartyChance)) {
    return Math.max(0, Math.min(0.8, config.emergentPartyChance));
  }

  const difficultyChance = CAMPAIGN_EMERGENT_DIFFICULTY_CHANCE[config.difficultyMode] || CAMPAIGN_EMERGENT_PARTY_BASE_CHANCE;
  const scenarioBonus = CAMPAIGN_EMERGENT_SCENARIO_BONUS[config.scenarioMode] || 0;
  return Math.max(0.02, Math.min(0.8, difficultyChance + scenarioBonus));
}

function ensureParliamentState(room) {
  if (!room || !room.parliament || typeof room.parliament !== 'object') {
    if (room) room.parliament = {};
    else return;
  }
  if (!room.parliament.sharedBillUsageBySession || typeof room.parliament.sharedBillUsageBySession !== 'object') {
    room.parliament.sharedBillUsageBySession = {};
  }
  if (!room.parliament.billKeysBySession || typeof room.parliament.billKeysBySession !== 'object') {
    room.parliament.billKeysBySession = {};
  }
  if (!Array.isArray(room.parliament.pendingGovernmentBills)) {
    room.parliament.pendingGovernmentBills = [];
  }
  if (!room.parliament.termCompletionByPlayerId || typeof room.parliament.termCompletionByPlayerId !== 'object') {
    room.parliament.termCompletionByPlayerId = {};
  }
  if (!Number.isFinite(room.parliament.billSeq) || room.parliament.billSeq < 1) {
    room.parliament.billSeq = 1;
  }
}

function resetParliamentRuntimeState(room) {
  ensureParliamentState(room);
  room.parliament.sharedBillUsageBySession = {};
  room.parliament.billKeysBySession = {};
  room.parliament.pendingGovernmentBills = [];
  room.parliament.termCompletionByPlayerId = {};
  room.parliament.billSeq = 1;

  room.players.forEach((player) => {
    player.parliamentComplete = false;
    player.parliamentSessionNumber = 1;
    room.parliament.termCompletionByPlayerId[player.playerId] = false;
  });
}

function sanitizeRegionalPopularityMap(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    const region = String(key || '').trim().slice(0, 48);
    if (!region) continue;
    const delta = Number(value);
    if (!Number.isFinite(delta)) continue;
    out[region] = Math.round(clampNumber(delta, -20, 20));
    if (Object.keys(out).length >= 64) break;
  }
  return out;
}

function sanitizeGovernmentBillPayload(rawBill, fallbackId) {
  const bill = (rawBill && typeof rawBill === 'object') ? rawBill : {};
  const effects = (bill.effects && typeof bill.effects === 'object') ? bill.effects : {};
  const providedId = String(bill.id || '').trim().slice(0, 72);

  return {
    id: providedId || fallbackId,
    name: String(bill.name || 'Government Bill').trim().slice(0, 80) || 'Government Bill',
    description: String(bill.description || '').trim().slice(0, 420),
    capitalCost: Math.max(0, Math.floor(Number(bill.capitalCost) || 0)),
    effects: {
      popularityChanges: sanitizeRegionalPopularityMap(effects.popularityChanges || {}),
      capitalReward: Math.round(clampNumber(effects.capitalReward || 0, -500, 500)),
      scandalChange: Math.round(clampNumber(effects.scandalChange || 0, -50, 50))
    }
  };
}

function sanitizeGovernmentBillResolutionResult(input) {
  const result = (input && typeof input === 'object') ? input : {};
  const summary = Array.isArray(result.disruptionApplied)
    ? result.disruptionApplied
      .map((x) => String(x || '').trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 6)
    : [];

  return {
    billName: String(result.billName || '').trim().slice(0, 80) || 'Government Bill',
    stance: (result.stance === 'support' || result.stance === 'abstain') ? result.stance : 'oppose',
    aye: Math.max(0, Math.floor(Number(result.aye) || 0)),
    nay: Math.max(0, Math.floor(Number(result.nay) || 0)),
    abstain: Math.max(0, Math.floor(Number(result.abstain) || 0)),
    passed: !!result.passed,
    popNet: Number.isFinite(Number(result.popNet)) ? Number(result.popNet) : 0,
    disruptionApplied: summary
  };
}

function sanitizeParliamentPatch(input) {
  if (!input || typeof input !== 'object') return null;
  let raw;
  try {
    raw = JSON.stringify(input);
  } catch (err) {
    return null;
  }

  if (!raw || raw.length > PARLIAMENT_PATCH_MAX_BYTES) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function serializeRoom(room) {
  const coalitionState = room.coalition || {};
  ensureParliamentState(room);
  const pendingOffers = (((room.coalition || {}).offers) || [])
    .filter((offer) => offer.status === 'pending')
    .map((offer) => ({
      offerId: offer.offerId,
      fromPlayerId: offer.fromPlayerId,
      fromPartyId: offer.fromPartyId || null,
      fromPartyName: offer.fromPartyName || null,
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
    config: sanitizeRoomConfig(room.config || {}),
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
      pendingOffers,
      order: Array.isArray(coalitionState.order) ? coalitionState.order.slice() : [],
      turnIndex: Number.isFinite(coalitionState.turnIndex) ? coalitionState.turnIndex : 0,
      attempt: Number.isFinite(coalitionState.attempt) ? coalitionState.attempt : 1,
      currentFormateurPartyId: coalitionState.currentFormateurPartyId || null,
      coalitionPartyIds: Array.isArray(coalitionState.coalitionPartyIds) ? coalitionState.coalitionPartyIds.slice() : [],
      governmentPartyId: coalitionState.governmentPartyId || null
    },
    election: {
      seed: ((room.election || {}).seed) || null,
      hasResults: !!((room.election || {}).results),
      lockedAt: ((room.election || {}).lockedAt) || null,
      resultsByPlayerId: ((room.election || {}).resultsByPlayerId) || null
    },
    parliament: {
      sharedBillUsageBySession: ((room.parliament || {}).sharedBillUsageBySession) || {},
      pendingGovernmentBills: (((room.parliament || {}).pendingGovernmentBills) || []).map((bill) => ({
        id: bill.id,
        name: bill.name,
        description: bill.description,
        capitalCost: bill.capitalCost,
        effects: bill.effects || {},
        fromPlayerId: bill.fromPlayerId || null,
        fromPartyId: bill.fromPartyId || null,
        sessionNumber: Number.isFinite(Number(bill.sessionNumber)) ? Number(bill.sessionNumber) : 1,
        proposedAt: Number.isFinite(Number(bill.proposedAt)) ? Number(bill.proposedAt) : null
      })),
      termCompletionByPlayerId: ((room.parliament || {}).termCompletionByPlayerId) || {}
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
      campaignComplete: p.campaignComplete,
      parliamentComplete: !!p.parliamentComplete
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

function buildParliamentProgress(room) {
  return room.players.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    seat: p.seat,
    completed: !!p.parliamentComplete,
    connected: p.connected,
    role: p.role || null,
    sessionNumber: Math.max(1, Math.floor(Number(p.parliamentSessionNumber) || 1))
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

function publishParliamentProgress(room, reason = 'term_progress', extra = {}) {
  broadcastRoom(room, {
    type: 'parliament_progress',
    roomId: room.id,
    order: room.actionOrder,
    reason,
    progress: buildParliamentProgress(room),
    ...extra,
    at: now()
  });
}

function ensureCampaignEmergentState(room) {
  if (!room || !room.campaign || typeof room.campaign !== 'object') return;
  if (!room.campaign.emergentParty || typeof room.campaign.emergentParty !== 'object') {
    room.campaign.emergentParty = {};
  }
  if (!Number.isFinite(room.campaign.emergentParty.count) || room.campaign.emergentParty.count < 0) {
    room.campaign.emergentParty.count = 0;
  }
  if (!room.campaign.emergentParty.triggeredTurns || typeof room.campaign.emergentParty.triggeredTurns !== 'object') {
    room.campaign.emergentParty.triggeredTurns = {};
  }
}

function createCampaignEmergentPartyPayload(room, turnNumber) {
  ensureCampaignEmergentState(room);
  const emergent = room.campaign.emergentParty;
  const sequence = Math.max(1, Math.floor(Number(emergent.count) || 0) + 1);
  const safeTurn = Math.max(1, Math.floor(Number(turnNumber) || 1));
  const seed = Math.floor(Math.random() * 2147483647);
  const roomToken = String(room.id || 'room').toLowerCase();
  const partyId = `emergent_${roomToken}_${String(safeTurn).padStart(2, '0')}_${String(sequence).padStart(2, '0')}`;
  return {
    eventId: `${partyId}_${seed}`,
    partyId,
    seed,
    turnNumber: safeTurn,
    sequence
  };
}

function maybeTriggerCampaignEmergentParty(room, turnNumber, byPlayerId = null) {
  if (!room || room.state !== 'campaign') return false;
  ensureCampaignEmergentState(room);

  const emergent = room.campaign.emergentParty;
  const safeTurn = Math.max(1, Math.floor(Number(turnNumber) || 0));
  if (!safeTurn || safeTurn < CAMPAIGN_EMERGENT_PARTY_MIN_TURN) return false;
  if ((Number(emergent.count) || 0) >= CAMPAIGN_EMERGENT_PARTY_MAX) return false;

  const turnKey = String(safeTurn);
  if (emergent.triggeredTurns[turnKey]) return false;
  emergent.triggeredTurns[turnKey] = true;

  const chance = getCampaignEmergentPartyChance(room);

  if (Math.random() > chance) {
    return false;
  }

  const payload = createCampaignEmergentPartyPayload(room, safeTurn);
  emergent.count = Math.max(0, Math.floor(Number(emergent.count) || 0)) + 1;
  room.actionOrder += 1;
  room.lastActivityAt = now();

  broadcastRoom(room, {
    type: 'action_applied',
    roomId: room.id,
    order: room.actionOrder,
    playerId: byPlayerId || null,
    actionType: CAMPAIGN_ACTION_EMERGENT_PARTY_TYPE,
    payload,
    chance,
    at: now()
  });

  return true;
}

function sanitizeCampaignActionPayload(input) {
  if (!input || typeof input !== 'object') return {};
  let raw;
  try {
    raw = JSON.stringify(input);
  } catch (err) {
    return {};
  }
  if (!raw || raw.length > CAMPAIGN_ACTION_PAYLOAD_MAX_BYTES) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
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
    config: sanitizeRoomConfig(),
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
      offers: [],
      order: [],
      turnIndex: 0,
      attempt: 1,
      currentFormateurPartyId: null,
      proposedPartyIds: [],
      invitedPartyIds: [],
      coalitionPartyIds: [],
      governmentPartyId: null
    },
    parliament: {
      sharedBillUsageBySession: {},
      billKeysBySession: {},
      pendingGovernmentBills: [],
      termCompletionByPlayerId: {},
      billSeq: 1
    },
    campaign: {
      requiredTurns: TURN_TARGET,
      startedAt: null,
      barrierCompletedAt: null,
      electionSeed: null,
      emergentParty: {
        count: 0,
        triggeredTurns: {}
      }
    },
    election: {
      seed: null,
      results: null,
      resultsByPlayerId: null,
      lockedAt: null
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

    if (room.election && room.election.results) {
      safeSend(ws, {
        type: 'election_results_locked',
        roomId: room.id,
        byPlayerId: room.election.resultsByPlayerId || null,
        lockedAt: room.election.lockedAt || null,
        electionSeed: room.election.seed || null,
        results: room.election.results,
        at: now()
      });
    }

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
    parliamentComplete: false,
    parliamentSessionNumber: 1,
    joinedAt: now(),
    lastSeenAt: now()
  };

  room.players.push(player);
  ensureParliamentState(room);
  room.parliament.termCompletionByPlayerId[player.playerId] = false;
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

  if (room.election && room.election.results) {
    safeSend(ws, {
      type: 'election_results_locked',
      roomId: room.id,
      byPlayerId: room.election.resultsByPlayerId || null,
      lockedAt: room.election.lockedAt || null,
      electionSeed: room.election.seed || null,
      results: room.election.results,
      at: now()
    });
  }

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
  ensureParliamentState(room);
  delete room.parliament.termCompletionByPlayerId[ctx.playerId];
  room.parliament.pendingGovernmentBills = (room.parliament.pendingGovernmentBills || []).filter((bill) => bill.fromPlayerId !== ctx.playerId);
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

function uniquePartyIds(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const partyId = String(raw || '').trim();
    if (!partyId || seen.has(partyId)) continue;
    seen.add(partyId);
    out.push(partyId);
  }
  return out;
}

function getElectionSeatTotals(room) {
  return (((room.election || {}).results || {}).totalSeats) || {};
}

function getSortedCoalitionPartyOrder(room) {
  const totals = getElectionSeatTotals(room);
  return Object.keys(totals)
    .filter((partyId) => Number(totals[partyId] || 0) > 0)
    .sort((a, b) => {
      const delta = Number(totals[b] || 0) - Number(totals[a] || 0);
      if (delta !== 0) return delta;
      return String(a).localeCompare(String(b));
    });
}

function getCoalitionSeatTotal(room, partyIds) {
  const totals = getElectionSeatTotals(room);
  let seats = 0;
  for (const partyId of uniquePartyIds(partyIds)) {
    seats += Math.max(0, Math.floor(Number(totals[partyId] || 0)));
  }
  return seats;
}

function getGovernmentBillSessionCapFromRoom(room) {
  ensureCoalitionState(room);
  const coalitionSeats = getCoalitionSeatTotal(room, room.coalition.coalitionPartyIds || []);
  if (coalitionSeats >= 340) return 3;
  if (coalitionSeats >= 251) return 2;
  return 1;
}

function findPlayerByPartyId(room, partyId) {
  const value = String(partyId || '').trim();
  if (!value) return null;
  return room.players.find((p) => String(p.selectedPartyId || '') === value) || null;
}

function ensureCoalitionState(room) {
  if (!room.coalition || typeof room.coalition !== 'object') {
    room.coalition = {};
  }
  if (!Number.isFinite(room.coalition.offerSeq) || room.coalition.offerSeq < 1) {
    room.coalition.offerSeq = 1;
  }
  if (!Array.isArray(room.coalition.offers)) room.coalition.offers = [];
  if (!Array.isArray(room.coalition.order)) room.coalition.order = [];
  room.coalition.turnIndex = Math.max(0, Math.floor(Number(room.coalition.turnIndex) || 0));
  room.coalition.attempt = Math.max(1, Math.floor(Number(room.coalition.attempt) || 1));
  room.coalition.currentFormateurPartyId = room.coalition.currentFormateurPartyId || null;
  room.coalition.proposedPartyIds = uniquePartyIds(room.coalition.proposedPartyIds);
  room.coalition.invitedPartyIds = uniquePartyIds(room.coalition.invitedPartyIds);
  room.coalition.coalitionPartyIds = uniquePartyIds(room.coalition.coalitionPartyIds);
  room.coalition.governmentPartyId = room.coalition.governmentPartyId || null;
}

function getCurrentCoalitionFormateurPartyId(room) {
  ensureCoalitionState(room);
  if (room.coalition.currentFormateurPartyId) {
    return room.coalition.currentFormateurPartyId;
  }
  const idx = Math.max(0, Math.floor(Number(room.coalition.turnIndex) || 0));
  const partyId = (room.coalition.order || [])[idx] || null;
  room.coalition.currentFormateurPartyId = partyId;
  return partyId;
}

function resetCoalitionMandate(room, formateurPartyId, attempt = 1) {
  ensureCoalitionState(room);
  const partyId = String(formateurPartyId || '').trim();
  room.coalition.currentFormateurPartyId = partyId || null;
  room.coalition.attempt = Math.max(1, Math.floor(Number(attempt) || 1));
  room.coalition.proposedPartyIds = partyId ? [partyId] : [];
  room.coalition.invitedPartyIds = [];
  room.coalition.coalitionPartyIds = partyId ? [partyId] : [];
}

function initializeCoalitionFromElection(room) {
  ensureCoalitionState(room);
  const order = getSortedCoalitionPartyOrder(room);
  room.coalition.offerSeq = 1;
  room.coalition.offers = [];
  room.coalition.order = order;
  room.coalition.turnIndex = 0;
  room.coalition.governmentPartyId = null;
  const firstFormateur = order[0] || null;
  resetCoalitionMandate(room, firstFormateur, 1);
  room.players.forEach((player) => {
    player.role = null;
  });
}

function makeCoalitionOffer(room, input = {}) {
  ensureCoalitionState(room);
  const offer = {
    offerId: `off_${String(room.coalition.offerSeq++).padStart(5, '0')}`,
    fromPlayerId: String(input.fromPlayerId || '').trim() || null,
    fromPartyId: String(input.fromPartyId || '').trim() || null,
    fromPartyName: String(input.fromPartyName || '').trim() || null,
    targetPlayerId: String(input.targetPlayerId || '').trim() || null,
    targetPartyId: String(input.targetPartyId || '').trim() || null,
    offeredMinistries: Math.max(0, Math.min(8, Math.floor(Number(input.offeredMinistries) || 0))),
    status: 'pending',
    createdAt: now(),
    respondedAt: null
  };
  room.coalition.offers.push(offer);
  return offer;
}

function finalizeCoalitionGovernment(room, governmentPartyId, coalitionPartyIds) {
  ensureCoalitionState(room);
  ensureParliamentState(room);

  const coalition = uniquePartyIds(coalitionPartyIds);
  const governingPartyId = String(governmentPartyId || coalition[0] || '').trim() || null;
  const normalizedCoalition = governingPartyId
    ? uniquePartyIds([governingPartyId, ...coalition])
    : coalition;

  room.coalition.governmentPartyId = governingPartyId;
  room.coalition.currentFormateurPartyId = governingPartyId;
  room.coalition.proposedPartyIds = normalizedCoalition.slice();
  room.coalition.coalitionPartyIds = normalizedCoalition.slice();

  room.players.forEach((player) => {
    const partyId = String(player.selectedPartyId || '').trim();
    player.role = (partyId && normalizedCoalition.includes(partyId)) ? 'government' : 'opposition';
    player.parliamentComplete = false;
    player.parliamentSessionNumber = 1;
    room.parliament.termCompletionByPlayerId[player.playerId] = false;
  });

  room.parliament.sharedBillUsageBySession = {};
  room.parliament.billKeysBySession = {};
  room.parliament.pendingGovernmentBills = [];
  room.parliament.billSeq = 1;

  room.state = 'parliament';
  room.lastActivityAt = now();
  room.actionOrder += 1;
  publishParliamentProgress(room, 'parliament_started', { order: room.actionOrder });
  sendRoomUpdate(room);
}

function advanceCoalitionMandate(room) {
  ensureCoalitionState(room);
  const nextTurnIndex = Math.max(0, Math.floor(Number(room.coalition.turnIndex) || 0)) + 1;

  if (nextTurnIndex >= room.coalition.order.length) {
    const fallbackPartyId = room.coalition.order[0] || null;
    if (fallbackPartyId) {
      finalizeCoalitionGovernment(room, fallbackPartyId, [fallbackPartyId]);
    }
    return false;
  }

  room.coalition.turnIndex = nextTurnIndex;
  const nextFormateurPartyId = room.coalition.order[nextTurnIndex] || null;
  resetCoalitionMandate(room, nextFormateurPartyId, 1);
  return true;
}

function runCoalitionAutomation(room) {
  if (!room || room.state !== 'coalition') return;
  ensureCoalitionState(room);
  if (!room.coalition.order.length) return;

  let safety = 0;
  while (room.state === 'coalition' && safety < 24) {
    safety += 1;

    const formateurPartyId = getCurrentCoalitionFormateurPartyId(room);
    if (!formateurPartyId) return;

    if (!Array.isArray(room.coalition.proposedPartyIds) || room.coalition.proposedPartyIds[0] !== formateurPartyId) {
      resetCoalitionMandate(room, formateurPartyId, room.coalition.attempt || 1);
    }

    room.coalition.coalitionPartyIds = uniquePartyIds(room.coalition.proposedPartyIds);

    const formateurPlayer = findPlayerByPartyId(room, formateurPartyId);
    if (formateurPlayer) {
      sendRoomUpdate(room);
      return;
    }

    const aiSenderId = `ai_${formateurPartyId}`;
    const pendingOffer = (room.coalition.offers || []).find((offer) =>
      offer.status === 'pending' &&
      offer.fromPlayerId === aiSenderId
    );
    if (pendingOffer) return;

    let waitingOnPlayer = false;
    for (const partyId of room.coalition.order) {
      if (partyId === formateurPartyId) continue;
      if (room.coalition.proposedPartyIds.includes(partyId)) continue;
      if (room.coalition.invitedPartyIds.includes(partyId)) continue;
      if (getCoalitionSeatTotal(room, room.coalition.proposedPartyIds) >= 251) break;

      const playerForParty = findPlayerByPartyId(room, partyId);
      room.coalition.invitedPartyIds = uniquePartyIds([...room.coalition.invitedPartyIds, partyId]);

      if (playerForParty) {
        const existingPending = (room.coalition.offers || []).find((offer) =>
          offer.status === 'pending' &&
          offer.fromPlayerId === aiSenderId &&
          offer.targetPlayerId === playerForParty.playerId
        );
        if (!existingPending) {
          const offer = makeCoalitionOffer(room, {
            fromPlayerId: aiSenderId,
            fromPartyId: formateurPartyId,
            fromPartyName: formateurPartyId,
            targetPlayerId: playerForParty.playerId,
            targetPartyId: partyId,
            offeredMinistries: 1
          });
          room.lastActivityAt = now();
          broadcastRoom(room, {
            type: 'coalition_offer_pending',
            roomId: room.id,
            offer,
            at: now()
          });
          sendRoomUpdate(room);
        }
        waitingOnPlayer = true;
        break;
      }

      room.coalition.proposedPartyIds.push(partyId);
      room.coalition.coalitionPartyIds = uniquePartyIds(room.coalition.proposedPartyIds);
    }

    if (waitingOnPlayer) return;

    const coalitionSeats = getCoalitionSeatTotal(room, room.coalition.proposedPartyIds);
    if (coalitionSeats >= 251) {
      finalizeCoalitionGovernment(room, formateurPartyId, room.coalition.proposedPartyIds);
      return;
    }

    const remainingCandidates = room.coalition.order.filter((partyId) =>
      partyId !== formateurPartyId &&
      !room.coalition.proposedPartyIds.includes(partyId) &&
      !room.coalition.invitedPartyIds.includes(partyId)
    );

    if (remainingCandidates.length > 0) {
      continue;
    }

    if ((room.coalition.attempt || 1) < 2) {
      resetCoalitionMandate(room, formateurPartyId, 2);
      room.lastActivityAt = now();
      sendRoomUpdate(room);
      continue;
    }

    const advanced = advanceCoalitionMandate(room);
    if (!advanced) {
      return;
    }

    room.lastActivityAt = now();
    sendRoomUpdate(room);
  }
}

function startPartySelection(room) {
  if (room.state !== 'lobby') return;
  room.state = 'party_selection';
  room.lastActivityAt = now();
  room.players.forEach((p) => {
    p.selectedPartyId = null;
    p.selectedPartyName = null;
    p.parliamentComplete = false;
    p.parliamentSessionNumber = 1;
  });
  resetParliamentRuntimeState(room);

  broadcastRoom(room, {
    type: 'party_selection_started',
    room: serializeRoom(room),
    at: now()
  });

  sendRoomUpdate(room);
}

function startCampaign(room, options = {}) {
  const reason = String(options.reason || 'campaign_started').trim() || 'campaign_started';
  if (room.state !== 'party_selection' && room.state !== 'parliament') return;
  room.state = 'campaign';
  room.campaign.startedAt = now();
  room.campaign.barrierCompletedAt = null;
  room.campaign.electionSeed = null;
  room.campaign.emergentParty = {
    count: 0,
    triggeredTurns: {}
  };
  room.election.seed = null;
  room.election.results = null;
  room.election.resultsByPlayerId = null;
  room.election.lockedAt = null;
  ensureCoalitionState(room);
  room.coalition.offerSeq = 1;
  room.coalition.offers = [];
  room.coalition.order = [];
  room.coalition.turnIndex = 0;
  room.coalition.attempt = 1;
  room.coalition.currentFormateurPartyId = null;
  room.coalition.proposedPartyIds = [];
  room.coalition.invitedPartyIds = [];
  room.coalition.coalitionPartyIds = [];
  room.coalition.governmentPartyId = null;
  resetParliamentRuntimeState(room);
  room.actionOrder = 0;

  room.players.forEach((p) => {
    p.turnsCompleted = 0;
    p.campaignComplete = false;
    p.role = null;
    p.parliamentComplete = false;
    p.parliamentSessionNumber = 1;
  });

  broadcastRoom(room, {
    type: 'campaign_started',
    room: serializeRoom(room),
    reason,
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
  room.election.seed = room.campaign.electionSeed;
  room.election.results = null;
  room.election.resultsByPlayerId = null;
  room.election.lockedAt = null;

  broadcastRoom(room, {
    type: 'campaign_barrier_complete',
    roomId: room.id,
    electionSeed: room.campaign.electionSeed,
    at: now()
  });

  broadcastRoom(room, {
    type: 'election_started',
    room: serializeRoom(room),
    electionSeed: room.campaign.electionSeed,
    at: now()
  });

  sendRoomUpdate(room);
}

function sanitizeSeatMap(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    const k = String(key || '').trim().slice(0, 48);
    if (!k) continue;
    const n = Math.max(0, Math.floor(Number(value) || 0));
    out[k] = n;
  }
  return out;
}

function sanitizePopularVoteMap(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    const k = String(key || '').trim().slice(0, 48);
    if (!k) continue;
    const n = Number(value);
    out[k] = Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  return out;
}

function sanitizePartyListDetail(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    const k = String(key || '').trim().slice(0, 48);
    if (!k || !value || typeof value !== 'object') continue;
    out[k] = {
      exactSeats: Number.isFinite(Number(value.exactSeats)) ? Number(value.exactSeats) : 0,
      floorSeats: Math.max(0, Math.floor(Number(value.floorSeats) || 0)),
      remainder: Number.isFinite(Number(value.remainder)) ? Number(value.remainder) : 0,
      bonusSeats: Math.max(0, Math.floor(Number(value.bonusSeats) || 0))
    };
  }
  return out;
}

function sanitizeDistrictResults(input) {
  if (!Array.isArray(input)) return [];
  const rows = [];
  for (const row of input) {
    if (!row || typeof row !== 'object') continue;
    const districtId = Math.max(1, Math.floor(Number(row.districtId) || 0));
    const winnerId = String(row.winnerId || '').trim().slice(0, 48);
    if (!districtId || !winnerId) continue;
    rows.push({
      districtId,
      provinceName: String(row.provinceName || '').trim().slice(0, 48),
      seatIndex: Math.max(1, Math.floor(Number(row.seatIndex) || 1)),
      winnerId
    });
    if (rows.length >= 600) break;
  }
  return rows;
}

function sanitizeElectionResults(input) {
  if (!input || typeof input !== 'object') return null;
  const districtResults = sanitizeDistrictResults(input.districtResults);
  if (districtResults.length === 0) return null;
  return {
    constituencyWins: sanitizeSeatMap(input.constituencyWins),
    partyListSeats: sanitizeSeatMap(input.partyListSeats),
    totalSeats: sanitizeSeatMap(input.totalSeats),
    nationalPopularVote: sanitizePopularVoteMap(input.nationalPopularVote),
    partyListDetail: sanitizePartyListDetail(input.partyListDetail),
    districtResults
  };
}

function submitElectionResults(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'election') {
    safeSend(ws, { type: 'error', code: 'election_not_active', message: 'Election phase is not active.' });
    return;
  }

  if (room.election && room.election.results) {
    safeSend(ws, {
      type: 'election_results_locked',
      roomId: room.id,
      byPlayerId: room.election.resultsByPlayerId || null,
      lockedAt: room.election.lockedAt || null,
      electionSeed: room.election.seed || null,
      results: room.election.results,
      at: now()
    });
    return;
  }

  const sanitized = sanitizeElectionResults(message.results || null);
  if (!sanitized) {
    safeSend(ws, { type: 'error', code: 'invalid_election_results', message: 'Election results payload is invalid.' });
    return;
  }

  room.election.results = sanitized;
  room.election.resultsByPlayerId = ctx.playerId || null;
  room.election.lockedAt = now();
  room.lastActivityAt = now();

  broadcastRoom(room, {
    type: 'election_results_locked',
    roomId: room.id,
    byPlayerId: room.election.resultsByPlayerId || null,
    lockedAt: room.election.lockedAt || null,
    electionSeed: room.election.seed || null,
    results: room.election.results,
    at: now()
  });

  sendRoomUpdate(room);
}

function startCoalitionPhase(ws) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'election') {
    safeSend(ws, { type: 'error', code: 'election_not_active', message: 'Election phase is not active.' });
    return;
  }

  const owner = room.ownerPlayerId ? findPlayer(room, room.ownerPlayerId) : null;
  const ownerAvailable = !!(owner && owner.connected);
  if (!ctx.playerId || (room.ownerPlayerId !== ctx.playerId && ownerAvailable)) {
    safeSend(ws, { type: 'error', code: 'not_room_owner', message: 'Only host can start coalition phase.' });
    return;
  }

  if (!ownerAvailable && room.ownerPlayerId !== ctx.playerId) {
    room.ownerPlayerId = ctx.playerId;
  }

  if (!room.election || !room.election.results) {
    safeSend(ws, { type: 'error', code: 'election_results_missing', message: 'Election results are not locked yet.' });
    return;
  }

  initializeCoalitionFromElection(room);
  if (!room.coalition.order.length) {
    safeSend(ws, { type: 'error', code: 'coalition_order_missing', message: 'No valid election seat totals found for coalition phase.' });
    return;
  }

  room.state = 'coalition';
  room.lastActivityAt = now();

  broadcastRoom(room, {
    type: 'coalition_started',
    room: serializeRoom(room),
    at: now()
  });

  sendRoomUpdate(room);
  runCoalitionAutomation(room);
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

  ensureCoalitionState(room);
  const currentFormateurPartyId = getCurrentCoalitionFormateurPartyId(room);
  const fromPartyId = String(fromPlayer.selectedPartyId || '').trim();
  if (!currentFormateurPartyId || !fromPartyId || fromPartyId !== currentFormateurPartyId) {
    safeSend(ws, { type: 'error', code: 'not_your_turn', message: 'Only the current coalition lead can send invitations.' });
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

  const targetPartyId = String(message.targetPartyId || targetPlayer.selectedPartyId || '').trim() || null;
  if (targetPartyId) {
    room.coalition.invitedPartyIds = uniquePartyIds([...room.coalition.invitedPartyIds, targetPartyId]);
  }

  const offer = makeCoalitionOffer(room, {
    fromPlayerId: fromPlayer.playerId,
    fromPartyId,
    fromPartyName: fromPlayer.selectedPartyName || fromPartyId,
    targetPlayerId: targetPlayer.playerId,
    targetPartyId,
    offeredMinistries: message.offeredMinistries
  });

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
  ensureCoalitionState(room);
  offer.status = accepted ? 'accepted' : 'rejected';
  offer.respondedAt = now();

  if (offer.targetPartyId) {
    room.coalition.invitedPartyIds = uniquePartyIds([...room.coalition.invitedPartyIds, offer.targetPartyId]);
  }

  if (accepted && offer.targetPartyId) {
    room.coalition.proposedPartyIds = uniquePartyIds([...room.coalition.proposedPartyIds, offer.targetPartyId]);
    room.coalition.coalitionPartyIds = uniquePartyIds(room.coalition.proposedPartyIds);
  }

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

  const fromPlayerId = String(offer.fromPlayerId || '');
  if (fromPlayerId.startsWith('ai_')) {
    runCoalitionAutomation(room);
  }
}

function publishSharedGovernmentBillUsage(room, sessionNumber, extra = {}) {
  ensureParliamentState(room);
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

  ensureParliamentState(room);
  player.role = (message.role === 'government') ? 'government' : 'opposition';
  player.parliamentSessionNumber = Math.max(1, Math.floor(Number(message.sessionNumber) || 1));
  if (typeof player.parliamentComplete !== 'boolean') {
    player.parliamentComplete = false;
  }
  room.parliament.termCompletionByPlayerId[player.playerId] = !!player.parliamentComplete;
  player.lastSeenAt = now();
  room.lastActivityAt = now();
  if (room.state !== 'parliament') {
    room.state = 'parliament';
  }

  publishSharedGovernmentBillUsage(room, player.parliamentSessionNumber, {
    byPlayerId: player.playerId,
    reason: 'session_sync'
  });
  publishParliamentProgress(room, 'session_sync', {
    byPlayerId: player.playerId
  });
  sendRoomUpdate(room);
}

function reportParliamentTermComplete(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'parliament') {
    safeSend(ws, { type: 'error', code: 'parliament_not_active', message: 'Parliament phase is not active.' });
    return;
  }

  const player = findPlayer(room, ctx.playerId);
  if (!player) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }

  ensureParliamentState(room);
  const reportedSession = Math.max(1, Math.floor(Number(message.sessionNumber) || player.parliamentSessionNumber || 1));
  if (player.parliamentComplete) {
    publishParliamentProgress(room, 'term_complete_duplicate', {
      byPlayerId: player.playerId,
      sessionNumber: reportedSession
    });
    return;
  }

  player.parliamentSessionNumber = reportedSession;
  player.parliamentComplete = true;
  room.parliament.termCompletionByPlayerId[player.playerId] = true;
  player.lastSeenAt = now();
  room.lastActivityAt = now();
  room.actionOrder += 1;

  publishParliamentProgress(room, 'term_complete', {
    byPlayerId: player.playerId,
    sessionNumber: reportedSession,
    order: room.actionOrder
  });
  sendRoomUpdate(room);

  const allDone = room.players.length >= room.minPlayers && room.players.every((p) => !!p.parliamentComplete);
  if (!allDone) return;

  startCampaign(room, { reason: 'parliament_barrier_complete' });
}

function proposeGovernmentBill(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'parliament') {
    safeSend(ws, { type: 'error', code: 'parliament_not_active', message: 'Parliament phase is not active.' });
    return;
  }

  const player = findPlayer(room, ctx.playerId);
  if (!player) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }

  if (player.role !== 'government') {
    safeSend(ws, { type: 'error', code: 'role_not_allowed', message: 'Only governing players can propose government bills.' });
    return;
  }

  if (player.parliamentComplete) {
    safeSend(ws, { type: 'error', code: 'parliament_already_completed', message: 'You already completed this parliament term.' });
    return;
  }

  ensureParliamentState(room);
  if (room.parliament.pendingGovernmentBills.length >= GOVERNMENT_BILL_QUEUE_LIMIT) {
    safeSend(ws, { type: 'error', code: 'bill_queue_full', message: 'Pending government bill queue is full.' });
    return;
  }

  const fallbackId = `gb_${String(room.parliament.billSeq++).padStart(4, '0')}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const bill = sanitizeGovernmentBillPayload(message.bill || {}, fallbackId);
  if (!bill.name) {
    safeSend(ws, { type: 'error', code: 'invalid_bill', message: 'Invalid bill payload.' });
    return;
  }

  const duplicateId = room.parliament.pendingGovernmentBills.some((row) => row.id === bill.id);
  if (duplicateId) {
    bill.id = `${fallbackId}_dup`;
  }

  const sessionNumber = Math.max(1, Math.floor(Number(message.sessionNumber) || player.parliamentSessionNumber || 1));
  const sessionKey = String(sessionNumber);
  player.parliamentSessionNumber = sessionNumber;

  const sessionCap = getGovernmentBillSessionCapFromRoom(room);
  const usedThisSession = Math.max(0, Math.floor(Number(room.parliament.sharedBillUsageBySession[sessionKey] || 0)));
  if (usedThisSession >= sessionCap) {
    safeSend(ws, {
      type: 'error',
      code: 'bill_session_cap_reached',
      message: `Session bill cap reached (${usedThisSession}/${sessionCap}).`
    });
    return;
  }

  if (!room.parliament.sharedBillUsageBySession[sessionKey]) {
    room.parliament.sharedBillUsageBySession[sessionKey] = 0;
  }
  room.parliament.sharedBillUsageBySession[sessionKey] += 1;

  const proposal = {
    ...bill,
    fromPlayerId: player.playerId,
    fromPartyId: player.selectedPartyId || null,
    sessionNumber,
    proposedAt: now()
  };

  room.parliament.pendingGovernmentBills.push(proposal);
  room.actionOrder += 1;
  room.lastActivityAt = now();
  player.lastSeenAt = now();

  broadcastRoom(room, {
    type: 'government_bill_proposed',
    roomId: room.id,
    order: room.actionOrder,
    byPlayerId: player.playerId,
    bill: proposal,
    at: now()
  });

  publishSharedGovernmentBillUsage(room, sessionNumber, {
    byPlayerId: player.playerId,
    billName: bill.name,
    order: room.actionOrder,
    reason: 'government_bill_proposed'
  });

  sendRoomUpdate(room);
}

function submitGovernmentBillVote(ws, message) {
  const room = getRoomBySocket(ws);
  const ctx = getSocketContext(ws);
  if (!room || room.state !== 'parliament') {
    safeSend(ws, { type: 'error', code: 'parliament_not_active', message: 'Parliament phase is not active.' });
    return;
  }

  const player = findPlayer(room, ctx.playerId);
  if (!player) {
    safeSend(ws, { type: 'error', code: 'player_not_in_room', message: 'Player not in room.' });
    return;
  }

  if (player.role !== 'opposition') {
    safeSend(ws, { type: 'error', code: 'role_not_allowed', message: 'Only opposition players can resolve government bill votes.' });
    return;
  }

  if (player.parliamentComplete) {
    safeSend(ws, { type: 'error', code: 'parliament_already_completed', message: 'You already completed this parliament term.' });
    return;
  }

  ensureParliamentState(room);
  const billId = String(message.billId || '').trim();
  if (!billId) {
    safeSend(ws, { type: 'error', code: 'missing_bill_id', message: 'Bill id is required.' });
    return;
  }

  const idx = room.parliament.pendingGovernmentBills.findIndex((row) => row.id === billId);
  if (idx === -1) {
    safeSend(ws, { type: 'error', code: 'bill_not_found', message: 'Pending bill was not found.' });
    return;
  }

  const bill = room.parliament.pendingGovernmentBills[idx];
  const stance = (message.stance === 'support' || message.stance === 'abstain') ? message.stance : 'oppose';
  const result = sanitizeGovernmentBillResolutionResult(message.result || {});
  result.billName = result.billName || bill.name;
  result.stance = stance;
  const sessionNumber = Math.max(1, Math.floor(Number(message.sessionNumber) || Number(bill.sessionNumber) || player.parliamentSessionNumber || 1));
  player.parliamentSessionNumber = sessionNumber;
  const patch = sanitizeParliamentPatch(message.patch);

  room.parliament.pendingGovernmentBills.splice(idx, 1);
  room.actionOrder += 1;
  room.lastActivityAt = now();
  player.lastSeenAt = now();

  broadcastRoom(room, {
    type: 'government_bill_vote_resolved',
    roomId: room.id,
    order: room.actionOrder,
    byPlayerId: player.playerId,
    billId: bill.id,
    bill,
    stance,
    sessionNumber,
    result,
    patch,
    at: now()
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

  ensureParliamentState(room);

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
  maybeTriggerCampaignEmergentParty(room, player.turnsCompleted, player.playerId);

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

  const actionType = String(message.actionType || 'unknown').trim().slice(0, 64) || 'unknown';
  if (actionType === CAMPAIGN_ACTION_EMERGENT_PARTY_TYPE) {
    safeSend(ws, {
      type: 'error',
      code: 'action_not_allowed',
      message: 'This campaign action is server-managed.'
    });
    return;
  }

  const payload = sanitizeCampaignActionPayload(message.payload || {});

  room.actionOrder += 1;
  room.lastActivityAt = now();
  player.lastSeenAt = now();

  broadcastRoom(room, {
    type: 'action_applied',
    roomId: room.id,
    order: room.actionOrder,
    playerId: player.playerId,
    actionType,
    payload,
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

        room.config = sanitizeRoomConfig(msg.roomConfig || room.config || {});

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
      case 'parliament_term_complete': {
        reportParliamentTermComplete(ws, msg);
        break;
      }
      case 'government_bill_propose': {
        proposeGovernmentBill(ws, msg);
        break;
      }
      case 'government_bill_vote': {
        submitGovernmentBillVote(ws, msg);
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
      case 'election_results_submit': {
        submitElectionResults(ws, msg);
        break;
      }
      case 'start_coalition_phase': {
        startCoalitionPhase(ws);
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
