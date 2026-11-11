@echo off
setlocal
set "BRIDGE_ROOT=%~dp0"
set "CVD_ROOT=%BRIDGE_ROOT%..\CVI\CVD"
if not exist "%CVD_ROOT%\Bin\CVD.exe" set "CVD_ROOT=C:\JnDTech\CVI\CVD"
if not exist "%CVD_ROOT%\Bin\CVD.exe" (
  echo [LAUNCH ERROR] CodeViser CVD was not found.
  echo Expected CVD next to the extracted bridge folder or under C:\JnDTech\CVI\CVD.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%BRIDGE_ROOT%monitor-cvd-api.ps1" -CvdExe "%CVD_ROOT%\Bin\CVD.exe" -ApiDir "%CVD_ROOT%\API\BinR" -MasterConfig "%BRIDGE_ROOT%config\master.csf" %*
endlocal
