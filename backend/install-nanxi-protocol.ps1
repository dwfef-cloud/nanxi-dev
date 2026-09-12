$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $root 'start-nanxi.ps1'
$key = 'HKCU:\Software\Classes\nanxi'
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $key -Name '(Default)' -Value 'URL:南溪AI获客'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path "$key\shell\open\command" -Name '(Default)' -Value "powershell.exe -ExecutionPolicy Bypass -File `"$launcher`" `"%1`""
Write-Host 'nanxi:// 协议已安装。现在点击 nanxi://desktop 即可启动南溪 AI 获客。'
