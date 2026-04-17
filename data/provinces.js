// ============================================================
// PROVINCE DATA — 400 Constituency Seats across 77 Provinces
// ============================================================
window.Game = window.Game || {};
window.Game.Data = window.Game.Data || {};

window.Game.Data.PROVINCES = {
    "Bangkok": 33,
    "Nakhon Ratchasima": 16,
    "Khon Kaen": 11,
    "Ubon Ratchathani": 11,
    "Buriram": 10,
    "Chiang Mai": 10,
    "Chon Buri": 10,
    "Nakhon Si Thammarat": 10,
    "Udon Thani": 10,
    "Sisaket": 9,
    "Songkhla": 9,
    "Nonthaburi": 8,
    "Roi Et": 8,
    "Samut Prakan": 8,
    "Surin": 8,
    "Chaiyaphum": 7,
    "Chiang Rai": 7,
    "Pathum Thani": 7,
    "Sakon Nakhon": 7,
    "Surat Thani": 7,
    "Kalasin": 6,
    "Maha Sarakham": 6,
    "Nakhon Pathom": 6,
    "Nakhon Sawan": 6,
    "Phetchabun": 6,
    "Kanchanaburi": 5,
    "Lop Buri": 5,
    "Narathiwat": 5,
    "Pattani": 5,
    "Phitsanulok": 5,
    "Phra Nakhon Si Ayutthaya": 5,
    "Ratchaburi": 5,
    "Rayong": 5,
    "Suphan Buri": 5,
    "Chachoengsao": 4,
    "Kamphaeng Phet": 4,
    "Lampang": 4,
    "Loei": 4,
    "Nakhon Phanom": 4,
    "Saraburi": 4,
    "Sukhothai": 4,
    "Trang": 4,
    "Bueng Kan": 3,
    "Chanthaburi": 3,
    "Chumphon": 3,
    "Krabi": 3,
    "Nan": 3,
    "Nong Bua Lamphu": 3,
    "Nong Khai": 3,
    "Phatthalung": 3,
    "Phayao": 3,
    "Phetchaburi": 3,
    "Phichit": 3,
    "Phrae": 3,
    "Phuket": 3,
    "Prachin Buri": 3,
    "Prachuap Khiri Khan": 3,
    "Sa Kaeo": 3,
    "Samut Sakhon": 3,
    "Tak": 3,
    "Uttaradit": 3,
    "Yala": 3,
    "Yasothon": 3,
    "Amnat Charoen": 2,
    "Ang Thong": 2,
    "Chai Nat": 2,
    "Lamphun": 2,
    "Mae Hong Son": 2,
    "Mukdahan": 2,
    "Nakhon Nayok": 2,
    "Phang Nga": 2,
    "Satun": 2,
    "Uthai Thani": 2,
    "Ranong": 1,
    "Samut Songkhram": 1,
    "Sing Buri": 1,
    "Trat": 1
};

// Regional classification
window.Game.Data.REGIONS = {
    "Bangkok":   ["Bangkok"],
    "Central":   ["Nonthaburi","Pathum Thani","Samut Prakan","Nakhon Pathom","Samut Sakhon","Samut Songkhram","Nakhon Nayok","Ang Thong","Phra Nakhon Si Ayutthaya","Saraburi","Lop Buri","Sing Buri","Chai Nat","Suphan Buri","Chachoengsao","Prachin Buri","Sa Kaeo","Nakhon Sawan","Uthai Thani","Kamphaeng Phet","Phichit"],
    "North":     ["Chiang Mai","Chiang Rai","Lampang","Lamphun","Mae Hong Son","Nan","Phayao","Phrae","Uttaradit","Sukhothai","Tak","Phitsanulok","Phetchabun"],
    "Northeast": ["Nakhon Ratchasima","Khon Kaen","Ubon Ratchathani","Udon Thani","Buriram","Sisaket","Surin","Roi Et","Chaiyaphum","Sakon Nakhon","Kalasin","Maha Sarakham","Nakhon Phanom","Loei","Nong Khai","Nong Bua Lamphu","Bueng Kan","Mukdahan","Amnat Charoen","Yasothon"],
    "East":      ["Chon Buri","Rayong","Chanthaburi","Trat"],
    "West":      ["Kanchanaburi","Ratchaburi","Phetchaburi","Prachuap Khiri Khan"],
    "South":     ["Nakhon Si Thammarat","Songkhla","Surat Thani","Pattani","Narathiwat","Yala","Trang","Phatthalung","Krabi","Phuket","Phang Nga","Ranong","Chumphon","Satun"]
};

// Build reverse lookup: province → region
window.Game.Data.PROVINCE_REGION = {};
(function() {
    const regions = window.Game.Data.REGIONS;
    for (const [region, provs] of Object.entries(regions)) {
        for (const p of provs) {
            window.Game.Data.PROVINCE_REGION[p] = region;
        }
    }
})();

// TopoJSON NAME_1 → Game province name mapping (for mismatched names)
window.Game.Data.TOPOJSON_NAME_MAP = {
    "Bangkok Metropolis": "Bangkok",
    "Buri Ram": "Buriram",
    "Si Sa Ket": "Sisaket",
    "Bung Kan": "Bueng Kan",
    "Nong Bua Lam Phu": "Nong Bua Lamphu",
    "Phattalung": "Phatthalung",
    "Phangnga": "Phang Nga",
    "Sa Kaew": "Sa Kaeo",
    "Bueng Kan": "Bueng Kan",
    "Loburi": "Lop Buri",
    "Lop Buri": "Lop Buri",
    "Mahasarakham": "Maha Sarakham",
    "Maha Sarakham": "Maha Sarakham",
    "Nong Bua Lamphu": "Nong Bua Lamphu",
    "Prachin Buri": "Prachin Buri",
    "Phra Nakhon Si Ayutthaya": "Phra Nakhon Si Ayutthaya",
    "Samut Prakan": "Samut Prakan",
    "Samut Sakhon": "Samut Sakhon",
    "Samut Songkhram": "Samut Songkhram"
};
