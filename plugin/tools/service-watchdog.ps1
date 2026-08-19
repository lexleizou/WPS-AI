param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$RunnerPath,
  [Parameter(Mandatory=$true)][string]$ScriptPath,
  [Parameter(Mandatory=$true)][string]$RootDir,
  [Parameter(Mandatory=$true)][int]$StaticPort,
  [Parameter(Mandatory=$true)][int]$ProxyPort,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [int]$IdleSeconds = 30,
  [int]$PollSeconds = 2,
  [switch]$StartNow
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-WatchdogLog([string]$Message) {
  try {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -Path $LogPath -Encoding UTF8 -Value ("[{0}] [watchdog] {1}" -f (Get-Date).ToUniversalTime().ToString("o"), $Message)
  } catch {}
}

function Get-WpsHostProcess {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @('wps.exe', 'et.exe', 'wpp.exe', 'pdf.exe', 'wpsoffice.exe')
    } |
    Where-Object {
      $cmd = [string]$_.CommandLine
      if (-not $cmd) { return $true }

      # WPS keeps preview/preload/CEF helper processes after the visible window closes.
      # They should not keep the Lingxi Node service alive.
      if ($cmd -match '(?i)(/Preview\b|-Embedding\b|/from_prome\b|/prome-prestart-type=|CefRenderEntryPoint|promecefpluginhost|--type=renderer)') {
        return $false
      }

      # 修 ribbon 消失根因（二次修复）：`Run -Entry=` 既可能是预启动进程，也可能是用户真实主窗口
      # （WPS 12.1.0.26895 起主进程命令行同样带 `Run -Entry=EntryPoint`）。
      #
      # 旧版曾用 `MainWindowHandle -ne 0` 区分"预启动(无窗口) vs 主进程(有窗口)"。但 watchdog 由
      # 计划任务拉起，运行的 Windows 会话常与用户的 WPS **不在同一会话**（尤其 RDP 远程桌面 /
      # 服务上下文）。跨会话拿不到对方会话里的窗口句柄，MainWindowHandle 与 EnumWindows 对真实
      # 主窗口同样恒为 0/不可见 → 误判"没有 WPS 在跑" → idle 停掉本地服务 → taskpane(静态) 与
      # 代理端口全down → 模型栏/ribbon 失效。
      #
      # 改为**纯进程存在性**判定：Win32_Process 跨会话可见，只要存在非上面排除名单里的 WPS 宿主
      # 进程（renderer/preview/embedding 已排除），就认为 WPS 在用，保活服务。代价：WPS 的预启动
      # 后台进程也会让服务多保活一会（资源略多），但远好于"用户正用着服务却被杀"。
      return $true
    }
}

function Get-LingxiNodeProcess {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.Name -eq 'node.exe') -and
      (($_.CommandLine -like '*service-runner.js*') -or
       ($_.CommandLine -like '*serve-permanent.js*') -or
       ($_.CommandLine -like '*proxy-server.js*')) -and
      ($_.CommandLine -like '*\.lingxi-ai*')
    }
}

function Test-StaticPort {
  $client = $null
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connect = $client.BeginConnect('127.0.0.1', $StaticPort, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(500, $false)) {
      return $false
    }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    if ($client) { $client.Close() }
  }
}

function Start-LingxiService {
  if (Test-StaticPort) { return }
  # 修 watchdog 进程风暴：只看端口通不通不够。node 冷启动 + 加载模块 + bind 端口常要 1~3s，
  # 主循环每 2s 就来一次，端口还没起来时会不停 Start-Process 新 node；若 node 崩溃/端口冲突
  # 更会 crash-loop 无限 spawn。这里先看是否已有本插件的 node 在跑：有就说明正在启动中，等它，
  # 不再叠新进程。真挂死的 node 由 WPS 关闭后的 idle-stop 路径回收。
  if (Get-LingxiNodeProcess) { return }
  if (-not (Test-Path $NodeExe)) { Write-WatchdogLog "node missing: $NodeExe"; return }
  if (-not (Test-Path $RunnerPath)) { Write-WatchdogLog "runner missing: $RunnerPath"; return }
  if (-not (Test-Path $ScriptPath)) { Write-WatchdogLog "script missing: $ScriptPath"; return }

  $args = @(
    "`"$RunnerPath`"",
    "--log", "`"$LogPath`"",
    "--static-port", "$StaticPort",
    "--proxy-port", "$ProxyPort",
    "--script", "`"$ScriptPath`"",
    "--root", "`"$RootDir`""
  ) -join ' '

  Write-WatchdogLog "starting node service on $StaticPort/$ProxyPort"
  Start-Process -FilePath $NodeExe -ArgumentList $args -WorkingDirectory $RootDir -WindowStyle Hidden | Out-Null
}

function Stop-LingxiService {
  Write-WatchdogLog "stopping node service after idle"
  Get-LingxiNodeProcess | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force } catch {}
  }
}

Write-WatchdogLog "watchdog started; idleSeconds=$IdleSeconds pollSeconds=$PollSeconds startNow=$StartNow"

$lastSeenWps = if ($StartNow) { Get-Date } else { $null }
if ($StartNow) { Start-LingxiService }

while ($true) {
  $hasWps = [bool](Get-WpsHostProcess)
  if ($hasWps) {
    $lastSeenWps = Get-Date
    Start-LingxiService
  } elseif ($lastSeenWps -and ((Get-Date) - $lastSeenWps).TotalSeconds -ge $IdleSeconds) {
    Stop-LingxiService
    $lastSeenWps = $null
  }
  Start-Sleep -Seconds $PollSeconds
}
