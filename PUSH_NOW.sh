#!/bin/bash

# ⚠️ HISTORICAL SCRIPT — December 2025; the push described below already happened.
# The real remote is https://github.com/RealDealCPA-VR/Open-Source-QB.git and the
# repo now has ~766 tracked files (not the 16 mentioned below).
# The app shipped as an offline Electron + PGlite desktop application, not the
# cloud SaaS described in these docs. See README.md, INSTALL.md, and TODO.md.

# BookKeeper AI - Push to GitHub Script
# This script will help you push your repository to GitHub

echo "=========================================="
echo "  BookKeeper AI - GitHub Push Helper"
echo "=========================================="
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Not in bookkeeper-ai directory"
    echo "Please run: cd /workspace/bookkeeper-ai"
    exit 1
fi

echo "✅ Repository is ready to push!"
echo ""
echo "📦 What's included:"
echo "   - 16 files committed"
echo "   - Complete database schema"
echo "   - 6 documentation files"
echo "   - Production-ready configuration"
echo ""

# Get GitHub username
echo "Please enter your GitHub username:"
read -r GITHUB_USERNAME

if [ -z "$GITHUB_USERNAME" ]; then
    echo "❌ Error: GitHub username is required"
    exit 1
fi

REPO_NAME="bookkeeper-ai"
REPO_URL="https://github.com/$GITHUB_USERNAME/$REPO_NAME.git"

echo ""
echo "=========================================="
echo "  Step 1: Create Repository on GitHub"
echo "=========================================="
echo ""
echo "Please go to: https://github.com/new"
echo ""
echo "Repository settings:"
echo "  - Name: $REPO_NAME"
echo "  - Description: White-label QuickBooks alternative with QBO support and LLM error correction"
echo "  - Visibility: Public or Private (your choice)"
echo "  - ❌ DO NOT initialize with README, .gitignore, or license"
echo ""
echo "Press Enter after you've created the repository..."
read -r

echo ""
echo "=========================================="
echo "  Step 2: Pushing to GitHub"
echo "=========================================="
echo ""

# Add remote
echo "Adding GitHub remote..."
git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"

# Rename branch to main
echo "Renaming branch to main..."
git branch -M main

# Push to GitHub
echo "Pushing to GitHub..."
echo ""
git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "  ✅ SUCCESS!"
    echo "=========================================="
    echo ""
    echo "Your repository is now on GitHub!"
    echo ""
    echo "🔗 View it at: https://github.com/$GITHUB_USERNAME/$REPO_NAME"
    echo ""
    echo "Next steps:"
    echo "  1. Review the README.md on GitHub"
    echo "  2. Set up your database (see GETTING_STARTED.md)"
    echo "  3. Follow IMPLEMENTATION_GUIDE.md to complete the app"
    echo ""
else
    echo ""
    echo "=========================================="
    echo "  ⚠️  Push Failed"
    echo "=========================================="
    echo ""
    echo "Common issues:"
    echo "  1. Authentication required - use a Personal Access Token"
    echo "  2. Repository doesn't exist - create it first at https://github.com/new"
    echo "  3. Permission denied - check your GitHub credentials"
    echo ""
    echo "Manual push command:"
    echo "  git remote add origin $REPO_URL"
    echo "  git branch -M main"
    echo "  git push -u origin main"
    echo ""
fi
