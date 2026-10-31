#
# GitHub Desktop 一键脚本（Windows）
#
#   .\desktop.ps1              交互菜单
#   .\desktop.ps1 1|2|3|4|5|6  直接执行某一步
#   $env:MODE='prod'; .\desktop.ps1
#                               使用 production 构建（产物名为 GitHubDesktop.exe，
#                               安装时会覆盖 %LOCALAPPDATA%\GitHubDesktop 中的官方版）
#
# 也可以双击 desktop.cmd 启动交互菜单。
#
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Steps,
  [string]$Mode = $(if ($env:MODE) { $env:MODE } else { 'dev' })
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

switch ($Mode) {
  'dev' {
    $env:NODE_ENV = 'development'
    $AppName = 'GitHubDesktop-dev'
  }
  'prod' {
    $env:NODE_ENV = 'production'
    # 本地没有发布证书，沿用 development 渠道
    $env:RELEASE_CHANNEL = 'development'
    $AppName = 'GitHubDesktop'
  }
  default {
    Write-Host "未知 MODE: $Mode（可选 dev / prod）" -ForegroundColor Red
    exit 1
  }
}

# Node 的 fetch 不读取 Windows 系统代理，这里把系统代理导出为环境变量
if (-not ($env:https_proxy -or $env:HTTPS_PROXY)) {
  try {
    $inet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    if ($inet.ProxyEnable -eq 1 -and $inet.ProxyServer) {
      $hp = $null
      if ($inet.ProxyServer -match 'https=([^;]+)') { $hp = $Matches[1] }
      elseif ($inet.ProxyServer -notmatch '=') { $hp = $inet.ProxyServer }
      if ($hp) {
        if ($hp -notmatch '://') { $hp = "http://$hp" }
        $env:https_proxy = $hp; $env:HTTPS_PROXY = $hp
        $env:http_proxy = $hp; $env:HTTP_PROXY = $hp
        if (-not $env:NO_PROXY) { $env:NO_PROXY = 'localhost,127.0.0.1' }
        if (-not $env:no_proxy) { $env:no_proxy = 'localhost,127.0.0.1' }
      }
    }
  } catch { }
}
if ($env:https_proxy -or $env:HTTPS_PROXY) { $env:NODE_USE_ENV_PROXY = '1' }

$Arch = if ($env:npm_config_arch -eq 'arm64' -or $env:npm_config_arch -eq 'x64') {
  $env:npm_config_arch
} elseif ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
  'arm64'
} else {
  'x64'
}

$DistDir = Join-Path $Root "dist\$AppName-win32-$Arch"
$ExePath = Join-Path $DistDir "$AppName.exe"
# Squirrel 包名固定为 GitHubDesktop（见 script/dist-info.ts）
$SetupExe = Join-Path $Root "dist\installer\${AppName}Setup-$Arch.exe"
$InstallDir = Join-Path $env:LOCALAPPDATA 'GitHubDesktop'

# .nvmrc 指定的 Node 版本；没有版本管理器可用时会从 nodejs.org 下载 zip 装到这里（免管理员）
$NodeWanted = ((Get-Content (Join-Path $Root '.nvmrc') -Raw).Trim() -replace '^v', '')
$NodeHome = Join-Path $env:USERPROFILE ".desktop-node\node-v$NodeWanted-win-$Arch"

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "✔ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "✘ $m" -ForegroundColor Red; exit 1 }

function Test-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# 外部命令失败即终止（相当于 bash 的 set -e）
function Invoke-Native([string]$File, [string[]]$CmdArgs) {
  & $File @CmdArgs
  if ($LASTEXITCODE -ne 0) { Die "命令失败 (exit ${LASTEXITCODE}): $File $($CmdArgs -join ' ')" }
}

# winget 安装完不会更新当前进程的 PATH，从注册表重新加载
function Update-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

# fnm 的版本切换只对当前会话有效，重新执行步骤前恢复
function Initialize-Fnm {
  if (Test-Cmd fnm) {
    fnm env --shell power-shell | Out-String | Invoke-Expression
    fnm use --install-if-missing *> $null
    return (Test-Cmd node)
  }
  return $false
}

function Test-NodeVersion {
  (Test-Cmd node) -and ((& node -v 2>$null) -eq "v$NodeWanted")
}

# 官方 zip 解压版 Node：装上后优先于系统 PATH 里的其他版本
function Enable-BundledNode {
  $exe = Join-Path $NodeHome 'node.exe'
  if (-not (Test-Path $exe)) { return $false }
  if (($env:Path -split ';') -notcontains $NodeHome) {
    $env:Path = "$NodeHome;$env:Path"
  }
  return $true
}

function Install-NodeZip {
  $url = "https://nodejs.org/dist/v$NodeWanted/node-v$NodeWanted-win-$Arch.zip"
  $zip = Join-Path $env:TEMP "node-v$NodeWanted-win-$Arch.zip"
  $dest = Split-Path $NodeHome -Parent
  Info "下载 Node v$NodeWanted ($url)…"
  New-Item -ItemType Directory -Force $dest | Out-Null
  if (Test-Cmd curl.exe) {
    & curl.exe -fSL --retry 3 --retry-all-errors -o $zip $url
    if ($LASTEXITCODE -ne 0) { return $false }
  } else {
    try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing }
    catch { return $false }
  }
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Enable-BundledNode
}

# 每一步执行前确认 node / yarn 可用
function Assert-Node {
  Enable-BundledNode | Out-Null
  if (-not (Test-Cmd node)) { Initialize-Fnm | Out-Null }
  if (-not (Test-Cmd node)) { Die '找不到 node，请先执行第 1 步' }
  if (-not (Test-Cmd yarn)) { Die '找不到 yarn，请先执行第 1 步' }
}

# 根目录和 app/ 的 node_modules 都与 yarn.lock 一致，且 Electron 已下载
# -NoElectron 时不检查 Electron
function Test-Deps([switch]$NoElectron) {
  if (-not (Test-Path 'node_modules') -or -not (Test-Path 'app\node_modules')) { return $false }
  & yarn check --integrity *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  & yarn --cwd app check --integrity *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  if ($NoElectron) { return $true }
  return (Test-Path 'node_modules\electron\path.txt') -and (Test-Path 'node_modules\electron\dist')
}

# ---------------------------------------------------------------- 1. 安装环境
function Step-Setup {
  Info '[1] 安装环境'
  if ($env:OS -ne 'Windows_NT') { Die '此脚本仅支持 Windows' }

  # Visual C++ Build Tools：编译 keytar / node-pty / registry-js 等原生模块需要
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $hasVc = $false
  if (Test-Path $vswhere) {
    $hasVc = [bool](& $vswhere -latest -products * `
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -property installationPath 2>$null)
  }
  if (-not $hasVc) {
    if (Test-Cmd winget) {
      Warn '未找到 Visual C++ Build Tools，正在通过 winget 安装（会弹出 UAC，下载约几分钟）…'
      & winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
        --accept-source-agreements --accept-package-agreements `
        --override '--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --norestart'
      if (Test-Path $vswhere) {
        $hasVc = [bool](& $vswhere -latest -products * `
          -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
          -property installationPath 2>$null)
      }
    }
    if (-not $hasVc) { Die '缺少 Visual C++ Build Tools（编译原生模块需要），请安装 VS Build Tools 的"使用 C++ 的桌面开发"工作负荷后重试' }
  }
  Ok 'Visual C++ Build Tools'

  # Python 3：node-gyp 需要
  $pyOk = $false
  foreach ($p in 'python', 'python3') {
    if (Test-Cmd $p) {
      & $p --version *> $null
      if ($LASTEXITCODE -eq 0) { $pyOk = $true; break }
    }
  }
  if (-not $pyOk -and (Test-Cmd py)) {
    & py -3 --version *> $null
    if ($LASTEXITCODE -eq 0) { $pyOk = $true }
  }
  if (-not $pyOk) {
    if (Test-Cmd winget) {
      Warn '未找到 Python 3，正在通过 winget 安装…'
      & winget install --id Python.Python.3.12 -e `
        --accept-source-agreements --accept-package-agreements
      Update-Path
      if (Test-Cmd python) {
        & python --version *> $null
        if ($LASTEXITCODE -eq 0) { $pyOk = $true }
      }
    }
    if (-not $pyOk) { Die '缺少 Python 3（node-gyp 需要），请安装并勾选"Add to PATH"后重试' }
  }
  Ok 'Python 3'

  # Node：版本以 .nvmrc 为准。优先 nvm-windows / fnm；
  # 都没有则从 nodejs.org 下载 zip 装到用户目录（免管理员，可拿到精确版本）；
  # 最后才用 winget（仓库版本可能滞后，只作同主版本兜底）
  Enable-BundledNode | Out-Null
  if (-not (Test-NodeVersion) -and (Test-Cmd nvm)) {
    Info "通过 nvm-windows 安装/切换 Node $NodeWanted…"
    & nvm install $NodeWanted
    & nvm use $NodeWanted
  }
  if (-not (Test-NodeVersion)) { Initialize-Fnm | Out-Null }
  if (-not (Test-NodeVersion)) { Install-NodeZip | Out-Null }
  if (-not (Test-NodeVersion) -and (Test-Cmd winget)) {
    $major = ($NodeWanted -split '\.')[0]
    $available = & winget show OpenJS.NodeJS --versions 2>$null |
      Where-Object { $_ -match '^\d+\.\d+\.\d+\s*$' } | ForEach-Object { $_.Trim() }
    $ver = @($available | Where-Object { $_ -eq $NodeWanted }) +
           @($available | Where-Object { $_ -like "$major.*" } | Sort-Object { [version]$_ } -Descending)
    if (-not $ver) { $ver = @($available | Sort-Object { [version]$_ } -Descending) }
    if (-not $ver) { Die '找不到可用的 Node 版本，请手动安装后重试' }
    $ver = $ver[0]
    if ($ver -ne $NodeWanted) { Warn "winget 没有 Node $NodeWanted，改装同主版本最新版 $ver" }
    Info "通过 winget 安装 Node $ver…"
    & winget install --id OpenJS.NodeJS --version $ver -e `
      --accept-source-agreements --accept-package-agreements
    Update-Path
  }
  if (-not (Test-Cmd node)) { Die '找不到 node，请手动安装后重试' }
  if (-not (Test-NodeVersion)) {
    $major = ($NodeWanted -split '\.')[0]
    $have = & node -v
    if ($have -match "^v$major\.") {
      Warn "node $have 与 .nvmrc (v$NodeWanted) 不一致，主版本相同，继续"
    } else {
      Die "node $have 与 .nvmrc 要求的 v$NodeWanted 不一致，请切换版本后重试"
    }
  }
  Ok "node $(& node -v)"

  if (-not (Test-Cmd yarn)) {
    Info '安装 yarn 1.x…'
    Invoke-Native npm @('install', '-g', 'yarn@1')
  }
  Ok "yarn $(& yarn -v)"

  if ((& git submodule status --recursive) -match '^-') {
    Info '初始化 git submodules…'
    Invoke-Native git @('submodule', 'update', '--init', '--recursive')
  }
  Ok 'git submodules'

  if ($env:FORCE -ne '1' -and (Test-Deps)) {
    Ok '依赖已安装且与 yarn.lock 一致，跳过（FORCE=1 可强制重装）'
    Ok '环境安装完成'
    return
  }

  # 依赖完整、只差 Electron 二进制（通常是之前下载失败）时只补装 Electron
  if ($env:FORCE -ne '1' -and (Test-Deps -NoElectron)) {
    Info '补装 Electron 二进制…'
    Invoke-Native node @('node_modules\electron\install.js')
    Ok '环境安装完成'
    return
  }

  # yarn 1 多个进程共用缓存并发解压会互相损坏文件
  $busy = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'yarn' -and $_.CommandLine -match 'install' }
  if ($busy) {
    $busy | ForEach-Object { Write-Host "  PID $($_.ProcessId): $($_.CommandLine)" -ForegroundColor Yellow }
    Die '检测到其他 yarn install 正在运行，请等待其结束或结束上面的进程后重试'
  }

  Info '安装依赖 (yarn install)…'
  & yarn install --frozen-lockfile --network-concurrency 4
  if ($LASTEXITCODE -ne 0) {
    Warn '安装失败，清理 yarn 缓存后重试一次…'
    & yarn cache clean
    Invoke-Native yarn @('install', '--frozen-lockfile', '--network-concurrency', '4')
  }
  Ok '环境安装完成'
}

# dev 构建默认从 yarn start 的 localhost:3000 加载界面；独立构建把界面打包进应用，
# 才能脱离开发服务器单独运行
function Test-StandaloneBuild {
  $indexHtml = Join-Path $DistDir 'resources\app\index.html'
  (Test-Path $indexHtml) -and -not (Select-String -Path $indexHtml -Pattern 'localhost:3000' -Quiet)
}

# ---------------------------------------------------------------- 2. 编译
function Step-Build {
  $kind = ''
  if ($Mode -eq 'dev') {
    $kind = if ($env:DESKTOP_STANDALONE -eq '1') { ', 独立运行' } else { ', 配合第 3 步开发服务器' }
  }
  Info "[2] 编译 ($Mode$kind)"
  Assert-Node
  Invoke-Native yarn @("build:$Mode")
  if (-not (Test-Path $ExePath)) { Die "编译完成但未找到 $ExePath" }
  Ok "编译完成: $ExePath"
}

# ---------------------------------------------------------------- 3. 运行
function Step-Run {
  Info "[3] 运行 ($Mode)"
  Assert-Node
  if (-not (Test-Path $ExePath)) { Die "未找到 $ExePath，请先执行第 2 步" }
  if ($Mode -eq 'dev' -and (Test-StandaloneBuild)) {
    Info '当前是独立构建，开发模式需要连接开发服务器的构建，重新编译…'
    $env:DESKTOP_STANDALONE = ''
    Step-Build
  }
  if ($Mode -eq 'dev') {
    Info '启动开发模式（支持热更新，Ctrl+C 退出）'
    Invoke-Native yarn @('start')
  } else {
    Invoke-Native yarn @('start:prod')
  }
}

# ---------------------------------------------------------------- 4. 打包
function Step-Package {
  Info '[4] 打包安装程序 (Squirrel)'
  Assert-Node
  if (-not (Test-Path $ExePath)) { Die "未找到 $ExePath，请先执行第 2 步" }
  Invoke-Native yarn @('package')
  if (-not (Test-Path $SetupExe)) { Die "未生成 $SetupExe" }
  Ok "打包完成: $SetupExe"
}

# ---------------------------------------------------------------- 5. 安装
function Step-Install {
  Info '[5] 安装'
  if (-not (Test-Path $ExePath)) { Die "未找到 $ExePath，请先执行第 2 步" }
  if ($Mode -eq 'dev' -and -not (Test-StandaloneBuild)) {
    Info '当前构建依赖 localhost:3000 开发服务器，重新编译为独立运行版本…'
    $env:DESKTOP_STANDALONE = '1'
    Step-Build
  }
  if (-not (Test-Path $SetupExe)) { Die "未找到 $SetupExe，请先执行第 4 步" }

  if (Test-Path $InstallDir) {
    $yn = Read-Host "将覆盖 $InstallDir（可能是官方版本），继续？[y/N]"
    if ($yn -notmatch '^[Yy]') { Warn '已取消'; return }
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, 'OrdinalIgnoreCase') } |
      ForEach-Object {
        Info "关闭正在运行的 $($_.ProcessName)…"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
      }
  }

  # Squirrel 安装完成后会自动启动应用
  Info "运行 $SetupExe …"
  & $SetupExe
  Ok "已安装: $InstallDir"
}

# ---------------------------------------------------------------- 6. 一键全部
function Step-All {
  Step-Setup
  $env:DESKTOP_STANDALONE = '1'
  Step-Build
  Step-Package
  Step-Install
  Ok '全部完成'
}

function Invoke-Step([string]$s) {
  switch ($s) {
    '1' { Step-Setup }
    '2' { Step-Build }
    '3' { Step-Run }
    '4' { Step-Package }
    '5' { Step-Install }
    '6' { Step-All }
    { $_ -in '0', 'q', 'Q' } { exit 0 }
    default { Warn "无效选项: $s" }
  }
}

function Show-Menu {
  $proxy = if ($env:https_proxy) { $env:https_proxy } elseif ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { '无' }
  $nodeVer = (Get-Content '.nvmrc' -Raw).Trim()
  while ($true) {
    Write-Host ''
    Write-Host 'GitHub Desktop 构建工具' -ForegroundColor Green -NoNewline
    Write-Host "  (MODE=$Mode, 产物: $AppName.exe, 代理: $proxy)"
    Write-Host "  1) 安装环境     VC++ Build Tools / Node $nodeVer / yarn / Python / submodules / 依赖"
    Write-Host "  2) 编译         yarn build:$Mode"
    Write-Host '  3) 运行         启动编译好的应用'
    Write-Host '  4) 打包         生成安装程序 (Setup exe/msi)'
    Write-Host "  5) 安装         安装到 $InstallDir"
    Write-Host '  6) 一键完成     1 → 2 → 4 → 5 并启动应用'
    Write-Host '  0) 退出'
    $choice = Read-Host '请选择 [0-6]'
    if ($choice -in '0', 'q', 'Q') { exit 0 }
    # 用独立进程执行，单步失败不会退出菜单
    $hostExe = (Get-Process -Id $PID).Path
    if (-not $hostExe) { $hostExe = 'powershell.exe' }
    & $hostExe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Mode $Mode -Steps $choice
    if ($LASTEXITCODE -ne 0) { Warn "步骤 $choice 执行失败" }
  }
}

try {
  if ($Steps.Count -gt 0) {
    foreach ($s in $Steps) { Invoke-Step $s }
  } else {
    Show-Menu
  }
} catch {
  Write-Host "✘ $_" -ForegroundColor Red
  exit 1
}
