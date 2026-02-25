@echo off
REM Disciplr Transaction History System Setup Script for Windows

echo 🚀 Setting up Disciplr Transaction History System...

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed. Please install Node.js first.
    echo    Visit: https://nodejs.org/
    pause
    exit /b 1
)

REM Check if PostgreSQL is installed
where psql >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ PostgreSQL is not installed. Please install PostgreSQL first.
    echo    Visit: https://www.postgresql.org/download/windows/
    pause
    exit /b 1
)

echo ✅ Prerequisites check passed

REM Install dependencies
echo 📦 Installing dependencies...
call npm install

REM Setup environment file
if not exist .env (
    echo ⚙️  Setting up environment configuration...
    copy env.example .env
    echo 📝 Please edit .env file with your database and Stellar configuration
    echo    Required: DATABASE_URL, STELLAR_HORIZON_URL, STELLAR_DISCIPLR_ACCOUNT
) else (
    echo ✅ Environment file already exists
)

REM Setup database
echo 🗄️  Setting up database...
set /p dbname="Enter PostgreSQL database name (default: disciplr): "
if "%dbname%"=="" set dbname=disciplr

set /p dbuser="Enter PostgreSQL username (default: postgres): "
if "%dbuser%"=="" set dbuser=postgres

REM Create database if it doesn't exist
echo Creating database '%dbname%'...
createdb -U %dbuser% %dbname% 2>nul || echo Database may already exist

REM Run migration
echo Running database migration...
psql -U %dbuser% -d %dbname% -f migrations/001_create_transactions_table.sql

if %errorlevel% equ 0 (
    echo ✅ Database setup completed
) else (
    echo ❌ Database migration failed. Please check your database configuration.
    pause
    exit /b 1
)

REM Build the project
echo 🔨 Building TypeScript project...
call npm run build

if %errorlevel% equ 0 (
    echo ✅ Build completed successfully
) else (
    echo ❌ Build failed. Please check the TypeScript errors.
    pause
    exit /b 1
)

echo.
echo 🎉 Setup completed successfully!
echo.
echo Next steps:
echo 1. Edit .env file with your configuration
echo 2. Start the development server: npm run dev
echo 3. Run tests: npm test
echo 4. Visit http://localhost:3000/api/health to verify the service
echo.
echo API Documentation:
echo - Transaction History: /api/transactions
echo - Health Check: /api/health
echo - Vault Operations: /api/vaults
echo.
echo For detailed documentation, see TRANSACTION_SYSTEM.md
pause
