param([Parameter(Mandatory = $true)][string]$LiteralArtifactPath)

$ErrorActionPreference = 'Stop'
$utilityModule = Join-Path -Path $PSHOME -ChildPath 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
$securityModule = Join-Path -Path $PSHOME -ChildPath 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Microsoft.PowerShell.Core\Import-Module -Name $utilityModule -Force -ErrorAction Stop
Microsoft.PowerShell.Core\Import-Module -Name $securityModule -Force -ErrorAction Stop

$beforeHash = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralArtifactPath).Hash.ToLowerInvariant()
$signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $LiteralArtifactPath
$afterHash = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralArtifactPath).Hash.ToLowerInvariant()
[ordered]@{
  status = [string]$signature.Status
  signerSubject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
  timestampPresent = [bool]$signature.TimeStamperCertificate
  timestampSubject = if ($signature.TimeStamperCertificate) { [string]$signature.TimeStamperCertificate.Subject } else { $null }
  artifactSha256Before = $beforeHash
  artifactSha256After = $afterHash
} | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
