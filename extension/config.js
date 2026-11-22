// Watch Party configuration.
// The relay server runs on the host's Mac and is exposed through ngrok (see scripts/start-server.sh).
//   local-only testing:  'ws://localhost:8080'
//   via ngrok:           'wss://kabob-either-stung.ngrok-free.dev'
/* eslint-disable no-unused-vars */
const SERVER_URL = 'wss://kabob-either-stung.ngrok-free.dev';

// Video call: STUN servers help two computers on different networks find a direct path to each other.
// That works for most home internet connections. If calls connect but show no video on some networks
// (strict office/mobile networks), add a TURN server here, e.g.
//   { urls: 'turn:your-turn-host:3478', username: 'user', credential: 'pass' }
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
