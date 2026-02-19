#!/usr/bin/env bash
# ============================================================
# Autonomous Agent — Detailed Setup Wizard (macOS/Linux)
# Security-focused with warnings and double confirmations.
# ============================================================
set -euo pipefail

C='\033[0;36m'; G='\033[0;32m'; Y='\033[0;33m'; R='\033[0;31m'; D='\033[0;90m'; W='\033[1;37m'; NC='\033[0m'
step()  { echo -e "\n  ${G}═══════════════════════════════════════════════════════${NC}"; echo -e "  ${G}STEP $1 of $2 — $3${NC}"; echo -e "  ${D}═══════════════════════════════════════════════════════${NC}\n"; }
ok()    { echo -e "    ${G}✓${NC} $1"; }
warn()  { echo -e "    ${Y}⚠${NC} $1"; }
err()   { echo -e "    ${R}✗${NC} $1"; }
info()  { echo -e "    ${D}$1${NC}"; }

security_note() {
    echo -e "\n    ${Y}┌─── 🔒 SECURITY NOTE ────────────────────────────${NC}"
    echo -e "    ${Y}│ $1${NC}"
    shift; for line in "$@"; do echo -e "    ${Y}│ $line${NC}"; done
    echo -e "    ${Y}└─────────────────────────────────────────────────${NC}\n"
}

danger_warning() {
    echo -e "\n    ${R}╔═══ ⚠️  DANGER — SECURITY RISK ═══════════════════╗${NC}"
    echo -e "    ${R}║ $1${NC}"
    echo -e "    ${R}╠════════════════════════════════════════════════════╣${NC}"
    echo -e "    ${R}║ Risk: $2${NC}"
    echo -e "    ${R}║ If compromised: $3${NC}"
    echo -e "    ${R}╚════════════════════════════════════════════════════╝${NC}\n"
}

ask() {
    local prompt="$1" default="${2:-}"
    if [ -n "$default" ]; then read -rp "    $prompt [$default]: " answer
    else read -rp "    $prompt: " answer; fi
    echo "${answer:-$default}"
}

ask_yn() {
    local prompt="$1" default="${2:-y}" suffix="(Y/n)"
    [[ "$default" == "n" ]] && suffix="(y/N)"
    read -rp "    $prompt $suffix: " answer
    answer="${answer:-$default}"
    [[ "$answer" =~ ^[yY] ]]
}

double_confirm() {
    echo -e "\n    ${Y}This requires DOUBLE CONFIRMATION (security-sensitive action).${NC}\n"
    read -rp "    First — Type YES to enable '$1': " first
    [[ "$first" != "YES" ]] && { ok "Cancelled. Keeping safe default."; return 1; }
    echo -e "\n    ${R}Are you ABSOLUTELY SURE?${NC}"
    read -rp "    Second — Type CONFIRM to proceed: " second
    [[ "$second" != "CONFIRM" ]] && { ok "Cancelled. Keeping safe default."; return 1; }
    return 0
}

echo -e "${C}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║   🤖  Autonomous Agent — Setup Wizard                    ║"
echo "  ║   Detailed, security-focused installation                ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
TOTAL=10

# Step 1: Prerequisites
step 1 $TOTAL "Checking Prerequisites"
command -v node &>/dev/null || { err "Node.js not found. Install v20+: https://nodejs.org"; exit 1; }
NODE_VER=$(node --version | tr -d 'v'); NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
[ "$NODE_MAJOR" -ge 20 ] && ok "Node.js $NODE_VER" || { err "Node.js $NODE_VER — need v20+"; exit 1; }
command -v npm &>/dev/null && ok "npm $(npm --version)" || { err "npm not found"; exit 1; }
command -v git &>/dev/null && ok "git found" || warn "Git not found (optional)"

# Step 2: Install
step 2 $TOTAL "Installing Dependencies"
npm install 2>&1 | sed 's/^/    /'
ok "Dependencies installed"

# Step 3: Identity
step 3 $TOTAL "Agent Identity"
AGENT_NAME=$(ask "Agent name" "Jarvis")

# Step 4: LLM
step 4 $TOTAL "LLM Provider"
security_note "API Key Safety" "Keys stored ONLY in local .env (chmod 600)." "Never sent anywhere except the provider's API."
info "  1. Anthropic (Claude) — recommended"
info "  2. OpenAI (GPT-4o)"
info "  3. Ollama (local, free)"
P_IDX=$(ask "Choice [1-3]" "1")
case "$P_IDX" in
  2) PROVIDER="openai"; API_KEY=$(ask "OpenAI API key"); MODEL=$(ask "Model" "gpt-4o") ;;
  3) PROVIDER="ollama"; API_KEY=""; MODEL=$(ask "Model" "llama3.1") ;;
  *) PROVIDER="anthropic"; API_KEY=$(ask "Anthropic API key"); MODEL=$(ask "Model" "claude-sonnet-4-20250514") ;;
esac

# Step 5: Channels
step 5 $TOTAL "Chat Channels"
security_note "Channel Security" "Bot tokens give message access." "If leaked, revoke immediately."
TG_TOKEN=$(ask "Telegram bot token (blank to skip)" "")
DC_TOKEN=$(ask "Discord bot token (blank to skip)" "")
security_note "User Restriction" "Without restriction, ANYONE can control the agent." "Strongly recommended to set user IDs."
ALLOWED=$(ask "Allowed user IDs (comma-separated, blank=all)" "")
if [ -z "$ALLOWED" ]; then
    warn "No user restriction. Anyone can control the agent."
    if ! ask_yn "Continue without restriction?" "n"; then
        ALLOWED=$(ask "Enter your user ID(s)")
    fi
fi

# Step 6: Autonomy
step 6 $TOTAL "Autonomy Level"
info "  1. Low — asks before ANY action"
info "  2. Medium — safe=auto, destructive=ask (recommended)"
info "  3. High — full autonomy ⚠️"
A_IDX=$(ask "Choice [1-3]" "2")
case "$A_IDX" in
  1) AUTONOMY="low" ;;
  3)
    AUTONOMY="high"
    danger_warning "High Autonomy" "Agent acts without asking" "Hallucination/injection → unintended actions"
    if ! double_confirm "High Autonomy"; then AUTONOMY="medium"; ok "Reverted to medium."; fi ;;
  *) AUTONOMY="medium" ;;
esac

# Step 7: Heartbeat
step 7 $TOTAL "Heartbeat"
HEARTBEAT=$(ask_yn "Enable heartbeat?" "y" && echo "true" || echo "false")
HB_INT=$(ask "Interval (minutes)" "30")

# Step 8: Integrations
step 8 $TOTAL "Integrations"
EMAIL_ON=false; GH_TOKEN=""; MASTO_URL=""; MASTO_TOKEN=""; SYS_CTL=false

echo -e "\n  ${C}📧 EMAIL${NC}"
if ask_yn "Configure email? (IMAP/SMTP, free)" "n"; then
    danger_warning "Email Access" "Agent reads ALL email and sends as you" "Sensitive data exposed, spam sent"
    if double_confirm "Email Access"; then
        EMAIL_ON=true
        EMAIL_HOST=$(ask "IMAP host" "imap.gmail.com")
        EMAIL_USER=$(ask "Email address")
        EMAIL_PASS=$(ask "Password / App Password")
        SMTP_HOST=$(ask "SMTP host" "smtp.gmail.com")
    fi
fi

echo -e "\n  ${C}🐙 GITHUB${NC}"
if ask_yn "Configure GitHub? (free API)" "n"; then
    GH_TOKEN=$(ask "Personal access token (ghp_...)")
fi

echo -e "\n  ${C}🐘 MASTODON${NC}"
if ask_yn "Configure Mastodon? (free)" "n"; then
    MASTO_URL=$(ask "Instance URL" "https://mastodon.social")
    MASTO_TOKEN=$(ask "Access token")
fi

echo -e "\n  ${R}⚡ SYSTEM CONTROL${NC}"
if ask_yn "Enable system control? (HIGH RISK)" "n"; then
    danger_warning "System Control" "OS-level access (apps, clipboard, screenshots)" "Data exfiltration, software installation"
    if double_confirm "System Control"; then SYS_CTL=true; fi
fi

# Step 9: Security
step 9 $TOTAL "Security Settings"
SANDBOX=true; SSRF=true; INJ=true; AUTH=true; AUDIT=true

info "All protections are ON by default."
if ask_yn "Keep all security protections enabled? (recommended)" "y"; then
    ok "All protections enabled."
else
    if ! ask_yn "Keep Sandbox?" "y"; then
        danger_warning "Sandbox Off" "ANY shell command allowed" "rm -rf, reverse shells, credential theft"
        if double_confirm "Disable Sandbox"; then SANDBOX=false; fi
    fi
    if ! ask_yn "Keep SSRF Protection?" "y"; then
        danger_warning "SSRF Off" "Agent reaches internal networks" "Cloud metadata, internal services exposed"
        if double_confirm "Disable SSRF"; then SSRF=false; fi
    fi
    ask_yn "Keep Prompt Injection Guards?" "y" || INJ=false
    if ! ask_yn "Keep Gateway Auth?" "y"; then
        danger_warning "Auth Off" "Anyone on network controls agent" "Commands, memory, data all exposed"
        if double_confirm "Disable Auth"; then AUTH=false; fi
    fi
    ask_yn "Keep Audit Logging?" "y" || AUDIT=false
fi

# Step 10: Generate
step 10 $TOTAL "Generating Configuration"
HB_CHAN=$([[ -n "$TG_TOKEN" ]] && echo "telegram" || echo "cli")

cat > .env << ENVEOF
# Generated $(date '+%Y-%m-%d %H:%M') — DO NOT SHARE
LLM_PROVIDER=$PROVIDER
ANTHROPIC_API_KEY=$([[ "$PROVIDER" == "anthropic" ]] && echo "$API_KEY" || echo "")
ANTHROPIC_MODEL=$([[ "$PROVIDER" == "anthropic" ]] && echo "$MODEL" || echo "claude-sonnet-4-20250514")
OPENAI_API_KEY=$([[ "$PROVIDER" == "openai" ]] && echo "$API_KEY" || echo "")
OPENAI_MODEL=$([[ "$PROVIDER" == "openai" ]] && echo "$MODEL" || echo "gpt-4o")
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=$([[ "$PROVIDER" == "ollama" ]] && echo "$MODEL" || echo "llama3.1")
TELEGRAM_BOT_TOKEN=$TG_TOKEN
DISCORD_BOT_TOKEN=$DC_TOKEN
DISCORD_ALLOWED_CHANNEL_IDS=
GATEWAY_PORT=18789
GATEWAY_HOST=127.0.0.1
HEARTBEAT_ENABLED=$HEARTBEAT
HEARTBEAT_INTERVAL_MINUTES=$HB_INT
HEARTBEAT_CHANNEL=$HB_CHAN
AGENT_NAME=$AGENT_NAME
AGENT_WORKSPACE=./workspace
AGENT_MAX_TOOL_CALLS=20
AGENT_AUTONOMY_LEVEL=$AUTONOMY
ALLOWED_USER_IDS=$ALLOWED
SANDBOX_ENABLED=$SANDBOX
GATEWAY_AUTH_ENABLED=$AUTH
SSRF_PROTECTION_ENABLED=$SSRF
PROMPT_INJECTION_GUARDS=$INJ
AUDIT_LOG_ENABLED=$AUDIT
SHELL_TIMEOUT_MS=30000
MAX_TOOL_OUTPUT_CHARS=50000
GATEWAY_RATE_LIMIT_PER_MIN=60
LLM_RATE_LIMIT_PER_MIN=30
MAX_REQUEST_BODY_BYTES=1048576
ENVEOF

chmod 600 .env
ok ".env created (chmod 600)"

mkdir -p workspace/{skills,memory/{conversations,facts,tasks},logs}
ok "Workspace ready"

npm run build 2>&1 | sed 's/^/    /' || warn "Build issues — use: npm run dev"

echo -e "\n  ${G}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${G}║   ✓  Setup Complete!                                     ║${NC}"
echo -e "  ${G}╚══════════════════════════════════════════════════════════╝${NC}\n"
echo -e "  ${C}npm run dev${NC}   — development mode"
echo -e "  ${C}npm start${NC}     — production mode"
echo -e "  Admin:  ${C}http://127.0.0.1:18789/admin${NC}"
echo ""
