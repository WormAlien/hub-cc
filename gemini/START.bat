@echo off
rem Ручной запуск сервера вкладки Gemini (Antigravity).
rem
rem В обычной жизни его поднимает сам хаб (дашборд :8200) и он висит всегда — вкладке нужны
rem живые квота и тир, даже когда Gemini не выбран активным бэкендом. Этот файл нужен, когда
rem надо посмотреть вывод глазами или поднять сервер, не трогая хаб.
rem
rem ANTIGRAVITY_CONFIG_DIR указывает на СВОЮ папку: пул аккаунтов и настройки лежат здесь,
rem а не в %USERPROFILE%\.config\antigravity-proxy (там остался прежний форк).
title Gemini (Antigravity) :20178
cd /d "%~dp0"
set ANTIGRAVITY_CLIENT_VERSION=1.110.0
set ANTIGRAVITY_CONFIG_DIR=%~dp0
node src\index.js
echo.
echo Сервер остановлен. Окно можно закрыть.
pause
