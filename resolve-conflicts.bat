@echo off
REM Merge Conflict Resolution Script for Disciplr Backend (Windows)

echo 🔧 Disciplr Backend - Merge Conflict Resolution
echo ==============================================

REM Check if we're in a merge or rebase state
if exist .git\MERGE_HEAD (
    echo 📋 Currently in merge state
    set MERGE_MODE=merge
) else if exist .git\REBASE_HEAD (
    echo 📋 Currently in rebase state
    set MERGE_MODE=rebase
) else (
    echo ℹ️  No merge/rebase in progress. Checking for conflict markers...
    set MERGE_MODE=check
)

echo.
echo 📂 Checking common conflict files...

REM Check for conflicts in README.md
echo 🔍 Checking README.md...
if exist README.md (
    findstr /C:"<<<<<<< " README.md >nul 2>&1
    if !errorlevel! equ 0 (
        echo ⚠️  Conflict markers found in README.md
        echo 📝 Manual resolution needed - please edit the file
    ) else (
        echo ✅ No conflicts in README.md
    )
) else (
    echo ℹ️  File README.md does not exist
)

REM Check for conflicts in package.json
echo 🔍 Checking package.json...
if exist package.json (
    findstr /C:"<<<<<<< " package.json >nul 2>&1
    if !errorlevel! equ 0 (
        echo ⚠️  Conflict markers found in package.json
        echo 📝 Manual resolution needed - please edit the file
    ) else (
        echo ✅ No conflicts in package.json
    )
) else (
    echo ℹ️  File package.json does not exist
)

REM Check for conflicts in package-lock.json
echo 🔍 Checking package-lock.json...
if exist package-lock.json (
    findstr /C:"<<<<<<< " package-lock.json >nul 2>&1
    if !errorlevel! equ 0 (
        echo ⚠️  Conflict markers found in package-lock.json
        echo 💡 Tip: Often safe to regenerate with "npm install"
        echo 📝 Manual resolution needed - please edit the file
    ) else (
        echo ✅ No conflicts in package-lock.json
    )
) else (
    echo ℹ️  File package-lock.json does not exist
)

REM Check for conflicts in src/index.ts
echo 🔍 Checking src\index.ts...
if exist src\index.ts (
    findstr /C:"<<<<<<< " src\index.ts >nul 2>&1
    if !errorlevel! equ 0 (
        echo ⚠️  Conflict markers found in src\index.ts
        echo 📝 Manual resolution needed - please edit the file
    ) else (
        echo ✅ No conflicts in src\index.ts
    )
) else (
    echo ℹ️  File src\index.ts does not exist
)

REM Check for conflicts in src/routes/transactions.ts
echo 🔍 Checking src\routes\transactions.ts...
if exist src\routes\transactions.ts (
    findstr /C:"<<<<<<< " src\routes\transactions.ts >nul 2>&1
    if !errorlevel! equ 0 (
        echo ⚠️  Conflict markers found in src\routes\transactions.ts
        echo 📝 Manual resolution needed - please edit the file
    ) else (
        echo ✅ No conflicts in src\routes\transactions.ts
    )
) else (
    echo ℹ️  File src\routes\transactions.ts does not exist
)

echo.
echo 📊 Conflict Resolution Summary:
echo ==============================

REM Show current git status
git status --porcelain

echo.
echo 🎯 Next Steps:
echo =============

if "%MERGE_MODE%"=="merge" (
    echo 1. Review any remaining conflicts manually
    echo 2. Stage resolved files: git add ^<file^>
    echo 3. Continue the merge: git commit
) else if "%MERGE_MODE%"=="rebase" (
    echo 1. Review any remaining conflicts manually  
    echo 2. Stage resolved files: git add ^<file^>
    echo 3. Continue the rebase: git rebase --continue
) else (
    echo 1. If you see conflicts above, resolve them manually
    echo 2. Stage resolved files: git add ^<file^>
    echo 3. Commit your changes: git commit -m "Resolve merge conflicts"
)

echo.
echo 💡 Tips for resolving conflicts:
echo - Use VS Code's merge conflict editor (Ctrl+Shift+P > "Merge Conflict")
echo - Use "git diff" to see conflicts in terminal
echo - Use "git checkout --ours/theirs ^<file^>" to pick versions
echo - Remove ^<<<<<<<, ^=======, ^>>>>>>> markers manually
echo.
echo 🔧 For package-lock.json conflicts, consider: "npm install" to regenerate

echo.
echo ✨ Conflict resolution helper completed!
pause
