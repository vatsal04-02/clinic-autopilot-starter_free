#!/usr/bin/env bash
# Fills the EMPTY secrets in .env.demo with random values (never prints them). Run once: ./scripts/gen-demo-secrets.sh .env.demo
# DEMO_CALL_SECRET and DEMO_META_APP_SECRET are also what you paste into the demo workflow (n8n/demo/DEMO.md, step 4): they are made-up demo values,
# NOT your real Meta App Secret. Do not put a real credential here.
set -euo pipefail

ENV_FILE="${1:-.env.demo}"
[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE found. Run: cp .env.demo.example .env.demo"; exit 1; }

fill() {
  local key="$1"
  if grep -qE "^${key}=$" "$ENV_FILE"; then
    sed -i "s|^${key}=$|${key}=$(openssl rand -hex 32)|" "$ENV_FILE"
    echo "Generated ${key}"
  else
    echo "${key} already set, leaving it alone"
  fi
}

for k in N8N_ENCRYPTION_KEY GRIST_SESSION_SECRET FLOWHQ_SESSION_SECRET DEMO_CALL_SECRET DEMO_META_APP_SECRET; do fill "$k"; done
chmod 600 "$ENV_FILE"
echo "Done. Pin N8N_VERSION and GRIST_VERSION in $ENV_FILE before 'docker compose up'."
