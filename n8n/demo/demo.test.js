// The scripted demo as a TEST: the combined demo workflow, 16 steps, every check must pass (the transcript: node n8n/demo/run-demo.js).
// Synthetic data, a scripted model, fake Grist; nothing can reach the network. Run: node n8n/demo/demo.test.js   (DEMO_WORKFLOW_FILE=<another build>)
const http = require('http');
const https = require('https');
const net = require('net');
const trap = () => { throw new Error('this test must not touch the network'); };
global.fetch = trap; http.request = trap; http.get = trap; https.request = trap; https.get = trap; net.connect = trap; net.createConnection = trap;

const { runScenario } = require('./scenario');

const { results } = runScenario();
let ok = 0; let bad = 0;
for (const s of results) {
  for (const c of s.checks) { if (c.ok) ok++; else { bad++; console.log(`FAIL  step ${s.id} - ${c.desc}\n        ${c.why}`); } }
  if (s.error) { bad++; console.log(`FAIL  step ${s.id} crashed: ${s.error}`); }
}
if (bad) { console.log(`\nDEMO SCRIPT: ${bad} check(s) FAILED, ${ok} passed`); process.exit(1); }
console.log(`DEMO SCRIPT: ${ok} of ${ok} checks pass in ${results.length} steps (missed call, retries, English + Hinglish, requests, confirm / conflict / decline, hand-off, emergency, opt-out, Ollama down, night)`);
