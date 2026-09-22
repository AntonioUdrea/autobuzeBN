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

// Rare vehicles.
// Format: "operator:vehicleId"
const RARE_VEHICLES = new Set([
  "transmixt:41",
  "transmixt:53",
  "transmixt:62",
  "transmixt:133",
  "transmixt:145"
]);

// Leave [] to allow all routes.
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
      body: JSON.stringify({
        content
      })
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
// Write state safely
// ============================================================

function writeStateFile(state) {
  fs.mkdirSync('data', {
    recursive: true
  });

  const temporaryFile =
    `${STATE_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(state, null, 2) + '\n',
    'utf8'
  );

  fs.renameSync(
    temporaryFile,
    STATE_FILE
  );
}


// ============================================================
// Commit + push state
// ============================================================

function persistStateToGit() {
  try {

    execSync(
      `git config user.name "github-actions[bot]"`,
      {
        stdio: 'inherit'
      }
    );

    execSync(
      `git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`,
      {
        stdio: 'inherit'
      }
    );


    console.log(
      "Fetching latest main..."
    );

    execSync(
      `git fetch origin main`,
      {
        stdio: 'inherit'
      }
    );


    execSync(
      `git add ${STATE_FILE}`,
      {
        stdio: 'inherit'
      }
    );


    let hasChanges = false;

    try {

      execSync(
        `git diff --cached --quiet -- ${STATE_FILE}`
      );

      console.log(
        "Git reports no change to bus state."
      );

    } catch {

      hasChanges = true;

      console.log(
        "Git detected a change to bus state."
      );
    }


    if (!hasChanges) {
      return true;
    }


    execSync(
      `git commit -m "Update bus alert state [skip ci]"`,
      {
        stdio: 'inherit'
      }
    );


    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {

      try {

        console.log(
          `Pushing state to main (attempt ${attempt}/3)...`
        );

        execSync(
          `git push origin HEAD:main`,
          {
            stdio: 'inherit'
          }
        );

        console.log(
          "Bus state successfully pushed."
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
          {
            stdio: 'inherit'
          }
        );

        execSync(
          `git rebase origin/main`,
          {
            stdio: 'inherit'
          }
        );
      }
    }


    return false;

  } catch (err) {

    console.error(
      "CRITICAL: Failed to persist bus state."
    );

    console.error(
      err.message
    );

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

  const timeString =
    now.toLocaleString("en-GB", {
      timeZone: "Europe/Bucharest",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });

  const [hour, minute] =
    timeString
      .split(":")
      .map(Number);

  const currentMinutes =
    hour * 60 + minute;

  const startMinutes =
    5 * 60;

  const stopMinutes =
    22 * 60 + 30;


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
  // Local Bucharest date
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
  // Discord
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

    if (
      fs.existsSync(
        'data/vehicles.json'
      )
    ) {

      vehiclesMeta =
        JSON.parse(
          fs.readFileSync(
            'data/vehicles.json',
            'utf8'
          )
        );
    }


    if (
      fs.existsSync(
        'data/routes.json'
      )
    ) {

      routesMeta =
        JSON.parse(
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
  // Load previous state
  //
  // The state now contains EVERY bus that has triggered
  // either a rare-bus or unusual-route alert.
  //
  // Example:
  //
  // {
  //   "date": "2026-09-22",
  //   "buses": {
  //     "transmixt:53": {
  //       "route": "1",
  //       "rare": true,
  //       "unusual": false
  //     },
  //     "transmixt:62": {
  //       "route": "476",
  //       "rare": false,
  //       "unusual": true
  //     }
  //   }
  // }
  // ==========================================================

  let previousState = {};


  if (
    fs.existsSync(
      STATE_FILE
    )
  ) {

    try {

      const savedState =
        JSON.parse(
          fs.readFileSync(
            STATE_FILE,
            'utf8'
          )
        );


      if (
        savedState.date === localDate
      ) {

        previousState =
          savedState.buses ?? {};


        console.log(
          `Loaded bus alert state for ${localDate}.`
        );


        console.log(
          `Previously stored buses: ${
            Object.keys(previousState).length
          }`
        );

      } else {

        console.log(
          `New day detected: ${
            savedState.date ?? "none"
          } -> ${localDate}.`
        );

        console.log(
          "Resetting bus alert state."
        );

        previousState = {};
      }

    } catch (err) {

      console.warn(
        "Could not read bus alert state:",
        err.message
      );

      previousState = {};
    }

  } else {

    console.log(
      "No bus alert state file exists yet."
    );
  }


  // ==========================================================
  // Fetch all buses
  // ==========================================================

  const activeBuses = [];


  for (
    const api of API_URLS
  ) {

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


      if (
        !Array.isArray(data)
      ) {

        console.error(
          `${api.name} returned unexpected data.`
        );

        continue;
      }


      for (
        const vehicle of data
      ) {

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
  // Group API entries by vehicle ID
  //
  // This only groups duplicate API records belonging to the
  // SAME vehicle ID.
  //
  // Different vehicle IDs remain completely independent.
  // ==========================================================

  const busesByKey =
    new Map();


  for (
    const bus of activeBuses
  ) {

    const key =
      `${bus.operator}:${bus.vehicleId}`;


    if (
      !busesByKey.has(key)
    ) {

      busesByKey.set(
        key,
        []
      );
    }


    busesByKey
      .get(key)
      .push(bus);
  }


  // ==========================================================
  // Resolve duplicate API entries
  // ==========================================================

  const resolvedBuses = [];


  for (
    const [key, entries]
    of busesByKey.entries()
  ) {

    if (
      entries.length === 1
    ) {

      resolvedBuses.push(
        entries[0]
      );

      continue;
    }


    console.log(
      `Duplicate API entries for ${key}: ${entries.length}`
    );


    const previousEntry =
      previousState[key];


    const previousRoute =
      previousEntry?.route ??
      previousEntry;


    const candidates =
      entries.map(
        entry => {

          const routeInfo =
            routesMeta[
              entry.operator
            ]?.[
              String(entry.routeId)
            ];


          return {
            bus: entry,

            route: String(
              routeInfo?.indicative ??
              entry.routeId
            )
          };
        }
      );


    console.log(
      `${key} API routes: ${
        candidates
          .map(
            item => item.route
          )
          .join(', ')
      }`
    );


    // If we already know this vehicle's previous route,
    // prefer a candidate representing a route change.
    if (
      previousRoute !== undefined
    ) {

      const changed =
        candidates.find(
          candidate =>
            candidate.route !==
            String(previousRoute)
        );


      if (changed) {

        console.log(
          `${key}: selecting changed route ${changed.route}.`
        );

        resolvedBuses.push(
          changed.bus
        );

        continue;
      }
    }


    // Otherwise use the first API entry.
    resolvedBuses.push(
      entries[0]
    );
  }


  // ==========================================================
  // Start with ALL previous state.
  //
  // If a bus disappears temporarily from the API, its last
  // known state remains here.
  // ==========================================================

  const currentState = {
    ...previousState
  };


  // ==========================================================
  // Process every resolved vehicle
  // ==========================================================

  for (
    const bus of resolvedBuses
  ) {

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
      vehicleInfo?.assignedRoutes ??
      [];


    // --------------------------------------------------------
    // Rare check
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
    // Unusual route check
    // --------------------------------------------------------

    const isUnusualRoute =
      assignedRoutes.length > 0 &&
      !assignedRoutes.includes(
        routeIndicative
      );


    // --------------------------------------------------------
    // Previous state for THIS vehicle
    // --------------------------------------------------------

    const previousEntry =
      previousState[key];


    const previousRoute =
      previousEntry?.route ??
      previousEntry;


    const currentRoute =
      String(routeIndicative);


    // --------------------------------------------------------
    // Determine whether a notification is needed
    // --------------------------------------------------------

    const rareAlertNeeded =
      isRare &&
      isTargetRoute &&
      (
        previousRoute === undefined ||
        String(previousRoute) !== currentRoute
      );


    const unusualAlertNeeded =
      isUnusualRoute &&
      (
        previousRoute === undefined ||
        String(previousRoute) !== currentRoute
      );


    const shouldNotify =
      rareAlertNeeded ||
      unusualAlertNeeded;


    // --------------------------------------------------------
    // Log current classification
    // --------------------------------------------------------

    console.log(
      `${key}: route ${currentRoute} | ` +
      `rare=${isRare} | ` +
      `unusual=${isUnusualRoute} | ` +
      `rareAlert=${rareAlertNeeded} | ` +
      `unusualAlert=${unusualAlertNeeded}`
    );


    // --------------------------------------------------------
    // Send ONE notification only
    //
    // If a bus is both rare and unusual, it still gets only
    // one Discord message.
    // --------------------------------------------------------

    if (
      shouldNotify
    ) {

      const content =
        `${licensePlate} (${model}) e pe linia ${routeIndicative}`;


      const notificationSent =
        await sendDiscord(
          webhookUrl,
          content
        );


      // ------------------------------------------------------
      // Only advance the state if Discord successfully
      // received the notification.
      //
      // If Discord failed, the old state remains so the next
      // run can retry the alert.
      // ------------------------------------------------------

      if (
        !notificationSent
      ) {

        console.error(
          `${key}: notification failed; keeping previous state.`
        );

        continue;
      }


      console.log(
        `${key}: alert sent successfully.`
      );
    }


    // --------------------------------------------------------
    // Store this vehicle independently.
    //
    // This happens for:
    //
    // 1. Rare buses
    // 2. Unusual-route buses
    //
    // It does NOT store ordinary buses that triggered no alert.
    // --------------------------------------------------------

    if (
      isRare ||
      isUnusualRoute ||
      previousState[key]
    ) {

      currentState[key] = {
        route: currentRoute,
        rare: isRare,
        unusual: isUnusualRoute
      };
    }
  }


  // ==========================================================
  // Final state
  // ==========================================================

  const finalState = {
    date: localDate,
    buses: currentState
  };


  // ==========================================================
  // Show every stored vehicle
  // ==========================================================

  console.log(
    `Storing ${
      Object.keys(currentState).length
    } bus(es) in state:`
  );


  for (
    const [key, data]
    of Object.entries(currentState)
  ) {

    console.log(
      `  ${key} -> line ${data.route} | ` +
      `rare=${data.rare} | ` +
      `unusual=${data.unusual}`
    );
  }


  // ==========================================================
  // Write state
  // ==========================================================

  writeStateFile(
    finalState
  );


  console.log(
    `Bus alert state written to ${STATE_FILE}.`
  );


  // ==========================================================
  // Persist state to GitHub
  // ==========================================================

  const pushSuccessful =
    persistStateToGit();


  if (
    !pushSuccessful
  ) {

    console.error(
      "ERROR: Bus alert state could not be persisted to GitHub."
    );

    process.exit(1);
  }


  console.log(
    "Bus checker completed successfully."
  );
}


run();
