#!/bin/bash

echo "=== AI Arena Setup ==="

# Check Node.js
if ! command -v node &> /dev/null; then
  echo ""
  echo "Node.js not found!"
  echo "Install LTS from: https://nodejs.org"
  echo "Then reopen Cursor."
  exit 1
fi

echo "Node.js $(node -v) found"

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
else
  echo "Dependencies already installed"
fi

# Check .env
if [ ! -f ".env" ]; then
  echo ""
  echo "WARNING: .env file missing! Create it with:"
  echo "  ANTHROPIC_API_KEY=..."
  echo "  OPENAI_API_KEY=..."
  echo "  GOOGLE_API_KEY=..."
  echo "  APP_PASSWORD=..."
else
  echo ".env found"
fi

echo ""
echo "Ready! Run: npm start"
