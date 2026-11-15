@echo off
rem Elontopbot: OLX arzon e'lonlar boti. Oynani yopsangiz, bot to'xtaydi.
cd /d C:\Users\ziyo\Elontopbot
set /p BOT_TOKEN=<bot-token.txt
:loop
node bot.mjs
echo Bot to'xtadi, 10 soniyadan keyin qayta ishga tushadi...
timeout /t 10 /nobreak >nul
goto loop
