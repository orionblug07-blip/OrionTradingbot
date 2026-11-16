@echo off
rem Runs the daily check. Task Scheduler calls this every hour.
cd /d "%~dp0"
if not exist data mkdir data
set PY=python
where py >nul 2>nul && set PY=py -3
%PY% bot.py run >> data\scheduler.log 2>&1
