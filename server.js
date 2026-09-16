const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

// =========================
// MIDDLEWARE
// =========================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend files
app.use(express.static(path.join(__dirname)));

// =========================
// DATABASE
// =========================
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing!");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  console.error("❌ Unexpected PostgreSQL pool error:", err);
});

// =========================
// META CONVERSION API
// =========================
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_API_VERSION = process.env.META_API_VERSION || "v23.0";

function hashData(value) {
  if (!value) return null;

  return crypto
    .createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex");
}

async function sendMetaConversion(data) {
  try {
    if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
      console.log("⚠️ Meta CAPI skipped: Pixel ID or Access Token missing.");
      return;
    }

    const userData = {};

    if (data.email) {
      userData.em = [hashData(data.email)];
    }

    if (data.phone) {
      userData.ph = [hashData(data.phone)];
    }

    if (data.ip) {
      userData.client_ip_address = data.ip;
    }

    if (data.user_agent) {
      userData.client_user_agent = data.user_agent;
    }

    if (data.fbp) {
      userData.fbp = data.fbp;
    }

    if (data.fbc) {
      userData.fbc = data.fbc;
    }

    const event = {
      event_name: "CompleteRegistration",
      event_time: Math.floor(Date.now() / 1000),
      event_id: data.event_id,
      action_source: "website",
      event_source_url: data.event_source_url || "",
      user_data: userData,
      custom_data: {
        currency: "BDT",
        value: Number(data.registration_fee) || 0
      }
    };

    const url =
      `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events` +
      `?access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: [event]
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("⚠️ Meta CAPI error:", result);
      return;
    }

    console.log("✅ Meta CAPI event sent:", result);

  } catch (error) {
    // Meta error must NEVER break registration
    console.error("⚠️ Meta CAPI failed:", error.message);
  }
}

// =========================
// TEST DATABASE
// =========================
app.get("/api/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");

    res.json({
      success: true,
      message: "Neon database connected successfully!",
      time: result.rows[0].now
    });

  } catch (error) {
    console.error("❌ DATABASE TEST ERROR");
    console.error("Message:", error.message);
    console.error("Code:", error.code);
    console.error("Detail:", error.detail);

    res.status(500).json({
      success: false,
      message: "Database connection failed.",
      error: error.message,
      code: error.code || null
    });
  }
});

// =========================
// REGISTRATION
// =========================
app.post("/api/register", async (req, res) => {

  console.log("\n=================================");
  console.log("📥 NEW REGISTRATION REQUEST");
  console.log("=================================");

  try {
    const {
      name,
      email,
      phone,
      distance,
      category,
      gender,
      payment_method,
      payment_number,
      trx_id,
      registration_fee,
      fbp,
      fbc,
      event_source_url
    } = req.body;

    console.log("Name:", name);
    console.log("Email:", email);
    console.log("Phone:", phone);
    console.log("Distance:", distance);
    console.log("Category:", category);
    console.log("Gender:", gender);
    console.log("Payment Method:", payment_method);
    console.log("Payment Number:", payment_number);
    console.log("TRX ID:", trx_id);
    console.log("Registration Fee:", registration_fee);

    // =========================
    // VALIDATION
    // =========================
    if (
      !name ||
      !email ||
      !phone ||
      !distance ||
      !category ||
      !gender ||
      !payment_method ||
      !payment_number ||
      !trx_id ||
      registration_fee === undefined ||
      registration_fee === null
    ) {
      console.log("❌ Validation failed: Missing required fields.");

      return res.status(400).json({
        success: false,
        message: "Please fill in all required fields."
      });
    }

    // =========================
    // INSERT INTO DATABASE
    // =========================
    const query = `
      INSERT INTO registrations (
        name,
        email,
        phone,
        distance,
        category,
        gender,
        payment_method,
        payment_number,
        trx_id,
        registration_fee
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `;

    const values = [
      name,
      email,
      phone,
      distance,
      category,
      gender,
      payment_method,
      payment_number,
      trx_id,
      Number(registration_fee)
    ];

    console.log("⏳ Inserting registration into PostgreSQL...");

    const result = await pool.query(query, values);

    const registrationId = result.rows[0].id;

    console.log("✅ DATABASE INSERT SUCCESS");
    console.log("Registration ID:", registrationId);

    // =========================
    // META CAPI
    // =========================
    const eventId = `registration_${registrationId}_${Date.now()}`;

    sendMetaConversion({
      event_id: eventId,
      email,
      phone,
      registration_fee,
      fbp,
      fbc,
      event_source_url,
      ip: req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress,
      user_agent: req.headers["user-agent"]
    });

    // =========================
    // SUCCESS RESPONSE
    // =========================
    return res.status(200).json({
      success: true,
      message: "Registration successful!",
      registration_id: registrationId
    });

  } catch (error) {

    console.error("\n=================================");
    console.error("❌ REGISTRATION ERROR");
    console.error("=================================");

    console.error("Message:", error.message);
    console.error("Code:", error.code);
    console.error("Detail:", error.detail);
    console.error("Constraint:", error.constraint);
    console.error("Table:", error.table);
    console.error("Column:", error.column);
    console.error("Full Error:", error);

    return res.status(500).json({
      success: false,
      message: "Registration failed.",
      error: error.message,
      code: error.code || null
    });
  }
});

// =========================
// HOME PAGE
// =========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// =========================
// SERVER
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("=================================");
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("=================================");
});