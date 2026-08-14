# CyberWorld — Self-Hosted Blog with Direct-Publish Admin Panel

A real Node.js server (no framework, **zero npm dependencies**) that
serves the public blog and a login-protected admin panel where creating
or editing a post makes it **live on the site immediately** — no
downloading a file and uploading it somewhere. Login requires a
password **and** a 2FA code from an authenticator app, implemented from
scratch using Node's built-in `crypto` module (the same open TOTP
standard Google Authenticator, Authy, and 1Password all use — verified
against the official RFC test vectors).

## Why this is different from the previous version

The earlier version of this site was static HTML files — the admin
panel could only generate a file for you to manually upload. That's
gone. This version is a running server: the 30 blog posts live in
`data/posts.json`, and every page (homepage, each article, the sitemap)
is generated from that file on every request. When you save a post in
the admin panel, the file is updated and the change is live on the next
page load — for you and every visitor — instantly.

## Running it

Requires only Node.js (v18+) — nothing to `npm install`.

```
node server.js
```

Or, using the provided script:

```
npm start
```

By default it listens on port 3000 (`http://localhost:3000`). To use a
different port:

```
PORT=8080 node server.js
```

## First-time setup

1. Start the server and visit `http://yourdomain.com/admin/setup`.
2. Create a username and password (password must be at least 10
   characters).
3. You'll immediately be shown a **2FA secret key**. Open an
   authenticator app (Google Authenticator, Authy, 1Password, Microsoft
   Authenticator — any standard TOTP app works), choose "add account" →
   "enter a setup key manually," and enter that secret.
4. Enter the 6-digit code your app generates to confirm setup.
5. From then on, every login requires your password **and** a fresh
   6-digit code — two factors, both checked server-side.

This account info is stored in `data/admin.json` (password is hashed
with `scrypt`, never stored in plain text). **Back this file up** — if
you lose both your password and your authenticator app, the only
recovery path is deleting `data/admin.json` and running setup again
from scratch (see "Losing access" below).

## Using the admin panel

- `/admin/login` → enter username + password
- `/admin/verify-2fa` → enter your 6-digit authenticator code
- `/admin` → dashboard listing every post, with Edit / View / Delete
- `/admin/editor` → write a new post, or `/admin/editor?slug=article-x`
  to edit an existing one — with a live preview panel that updates as
  you type, using the site's real CSS
- Click **"Publish live"** — the post is saved to `data/posts.json` and
  is immediately visible at `/your-slug.html` and on the homepage. That's
  the whole publish flow. No file to download, nothing to upload.
- You can optionally upload a custom cover image per post (PNG/JPEG/WebP/SVG,
  under 2MB) instead of using the automatic category icon — pick it in
  the editor and it's saved to `public/uploads/` when you publish.

## How content is stored

```
data/
  posts.json    All 30 blog posts as structured data (title, category,
                threat level, body, etc.) — this is the live database.
  admin.json    Your hashed password + 2FA secret. Created on first setup.
```

There's no SQL database — `posts.json` is read and (on save) rewritten
directly by the server. This is entirely adequate for a single-admin
blog; if you outgrow it later, `lib/store.js` is the one file that would
need to change to point at a real database instead.

## Security notes — read this before going live

- **This login is real, server-side authentication** — unlike a
  client-side JavaScript gate, the password check and 2FA verification
  both happen on the server, using `crypto.scryptSync` for password
  hashing and a from-scratch TOTP implementation for 2FA (tested against
  the official RFC 4226 test vectors — see `lib/totp.js`).
- **Put this behind HTTPS in production.** The server itself speaks
  plain HTTP; run it behind a reverse proxy (Nginx, Caddy, or your
  host's built-in TLS termination) so login credentials and session
  cookies aren't sent in the clear. Caddy in particular can do this with
  a couple of lines of config and automatic free certificates.
- **Login attempts are rate-limited** — 6 failed attempts (on either the
  password step or the 2FA step) locks that IP out for 10 minutes.
- **Sessions are in-memory.** Restarting the server logs everyone out,
  and if you ever run multiple server instances behind a load balancer,
  sessions won't be shared between them. Fine for a single-process,
  single-admin setup; flag it if your hosting grows beyond that.
- **Admin pages are excluded from search indexing** (`noindex` meta tag
  and `Disallow: /admin/` in `robots.txt`), but that's not a substitute
  for the HTTPS + strong password + 2FA combination above.

## Losing access

If you lose your password and your authenticator app together, there's
no "forgot password" flow (by design — a recovery email flow would need
its own security review). To reset: stop the server, delete
`data/admin.json`, restart, and visit `/admin/setup` again to create a
fresh account. Your blog posts in `data/posts.json` are untouched by
this.

## Deploying

Any host that can run a persistent Node.js process works:

- **A VPS** (DigitalOcean, Linode, a cheap EC2 instance, etc.) — run
  `node server.js` under a process manager like `systemd` or `pm2` so it
  restarts automatically if it crashes or the server reboots, and put
  Nginx or Caddy in front for HTTPS.
- **Render, Railway, Fly.io** — all support "just run a Node process"
  deployments with HTTPS handled for you, and are a lighter-weight
  option than managing your own VPS.

Static hosts like Netlify, Cloudflare Pages, or GitHub Pages **won't
work** for this version — they only serve static files and can't run
the server-side admin panel or 2FA. That trade-off is the direct
consequence of what you asked for (instant publish with no manual
upload step): it requires an actual running server.

## File structure

```
server.js              The entire application — routing, static files,
                        auth, save/delete endpoints. No framework.
lib/
  totp.js               2FA implementation (RFC 6238), Node crypto only
  store.js               Reads/writes data/posts.json and data/admin.json,
                          session + login-attempt tracking
  render.js               HTML templates for the public site (homepage,
                            articles, sitemap)
  admin-views.js            HTML templates for the admin panel
data/
  posts.json                The 30 blog posts (your live content)
  admin.json                 Created on first setup — your credentials
public/
  assets/styles.css          Site design (colors, fonts, layout)
  assets/site.js              Theme toggle, mobile nav, newsletter form
  assets/covers/*.svg          17 category icon illustrations
  uploads/                      Custom cover images you upload via the editor
scripts/migrate.js         The one-off script used to convert the old
                            static article files into posts.json — kept
                            for reference, not needed at runtime
about.html, contact.html,
privacy.html, terms.html   Static pages (not blog posts) served as-is
robots.txt, ads.txt         Static files (ads.txt authorizes your AdSense
                             account; robots.txt blocks /admin/ from indexing)
```

## AdSense

Your AdSense verification script (`ca-pub-6710305777672064`) is baked
into every rendered page. `ads.txt` is in place. Ad slots — a leaderboard
and rectangle on the homepage, two in-article slots per post, and
skyscraper rails on wide screens — are still placeholder `<div>`s labeled
clearly; once your AdSense account is approved, replace the placeholder
markup in `lib/render.js` (for the public site) with your real
`<ins class="adsbygoogle">` ad unit snippets. Since pages are generated
from these templates, updating them once updates every page.
