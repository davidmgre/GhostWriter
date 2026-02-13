#!/bin/bash
# GhostWriter - Start Script
# Runs both the backend API server and the frontend dev server

cd "$(dirname "$0")"

echo "GhostWriter"
echo "==========="

# Kill any existing processes on our ports
lsof -ti:3888 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

# Start the backend API server
echo "Starting API server on port 3888..."
node server.mjs &
API_PID=$!

# Start the Vite dev server
echo "Starting frontend dev server on port 5173..."
npx vite --port 5173 &
VITE_PID=$!

echo ""
echo "GhostWriter is running!"
echo "   Frontend: http://localhost:5173"
echo "   API:      http://localhost:3888"
echo ""
echo "Press Ctrl+C to stop both servers."

# Trap Ctrl+C to kill both processes
trap "kill $API_PID $VITE_PID 2>/dev/null; exit 0" INT TERM
wait
