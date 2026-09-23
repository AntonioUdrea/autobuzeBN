
// ============================================================
// API CONFIGURATION
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


// ============================================================
// GLOBAL VARIABLES
// ============================================================

let VEHICLES = {};
let ROUTES = {};

let allVehicles = [];

let markers = {};

let selectedOperator = "all";
let selectedRoute = "all";
let selectedModel = "all";


// ============================================================
// MAP
// ============================================================

const map = L.map("map").setView(
  [47.133, 24.500],
  13
);

const markerBus = L.icon({
  iconUrl: "markerBus.png",
  iconSize: [75, 65],
  iconAnchor: [35, 32],
  popupAnchor: [0, -32]
});

L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }
).addTo(map);


// ============================================================
// LOAD LOCAL DATA
// ============================================================

async function loadLocalData() {

  const [
    vehiclesResponse,
    routesResponse
  ] = await Promise.all([
    fetch("data/vehicles.json"),
    fetch("data/routes.json")
  ]);

  if (!vehiclesResponse.ok) {
    throw new Error("Could not load data/vehicles.json");
  }

  if (!routesResponse.ok) {
    throw new Error("Could not load data/routes.json");
  }

  VEHICLES = await vehiclesResponse.json();
  ROUTES = await routesResponse.json();
}


// ============================================================
// ENRICH VEHICLE DATA
// ============================================================

function enrichVehicle(vehicle) {

  const operatorRoutes =
    ROUTES[vehicle.operator];

  const routeInfo =
    operatorRoutes?.[String(vehicle.routeId)];

  const directionName =
    routeInfo?.directions?.[String(vehicle.direction)];

  const vehicleInfo =
    VEHICLES[vehicle.operator]?.[
      String(vehicle.vehicleId)
    ];

  // Debug information
  if (!routeInfo) {

    console.warn(
      "Route not found:",
      {
        operator: vehicle.operator,
        routeId: vehicle.routeId,
        availableRoutes: operatorRoutes
          ? Object.keys(operatorRoutes)
          : "NO OPERATOR FOUND"
      }
    );
  }

  if (!directionName) {

    console.warn(
      "Direction not found:",
      {
        operator: vehicle.operator,
        routeId: vehicle.routeId,
        direction: vehicle.direction,
        routeInfo: routeInfo
      }
    );
  }

  return {

    ...vehicle,

    licensePlate:
      !vehicleInfo?.licensePlate ||
      vehicleInfo.licensePlate.toLowerCase() === "unknown"
        ? `Unknown (vehicle ${vehicle.vehicleId})`
        : vehicleInfo.licensePlate,

    model:
      vehicleInfo?.model ?? "Unknown",

    routeIndicative:
      routeInfo?.indicative ??
      String(vehicle.routeId),

    direction:
      directionName ?? "Unknown"
  };
}


// ============================================================
// FETCH VEHICLES FROM ONE API
// ============================================================

async function fetchFromAPI(api) {

  const response = await fetch(api.url);

  if (!response.ok) {

    throw new Error(
      `${api.name} API returned ${response.status}`
    );
  }

  const vehicles = await response.json();

  if (!Array.isArray(vehicles)) {

    throw new Error(
      `${api.name} API did not return an array`
    );
  }

  return vehicles.map(vehicle => ({

    ...vehicle,

    operator: api.operator,

    operatorName: api.name
  }));
}


// ============================================================
// FETCH ALL VEHICLES
// ============================================================

async function fetchVehicles() {

  const results = await Promise.allSettled(
    API_URLS.map(fetchFromAPI)
  );

  const vehicles = [];

  results.forEach((result, index) => {

    const api = API_URLS[index];

    if (result.status === "fulfilled") {

      vehicles.push(...result.value);

    } else {

      console.error(
        `Could not load ${api.name}:`,
        result.reason
      );
    }
  });

  return vehicles.map(enrichVehicle);
}


// ============================================================
// GET VEHICLE COORDINATES
// ============================================================

function getLatitude(vehicle) {

  return (
    vehicle.latitude ??
    vehicle.lat ??
    vehicle.position?.latitude ??
    vehicle.position?.lat ??
    null
  );
}


function getLongitude(vehicle) {

  return (
    vehicle.longitude ??
    vehicle.lng ??
    vehicle.lon ??
    vehicle.position?.longitude ??
    vehicle.position?.lng ??
    null
  );
}


// ============================================================
// GET VEHICLE ID
// ============================================================

function getVehicleId(vehicle) {

  return (
    vehicle.vehicleId ??
    null
  );
}


// ============================================================
// GET ROUTE ID
// ============================================================

function getRouteId(vehicle) {

  return (
    vehicle.routeId ??
    vehicle.route_id ??
    null
  );
}


// ============================================================
// NORMALIZE VEHICLE
// ============================================================

function normalizeVehicle(vehicle) {

  return {

    ...vehicle,

    vehicleId: vehicle.vehicleId,

    routeId: vehicle.routeId,

    direction: vehicle.direction
  };
}


// ============================================================
// POPUP
// ============================================================

function createPopup(vehicle) {

  const delaySeconds =
    Number(vehicle.delaySeconds ?? 0);

  const delayMinutes =
    Math.round(
      Math.abs(delaySeconds) / 60
    );

  let delayText;

  if (delaySeconds < -60) {

    delayText =
      `${delayMinutes} min în avans`;

  } else if (delaySeconds > 60) {

    delayText =
      `${delayMinutes} min întârziere`;

  } else {

    delayText =
      "La timp";
  }

  return `

    <div class="vehicle-popup">

      <p>
        <strong>Operator:</strong>
        ${vehicle.operatorName}
      </p>

      <p>
        <strong>Nr. Inmatriculare:</strong>
        ${vehicle.licensePlate}
      </p>

      <p>
        <strong>Model:</strong>
        ${vehicle.model}
      </p>

      <p>
        <strong>Linia:</strong>
        ${vehicle.routeIndicative}
      </p>

      <p>
        <strong>Întârziere:</strong>
        ${delayText}
      </p>

    </div>

  `;
}


// ============================================================
// CREATE / UPDATE MARKER
// ============================================================

function updateMarker(vehicle) {

  const latitude =
    getLatitude(vehicle);

  const longitude =
    getLongitude(vehicle);

  if (
    latitude === null ||
    longitude === null ||
    latitude === undefined ||
    longitude === undefined
  ) {

    return;
  }

  // Important:
  // Vehicle IDs can overlap between operators.
  // Therefore we use operator + vehicle ID.

  const vehicleKey =
    `${vehicle.operator}-${vehicle.vehicleId}`;

  const position = [
    Number(latitude),
    Number(longitude)
  ];

  if (
    Number.isNaN(position[0]) ||
    Number.isNaN(position[1])
  ) {

    return;
  }


  // ----------------------------------------------------------
  // Existing marker
  // ----------------------------------------------------------

  if (markers[vehicleKey]) {

    markers[vehicleKey]
      .setLatLng(position)
      .setPopupContent(
        createPopup(vehicle)
      );

    return;
  }


  // ----------------------------------------------------------
  // New marker
  // ----------------------------------------------------------

  const marker =
    L.marker(
      position,
      {
        icon: markerBus
      }
    ).addTo(map);

  marker.bindPopup(
    createPopup(vehicle)
  );

  marker.addTo(map);

  markers[vehicleKey] =
    marker;
}


// ============================================================
// REMOVE OLD MARKERS
// ============================================================

function removeOldMarkers(currentVehicles) {

  const currentKeys =
    new Set();

  currentVehicles.forEach(vehicle => {

    const key =
      `${vehicle.operator}-${vehicle.vehicleId}`;

    currentKeys.add(key);
  });


  Object.keys(markers).forEach(key => {

    if (!currentKeys.has(key)) {

      map.removeLayer(
        markers[key]
      );

      delete markers[key];
    }
  });
}


// ============================================================
// DISPLAY VEHICLES
// ============================================================

function displayVehicles() {

  const filteredVehicles =
    allVehicles.filter(vehicle => {

      // ------------------------------------------------------
      // Operator filter
      // ------------------------------------------------------

      if (
        selectedOperator !== "all" &&
        vehicle.operator !== selectedOperator
      ) {

        return false;
      }


      // ------------------------------------------------------
      // Route filter
      // ------------------------------------------------------

      if (
        selectedRoute !== "all" &&
        String(vehicle.routeId) !==
          String(selectedRoute)
      ) {

        return false;
      }


      // ------------------------------------------------------
      // Model filter
      // ------------------------------------------------------

      if (
        selectedModel !== "all" &&
        vehicle.model !== selectedModel
      ) {

        return false;
      }


      return true;
    });


  removeOldMarkers(
    filteredVehicles
  );


  filteredVehicles.forEach(vehicle => {

    updateMarker(vehicle);

  });


  updateStatus(
    filteredVehicles
  );
}


// ============================================================
// UPDATE MODEL FILTER
// ============================================================

function updateModelFilter() {

  const modelFilter =
    document.getElementById(
      "modelFilter"
    );

  if (!modelFilter) {
    return;
  }

  const previousValue =
    modelFilter.value;


  modelFilter.innerHTML = `

    <option value="all">
      All models
    </option>

  `;


  const models =
    new Set();


  allVehicles.forEach(vehicle => {

    // If an operator is selected,
    // only show models from that operator.

    if (
      selectedOperator !== "all" &&
      vehicle.operator !== selectedOperator
    ) {

      return;
    }


    if (
      vehicle.model &&
      vehicle.model !== "Unknown"
    ) {

      models.add(
        vehicle.model
      );
    }

  });


  const sortedModels =
    [...models].sort(
      (a, b) =>
        String(a).localeCompare(
          String(b),
          undefined,
          {
            numeric: true
          }
        )
    );


  sortedModels.forEach(model => {

    const option =
      document.createElement(
        "option"
      );

    option.value =
      model;

    option.textContent =
      model;

    modelFilter.appendChild(
      option
    );

  });


  // Restore previous selection
  // if it is still available.

  if (
    [...modelFilter.options]
      .some(
        option =>
          option.value ===
          previousValue
      )
  ) {

    modelFilter.value =
      previousValue;

  } else {

    modelFilter.value =
      "all";

    selectedModel =
      "all";
  }
}


// ============================================================
// UPDATE ROUTE FILTER
// ============================================================

function updateRouteFilter() {

  const routeFilter =
    document.getElementById(
      "routeFilter"
    );

  const previousValue =
    routeFilter.value;


  routeFilter.innerHTML = `

    <option value="all">
      All routes
    </option>

  `;


  const routes =
    new Map();


  allVehicles.forEach(vehicle => {

    if (
      selectedOperator !== "all" &&
      vehicle.operator !== selectedOperator
    ) {

      return;
    }


    if (
      vehicle.routeId === null ||
      vehicle.routeId === undefined
    ) {

      return;
    }


    const key =
      `${vehicle.operator}-${vehicle.routeId}`;


    if (!routes.has(key)) {

      routes.set(
        key,
        {
          operator:
            vehicle.operator,

          routeId:
            vehicle.routeId,

          indicative:
            vehicle.routeIndicative
        }
      );
    }

  });


  const sortedRoutes =
    [...routes.values()]
      .sort((a, b) => {

        return String(a.indicative)
          .localeCompare(
            String(b.indicative),
            undefined,
            {
              numeric: true
            }
          );

      });


  sortedRoutes.forEach(route => {

    const option =
      document.createElement(
        "option"
      );


    option.value =
      `${route.operator}|${route.routeId}`;


    option.textContent =
      `${route.indicative} (${
        route.operator === "transmixt"
          ? "Transmixt"
          : "Ani Tour"
      })`;


    routeFilter.appendChild(
      option
    );

  });


  // Restore selection if possible

  if (
    [...routeFilter.options]
      .some(
        option =>
          option.value ===
          previousValue
      )
  ) {

    routeFilter.value =
      previousValue;

  } else {

    routeFilter.value =
      "all";

    selectedRoute =
      "all";
  }
}


// ============================================================
// STATUS
// ============================================================

function updateStatus(vehicles) {

  const status =
    document.getElementById(
      "status"
    );

  const time =
    new Date()
      .toLocaleTimeString();


  status.textContent =
    `${vehicles.length} buses shown • Last update: ${time}`;
}


// ============================================================
// UPDATE EVERYTHING
// ============================================================

async function updateVehicles() {

  const status =
    document.getElementById(
      "status"
    );


  status.textContent =
    "Updating...";


  try {

    allVehicles =
      await fetchVehicles();


    allVehicles =
      allVehicles.map(
        normalizeVehicle
      );


    updateModelFilter();

    updateRouteFilter();

    displayVehicles();


    console.log(
      "Vehicles:",
      allVehicles
    );


  } catch (error) {

    console.error(error);

    status.textContent =
      `Error updating buses: ${error.message}`;
  }
}


// ============================================================
// OPERATOR FILTER
// ============================================================

document
  .getElementById(
    "operatorFilter"
  )
  .addEventListener(
    "change",
    event => {

      selectedOperator =
        event.target.value;


      // Changing operator resets route
      selectedRoute =
        "all";


      // Changing operator also refreshes
      // the available models.

      updateModelFilter();

      updateRouteFilter();


      displayVehicles();
    }
  );


// ============================================================
// ROUTE FILTER
// ============================================================

document
  .getElementById(
    "routeFilter"
  )
  .addEventListener(
    "change",
    event => {

      const value =
        event.target.value;


      if (value === "all") {

        selectedRoute =
          "all";

      } else {

        // Format:
        // operator|routeId

        const [
          operator,
          routeId
        ] =
          value.split("|");


        // Make sure the selected operator
        // matches the selected route.

        selectedOperator =
          operator;


        document
          .getElementById(
            "operatorFilter"
          )
          .value =
            operator;


        selectedRoute =
          routeId;


        // Refresh available models
        // for the selected operator.

        updateModelFilter();
      }


      displayVehicles();
    }
  );


// ============================================================
// MODEL FILTER
// ============================================================

document
  .getElementById(
    "modelFilter"
  )
  .addEventListener(
    "change",
    event => {

      selectedModel =
        event.target.value;


      displayVehicles();
    }
  );


// ============================================================
// MANUAL REFRESH
// ============================================================

document
  .getElementById(
    "refreshButton"
  )
  .addEventListener(
    "click",
    updateVehicles
  );


// ============================================================
// START APPLICATION
// ============================================================

async function startApp() {

  try {

    document
      .getElementById(
        "status"
      )
      .textContent =
        "Loading local data...";


    await loadLocalData();


    document
      .getElementById(
        "status"
      )
      .textContent =
        "Loading buses...";


    await updateVehicles();


    // Refresh every 10 seconds

    setInterval(
      updateVehicles,
      10000
    );


  } catch (error) {

    console.error(error);


    document
      .getElementById(
        "status"
      )
      .textContent =
        `Startup error: ${error.message}`;
  }
}


startApp();

