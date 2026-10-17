/*
 * history-store.js (Node only): reads and writes the vehicle history.
 *
 * Layout on disk:
 *   data/history/index.json      { "months": ["2026-09", "2026-10"] }
 *   data/history/2026-10.json    one file per month
 *
 * Inside a month file:
 *   {
 *     "2026-10-15": {                                   <- day
 *       "transmixt:53": [                               <- vehicle ("operator:id")
 *         { "route": "10", "from": "06:15", "to": "09:30", "polls": 14, "directions": ["Gara"] },
 *         { "route": "1",  "from": "09:45", "to": "14:00", "polls": 17 }
 *       ]
 *     }
 *   }
 *
 * Each entry in a vehicle's list is a "stint": one continuous period on one route.
 *   route       line number
 *   from / to   first and last time the bus was seen in that stint (Bucharest time)
 *   polls       how many checks saw it
 *   directions  destinations seen during the stint (optional)
 * Rows imported from the old history.csv only have `route` (no times).
 */
const fs = require("fs");
const path = require("path");
const { toMinutes, naturalCompare } = require("./common.js");

const HISTORY_DIR = "data/history";
const INDEX_FILE = `${HISTORY_DIR}/index.json`;

// If a bus is missing for longer than this, the next sighting starts a new stint.
// Checks run every ~15 min, so 60 min tolerates a few skipped checks.
const MAX_GAP_MINUTES = 60;

const monthOf = date => date.slice(0, 7);
const monthFile = month => `${HISTORY_DIR}/${month}.json`;


function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** A missing file is a new month. A corrupt file THROWS, so we never overwrite good history with {}. */
function loadMonth(month) {
  const file = monthFile(month);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

// One vehicle per line, so a git diff shows exactly which vehicles changed.
function serializeMonth(data) {
  const days = Object.keys(data).sort().map(date => {
    const vehicles = Object.keys(data[date]).sort(naturalCompare).map(key =>
      `    ${JSON.stringify(key)}: ${JSON.stringify(data[date][key])}`);
    return `  ${JSON.stringify(date)}: {\n${vehicles.join(",\n")}\n  }`;
  });
  return `{\n${days.join(",\n")}\n}\n`;
}

function addToIndex(month) {
  const months = fs.existsSync(INDEX_FILE)
    ? JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")).months ?? []
    : [];

  if (months.includes(month)) return;
  months.push(month);
  months.sort();
  writeAtomic(INDEX_FILE, JSON.stringify({ months }, null, 2) + "\n");
}

function saveMonth(month, data) {
  writeAtomic(monthFile(month), serializeMonth(data));
  addToIndex(month);
}


/**
 * Record "this vehicle was seen on this route at this time".
 * Extends the vehicle's latest stint if it is the same route and recent enough,
 * otherwise starts a new one. Changes `monthData` in place.
 */
function recordSighting(monthData, { date, key, route, time, destination = "" }) {
  const day = (monthData[date] ??= {});
  const stints = (day[key] ??= []);
  const last = stints[stints.length - 1];

  const addDestination = stint => {
    if (!destination) return;
    stint.directions ??= [];
    if (!stint.directions.includes(destination)) stint.directions.push(destination);
  };

  // A row imported from the old CSV has no times yet: fill it in
  if (last && last.route === route && !last.to) {
    Object.assign(last, { from: time, to: time, polls: 1 });
    addDestination(last);
    return;
  }

  if (last && last.route === route && toMinutes(time) - toMinutes(last.to) <= MAX_GAP_MINUTES) {
    last.to = time;
    last.polls += 1;
    addDestination(last);
    return;
  }

  const stint = { route, from: time, to: time, polls: 1 };
  addDestination(stint);
  stints.push(stint);
}


module.exports = {
  HISTORY_DIR,
  MAX_GAP_MINUTES,
  monthOf,
  loadMonth,
  saveMonth,
  serializeMonth,
  recordSighting
};
