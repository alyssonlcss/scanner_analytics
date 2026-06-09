@echo off
title Scanner Analytics - Setup
echo ===================================================
echo       Iniciando Setup do Scanner Analytics
echo ===================================================
echo.

echo [1/3] Instalando dependencias do Backend...
cd src\backend
call npm install

echo.
echo [2/3] Instalando dependencias do Frontend...
cd ..\frontend
call npm install

echo.
echo [3/3] Iniciando os servidores...
echo O Backend sera iniciado em uma nova janela.
cd ..\backend
start "Scanner Analytics - Backend" cmd /c "npm run dev"

echo O Frontend sera iniciado em uma nova janela.
cd ..\frontend
start "Scanner Analytics - Frontend" cmd /c "npm start"

echo.
echo ===================================================
echo Setup concluido!
echo O navegador deve ser aberto em http://localhost:4200
echo ===================================================
echo.
pause
