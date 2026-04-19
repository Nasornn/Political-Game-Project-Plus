# Antigravity Multiplayer Server

WebSocket backend for 3-4 player FFA sessions with an 8-turn campaign barrier.

## Features
- Private room codes
- Public matchmaking queue (fills 3-4 players)
- Ready checks + host-controlled start
- Room-level party selection phase (unique party per player)
- In-room text chat broadcasting
- Campaign barrier tracking: each player completes 8 turns
- Coalition phase trigger when all active players reach 8/8
- Realtime coalition offer/response events (player-to-player)
- Parliament shared bill-usage synchronization for governing players
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
3. Host clicks `Host Room`, then `Copy Join Key`.
4. Friends paste the join key into the room field and click `Join`.
5. Everyone clicks `Set Ready`.
6. Host clicks `Start Match`.
7. Players lock one unique party during room party selection.
8. Campaign starts. Players play 8 turns each.
9. Coalition starts when all players complete campaign.
10. Parliament shared bill usage can be synced by governing players.

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
- `start_match`
- `select_party` { partyId, partyName }
- `campaign_turn_complete` { turnsCompleted }
- `campaign_action` { actionType, payload }
- `chat_send` { text, channel? }
- `coalition_offer_create` { targetPlayerId, targetPartyId, offeredMinistries }
- `coalition_offer_response` { offerId, accept }
- `sync_parliament_role` { role, sessionNumber }
- `government_bill_passed` { billName, sessionNumber }
- `heartbeat`

Server events:
- `connected`
- `session_resumed`
- `resume_failed`
- `room_joined`
- `room_update`
- `party_selection_started`
- `party_selection_update`
- `campaign_started`
- `campaign_progress`
- `campaign_player_auto_completed`
- `campaign_barrier_complete`
- `coalition_started`
- `coalition_offer_pending`
- `coalition_offer_resolved`
- `chat_message`
- `government_bill_shared_update`
- `action_applied`
- `error`
