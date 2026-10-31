const express = require("express");
const { getPool } = require("../config/database");

const router = express.Router();

// Is the API process up? Never touches the database.
router.get("/health", (req, res) => {
  res.json({ ok: true, service: "spiritdrop-api" });
});

// Can the API reach the database? Runs a harmless query and changes nothing.
router.get("/health/db", async (req, res) => {
  try {
    await getPool().query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (err) {
    // MySQL error messages can include the database username, so production
    // logs only the error code. Browsers never receive any detail.
    if (process.env.NODE_ENV === "production") {
      console.error("Database health check failed:", err.code || "NOT_CONFIGURED");
    } else {
      console.error("Database health check failed:", err.message);
    }
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

module.exports = router;
