@echo off
set WT_PATH=%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe
set PROJECT_DIR=%~dp0
set PROJECT_DIR=%PROJECT_DIR:~0,-1%

:: Se nao estiver rodando dentro do Windows Terminal, re-lanca o script dentro dele
if not defined WT_SESSION (
    "%WT_PATH%" -d "%PROJECT_DIR%" --title "Setup" --suppressApplicationTitle cmd /k "%~f0"
    exit /b
)

title Scanner Analytics - Setup
echo ===================================================
echo       Iniciando Setup do Scanner Analytics
echo ===================================================
echo.

echo [1/3] Instalando dependencias do Backend...
cd /d "%PROJECT_DIR%\src\backend"
if not exist "node_modules\" (
    set PUPPETEER_SKIP_DOWNLOAD=true
    call npm install
) else (
    echo Dependencias do Backend ja estao instaladas. Ignorando npm install...
)

echo.
echo [2/3] Instalando dependencias do Frontend...
cd /d "%PROJECT_DIR%\src\frontend"
if not exist "node_modules\" (
    call npm install
) else (
    echo Dependencias do Frontend ja estao instaladas. Ignorando npm install...
)

echo.
echo [3/3] Iniciando os servidores...
cd /d "%PROJECT_DIR%"

echo Abrindo abas do Backend e Frontend...
"%WT_PATH%" -w 0 new-tab -d "%PROJECT_DIR%\src\backend" --title "Backend" --suppressApplicationTitle cmd /k "npm run dev"
"%WT_PATH%" -w 0 new-tab -d "%PROJECT_DIR%\src\frontend" --title "Frontend" --suppressApplicationTitle cmd /k "npm start"

exit
