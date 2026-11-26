
/*
 * common.js: code shared by the web pages AND the GitHub Action scripts.
 *
 * External API requests go through Cloudflare.
 * Local JSON files are fetched directly.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Common = factory();
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

  const OPERATOR_NAMES = Object.fromEntries(
    API_URLS.map(a => [a.operator, a.name])
  );

  const ON_TIME_SECONDS = 60;
  const FETCH_TIMEOUT_MS = 15000;
  const TIME_ZONE = "Europe/Bucharest";

  // Cloudflare proxy for external API requests.
  const PROXY_URL =
    "https://bus-proxy.ericantonio-udrea.workers.dev/";

  // Both browser and GitHub Actions use the proxy.
  const viaProxy = url =>
    `${PROXY_URL}?url=${encodeURIComponent(url)}`;


  // ============================================================
  // Small helpers
  // ============================================================

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, c =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;"
      }[c])
    );
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(
      String(b),
      undefined,
      { numeric: true }
    );
  }


  // ============================================================
  // API / JSON fetching
  // ============================================================

  async function fetchJson(url, label = url) {
    // Local files must NOT go through the Cloudflare proxy.
    // External HTTP/HTTPS APIs MUST go through the proxy.
    const isExternal = /^https?:\/\//i.test(url);

    const requestUrl = isExternal
      ? viaProxy(url)
      : url;

    console.log(`[FETCH] ${label}`);

    console.log(
      `[FETCH] Route: ${isExternal ? "Cloudflare proxy" : "Local/direct"}`
    );

    let response;

    try {
      response = await fetch(requestUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (err) {
      console.error(
        `[FETCH] Network error (${label}):`,
        err.message
      );

      throw new Error(
        `${label}: Network error - ${err.message}`
      );
    }

    console.log(
      `[FETCH] ${label}: HTTP ${response.status}`
    );

    const body = await response.text();

    if (!response.ok) {
      console.error(
        `[FETCH] ${label} failed:`,
        body.slice(0, 500)
      );

      throw new Error(
        `${label} returned HTTP ${response.status}: ${body.slice(0, 500)}`
      );
    }

    try {
      return JSON.parse(body);
    } catch {
      console.error(
        `[FETCH] Invalid JSON from ${label}:`,
        body.slice(0, 500)
      );

      throw new Error(
        `${label} returned invalid JSON`
      );
    }
  }


  // ============================================================
  // Date and time
  // ============================================================

  const dateFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const timeFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
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

    if (seconds > ON_TIME_SECONDS) {
      return { kind: "late", minutes };
    }

    if (seconds < -ON_TIME_SECONDS) {
      return { kind: "early", minutes };
    }

    return { kind: "ontime", minutes };
  }

  function getPosition(v) {
    const lat = Number(
      v.latitude ??
      v.lat ??
      v.position?.latitude ??
      v.position?.lat
    );

    const lng = Number(
      v.longitude ??
      v.lng ??
      v.lon ??
      v.position?.longitude ??
      v.position?.lng
    );

    return Number.isFinite(lat) && Number.isFinite(lng)
      ? [lat, lng]
      : null;
  }


  // ============================================================
  // Loading local data
  // ============================================================

  async function loadLocalData() {
    const [vehicles, routes] = await Promise.all([
      fetchJson("data/vehicles.json", "data/vehicles.json"),
      fetchJson("data/routes.json", "data/routes.json")
    ]);

    return { vehicles, routes };
  }


  // ============================================================
  // Fetch vehicles
  // ============================================================

  async function fetchAllVehicles() {
    console.log("========== FETCHING VEHICLES ==========");

    const results = await Promise.allSettled(
      API_URLS.map(async api => {
        const data = await fetchJson(
          api.url,
          `${api.name} API`
        );

        if (!Array.isArray(data)) {
          throw new Error(
            `${api.name} API did not return an array`
          );
        }

        console.log(
          `[API] ${api.name}: received ${data.length} vehicles`
        );

        return data.map(v => ({
          ...v,
          operator: api.operator,
          operatorName: api.name
        }));
      })
    );

    const buses = [];
    const failed = [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        buses.push(...result.value);
      } else {
        failed.push(API_URLS[i].name);

        console.error(
          `[API] Could not load ${API_URLS[i].name}:`,
          result.reason
        );
      }
    });

    console.log(
      `[API] Total vehicles received: ${buses.length}`
    );

    console.log("=======================================");

    return { buses, failed };
  }


  // ============================================================
  // Fetch stops and patterns
  // ============================================================

  async function fetchStops() {
    console.log("========== FETCHING STOPS ==========");

    const stops = {};
    const patterns = {};

    const results = await Promise.allSettled(
      API_URLS.map(api =>
        fetchJson(
          api.url.replace(/vehicles$/, "stops"),
          `${api.name} stops API`
        )
      )
    );

    results.forEach((result, i) => {
      const { operator, name } = API_URLS[i];

      stops[operator] = {};
      patterns[operator] = {};

      if (
        result.status !== "fulfilled" ||
        !Array.isArray(result.value)
      ) {
        console.error(
          `[API] Could not load stops for ${name}:`,
          result.status === "rejected"
            ? result.reason
            : "Invalid response format"
        );

        return;
      }

      console.log(
        `[API] ${name}: received ${result.value.length} stops`
      );

      for (const stop of result.value) {
        stops[operator][stop.id] = stop.name;

        for (const p of stop.patterns ?? []) {
          patterns[operator][`${p.routeId}:${p.index}`] ??= {
            from: p.fromStopId,
            to: p.toStopId
          };
        }
      }
    });

    console.log("====================================");

    return { stops, patterns };
  }


  // ============================================================
  // Enrich vehicle information
  // ============================================================

  function enrichVehicle(bus, ctx) {
    const { operator } = bus;

    const routeInfo =
      ctx.routes[operator]?.[String(bus.routeId)];

    const vehicleInfo =
      ctx.vehicles[operator]?.[String(bus.vehicleId)];

    const stopName = id =>
      ctx.stops[operator]?.[id] ?? "";

    const pattern =
      ctx.patterns[operator]?.[
        `${bus.routeId}:${bus.patternIndex}`
      ];

    const first = pattern
      ? stopName(pattern.from)
      : "";

    const last = pattern
      ? stopName(pattern.to)
      : "";

    const patternUsable = Boolean(
      pattern &&
      pattern.from !== pattern.to &&
      first &&
      last
    );

    const directionIndex =
      bus.patternIndex < 0
        ? -1
        : bus.patternIndex >= 11
          ? 1
          : 0;

    const fromRoutesJson =
      routeInfo?.directions?.[String(directionIndex)] || "";

    const headsign = bus.headsign?.trim() || "";

    const plate = vehicleInfo?.licensePlate
      ? String(vehicleInfo.licensePlate)
      : "";

    const model = vehicleInfo?.model
      ? String(vehicleInfo.model)
      : "";

    const unknownPlate =
      !plate || plate.toLowerCase() === "unknown";

    const unknownModel =
      !model || model.toLowerCase() === "unknown";

    return {
      ...bus,

      id: String(bus.vehicleId),
      key: `${operator}:${bus.vehicleId}`,

      routeKey: `${operator}|${bus.routeId}`,
      routeKnown: Boolean(routeInfo),

      routeIndicative: String(
        routeInfo?.indicative ?? bus.routeId
      ),

      licensePlate: unknownPlate ? "Unknown" : plate,
      model: unknownModel ? "Unknown" : model,

      unknownPlate,
      unknownModel,

      assignedRoutes: vehicleInfo?.assignedRoutes ?? [],

      destination:
        headsign ||
        (patternUsable ? last : "") ||
        fromRoutesJson ||
        "Unknown",

      direction:
        headsign ||
        (patternUsable ? `${first} → ${last}` : "") ||
        fromRoutesJson ||
        "Unknown",

      stopName:
        bus.stopId != null
          ? (stopName(bus.stopId) || `Stop ${bus.stopId}`)
          : ""
    };
  }


  // ============================================================
  // Exports
  // ============================================================

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
