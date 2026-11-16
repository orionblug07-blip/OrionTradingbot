@echo off
rem Creates a Windows scheduled task "JijazyFX" that runs the bot every hour,
rem also on battery, and catches up after the laptop wakes up.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = (Get-Location).Path;" ^
  "$a = New-ScheduledTaskAction -Execute (Join-Path $d 'run_hourly.bat') -WorkingDirectory $d;" ^
  "$t = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1);" ^
  "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30);" ^
  "Register-ScheduledTask -TaskName 'JijazyFX' -Action $a -Trigger $t -Settings $s -Force | Out-Null;" ^
  "Write-Host 'Scheduled task JijazyFX created: runs every hour.'"
pause
