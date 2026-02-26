#!/bin/bash

# Merge Conflict Resolution Script for Disciplr Backend
# This script helps resolve common merge conflicts in the transaction system

echo "🔧 Disciplr Backend - Merge Conflict Resolution"
echo "=============================================="

# Check if we're in a merge or rebase state
if [ -f .git/MERGE_HEAD ]; then
    echo "📋 Currently in merge state"
    MERGE_MODE="merge"
elif [ -f .git/REBASE_HEAD ]; then
    echo "📋 Currently in rebase state"
    MERGE_MODE="rebase"
else
    echo "ℹ️  No merge/rebase in progress. Checking for conflict markers..."
    MERGE_MODE="check"
fi

# Function to check and resolve conflicts in a file
resolve_conflicts() {
    local file=$1
    local strategy=$2
    
    echo "🔍 Checking $file..."
    
    if [ -f "$file" ]; then
        # Check for conflict markers
        if grep -q "<<<<<<< \|======= \|>>>>>>>" "$file"; then
            echo "⚠️  Conflict markers found in $file"
            
            case $strategy in
                "ours")
                    echo "📝 Keeping our version of $file"
                    git checkout --ours "$file"
                    git add "$file"
                    ;;
                "theirs")
                    echo "📝 Keeping their version of $file"
                    git checkout --theirs "$file"
                    git add "$file"
                    ;;
                "manual")
                    echo "📝 Manual resolution needed for $file"
                    echo "   Please edit the file to remove conflict markers"
                    ;;
            esac
        else
            echo "✅ No conflicts in $file"
        fi
    else
        echo "ℹ️  File $file does not exist"
    fi
}

# Files that commonly have conflicts
CONFLICT_FILES=(
    "README.md"
    "package-lock.json" 
    "package.json"
    "src/index.ts"
    "src/routes/transactions.ts"
)

# Strategy for resolving conflicts
# Options: "ours", "theirs", "manual"
STRATEGY="manual"

echo ""
echo "📂 Checking common conflict files..."

for file in "${CONFLICT_FILES[@]}"; do
    resolve_conflicts "$file" "$STRATEGY"
done

echo ""
echo "📊 Conflict Resolution Summary:"
echo "=============================="

# Show current git status
git status --porcelain

echo ""
echo "🎯 Next Steps:"
echo "============="

if [ "$MERGE_MODE" = "merge" ] || [ "$MERGE_MODE" = "rebase" ]; then
    echo "1. Review any remaining conflicts manually"
    echo "2. Stage resolved files: git add <file>"
    echo "3. Continue the process:"
    
    if [ "$MERGE_MODE" = "merge" ]; then
        echo "   git commit"
    else
        echo "   git rebase --continue"
    fi
else
    echo "1. If you see conflicts above, resolve them manually"
    echo "2. Stage resolved files: git add <file>"
    echo "3. Commit your changes: git commit -m 'Resolve merge conflicts'"
fi

echo ""
echo "💡 Tips for resolving conflicts:"
echo "- Use VS Code's merge conflict editor"
echo '- Run "git diff" to see conflicts'
echo '- Use "git checkout --ours/theirs <file>" to pick versions'
echo '- Remove <<<<<<<, =======, >>>>>>> markers manually'

echo ""
echo "✨ Conflict resolution helper completed!"
