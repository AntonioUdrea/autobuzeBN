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
// Helper: send Discord notification
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
// Helper: save state to disk
// ============================================================

function saveState(state) {
  fs.mkdirSync('data', { recursive: true });

  // Write to a temporary file first.
  // This prevents leaving a partially-written JSON file if
  // something goes wrong during the write.
  const tempFile = `${STATE_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(state, null, 2) + '\n',
    'utf8'
  );

  fs.renameSync(tempFile, STATE_FILE);
}


// ============================================================
// Helper: commit and push state robustly
// ============================================================

function commitAndPushState() {
  try {
    // --------------------------------------------------------
    // Configure Git identity
    // --------------------------------------------------------
    execSync(
      `git config user.name "github-actions[bot]"`,
      { stdio: 'inherit' }
    );

    execSync(
      `git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`,
      { stdio: 'inherit' }
    );

    // --------------------------------------------------------
    // Make sure we are working with the latest main branch
    // --------------------------------------------------------
    console.log("Fetching latest repository state...");

    execSync(
      `git fetch origin main`,
      { stdio: 'inherit' }
    );

    // --------------------------------------------------------
    // Stage our state file
    // --------------------------------------------------------
    execSync(
      `git add ${STATE_FILE}`,
      { stdio: 'inherit' }
    );

    // --------------------------------------------------------
    // Check whether there is actually anything to commit
    // --------------------------------------------------------
    try {
      execSync(
        `git diff --cached --quiet -- ${STATE_FILE}`
      );

      console.log("Rare bus state has not changed.");
      return true;

    } catch {
      // Exit code 1 means the staged file has changed.
      console.log("Rare bus state has changed.");
    }

    // --------------------------------------------------------
    // Commit
    // --------------------------------------------------------
    execSync(
      `git commit -m "Update rare bus state [skip ci]"`,
      { stdio: 'inherit' }
    );

    // --------------------------------------------------------
    // Push with retry logic
    // --------------------------------------------------------
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(
          `Pushing rare bus state (attempt ${attempt}/${maxAttempts})...`
        );

        execSync(
          `git push origin HEAD:main`,
          { stdio: 'inherit' }
        );

        console.log("Rare bus state successfully pushed.");
        return true;

      } catch (pushError) {
        console.error(
          `Git push failed on attempt ${attempt}.`
        );

        if (attempt === maxAttempts) {
          throw pushError;
        }

        // ------------------------------------------------------
        // Someone may have pushed to main while this job was
        // running. Fetch their changes and rebase our commit.
        // ------------------------------------------------------
        console.log(
          "Fetching latest main and rebasing before retry..."
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
      "CRITICAL: Failed to save rare bus state to GitHub."
    );

    console.error(err.message);

    return false;
  }
}


// ============================================================
// Main
// ============================================================

async function run() {

  // ------------------------------------------------------------
  // Time-of-Day Guard
  // Bistrița local time: Europe/Bucharest
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

  const startMinutes = 5 * 60;          // 05:00
  const stopMinutes = 22 * 60 + 30;     // 22:30

  if (
    currentMinutes >= stopMinutes ||
    currentMinutes < startMinutes
  ) {
    console.log(
      `Skipping: Outside active bus hours (${timeString} local time).`
    );

    return;
  }


  // ------------------------------------------------------------
  // Current local date
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
    console.error(
      "Missing DISCORD_WEBHOOK_URL environment variable."
    );

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
      "Warning loading local metadata:",
      err.message
    );
  }


  // ------------------------------------------------------------
  // Load previous rare-bus state
  // ------------------------------------------------------------

  let previousState = {};

  try {

    if (fs.existsSync(STATE_FILE)) {

      const savedState = JSON.parse(
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
            savedState.date ?? "no previous date"
          } -> ${localDate}.`
        );

        console.log(
          "Resetting rare-bus state for today."
        );

        previousState = {};
      }

    } else {

      console.log(
        "No previous rare-bus state found."
      );
    }

  } catch (err) {

    console.warn(
      "Warning loading rare-bus state:",
      err.message
    );

    previousState = {};
  }


  // ------------------------------------------------------------
  // Fetch active buses
  // ------------------------------------------------------------

  const activeBuses = [];

  for (const api of API_URLS) {

    try {

      const res = await fetch(api.url);

      if (!res.ok) {

        console.error(
          `Failed to fetch ${api.name}: HTTP ${res.status}`
        );

        continue;
      }

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

    } catch (err) {

      console.error(
        `Failed to fetch from ${api.name}:`,
        err.message
      );
    }
  }


  // ------------------------------------------------------------
  // IMPORTANT:
  //
  // Start with the previous state instead of an empty object.
  //
  // This means a bus that temporarily disappears from the API
  // remains remembered.
  // ------------------------------------------------------------

  const currentState = {
    ...previousState
  };


  // ------------------------------------------------------------
  // Main evaluation loop
  // ------------------------------------------------------------

  for (const bus of activeBuses) {

    const key =
      `${bus.operator}:${bus.vehicleId}`;

    const vehicleInfo =
      vehiclesMeta[bus.operator]?.[
        String(bus.vehicleId)
      ];

    const routeInfo =
      routesMeta[bus.operator]?.[
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


    // ----------------------------------------------------------
    // Determine whether this is a rare bus
    // ----------------------------------------------------------

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


    // ----------------------------------------------------------
    // Determine whether route is unusual
    // ----------------------------------------------------------

    const isUnusualRoute =
      assignedRoutes.length > 0 &&
      !assignedRoutes.includes(routeIndicative);


    // ----------------------------------------------------------
    // ONE notification maximum per bus per run
    // ----------------------------------------------------------

    if (isRare && isTargetRoute) {

      const currentRoute =
        String(routeIndicative);

      const previousRoute =
        previousState[key];


      // First sighting today OR route changed
      if (
        previousRoute === undefined ||
        previousRoute !== currentRoute
      ) {

        const content =
          `${licensePlate} (${model}) e pe linia ${routeIndicative}`;

        await sendDiscord(
          webhookUrl,
          content
        );

      } else {

        console.log(
          `${key} still on line ${currentRoute}; no rare-bus notification needed.`
        );
      }


      // Always remember the latest known route.
      currentState[key] =
        currentRoute;

    }


    // ----------------------------------------------------------
    // Unusual route notification
    //
    // Only send this if the bus was NOT already handled by the
    // rare-bus notification above.
    // ----------------------------------------------------------

    if (
      isUnusualRoute &&
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


  // ------------------------------------------------------------
  // Prepare state for saving
  // ------------------------------------------------------------

  const stateToSave = {
    date: localDate,
    buses: currentState
  };


  // ------------------------------------------------------------
  // Save state locally FIRST
  // ------------------------------------------------------------

  saveState(stateToSave);

  console.log(
    `Rare bus state written locally to ${STATE_FILE}.`
  );


  // ------------------------------------------------------------
  // Persist state to GitHub
  // ------------------------------------------------------------

  const pushSuccessful =
    commitAndPushState();


  // ------------------------------------------------------------
  // IMPORTANT:
  //
  // If GitHub persistence fails, fail the Action visibly.
  // This makes the problem obvious instead of silently
  // allowing duplicate alerts on the next run.
  // ------------------------------------------------------------

  if (!pushSuccessful) {

    console.error(
      "WARNING: Rare bus state could not be persisted to GitHub."
    );

    process.exit(1);
  }


  console.log(
    "Bus checker completed successfully."
  );
}


run();
