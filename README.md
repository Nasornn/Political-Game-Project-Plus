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
