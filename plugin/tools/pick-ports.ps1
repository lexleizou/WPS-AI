param(
  [int]$PreferredStatic = 3889,
  [int]$PreferredProxy = 3890
)

# 探活方式:真正去 bind TcpListener。Windows 把端口排除在 dynamic 范围(Hyper-V/WSL2 常干)
# 时,bind 会 throw,我们就退到备选。比 netstat -ano 准——netstat 只看在用的,看不到被排除的。
function Test-Port([int]$p) {
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

# 修 T5：加 $exclude，避免第二次调用（选 proxy）在 ephemeral 兜底时和第一次（选 static）
# 撞同一个端口 —— Pick-Port 会在返回前释放端口，两次都从 49152 起扫就会返回同一个。
function Pick-Port([int]$preferred, [int[]]$candidates, [int[]]$exclude = @()) {
  if (($exclude -notcontains $preferred) -and (Test-Port $preferred)) { return $preferred }
  foreach ($p in $candidates) {
    if (($exclude -notcontains $p) -and (Test-Port $p)) { return $p }
  }
  # 全占了 → 退到 ephemeral 范围找一个（跳过已被占用的 exclude）
  for ($p = 49152; $p -le 65535; $p += 1) {
    if (($exclude -notcontains $p) -and (Test-Port $p)) { return $p }
  }
  throw "找不到可用端口"
}

$static = Pick-Port $PreferredStatic @(13889, 23889, 33889, 43889, 53889)
$proxy  = Pick-Port $PreferredProxy  @(13890, 23890, 33890, 43890, 53890) @($static)

# 用空格分隔输出,bat 端 for /f 拆
Write-Output "$static $proxy"
