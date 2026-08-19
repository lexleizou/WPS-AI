param(
  [switch]$PreferCurrent
)

$ErrorActionPreference = 'Stop'

function Get-CurrentIdentityInfo {
  $wid = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  [pscustomobject]@{
    UserId = $wid.Name
    Sid = $wid.User.Value
    Source = 'current'
  }
}

function Convert-ToSid([string]$userId) {
  try {
    return ([System.Security.Principal.NTAccount]$userId).
      Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    return $null
  }
}

function Get-ExplorerIdentityInfo {
  $explorers = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue |
    Sort-Object -Property SessionId, CreationDate -Descending

  foreach ($proc in $explorers) {
    try {
      $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwner
      if ($owner.ReturnValue -ne 0 -or -not $owner.User) { continue }
      $userId = if ($owner.Domain) { "$($owner.Domain)\$($owner.User)" } else { $owner.User }
      $sid = Convert-ToSid $userId
      if (-not $sid) { continue }
      return [pscustomobject]@{
        UserId = $userId
        Sid = $sid
        Source = "explorer:session=$($proc.SessionId)"
      }
    } catch {
      continue
    }
  }

  return $null
}

function Get-ProfilePath([string]$sid, [string]$userId) {
  $profile = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
    Where-Object { $_.SID -eq $sid } |
    Select-Object -First 1

  if ($profile -and $profile.LocalPath -and (Test-Path $profile.LocalPath)) {
    return $profile.LocalPath
  }

  $name = ($userId -split '\\')[-1]
  $candidate = Join-Path $env:SystemDrive "Users\$name"
  if (Test-Path $candidate) {
    return $candidate
  }

  throw "无法定位目标用户 Profile: $userId ($sid)"
}

$current = Get-CurrentIdentityInfo
$target = if ($PreferCurrent) { $current } else { Get-ExplorerIdentityInfo }
if (-not $target) { $target = $current }

$profilePath = Get-ProfilePath $target.Sid $target.UserId
$appData = Join-Path $profilePath 'AppData\Roaming'

Write-Output "TARGET_USER=$($target.UserId)"
Write-Output "TARGET_SID=$($target.Sid)"
Write-Output "TARGET_PROFILE=$profilePath"
Write-Output "TARGET_APPDATA=$appData"
Write-Output "TARGET_SOURCE=$($target.Source)"
