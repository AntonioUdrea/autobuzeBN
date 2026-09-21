
const fs = require('fs');
const { execSync } = require('child_process');

const API_URLS = [
  {
    operator: "transmixt",
    name: "Transmixt",
    url: "https://app.bistrita-transport.com/api/v1/0697fb4a-6530-4bf2-a143-98225b196a32/transport/planner/vehicles"
  },
  {
    operator: "ani-tour",
    name: "Ani Tour",
    url: "https://www.telelink.city/api/v1/a5f27685-3239-4aa9-9105-48b19a9bb2cc/transport/planner/vehicles"
  }
];

// Defined as "operator:vehicleId" or license plate string
const RARE_VEHICLES = new Set([
  "transmixt:41",
  "transmixt:53",
  "transmixt:62",
  "transmixt:133",
  "transmixt:145"
]);

// Optionally restrict rare bus alerts to specific routes (leave [] for all routes)
const TARGET_ROUTES = [];

const STATE_FILE = 'data/rare-bus-state.json';

async function run() {
  // ------------------------------------------------------------
  // Time-of-Day Guard (Bistrița local time: Europe/Bucharest)
  // ------------------------------------------------------------
  const now = new Date();

  const timeString = now.toLocaleString("en-GB", {
    timeZone: "Europe/Bucharest",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const [hour, minute] = timeString.split(":").map(Number);
  const currentMinutes = hour * 60 + minute;

  const startMinutes = 5 * 60;          // 05:00 AM
  const stopMinutes = 22 * 60 + 30;     // 10:30 PM

  // Skip if time is at/after 22:30 OR before 05:00
  if (currentMinutes >= stopMinutes || currentMinutes < startMinutes) {
    console.log(
      `Skipping: Outside active bus hours (${timeString} local time).`
    );
    return;
  }

  // ------------------------------------------------------------
  // Current local date in Europe/Bucharest
  // ------------------------------------------------------------
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);

  console.log(
    `Bus checker running at ${timeString} Europe/Bucharest (${localDate}).`
  );

  // ------------------------------------------------------------
  // Environment
  // ------------------------------------------------------------
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    console.error("Missing DISCORD_WEBHOOK_URL environment variable.");
    process.exit(1);
  }

  // ------------------------------------------------------------
  // Load metadata
  // ------------------------------------------------------------
  let vehiclesMeta = {};
  let routesMeta = {};

  try {
    if (fs.existsSync('data/vehicles.json')) {
      vehiclesMeta = JSON.parse(
        fs.readFileSync('data/vehicles.json', 'utf8')
      );
    }

    if (fs.existsSync('data/routes.json')) {
      routesMeta = JSON.parse(
        fs.readFileSync('data/routes.json', 'utf8')
      );
    }
  } catch (err) {
    console.warn("Warning loading local metadata:", err.message);
  }

  // ------------------------------------------------------------
  // Load persistent rare-bus state
  //
  // IMPORTANT:
  // A bus is NOT removed from this state when it disappears
  // from the API.
  //
  // This prevents:
  //   bus disappears -> bus reappears -> duplicate alert
  //
  // State format:
  //
  // {
  //   "date": "2026-09-21",
  //   "buses": {
  //     "transmixt:41": "3",
  //     "transmixt:53": "5"
  //   }
  // }
  // ------------------------------------------------------------
  let previousState = {};

  try {
    if (fs.existsSync(STATE_FILE)) {
      const savedState = JSON.parse(
        fs.readFileSync(STATE_FILE, 'utf8')
      );

      if (savedState.date === localDate) {
        previousState = savedState.buses ?? {};

        console.log(
          `Loaded rare-bus state for ${localDate}.`
        );
      } else {
        console.log(
          `New day detected (${savedState.date ?? "no previous date"} -> ${localDate}).`
        );
        console.log("Resetting rare-bus state for today.");

        previousState = {};
      }
    } else {
      console.log("No previous rare-bus state found.");
    }
  } catch (err) {
    console.warn("Warning loading rare-bus state:", err.message);
    previousState = {};
  }

  // ------------------------------------------------------------
  // Fetch active buses
  // ------------------------------------------------------------
  const activeBuses = [];

  for (const api of API_URLS) {
    try {
      const res = await fetch(api.url);

      if (res.ok) {
        const data = await res.json();

        if (Array.isArray(data)) {
          data.forEach(v => {
            activeBuses.push({
              ...v,
              operator: api.operator,
              operatorName: api.name
            });
          });
        }
      } else {
        console.error(
          `Failed to fetch ${api.name}: HTTP ${res.status}`
        );
      }
    } catch (err) {
      console.error(
        `Failed to fetch from ${api.name}:`,
        err.message
      );
    }
  }

  // ------------------------------------------------------------
  // Start today's state with EVERYTHING we already knew.
  //
  // This is intentional:
  // if a bus temporarily disappears from the API, its last
  // known route is retained.
  // ------------------------------------------------------------
  const currentState = {
    ...previousState
  };

  // ------------------------------------------------------------
  // Main evaluation loop
  // ------------------------------------------------------------
  for (const bus of activeBuses) {
    const key = `${bus.operator}:${bus.vehicleId}`;

    const vehicleInfo =
      vehiclesMeta[bus.operator]?.[String(bus.vehicleId)];

    const routeInfo =
      routesMeta[bus.operator]?.[String(bus.routeId)];

    const licensePlate =
      vehicleInfo?.licensePlate ??
      `Vehicle ${bus.vehicleId}`;

    const model =
      vehicleInfo?.model ??
      "Unknown Model";

    // Resolve human-readable line number
    const routeIndicative =
      routeInfo?.indicative ??
      String(bus.routeId);

    // Read assigned lines list from vehicles.json
    const assignedRoutes =
      vehicleInfo?.assignedRoutes ?? [];

    // ----------------------------------------------------------
    // 1. Rare Bus Check
    // ----------------------------------------------------------
    const isRare =
      RARE_VEHICLES.has(key) ||
      (
        vehicleInfo?.licensePlate &&
        RARE_VEHICLES.has(vehicleInfo.licensePlate)
      );

    const isTargetRoute =
      TARGET_ROUTES.length === 0 ||
      TARGET_ROUTES.includes(String(bus.routeId));

    if (isRare && isTargetRoute) {
      const currentRoute = String(routeIndicative);
      const previousRoute = previousState[key];

      // Alert if:
      //   - this is the first time we see the bus today, OR
      //   - it has changed route
      if (
        previousRoute === undefined ||
        previousRoute !== currentRoute
      ) {
        const content =
          `${licensePlate} (${model}) e pe linia ${routeIndicative}`;

        console.log(
          `Rare bus alert: ${content}`
        );

        try {
          const discordResponse = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content })
          });

          if (!discordResponse.ok) {
            console.error(
              `Discord webhook failed: HTTP ${discordResponse.status}`
            );
          }
        } catch (err) {
          console.error(
            "Failed to send rare bus notification:",
            err.message
          );
        }
      } else {
        console.log(
          `${key} still on line ${currentRoute}; no rare-bus notification needed.`
        );
      }

      // Always update the last known route while the bus
      // is actually visible in the API.
      currentState[key] = currentRoute;
    }

    // ----------------------------------------------------------
    // 2. Unusual Route Check
    //
    // This remains independent of the rare-bus state.
    // It behaves exactly as before.
    // ----------------------------------------------------------
    if (
      assignedRoutes.length > 0 &&
      !assignedRoutes.includes(routeIndicative)
    ) {
      const content =
        `${licensePlate} (${model}) e pe linia ${routeIndicative}`;

      console.log(
        `Unusual route alert: ${content}`
      );

      try {
        const discordResponse = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ content })
        });

        if (!discordResponse.ok) {
          console.error(
            `Discord webhook failed: HTTP ${discordResponse.status}`
          );
        }
      } catch (err) {
        console.error(
          "Failed to send unusual route notification:",
          err.message
        );
      }
    }
  }

  // ------------------------------------------------------------
  // Save today's rare-bus state
  //
  // IMPORTANT:
  // We intentionally keep buses that disappeared from the API.
  // They will remain remembered until the next day.
  // ------------------------------------------------------------
  const stateToSave = {
    date: localDate,
    buses: currentState
  };

  fs.mkdirSync('data', { recursive: true });

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(stateToSave, null, 2) + '\n'
  );

  // ------------------------------------------------------------
  // Commit state if it changed
  // ------------------------------------------------------------
  try {
    execSync(
      `git config user.name "github-actions[bot]"`
    );

    execSync(
      `git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`
    );

    execSync(`git add ${STATE_FILE}`);

    try {
      // Exit code 0 = no changes
      execSync(
        `git diff --cached --quiet -- ${STATE_FILE}`
      );

      console.log("Rare bus state unchanged.");
    } catch {
      // Exit code 1 = staged changes exist
      execSync(
        `git commit -m "Update rare bus state [skip ci]"`,
        { stdio: 'inherit' }
      );

      execSync(
        `git push`,
        { stdio: 'inherit' }
      );

      console.log("Rare bus state saved.");
    }
  } catch (err) {
    console.error(
      "Failed to commit rare bus state:",
      err.message
    );
  }
}

run();
