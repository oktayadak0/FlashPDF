@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ======================================================================
rem  PiCODE - tek tikla kurulum ve baslatma (Windows)
rem
rem  1. Python 3.10+ (yoksa winget ile Python 3.12 kurar)
rem  2. .venv sanal ortami + backend\requirements.txt paketleri
rem  3. Ollama (yoksa winget ile kurar) ve Ollama sunucusu
rem  4. Gemma 4 modeli (yoksa indirir, yaklasik 8 GB)
rem  5. PiCODE sunucusu + tarayicida http://127.0.0.1:8000
rem
rem  Secenekler:
rem    RUN.bat --no-start          sadece kurulum, siteyi baslatmaz
rem    set PICODE_MODEL=...        baska bir Gemma 4 etiketi kullan
rem    set PICODE_PORT=...         baska bir port kullan (varsayilan 8000)
rem    set PICODE_NO_BROWSER=1     tarayiciyi otomatik acma
rem
rem  Not: Bu dosya bilerek yalnizca ASCII karakter icerir (Turkce harf yok).
rem  Boylece Windows kod sayfasina ve dosyanin kayit kodlamasina bagli
rem  hatalar olusmaz. Not Defteri'nde "UTF-8 BOM" ile KAYDETMEYIN.
rem ======================================================================

if not defined PICODE_MODEL set "PICODE_MODEL=gemma4:e2b"
if not defined PICODE_PORT set "PICODE_PORT=8000"
set "OLLAMA_URL=http://127.0.0.1:11434"
set "APP_URL=http://localhost:%PICODE_PORT%"

rem Bu dosya kendini arka planda tarayici acmak icin de cagirir.
if "%~1"=="__open_browser" goto open_browser

rem Cift tiklandiysa pencere hata ya da bitis mesajinda kapanmasin.
rem (Komut satiri gecikmeli genisletmeyle okunur; icindeki & veya > gibi karakterler calistirilmaz.)
set "INTERACTIVE="
setlocal EnableDelayedExpansion
set "CMDLINE=!cmdcmdline!"
if /i not "!CMDLINE:%~nx0=!"=="!CMDLINE!" (endlocal & set "INTERACTIVE=1") else endlocal

set "NO_START="
if /i "%~1"=="--no-start" set "NO_START=1"
set "HAVE_WINGET="
where winget >nul 2>&1 && set "HAVE_WINGET=1"
set "MODEL_READY="

title FlashPDF
echo.
echo  ==============================================
echo    FlashPDF - kurulum ve baslatma
echo  ==============================================
echo.

rem ---------------------------------------------------------------- 1. Python
echo [1/5] Python kontrol ediliyor...
call :find_python
if defined PY goto python_found
echo       Python bulunamadi.
if not defined HAVE_WINGET goto no_python
echo       winget ile Python 3.12 kuruluyor...
winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
call :find_python
if not defined PY goto no_python
:python_found
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1 || goto old_python
for /f "delims=" %%V in ('%PY% --version 2^>^&1') do echo       %%V bulundu.

rem ---------------------------------------------------------------- 2. venv + paketler
echo [2/5] Python paketleri kontrol ediliyor...
if exist ".venv\Scripts\python.exe" goto venv_ready
echo       Sanal ortam olusturuluyor: .venv
%PY% -m venv .venv || goto fail_venv
:venv_ready
set "VPY=%CD%\.venv\Scripts\python.exe"
"%VPY%" -m pip install --disable-pip-version-check -q -r backend\requirements.txt || goto fail_pip
echo       fastapi, uvicorn, httpx hazir.

rem ---------------------------------------------------------------- 3. Ollama
echo [3/5] Ollama kontrol ediliyor...
call :find_ollama
if defined OLLAMA goto ollama_found
echo       Ollama bulunamadi.
if not defined HAVE_WINGET goto no_ollama
echo       winget ile Ollama kuruluyor...
winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
call :find_ollama
if not defined OLLAMA goto no_ollama
:ollama_found
echo       Ollama: %OLLAMA%

curl -s -f "%OLLAMA_URL%/api/tags" >nul 2>&1 && goto ollama_running
echo       Ollama sunucusu baslatiliyor...
start "Ollama" /min "%OLLAMA%" serve
set /a TRIES=0
:wait_ollama
ping -n 2 127.0.0.1 >nul
curl -s -f "%OLLAMA_URL%/api/tags" >nul 2>&1 && goto ollama_running
set /a TRIES+=1
if %TRIES% lss 5 goto wait_ollama
echo       BILGI: Ollama yanit vermedi. Site aciliyor (demo modu kullanilabilir).
goto start_app
:ollama_running
echo       Ollama sunucusu calisiyor: %OLLAMA_URL%

rem ---------------------------------------------------------------- 4. Model kontrolu
echo [4/5] Model kontrol ediliyor: %PICODE_MODEL%
"%OLLAMA%" list 2>nul | findstr /b /c:"%PICODE_MODEL% " >nul && goto model_found
echo       Model (%PICODE_MODEL%) bulunamadi; site aciliyor (demo modu hazir).
goto start_app
:model_found
set "MODEL_READY=1"
echo       %PICODE_MODEL% hazir.
goto start_app
:model_failed
echo       Site aciliyor...

rem ---------------------------------------------------------------- 5. PiCODE
:start_app
if defined NO_START goto setup_done
echo [5/5] PiCODE baslatiliyor...

rem PiCODE bu portta zaten calisiyorsa yeni sunucu acma, sadece tarayiciyi ac.
curl -s -f "%APP_URL%/api/config" >nul 2>&1 && goto already_running

rem Port baska bir program tarafindan kullaniliyorsa sonraki bos portu sec.
call :port_busy %PICODE_PORT%
if not defined BUSY goto port_ok
echo       %PICODE_PORT% portu baska bir program tarafindan kullaniliyor; bos port araniyor...
set /a TRY_PORT=%PICODE_PORT%
set /a LAST_PORT=%PICODE_PORT%+20
:next_port
set /a TRY_PORT+=1
if %TRY_PORT% gtr %LAST_PORT% goto no_port
call :port_busy %TRY_PORT%
if defined BUSY goto next_port
set "PICODE_PORT=%TRY_PORT%"
set "APP_URL=http://localhost:%PICODE_PORT%"
echo       Bos port bulundu: %PICODE_PORT%
:port_ok

if not defined PICODE_NO_BROWSER start "" /b "%~f0" __open_browser
echo.
echo  ----------------------------------------------
echo    FlashPDF:  %APP_URL%
if defined MODEL_READY echo    Model:     %PICODE_MODEL% (Ollama uzerinden)
if not defined MODEL_READY echo    Model:     hazir degil - demo modu kullanilabilir
echo    Tarayici birkac saniye icinde acilacak.
echo    Durdurmak icin bu pencerede Ctrl+C tuslayin.
echo  ----------------------------------------------
echo.
"%VPY%" -m uvicorn backend.app:app --host 127.0.0.1 --port %PICODE_PORT%
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (echo PiCODE durduruldu.) else (echo HATA: PiCODE sunucusu kapandi ^(kod %EXIT_CODE%^). Yukaridaki mesaji kontrol edin.)
call :hold
exit /b %EXIT_CODE%

:already_running
echo       PiCODE zaten calisiyor: %APP_URL%
echo       Baska bir pencerede ya da arka planda acik; yeni sunucu baslatilmadi.
if not defined PICODE_NO_BROWSER (
  start "" "%APP_URL%"
  echo       Tarayici acildi.
)
echo       Kapatmak icin PiCODE'un calistigi diger pencerede Ctrl+C tuslayin.
call :hold
exit /b 0

:setup_done
echo.
echo Kurulum tamamlandi. Baslatmak icin: RUN.bat
call :hold
exit /b 0

rem ================================================================ yardimcilar

:hold
rem Cift tiklamayla acildiysa pencereyi acik tut; komut satirindan calistirildiysa bekleme.
if defined INTERACTIVE (
  echo.
  pause
)
goto :eof

:find_python
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3" && goto :eof
python --version >nul 2>&1 && set "PY=python" && goto :eof
for %%V in (313 312 311 310) do if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" (
  set PY="%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
  goto :eof
)
goto :eof

:find_ollama
set "OLLAMA="
for /f "delims=" %%P in ('where ollama 2^>nul') do if not defined OLLAMA set "OLLAMA=%%P"
if not defined OLLAMA if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
goto :eof

:port_busy
rem BUSY=1 ise verilen TCP portunda dinleyen bir program var.
set "BUSY="
netstat -ano -p tcp | findstr /c:":%~1 " | findstr /c:"LISTENING" >nul && set "BUSY=1"
goto :eof

:open_browser
rem Sunucu yanit verene kadar bekler (en fazla 60 sn), sonra tarayiciyi acar.
for /l %%i in (1,1,60) do (
  curl -s -f "%APP_URL%/api/config" >nul 2>&1 && (
    start "" "%APP_URL%"
    exit /b 0
  )
  ping -n 2 127.0.0.1 >nul
)
exit /b 0

rem ================================================================ hatalar

:no_port
echo.
echo HATA: %PICODE_PORT% ile %LAST_PORT% arasinda bos port bulunamadi.
echo       Baska bir port deneyin:  set PICODE_PORT=9000  ve ardindan RUN.bat
call :hold
exit /b 1

:no_python
echo.
echo HATA: Python 3.10 veya ustu bulunamadi ve otomatik kurulamadi.
echo       https://www.python.org/downloads/ adresinden kurun, ardindan RUN.bat'i tekrar calistirin.
echo       Python yeni kurulduysa bu pencereyi kapatip RUN.bat'i bir kez daha calistirin.
call :hold
exit /b 1

:old_python
echo.
echo HATA: Python surumu cok eski. PiCODE Python 3.10 veya ustunu gerektirir.
call :hold
exit /b 1

:fail_venv
echo.
echo HATA: .venv sanal ortami olusturulamadi.
call :hold
exit /b 1

:fail_pip
echo.
echo HATA: Python paketleri kurulamadi. Internet baglantinizi kontrol edin.
call :hold
exit /b 1

:no_ollama
echo       UYARI: Ollama kurulamadi. https://ollama.com/download adresinden kurabilirsiniz.
echo       Site yine acilir; yapay zeka analizi yerine demo modunu kullanabilirsiniz.
goto start_app
