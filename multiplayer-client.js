window.Game = window.Game || {};

function __agResolveConfiguredEndpoint() {
    try {
        const cfg = window.ANTIGRAVITY_CONFIG || {};
        const raw = String(cfg.multiplayerEndpoint || window.__ANTIGRAVITY_MULTIPLAYER_ENDPOINT || '').trim();
        return raw;
    } catch (_) {
        return '';
    }
}

function __agResolveEndpointLock() {
    try {
        const cfg = window.ANTIGRAVITY_CONFIG || {};
        if (cfg.lockMultiplayerEndpoint === true) return true;
        if (cfg.lockMultiplayerEndpoint === false) return false;
        return !!__agResolveConfiguredEndpoint();
    } catch (_) {
        return false;
    }
}

function __agResolveDefaultEndpoint() {
    const configured = __agResolveConfiguredEndpoint();
    if (configured) return configured;
    const stored = (window.localStorage && localStorage.getItem('antigravity.multiplayer.endpoint')) || '';
    const trimmed = String(stored || '').trim();
    return trimmed || 'ws://localhost:8787';
}

window.Game.Multiplayer = {
    socket: null,
    configuredEndpoint: __agResolveConfiguredEndpoint(),
    endpointLocked: __agResolveEndpointLock(),
    endpoint: __agResolveDefaultEndpoint(),
    resumeToken: (window.localStorage && localStorage.getItem('antigravity.multiplayer.resumeToken')) || null,
    connected: false,
    playerId: null,
    room: null,
    _listeners: {},
    _heartbeatTimer: 0,
    _resumeAttempted: false,
    _inviteAutoJoinAttempted: false,

    on(eventName, handler) {
        if (!this._listeners[eventName]) {
            this._listeners[eventName] = [];
        }
        this._listeners[eventName].push(handler);
    },

    _emit(eventName, payload) {
        const handlers = this._listeners[eventName] || [];
        handlers.forEach((handler) => {
            try {
                handler(payload);
            } catch (err) {
                console.error('[multiplayer] listener error:', err);
            }
        });
    },

    setEndpoint(endpoint) {
        const trimmed = String(endpoint || '').trim();
        if (this.endpointLocked && this.configuredEndpoint) {
            this.endpoint = this.configuredEndpoint;
            this._emit('status', { connected: this.connected, endpoint: this.endpoint });
            return;
        }
        if (!trimmed) return;
        this.endpoint = trimmed;
        if (window.localStorage) {
            localStorage.setItem('antigravity.multiplayer.endpoint', this.endpoint);
        }
        this._emit('status', { connected: this.connected, endpoint: this.endpoint });
    },

    buildInviteLink(roomId, opts = {}) {
        const code = String(roomId || '').trim().toUpperCase();
        if (!code) return '';

        try {
            const url = new URL(window.location.href);
            url.searchParams.set('mpRoom', code);

            const endpoint = String(opts.endpoint || this.endpoint || '').trim();
            if (endpoint) {
                url.searchParams.set('mpEndpoint', endpoint);
            }

            const name = String(opts.name || '').trim();
            if (name) {
                url.searchParams.set('mpName', name);
            }

            url.searchParams.set('mpAutoJoin', '1');
            return url.toString();
        } catch (_) {
            return '';
        }
    },

    _encodeBase64Url(raw) {
        try {
            return btoa(unescape(encodeURIComponent(String(raw || ''))))
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/g, '');
        } catch (_) {
            return '';
        }
    },

    _decodeBase64Url(encoded) {
        try {
            const normalized = String(encoded || '').replace(/-/g, '+').replace(/_/g, '/');
            const padding = (4 - (normalized.length % 4)) % 4;
            const padded = normalized + '='.repeat(padding);
            return decodeURIComponent(escape(atob(padded)));
        } catch (_) {
            return '';
        }
    },

    buildJoinKey(roomId, opts = {}) {
        const code = String(roomId || '').trim().toUpperCase();
        if (!code) return '';

        const payload = {
            v: 1,
            roomId: code
        };

        const endpoint = String(opts.endpoint || this.endpoint || '').trim();
        if (endpoint) {
            payload.endpoint = endpoint;
        }

        const name = String(opts.name || '').trim();
        if (name) {
            payload.name = name;
        }

        const encoded = this._encodeBase64Url(JSON.stringify(payload));
        if (!encoded) return '';
        return `AG1.${encoded}`;
    },

    decodeJoinKey(value) {
        const raw = String(value || '').trim();
        if (!raw) return null;

        // Support invite URL paste directly in the join field.
        try {
            const url = new URL(raw);
            const roomId = String(url.searchParams.get('mpRoom') || '').trim().toUpperCase();
            if (roomId) {
                const endpoint = String(url.searchParams.get('mpEndpoint') || '').trim();
                const name = String(url.searchParams.get('mpName') || '').trim();
                return {
                    roomId,
                    endpoint: endpoint || null,
                    name: name || null
                };
            }
        } catch (_) {
            // Not a URL; continue with join-key decode.
        }

        const compact = raw.replace(/\s+/g, '');
        if (!/^AG1\.[A-Za-z0-9_-]+$/.test(compact)) {
            return null;
        }

        const encoded = compact.slice(4);
        const decoded = this._decodeBase64Url(encoded);
        if (!decoded) return null;

        try {
            const payload = JSON.parse(decoded);
            const roomId = String(payload.roomId || '').trim().toUpperCase();
            if (!roomId) return null;
            const endpoint = String(payload.endpoint || '').trim();
            const name = String(payload.name || '').trim();
            return {
                roomId,
                endpoint: endpoint || null,
                name: name || null
            };
        } catch (_) {
            return null;
        }
    },

    async joinWithKey({ joinKey, fallbackName = 'Player' } = {}) {
        const parsed = this.decodeJoinKey(joinKey);
        if (!parsed || !parsed.roomId) {
            return { success: false, msg: 'Invalid join key or invite link.' };
        }

        if (parsed.endpoint) {
            this.setEndpoint(parsed.endpoint);
        }

        const conn = await this.ensureConnection();
        if (!conn.success) return conn;

        const name = parsed.name || String(fallbackName || '').trim() || 'Player';
        this._send({ type: 'join_room', roomId: parsed.roomId, name });
        return {
            success: true,
            roomId: parsed.roomId,
            msg: `Joining room ${parsed.roomId}...`
        };
    },

    _readInviteFromUrl() {
        try {
            const url = new URL(window.location.href);
            const roomId = String(url.searchParams.get('mpRoom') || '').trim().toUpperCase();
            if (!roomId) return null;

            const endpoint = String(url.searchParams.get('mpEndpoint') || '').trim();
            const name = String(url.searchParams.get('mpName') || '').trim();

            return {
                roomId,
                endpoint: endpoint || null,
                name: name || null
            };
        } catch (_) {
            return null;
        }
    },

    _clearInviteFromUrl() {
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete('mpRoom');
            url.searchParams.delete('mpEndpoint');
            url.searchParams.delete('mpName');
            url.searchParams.delete('mpAutoJoin');
            window.history.replaceState({}, '', url.toString());
        } catch (_) {
            // ignore
        }
    },

    async autoJoinInviteFromUrl(defaultName = 'Player') {
        if (this._inviteAutoJoinAttempted) {
            return { success: false, skipped: true, msg: 'Invite link already processed.' };
        }
        this._inviteAutoJoinAttempted = true;

        const invite = this._readInviteFromUrl();
        if (!invite) {
            return { success: false, skipped: true, msg: 'No invite link found.' };
        }

        if (invite.endpoint) {
            this.setEndpoint(invite.endpoint);
        }

        const conn = await this.ensureConnection();
        if (!conn.success) {
            // Allow retry if initial auto-connect failed.
            this._inviteAutoJoinAttempted = false;
            return conn;
        }

        const name = invite.name || String(defaultName || '').trim() || 'Player';
        this._send({ type: 'join_room', roomId: invite.roomId, name });
        this._clearInviteFromUrl();

        return {
            success: true,
            roomId: invite.roomId,
            msg: `Joining room ${invite.roomId} from invite link...`
        };
    },

    async connect() {
        if (this.socket && this.connected) {
            return { success: true, msg: 'Already connected.' };
        }

        return new Promise((resolve) => {
            let resolved = false;
            try {
                const ws = new WebSocket(this.endpoint);
                this.socket = ws;

                ws.addEventListener('open', () => {
                    this.connected = true;
                    this._startHeartbeat();
                    this._resumeAttempted = false;

                    if (this.resumeToken) {
                        this._send({ type: 'resume_session', resumeToken: this.resumeToken });
                        this._resumeAttempted = true;
                    }

                    this._emit('status', { connected: true, endpoint: this.endpoint });
                    if (!resolved) {
                        resolved = true;
                        resolve({ success: true, msg: 'Connected.' });
                    }
                });

                ws.addEventListener('message', (ev) => {
                    let message;
                    try {
                        message = JSON.parse(String(ev.data || '{}'));
                    } catch (err) {
                        console.error('[multiplayer] bad message:', err);
                        return;
                    }
                    this._handleMessage(message);
                });

                ws.addEventListener('close', () => {
                    this.connected = false;
                    this._stopHeartbeat();
                    this._emit('status', { connected: false, endpoint: this.endpoint });
                    this._emit('disconnected', { at: Date.now() });
                    if (!resolved) {
                        resolved = true;
                        resolve({ success: false, msg: 'Connection closed.' });
                    }
                });

                ws.addEventListener('error', () => {
                    if (!resolved) {
                        resolved = true;
                        resolve({ success: false, msg: 'Failed to connect server.' });
                    }
                });
            } catch (err) {
                if (!resolved) {
                    resolved = true;
                    resolve({ success: false, msg: err.message || 'Failed to connect.' });
                }
            }
        });
    },

    disconnect() {
        this._stopHeartbeat();
        if (this.socket) {
            try {
                this.socket.close();
            } catch (_) {
                // ignore
            }
        }
        this.socket = null;
        this.connected = false;
        this.room = null;
        this._emit('status', { connected: false, endpoint: this.endpoint });
    },

    async ensureConnection() {
        if (this.connected) return { success: true };
        return this.connect();
    },

    async createRoom({ name, maxPlayers = 4 } = {}) {
        const conn = await this.ensureConnection();
        if (!conn.success) return conn;
        this._send({ type: 'create_room', name: name || 'Host', maxPlayers });
        return { success: true, msg: 'Creating room...' };
    },

    async joinRoom({ roomId, name } = {}) {
        const conn = await this.ensureConnection();
        if (!conn.success) return conn;
        this._send({ type: 'join_room', roomId, name: name || 'Player' });
        return { success: true, msg: 'Joining room...' };
    },

    async joinMatchmaking({ name } = {}) {
        const conn = await this.ensureConnection();
        if (!conn.success) return conn;
        this._send({ type: 'join_matchmaking', name: name || 'Player' });
        return { success: true, msg: 'Queued for matchmaking...' };
    },

    leaveRoom() {
        this._send({ type: 'leave_room' });
        this.room = null;
    },

    setReady(ready) {
        this._send({ type: 'set_ready', ready: !!ready });
    },

    startMatch({ roomConfig } = {}) {
        this._send({ type: 'start_match', roomConfig });
    },

    selectParty({ partyId, partyName } = {}) {
        this._send({ type: 'select_party', partyId, partyName });
    },

    reportCampaignTurn(turnsCompleted) {
        this._send({ type: 'campaign_turn_complete', turnsCompleted });
    },

    reportCampaignAction(actionType, payload = {}) {
        this._send({ type: 'campaign_action', actionType, payload });
    },

    submitElectionResults(results) {
        this._send({ type: 'election_results_submit', results });
    },

    startCoalitionPhase() {
        this._send({ type: 'start_coalition_phase' });
    },

    sendChat({ text, channel } = {}) {
        this._send({ type: 'chat_send', text, channel });
    },

    createCoalitionOffer({ targetPlayerId, targetPartyId, offeredMinistries = 0 } = {}) {
        this._send({ type: 'coalition_offer_create', targetPlayerId, targetPartyId, offeredMinistries });
    },

    respondCoalitionOffer({ offerId, accept } = {}) {
        this._send({ type: 'coalition_offer_response', offerId, accept: !!accept });
    },

    syncParliamentRole({ role, sessionNumber } = {}) {
        this._send({ type: 'sync_parliament_role', role, sessionNumber });
    },

    reportParliamentTermComplete({ sessionNumber, parliamentYear } = {}) {
        this._send({ type: 'parliament_term_complete', sessionNumber, parliamentYear });
    },

    proposeGovernmentBill({ bill, sessionNumber } = {}) {
        this._send({ type: 'government_bill_propose', bill, sessionNumber });
    },

    submitGovernmentBillVote({ billId, stance, sessionNumber, result, patch, autoResolved } = {}) {
        this._send({ type: 'government_bill_vote', billId, stance, sessionNumber, result, patch, autoResolved: !!autoResolved });
    },

    submitNoConfidenceMotion({ sessionNumber, result, patch } = {}) {
        this._send({ type: 'no_confidence_motion', sessionNumber, result, patch });
    },

    requestParliamentDissolve({ sessionNumber } = {}) {
        this._send({ type: 'dissolve_parliament', sessionNumber });
    },

    reportGovernmentBillPassed({ billName, sessionNumber } = {}) {
        this._send({ type: 'government_bill_passed', billName, sessionNumber });
    },

    _send(payload) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        this.socket.send(JSON.stringify(payload));
    },

    _startHeartbeat() {
        this._stopHeartbeat();
        this._heartbeatTimer = window.setInterval(() => {
            this._send({ type: 'heartbeat' });
        }, 12000);
    },

    _stopHeartbeat() {
        if (!this._heartbeatTimer) return;
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = 0;
    },

    _handleMessage(msg) {
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {
            case 'connected':
                this.playerId = msg.playerId || null;
                if (msg.resumeToken) {
                    this.resumeToken = msg.resumeToken;
                    if (window.localStorage) {
                        localStorage.setItem('antigravity.multiplayer.resumeToken', this.resumeToken);
                    }
                }
                this._emit('connected', msg);
                break;
            case 'session_resumed':
                if (msg.self && msg.self.resumeToken) {
                    this.resumeToken = msg.self.resumeToken;
                    if (window.localStorage) {
                        localStorage.setItem('antigravity.multiplayer.resumeToken', this.resumeToken);
                    }
                }
                if (msg.self && msg.self.playerId) {
                    this.playerId = msg.self.playerId;
                }
                this._emit('session_resumed', msg);
                break;
            case 'resume_failed':
                this._emit('resume_failed', msg);
                break;
            case 'room_joined':
                this.room = msg.room || null;
                if (msg.self && msg.self.resumeToken) {
                    this.resumeToken = msg.self.resumeToken;
                    if (window.localStorage) {
                        localStorage.setItem('antigravity.multiplayer.resumeToken', this.resumeToken);
                    }
                }
                this._emit('room_joined', msg);
                break;
            case 'room_update':
                this.room = msg.room || this.room;
                this._emit('room_update', msg);
                break;
            case 'match_found':
                this.room = msg.room || this.room;
                this._emit('match_found', msg);
                break;
            case 'party_selection_started':
                this.room = msg.room || this.room;
                this._emit('party_selection_started', msg);
                break;
            case 'party_selection_update':
                this.room = msg.room || this.room;
                this._emit('party_selection_update', msg);
                break;
            case 'campaign_started':
                this._emit('campaign_started', msg);
                break;
            case 'campaign_progress':
                this._emit('campaign_progress', msg);
                break;
            case 'parliament_progress':
                this._emit('parliament_progress', msg);
                break;
            case 'campaign_barrier_complete':
                this._emit('campaign_barrier_complete', msg);
                break;
            case 'coalition_started':
                this.room = msg.room || this.room;
                this._emit('coalition_started', msg);
                break;
            case 'coalition_offer_pending':
                this._emit('coalition_offer_pending', msg);
                break;
            case 'coalition_offer_resolved':
                this._emit('coalition_offer_resolved', msg);
                break;
            case 'campaign_player_auto_completed':
                this._emit('campaign_player_auto_completed', msg);
                break;
            case 'election_started':
                this._emit('election_started', msg);
                break;
            case 'election_results_locked':
                this._emit('election_results_locked', msg);
                break;
            case 'chat_message':
                this._emit('chat_message', msg);
                break;
            case 'government_bill_shared_update':
                this._emit('government_bill_shared_update', msg);
                break;
            case 'government_bill_proposed':
                this._emit('government_bill_proposed', msg);
                break;
            case 'government_bill_vote_resolved':
                this._emit('government_bill_vote_resolved', msg);
                break;
            case 'no_confidence_resolved':
                this._emit('no_confidence_resolved', msg);
                break;
            case 'parliament_dissolved':
                this._emit('parliament_dissolved', msg);
                break;
            case 'action_applied':
                this._emit('action_applied', msg);
                break;
            case 'error':
                this._emit('error', msg);
                break;
            default:
                this._emit('message', msg);
                break;
        }
    }
};
