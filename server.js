const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "20kb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
});

const PORT = process.env.PORT || 3000;
const WEBSITE_URL = "https://shadow-skin-oficial.vercel.app/";
const DAILY_KEY_API = "https://shadow-skin-oficial.vercel.app/api/key";
const DAY_MS = 24 * 60 * 60 * 1000;

app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

function istDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function cleanDeviceId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (id.length < 8 || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  return id;
}

async function ensureUser(deviceId) {
  await pool.query(
    `INSERT INTO ticket_users(device_id) VALUES($1)
     ON CONFLICT(device_id) DO NOTHING`,
    [deviceId]
  );
}

function msRemaining(until) {
  if (!until) return 0;
  return Math.max(0, new Date(until).getTime() - Date.now());
}

async function getDailyWebsiteCode() {
  const response = await fetch(DAILY_KEY_API, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Daily-code service returned HTTP " + response.status);
  const data = await response.json();
  if (!data || data.status !== "success" || typeof data.password !== "string" || !data.password.trim()) {
    throw new Error("Unexpected daily-code API response");
  }
  return data.password.trim();
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/state", async (req, res) => {
  try {
    const deviceId = cleanDeviceId(req.body.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, error: "INVALID_DEVICE_ID" });
    await ensureUser(deviceId);
    const result = await pool.query(
      `SELECT tickets, get_tickets_until, submit_until, last_redeem_date
       FROM ticket_users WHERE device_id=$1`,
      [deviceId]
    );
    const row = result.rows[0];
    res.json({
      ok: true,
      tickets: row.tickets,
      getTicketsCooldownMs: msRemaining(row.get_tickets_until),
      submitCooldownMs: msRemaining(row.submit_until),
      redeemedToday: row.last_redeem_date === istDateString(),
      dateIST: istDateString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// Starts the 24-hour Get Tickets cooldown and returns the existing website.
app.post("/api/get-tickets", async (req, res) => {
  const client = await pool.connect();
  try {
    const deviceId = cleanDeviceId(req.body.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, error: "INVALID_DEVICE_ID" });
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO ticket_users(device_id) VALUES($1) ON CONFLICT(device_id) DO NOTHING`,
      [deviceId]
    );
    const result = await client.query(
      `UPDATE ticket_users
       SET get_tickets_until = NOW() + INTERVAL '24 hours', updated_at=NOW()
       WHERE device_id=$1 AND (get_tickets_until IS NULL OR get_tickets_until <= NOW())
       RETURNING get_tickets_until`,
      [deviceId]
    );
    if (result.rowCount === 0) {
      const current = await client.query(
        `SELECT get_tickets_until FROM ticket_users WHERE device_id=$1`,
        [deviceId]
      );
      await client.query("COMMIT");
      return res.status(429).json({
        ok: false,
        error: "GET_TICKETS_COOLDOWN",
        cooldownMs: msRemaining(current.rows[0].get_tickets_until)
      });
    }
    await client.query("COMMIT");
    res.json({ ok: true, websiteUrl: WEBSITE_URL, cooldownMs: DAY_MS });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  } finally {
    client.release();
  }
});

// Each device can redeem the current website code once per India calendar day.
app.post("/api/redeem", async (req, res) => {
  try {
    const deviceId = cleanDeviceId(req.body.deviceId);
    const submittedCode = typeof req.body.code === "string" ? req.body.code.trim() : "";
    if (!deviceId || !submittedCode || submittedCode.length > 100) {
      return res.status(400).json({ ok: false, error: "INVALID_INPUT" });
    }

    const currentCode = await getDailyWebsiteCode();
    if (submittedCode.toUpperCase() !== currentCode.toUpperCase()) {
      return res.status(400).json({ ok: false, error: "INVALID_OR_EXPIRED_CODE" });
    }

    const today = istDateString();
    const codeHash = crypto.createHash("sha256").update(currentCode).digest("hex");
    await ensureUser(deviceId);

    const result = await pool.query(
      `UPDATE ticket_users
       SET tickets = tickets + 1,
           last_redeem_date = $2,
           last_redeem_code_hash = $3,
           updated_at = NOW()
       WHERE device_id = $1
         AND (last_redeem_date IS DISTINCT FROM $2)
       RETURNING tickets`,
      [deviceId, today, codeHash]
    );

    if (result.rowCount === 0) {
      const state = await pool.query(
        `SELECT tickets FROM ticket_users WHERE device_id=$1`,
        [deviceId]
      );
      return res.status(409).json({
        ok: false,
        error: "ALREADY_REDEEMED_TODAY",
        tickets: state.rows[0].tickets
      });
    }

    res.json({ ok: true, tickets: result.rows[0].tickets, message: "1 ticket added" });
  } catch (e) {
    console.error(e);
    res.status(503).json({ ok: false, error: "CODE_VERIFICATION_UNAVAILABLE" });
  }
});

// Call this ONLY after Telegram confirms that the image upload succeeded.
app.post("/api/consume-ticket", async (req, res) => {
  try {
    const deviceId = cleanDeviceId(req.body.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, error: "INVALID_DEVICE_ID" });
    await ensureUser(deviceId);

    const result = await pool.query(
      `UPDATE ticket_users
       SET tickets = tickets - 1,
           submit_until = NOW() + INTERVAL '24 hours',
           updated_at = NOW()
       WHERE device_id = $1
         AND tickets > 0
         AND (submit_until IS NULL OR submit_until <= NOW())
       RETURNING tickets, submit_until`,
      [deviceId]
    );

    if (result.rowCount === 0) {
      const state = await pool.query(
        `SELECT tickets, submit_until FROM ticket_users WHERE device_id=$1`,
        [deviceId]
      );
      const row = state.rows[0];
      if (msRemaining(row.submit_until) > 0) {
        return res.status(429).json({
          ok: false, error: "SUBMIT_COOLDOWN",
          cooldownMs: msRemaining(row.submit_until), tickets: row.tickets
        });
      }
      return res.status(400).json({ ok: false, error: "NO_TICKETS", tickets: row.tickets });
    }

    res.json({
      ok: true,
      tickets: result.rows[0].tickets,
      submitCooldownMs: DAY_MS
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "SERVER_ERROR" });
});

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL environment variable is required.");
    process.exit(1);
  }
  await pool.query("SELECT 1");
  app.listen(PORT, () => console.log("Ticket API listening on port " + PORT));
}

start().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
