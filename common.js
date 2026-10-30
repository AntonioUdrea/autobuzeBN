/*
 * common.js: code shared by the web pages AND the GitHub Action scripts.
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

  const ON_TIME_SECONDS = 60;
  const FETCH_TIMEOUT_MS = 8000;
  const TIME_ZONE = "Europe/Bucharest";


  // ============================================================
  // Small helpers
  // ============================================================

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  async function fetchJson(url, label = url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${label} returned ${response.status}`);
    return response.json();
  }

  const dateFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  });

  const timeFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });

  function bucharestDate(date = new Date()) {
    return dateFormat.format(date);
  }

  function bucharestTime(date = new Date()) {
    return timeFormat.format(date);
  }

  function formatTime(iso) {
    return iso ? bucharestTime(new Date(iso)) : "";
  }

  function toMinutes(hhmm) {
    const [h, m] = String(hhmm).split(":").map(Number);
    return h * 60 + m;
  }


  // ============================================================
  // Vehicle helpers
  // ============================================================

  function describeDelay(seconds) {
    const minutes = Math.round(Math.abs(seconds) / 60);
    if (seconds > ON_TIME_SECONDS) return { kind: "late", minutes };
    if (seconds < -ON_TIME_SECONDS) return { kind: "early", minutes };
    return { kind: "ontime", minutes };
  }

  function getPosition(v) {
    const lat = Number(v.latitude ?? v.lat ?? v.position?.latitude ?? v.position?.lat);
    const lng = Number(v.longitude ?? v.lng ?? v.lon ?? v.position?.longitude ?? v.position?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }


  // ============================================================
  // Loading data
  // ============================================================

  async function loadLocalData() {
    const [vehicles, routes] = await Promise.all([
      fetchJson("data/vehicles.json", "data/vehicles.json"),
      fetchJson("data/routes.json", "data/routes.json")
    ]);
    return { vehicles, routes };
  }

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

  // stops and routes
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
  // local data + api data combined
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
