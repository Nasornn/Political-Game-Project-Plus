window.Game = window.Game || {};

window.Game.Multiplayer = {
    socket: null,
    endpoint: (window.localStorage && localStorage.getItem('antigravity.multiplayer.endpoint')) || 'ws://localhost:8787',
    resumeToken: (window.localStorage && localStorage.getItem('antigravity.multiplayer.resumeToken')) || null,
    connected: false,
    playerId: null,
    room: null,
    _listeners: {},
    _heartbeatTimer: 0,
    _resumeAttempted: false,

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
        if (!trimmed) return;
        this.endpoint = trimmed;
        if (window.localStorage) {
            localStorage.setItem('antigravity.multiplayer.endpoint', this.endpoint);
        }
        this._emit('status', { connected: this.connected, endpoint: this.endpoint });
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

    reportCampaignTurn(turnsCompleted) {
        this._send({ type: 'campaign_turn_complete', turnsCompleted });
    },

    reportCampaignAction(actionType, payload = {}) {
        this._send({ type: 'campaign_action', actionType, payload });
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
            case 'campaign_started':
                this._emit('campaign_started', msg);
                break;
            case 'campaign_progress':
                this._emit('campaign_progress', msg);
                break;
            case 'campaign_barrier_complete':
                this._emit('campaign_barrier_complete', msg);
                break;
            case 'campaign_player_auto_completed':
                this._emit('campaign_player_auto_completed', msg);
                break;
            case 'election_started':
                this._emit('election_started', msg);
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
