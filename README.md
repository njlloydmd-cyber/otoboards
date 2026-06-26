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
5. Render prompts you for the two secret values declared in `render.yaml`:
   - `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com/settings/keys)
   - `FIREBASE_SERVICE_ACCOUNT_BASE64` — from the Firebase steps above (leave blank if you're skipping the Question Bank for now)
6. Render builds and deploys. Your app is live at the `.onrender.com` URL it gives you.

A few things specific to Render:
- The included Blueprint uses `plan: free`, which sleeps after 15 minutes of inactivity (30–60 second cold start on the next request). That's fine for personal/small-group use; switch to `plan: starter` in `render.yaml` (~$7/month) if you want it always warm.
- Render's free tier has an **ephemeral filesystem** — it's wiped on every redeploy. That's exactly why the Question Bank lives in Firestore rather than a local file or SQLite database; nothing this app needs to persist lives on Render's disk.
- If you add `FIREBASE_SERVICE_ACCOUNT_BASE64` *after* the initial Blueprint deploy (rather than during the prompt), add it manually under your service's **Environment** tab in the Render dashboard — Render only prompts for `sync: false` variables on first creation, not on later Blueprint updates.

## Build for production

```
npm run build
npm start
```
