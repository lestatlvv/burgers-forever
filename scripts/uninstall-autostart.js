"use strict";

/**
 * Remove Burgers Forever Windows autostart (Task Scheduler + Startup launcher).
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { isWin } = require("./paths");

const TASK_NAME = "BurgersForeverKiosk";
const STARTUP_NAMES = ["BurgersForeverKiosk.cmd", "BurgersForeverKiosk.lnk"];

function main() {
  if (!isWin) {
    console.error("uninstall:autostart is only supported on Windows.");
    process.exit(1);
  }

  const del = spawnSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (del.status === 0) {
    console.log(`Removed scheduled task: ${TASK_NAME}`);
  } else {
    console.log(`No scheduled task named ${TASK_NAME} (or already removed).`);
  }

  const startupDir = path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
  let removed = false;
  for (const name of STARTUP_NAMES) {
    const p = path.join(startupDir, name);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`Removed Startup entry: ${p}`);
      removed = true;
    }
  }
  if (!removed) {
    console.log("No Startup launcher found.");
  }

  console.log("Autostart removed. Services already running are not stopped.");
  console.log("Stop them with: npm stop");
}

main();
