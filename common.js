/*
 * common.js: code shared by the web pages AND the GitHub Action scripts.
 *
 * Before this file existed, the API URLs, escapeHtml(), formatTime(), the stops
 * loading and the "which direction is this bus going" logic were copy-pasted in
 * app.js, list.html and check-buses.js. Now there is one copy.
 *
 * One file, two environments:
 *   Browser:  <script src="common.js"></script>      then   Common.fetchAllVehicles()
 *   Node:     const Common = require("./common.js"); then   Common.fetchAllVehicles()
 * The wrapper right below is what makes that work. Everything inside the
 * function is private unless it appears in the `return { ... }` at the bottom.
 *
 * Nothing in here keeps hidden global state. Functions that need your local
 * data (vehicles.json, routes.json, stops) receive it as an argument called
 * `ctx`, so they behave the same in the browser and in Node:
 *
 *   ctx = { vehicles, routes, stops, patterns }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();   // Node
  } else {
    root.Common = factory();      // Browser: window.Common
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ============================================================
  // Settings
  // ============================================================

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

  const OPERATOR_NAMES = Object.fromEntries(API_URLS.map(a => [a.operator, a.name]));

  const ON_TIME_SECONDS = 60;      // within +/- 1 minute counts as on time
  const FETCH_TIMEOUT_MS = 8000;   // give up on a slow API instead of hanging
  const TIME_ZONE = "Europe/Bucharest";


  // ============================================================
  // Small helpers
  // ============================================================

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  }

  // "2" < "10" instead of "10" < "2"
  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  async function fetchJson(url, label = url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${label} returned ${response.status}`);
    return response.json();
  }


  // ============================================================
  // Dates and times (always Bucharest time, whatever the machine's zone is.
  // GitHub runners use UTC, so this matters.)
  // ============================================================

  const dateFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  });

  const timeFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });

  /** "2026-10-15" */
  function bucharestDate(date = new Date()) {
    return dateFormat.format(date);
  }

  /** "14:05" */
  function bucharestTime(date = new Date()) {
    return timeFormat.format(date);
  }

  /** ISO timestamp from the API -> "14:05" (empty string if missing) */
  function formatTime(iso) {
    return iso ? bucharestTime(new Date(iso)) : "";
  }

  /** "14:05" -> 845 (minutes since midnight) */
  function toMinutes(hhmm) {
    const [h, m] = String(hhmm).split(":").map(Number);
    return h * 60 + m;
  }


  // ============================================================
  // Vehicle helpers
  // ============================================================

  /** seconds -> { kind: "late" | "early" | "ontime", minutes }. Each page words it its own way. */
  function describeDelay(seconds) {
    const minutes = Math.round(Math.abs(seconds) / 60);
    if (seconds > ON_TIME_SECONDS) return { kind: "late", minutes };
    if (seconds < -ON_TIME_SECONDS) return { kind: "early", minutes };
    return { kind: "ontime", minutes };
  }

  // The APIs don't always use the same field names, so try the known ones.
  // Returns [lat, lng] or null.
  function getPosition(v) {
    const lat = Number(v.latitude ?? v.lat ?? v.position?.latitude ?? v.position?.lat);
    const lng = Number(v.longitude ?? v.lng ?? v.lon ?? v.position?.longitude ?? v.position?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }


  // ============================================================
  // Loading data
  // ============================================================

  /** Browser only: your own data files. */
  async function loadLocalData() {
    const [vehicles, routes] = await Promise.all([
      fetchJson("data/vehicles.json", "data/vehicles.json"),
      fetchJson("data/routes.json", "data/routes.json")
    ]);
    return { vehicles, routes };
  }

  /**
   * Live vehicles from every operator, in parallel.
   * One operator being down doesn't stop the other:
   *   { buses: [...], failed: ["Ani Tour"] }
   */
  async function fetchAllVehicles() {
    const results = await Promise.allSettled(API_URLS.map(async api => {
      const data = await fetchJson(api.url, `${api.name} API`);
      if (!Array.isArray(data)) throw new Error(`${api.name} API did not return an array`);
      return data.map(v => ({ ...v, operator: api.operator, operatorName: api.name }));
    }));

    const buses = [];
    const failed = [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        buses.push(...result.value);
      } else {
        failed.push(API_URLS[i].name);
        console.error(`Could not load ${API_URLS[i].name}:`, result.reason);
      }
    });

    return { buses, failed };
  }

  /**
   * Stop names plus the first/last stop of each route pattern.
   *   stops:    { operator: { stopId: "Stop name" } }
   *   patterns: { operator: { "routeId:patternIndex": { from, to } } }
   * Never throws; a failed operator just gets empty objects.
   */
  async function fetchStops() {
    const stops = {};
    const patterns = {};

    const results = await Promise.allSettled(API_URLS.map(api =>
      fetchJson(api.url.replace(/vehicles$/, "stops"), `${api.name} stops API`)));

    results.forEach((result, i) => {
      const { operator, name } = API_URLS[i];
      stops[operator] = {};
      patterns[operator] = {};

      if (result.status !== "fulfilled" || !Array.isArray(result.value)) {
        console.error(`Could not load stops for ${name}:`, result.reason);
        return;
      }

      for (const stop of result.value) {
        stops[operator][stop.id] = stop.name;

        for (const p of stop.patterns ?? []) {
          patterns[operator][`${p.routeId}:${p.index}`] ??= { from: p.fromStopId, to: p.toStopId };
        }
      }
    });

    return { stops, patterns };
  }


  // ============================================================
  // Enrich: raw API vehicle + your local data = everything a page needs
  // ============================================================

  /**
   * Adds these fields on top of everything the API sent (lat/lng, delaySeconds, ...):
   *
   *   id, key            "53", "transmixt:53"
   *   routeKey           "transmixt|10"       (handy as a <select> value)
   *   routeKnown         false if routes.json doesn't know this route yet
   *   routeIndicative    "10"                 (the line number people see)
   *   licensePlate       real plate, or "Unknown"
   *   model              real model, or "Unknown"
   *   unknownPlate/Model true/false
   *   assignedRoutes     from vehicles.json, [] if none
   *   destination        "Gara"                (headsign, else the pattern's last stop,
   *                                             else routes.json, else "Unknown")
   *   direction          "Piața → Gara"        (same, but with the first stop too)
   *   stopName           the stop the bus is at or heading to ("" if none)
   */
  function enrichVehicle(bus, ctx) {
    const { operator } = bus;

    const routeInfo = ctx.routes[operator]?.[String(bus.routeId)];
    const vehicleInfo = ctx.vehicles[operator]?.[String(bus.vehicleId)];

    const stopName = id => ctx.stops[operator]?.[id] ?? "";

    // The API has no direction field. patternIndex 1-10 = direction 0, 11+ = direction 1,
    // negative = out of service.
    const pattern = ctx.patterns[operator]?.[`${bus.routeId}:${bus.patternIndex}`];
    const first = pattern ? stopName(pattern.from) : "";
    const last = pattern ? stopName(pattern.to) : "";
    const patternUsable = Boolean(pattern && pattern.from !== pattern.to && first && last);

    const directionIndex = bus.patternIndex < 0 ? -1 : bus.patternIndex >= 11 ? 1 : 0;
    const fromRoutesJson = routeInfo?.directions?.[String(directionIndex)] || "";
    const headsign = bus.headsign?.trim() || "";

    const plate = vehicleInfo?.licensePlate ? String(vehicleInfo.licensePlate) : "";
    const model = vehicleInfo?.model ? String(vehicleInfo.model) : "";
    const unknownPlate = !plate || plate.toLowerCase() === "unknown";
    const unknownModel = !model || model.toLowerCase() === "unknown";

    return {
      ...bus,

      id: String(bus.vehicleId),
      key: `${operator}:${bus.vehicleId}`,

      routeKey: `${operator}|${bus.routeId}`,
      routeKnown: Boolean(routeInfo),
      routeIndicative: String(routeInfo?.indicative ?? bus.routeId),

      licensePlate: unknownPlate ? "Unknown" : plate,
      model: unknownModel ? "Unknown" : model,
      unknownPlate,
      unknownModel,
      assignedRoutes: vehicleInfo?.assignedRoutes ?? [],

      destination: headsign || (patternUsable ? last : "") || fromRoutesJson || "Unknown",
      direction: headsign || (patternUsable ? `${first} \u2192 ${last}` : "") || fromRoutesJson || "Unknown",

      stopName: bus.stopId != null ? (stopName(bus.stopId) || `Stop ${bus.stopId}`) : ""
    };
  }


  return {
    API_URLS,
    OPERATOR_NAMES,
    ON_TIME_SECONDS,
    escapeHtml,
    naturalCompare,
    fetchJson,
    bucharestDate,
    bucharestTime,
    formatTime,
    toMinutes,
    describeDelay,
    getPosition,
    loadLocalData,
    fetchAllVehicles,
    fetchStops,
    enrichVehicle
  };
});
