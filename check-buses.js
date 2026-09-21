const fs = require('fs');

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
  "transmixt:41,53,62,133,145"
]);

// Optionally restrict rare bus alerts to specific routes (leave [] for all routes)
const TARGET_ROUTES = []; 



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

  const startMinutes = 5 * 60;          // 05:00 AM (300 mins)
  const stopMinutes = 22 * 60 + 30;     // 10:30 PM (1350 mins)

  // Skip if time is at/after 22:30 OR before 05:00
  if (currentMinutes >= stopMinutes || currentMinutes < startMinutes) {
    console.log(`Skipping: Outside active bus hours (${timeString} local time).`);
    return;
  }
  // ------------------------------------------------------------
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("Missing DISCORD_WEBHOOK_URL environment variable.");
    process.exit(1);
  }

  let vehiclesMeta = {};
  let routesMeta = {};

  try {
    if (fs.existsSync('data/vehicles.json')) {
      vehiclesMeta = JSON.parse(fs.readFileSync('data/vehicles.json', 'utf8'));
    }
    if (fs.existsSync('data/routes.json')) {
      routesMeta = JSON.parse(fs.readFileSync('data/routes.json', 'utf8'));
    }
  } catch (err) {
    console.warn("Warning loading local metadata:", err.message);
  }

  const activeBuses = [];

  for (const api of API_URLS) {
    try {
      const res = await fetch(api.url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          data.forEach(v => activeBuses.push({ ...v, operator: api.operator, operatorName: api.name }));
        }
      }
    } catch (err) {
      console.error(`Failed to fetch from ${api.name}:`, err.message);
    }
  }

  // Main evaluation loop
  for (const bus of activeBuses) {
    const key = `${bus.operator}:${bus.vehicleId}`;
    const vehicleInfo = vehiclesMeta[bus.operator]?.[String(bus.vehicleId)];
    const routeInfo = routesMeta[bus.operator]?.[String(bus.routeId)];

    const licensePlate = vehicleInfo?.licensePlate ?? `Vehicle ${bus.vehicleId}`;
    const model = vehicleInfo?.model ?? "Unknown Model";
    
    // Resolve human-readable line number (indicative) from routes.json
    const routeIndicative = routeInfo?.indicative ?? String(bus.routeId);
    
    // Read assigned lines list from vehicles.json
    const assignedRoutes = vehicleInfo?.assignedRoutes ?? [];

    // 1. Rare Bus Check
    const isRare = RARE_VEHICLES.has(key) || (vehicleInfo?.licensePlate && RARE_VEHICLES.has(vehicleInfo.licensePlate));
    const isTargetRoute = TARGET_ROUTES.length === 0 || TARGET_ROUTES.includes(String(bus.routeId));

    if (isRare && isTargetRoute) {
      const content = `${licensePlate} (${model}) e pe linia ${routeIndicative}`;

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
    }

    // 2. Unusual Route Check (compares against indicative e.g. "1", "3", "5")
    if (assignedRoutes.length > 0 && !assignedRoutes.includes(routeIndicative)) {
      const content = `${licensePlate} (${model}) e pe linia ${routeIndicative}`;

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
    }
  }
}



run();
