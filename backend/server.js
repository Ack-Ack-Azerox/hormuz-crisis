const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const turf = require("@turf/turf");
const fleet = require("./fleet.json");

const app = express();

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

let restrictedZones = [];
let alerts = [];
let directives = [];
let history = [];

let ships = JSON.parse(
  JSON.stringify(fleet.fleet)
);

ships.forEach(ship => {
  ship.history = [ship.position];
});

const weatherZones = [
  {
    name: "Storm Alpha",
    center: [25.8, 55.8],
    radius: 120
  },
  {
    name: "Storm Bravo",
    center: [24.8, 57.5],
    radius: 100
  }
];
app.get("/stats", (req, res) => {

  const activeShips =
    ships.filter(
      s => s.status !== "stopped"
    ).length;

  const lowFuelShips =
    ships.filter(
      s => s.fuel < 500
    ).length;

  res.json({
    totalShips: ships.length,
    activeShips,
    lowFuelShips,
    alerts: alerts.length,
    zones: restrictedZones.length
  });

});

app.get("/", (req, res) => {
  res.send("Fleet Backend Running");
});

app.get("/ships", (req, res) => {
  res.json(ships);
});

app.get("/polygon", (req, res) => {
  res.json(fleet.navigableWater);
});

app.get("/zones", (req, res) => {
  res.json(restrictedZones);
});

app.get("/alerts", (req, res) => {
  res.json(alerts);
});

app.get("/history", (req, res) => {
  res.json(history);
});

app.get("/weather", (req, res) => {
  res.json(weatherZones);
});

io.on("connection", (socket) => {

  console.log("Client Connected");

  socket.emit(
    "zones:update",
    restrictedZones
  );

  socket.on(
    "send:directive",
    (data) => {

      directives.unshift(data);

      io.emit(
        "directive:new",
        data
      );

    }
  );

  socket.on(
    "captain:response",
    (data) => {

      if (
        data.status ===
        "DISTRESS"
      ) {

        const msg =
          data.message.toLowerCase();

        let severity =
          "LOW";

        if (
          msg.includes("fire") ||
          msg.includes("explosion") ||
          msg.includes("sinking")
        ) {
          severity =
            "CRITICAL";
        }
        else if (
          msg.includes("engine") ||
          msg.includes("injured") ||
          msg.includes("damage")
        ) {
          severity =
            "HIGH";
        }

        data.aiAnalysis = {
          severity
        };

        alerts.unshift({
          id:
            Date.now() +
            Math.random(),
          type:
            "distress",
          message:
            `${data.shipId} distress (${severity})`,
          timestamp:
            new Date()
              .toISOString()
        });

      }

      io.emit(
        "captain:update",
        data
      );

    }
  );

  socket.on(
    "zone:create",
    (zone) => {

      restrictedZones.push(
        zone
      );

      io.emit(
        "zones:update",
        restrictedZones
      );

    }
  );

});

function shipInStorm(
  ship
) {

  for (
    const storm of weatherZones
  ) {

    const distance =
      turf.distance(
        turf.point([
          ship.position[1],
          ship.position[0]
        ]),
        turf.point([
          storm.center[1],
          storm.center[0]
        ]),
        {
          units:
            "kilometers"
        }
      );

    if (
      distance <
      storm.radius
    ) {
      return true;
    }

  }

  return false;

}

function moveShips() {

  ships.forEach(
    (ship) => {

      if (
        ship.status ===
          "arrived" ||
        ship.status ===
          "stopped"
      ) {
        return;
      }

      const lat =
        ship.position[0];

      const lng =
        ship.position[1];

      const distance =
        ship.speed *
        0.00002;

      const angle =
        ship.heading *
        Math.PI /
        180;

      ship.position = [
        lat +
          distance *
            Math.cos(
              angle
            ),
        lng +
          distance *
            Math.sin(
              angle
            )
      ];

      ship.history.push([
  ship.position[0],
  ship.position[1]
]);

if (ship.history.length > 20) {
  ship.history.shift();
}

      let burn =
        0.25;

      if (
        shipInStorm(ship)
      ) {

        burn =
          burn * 1.3;

        ship.status =
          "weather";

      }

      ship.fuel -= burn;

      if (
  ship.fuel > 0 &&
  ship.fuel < 200
) {

  io.emit(
    "alert:new",
    {
      id:
        Date.now() +
        Math.random(),
      type: "critical-fuel",
      message:
        `${ship.name} CRITICAL FUEL`,
      timestamp:
        new Date()
          .toISOString()
    }
  );

}

      if (
        ship.fuel <
          500 &&
        ship.fuel > 0
      ) {

        alerts.unshift({
          id:
            Date.now() +
            Math.random(),
          type:
            "fuel",
          message:
            `${ship.name} low fuel`,
          timestamp:
            new Date()
              .toISOString()
        });

      }

      if (
        ship.fuel <= 0
      ) {

        ship.fuel = 0;

        ship.status =
          "stopped";

        alerts.unshift({
          id:
            Date.now() +
            Math.random(),
          type:
            "fuel",
          message:
            `${ship.name} ran out of fuel`,
          timestamp:
            new Date()
              .toISOString()
        });

      }

    }
  );

}

function checkProximity() {

  for (let i = 0; i < ships.length; i++) {

    for (let j = i + 1; j < ships.length; j++) {

      const distance = turf.distance(
        turf.point([
          ships[i].position[1],
          ships[i].position[0]
        ]),
        turf.point([
          ships[j].position[1],
          ships[j].position[0]
        ]),
        {
          units: "kilometers"
        }
      );

      if (distance < 10) {

        const alert = {
          id: Date.now() + Math.random(),
          type: "proximity",
          message: `${ships[i].name} near ${ships[j].name} (${distance.toFixed(2)} km)`,
          timestamp: new Date().toISOString()
        };

        alerts.unshift(alert);

        io.emit(
          "alert:new",
          alert
        );

      }

    }

  }

}

function checkGeofences() {

  ships.forEach(
    (ship) => {

      const point =
        turf.point([
          ship.position[1],
          ship.position[0]
        ]);

      restrictedZones.forEach(
        (zone) => {

          const polygon =
            turf.polygon([
              [
                ...zone.map(
                  (
                    p
                  ) => [
                    p[1],
                    p[0]
                  ]
                ),
                [
                  zone[0][1],
                  zone[0][0]
                ]
              ]
            ]);

          const inside =
            turf.booleanPointInPolygon(
              point,
              polygon
            );

          if (
            inside &&
            ship.status !==
              "rerouting"
          ) {

            ship.status =
              "rerouting";

            const alert =
              {
                id:
                  Date.now() +
                  Math.random(),
                type:
                  "geofence",
                message:
                  `${ship.name} entered restricted zone`
              };

            alerts.unshift(
              alert
            );

            io.emit(
              "alert:new",
              alert
            );

          }

        }
      );

    }
  );

}

setInterval(() => {

  moveShips();

  checkGeofences();

  checkProximity();

  history.push({
    timestamp:
      Date.now(),
    ships:
      JSON.parse(
        JSON.stringify(
          ships
        )
      )
  });

  if (
    history.length >
    120
  ) {
    history.shift();
  }

  io.emit(
    "fleet:update",
    ships
  );

}, 1000);

server.listen(
  5000,
  () => {

    console.log(
      "Server running on port 5000"
    );

  }
);