#!/usr/bin/env bash
# Push the AI Code Review telemetry dashboard to a Grafana instance via its HTTP API.
#
# Secrets stay in YOUR shell, never in source. Run it like:
#   GRAFANA_URL=https://grafana.example.com \
#   GRAFANA_TOKEN=glsa_xxx \
#   ./grafana/push-dashboard.sh
#
# GRAFANA_TOKEN must be a service-account token (or API key) with the
# "Dashboards: write" permission in the target folder. GRAFANA_FOLDER_UID is
# optional (defaults to the General/root folder).
set -euo pipefail

: "${GRAFANA_URL:?set GRAFANA_URL, e.g. https://grafana.example.com}"
: "${GRAFANA_TOKEN:?set GRAFANA_TOKEN (service-account token)}"
FOLDER_UID="${GRAFANA_FOLDER_UID:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH_FILE="$SCRIPT_DIR/dashboards/ai-review-telemetry.json"

# Wrap the bare dashboard model in the create/update envelope. overwrite=true
# makes re-runs idempotent (matched by the dashboard uid).
BODY="$(FOLDER_UID="$FOLDER_UID" DASH_FILE="$DASH_FILE" python3 - <<'PY'
import json, os
dash = json.load(open(os.environ["DASH_FILE"]))
dash["id"] = None  # force create-or-update-by-uid, never collide on numeric id
env = {"dashboard": dash, "overwrite": True, "message": "ai-code-review telemetry dashboard"}
folder = os.environ.get("FOLDER_UID")
if folder:
    env["folderUid"] = folder
print(json.dumps(env))
PY
)"

# Keep the bearer token OUT of the process argument list (where `ps`/`/proc/<pid>/cmdline` would
# expose it to other users on a shared host). curl reads the Authorization header from a 0600
# --config file instead, removed on exit.
CURL_CONFIG="$(mktemp)"
chmod 600 "$CURL_CONFIG"  # mktemp mode is umask-dependent; narrow before writing the token
trap 'rm -f "$CURL_CONFIG"' EXIT
# The header value MUST stay quoted: curl's config parser trims an unquoted value at the first
# space, so `Authorization: Bearer <token>` would lose everything after "Authorization:" and 401.
# (A token containing a literal `"` would still break this, but Grafana glsa_* tokens never do.)
printf 'header = "Authorization: Bearer %s"\n' "$GRAFANA_TOKEN" >"$CURL_CONFIG"

curl -fsSL --config "$CURL_CONFIG" -X POST "${GRAFANA_URL%/}/api/dashboards/db" \
  -H "Content-Type: application/json" \
  -d "$BODY"
echo
