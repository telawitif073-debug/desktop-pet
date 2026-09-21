@echo off
rem 双击一键启动平台（PostgreSQL + 后端 3001 + 前端 5174）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-platform.ps1"
pause
