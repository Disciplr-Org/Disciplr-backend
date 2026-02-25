#!/bin/bash

# Disciplr Transaction History System Setup Script

echo "🚀 Setting up Disciplr Transaction History System..."

# Check if PostgreSQL is installed
if ! command -v psql &> /dev/null; then
    echo "❌ PostgreSQL is not installed. Please install PostgreSQL first."
    echo "   Visit: https://www.postgresql.org/download/"
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

echo "✅ Prerequisites check passed"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Setup environment file
if [ ! -f .env ]; then
    echo "⚙️  Setting up environment configuration..."
    cp env.example .env
    echo "📝 Please edit .env file with your database and Stellar configuration"
    echo "   Required: DATABASE_URL, STELLAR_HORIZON_URL, STELLAR_DISCIPLR_ACCOUNT"
else
    echo "✅ Environment file already exists"
fi

# Setup database
echo "🗄️  Setting up database..."
read -p "Enter PostgreSQL database name (default: disciplr): " dbname
dbname=${dbname:-disciplr}

read -p "Enter PostgreSQL username (default: postgres): " dbuser
dbuser=${dbuser:-postgres}

# Create database if it doesn't exist
echo "Creating database '$dbname'..."
createdb -U "$dbuser" "$dbname" 2>/dev/null || echo "Database may already exist"

# Run migration
echo "Running database migration..."
psql -U "$dbuser" -d "$dbname" -f migrations/001_create_transactions_table.sql

if [ $? -eq 0 ]; then
    echo "✅ Database setup completed"
else
    echo "❌ Database migration failed. Please check your database configuration."
    exit 1
fi

# Build the project
echo "🔨 Building TypeScript project..."
npm run build

if [ $? -eq 0 ]; then
    echo "✅ Build completed successfully"
else
    echo "❌ Build failed. Please check the TypeScript errors."
    exit 1
fi

echo ""
echo "🎉 Setup completed successfully!"
echo ""
echo "Next steps:"
echo "1. Edit .env file with your configuration"
echo "2. Start the development server: npm run dev"
echo "3. Run tests: npm test"
echo "4. Visit http://localhost:3000/api/health to verify the service"
echo ""
echo "API Documentation:"
echo "- Transaction History: /api/transactions"
echo "- Health Check: /api/health"
echo "- Vault Operations: /api/vaults"
echo ""
echo "For detailed documentation, see TRANSACTION_SYSTEM.md"
