# OTOBOARDS

An AI-powered practice question generator for the Otolaryngology–Head and Neck Surgery board exam, with multiple testing modes and performance analytics. Powered by the [Claude API](https://docs.claude.com).

## Run Locally

**Prerequisites:** Node.js 18+

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env.local` and add your Anthropic API key:
   ```
   cp .env.example .env.local
   ```
   Get a key from [console.anthropic.com](https://console.anthropic.com/settings/keys). The key is only ever read by the Express server in `server.ts` — it is never bundled into client-side code.
3. Run the app:
   ```
   npm run dev
   ```
4. Open http://localhost:3000

## How it works

- **Frontend:** React + Vite (`App.tsx`).
- **Backend:** An Express server (`server.ts`) that talks to the Claude API on the frontend's behalf, so the API key never reaches the browser.
- **Document uploads:** PDFs are sent directly to Claude as native documents (Claude reads the page layout itself — no client-side rendering or page-by-page OCR needed). `.docx` files are parsed deterministically with [mammoth](https://github.com/mwilliamson/mammoth.js) (no AI call, so it's instant and free). Plain text/Markdown files are read directly in the browser.
- **Question generation:** Uses Claude's [structured outputs](https://docs.claude.com/en/docs/build-with-claude/structured-outputs) (tool-forced JSON) so responses always match the expected schema. Each request also lists your recently-seen questions so Claude avoids repeating them.
- **Question Bank:** A shared, growing pool of questions everyone using this deployment has marked as high quality (the star icon next to any explanation). It lives in Firestore — separate from Claude entirely — and once a question is in the bank, future "Question Bank" test sessions sample from it directly with **zero AI calls and zero token cost**. See setup below.
- **Cross-device sync (optional):** Sign in with Google to keep your sessions *and* uploaded documents in sync across devices. This is entirely optional — the app works fully with zero account, storing everything in the browser's local storage. Signing in adds a copy in Firestore, scoped to your account only (separate from the shared Question Bank above). The first time you sign in on a given account, any existing local data on that device is merged with whatever's already synced for that account, not overwritten. Documents sync individually (one Firestore document per uploaded file, capped at ~900KB each) rather than bundled with sessions, since extracted PDF/docx text can be much larger than session data.
- **Offline fallback:** If Claude is rate-limited or unreachable, the app falls back to a small curated bank of board questions (`curatedQuestions.ts`) so a study session is never completely blocked.

## Setting up the Question Bank (Firestore)

The Question Bank needs its own Firestore database — this is separate infrastructure from Claude, and you'll need a (free) Google/Firebase account to set it up. I can't create this for you; it requires your own account.

1. Go to the [Firebase console](https://console.firebase.google.com), create a new project (or reuse an existing one).
2. In that project, go to **Build → Firestore Database** and create a database (any region; Native mode).
3. Go to **Project Settings → Service Accounts → Generate new private key**. This downloads a JSON file — keep it private, it's a credential.
4. Base64-encode that file into a single-line string (this avoids the classic problem of multi-line private keys getting mangled by hosting-platform environment-variable UIs):
   ```
   node -e "console.log(require('fs').readFileSync('/path/to/your-key.json').toString('base64'))"
   ```
5. Set the result as `FIREBASE_SERVICE_ACCOUNT_BASE64` in your `.env.local` (locally) and in your hosting platform's environment variables (in production).

Note on security: the browser never talks to Firestore directly — only the Express server does, using this service account's elevated access. So there's no separate Firestore security-rules configuration needed; access to the bank is gated the same way access to the rest of the app already is (whoever can reach this deployment's URL).

If `FIREBASE_SERVICE_ACCOUNT_BASE64` isn't set, the Question Bank endpoints fail gracefully (clear error message, no crash) — everything else in the app works fine without it.

## Setting up cross-device sync (Google sign-in)

This reuses the same Firebase project as the Question Bank above, so do that first if you haven't. Cross-device sync needs one more thing on top: a registered "Web app" in that project, which gives you a set of **public** config values (different from the private service account key — these are safe to expose in the browser).

1. In the [Firebase console](https://console.firebase.google.com), open your project → gear icon → **Project Settings** → scroll to **Your apps** → click the **Web** icon (`</>`) to register a new web app (any nickname is fine; you don't need Firebase Hosting).
2. It shows you a `firebaseConfig` object. You need four values from it: `apiKey`, `authDomain`, `projectId`, `appId`.
3. Still in the Firebase console, go to **Build → Authentication → Sign-in method**, click **Google** in the provider list, and enable it.
4. Set these as environment variables (`.env.local` locally, or your hosting platform in production):
   ```
   VITE_FIREBASE_API_KEY=<apiKey>
   VITE_FIREBASE_AUTH_DOMAIN=<authDomain>
   VITE_FIREBASE_PROJECT_ID=<projectId>
   VITE_FIREBASE_APP_ID=<appId>
   ```
   Note the `VITE_` prefix — Vite only exposes env vars with this prefix to browser code, and it bakes them into the built bundle **at build time**, not runtime. That means these must be set *before* `npm run build` runs, not just before `npm start`.
5. If you're deploying on a platform with a separate "preview" or "production" URL, you may also need to add that URL to **Authentication → Settings → Authorized domains** in the Firebase console, or sign-in will be rejected.

Leave all four blank (or unset) and the "Sign in to sync" button simply doesn't appear — the rest of the app is unaffected.

## Deploying to Render

This repo includes a `render.yaml` Blueprint, so most of the setup is one click once your code is on GitHub.

1. **Push this code to a GitHub repo** (Render deploys from a Git repo, not a zip upload):
   ```
   git init
   git add .
   git commit -m "Initial commit"
   ```
   Then create an empty repo on [github.com/new](https://github.com/new) and follow the "push an existing repository" instructions it shows you.
2. **Do the Firebase setup above first** if you want the Question Bank live from day one (you can also skip it and add it later — the rest of the app works without it).
3. Go to the [Render Dashboard](https://dashboard.render.com), click **New → Blueprint**, and connect the GitHub repo you just pushed.
4. Render reads `render.yaml` and shows you a preview of what it'll create (one free web service). Click **Deploy Blueprint**.
5. Render prompts you for the secret values declared in `render.yaml`:
   - `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com/settings/keys)
   - `FIREBASE_SERVICE_ACCOUNT_BASE64` — from the Question Bank setup above (leave blank to skip for now)
   - `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` — from the cross-device sync setup above (leave all four blank to skip for now)
6. Render builds and deploys. Your app is live at the `.onrender.com` URL it gives you.

A few things specific to Render:
- The included Blueprint uses `plan: free`, which sleeps after 15 minutes of inactivity (30–60 second cold start on the next request). That's fine for personal/small-group use; switch to `plan: starter` in `render.yaml` (~$7/month) if you want it always warm.
- Render's free tier has an **ephemeral filesystem** — it's wiped on every redeploy. That's exactly why the Question Bank and sync data live in Firestore rather than a local file or SQLite database; nothing this app needs to persist lives on Render's disk.
- If you add any of these variables *after* the initial Blueprint deploy (rather than during the prompt), add them manually under your service's **Environment** tab in the Render dashboard — Render only prompts for `sync: false` variables on first creation, not on later Blueprint updates.
- **If `render.yaml` changes ever stop taking effect** (e.g. editing `buildCommand` in the file doesn't change what actually runs) — this can happen if your service's settings get "stuck" on values set directly in the dashboard at some point. If so, set the value directly under your service's **Settings** tab instead of relying on the file; that's a more reliable source of truth if the Blueprint sync seems to be ignoring your edits.
- Remember that `VITE_*` variables are baked into the bundle at **build time**. If you add or change one, you need a fresh build (a new deploy), not just a restart, for it to take effect.

## Build for production

```
npm run build
npm start
```
