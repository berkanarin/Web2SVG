@echo off
setlocal
title Web2SVG Server

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0scripts\launch.ps1"
