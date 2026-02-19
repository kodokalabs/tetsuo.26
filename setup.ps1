#Requires -Version 5.1
<#
.SYNOPSIS
    Autonomous Agent - Detailed Setup Wizard (Windows)
.DESCRIPTION
    Guided interactive setup with security explanations, risk warnings,
    and double confirmations for every dangerous option.
.NOTES
    Run: powershell -ExecutionPolicy Bypass -File setup.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---- Helpers --------------------------------------------------

function Write-Banner {
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║                                                          ║" -ForegroundColor Cyan
    Write-Host "  ║   🤖  Autonomous Agent — Setup Wizard                    ║" -ForegroundColor Cyan
    Write-Host "  ║   Detailed, security-focused installation                ║" -ForegroundColor Cyan
    Write-Host "  ║                                                          ║" -ForegroundColor Cyan
    Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step {
    param([int]$Num, [int]$Total, [string]$Title)
    Write-Host ""
    Write-Host "  ═══════════════════════════════════════════════════════" -ForegroundColor DarkGray
    Write-Host "  STEP $Num of $Total — $Title" -ForegroundColor Green
    Write-Host "  ═══════════════════════════════════════════════════════" -ForegroundColor DarkGray
    Write-Host ""
}

function Write-Info { param([string]$M) Write-Host "    $M" -ForegroundColor Gray }
function Write-Ok { param([string]$M) Write-Host "    ✓ $M" -ForegroundColor Green }
function Write-Warn { param([string]$M) Write-Host "    ⚠ $M" -ForegroundColor Yellow }
function Write-Err { param([string]$M) Write-Host "    ✗ $M" -ForegroundColor Red }
function Write-SecurityNote {
    param([string]$Title, [string]$Body)
    Write-Host ""
    Write-Host "    ┌─── 🔒 SECURITY NOTE ────────────────────────────" -ForegroundColor Yellow
    Write-Host "    │ $Title" -ForegroundColor Yellow
    $Body.Split("`n") | ForEach-Object { Write-Host "    │ $_" -ForegroundColor DarkYellow }
    Write-Host "    └─────────────────────────────────────────────────" -ForegroundColor Yellow
    Write-Host ""
}

function Write-DangerWarning {
    param([string]$Title, [string]$Risk, [string]$Consequence)
    Write-Host ""
    Write-Host "    ╔═══ ⚠️  DANGER — SECURITY RISK ═══════════════════╗" -ForegroundColor Red
    Write-Host "    ║ $Title" -ForegroundColor Red
    Write-Host "    ╠════════════════════════════════════════════════════╣" -ForegroundColor Red
    Write-Host "    ║ Risk: $Risk" -ForegroundColor Red
    Write-Host "    ║ If compromised: $Consequence" -ForegroundColor Red
    Write-Host "    ╚════════════════════════════════════════════════════╝" -ForegroundColor Red
    Write-Host ""
}

function Ask-Input {
    param([string]$Prompt, [string]$Default = "")
    $suffix = if ($Default) { " [$Default]" } else { "" }
    $answer = Read-Host "    $Prompt$suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}

function Ask-YesNo {
    param([string]$Question, [bool]$Default = $true)
    $suffix = if ($Default) { "(Y/n)" } else { "(y/N)" }
    $answer = Read-Host "    $Question $suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer -match "^[yY]"
}

function Ask-DoubleConfirm {
    param([string]$Action)
    Write-Host ""
    Write-Host "    This requires DOUBLE CONFIRMATION because it is a security-sensitive action." -ForegroundColor Yellow
    Write-Host ""
    $first = Read-Host "    First confirmation — Type YES to enable '$Action'"
    if ($first -ne "YES") {
        Write-Ok "Cancelled. Keeping the safe default."
        return $false
    }
    Write-Host ""
    Write-Host "    Are you ABSOLUTELY SURE? This cannot be undone during setup." -ForegroundColor Red
    $second = Read-Host "    Second confirmation — Type CONFIRM to proceed"
    if ($second -ne "CONFIRM") {
        Write-Ok "Cancelled. Keeping the safe default."
        return $false
    }
    return $true
}

function Ask-Choice {
    param([string]$Prompt, [string[]]$Options, [string[]]$Descriptions, [int]$Default = 0, [int[]]$DangerIndices = @())
    Write-Host ""
    for ($i = 0; $i -lt $Options.Length; $i++) {
        $marker = if ($i -eq $Default) { ">" } else { " " }
        $color = if ($DangerIndices -contains $i) { "Red" } else { if ($i -eq $Default) { "White" } else { "Gray" } }
        $dangerTag = if ($DangerIndices -contains $i) { " ⚠️" } else { "" }
        Write-Host "    $marker $($i+1). $($Options[$i])$dangerTag" -ForegroundColor $color
        if ($Descriptions -and $Descriptions[$i]) {
            Write-Host "       $($Descriptions[$i])" -ForegroundColor DarkGray
        }
    }
    Write-Host ""
    $answer = Read-Host "    $Prompt [default: $($Default+1)]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    $idx = [int]$answer - 1
    if ($idx -ge 0 -and $idx -lt $Options.Length) { return $idx }
    return $Default
}

function Test-CommandExists {
    param([string]$Cmd)
    try { Get-Command $Cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

# ---- Main Setup -----------------------------------------------

function Main {
    Write-Banner

    $TOTAL_STEPS = 10

    # ============================================================
    # STEP 1: Prerequisites
    # ============================================================
    Write-Step 1 $TOTAL_STEPS "Checking Prerequisites"

    Write-Info "Checking for required software..."
    Write-Host ""

    # Node.js
    $nodeOk = $false
    if (Test-CommandExists "node") {
        $nodeVer = (node --version 2>$null) -replace 'v', ''
        $nodeMajor = [int]($nodeVer.Split('.')[0])
        if ($nodeMajor -ge 20) {
            Write-Ok "Node.js $nodeVer (v20+ required)"
            $nodeOk = $true
        } else {
            Write-Warn "Node.js $nodeVer found but v20+ is required"
        }
    }

    if (-not $nodeOk) {
        Write-Err "Node.js v20+ is required."
        Write-Info ""
        Write-Info "Node.js is the runtime that powers the agent. It's safe, widely used,"
        Write-Info "and installs no background services."
        Write-Info ""

        if (Test-CommandExists "winget") {
            if (Ask-YesNo "Install Node.js v22 LTS via winget? (recommended)") {
                Write-Info "Installing Node.js LTS..."
                winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
                if (Test-CommandExists "node") {
                    Write-Ok "Node.js installed: $(node --version)"
                    $nodeOk = $true
                } else {
                    Write-Warn "Installed but not in PATH. Please restart this terminal and re-run setup."
                    Read-Host "Press Enter to exit"
                    exit 1
                }
            }
        }
        if (-not $nodeOk) {
            Write-Info "Install manually: https://nodejs.org (LTS version)"
            Read-Host "Press Enter to exit"
            exit 1
        }
    }

    # npm
    if (Test-CommandExists "npm") { Write-Ok "npm $(npm --version)" }
    else { Write-Err "npm not found."; exit 1 }

    # Git
    if (Test-CommandExists "git") { Write-Ok "git $(git --version 2>$null | Select-String '\d+\.\d+' -AllMatches | ForEach-Object { $_.Matches.Value })" }
    else { Write-Warn "Git not found (optional, recommended for workspace versioning)" }

    # ============================================================
    # STEP 2: Install Dependencies
    # ============================================================
    Write-Step 2 $TOTAL_STEPS "Installing Dependencies"

    $projectDir = if (Test-Path (Join-Path $PSScriptRoot "package.json")) { $PSScriptRoot } else { Get-Location }
    Push-Location $projectDir

    if (-not (Test-Path "package.json")) {
        Write-Err "Cannot find package.json. Run this script from the project root."
        Pop-Location; exit 1
    }

    Write-Info "Project: $projectDir"
    Write-Info "Running npm install (this may take 1-2 minutes)..."
    Write-Host ""
    npm install 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; Pop-Location; exit 1 }
    Write-Ok "All dependencies installed"

    # ============================================================
    # STEP 3: Agent Identity
    # ============================================================
    Write-Step 3 $TOTAL_STEPS "Agent Identity"

    Write-Info "Your agent needs a name. This is how it will identify itself"
    Write-Info "in conversations and notifications."
    Write-Host ""
    $agentName = Ask-Input "Agent name" "Jarvis"
    Write-Ok "Agent name: $agentName"

    # ============================================================
    # STEP 4: LLM Provider
    # ============================================================
    Write-Step 4 $TOTAL_STEPS "LLM Provider (the brain)"

    Write-Info "The agent needs a large language model to think with."
    Write-Info "You'll need an API key from your chosen provider."
    Write-Host ""

    Write-SecurityNote "API Key Safety" "Your API key is stored ONLY in the local .env file.`nIt is never sent anywhere except the provider's API.`nThe .env file will be permission-locked to your user account."

    $providerIdx = Ask-Choice "Choose LLM provider:" @(
        "Anthropic (Claude) — recommended for agents",
        "OpenAI (GPT-4o)",
        "Ollama (fully local, free, no API key needed)"
    ) @(
        "Best tool use. Requires API key from console.anthropic.com (~`$3/MTok)",
        "Requires API key from platform.openai.com",
        "Runs on your hardware. Needs 16GB+ RAM. No data leaves your machine."
    )

    $provider = @("anthropic", "openai", "ollama")[$providerIdx]
    $apiKey = ""
    $model = ""

    switch ($provider) {
        "anthropic" {
            $apiKey = Ask-Input "Anthropic API key (starts with sk-ant-)"
            $model = Ask-Input "Model" "claude-sonnet-4-20250514"
            if (-not $apiKey.StartsWith("sk-ant-")) {
                Write-Warn "Key doesn't start with sk-ant- — double-check it's correct."
            }
        }
        "openai" {
            $apiKey = Ask-Input "OpenAI API key (starts with sk-)"
            $model = Ask-Input "Model" "gpt-4o"
        }
        "ollama" {
            Write-Info "Make sure Ollama is running: https://ollama.ai/download"
            Write-Info "After install, run: ollama pull llama3.1"
            $model = Ask-Input "Model name" "llama3.1"
        }
    }
    Write-Ok "Provider: $provider | Model: $model"

    # ============================================================
    # STEP 5: Chat Channels
    # ============================================================
    Write-Step 5 $TOTAL_STEPS "Chat Channels"

    Write-Info "Connect chat platforms so you can message the agent."
    Write-Info "Leave blank to skip any channel. CLI mode always works."
    Write-Host ""

    Write-SecurityNote "Channel Security" "Bot tokens give the agent access to send/receive messages.`nKeep them secret. If leaked, revoke immediately via the platform.`nOnly configure channels you actively want to use."

    $telegramToken = Ask-Input "Telegram bot token (from @BotFather, blank to skip)" ""
    $discordToken = Ask-Input "Discord bot token (from discord.dev, blank to skip)" ""

    # User restriction
    Write-Host ""
    Write-Info "You can restrict which users can talk to the agent."
    Write-Info "If left blank, ANYONE who messages the bot can use it."
    Write-SecurityNote "User Restriction" "Without user restriction, anyone who discovers your bot`ncan command it. For Telegram, your user ID is a number`n(find it via @userinfobot). Strongly recommended."

    $allowedUsers = Ask-Input "Allowed user IDs (comma-separated, blank = allow all)" ""
    if ([string]::IsNullOrWhiteSpace($allowedUsers)) {
        Write-Warn "No user restriction set. Anyone can control the agent."
        if (-not (Ask-YesNo "Continue without user restriction?" $false)) {
            $allowedUsers = Ask-Input "Enter your user ID(s)"
        }
    }

    # ============================================================
    # STEP 6: Autonomy Level
    # ============================================================
    Write-Step 6 $TOTAL_STEPS "Autonomy Level"

    Write-Info "How much should the agent do on its own?"
    Write-Host ""
    Write-Info "This controls whether the agent asks permission before taking actions."
    Write-Host ""

    $autoIdx = Ask-Choice "Autonomy level:" @(
        "Low — always asks before ANY action",
        "Medium — runs safe actions, asks for destructive ones (recommended)",
        "High — full autonomy, only asks for irreversible actions"
    ) @(
        "Safest. Every tool call requires your approval. Slower but transparent.",
        "Good balance. Read operations auto-run. Writes/deletes/sends need approval.",
        "Maximum speed. The agent acts independently. Use only if you trust your config."
    ) 1 @(2)

    $autonomy = @("low", "medium", "high")[$autoIdx]

    if ($autoIdx -eq 2) {
        Write-DangerWarning "High Autonomy Selected" `
            "The agent will execute commands, write files, and send messages without asking." `
            "An LLM hallucination or prompt injection could cause unintended actions."

        if (-not (Ask-DoubleConfirm "High Autonomy")) {
            $autonomy = "medium"
            Write-Ok "Reverted to Medium autonomy."
        } else {
            Write-Warn "High autonomy enabled. Monitor audit logs closely."
        }
    }
    Write-Ok "Autonomy: $autonomy"

    # ============================================================
    # STEP 7: Heartbeat
    # ============================================================
    Write-Step 7 $TOTAL_STEPS "Heartbeat (Proactive Behavior)"

    Write-Info "The heartbeat system lets the agent check for pending tasks"
    Write-Info "on a schedule, even when you haven't sent a message."
    Write-Host ""

    $heartbeatEnabled = Ask-YesNo "Enable heartbeat?" $true
    $heartbeatInterval = "30"
    if ($heartbeatEnabled) {
        $heartbeatInterval = Ask-Input "Check interval (minutes)" "30"
    }

    # ============================================================
    # STEP 8: Integrations (Email, Social, System)
    # ============================================================
    Write-Step 8 $TOTAL_STEPS "Integrations (Optional)"

    Write-Info "The agent can connect to external services. Each integration"
    Write-Info "is OFF by default and can be toggled in the admin dashboard."
    Write-Host ""

    # -- Email --
    Write-Host "  📧 EMAIL (IMAP/SMTP)" -ForegroundColor Cyan
    Write-Info "Free — works with any email provider (Gmail, Outlook, etc.)"
    Write-Info "The agent can read your inbox and send emails as you."
    Write-Host ""

    $emailEnabled = $false
    $emailHost = ""; $emailUser = ""; $emailPass = ""; $smtpHost = ""; $smtpPort = 587

    if (Ask-YesNo "Configure email?" $false) {
        Write-DangerWarning "Email Access" `
            "The agent can read ALL emails and send messages as you." `
            "A compromised agent could read sensitive correspondence or send spam."

        if (Ask-DoubleConfirm "Email Access") {
            $emailEnabled = $true
            Write-Info "For Gmail: use an App Password (not your real password)"
            Write-Info "Generate one at: myaccount.google.com > Security > App Passwords"
            Write-Host ""
            $emailHost = Ask-Input "IMAP host" "imap.gmail.com"
            $emailUser = Ask-Input "Email address"
            $emailPass = Ask-Input "Password or App Password"
            $smtpHost = Ask-Input "SMTP host" "smtp.gmail.com"
            $smtpPort = Ask-Input "SMTP port" "587"
            Write-Ok "Email configured"
        }
    }

    # -- GitHub --
    Write-Host ""
    Write-Host "  🐙 GITHUB (Free API)" -ForegroundColor Cyan
    Write-Info "Read/create issues, PRs, manage repos. 5000 requests/hour."
    Write-Host ""

    $githubToken = ""
    if (Ask-YesNo "Configure GitHub?" $false) {
        Write-SecurityNote "GitHub Token" "Use a fine-grained personal access token with minimal scopes.`nGenerate at: github.com/settings/tokens?type=beta`nRecommended scopes: Issues (read/write), Pull requests (read)"
        $githubToken = Ask-Input "GitHub personal access token (ghp_...)"
    }

    # -- Mastodon --
    Write-Host ""
    Write-Host "  🐘 MASTODON (Free API)" -ForegroundColor Cyan
    Write-Info "Read timeline, post toots, check notifications. Fully free and federated."
    Write-Host ""

    $mastodonUrl = ""; $mastodonToken = ""
    if (Ask-YesNo "Configure Mastodon?" $false) {
        Write-SecurityNote "Mastodon Access" "The agent can post publicly as you.`nGet a token: Your Instance > Preferences > Development > New Application"

        if (Ask-YesNo "Proceed with Mastodon setup?" $true) {
            $mastodonUrl = Ask-Input "Instance URL" "https://mastodon.social"
            $mastodonToken = Ask-Input "Access token"
        }
    }

    # -- Reddit --
    Write-Host ""
    Write-Host "  🤖 REDDIT (Free API)" -ForegroundColor Cyan
    Write-Info "Read subreddits, check inbox, post. 60 requests/minute."
    Write-Host ""

    $redditClientId = ""; $redditSecret = ""; $redditUser = ""; $redditPass = ""
    if (Ask-YesNo "Configure Reddit?" $false) {
        Write-SecurityNote "Reddit Access" "Create a 'script' type app at reddit.com/prefs/apps`nThe agent can post and comment as your Reddit account."

        if (Ask-YesNo "Proceed with Reddit setup?" $true) {
            $redditClientId = Ask-Input "Client ID (under your app name)"
            $redditSecret = Ask-Input "Client Secret"
            $redditUser = Ask-Input "Reddit username"
            $redditPass = Ask-Input "Reddit password"
        }
    }

    # -- System Control --
    Write-Host ""
    Write-Host "  ⚡ SYSTEM CONTROL" -ForegroundColor Red
    Write-Info "Clipboard, notifications, app launching, screenshots, process list."
    Write-Info "This gives the agent OS-level access to your computer."
    Write-Host ""

    $systemControl = $false
    if (Ask-YesNo "Enable system control? (HIGH RISK)" $false) {
        Write-DangerWarning "System Control Access" `
            "The agent can launch apps, read clipboard, take screenshots, list processes." `
            "A compromised agent could exfiltrate data, install software, or control your desktop."

        Write-Host ""
        Write-Host "    This is the HIGHEST-RISK permission. It effectively gives" -ForegroundColor Red
        Write-Host "    the AI full control of your operating system." -ForegroundColor Red
        Write-Host ""

        if (Ask-DoubleConfirm "System Control") {
            $systemControl = $true
            Write-Warn "System control enabled. The agent can control your OS."
        }
    }

    # ============================================================
    # STEP 9: Security Settings
    # ============================================================
    Write-Step 9 $TOTAL_STEPS "Security Settings"

    Write-Info "Review and confirm security defaults. All protections are ON by default."
    Write-Info "You can change these later in the admin dashboard."
    Write-Host ""

    $sandbox = $true; $ssrf = $true; $injection = $true; $auth = $true; $audit = $true

    Write-Info "Current security configuration:"
    Write-Host "    ✓ Sandbox Mode         — shell commands are filtered" -ForegroundColor Green
    Write-Host "    ✓ SSRF Protection      — internal network access blocked" -ForegroundColor Green
    Write-Host "    ✓ Prompt Injection Guard — web content wrapped with boundaries" -ForegroundColor Green
    Write-Host "    ✓ Gateway Auth         — bearer token required" -ForegroundColor Green
    Write-Host "    ✓ Audit Logging        — all actions recorded" -ForegroundColor Green
    Write-Host ""

    if (Ask-YesNo "Keep all security protections enabled? (STRONGLY recommended)" $true) {
        Write-Ok "All security protections enabled."
    } else {
        Write-Warn "Customizing security settings..."
        Write-Host ""
        Write-Info "For each protection, you'll need to explicitly disable it."
        Write-Host ""

        if (Ask-YesNo "Keep Sandbox Mode? (filters dangerous shell commands)" $true) {} else {
            Write-DangerWarning "Sandbox Disabled" "Agent can run ANY shell command" "rm -rf /, reverse shells, credential theft"
            if (Ask-DoubleConfirm "Disable Sandbox") { $sandbox = $false }
        }

        if (Ask-YesNo "Keep SSRF Protection? (blocks access to internal network)" $true) {} else {
            Write-DangerWarning "SSRF Disabled" "Agent can access localhost, 10.x, 172.x, 192.168.x, cloud metadata" "Internal services exposed, cloud credentials stolen"
            if (Ask-DoubleConfirm "Disable SSRF Protection") { $ssrf = $false }
        }

        if (Ask-YesNo "Keep Prompt Injection Guards?" $true) {} else { $injection = $false }

        if (Ask-YesNo "Keep Gateway Authentication?" $true) {} else {
            Write-DangerWarning "Auth Disabled" "Anyone on the network can control the agent" "Attacker sends commands, reads memory, exfiltrates data"
            if (Ask-DoubleConfirm "Disable Gateway Auth") { $auth = $false }
        }

        if (Ask-YesNo "Keep Audit Logging?" $true) {} else { $audit = $false }
    }

    # ============================================================
    # STEP 10: Generate Configuration
    # ============================================================
    Write-Step 10 $TOTAL_STEPS "Generating Configuration"

    $heartbeatChannel = if ($telegramToken) { "telegram" } elseif ($discordToken) { "discord" } else { "cli" }

    $envContent = @"
# ============================================================
# Autonomous Agent — Generated by setup.ps1 on $(Get-Date -Format "yyyy-MM-dd HH:mm")
# DO NOT share this file. It contains API keys and credentials.
# ============================================================

# --- LLM Provider ---
LLM_PROVIDER=$provider
ANTHROPIC_API_KEY=$(if ($provider -eq 'anthropic') { $apiKey } else { '' })
ANTHROPIC_MODEL=$(if ($provider -eq 'anthropic') { $model } else { 'claude-sonnet-4-20250514' })
OPENAI_API_KEY=$(if ($provider -eq 'openai') { $apiKey } else { '' })
OPENAI_MODEL=$(if ($provider -eq 'openai') { $model } else { 'gpt-4o' })
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=$(if ($provider -eq 'ollama') { $model } else { 'llama3.1' })

# --- Channels ---
TELEGRAM_BOT_TOKEN=$telegramToken
DISCORD_BOT_TOKEN=$discordToken
DISCORD_ALLOWED_CHANNEL_IDS=

# --- Gateway ---
GATEWAY_PORT=18789
GATEWAY_HOST=127.0.0.1

# --- Heartbeat ---
HEARTBEAT_ENABLED=$($heartbeatEnabled.ToString().ToLower())
HEARTBEAT_INTERVAL_MINUTES=$heartbeatInterval
HEARTBEAT_CHANNEL=$heartbeatChannel

# --- Agent ---
AGENT_NAME=$agentName
AGENT_WORKSPACE=./workspace
AGENT_MAX_TOOL_CALLS=20
AGENT_AUTONOMY_LEVEL=$autonomy

# --- Security ---
ALLOWED_USER_IDS=$allowedUsers
SANDBOX_ENABLED=$($sandbox.ToString().ToLower())
GATEWAY_AUTH_ENABLED=$($auth.ToString().ToLower())
SSRF_PROTECTION_ENABLED=$($ssrf.ToString().ToLower())
PROMPT_INJECTION_GUARDS=$($injection.ToString().ToLower())
AUDIT_LOG_ENABLED=$($audit.ToString().ToLower())
SHELL_TIMEOUT_MS=30000
MAX_TOOL_OUTPUT_CHARS=50000
GATEWAY_RATE_LIMIT_PER_MIN=60
LLM_RATE_LIMIT_PER_MIN=30
MAX_REQUEST_BODY_BYTES=1048576
"@

    $envFile = Join-Path $projectDir ".env"
    Set-Content -Path $envFile -Value $envContent -Encoding UTF8
    Write-Ok ".env file created"

    # Protect .env file
    try {
        $acl = Get-Acl $envFile
        $acl.SetAccessRuleProtection($true, $false)
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($currentUser, "FullControl", "Allow")
        $acl.SetAccessRule($rule)
        Set-Acl -Path $envFile -AclObject $acl
        Write-Ok ".env permissions restricted to: $currentUser"
    } catch {
        Write-Warn "Could not lock .env permissions: $_"
    }

    # Generate settings.json with integration configs
    $settings = @{
        sandboxEnabled = $sandbox
        ssrfProtectionEnabled = $ssrf
        promptInjectionGuards = $injection
        gatewayAuthEnabled = $auth
        auditLogEnabled = $audit
        shellTimeoutMs = 30000
        maxToolOutputChars = 50000
        gatewayRateLimitPerMin = 60
        llmRateLimitPerMin = 30
        maxRequestBodyBytes = 1048576
        maxToolCallsPerMessage = 20
        autonomyLevel = $autonomy
        agentName = $agentName
        allowedDomains = @()
        blockedDomains = @()
        allowLocalhost = $false
        toolPermissions = @{
            shell = $true
            fileRead = $true
            fileWrite = $true
            webFetch = $true
            browser = $true
            email = $emailEnabled
            socialMedia = ($githubToken -ne "" -or $mastodonToken -ne "" -or $redditClientId -ne "")
            systemControl = $systemControl
        }
        integrations = @{
            email = @{ enabled = $emailEnabled; host = $emailHost; port = 993; secure = $true; user = $emailUser; pass = $emailPass; smtpHost = $smtpHost; smtpPort = [int]$smtpPort }
            github = @{ enabled = ($githubToken -ne ""); token = $githubToken }
            mastodon = @{ enabled = ($mastodonToken -ne ""); instanceUrl = $mastodonUrl; accessToken = $mastodonToken }
            reddit = @{ enabled = ($redditClientId -ne ""); clientId = $redditClientId; clientSecret = $redditSecret; username = $redditUser; password = $redditPass }
        }
    }

    $workspace = Join-Path $projectDir "workspace"
    @("skills","memory","memory/conversations","memory/facts","memory/tasks","logs") | ForEach-Object {
        $d = Join-Path $workspace $_
        if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }

    $settingsJson = $settings | ConvertTo-Json -Depth 5
    $settingsFile = Join-Path $workspace "settings.json"
    Set-Content -Path $settingsFile -Value $settingsJson -Encoding UTF8
    Write-Ok "settings.json created with integration configs"

    # Build
    Write-Info "Building TypeScript..."
    npm run build 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -eq 0) { Write-Ok "Build complete" } else { Write-Warn "Build issues — use 'npm run dev' for development" }

    # ============================================================
    # SUMMARY
    # ============================================================
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "  ║                                                          ║" -ForegroundColor Green
    Write-Host "  ║   ✓  Setup Complete!                                     ║" -ForegroundColor Green
    Write-Host "  ║                                                          ║" -ForegroundColor Green
    Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Configuration Summary:" -ForegroundColor White
    Write-Host "  ────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host "    Agent:         $agentName" -ForegroundColor Cyan
    Write-Host "    LLM:           $provider ($model)" -ForegroundColor Cyan
    Write-Host "    Autonomy:      $autonomy" -ForegroundColor $(if ($autonomy -eq 'high') { 'Red' } else { 'Cyan' })
    Write-Host "    Channels:      $(if($telegramToken){'Telegram '}else{''})$(if($discordToken){'Discord '}else{''})CLI" -ForegroundColor Cyan
    Write-Host "    Email:         $(if($emailEnabled){'✓ Enabled'}else{'✗ Disabled'})" -ForegroundColor $(if($emailEnabled){'Yellow'}else{'Gray'})
    Write-Host "    GitHub:        $(if($githubToken){'✓ Enabled'}else{'✗ Disabled'})" -ForegroundColor $(if($githubToken){'Yellow'}else{'Gray'})
    Write-Host "    Mastodon:      $(if($mastodonToken){'✓ Enabled'}else{'✗ Disabled'})" -ForegroundColor $(if($mastodonToken){'Yellow'}else{'Gray'})
    Write-Host "    Reddit:        $(if($redditClientId){'✓ Enabled'}else{'✗ Disabled'})" -ForegroundColor $(if($redditClientId){'Yellow'}else{'Gray'})
    Write-Host "    System Ctl:    $(if($systemControl){'⚠ Enabled (HIGH RISK)'}else{'✗ Disabled (safe)'})" -ForegroundColor $(if($systemControl){'Red'}else{'Green'})
    Write-Host "    Sandbox:       $(if($sandbox){'✓ ON'}else{'⚠ OFF'})" -ForegroundColor $(if($sandbox){'Green'}else{'Red'})
    Write-Host "    SSRF Guard:    $(if($ssrf){'✓ ON'}else{'⚠ OFF'})" -ForegroundColor $(if($ssrf){'Green'}else{'Red'})
    Write-Host "    Auth:          $(if($auth){'✓ ON'}else{'⚠ OFF'})" -ForegroundColor $(if($auth){'Green'}else{'Red'})
    Write-Host ""
    Write-Host "  To start:" -ForegroundColor White
    Write-Host "    npm run dev     " -NoNewline -ForegroundColor Cyan
    Write-Host "(development with hot reload)" -ForegroundColor Gray
    Write-Host "    npm start       " -NoNewline -ForegroundColor Cyan
    Write-Host "(production)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Admin dashboard:  " -NoNewline -ForegroundColor White
    Write-Host "http://127.0.0.1:18789/admin" -ForegroundColor Cyan
    Write-Host "  Gateway token:    " -NoNewline -ForegroundColor White
    Write-Host "workspace/.gateway-token (auto-generated on first run)" -ForegroundColor Gray
    Write-Host "  Audit logs:       " -NoNewline -ForegroundColor White
    Write-Host "workspace/logs/" -ForegroundColor Gray
    Write-Host ""

    Pop-Location
    Read-Host "Press Enter to exit"
}

Main
