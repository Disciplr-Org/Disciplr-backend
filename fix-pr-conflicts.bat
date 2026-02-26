@echo off
REM GitHub PR Conflict Resolution Script for Windows

echo 🔧 GitHub PR Conflict Resolution
echo =================================

echo Current state:
for /f %%i in ('git branch --show-current') do echo Branch: %%i
for /f %%i in ('git log -1 --oneline') do echo Latest commit: %%i

echo.
echo Checking for potential conflicts...

REM Check if we can identify the PR target branch
echo Remote branches:
git branch -r

echo.
echo 📋 Steps to resolve GitHub PR conflicts:
echo 1. Close the current PR on GitHub
echo 2. Create a new branch for your changes  
echo 3. Push and create a new PR

echo.
echo 🚀 Creating fresh branch for PR...

REM Create a new branch for the PR
set TIMESTAMP=%date:~-4%%date:~-7,2%%date:~-10,2%%time:~-11,2%%time:~-9,2%%time:~-7,2%
set TIMESTAMP=%TIMESTAMP: =0%
set BRANCH_NAME=pr/transaction-history-%TIMESTAMP%

git checkout -b %BRANCH_NAME%

echo ✅ Created new branch: %BRANCH_NAME%
echo.
echo 📤 Pushing new branch to GitHub...

git push -u origin %BRANCH_NAME%

echo.
echo ✅ Ready for new PR!
echo ====================
echo 1. Go to GitHub and create a new PR from branch: %BRANCH_NAME%
echo 2. The new PR should not have conflicts
echo 3. If conflicts still appear, they can be resolved on GitHub

echo.
echo 🔗 GitHub URL: https://github.com/1sraeliteX/Disciplr-backend/compare/main...%BRANCH_NAME%
pause
