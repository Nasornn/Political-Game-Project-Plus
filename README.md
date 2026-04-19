# Political-Game-Project
Political Game Project
Political Game Project is a browser-based Thailand election and parliament strategy simulator. Players choose from 8 Thai political parties (or create their own) and compete in a fully simulated 500-seat national election, then govern through a 4-year parliamentary term.

Gameplay Overview
The game progresses through five distinct phases:

Setup – Select a party with unique ideologies, regional strengths, and military influence ("BanYai") ratings.
Campaign – Spend action points across Thailand's 7 regions over 5 turns. Counter rivals with disinformation campaigns (IO operations), manage your scandal meter, and strategize on the interactive D3-powered Thailand map.
Election – A complex algorithm resolves all 400 constituency seats (first-past-the-post) and 100 party-list seats (proportional representation), factoring in base popularity, regional bonuses, candidate appeal, campaign buffs, and corruption debuffs.
Coalition – Negotiate with other parties to form a government with 251+ seats. Allocate ministries to coalition partners.
Parliament – Govern for 4 years. Vote on 15 bills (land reform, military budget, marriage equality, welfare, etc.), manage 500 individually simulated MPs with loyalty, ideology, and corruption attributes, and engage in shadow politics — bribe rival MPs into becoming "Cobras" (defectors), siphon funds into grey money, or risk EC investigation and party dissolution.
Key Features
🗺️ Interactive Thailand map with district-level visualization (D3.js + TopoJSON)
🧠 AI-driven rival parties that campaign and react to player actions
🏛️ 500 simulated MPs with unique personality traits (loyalty, ideology, corruption)
🎭 Shadow politics system — corruption, bribery, disinformation, and scandal risk
🌐 Bilingual UI — Thai (ไทย) and English
📊 Deep election simulation — multi-factor scoring per district
Tech Stack
Vanilla JavaScript (OOP, window.Game.* module pattern)
D3.js v7 + TopoJSON for map rendering
Pure CSS with a dark political theme and gold accents
No build tools — runs directly in the browser

Custom Scenario Modding
You can now mod the game by importing a JSON scenario.

How to open the mod editor
1. Start the game and go to Setup.
2. Click Scenario Mod in the top toolbar, or click Open Custom Scenario Editor in the Setup Scenario panel.

How to apply a custom scenario
1. In the editor modal, click Load Template to get a valid starter schema.
2. Edit JSON fields (party overrides, custom parties, campaign settings).
3. Click Apply Scenario while on the Setup screen.
4. Pick a party and start the run.

How to disable a custom scenario
1. Open the same Scenario Mod editor.
2. Click Disable Custom, or use Disable Custom Scenario in Setup.

File-based scenario packs (local folder)
You can ship reusable scenario mods as JSON files under the scenarios folder.

1. Add pack entries to scenarios/index.json.
2. Put each scenario JSON file in scenarios/.
3. Open Scenario Mod in-game.
4. Use Refresh Packs, then Preview or Quick Apply.

Manifest format (scenarios/index.json)
{
	"packs": [
		{
			"id": "urban_reform_wave",
			"name": "Urban Reform Wave",
			"description": "Short description",
			"author": "Your Name",
			"file": "scenarios/urban_reform_wave.json"
		}
	]
}

Notes
- Quick Apply only works from Setup screen.
- If pack loading fails when opening index.html directly, run the project from a local server so JSON fetch works.

Cheat Commands (Testing)
Use browser DevTools console:

1. `window.Game.Cheat.help()` to list commands.
2. `window.Game.Cheat.run("<command>")` to execute.

Common examples
- `window.Game.Cheat.run("capital 500")`
- `window.Game.Cheat.run("grey 300")`
- `window.Game.Cheat.run("state parliament")`
- `window.Game.Cheat.run("role opposition")`
- `window.Game.Cheat.run("queuebills 2")`
- `window.Game.Cheat.run("walkout 25")`
- `window.Game.Cheat.run("split bhumjaithai 18")`
- `window.Game.Cheat.run("vote oppose")`

Supported JSON fields
- name: string
- description: string
- baseMode: realistic or balanced
- campaign.maxTurns: 4-16
- campaign.apPerTurn: 4-20
- campaign.emergentPartyChance: 0.0-0.8
- partyOverrides: array of patches for existing party ids
- customParties: array of fully defined new parties

Minimal example
{
	"name": "Regional Machine Test",
	"baseMode": "realistic",
	"campaign": {
		"maxTurns": 9,
		"apPerTurn": 11,
		"emergentPartyChance": 0.18
	},
	"partyOverrides": [
		{
			"id": "progressive",
			"basePopularity": 34,
			"regionalPopMod": {
				"Bangkok": 18,
				"North": -2
			}
		}
	],
	"customParties": [
		{
			"id": "green_wave",
			"name": "Green Wave Alliance",
			"thaiName": "Green Wave",
			"shortName": "GWA",
			"hexColor": "#2F9E44",
			"basePopularity": 7,
			"banYaiPower": 10,
			"ideology": 24,
			"politicalCapital": 170,
			"greyMoney": 15,
			"regionalPopMod": {
				"Bangkok": 2,
				"North": 3
			},
			"provincialBanYai": {
				"Phuket": 55
			},
			"description": "A green-urban reform bloc with a Phuket machine."
		}
	]
}

Multiplayer (Implementation Started)
This project now includes an initial multiplayer stack for live FFA sessions with an 8-turn campaign barrier.

What is implemented
- Node.js WebSocket backend scaffold in multiplayer-server/
- Private room code hosting and joining
- Public matchmaking queue (2-4 players)
- Ready check + host-controlled match start
- Room-level party selection phase (unique party lock per player)
- Campaign room chatbox during live play
- Campaign progress tracking per player (0-8)
- Waiting-room behavior for players who finish campaign early
- Barrier trigger: coalition phase starts only when all players reach 8/8
- Realtime coalition offer/accept/reject flow for human-controlled parties
- Shared government bill-cap sync across governing players (multiplayer parliament)
- Deterministic action order index for concurrent campaign action events

Run multiplayer server
1. cd multiplayer-server
2. npm install
3. npm start

Default endpoint is ws://localhost:8787.

Client controls
- Click the Multiplayer button in the top toolbar.
- Connect to server endpoint, then Host Room / Join Room / Matchmaking.
- Set Ready, then host clicks Start Match.
- In setup, each player locks one unique party for that room.

Current integration notes
- Multiplayer is integrated as an active implementation slice and coexists with single-player.
- Save/Load, Sandbox, and Scenario Mod are disabled during active multiplayer sessions.
- Campaign UI now shows per-player turn progress and waiting state when you finish 8/8.

Easy Host + Play (Step-by-Step)
1. Start backend server:
	 - `cd multiplayer-server`
	 - `npm install`
	 - `npm start`
2. Open the game in your browser.
3. Click `🌐 Multiplayer` in the top toolbar.
4. Keep endpoint as `ws://localhost:8787` (or your host URL) and click `Connect`.
5. Host clicks `Host Room`, then clicks `Copy Join Key`.
6. Other players paste that key into the Room field and click `Join` (works with room code, join key, or invite link).
7. Host clicks `Start Match` after all are ready.
8. All players are moved to room party selection; each player locks one unique party.
9. Campaign starts; chatbox is available in live multiplayer phases.
10. Each player plays 8 turns independently.
11. Finished players wait in waiting state.
12. Coalition phase starts after all players reach 8/8, with realtime accept/reject offers for player-controlled parties.
13. Parliament phase syncs governing bill usage: when one governing player passes a bill, shared cap usage updates for all governing players.

Hosting for friends
- Same Wi-Fi/LAN:
	- Use endpoint like `ws://<host-local-ip>:8787`.
- Over internet:
	- Deploy `multiplayer-server` on a cloud/VPS and expose port `8787`.
	- Use secure websocket endpoint (`wss://...`) if your host supports TLS.

Netlify no-setup mode
- Netlify can host the game frontend, but multiplayer still needs a separate WebSocket backend.
- Deploy `multiplayer-server` to a websocket-capable host (Render/Railway/Fly/VPS), then get a public `wss://...` URL.
- Set your public endpoint once in `index.html`:
	- `window.ANTIGRAVITY_CONFIG.multiplayerEndpoint = 'wss://your-server-url'`
	- `window.ANTIGRAVITY_CONFIG.lockMultiplayerEndpoint = true`
- With endpoint lock enabled, players can host/join directly without manual endpoint setup.

Reconnect behavior
- The client keeps a resume token in browser storage.
- If a player disconnects, reopening and reconnecting will attempt session resume automatically.
- Disconnected players that do not return are auto-completed after timeout so the match cannot be held hostage.
