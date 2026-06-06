<#
.SYNOPSIS
  Sends a signed GitHub pull_request webhook to a locally running AI PR Worker.

.DESCRIPTION
  Builds a minimal pull_request payload, signs the raw bytes with HMAC-SHA256
  using your GITHUB_WEBHOOK_SECRET, and POSTs it to the worker. Use this to
  verify signature validation, the shouldRun() gate, and (with a real repo +
  token + authenticated `claude`) the full clone -> runAi -> comment pipeline.

.EXAMPLE
  # Reads secret from .env, targets an allowlisted repo + existing feature branch:
  ./scripts/send-test-webhook.ps1 -Repo "TritonSolutions/app-one" -Branch "feature/test" -PrNumber 1

.NOTES
  - The repo must be in GITHUB_ALLOWED_REPOS or the gate returns accepted:false.
  - The branch must NOT be main/master/default, and head.repo must equal repo
    (fork PRs are rejected by design).
  - For a real end-to-end run, the branch must exist on GitHub and the token in
    .env must be able to clone/comment, or the job fails at clone/comment time.
#>
param(
  [string]$Url = "http://127.0.0.1:8787/webhooks/github",
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Branch,
  [int]$PrNumber = 1,
  [string]$Action = "labeled",
  [string]$Label = "need-this",
  [string]$DefaultBranch = "main",
  [string]$Secret = $env:GITHUB_WEBHOOK_SECRET,
  [string]$EnvFile = ".env"
)

# Fall back to reading GITHUB_WEBHOOK_SECRET from the .env file.
if (-not $Secret -and (Test-Path $EnvFile)) {
  $line = Get-Content $EnvFile | Where-Object { $_ -match '^\s*GITHUB_WEBHOOK_SECRET\s*=' } | Select-Object -First 1
  if ($line) { $Secret = ($line -split '=', 2)[1].Trim() }
}
if (-not $Secret) { throw "No webhook secret. Set GITHUB_WEBHOOK_SECRET or pass -Secret." }

$payload = [ordered]@{
  action     = $Action
  repository = [ordered]@{ full_name = $Repo; default_branch = $DefaultBranch }
  pull_request = [ordered]@{
    number   = $PrNumber
    title    = "Test PR from send-test-webhook.ps1"
    body     = "Triggering the AI PR Worker for a manual test."
    state    = "open"
    draft    = $false
    merged   = $false
    html_url = "https://github.com/$Repo/pull/$PrNumber"
    labels   = @(@{ name = $Label })
    head     = [ordered]@{
      ref  = $Branch
      sha  = "0000000000000000000000000000000000000000"
      repo = [ordered]@{ full_name = $Repo; clone_url = "https://github.com/$Repo.git" }
    }
    base     = [ordered]@{ ref = $DefaultBranch }
  }
}

# IMPORTANT: sign and send the EXACT same bytes. Depth keeps nested objects intact.
$json  = $payload | ConvertTo-Json -Depth 10 -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

$hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($Secret))
$sig  = "sha256=" + (($hmac.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")

$headers = @{
  "X-GitHub-Event"        = "pull_request"
  "X-Hub-Signature-256"   = $sig
  "X-GitHub-Delivery"     = [guid]::NewGuid().ToString()
}

Write-Host "POST $Url" -ForegroundColor Cyan
Write-Host "Body: $json"
try {
  $resp = Invoke-WebRequest -Uri $Url -Method Post -ContentType "application/json" -Headers $headers -Body $bytes -UseBasicParsing
  Write-Host "HTTP $($resp.StatusCode): $($resp.Content)" -ForegroundColor Green
} catch {
  $r = $_.Exception.Response
  if ($r) {
    $reader = [System.IO.StreamReader]::new($r.GetResponseStream())
    Write-Host "HTTP $([int]$r.StatusCode): $($reader.ReadToEnd())" -ForegroundColor Yellow
  } else {
    throw
  }
}
