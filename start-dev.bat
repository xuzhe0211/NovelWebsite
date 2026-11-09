@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  Local dev launcher: MySQL (portable) + backend API
rem  MySQL home: C:\Users\xuzhe\AppData\Local\NovelMySQL
rem  Close: just close the two console windows
rem ============================================================

set "MYSQL_HOME=C:\Users\xuzhe\AppData\Local\NovelMySQL"
set "MYSQL_BIN=%MYSQL_HOME%\mysql-8.0.29-winx64\bin"

echo [1/2] Checking MySQL on 127.0.0.1:3306 ...
"%MYSQL_BIN%\mysqladmin.exe" -h 127.0.0.1 -P 3306 -u root -proot ping >nul 2>&1
if not errorlevel 1 goto mysql_ok

echo       Not running, starting mysqld ...
start "NovelMySQL" "%MYSQL_BIN%\mysqld.exe" --defaults-file=%MYSQL_HOME%\my.ini --console
set /a wait=0
:wait_mysql
rem ping is used instead of timeout: timeout.exe refuses redirected stdin
"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
set /a wait+=1
"%MYSQL_BIN%\mysqladmin.exe" -h 127.0.0.1 -P 3306 -u root -proot ping >nul 2>&1
if not errorlevel 1 goto mysql_ok
if %wait% lss 20 goto wait_mysql
echo       [WARN] MySQL not ready after 20s - check the NovelMySQL window
goto run_api

:mysql_ok
echo       MySQL is ready

:run_api
echo [2/2] Starting API on http://127.0.0.1:3000 ...
cd /d "%~dp0server"
call npm run dev
