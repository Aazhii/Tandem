// Tandem configuration (defaults built into the extension).
//
// Leave these empty to share one extension zip with anyone: each person then enters the server
// address (and party key, if the server has one) in the popup → ⚙ Server settings.
//
// Hosts who build a zip just for their friends can bake their server in instead. Put the same
// three constants in extension/config.local.js (not committed to git) and run
// ./scripts/package-extension.sh: the zip then uses config.local.js, so friends need no setup.
//   local-only testing:  'ws://localhost:8080'
//   via ngrok:           'wss://your-domain.ngrok-free.dev'
/* eslint-disable no-unused-vars */
const SERVER_URL = '';
const PARTY_KEY = '';

// Video call: STUN servers help two computers on different networks find a direct path to each other.
// TURN (for strict networks) is configured on the server (scripts/setup-turn.sh) and handed out to
// party members automatically, so nothing needs to be added here.
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
