#!/bin/bash
clear
echo "=== Interouter — @decision3/interouter-core ==="
sleep 2
echo ""
node --version && npm --version
sleep 2
echo ""
cat packages/interouter-core/package.json | grep -E '"name"|"version"|"license"'
sleep 2
echo ""
cd packages/interouter-core && npm test 2>&1 | tail -20
sleep 2
echo ""
cd ../..
echo "Interouter v0.1.6 — MIT — github.com/decision3-ai/interouter"
