param(
  [Parameter(Mandatory=$true)][int]$StaticPort
)

$ErrorActionPreference = 'SilentlyContinue'

foreach ($wpsHost in @('wps', 'et', 'wpp', 'pdf')) {
  foreach ($file in @('manifest.json', 'ribbon.xml', 'index.html')) {
    $url = 'http://127.0.0.1:' + $StaticPort + '/' + $wpsHost + '/' + $file
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      Write-Output ('[OK] ' + $url + ' -> HTTP ' + $response.StatusCode + ', ' + $response.Content.Length + ' bytes')
    } catch {
      Write-Output ('[X]  ' + $url + ' -> ' + $_.Exception.Message)
    }
  }
}
