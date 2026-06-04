@echo off
title MeshBot Runner
echo Starting MeshBot...
node index.mjs
if %errorlevel% neq 0 (
    echo.
    echo Bot crashed or exited with error code %errorlevel%
)
pause
