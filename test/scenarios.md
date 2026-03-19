# Dashboard Demo Scenarios

## Scenario 1: Command Center — Create a Plan
**Action:** Open Command Center, type "Create a plan to add user authentication with OAuth2 and role-based access control"
**Expected:**
- CC panel opens with chat interface
- Plan work item created (type: plan, status: pending)
- Plan appears in Work Items section
- User can later execute plan-to-prd from Plans tab

## Scenario 2: One-Off Work Items
**Action:** Create, retry, and delete work items
**Steps:**
1. Click "Add Work" or use CC to add a work item: "Fix login page CSS on mobile"
2. Show item appears in Work Items table (status: pending)
3. Manually set one to failed, then click Retry — status resets to pending
4. Delete an item — removed from table
**Expected:** Full CRUD lifecycle visible in the UI

## Scenario 3: Plan Doc Chat & Steering
**Action:** Open a plan in Plans tab, use Doc Chat to discuss and steer
**Steps:**
1. Navigate to Plans tab
2. Click on a plan card to open it
3. Use the chat/discuss modal to ask "What are the security implications of this plan?"
4. Steer: "Add rate limiting to the API endpoints section"
**Expected:** Chat responses appear, plan content can be discussed inline

## Scenario 4: Plan Approval & Execution
**Action:** Approve a plan and execute it
**Steps:**
1. View a plan with status "Awaiting Approval"
2. Click "Approve" button
3. Click "Execute" to queue plan-to-prd conversion
4. Show PRD items appearing in PRD Progress section
**Expected:** Plan status changes, work items materialize after PRD generation

## Scenario 5: Dashboard Overview
**Action:** Tour the main dashboard panels
**Steps:**
1. Show agent cards (5 agents with status indicators)
2. Show dispatch queue (pending/active/completed)
3. Show work items table (sorted by status)
4. Show PRD progress section (dependency graph)
5. Show token usage and metrics
**Expected:** All panels render with data, responsive layout

## Scenario 6: Agent Detail View
**Action:** Click an agent card to view details
**Steps:**
1. Click on Ripley's agent card
2. Show charter, history, recent dispatches
3. Show live output panel
4. Close modal
**Expected:** Detail modal opens with complete agent info

## Scenario 7: Knowledge Base & Inbox
**Action:** Browse KB and manage inbox
**Steps:**
1. Navigate to Knowledge Base section
2. Browse category tabs (architecture, conventions, etc.)
3. View an entry
4. Navigate to Inbox section
5. View a note, promote to KB
**Expected:** KB tabs work, promotion moves file to correct category
