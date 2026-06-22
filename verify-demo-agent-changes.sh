#!/bin/bash
# Verification script for demo agent identification feature

echo "🔍 Demo Agent Implementation Verification"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check function
check_file() {
    local file=$1
    local search=$2
    local description=$3
    
    if [ ! -f "$file" ]; then
        echo -e "${RED}✗${NC} File not found: $file"
        return 1
    fi
    
    if grep -q "$search" "$file"; then
        echo -e "${GREEN}✓${NC} $description"
        return 0
    else
        echo -e "${RED}✗${NC} $description"
        return 1
    fi
}

echo "📋 Checking Contract Changes..."
check_file "contract/agents/src/lib.rs" "pub is_demo: bool" "AgentEntry has is_demo field"
check_file "contract/agents/src/lib.rs" "is_demo: bool," "register_agent accepts is_demo parameter"

echo ""
echo "📋 Checking Backend Changes..."
check_file "backend/src/lib/contract.js" "isDemo = false" "registerAgentOnChain has isDemo parameter"
check_file "backend/src/lib/contract.js" "is_demo: raw.is_demo" "mapAgent includes is_demo field"
check_file "backend/scripts/seed-agents.js" "registerAgentOnChain(address, agent.name, agent.description, true)" "seed-agents marks agents as demo"
check_file "backend/scripts/boost-scores.js" "--mainnet-confirm" "boost-scores has mainnet guard"
check_file "backend/src/routes/agents.js" "exclude_demo" "agents route has exclude_demo filter"

echo ""
echo "📋 Checking Frontend Changes..."
check_file "frontend/lib/types.ts" "is_demo: boolean" "AgentEntry type has is_demo field"
check_file "frontend/lib/contract.ts" "excludeDemo" "fetchAgents has excludeDemo parameter"
check_file "frontend/app/agents/page.tsx" "excludeDemo" "agents page has excludeDemo state"
check_file "frontend/components/AgentCard.tsx" "Demo" "AgentCard shows demo badge"

echo ""
echo "📋 Checking Test Changes..."
check_file "backend/src/routes/agents.test.js" "is_demo: false" "Test helper includes is_demo field"
check_file "backend/src/routes/agents.test.js" "exclude_demo" "Tests cover exclude_demo parameter"

echo ""
echo "=========================================="
echo "✨ Verification complete!"
echo ""
echo "Next steps:"
echo "1. cd backend && npm install"
echo "2. npm test"
echo "3. cd ../contract/agents && cargo build --release --target wasm32-unknown-unknown"
echo "4. Deploy updated contract"
echo "5. Run seed-agents.js to populate demo agents"
echo "6. Test the frontend"
