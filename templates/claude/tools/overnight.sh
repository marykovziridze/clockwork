#!/usr/bin/env bash
# Clockwork overnight launcher (macOS). Managed by Clockwork: do not edit in a project.
#
# Opens ONE interactive `claude` session in a Terminal.app window in auto mode, keeps the Mac awake
# (caffeinate on AC power), and writes a heartbeat log. It never uses bypassPermissions and never
# uses `claude -p`/--bg: auto-continue after a usage-limit reset exists only in interactive
# claude.ai sessions (https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset).
#
# Usage: overnight.sh --project <dir> --plan <file> [--until HH:MM] [--name <n>] [--dry-run] [--allow-battery]
# Exit: 0 = ok (dry-run: all preflight passed / launched), 1 = preflight or launch failed, 2 = usage/crash.
# Env (tests): CLOCKWORK_OSASCRIPT (default osascript), CLOCKWORK_HEARTBEAT_SECS (300),
#              CLOCKWORK_TICK_SECS (10), CLOCKWORK_STOP_EPOCH (override computed stop time),
#              CLOCKWORK_STALL_SECS (3600: no ledger change for this long = a STALLED line in the log).
#
# Flags verified with `claude --help` (2.1.285): -n/--name, --permission-mode auto, --settings <file>.
# Verified in raw docs 2026-09-30:
#  - Claude Code >= 2.1.234 for auto-continue (interactive-mode.md "Wait for a usage limit to reset").
#  - `claude "/goal ..."` as the initial prompt runs /goal (tested: `claude "/goal"` opened the goal panel).
#  - autoContinueAtUsageLimit is read from user settings, --settings and managed settings only; a
#    project/local file that sets it while none of those does turns the feature OFF (settings-reference.md).
#  - Background Bash commands stop after a time limit: default 30 min, max 2 h, set by the `timeout`
#    Claude passes with run_in_background (changelog 2.1.285). No setting/env var found that raises it.
#  - Auto mode pauses and prompts after 3 classifier blocks in a row or 20 in total; not configurable
#    (permission-modes.md "When auto mode falls back").
#  - A Remote Control session does not start the usage-limit wait on its own (interactive-mode.md);
#    remoteControlAtStartup false is honoured from any settings file (settings-reference.md).
#  - /goal condition: at most 4,000 characters (goal.md).
#  - --settings takes one file (cli-reference.md), so the kit deny list and this Mac's own list are merged into
#    .claude/.state/overnight-settings.json (gitignored) at launch. Deny rules accept a server name, mcp__<server>,
#    and glob tool names (permissions.md "Tool name wildcards").
#  - The plan, ledger and verify scratch live under PM/, not .claude/: writes into .claude/ are "protected paths",
#    never auto-approved and routed to the auto-mode classifier (permission-modes.md "Protected paths").
set -euo pipefail

MIN_CLAUDE="2.1.234"
SELF="${BASH_SOURCE[0]}"
case "$SELF" in /*) ;; *) SELF="$PWD/$SELF" ;; esac

PROJECT=""; PLAN=""; UNTIL=""; NAME=""; DRY=0; ALLOW_BATTERY=0
HB_MODE=0; HB_PID=""; HB_STOP=""; HB_LOG=""; HB_LEDGER=""; HB_LOCK=""

usage() {
  cat <<'EOF'
Usage: overnight.sh --project <dir> --plan <file> [--until HH:MM] [--name <n>] [--dry-run] [--allow-battery]
  --project        project root (has .claude/clockwork.json)
  --plan           overnight plan file (default place: PM/overnight/OVERNIGHT-PLAN.md; template:
                   .claude/skills/overnight/plan-template.md). The night follows exactly this file.
  --until HH:MM    stop time; overrides the plan's "Stop time:" line
  --name <n>       session name (default: clockwork.json overnight.sessionName, else <folder>-overnight)
  --dry-run        run every preflight check, print PASS/WARN/FAIL, launch nothing, write nothing
  --allow-battery  allow a run on battery (WARN instead of FAIL; the Mac will sleep when the battery dies)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --plan) PLAN="${2:-}"; shift 2 ;;
    --until) UNTIL="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --allow-battery) ALLOW_BATTERY=1; shift ;;
    --_heartbeat) HB_MODE=1; shift ;;
    --_pid) HB_PID="${2:-}"; shift 2 ;;
    --_stop) HB_STOP="${2:-}"; shift 2 ;;
    --_log) HB_LOG="${2:-}"; shift 2 ;;
    --_ledger) HB_LEDGER="${2:-}"; shift 2 ;;
    --_lock) HB_LOCK="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERR unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

OSA="${CLOCKWORK_OSASCRIPT:-osascript}"
HB_SECS="${CLOCKWORK_HEARTBEAT_SECS:-300}"
TICK_SECS="${CLOCKWORK_TICK_SECS:-10}"
STALL_SECS="${CLOCKWORK_STALL_SECS:-3600}"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

# ---------------------------------------------------------------- heartbeat (runs detached)
# Streams every line straight to the log file; nothing is collected in a variable.
heartbeat() {
  local next=0 stop_logged=0 now left mt last_change stalled=0
  hb() { printf '%s %s\n' "$(stamp)" "$*" >> "$HB_LOG"; }
  last_change=$(date +%s)
  hb "HEARTBEAT START monitor_pid=$$ claude_pid=$HB_PID stop_epoch=$HB_STOP"
  while :; do
    if ! kill -0 "$HB_PID" 2>/dev/null; then
      hb "CLAUDE EXITED pid=$HB_PID (heartbeat ends)"
      break
    fi
    now=$(date +%s)
    if [ "$stop_logged" -eq 0 ] && [ "$now" -ge "$HB_STOP" ]; then
      hb "STOP TIME REACHED (claude pid=$HB_PID still alive; the session stops itself per its /goal)"
      stop_logged=1
    fi
    mt=$(stat -f %m "$HB_LEDGER" 2>/dev/null || echo 0)
    if [ "$mt" -gt "$last_change" ]; then last_change=$mt; stalled=0; fi
    if [ "$stalled" -eq 0 ] && [ $(( now - last_change )) -ge "$STALL_SECS" ]; then
      hb "STALLED? no ledger change for $(( (now - last_change) / 60 )) min: the window may be waiting at a prompt (auto mode pauses after 3 blocks in a row or 20 in total). Look at the Terminal window."
      stalled=1
    fi
    if [ "$now" -ge "$next" ]; then
      left=$(( (HB_STOP - now) / 60 ))
      hb "heartbeat claude_pid=$HB_PID alive=yes minutes_to_stop=$left"
      if [ -f "$HB_LEDGER" ]; then
        tail -n 2 "$HB_LEDGER" | sed "s/^/    ledger: /" >> "$HB_LOG"
      else
        printf '    ledger: (none at %s)\n' "$HB_LEDGER" >> "$HB_LOG"
      fi
      next=$(( now + HB_SECS ))
    fi
    sleep "$TICK_SECS"
  done
  # release the lock only if it is still ours
  if [ -n "$HB_LOCK" ] && [ -f "$HB_LOCK" ] && grep -q "^pid=$$\$" "$HB_LOCK" 2>/dev/null; then
    rm -f "$HB_LOCK"
  fi
}

if [ "$HB_MODE" -eq 1 ]; then
  [ -n "$HB_PID" ] && [ -n "$HB_STOP" ] && [ -n "$HB_LOG" ] || { echo "ERR heartbeat needs --_pid --_stop --_log" >&2; exit 2; }
  heartbeat
  exit 0
fi

# ---------------------------------------------------------------- preflight helpers
FAILS=0; WARNS=0; PASSES=0
pass() { printf 'PASS  %s\n' "$*"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
warn() { printf 'WARN  %s\n' "$*"; WARNS=$((WARNS + 1)); }

plan_field() { # $1 = key at line start ("Goal", "Stop time"...), optional "- " bullet; prints trimmed value
  grep -iE "^[[:space:]]*(-[[:space:]]+)?$1[[:space:]]*:" "$PLAN" 2>/dev/null | head -n1 \
    | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]+$//' || true
}
is_placeholder() { # empty, <angle placeholder>, TODO/TBD/FIXME
  [[ -z "$1" || "$1" =~ \<[^\>]*\> || "$1" =~ (TODO|TBD|FIXME) ]]
}
section_lines() { # $1 = text the "## " heading contains; prints the count of filled bullet lines under it (-1 = no such heading)
  awk -v pat="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" '
    /^##[[:space:]]/ { on = (index(tolower($0), pat) > 0); found = found || on; next }
    on && $0 ~ /^[[:space:]]*([-*]|[0-9]+\.)[[:space:]]+[^[:space:]]/ && $0 !~ /<[^>]*>/ && $0 !~ /(TODO|TBD|FIXME)/ { n++ }
    END { if (!found) print -1; else print n + 0 }' "$PLAN"
}
abs_dir() { (cd "$1" 2>/dev/null && pwd -P) || true; }
as_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
pid_is_ours() { # alive AND looks like overnight.sh / claude / caffeinate (guards against a recycled PID)
  local p="$1" cmd
  [[ "$p" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  cmd=$(ps -p "$p" -o command= 2>/dev/null || true)
  [[ "$cmd" == *overnight.sh* || "$cmd" == *claude* ]]
}

echo "== Clockwork overnight preflight $(stamp) =="

# 0. platform + arguments
if [ "$(uname -s)" != "Darwin" ]; then
  fail "macOS only (needs pmset, caffeinate, Terminal.app); this is $(uname -s)"
fi
[ -n "$PROJECT" ] || { echo "ERR --project is required" >&2; usage >&2; exit 2; }
[ -n "$PLAN" ] || { echo "ERR --plan is required" >&2; usage >&2; exit 2; }

PROJECT_ABS=$(abs_dir "$PROJECT")
if [ -z "$PROJECT_ABS" ]; then
  echo "FAIL  project folder not found: $PROJECT"; echo "PREFLIGHT FAILED (1 FAIL)"; exit 1
fi
PROJECT="$PROJECT_ABS"
case "$PLAN" in /*) ;; *) [ -f "$PLAN" ] || PLAN="$PROJECT/$PLAN" ;; esac
[ -f "$PLAN" ] && PLAN="$(cd "$(dirname "$PLAN")" && pwd -P)/$(basename "$PLAN")"
STATE="$PROJECT/.claude/.state"
LOCK="$STATE/overnight.lock"
SETTINGS_REL=".claude/overnight-settings.json"
MERGED_REL=".claude/.state/overnight-settings.json"
MACHINE_DENY="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/clockwork-overnight-deny.json"
# the plan as the night session will read it: relative to the project when it is inside it
case "$PLAN" in "$PROJECT"/*) PLAN_REL="${PLAN#"$PROJECT"/}" ;; *) PLAN_REL="$PLAN" ;; esac

if [ -f "$PROJECT/.claude/clockwork.json" ]; then
  pass "project: $PROJECT (has .claude/clockwork.json)"
else
  warn "project has no .claude/clockwork.json; Clockwork is not installed here (run install.mjs)"
fi

# session name
if [ -z "$NAME" ] && [ -f "$PROJECT/.claude/clockwork.json" ]; then
  NAME=$(sed -nE 's/.*"sessionName"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$PROJECT/.claude/clockwork.json" | head -n1 || true)
fi
if [ -z "$NAME" ]; then
  NAME="$(basename "$PROJECT" | tr '[:upper:] ' '[:lower:]-')-overnight"
fi
if [[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  pass "session name: $NAME"
else
  fail "session name '$NAME' has characters outside A-Z a-z 0-9 . _ - (pass --name)"
fi

# 1. claude version
CLAUDE_BIN=$(command -v claude || true)
if [ -z "$CLAUDE_BIN" ]; then
  fail "claude not found on PATH"
else
  CLAUDE_VER=$("$CLAUDE_BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
  if [ -z "$CLAUDE_VER" ]; then
    fail "could not read the claude version (claude --version printed nothing usable)"
  elif [ "$(printf '%s\n%s\n' "$MIN_CLAUDE" "$CLAUDE_VER" | sort -V | head -n1)" = "$MIN_CLAUDE" ]; then
    pass "claude $CLAUDE_VER (>= $MIN_CLAUDE, needed for auto-continue after a usage-limit reset)"
  else
    fail "claude $CLAUDE_VER is older than $MIN_CLAUDE (auto-continue after a usage-limit reset needs it). Run: claude update"
  fi
fi

# 2. power
BATT=$(pmset -g batt 2>/dev/null | head -n1 || true)
if [[ "$BATT" == *"AC Power"* ]]; then
  pass "AC power connected (pmset: $BATT)"
elif [[ "$BATT" == *"Battery Power"* ]]; then
  if [ "$ALLOW_BATTERY" -eq 1 ]; then
    warn "ON BATTERY, allowed by --allow-battery: caffeinate -s is ignored on battery, the Mac can sleep and the run stops"
  else
    fail "on battery power: plug in the charger (caffeinate -s only works on AC) or pass --allow-battery"
  fi
else
  fail "cannot tell the power source from 'pmset -g batt' (got: ${BATT:-nothing}); plug in and retry"
fi
warn "keep the lid OPEN all night (closing it sleeps the Mac even with caffeinate). Clamshell only with power + external display + keyboard: unsure, untested here"

# 3. tools used at launch
command -v caffeinate >/dev/null 2>&1 && pass "caffeinate found" || fail "caffeinate not found"
if command -v "$OSA" >/dev/null 2>&1 || [ -x "$OSA" ]; then
  pass "window opener found: $OSA"
else
  fail "osascript not found ($OSA)"
fi

# 4. overnight settings file (deny rules + OVERNIGHT=1)
if [ -f "$PROJECT/$SETTINGS_REL" ]; then
  if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$PROJECT/$SETTINGS_REL" 2>/dev/null; then
    pass "$SETTINGS_REL exists and is valid JSON (deny rules for outward actions)"
  else
    fail "$SETTINGS_REL is not valid JSON"
  fi
else
  fail "$SETTINGS_REL is missing: without it nothing blocks deploys or client mail overnight. Re-run install.mjs"
fi

# 4a. this Mac's own deny rules (client connectors, private servers): kept out of the kit file, which is committed
#     into every client repository
MACHINE_RULES=0
if [ -f "$MACHINE_DENY" ]; then
  if MACHINE_RULES=$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const d = Array.isArray(j) ? j : (j.permissions && j.permissions.deny) || j.deny;
    if (!Array.isArray(d) || !d.every((x) => typeof x === "string")) throw new Error("need a JSON array of rule strings, or {\"deny\": [...]}");
    console.log(d.length);' "$MACHINE_DENY" 2>/dev/null); then
    pass "$MACHINE_RULES deny rule(s) for this Mac from $MACHINE_DENY (merged into $MERGED_REL at launch)"
  else
    fail "$MACHINE_DENY is not a JSON array of deny rules (or {\"deny\": [...]}): fix it or move it away"; MACHINE_RULES=0
  fi
else
  warn "no $MACHINE_DENY: each client's own connectors (a WordPress or shop connector per client) are denied only if listed there, as a JSON array such as [\"mcp__claude_ai_<Client>_Wordpress\"]"
fi

# 4b. Remote Control: a Remote Control session never starts the usage-limit wait by itself
RC_USER=0
[ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" ] && grep -Eq '"remoteControlAtStartup"[[:space:]]*:[[:space:]]*true' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" && RC_USER=1
if [ -f "$PROJECT/$SETTINGS_REL" ] && grep -Eq '"remoteControlAtStartup"[[:space:]]*:[[:space:]]*false' "$PROJECT/$SETTINGS_REL"; then
  pass "Remote Control off for the night window ($SETTINGS_REL sets remoteControlAtStartup false)"
elif [ "$RC_USER" -eq 1 ]; then
  fail "user settings turn Remote Control on at startup and $SETTINGS_REL does not turn it off: a Remote Control session does not wait for a usage-limit reset on its own. Re-run install.mjs to restore $SETTINGS_REL"
else
  warn "$SETTINGS_REL does not set remoteControlAtStartup false; if Remote Control connects, the night will not wait for a usage-limit reset"
fi

# 4c. MCP servers the deny list does not know (they may send, publish or write production)
if [ -f "$PROJECT/$SETTINGS_REL" ]; then
  MCP_UNKNOWN=$(node -e '
    const fs=require("fs"), path=require("path");
    const deny=[...((JSON.parse(fs.readFileSync(process.argv[1],"utf8")).permissions||{}).deny||[])];
    try { const j=JSON.parse(fs.readFileSync(process.argv[3],"utf8")); deny.push(...(Array.isArray(j)?j:(j.permissions&&j.permissions.deny)||j.deny||[])); } catch {}
    const names=new Set();
    for (const f of [path.join(process.env.HOME||"",".claude.json"), path.join(process.argv[2],".mcp.json")]) {
      try { Object.keys(JSON.parse(fs.readFileSync(f,"utf8")).mcpServers||{}).forEach((n)=>names.add(n)); } catch {}
    }
    const readOnly=new Set(["chrome-devtools","obsidian","ads-competitor-research"]); // local or read-only
    console.log([...names].filter((n)=>!readOnly.has(n) && !deny.some((r)=>r===`mcp__${n}` || r.startsWith(`mcp__${n}__`))).join(" "));
  ' "$PROJECT/$SETTINGS_REL" "$PROJECT" "$MACHINE_DENY" 2>/dev/null || true)
  if [ -n "$MCP_UNKNOWN" ]; then
    warn "MCP server(s) with no overnight deny rule: $MCP_UNKNOWN. If one can send mail, publish or write production, add \"mcp__<name>\" to $MACHINE_DENY"
  else
    pass "every MCP server in ~/.claude.json and .mcp.json is denied or known read-only (those two files only)"
  fi
  warn "claude.ai connectors (mcp__claude_ai_*) and plugin MCP servers (mcp__plugin_*) are in no file this check can read: only the deny rules in $SETTINGS_REL and $MACHINE_DENY cover them. A connector you authenticate later is writable overnight until you list it"
fi

# 4d. production deploy paths: every deploy script and commands.productionDeploy must be blocked by guard-bash overnight
GUARD="$PROJECT/.claude/hooks/guard-bash.mjs"
if [ ! -f "$GUARD" ]; then
  fail "$GUARD is missing: nothing would block production deploys overnight. Re-run install.mjs"
else
  DEPLOY_CHECK=$(node --input-type=module -e '
    import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
    const [guard, root] = process.argv.slice(2); // argv[1] is a placeholder: with -e it would equal the guard path and run its main()
    const g = await import(pathToFileURL(guard).href);
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(root, ".claude/clockwork.json"), "utf8")); } catch {}
    const skip = new Set(["node_modules", ".git", "worktrees", "vendor", "wp-admin", "wp-includes", "archive", ".clockwork-backups"]);
    const cands = [];
    const walk = (d, depth) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) { const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!skip.has(e.name) && depth < 4) walk(p, depth + 1); continue; }
        const m = /deploy/i.test(e.name) && /\.(py|sh|js|mjs|php|rb)$/.exec(e.name);
        if (m) cands.push(`${{ py: "python3", sh: "bash", js: "node", mjs: "node", php: "php", rb: "ruby" }[m[1]]} ${path.relative(root, p)}`); } };
    walk(root, 0);
    for (const dir of [root, path.join(root, cfg.siteDir || ".")]) { try { for (const n of Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts || {})) if (/deploy|release|publish/i.test(n) && !/preview|staging|dev\b/i.test(n)) cands.push(`npm run ${n}`); } catch {} }
    const prod = (cfg.commands || {}).productionDeploy || "";
    cands.push(...g.commandTexts(prod));
    const preview = g.previewTextsOf(cfg);
    const ctx = { cwd: root, overnight: true, productionPatterns: () => g.productionPatternsOf(cfg), previewTexts: () => preview };
    const open = [...new Set(cands)].filter((c) => !preview.includes(c) && !g.evaluate(c, ctx).findings.some((f) => f.deny));
    console.log(JSON.stringify({ n: new Set(cands).size, open, prod: !!prod.trim(), stack: cfg.stack || "" }));
  ' _ "$GUARD" "$PROJECT" 2>&1 || echo '{"error":true}')
  case "$DEPLOY_CHECK" in
    *'"error"'*|'') fail "could not check deploy scripts against guard-bash ($DEPLOY_CHECK)" ;;
    *'"open":[]'*) pass "production deploy paths blocked overnight ($(printf '%s' "$DEPLOY_CHECK" | sed -E 's/.*"n":([0-9]+).*/\1/') found, each denied by guard-bash)"
      if printf '%s' "$DEPLOY_CHECK" | grep -q '"prod":false'; then warn "clockwork.json commands.productionDeploy is empty: the guard blocks deploy-named scripts and interpreter-run scripts that upload (FTP, SFTP, curl -T, WordPress REST writes); any other way this project reaches production must be set there"; fi ;;
    *) fail "production deploy command(s) NOT blocked overnight: $(printf '%s' "$DEPLOY_CHECK" | sed -E 's/.*"open":\[([^]]*)\].*/\1/'). Add them to clockwork.json productionPatterns or commands.productionDeploy" ;;
  esac
fi

# 5. the plan
PLAN_OK=1
if [ ! -f "$PLAN" ]; then
  fail "plan file not found: $PLAN"; PLAN_OK=0
else
  GOAL=$(plan_field "Goal"); VERIFY=$(plan_field "Verification command"); PSTOP=$(plan_field "Stop time")
  TURNCAP=$(plan_field "Turn cap"); SPENDCAP=$(plan_field "Spend cap"); LEDGER_REL=$(plan_field "Ledger")
  if is_placeholder "$GOAL"; then fail "plan: 'Goal:' is missing or still a placeholder"; PLAN_OK=0; else pass "plan: goal set"; fi
  if is_placeholder "$VERIFY"; then fail "plan: 'Verification command:' is missing or still a placeholder (the run needs a pass/fail command)"; PLAN_OK=0; else pass "plan: verification command set ($VERIFY)"; fi
  if is_placeholder "$PSTOP" || ! [[ "$PSTOP" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
    if [ -n "$UNTIL" ]; then warn "plan: 'Stop time:' is missing or not HH:MM; using --until $UNTIL"; else fail "plan: 'Stop time:' must be HH:MM (24 h), got '${PSTOP:-nothing}'"; PLAN_OK=0; fi
  else
    pass "plan: stop time $PSTOP"
  fi
  if is_placeholder "$TURNCAP" || ! [[ "$TURNCAP" =~ [0-9]+ ]]; then fail "plan: 'Turn cap:' needs a number (for example 150)"; PLAN_OK=0; else pass "plan: turn cap $TURNCAP"; fi
  if is_placeholder "$SPENDCAP" || ! [[ "$SPENDCAP" =~ [0-9] ]]; then fail "plan: 'Spend cap:' needs an amount (for example \$100)"; PLAN_OK=0; else pass "plan: spend cap $SPENDCAP (enforced by the session reporting a running total, not by the platform)"; fi
  n=$(section_lines "authority")
  if [ "$n" -gt 0 ]; then pass "plan: authority scope written"; else fail "plan: '## Authority scope' section is missing or empty"; PLAN_OK=0; fi
  for b in 1 2 3; do
    n=$(section_lines "bucket $b")
    if [ "$n" -gt 0 ]; then pass "plan: bucket $b has content"; else fail "plan: '## Bucket $b' section is missing or empty (write 'none' if truly nothing)"; PLAN_OK=0; fi
  done
fi

# 5b. files the night session writes itself must not sit in .claude/ (protected path: classifier-judged in auto mode,
#     and each block counts toward the 3-in-a-row / 20-total pause)
for f in "$PLAN_REL" "${LEDGER_REL:-}"; do
  case "$f" in .claude/*|*/.claude/*) warn "$f is under .claude/: every write there goes to the auto-mode classifier and no allow rule pre-approves it. Keep the plan and ledger in PM/overnight/" ;; esac
done

# 6. stop time -> epoch
EFFECTIVE_STOP="${UNTIL:-${PSTOP:-}}"
STOP_EPOCH=""
if [ -n "$EFFECTIVE_STOP" ]; then
  if ! [[ "$EFFECTIVE_STOP" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
    fail "stop time '$EFFECTIVE_STOP' is not HH:MM (24 h)"
  else
    [ -z "$UNTIL" ] || [ -z "${PSTOP:-}" ] || [ "$UNTIL" = "$PSTOP" ] || warn "--until $UNTIL overrides the plan's stop time $PSTOP (the plan file is not edited)"
    if [ -n "${CLOCKWORK_STOP_EPOCH:-}" ]; then
      STOP_EPOCH="$CLOCKWORK_STOP_EPOCH"
    else
      TODAY=$(date +%F); NOW=$(date +%s)
      STOP_EPOCH=$(date -j -f '%Y-%m-%d %H:%M' "$TODAY $EFFECTIVE_STOP" +%s 2>/dev/null || true)
      if [ -z "$STOP_EPOCH" ]; then
        fail "could not compute the stop time from '$EFFECTIVE_STOP'"
      elif [ "$STOP_EPOCH" -le "$NOW" ]; then
        STOP_EPOCH=$(date -j -v+1d -f '%Y-%m-%d %H:%M' "$TODAY $EFFECTIVE_STOP" +%s)
      fi
    fi
    if [ -n "$STOP_EPOCH" ]; then
      HOURS=$(( (STOP_EPOCH - $(date +%s)) / 3600 ))
      pass "stop time $EFFECTIVE_STOP = $(date -r "$STOP_EPOCH" '+%a %H:%M'), in about ${HOURS} h (from date, not estimated)"
      if [ "$HOURS" -gt 14 ]; then warn "stop time is more than 14 h away; check the time and the date"; fi
    fi
  fi
else
  fail "no stop time (plan 'Stop time:' or --until HH:MM)"
fi

# 7. lock with live-PID check
STALE_LOCK=0
if [ -f "$LOCK" ]; then
  LOCK_PID=$(sed -nE 's/^pid=([0-9]+)$/\1/p' "$LOCK" | head -n1 || true)
  LOCK_CLAUDE=$(sed -nE 's/^claude_pid=([0-9]+)$/\1/p' "$LOCK" | head -n1 || true)
  LOCK_NAME=$(sed -nE 's/^name=(.*)$/\1/p' "$LOCK" | head -n1 || true)
  if pid_is_ours "${LOCK_PID:-}" || pid_is_ours "${LOCK_CLAUDE:-}"; then
    fail "another overnight run is live (lock $LOCK: name=${LOCK_NAME:-?} pid=${LOCK_PID:-?} claude_pid=${LOCK_CLAUDE:-?}). Do not start a second one"
  else
    STALE_LOCK=1
    warn "stale lock from a dead run (pid=${LOCK_PID:-?}); it will be replaced at launch"
  fi
else
  pass "no overnight lock (no other run)"
fi

# 8. autoContinueAtUsageLimit: a project/local value (with none in user/--settings/managed) turns it OFF
AC_PROBLEM=0
USER_SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
SET_ON_LAUNCH=0
if [ -f "$PROJECT/$SETTINGS_REL" ] && grep -Eq '"autoContinueAtUsageLimit"[[:space:]]*:[[:space:]]*true' "$PROJECT/$SETTINGS_REL"; then SET_ON_LAUNCH=1; fi
for f in "$PROJECT/.claude/settings.json" "$PROJECT/.claude/settings.local.json"; do
  if [ -f "$f" ] && grep -q '"autoContinueAtUsageLimit"' "$f"; then
    if [ "$SET_ON_LAUNCH" -eq 1 ]; then
      warn "$(basename "$f") sets autoContinueAtUsageLimit, but $SETTINGS_REL sets it true and the flag file wins over project files; remove it from $(basename "$f") anyway"
    else
      fail "$f sets autoContinueAtUsageLimit: a project/local value turns auto-continue OFF. Delete that key (set it only in user settings or $SETTINGS_REL)"
      AC_PROBLEM=1
    fi
  fi
done
if [ -f "$USER_SETTINGS" ] && grep -Eq '"autoContinueAtUsageLimit"[[:space:]]*:[[:space:]]*false' "$USER_SETTINGS"; then
  fail "user settings ($USER_SETTINGS) turn autoContinueAtUsageLimit OFF: the night stops at the first usage limit. Set it true or remove it"
  AC_PROBLEM=1
fi
[ "$AC_PROBLEM" -eq 1 ] || pass "no settings file turns autoContinueAtUsageLimit off"

# 8b. auto mode: a session launched with --permission-mode auto starts in MANUAL when auto mode is unavailable, and the
# night then waits at its first prompt (permission-modes.md). A settings file with disableAutoMode "disable" (top level
# or under permissions; settings-reference.md) is one cause the preflight can see. Managed file: managed-settings.md.
MANAGED_SETTINGS="${CLOCKWORK_MANAGED_SETTINGS:-/Library/Application Support/ClaudeCode/managed-settings.json}"
AUTO_OFF=$(node -e '
  const fs = require("fs"); const hits = [];
  for (const f of process.argv.slice(1)) { let j; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    if (j && (j.disableAutoMode === "disable" || (j.permissions && j.permissions.disableAutoMode === "disable"))) hits.push(f); }
  console.log(hits.join(" · "));' "$USER_SETTINGS" "$PROJECT/.claude/settings.json" "$PROJECT/.claude/settings.local.json" "$PROJECT/$SETTINGS_REL" "$MANAGED_SETTINGS" 2>/dev/null || echo "?")
if [ "$AUTO_OFF" = "?" ]; then
  warn "could not read the settings files for disableAutoMode; check that none sets it to \"disable\""
elif [ -n "$AUTO_OFF" ]; then
  fail "auto mode is turned off by disableAutoMode \"disable\" in: $AUTO_OFF. The window would start in Manual and wait at the first prompt all night. Remove that key (a managed file needs its admin)"
else
  pass "no settings file turns auto mode off (disableAutoMode)"
fi
warn "auto mode can still be unavailable (the model, the plan, or turned off server-side): 2 min after launch, look at the window and confirm its mode shows auto; if it shows Manual, close it"

# 8c. a preview to verify on: the night marks an item VERIFIED only after a fresh verifier on a preview of that sha
PREVIEW=$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(((c.commands || {}).previewDeploy || "").trim() ? "set" : (c.stack || "unknown")); } catch { console.log("unknown"); }' "$PROJECT/.claude/clockwork.json" 2>/dev/null || echo unknown)
if [ "$PREVIEW" = "set" ]; then
  pass "clockwork.json commands.previewDeploy is set (the verifier gets a preview of each sha)"
else
  warn "clockwork.json commands.previewDeploy is empty (stack ${PREVIEW}): a Bucket 1 item reaches VERIFIED only on a preview of its sha. Next.js on Vercel: pushing the named branch makes one (git push -u origin <branch>). WordPress or no preview route: set previewDeploy or a staging URL first, or every item ends FLAGGED"
fi

# 9. workspace trust (internal file format, not documented: WARN only)
TRUST=$(node -e '
  try {
    const p=(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude.json","utf8")).projects)||{};
    let d=process.argv[1];
    for(;;){ if(p[d]&&p[d].hasTrustDialogAccepted===true){console.log("yes");break}
      const up=require("path").dirname(d); if(up===d){console.log("no");break} d=up }
  } catch(e){console.log("unknown")}' "$PROJECT" 2>/dev/null || echo unknown)
case "$TRUST" in
  yes) pass "project folder is already trusted (no trust prompt to block the night)" ;;
  no) warn "project folder may not be trusted yet: open 'claude' in it once by hand and accept, or the window stops at a prompt and /goal is unavailable" ;;
  *) warn "could not read trust state; make sure you have opened claude in this folder once" ;;
esac

# 9b. the /goal line (at most 4,000 characters of condition, goal.md)
EFFECTIVE_STOP_TXT="${UNTIL:-${PSTOP:-}}"
GOAL_TEXT=$(
  printf '%s' "${GOAL:-}"
  printf ' | Done when: every Bucket 1 item in %s has a ledger line' "$PLAN_REL"
  printf ' saying VERIFIED (its check, `%s` or the item'"'"'s own, run with the full output printed and passing, then a fresh verifier) or FLAGGED after 2 failed attempts' "${VERIFY:-}"
  printf ' | OR the stop time %s arrives (run `date`; do not guess), after which you start no new work and write the handover' "$EFFECTIVE_STOP_TXT"
  printf ' | OR you have used %s turns' "${TURNCAP:-}"
  printf ' | Follow %s exactly (authority scope, three buckets, caps; ledger %s).' "$PLAN_REL" "${LEDGER_REL:-PM/overnight/OVERNIGHT-LEDGER.md}"
  printf ' Run `date` at the start of every turn and print it. Print proof (command + output) for every claim.'
)
GOAL_LEN=${#GOAL_TEXT}
if [ "$GOAL_LEN" -gt 4000 ]; then fail "the /goal condition is $GOAL_LEN characters, over the 4,000 limit: shorten the plan's Goal line"; else pass "/goal condition is $GOAL_LEN characters (limit 4,000)"; fi

# 10. things that cannot be checked here
warn "weekly usage limit: check /usage first. A weekly reset more than 24 h away does NOT auto-continue (the night ends there)"
warn "auto-continue re-arms at most twice in a row, and only while the window stays open; after >30 min of Mac sleep it waits for you to press Enter"
warn "background commands stop after 30 min by default (2.1.285); Claude can ask for up to 2 h with the timeout on run_in_background. No setting raises the default, and a subagent's command ends when the subagent finishes, so split long builds"
warn "auto mode pauses and waits for a person after 3 blocked actions in a row or 20 in total (not configurable). A STALLED line in the log means no ledger change for $(( STALL_SECS / 60 )) min: look at the window"
warn "the first launch of each saved workflow in auto mode asks for consent once: run /verify-change and /build-slices by hand in this project and pick Yes before the first night"

echo "== $PASSES PASS, $WARNS WARN, $FAILS FAIL =="
if [ "$FAILS" -gt 0 ]; then
  echo "PREFLIGHT FAILED: fix the FAIL lines above. Nothing was launched."
  exit 1
fi
if [ "$DRY" -eq 1 ]; then
  echo "DRY-RUN OK: all preflight checks passed; nothing launched, nothing written."
  exit 0
fi

# ---------------------------------------------------------------- launch
mkdir -p "$STATE"
TODAY=$(date +%F)
LOG="$STATE/overnight-$TODAY.log"
PIDFILE="$STATE/overnight-claude.pid"
PROMPTFILE="$STATE/overnight-prompt.txt"
LAUNCHER="$STATE/overnight-launch.sh"
LEDGER_REL="${LEDGER_REL:-PM/overnight/OVERNIGHT-LEDGER.md}"
case "$LEDGER_REL" in /*) LEDGER="$LEDGER_REL" ;; *) LEDGER="$PROJECT/$LEDGER_REL" ;; esac
mkdir -p "$(dirname "$LEDGER")"

# take the lock (atomic create); replace a stale one
[ "$STALE_LOCK" -eq 1 ] && rm -f "$LOCK"
if ! ( set -o noclobber; printf 'pid=%s\nname=%s\nstarted=%s\nplan=%s\n' "$$" "$NAME" "$(stamp)" "$PLAN" > "$LOCK" ) 2>/dev/null; then
  echo "FAIL  could not take the lock $LOCK (another launch started at the same moment)"; exit 1
fi
release_lock() { rm -f "$LOCK"; }
trap 'release_lock' ERR

# initial prompt: /goal is processed as a command when it is the initial prompt (tested on 2.1.285)
printf '/goal %s' "$GOAL_TEXT" > "$PROMPTFILE"

# the one settings file the window gets: the kit file with this Mac's deny rules added (gitignored, never committed)
if ! node -e '
  const fs = require("fs"); const [kitF, machineF, out] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(kitF, "utf8")); s.permissions = s.permissions || {};
  let extra = []; if (fs.existsSync(machineF)) { const j = JSON.parse(fs.readFileSync(machineF, "utf8")); extra = Array.isArray(j) ? j : (j.permissions && j.permissions.deny) || j.deny || []; }
  s.permissions.deny = [...new Set([...(s.permissions.deny || []), ...extra])];
  fs.writeFileSync(out + ".tmp", JSON.stringify(s, null, 2) + "\n"); fs.renameSync(out + ".tmp", out);' "$PROJECT/$SETTINGS_REL" "$MACHINE_DENY" "$PROJECT/$MERGED_REL"; then
  echo "FAIL  could not write $MERGED_REL"; release_lock; exit 1
fi

rm -f "$PIDFILE"
{
  echo '#!/usr/bin/env bash'
  printf 'cd %q || exit 1\n' "$PROJECT"
  printf 'echo $$ > %q\n' "$PIDFILE"
  echo 'export CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1'
  printf 'exec %q -n %q --permission-mode auto --settings %q "$(cat %q)"\n' "$CLAUDE_BIN" "$NAME" "$MERGED_REL" "$PROMPTFILE"
} > "$LAUNCHER"
chmod +x "$LAUNCHER"

CMD=$(printf 'bash %q' "$LAUNCHER")
echo "Launching a Terminal window: $CMD"
if ! "$OSA" -e 'tell application "Terminal"' -e 'activate' -e "do script \"$(as_escape "$CMD")\"" -e 'end tell' >/dev/null; then
  echo "FAIL  opening the Terminal window failed. If macOS asked to let 'osascript' control Terminal, allow it (System Settings > Privacy & Security > Automation) and retry."
  release_lock; exit 1
fi

CLAUDE_PID=""
for _ in $(seq 1 90); do
  if [ -s "$PIDFILE" ]; then CLAUDE_PID=$(tr -dc '0-9' < "$PIDFILE"); break; fi
  sleep 1
done
if [ -z "$CLAUDE_PID" ] || ! kill -0 "$CLAUDE_PID" 2>/dev/null; then
  echo "FAIL  the claude session did not start within 90 s (no live PID in $PIDFILE). Look at the Terminal window, close it, fix the cause, retry."
  release_lock; exit 1
fi

nohup caffeinate -i -s -w "$CLAUDE_PID" </dev/null >/dev/null 2>&1 &
CAFF_PID=$!

{
  printf '%s OVERNIGHT START name=%s project=%s\n' "$(stamp)" "$NAME" "$PROJECT"
  printf '%s claude_pid=%s caffeinate_pid=%s stop=%s plan=%s\n' "$(stamp)" "$CLAUDE_PID" "$CAFF_PID" "$EFFECTIVE_STOP" "$PLAN"
} >> "$LOG"

nohup bash "$SELF" --_heartbeat --_pid "$CLAUDE_PID" --_stop "$STOP_EPOCH" --_log "$LOG" --_ledger "$LEDGER" --_lock "$LOCK" </dev/null >/dev/null 2>&1 &
HB=$!
printf 'pid=%s\nclaude_pid=%s\ncaffeinate_pid=%s\nname=%s\nstarted=%s\nplan=%s\n' "$HB" "$CLAUDE_PID" "$CAFF_PID" "$NAME" "$(stamp)" "$PLAN" > "$LOCK"
trap - ERR

echo "LAUNCHED name=$NAME claude_pid=$CLAUDE_PID caffeinate_pid=$CAFF_PID heartbeat_pid=$HB stop=$EFFECTIVE_STOP"
echo "Log: $LOG   (watch it: tail -f \"$LOG\")"
echo "Lid open, charger in. Stop early: close the Terminal window (or press Esc then /exit in it)."
