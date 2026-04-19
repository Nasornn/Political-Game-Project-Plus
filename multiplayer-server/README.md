# Antigravity Multiplayer Server

WebSocket backend for 3-4 player FFA sessions with an 8-turn campaign barrier.

## Features
- Private room codes
- Public matchmaking queue (fills 3-4 players)
- Ready checks and campaign start
- Campaign barrier tracking: each player completes 8 turns
- Election trigger event when all active players reach 8/8
- Deterministic receive-order index for concurrent actions
- Session resume via reconnect token
- Disconnected-player auto-complete timeout to prevent barrier stalls

## Run locally
1. `cd multiplayer-server`
2. `npm install`
3. `npm start`

Server runs on `ws://localhost:8787` by default.

## Docker
1. `cd multiplayer-server`
2. `docker build -t antigravity-mp .`
3. `docker run --rm -p 8787:8787 antigravity-mp`

## Easiest host flow
1. Host runs server locally (`npm start` in this folder).
2. Host opens game and connects to `ws://localhost:8787`.
3. Host clicks `Host Room` and shares room code.
4. Friends connect to host endpoint and click `Join Room`.
5. Everyone clicks `Set Ready`.
6. Match starts automatically. Each player plays 8 turns; election starts when all complete.

## Internet hosting quick options
- Same LAN: use host machine IP, e.g. `ws://192.168.1.23:8787`.
- Public internet: deploy container to any VPS/cloud and expose port `8787`.
- Tunnel for testing: forward `8787` with your preferred tunnel tool, then use the generated `ws://`/`wss://` URL.

## Protocol (high-level)
Client messages:
- `create_room` { name, maxPlayers }
- `join_room` { roomId, name }
- `join_matchmaking` { name }
- `resume_session` { resumeToken, name? }
- `leave_room`
- `set_ready` { ready }
- `campaign_turn_complete` { turnsCompleted }
- `campaign_action` { actionType, payload }
- `heartbeat`

Server events:
- `connected`
- `session_resumed`
- `resume_failed`
- `room_joined`
- `room_update`
- `campaign_started`
- `campaign_progress`
- `campaign_player_auto_completed`
- `campaign_barrier_complete`
- `election_started`
- `action_applied`
- `error`
