param(
  [string]$RootDir = ''
)

$ErrorActionPreference = 'SilentlyContinue'

$selfPid = $PID
$parentPid = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID)).ParentProcessId

$patterns = @(
  'serve-permanent.js',
  'proxy-server.js',
  'service-runner.js',
  'service-watchdog.ps1',
  'lingxi-launcher.exe'
)

if ($RootDir) {
  $patterns += $RootDir
}

# 先停计划任务，避免 watchdog 在安装期间把服务重新拉起来（EBUSY 复现）
try { Stop-ScheduledTask -TaskName 'LingxiAI' -ErrorAction SilentlyContinue } catch {}

Get-CimInstance Win32_Process |
  Where-Object {
    # 修 EBUSY 根因：原写法内层 Where-Object 的 $_ 是模式字符串（没有 CommandLine 属性），
    # 匹配恒为空 → 本脚本从未杀掉过任何进程 → build-variants 删 plugin-* 目录时被
    # 仍在运行的 node（proxy CWD 在 plugin-wps 里）锁住而 EBUSY 失败。
    # 先把进程对象存进 $proc，再对模式列表做匹配。
    $proc = $_
    ($proc.ProcessId -ne $selfPid) -and
    ($proc.ProcessId -ne $parentPid) -and
    ($proc.Name -in @('node.exe', 'wscript.exe', 'cmd.exe', 'powershell.exe', 'lingxi-launcher.exe')) -and
    [bool]($patterns | Where-Object { $_ -and ([string]$proc.CommandLine -like ('*' + $_ + '*')) })
  } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force } catch {}
  }
