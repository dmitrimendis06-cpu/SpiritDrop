const express = require("express");
const { closePool, missingDbVars } = require("./config/database");
const healthRoutes = require("./routes/health");

const app = express();

// CORS is deliberately not configured: no browser frontend uses this API yet.
app.disable("x-powered-by");

app.use(healthRoutes);

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

// Generic responses only: no stack traces or internal details reach the browser.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isProduction = process.env.NODE_ENV === "production";
  console.error("Unhandled error:", isProduction ? err.code || err.name : err);
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ ok: false, error: status < 500 ? "Bad request" : "Internal server error" });
});

// Hostinger supplies PORT at runtime; 3001 is for local development only.
const port = process.env.PORT || 3001;
const server = app.listen(port, () => {
  console.log(`spiritdrop-api listening on port ${port}`);
  const missing = missingDbVars();
  if (missing.length > 0) {
    console.warn(`Database not configured. Missing: ${missing.join(", ")}`);
  }
});

function shutdown() {
  server.close(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
