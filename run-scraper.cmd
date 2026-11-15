@echo off
rem Elontopbot OLX skaneri: Windows Task Scheduler shu faylni ishga tushiradi
cd /d C:\Users\ziyo\Elontopbot
set CHANNEL_ID=-1002824123374
set /p BOT_TOKEN=<bot-token.txt
echo ===== %date% %time% =====>> scraper.log
node scraper.mjs >> scraper.log 2>&1
