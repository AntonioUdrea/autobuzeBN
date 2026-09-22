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

// Optionally restrict rare-bus alerts to specific routes.
// Leave [] for all routes.
const TARGET_ROUTES = [];

const STATE_FILE = 'data/rare-bus-state.json';


// ============================================================
// Discord
// ============================================================

async function sendDiscord(webhookUrl, content) {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content })
    });

    if (!response.ok) {
      throw new Error(`Discord HTTP ${response.status}`);
    }

    console.log(`Discord notification sent: ${content}`);

    return true;

  } catch (err) {
    console.error(
      `Failed to send Discord notification: ${err.message}`
    );

    return false;
  }
}


// ============================================================
// State file
// ============================================================

function writeStateFile(state) {
  fs.mkdirSync('data', { recursive: true });

  const temporaryFile = `${STATE_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(state, null, 2) + '\n',
    'utf8'
  );

  // Atomic replacement.
  fs.renameSync(temporaryFile, STATE_FILE);
}


// ============================================================
// Git persistence
// ============================================================

function persistStateToGit() {
  try {
    execSync(
      `git config user.name "github-actions[bot]"`,
      { stdio: 'inherit' }
    );

    execSync(
      `git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`,
      { stdio: 'inherit' }
    );

    // Make sure the local repository knows about the latest main.
    console.log("Fetching latest main...");

    execSync(
      `git fetch origin main`,
      { stdio: 'inherit' }
    );

    // Stage the state file.
    execSync(
      `git add ${STATE_FILE}`,
      { stdio: 'inherit' }
    );

    // Check whether the state actually changed.
    let hasChanges = false;

    try {
      execSync(
        `git diff --cached --quiet -- ${STATE_FILE}`
      );

      console.log(
        "Git reports that rare-bus state has not changed."
      );

    } catch {
      hasChanges = true;

      console.log(
        "Git detected a change to rare-bus state."
      );
    }

    if (!hasChanges) {
      return true;
    }

    // Commit the state.
    execSync(
      `git commit -m "Update rare bus state [skip ci]"`,
      { stdio: 'inherit' }
    );

    // Push.
    //
    // Normally the workflow concurrency setting prevents
    // simultaneous jobs. The retry is an additional safeguard.
    for (let attempt = 1; attempt <= 3; attempt++) {

      try {

        console.log(
          `Pushing state to main (attempt ${attempt}/3)...`
        );

        execSync(
          `git push origin HEAD:main`,
          { stdio: 'inherit' }
        );

        console.log(
          "Rare-bus state successfully pushed to GitHub."
        );

        return true;

      } catch (err) {

        console.error(
          `Push attempt ${attempt} failed.`
        );

        if (attempt === 3) {
          throw err;
        }

        console.log(
          "Fetching latest main and rebasing..."
        );

        execSync(
          `git fetch origin main`,
          { stdio: 'inherit' }
        );

        execSync(
          `git rebase origin/main`,
          { stdio: 'inherit' }
        );
      }
    }

    return false;

  } catch (err) {

    console.error(
      "CRITICAL: Could not persist rare-bus state."
    );

    console.error(err.message);

    return false;
  }
}


// ============================================================
// Main
// ============================================================

async function run() {

  // ==========================================================
  // Time guard
  // ==========================================================

  const now = new Date();

  const timeString = now.toLocaleString("en-GB", {
    timeZone: "Europe/Bucharest",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const [hour, minute] =
    timeString.split(":").map(Number);

  const currentMinutes =
    hour * 60 + minute;

  const startMinutes = 5 * 60;
  const stopMinutes = 22 * 60 + 30;

  if (
    currentMinutes >= stopMinutes ||
    currentMinutes < startMinutes
  ) {
    console.log(
      `Skipping: Outside active bus hours (${timeString} Europe/Bucharest).`
    );

    return;
  }


  // ==========================================================
  // Local date
  // ==========================================================

  const localDate =
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Bucharest",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now);

  console.log(
    `Bus checker running at ${timeString} Europe/Bucharest (${localDate}).`
  );


  // ==========================================================
  // Discord environment
  // ==========================================================

  const webhookUrl =
    process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    console.error(
      "Missing DISCORD_WEBHOOK_URL environment variable."
    );

    process.exit(1);
  }


  // ==========================================================
  // Load metadata
  // ==========================================================

  let vehiclesMeta = {};
  let routesMeta = {};

  try {

    if (fs.existsSync('data/vehicles.json')) {
      vehiclesMeta = JSON.parse(
        fs.readFileSync(
          'data/vehicles.json',
          'utf8'
        )
      );
    }

    if (fs.existsSync('data/routes.json')) {
      routesMeta = JSON.parse(
        fs.readFileSync(
          'data/routes.json',
          'utf8'
        )
      );
    }

  } catch (err) {

    console.warn(
      "Warning loading metadata:",
      err.message
    );
  }


  // ==========================================================
  // Load today's previous rare-bus state
  // ==========================================================

  let previousState = {};

  if (fs.existsSync(STATE_FILE)) {

    try {

      const savedState =
        JSON.parse(
          fs.readFileSync(
            STATE_FILE,
            'utf8'
          )
        );

      if (savedState.date === localDate) {

        previousState =
          savedState.buses ?? {};

        console.log(
          `Loaded rare-bus state for ${localDate}.`
        );

      } else {

        console.log(
          `New day detected: ${
            savedState.date ?? "none"
          } -> ${localDate}`
        );

        console.log(
          "Starting with a fresh rare-bus state."
        );

        previousState = {};
      }

    } catch (err) {

      console.warn(
        "Could not read rare-bus state:",
        err.message
      );

      previousState = {};
    }

  } else {

    console.log(
      "No rare-bus state file exists yet."
    );
  }


  // ==========================================================
  // Fetch buses
  // ==========================================================

  const activeBuses = [];

  for (const api of API_URLS) {

    try {

      const response =
        await fetch(api.url);

      if (!response.ok) {

        console.error(
          `Failed to fetch ${api.name}: HTTP ${response.status}`
        );

        continue;
      }

      const data =
        await response.json();

      if (!Array.isArray(data)) {

        console.error(
          `${api.name} returned unexpected data.`
        );

        continue;
      }

      for (const vehicle of data) {

        activeBuses.push({
          ...vehicle,
          operator: api.operator,
          operatorName: api.name
        });
      }

    } catch (err) {

      console.error(
        `Failed to fetch from ${api.name}:`,
        err.message
      );
    }
  }


  // ==========================================================
  // Resolve duplicate vehicle entries
  //
  // The API can apparently return the same vehicle more than
  // once, sometimes with different routes.
  //
  // Example:
  //
  // transmixt:53 -> route 1
  // transmixt:53 -> route 476
  //
  // We resolve this BEFORE sending notifications.
  // ==========================================================

  const busesByKey = new Map();

  for (const bus of activeBuses) {

    const key =
      `${bus.operator}:${bus.vehicleId}`;

    if (!busesByKey.has(key)) {

      busesByKey.set(key, []);

    }

    busesByKey.get(key).push(bus);
  }


  // ==========================================================
  // Build one definitive entry per vehicle
  // ==========================================================

  const resolvedBuses = [];

  for (const [key, entries] of busesByKey.entries()) {

    if (entries.length === 1) {

      resolvedBuses.push(entries[0]);
      continue;
    }

    console.log(
      `Duplicate API entries found for ${key}: ${entries.length}`
    );

    const previousRoute =
      previousState[key];

    // Convert each entry to a route string.
    const routes = entries.map(entry => {

      const routeInfo =
        routesMeta[
          entry.operator
        ]?.[
          String(entry.routeId)
        ];

      return {
        bus: entry,
        route:
          String(
            routeInfo?.indicative ??
            entry.routeId
          )
      };
    });

    console.log(
      `${key} reported routes: ${routes.map(r => r.route).join(', ')}`
    );

    // --------------------------------------------------------
    // If we already know this bus's previous route, prefer
    // a route that is DIFFERENT from the previous route.
    //
    // This handles:
    //
    // previous: 1
    // API:      1 + 476
    //
    // Result:   476
    // --------------------------------------------------------

    if (previousRoute !== undefined) {

      const changedRoute =
        routes.find(
          item => item.route !== String(previousRoute)
        );

      if (changedRoute) {

        console.log(
          `${key}: choosing changed route ${changedRoute.route} over previous route ${previousRoute}.`
        );

        resolvedBuses.push(
          changedRoute.bus
        );

        continue;
      }
    }

    // --------------------------------------------------------
    // Otherwise use the first API entry.
    // --------------------------------------------------------

    console.log(
      `${key}: no clear route change; using first API entry.`
    );

    resolvedBuses.push(
      entries[0]
    );
  }


  // ==========================================================
  // Start today's state with previous state
  //
  // IMPORTANT:
  // A missing bus is NOT removed.
  //
  // This prevents:
  //
  // bus disappears
  // -> bus reappears
  // -> duplicate alert
  // ==========================================================

  const currentState = {
    ...previousState
  };


  // ==========================================================
  // Evaluate each unique vehicle ONCE
  // ==========================================================

  for (const bus of resolvedBuses) {

    const key =
      `${bus.operator}:${bus.vehicleId}`;

    const vehicleInfo =
      vehiclesMeta[
        bus.operator
      ]?.[
        String(bus.vehicleId)
      ];

    const routeInfo =
      routesMeta[
        bus.operator
      ]?.[
        String(bus.routeId)
      ];

    const licensePlate =
      vehicleInfo?.licensePlate ??
      `Vehicle ${bus.vehicleId}`;

    const model =
      vehicleInfo?.model ??
      "Unknown Model";

    const routeIndicative =
      routeInfo?.indicative ??
      String(bus.routeId);

    const assignedRoutes =
      vehicleInfo?.assignedRoutes ?? [];


    // --------------------------------------------------------
    // Rare bus
    // --------------------------------------------------------

    const isRare =
      RARE_VEHICLES.has(key) ||
      (
        vehicleInfo?.licensePlate &&
        RARE_VEHICLES.has(
          vehicleInfo.licensePlate
        )
      );

    const isTargetRoute =
      TARGET_ROUTES.length === 0 ||
      TARGET_ROUTES.includes(
        String(bus.routeId)
      );


    // --------------------------------------------------------
    // Unusual route
    // --------------------------------------------------------

    const isUnusualRoute =
      assignedRoutes.length > 0 &&
      !assignedRoutes.includes(
        routeIndicative
      );


    // --------------------------------------------------------
    // Rare-bus notification
    // --------------------------------------------------------

    let sentRareNotification = false;

    if (isRare && isTargetRoute) {

      const currentRoute =
        String(routeIndicative);

      const previousRoute =
        previousState[key];

      if (
        previousRoute === undefined
      ) {

        console.log(
          `${key}: first sighting today on line ${currentRoute}.`
        );

        const content =
          `${licensePlate} (${model}) e pe linia ${routeIndicative}`;

        const sent =
          await sendDiscord(
            webhookUrl,
            content
          );

        if (sent) {
          sentRareNotification = true;
        }

      } else if (
        String(previousRoute) !== currentRoute
      ) {

        console.log(
          `${key}: route changed ${previousRoute} -> ${currentRoute}.`
        );

        const content =
          `${licensePlate} (${model}) e pe linia ${routeIndicative}`;

        const sent =
          await sendDiscord(
            webhookUrl,
            content
          );

        if (sent) {
          sentRareNotification = true;
        }

      } else {

        console.log(
          `${key} still on line ${currentRoute}; no rare-bus notification needed.`
        );
      }


      // Always remember the latest resolved route.
      currentState[key] =
        currentRoute;
    }


    // --------------------------------------------------------
    // Unusual-route notification
    //
    // Do NOT send another message if the rare-bus check already
    // sent one for this same bus during this run.
    // --------------------------------------------------------

    if (
      isUnusualRoute &&
      !sentRareNotification &&
      !(isRare && isTargetRoute)
    ) {

      const content =
        `${licensePlate} (${model}) e pe linia ${routeIndicative}`;

      await sendDiscord(
        webhookUrl,
        content
      );
    }
  }


  // ==========================================================
  // Create final state
  // ==========================================================

  const finalState = {
    date: localDate,
    buses: currentState
  };


  // ==========================================================
  // Show state in Actions log
  //
  // This makes debugging much easier.
  // ==========================================================

  console.log(
    "Final rare-bus state:"
  );

  console.log(
    JSON.stringify(
      finalState,
      null,
      2
    )
  );


  // ==========================================================
  // Write state locally
  // ==========================================================

  writeStateFile(
    finalState
  );

  console.log(
    `Rare-bus state written to ${STATE_FILE}.`
  );


  // ==========================================================
  // Commit + push
  // ==========================================================

  const pushSuccessful =
    persistStateToGit();


  // ==========================================================
  // Do NOT silently continue if persistence failed
  // ==========================================================

  if (!pushSuccessful) {

    console.error(
      "ERROR: Rare-bus state could not be persisted to GitHub."
    );

    process.exit(1);
  }


  console.log(
    "Bus checker completed successfully."
  );
}


run();
