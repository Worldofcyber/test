// CyberWorld server — plain Node.js http module only. No Express, no
// npm dependencies at all. Run with: node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const store = require("./lib/store.js");
const totp = require("./lib/totp.js");
const { renderHome, renderArticle, renderSitemap } = require("./lib/render.js");
const adminViews = require("./lib/admin-views.js");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");
const STATIC_PAGES = ["about.html", "contact.html", "privacy.html", "terms.html"];

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".xml": "application/xml", ".txt": "text/plain", ".json": "application/json",
  ".ico": "image/x-icon",
};

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, opts = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (opts.maxAge) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.clear) cookie = `${name}=; Path=/; HttpOnly; Max-Age=0`;
  res.setHeader("Set-Cookie", cookie);
}
function readBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function parseFormBody(bodyStr) {
  const params = new URLSearchParams(bodyStr);
  const obj = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}
function slugify(title) {
  return "article-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

// ---------- auth middleware ----------
function getSessionFromReq(req) {
  const cookies = parseCookies(req);
  if (!cookies.cw_session) return null;
  return { id: cookies.cw_session, session: store.getSession(cookies.cw_session) };
}
function requireFullAuth(req, res) {
  const { session } = getSessionFromReq(req) || {};
  if (!session || session.stage !== "authenticated") {
    redirect(res, "/admin/login");
    return false;
  }
  return true;
}

// ---------- static file serving ----------
function serveStatic(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { send(res, 404, "<h1>404 Not Found</h1>"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- save uploaded cover image (base64 data URL from the editor) ----------
function saveCoverImage(dataUrl, slug) {
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,(.+)$/);
  if (!match) return null;
  const ext = match[1] === "svg+xml" ? "svg" : match[1];
  const buffer = Buffer.from(match[2], "base64");
  const filename = `${slug}-cover-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return `/uploads/${filename}`;
}

// ---------- request handler ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    // ===== Static assets =====
    if (pathname.startsWith("/assets/") || pathname.startsWith("/uploads/")) {
      const filePath = path.join(PUBLIC_DIR, pathname);
      if (!filePath.startsWith(PUBLIC_DIR)) { send(res, 403, "Forbidden"); return; }
      serveStatic(req, res, filePath);
      return;
    }

    if (pathname === "/robots.txt" || pathname === "/ads.txt") {
      const filePath = path.join(ROOT, pathname);
      if (fs.existsSync(filePath)) { serveStatic(req, res, filePath); return; }
    }

    if (pathname === "/sitemap.xml") {
      const posts = store.getAllPosts();
      const baseUrl = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
      send(res, 200, renderSitemap(posts, STATIC_PAGES, baseUrl), { "Content-Type": "application/xml" });
      return;
    }

    if (STATIC_PAGES.includes(pathname.replace(/^\//, ""))) {
      serveStatic(req, res, path.join(ROOT, pathname));
      return;
    }

    // ===== Admin routes =====
    if (pathname === "/admin" || pathname === "/admin/") {
      if (!requireFullAuth(req, res)) return;
      send(res, 200, adminViews.dashboardPage(store.getAllPosts()));
      return;
    }

    if (pathname === "/admin/login") {
      if (req.method === "GET") {
        const admin = store.getAdmin();
        if (!admin) { redirect(res, "/admin/setup"); return; }
        send(res, 200, adminViews.loginPage({}));
        return;
      }
      if (req.method === "POST") {
        const ip = clientIp(req);
        if (store.isLockedOut(ip)) {
          send(res, 429, adminViews.loginPage({ error: "Too many failed attempts. Try again in a few minutes." }));
          return;
        }
        const body = parseFormBody(await readBody(req));
        const admin = store.getAdmin();
        if (!admin) { redirect(res, "/admin/setup"); return; }
        const ok = body.username === admin.username && store.verifyPassword(body.password || "", admin.salt, admin.hash);
        if (!ok) {
          store.recordFailure(ip);
          send(res, 401, adminViews.loginPage({ error: "Incorrect username or password." }));
          return;
        }
        store.recordSuccess(ip);
        const sessionId = store.createSession("password_ok");
        setCookie(res, "cw_session", sessionId, { maxAge: 600 }); // 10 min to complete 2FA
        redirect(res, "/admin/verify-2fa");
        return;
      }
    }

    if (pathname === "/admin/verify-2fa") {
      const { id, session } = getSessionFromReq(req) || {};
      if (!session || session.stage === undefined) { redirect(res, "/admin/login"); return; }
      if (req.method === "GET") { send(res, 200, adminViews.verify2faPage({})); return; }
      if (req.method === "POST") {
        const ip = clientIp(req);
        if (store.isLockedOut(ip)) {
          send(res, 429, adminViews.verify2faPage({ error: "Too many failed attempts. Try again in a few minutes." }));
          return;
        }
        const body = parseFormBody(await readBody(req));
        const admin = store.getAdmin();
        const ok = admin && admin.totpSecret && totp.verifyTotp(admin.totpSecret, (body.code || "").trim());
        if (!ok) {
          store.recordFailure(ip);
          send(res, 401, adminViews.verify2faPage({ error: "Incorrect or expired code. Try again." }));
          return;
        }
        store.recordSuccess(ip);
        store.upgradeSession(id, "authenticated");
        setCookie(res, "cw_session", id, { maxAge: 60 * 60 * 8 });
        redirect(res, "/admin");
        return;
      }
    }

    // First-run 2FA + password setup
    if (pathname === "/admin/setup") {
      const admin = store.getAdmin();
      if (admin) { redirect(res, "/admin/login"); return; }
      if (req.method === "GET") {
        send(res, 200, `<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/assets/styles.css"><title>Initial Setup</title></head><body style="background:var(--ink);"><div class="login-box" style="width:400px;background:var(--panel);border:1px solid var(--hairline);border-radius:10px;padding:40px 32px;margin:8vh auto;"><h1 style="font-family:var(--f-display);text-align:center;color:var(--paper);">First-Time Setup</h1><p style="color:var(--slate);text-align:center;font-size:13.5px;">Create your admin username and password. You'll set up 2FA on the next screen.</p><form method="POST" action="/admin/setup"><div style="margin-bottom:16px;"><label style="display:block;font-size:12px;color:var(--slate);margin-bottom:6px;">Username</label><input name="username" required style="width:100%;padding:11px 14px;background:var(--ink);border:1px solid var(--hairline);border-radius:6px;color:var(--paper);"></div><div style="margin-bottom:16px;"><label style="display:block;font-size:12px;color:var(--slate);margin-bottom:6px;">Password (min 10 characters)</label><input name="password" type="password" minlength="10" required style="width:100%;padding:11px 14px;background:var(--ink);border:1px solid var(--hairline);border-radius:6px;color:var(--paper);"></div><button class="btn btn-primary" type="submit" style="width:100%;justify-content:center;">Create Account</button></form></div></body></html>`);
        return;
      }
      if (req.method === "POST") {
        const body = parseFormBody(await readBody(req));
        if (!body.username || !body.password || body.password.length < 10) {
          send(res, 400, "Username required and password must be at least 10 characters. <a href='/admin/setup'>Back</a>");
          return;
        }
        const { salt, hash } = store.hashPassword(body.password);
        const secret = totp.generateSecret();
        store.saveAdmin({ username: body.username, salt, hash, totpSecret: secret, totpConfirmed: false });
        const sessionId = store.createSession("setup_2fa");
        setCookie(res, "cw_session", sessionId, { maxAge: 900 });
        redirect(res, "/admin/setup-2fa");
        return;
      }
    }

    if (pathname === "/admin/setup-2fa") {
      const { session } = getSessionFromReq(req) || {};
      const admin = store.getAdmin();
      if (!admin || !session || admin.totpConfirmed) { redirect(res, "/admin/login"); return; }
      const uri = totp.otpAuthUri(admin.totpSecret, admin.username, "CyberWorld");
      send(res, 200, adminViews.setup2faPage({ secret: admin.totpSecret, otpauthUri: uri }));
      return;
    }

    if (pathname === "/admin/complete-2fa-setup" && req.method === "POST") {
      const { id, session } = getSessionFromReq(req) || {};
      const admin = store.getAdmin();
      if (!admin || !session) { redirect(res, "/admin/login"); return; }
      const body = parseFormBody(await readBody(req));
      const ok = totp.verifyTotp(admin.totpSecret, (body.code || "").trim());
      if (!ok) {
        send(res, 401, adminViews.setup2faPage({ secret: admin.totpSecret, otpauthUri: "" }) + "<script>alert('Incorrect code — try again.')</script>");
        return;
      }
      admin.totpConfirmed = true;
      store.saveAdmin(admin);
      store.upgradeSession(id, "authenticated");
      setCookie(res, "cw_session", id, { maxAge: 60 * 60 * 8 });
      redirect(res, "/admin");
      return;
    }

    if (pathname === "/admin/logout" && req.method === "POST") {
      const { id } = getSessionFromReq(req) || {};
      if (id) store.destroySession(id);
      setCookie(res, "cw_session", "", { clear: true });
      redirect(res, "/admin/login");
      return;
    }

    if (pathname === "/admin/editor") {
      if (!requireFullAuth(req, res)) return;
      const slug = url.searchParams.get("slug");
      const post = slug ? store.getPost(slug) : null;
      send(res, 200, adminViews.editorPage(post));
      return;
    }

    if (pathname === "/admin/save" && req.method === "POST") {
      if (!requireFullAuth(req, res)) return;
      const body = parseFormBody(await readBody(req));
      const isEdit = !!body.originalSlug;
      const slug = isEdit ? body.originalSlug : (body.slug || slugify(body.title));

      let coverImage = body.existingCoverImage || null;
      if (body.coverImageData) {
        const saved = saveCoverImage(body.coverImageData, slug);
        if (saved) coverImage = saved;
      }

      const post = {
        slug,
        title: body.title || "Untitled post",
        description: body.description || "",
        category: body.category || "fraud",
        threat: body.threat || "Guarded",
        readTime: body.readTime || "5 min read",
        body: body.body || "",
        date: new Date().toISOString().slice(0, 10),
        coverImage: coverImage || null,
      };
      store.savePost(post); // instantly live — homepage and article pages read this file on every request
      redirect(res, "/admin?saved=" + encodeURIComponent(slug));
      return;
    }

    if (pathname === "/admin/delete" && req.method === "POST") {
      if (!requireFullAuth(req, res)) return;
      const body = parseFormBody(await readBody(req));
      if (body.slug) store.deletePost(body.slug);
      redirect(res, "/admin");
      return;
    }

    // ===== Public site =====
    if (pathname === "/" || pathname === "/index.html") {
      send(res, 200, renderHome(store.getAllPosts()));
      return;
    }

    const slugMatch = pathname.match(/^\/([a-z0-9-]+)\.html$/);
    if (slugMatch) {
      const post = store.getPost(slugMatch[1]);
      if (post) {
        send(res, 200, renderArticle(post, store.getAllPosts()));
        return;
      }
    }

    send(res, 404, "<h1>404 — Page not found</h1><p><a href='/'>Back to homepage</a></p>");
  } catch (err) {
    console.error(err);
    send(res, 500, "<h1>500 — Server error</h1>");
  }
});

server.listen(PORT, () => {
  console.log(`CyberWorld running at http://localhost:${PORT}`);
  if (!store.getAdmin()) {
    console.log(`No admin account yet — visit http://localhost:${PORT}/admin/setup to create one.`);
  }
});
