/*
 * check-buses.js: runs from GitHub Actions every ~15 minutes.
 *
 * One run does, in order:
 *   1. Read every data file first (so a corrupt file stops the run BEFORE anything is sent or changed).
 *   2. Fetch the live vehicles and stops from both operators.
 *   3. Record every vehicle in the detailed history (data/history/YYYY-MM.json).
 *   4. Update data/last-seen.json.
 *   5. Send Discord alerts for rare vehicles / vehicles on an unusual route.
 *   6. Write the files and push them to git.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const Common = require("./common.js");
const store = require("./history-store.js");


// ============================================================
// Settings
// ============================================================

// Rare vehicles. Format: "operator:vehicleId" (a licence plate also works)
const RARE_VEHICLES = new Set([
  "transmixt:41",
  "transmixt:53",
  "transmixt:62",
  "transmixt:77",
  "transmixt:123",
  "transmixt:133",
  "transmixt:145"
]);

// Route IDs (not line numbers) that rare-vehicle alerts apply to. [] = all routes.
const TARGET_ROUTES = [];

// Checks outside these hours are skipped (Bucharest time)
const ACTIVE_FROM = "05:00";
const ACTIVE_UNTIL = "22:30";

const STATE_FILE = "data/rare-bus-state.json";
const LAST_SEEN_FILE = "data/last-seen.json";


// ============================================================
// Files
// ============================================================

/** Missing file -> fallback. Corrupt file -> throws (never silently start from empty and overwrite). */
function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** vehicles.json / routes.json are nice to have: without them we still run, just with less detail. */
function loadMeta() {
  try {
    return {
      vehicles: readJson("data/vehicles.json", {}),
      routes: readJson("data/routes.json", {})
    };
  } catch (err) {
    console.warn("Could not load vehicles.json / routes.json:", err.message);
    return { vehicles: {}, routes: {} };
  }
}


// ============================================================
// Alert state (data/rare-bus-state.json)
//
// { "date": "2026-10-15",
//   "buses": { "transmixt:53": { "route": "1", "rare": true, "unusual": false } } }
//
// Only buses that triggered a rare/unusual alert are stored, and the state
// resets every day. It remembers which route we last alerted about, so a bus
// only alerts again when it changes route.
// ============================================================

function loadAlertState(date) {
  try {
    const saved = readJson(STATE_FILE, null);
    if (saved?.date === date) return saved.buses ?? {};
  } catch (err) {
    console.warn("Could not read alert state, starting fresh:", err.message);
  }
  return {};
}

// Older state files stored just the route string instead of an object
const routeOf = entry => (entry == null ? undefined : String(entry.route ?? entry));


// ============================================================
// Duplicates: the API sometimes lists the same vehicle more than once
// ============================================================

function resolveDuplicates(buses, previousRouteOf) {
  const groups = new Map();

  for (const bus of buses) {
    if (!groups.has(bus.key)) groups.set(bus.key, []);
    groups.get(bus.key).push(bus);
  }

  return [...groups.entries()].map(([key, entries]) => {
    if (entries.length === 1) return entries[0];

    console.log(`Duplicate API entries for ${key}: ${entries.map(e => e.routeIndicative).join(", ")}`);

    // Prefer an entry on a different route than last time, so route changes are noticed
    const previous = previousRouteOf(key);
    const changed = previous !== undefined && entries.find(e => e.routeIndicative !== previous);
    return changed || entries[0];
  });
}


// ============================================================
// Discord alerts
// ============================================================

async function sendDiscord(webhookUrl, content) {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);

    console.log(`Discord notification sent: ${content}`);
    return true;
  } catch (err) {
    console.error(`Failed to send Discord notification: ${err.message}`);
    return false;
  }
}

/** Sends the alerts and returns the new alert state. */
async function sendAlerts(buses, previousState, webhookUrl) {
  // Start from ALL previous state, so a bus that briefly drops out of the API keeps its entry
  const state = { ...previousState };

  for (const bus of buses) {
    const isRare =
      RARE_VEHICLES.has(bus.key) ||
      (!bus.unknownPlate && RARE_VEHICLES.has(bus.licensePlate));

    const isTargetRoute =
      TARGET_ROUTES.length === 0 || TARGET_ROUTES.includes(String(bus.routeId));

    const isUnusual =
      bus.assignedRoutes.length > 0 && !bus.assignedRoutes.map(String).includes(bus.routeIndicative);

    const previousRoute = routeOf(previousState[bus.key]);
    const routeChanged = previousRoute !== bus.routeIndicative; // also true when undefined

    // One message at most, even if the bus is both rare and unusual
    const shouldNotify = routeChanged && ((isRare && isTargetRoute) || isUnusual);

    if (shouldNotify) {
      const plate = bus.unknownPlate ? `Vehicle ${bus.id}` : bus.licensePlate;
      const model = bus.unknownModel ? "Unknown Model" : bus.model;

      const sent = await sendDiscord(webhookUrl, `${plate} (${model}) e pe linia ${bus.routeIndicative}`);

      // Only move the state forward if Discord got it, so the next run retries
      if (!sent) continue;
    }

    if (isRare || isUnusual || previousState[bus.key]) {
      state[bus.key] = { route: bus.routeIndicative, rare: isRare, unusual: isUnusual };
    }
  }

  return state;
}


// ============================================================
// Git
// ============================================================

const git = (...args) => execFileSync("git", args, { stdio: "inherit" });

function hasStagedChanges(paths) {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--", ...paths]);
    return false;  // exit code 0 = no differences
  } catch {
    return true;   // exit code 1 = there are differences
  }
}

function persistToGit(paths, message) {
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  git("add", ...paths);

  if (!hasStagedChanges(paths)) {
    console.log("Git reports no changes.");
    return;
  }

  git("commit", "-m", message);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      git("push", "origin", "HEAD:main");
      console.log("Pushed to main.");
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`Push attempt ${attempt} failed, rebasing and retrying...`);
      git("fetch", "origin", "main");
      git("rebase", "origin/main");
    }
  }
}


// ============================================================
// Main
// ============================================================

async function run(now = new Date()) {
  const date = Common.bucharestDate(now);
  const time = Common.bucharestTime(now);
  const minutes = Common.toMinutes(time);

  if (minutes < Common.toMinutes(ACTIVE_FROM) || minutes >= Common.toMinutes(ACTIVE_UNTIL)) {
    console.log(`Skipping: outside active bus hours (${time} Europe/Bucharest).`);
    return;
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("Missing DISCORD_WEBHOOK_URL environment variable.");
    process.exit(1);
  }

  console.log(`Bus checker running at ${time} Europe/Bucharest (${date}).`);

  // 1. Read everything first. If a file is corrupt this throws before anything is sent.
  const { vehicles, routes } = loadMeta();
  const alertState = loadAlertState(date);
  const lastSeen = readJson(LAST_SEEN_FILE, {});
  const month = store.monthOf(date);
  const history = store.loadMonth(month);

  // 2. Fetch
  const [{ buses, failed }, { stops, patterns }] = await Promise.all([
    Common.fetchAllVehicles(),
    Common.fetchStops()
  ]);

  if (failed.length === Common.API_URLS.length) {
    console.error("Every API failed. Nothing recorded this run.");
    return;
  }

  const ctx = { vehicles, routes, stops, patterns };
  const enriched = buses
    .filter(bus => bus.vehicleId != null)
    .map(bus => Common.enrichVehicle(bus, ctx));

  const current = resolveDuplicates(enriched, key => routeOf(alertState[key]));
  console.log(`${current.length} vehicles running.`);

  // 3 + 4. History and last seen
  for (const bus of current) {
    store.recordSighting(history, {
      date,
      time,
      key: bus.key,
      route: bus.routeIndicative,
      destination: bus.destination === "Unknown" ? "" : bus.destination
    });

    (lastSeen[bus.operator] ??= {})[bus.id] = { date, time, route: bus.routeIndicative };
  }

  // 5. Alerts
  const newAlertState = await sendAlerts(current, alertState, webhookUrl);

  // 6. Write + push
  store.saveMonth(month, history);
  writeJson(LAST_SEEN_FILE, lastSeen);
  writeJson(STATE_FILE, { date, buses: newAlertState });

  persistToGit([STATE_FILE, LAST_SEEN_FILE, store.HISTORY_DIR], "Update bus data [skip ci]");

  console.log("Bus checker completed successfully.");
}


module.exports = { resolveDuplicates, sendAlerts, run };

if (require.main === module) {
  run().catch(err => {
    console.error("Bus checker failed:", err);
    process.exit(1);
  });
}
