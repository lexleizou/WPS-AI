param(
  [Parameter(Mandatory=$true)][string]$TargetDir,
  [Parameter(Mandatory=$true)][int]$ProxyPort
)

# 客户端 JS(plugin/js/...)硬编码了 127.0.0.1:3890 / localhost:3890,
# 装包时如果 proxy 端口被改了,得把 TARGET\plugin-{wps,et,wpp,pdf}\ 下所有 JS 里
# 的 :3890 替换成实际选中的端口。
# 注意:只动 :3890 这俩字面量(localhost:3890 / 127.0.0.1:3890),不碰别的。

if ($ProxyPort -eq 3890) {
  Write-Output "proxy 端口仍是 3890,不用改 JS"
  return
}

$ErrorActionPreference = 'Stop'
$count = 0

Get-ChildItem -Path $TargetDir -Filter "*.js" -Recurse -File | ForEach-Object {
  $path = $_.FullName
  $content = Get-Content $path -Raw -Encoding UTF8
  # 修 T4：`:3890` 后面必须没有更多数字，否则会误改 :38900 / :38901 这类端口
  # （localhost:38900 → localhost:<新端口>0）。用 (?!\d) 负向断言加边界。
  $new = $content -replace 'localhost:3890(?!\d)', "localhost:$ProxyPort"
  $new = $new -replace '127\.0\.0\.1:3890(?!\d)', "127.0.0.1:$ProxyPort"
  if ($new -ne $content) {
    # 用 UTF-8 (无 BOM) 写回,跟原文件保持一致
    $utf8nobom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $new, $utf8nobom)
    $count++
  }
}

Write-Output "[OK] 改了 $count 个 JS 文件,把 :3890 换成 :$ProxyPort"
