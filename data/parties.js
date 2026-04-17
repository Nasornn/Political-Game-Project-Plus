// ============================================================
// PARTY DEFINITIONS — 9 Base Factions (Adjusted per user feedback)
// ============================================================
window.Game = window.Game || {};
window.Game.Data = window.Game.Data || {};

/*
 * Regional BanYai System:
 *   banYaiPower is a base value, but regionalBanYai overrides per-region.
 *   If a region key exists in regionalBanYai, THAT value is used instead.
 *   This lets us model: "Bangkok-only banYai" or "South-only banYai".
 *
 * Ideology scale: 0 = far-left progressive, 50 = centrist, 100 = far-right conservative
 */

window.Game.Data.PARTIES = [
    {
        id: "progressive",
        name: "Progressive Future",
        thaiName: "ก้าวไกล",
        shortName: "PF",
        hexColor: "#FF6B00",
        basePopularity: 30, // High national pop, but...
        banYaiPower: 0,     // Zero banYai outside Bangkok
        regionalBanYai: {
            "Bangkok": 70   // Strong ground game in BKK only
        },
        provincialBanYai: {
            "Phuket": 95,    // Strong ground game in Phuket
            "Lamphun": 90,
        },
        // Regional popularity modifiers (added to base for that region)
        regionalPopMod: {
            "Bangkok": +15,
            "Central": +3,
            "North": -5,
            "Northeast": -10,
            "East": +2,
            "West": -5,
            "South": -15
        },
        politicalCapital: 200,
        greyMoney: 0,
        scandalMeter: 0,
        ideology: 15,   // Progressive
        description: "Urban progressive movement. Dominates Bangkok and Phuket but struggles in rural heartlands.",
        isPlayerSelectable: true
    },
    {
        id: "pheuthai",
        name: "Pheu Thai",
        thaiName: "เพื่อไทย",
        shortName: "PT",
        hexColor: "#DC2626",
        basePopularity: 16,
        banYaiPower: 45,   // Medium banYai
        regionalBanYai: {
            "Northeast": 75,  // Stronger in Isan
            "North": 45,
            "Bangkok": 20,
            "Central": 35,
            "South": 10,
            "East": 30,
            "West": 5
        },
        provincialBanYai: {
            "Nakhon Ratchasima": 60, // Isan gateway provinc
        },
        regionalPopMod: {
            "Bangkok": -3,
            "Central": +2,
            "North": +8,
            "Northeast": +12,
            "East": 0,
            "West": 0,
            "South": -8
        },
        politicalCapital: 300,
        greyMoney: 100,
        scandalMeter: 15,
        ideology: 35,   // Center-left populist
        description: "Legacy populist machine. Deep roots in the North and Northeast via patronage networks.",
        isPlayerSelectable: true
    },
    {
        id: "bhumjaithai",
        name: "Bhumjaithai",
        thaiName: "ภูมิใจไทย",
        shortName: "BJT",
        hexColor: "#2563EB",
        basePopularity: 12,
        banYaiPower: 40,   // Moderate base banYai — real strength is provincial
        regionalBanYai: {
            "Northeast": 65,  // Boosted to compete with PT
            "Central": 75,
            "North": 25,
            "East": 55,
            "West": 30,
            "Bangkok": 10,
            "South": 15
        },
        provincialBanYai: {
            // Buriram + NE provinces bordering another country (Laos/Cambodia)
            "Buriram": 100,         // Cambodia border — absolute fortress
            "Nakhon Ratchasima": 75, // Gateway to Isan — second fortress
            "Surin": 95,            // Cambodia border
            "Sisaket": 95,          // Cambodia border
            "Ubon Ratchathani": 90, // Laos/Cambodia border
            "Chaiyaphum": 85,       // Strong patronage
            "Sa Kaeo": 65,          // Cambodia border
            "Nong Khai": 75,        // Laos border
            "Bueng Kan": 88,        // Laos border
            "Nakhon Phanom": 88,    // Laos border
            "Mukdahan": 88,         // Laos border
            "Loei": 85,             // Laos border
            "Uthai Thani": 90,      // Central-west foothold
            "Suphan Buri": 95       // Strong local machine in Suphan Buri
        },
        regionalPopMod: {
            "Bangkok": -8,
            "Central": +3,
            "North": +2,
            "Northeast": +10,
            "East": +5,
            "West": +3,
            "South": -3
        },
        politicalCapital: 250,
        greyMoney: 200,
        scandalMeter: 25,
        ideology: 55,   // Center-right
        description: "Pure local clan powerhouse. Wins through rural patron networks and constituency machines. Buriram and surrounding provinces are an unbreakable fortress.",
        isPlayerSelectable: true
    },
    {
        id: "unitedthai",
        name: "United Thai Nation",
        thaiName: "รวมไทยสร้างชาติ",
        shortName: "UTN",
        hexColor: "#1E3A8A",
        basePopularity: 10,       // Adjusted: NOT more than 10%
        banYaiPower: 40,          // Medium — LOWER than Bhumjaithai
        regionalBanYai: {
            "Central": 50,
            "Bangkok": 28,
            "South": 35,
            "Northeast": 30,
            "North": 25,
            "East": 40,
            "West": 35
        },
        regionalPopMod: {
            "Bangkok": +2,
            "Central": +4,
            "North": -2,
            "Northeast": -3,
            "East": +3,
            "West": +2,
            "South": +2
        },
        politicalCapital: 350,
        greyMoney: 150,
        scandalMeter: 20,
        ideology: 70,   // Conservative establishment
        description: "Establishment party backed by the military-bureaucratic elite. Moderate ground game.",
        isPlayerSelectable: true
    },
    {
        id: "palangpracharath",
        name: "Palang Pracharath",
        thaiName: "พลังประชารัฐ",
        shortName: "PPRP",
        hexColor: "#006536",
        basePopularity: 8,
        banYaiPower: 40,   // Medium banYai
        regionalBanYai: {
            "Central": 50,
            "Northeast": 40,
            "North": 30,
            "Bangkok": 35,
            "East": 45,
            "West": 40,
            "South": 25
        },
        provincialBanYai: {
            "Sa Kaeo": 80,          // Cambodia border — PPRP stronghold
            "Nong Khai": 80,        // Laos border — PPRP stronghold
        },
        regionalPopMod: {
            "Bangkok": +2,
            "Central": +4,
            "North": -2,
            "Northeast": +2,
            "East": +3,
            "West": +3,
            "South": -3
        },
        politicalCapital: 200,
        greyMoney: 120,
        scandalMeter: 30,
        ideology: 65,
        description: "Pro-military establishment force with moderate national reach and patronage connections.",
        isPlayerSelectable: true
    },
    {
        id: "klatham",
        name: "Kla Tham",
        thaiName: "กล้าธรรม",
        shortName: "KT",
        hexColor: "#4EC86F",
        basePopularity: 10,
        banYaiPower: 40,   // Medium banYai
        regionalBanYai: {
            "North": 80,      // Boosted to compete in Northern heartlands
            "Central": 45,
            "Bangkok": 30,
            "Northeast": 35,
            "East": 60,
            "West": 35,
            "South": 25
        },
        provincialBanYai: {
            "Phrae": 95,      // บ้านใหญ่แพร่ — Kla Tham stronghold
            "Phayao": 95,     // Strong Northern machine
            "Nan": 85,        // Secondary Northern stronghold
            "Uttaradit": 75,   // Emerging machine
            "Chiang Rai": 80,
            "Chachoengsao": 85,    // Eastern foothold
        },
        regionalPopMod: {
            "Bangkok": +2,
            "Central": +3,
            "North": 0,
            "Northeast": 0,
            "East": +2,
            "West": +1,
            "South": -2
        },
        politicalCapital: 150,
        greyMoney: 80,
        scandalMeter: 10,
        ideology: 60,
        description: "Centrist-conservative party. Phrae province is their local stronghold fortress.",
        isPlayerSelectable: true
    },
    {
        id: "democrat",
        name: "Democrat",
        thaiName: "ประชาธิปัตย์",
        shortName: "DEM",
        hexColor: "#15A5F5",
        basePopularity: 6,
        banYaiPower: 0,    // Zero base banYai...
        regionalBanYai: {
            "South": 70,   // ...but DOMINANT in the South only
            "Bangkok": 10,
            "Central": 5,
            "North": 0,
            "Northeast": 0,
            "East": 5,
            "West": 5
        },
        provincialBanYai: {
            // Deep south is Prachachat territory, not Democrat
            "Pattani": 5,
            "Yala": 5,
            "Narathiwat": 5
        },
        regionalPopMod: {
            "Bangkok": -1,
            "Central": -2,
            "North": -4,
            "Northeast": -4,
            "East": 0,
            "West": 0,
            "South": +25   // Strong southern popularity
        },
        politicalCapital: 180,
        greyMoney: 50,
        scandalMeter: 5,
        ideology: 55,
        description: "Thailand's oldest party. Southern fortress — but the deep south Islamic provinces have shifted to Prachachat.",
        isPlayerSelectable: true
    },
    {
        id: "setthakit",
        name: "Economics Party",
        thaiName: "พรรคเศรษฐกิจ",
        shortName: "ECN",
        hexColor: "#FEBD00",
        basePopularity: 3,
        banYaiPower: 0,    // No banYai at all
        regionalBanYai: {},
        regionalPopMod: {
            "Bangkok": +1,
            "Central": +1,
            "North": -1,
            "Northeast": -2,
            "East": +1,
            "West": 0,
            "South": -1
        },
        politicalCapital: 100,
        greyMoney: 0,
        scandalMeter: 0,
        ideology: 40,
        description: "Technocratic party focused on economic reform. Relies entirely on national appeal with zero ground game.",
        isPlayerSelectable: true
    },
    {
        id: "prachachat",
        name: "Prachachat",
        thaiName: "ประชาชาติ",
        shortName: "PCC",
        hexColor: "#BA810D",
        basePopularity: 2,     // Very low national popularity
        banYaiPower: 0,        // No banYai outside deep south
        regionalBanYai: {
            "Bangkok": 0,
            "Central": 0,
            "North": 0,
            "Northeast": 0,
            "East": 0,
            "West": 0,
            "South": 5         // Minimal southern presence outside the 3 provinces
        },
        provincialBanYai: {
            // Dominant บ้านใหญ่ in the 3 deep south Islamic provinces
            "Pattani": 95,
            "Yala": 95,
            "Narathiwat": 95
        },
        regionalPopMod: {
            "Bangkok": -2,
            "Central": -2,
            "North": -2,
            "Northeast": -2,
            "East": -2,
            "West": -2,
            "South": +8        // Popular in the south, especially Islamic communities
        },
        politicalCapital: 80,
        greyMoney: 30,
        scandalMeter: 0,
        ideology: 45,   // Centrist — focused on ethnic/religious identity
        description: "Islamic community party. Nearly invisible nationally but commands absolute loyalty in Pattani, Yala, and Narathiwat through religious and ethnic networks.",
        isPlayerSelectable: true
    },
    {
        id: "thaisangthai",
        name: "Thai Sang Thai",
        thaiName: "ไทยสร้างไทย",
        shortName: "TST",
        hexColor: "#6841D0",
        basePopularity: 3,
        banYaiPower: 0,
        regionalBanYai: {
            "Northeast": 10
        },
        provincialBanYai: {
            "Roi Et": 70
        },
        regionalPopMod: {
            "Bangkok": 0,
            "Central": 0,
            "North": 0,
            "Northeast": +10,
            "East": 0,
            "West": 0,
            "South": 0
        },
        politicalCapital: 120,
        greyMoney: 20,
        scandalMeter: 0,
        ideology: 45,
        description: "Moderate reform party with limited local machine focused in the Northeast.",
        isPlayerSelectable: true
    }
];
