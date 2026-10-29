# GPI Thekedar Entry (web app)

A phone-friendly web app for GPI contractors (thekedars). In each 10-minute entry window, every 3 hours, the contractor opens the app and taps **Record entry**. The server compares the phone's GPS with the GPI, Paras and Zahir geofences and records **IN FACTORY**, **OUT OF FACTORY** or **LOCATION UNVERIFIED**. Admins use the existing dashboard (the Apps Script web app link).

It runs on GitHub Pages and works in Chrome on Android, on tablets and on computers. It can be added to the home screen. No Android Studio and no APK.

## Files

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The contractor app |
| `config.js` | **The only file you edit:** your Apps Script `/exec` URL |
| `sw.js`, `manifest.webmanifest`, `icons/` | Lets the app open offline and be added to the home screen |
| `backend/` | The Google Apps Script backend (`Code.gs`, `Dashboard.html`, `appsscript.json`). Paste these into Apps Script; they are kept here for safekeeping and version history |
| `tests/` | Automated tests (not needed to run the app) |

## Set up

Follow the step-by-step guide shared with this project ("GPI Thekedar Web App: Setup and Deployment Guide"). In short:

1. Paste `backend/Code.gs` and `backend/Dashboard.html` into Apps Script, run `initialSetup` once, then **Deploy > Manage deployments > edit > New version**.
2. In the dashboard **Settings**, set **Entry window opens at**.
3. Put your `/exec` URL in `config.js`.
4. Upload all files to a public GitHub repository and turn on **Settings > Pages** (branch `main`, folder `/ (root)`).

## Updating

- **App:** edit a file on GitHub (pencil icon) and commit. GitHub Pages updates in 1-2 minutes, and phones get the new version the next time they open the app online.
- **Backend:** edit in Apps Script, then **Deploy > Manage deployments > edit > New version**. The URL stays the same.

## Security notes

- There are no secrets in this repository. The `/exec` URL in `config.js` is public by nature: every phone needs it. Access is protected on the server by contractor ID + PIN, lockout after 5 wrong PINs, and signed login tokens.
- The token-signing secret lives only in Apps Script **Script Properties** and is never in this code.
- Contractors can only record their own entries; admin actions require an admin login.

## Limitations

- **No background tracking.** Browsers do not let a web page read GPS when it is closed or the phone is locked. Contractors must open the app in every window; the dashboard shows missed windows.
- **No automatic reminders.** The app shows the day's window times so contractors can set phone alarms.
- **GPS can be faked.** The app records accuracy and time, and the server rejects stale, inaccurate or implausible readings, but a browser cannot detect fake-GPS apps.
- **Offline entries count only if the phone clock was right.** They are marked `IN WINDOW (OFFLINE)` so admins can spot them.

## Tests

`cd tests && npm install && npm test` runs the backend, dashboard and web-app tests (Node.js). Latest results: `tests/TEST_RESULTS.txt`.
