# SlowTalk v0.2

Browser-first starter with Google sign-in, Gmail contacts, PostgreSQL-backed message history, Socket.IO live messaging, call invitation/signalling, WebRTC audio/video UI, and Web Push notifications.

## Deploy to Render

1. Create a Render PostgreSQL database.
2. Upload the contents of this folder to a GitHub repository.
3. Create a Render Web Service for the repo.
4. Build command: `npm install`; start command: `npm start`.
5. Set Render environment variables: `NODE_ENV=production`, `DATABASE_URL` (Render PostgreSQL internal URL), `SESSION_SECRET` (long random value), `GOOGLE_CLIENT_ID`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, and `VAPID_PRIVATE_KEY`.
6. In Google Cloud Console, configure the OAuth consent screen and create an OAuth Client ID of type **Web application**. Add the Render URL to Authorized JavaScript origins.
7. Generate VAPID keys using `npx web-push generate-vapid-keys`. Keep the private key secret.
8. Open the Render HTTPS URL, sign in with Google, add a registered Gmail contact, then enable browser alerts.

## Important limitations

- No local HTTPS certificate is used. Render terminates HTTPS at its edge.
- Both users must sign in to SlowTalk before they can be added.
- Contacts must be saved by both users before messages/calls are allowed.
- Web Push requires real VAPID keys, HTTPS, browser permission, and OS/browser support.
- WebRTC currently uses STUN only; a TURN server is recommended for calls across restrictive networks.
- This is a v0.2 starter, not a security-audited production messenger. Before a public launch add rate limiting, call timeout/ringing lifecycle, block/report controls, read receipts, backup/retention policy, and tests.
