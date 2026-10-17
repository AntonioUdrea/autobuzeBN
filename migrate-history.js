/*
 * migrate-history.js: run ONCE to convert data/history.csv into data/history/YYYY-MM.json.
 *
 *   node migrate-history.js
 *
 * Old rows only know "this vehicle was on this route on this day", so the
 * imported entries have a route but no times. New checks fill in the details
 * from now on. Safe to run again: existing data is kept and nothing is duplicated.
 * The CSV is not touched; delete it yourself once you've checked the result.
 */
const fs = require("fs");
const store = require("./history-store.js");

const CSV_FILE = "data/history.csv";

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }

  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

if (!fs.existsSync(CSV_FILE)) {
  console.log(`${CSV_FILE} not found. Nothing to migrate.`);
  process.exit(0);
}

const months = new Map(); // "2026-10" -> month data
let imported = 0;

for (const [date, operator, id, route] of parseCsv(fs.readFileSync(CSV_FILE, "utf8")).slice(1)) {
  if (!date || !operator || !id) continue;

  const month = store.monthOf(date);
  if (!months.has(month)) months.set(month, store.loadMonth(month));

  const key = `${operator}:${id}`;
  const day = (months.get(month)[date] ??= {});
  const stints = (day[key] ??= []);
  const routeName = route || "?";

  if (!stints.some(s => s.route === routeName)) {
    stints.push({ route: routeName });
    imported++;
  }
}

for (const [month, data] of months) store.saveMonth(month, data);

console.log(`Imported ${imported} entries into ${months.size} month file(s) in ${store.HISTORY_DIR}/.`);
