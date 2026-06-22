@echo off
title Scanner Analytics - Setup
echo ===================================================
echo       Iniciando Setup do Scanner Analytics
echo ===================================================
echo.

echo [1/3] Instalando dependencias do Backend...
cd /d "%~dp0src\backend"
if not exist "node_modules\" (
    call npm install
) else (
    echo Dependencias do Backend ja estao instaladas. Ignorando npm install...
)

echo.
echo [2/3] Instalando dependencias do Frontend...
cd /d "%~dp0src\frontend"
if not exist "node_modules\" (
    call npm install
) else (
    echo Dependencias do Frontend ja estao instaladas. Ignorando npm install...
)

echo.
echo [3/3] Iniciando os servidores...
echo Os servidores serao iniciados no Windows Terminal nesta mesma janela.
cd /d "%~dp0"
wt -w 0 new-tab --title "Backend" -d "%~dp0src\backend" cmd /k "npm run dev" ; new-tab --title "Frontend" -d "%~dp0src\frontend" cmd /k "npm start"

echo.
echo ===================================================
echo Setup concluido!
echo O navegador deve ser aberto em http://localhost:4200
echo ===================================================
echo.
pause
