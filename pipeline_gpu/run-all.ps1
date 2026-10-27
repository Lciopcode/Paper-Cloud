# Paper-Cloud semantic layer: run everything (Windows twin of run-all.sh)
# ---------------------------------------------------------------------------
# WHY THIS FILE EXISTS
#   The docs told people to run `bash pipeline_gpu/run-all.sh`. On this machine
#   that command fails outright: there is no `bash` on PATH (no WSL distro, and
#   Git-for-Windows' bash.exe is not on PATH either -- verified with where.exe).
#   So the documented one-command entry point did not work on the target box.
#   This twin uses only PowerShell + the repo's venv, so it works here.
#
# ASCII-ONLY ON PURPOSE
#   PowerShell 5.1 reads .ps1 as GBK, so Chinese comments in this file would be
#   mangled. Keep it ASCII. (Chinese output from the Python scripts is fine:
#   they reconfigure their own stdout to UTF-8.)
#
# USAGE
#   powershell -ExecutionPolicy Bypass -File pipeline_gpu\run-all.ps1
#   powershell -ExecutionPolicy Bypass -File pipeline_gpu\run-all.ps1 -Domains cs,math
#
# EVERY STEP IS INDIVIDUALLY RE-RUNNABLE
#   embed.py's .ok file stores a PRODUCTION FINGERPRINT (model / dim / max-seq-len
#   / shard size). A shard is skipped only when the fingerprint matches, so
#   "switch the model and re-run" recomputes instead of silently reusing vectors.
#   Rule verified by: python pipeline_gpu/selftest_resume.py
#
# TWO GPUS
#   This box has two RTX 4090 D. Different domains can run in parallel on
#   separate cards (set CUDA_VISIBLE_DEVICES=1 for the second one) -- but NEVER
#   two instances for the SAME domain (they would write the same files).

param(
  [string[]]$Domains = @(),
  [int]$Shard = 200000,
  [int]$Batch = 64,
  [int]$K = 20,
  [int]$TopK = 12,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")

# --- interpreter: prefer the repo venv -------------------------------------
# The system python has no sentence-transformers / faiss installed, so a bare
# `python` fails at step 1 with ModuleNotFoundError. That is exactly what the
# first person following setup-4090.md hit.
$py = $null
foreach ($cand in @(".venv\Scripts\python.exe", "venv\Scripts\python.exe", ".venv\bin\python")) {
  if (Test-Path $cand) { $py = $cand; break }
}
if (-not $py) {
  Write-Output "!! no venv found (.venv\Scripts\python.exe). See setup-4090.md section 1.5."
  exit 1
}

# --- model: prefer the local directory -------------------------------------
# Without this, --model defaults to the hub id and embed.py would try to pull
# ~2.3 GB from huggingface.co (measured 0.08-1.3 MB/s on this network, and the
# hub downloader stalls at 0 bytes on large files).
$model = "BAAI/bge-m3"
if (Test-Path "models\bge-m3") { $model = "models/bge-m3" }

if ($Domains.Count -eq 0) {
  $Domains = @("qfin", "bio", "stat", "eess", "econ", "math", "cs", "physics")
}

Write-Output "=== Paper-Cloud semantic layer ==="
Write-Output "python : $py"
Write-Output "model  : $model"
Write-Output "domains: $($Domains -join ' ')"
nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader
Write-Output ""

# Measured on this box (bge-m3 / 256 token / batch 64 / 4090 D): 145-176 papers/s.
#   econ 145 . qfin 149 . bio 158 . stat 163 . eess 161 . math 176
#   econ 12,486 -> 86s . math 575,978 -> 54.4 min
#   extrapolated: cs 806,174 -> ~76 min . physics 1,463,588 -> ~139 min
#   => ~5 h for all eight on ONE card; two cards in parallel save ~76 min.
$report = @()
$total = [System.Diagnostics.Stopwatch]::StartNew()
$aborted = $false

foreach ($d in $Domains) {
  Write-Output ("`n################ {0} ################" -f $d)
  foreach ($step in @(
      @{ n = "1/5 embed  (slowest, 145-176 papers/s)"; a = @("pipeline_gpu/embed.py", "--domain", $d, "--model", $model, "--shard", "$Shard", "--batch", "$Batch") },
      @{ n = "2/5 cluster (layer 5: research points)"; a = @("pipeline_gpu/cluster.py", "--domain", $d) },
      @{ n = "3/5 knn     (in-layer neighbours)"; a = @("pipeline_gpu/knn.py", "--domain", $d, "--k", "$K") },
      @{ n = "4/5 community (layer 6 / third relation kind)"; a = @("pipeline_gpu/community.py", "--domain", $d) },
      @{ n = "5/5 label   (c-TF-IDF names)"; a = @("pipeline_gpu/label.py", "--domain", $d, "--topk", "$TopK") }
    )) {
    Write-Output ("--- {0} ---" -f $step.n)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $py @($step.a) 2>&1 | Select-Object -Last 4
    $code = $LASTEXITCODE
    $sw.Stop()
    $report += [pscustomobject]@{ domain = $d; step = $step.n; secs = [math]::Round($sw.Elapsed.TotalSeconds, 1); exit = $code }
    Write-Output ("    {0}: {1:N1}s exit={2}" -f $step.n.Split(' ')[0], $sw.Elapsed.TotalSeconds, $code)
    if ($code -ne 0) {
      Write-Output ("!! {0} failed at {1} -- stopping. Re-run the same command to resume (shards are resumable)." -f $d, $step.n.Split(' ')[0])
      $aborted = $true
      break
    }
  }
  if ($aborted) { break }
}

Write-Output "`n=== export + register + verify ==="
& $py pipeline_gpu/export.py --all 2>&1 | Select-Object -Last 12
& $py pipeline_gpu/register.py 2>&1 | Select-Object -Last 12

if (-not $SkipVerify) {
  & $py pipeline_gpu/verify_semantic.py --all 2>&1 | Select-Object -Last 30
  Write-Output ""
  Write-Output "format contract self-test (deliberately writes bad files):"
  & $py pipeline_gpu/selftest_formats.py 2>&1 | Select-Object -Last 4
  Write-Output "resume verdict self-test:"
  & $py pipeline_gpu/selftest_resume.py 2>&1 | Select-Object -Last 4
}

$total.Stop()
Write-Output "`n=== SUMMARY ==="
$report | Format-Table -AutoSize
$failed = @($report | Where-Object { $_.exit -ne 0 }).Count
Write-Output ("total {0:N1} min . failed steps: {1}" -f $total.Elapsed.TotalMinutes, $failed)

Write-Output ""
Write-Output "NOTE on git: the semantic products are NOT versioned."
Write-Output "  .gitignore has a line 'public/data/', so nothing under public/ is tracked and"
Write-Output "  'git add public/data/...' FAILS with 'The following paths are ignored...'."
Write-Output "  That is intentional: public/data is 4.4 GB of REBUILDABLE output and travels with"
Write-Output "  the delivery folder instead of with git. So after this run there is nothing to commit;"
Write-Output "  only code and docs are versioned."
Write-Output ""
Write-Output "Frontend acceptance (no Chrome needed; Edge works):"
Write-Output "  node deploy/verify-all.mjs     # 13/13, about 210 s (it starts its own server)"

if ($failed -gt 0 -or $aborted) { exit 1 }
exit 0
