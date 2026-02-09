# CodeMap AI

**Call graph analyzer for understanding code impact and execution flows - built for Claude Code**

Stop guessing what breaks when you change code. CodeMap builds a complete call graph so Claude can answer "what depends on this?" with surgical precision.

## Features

- 🔍 **Call Graph Analysis** - Trace every function call across your entire codebase
- 🎯 **Impact Analysis** - Know exactly what breaks before you change code
- 🔄 **Data Flow Analysis** - Track property accesses and detect breaking data shape changes (NEW in v3.5)
- 🔗 **Cross-File Resolution** - Follows imports and tracks dependencies (90%+ accuracy)
- 🚀 **FastAPI Support** - Detects HTTP endpoints and dependency injection
- 💾 **Incremental Updates** - Only re-indexes changed files (git-aware)
- 🤖 **Claude Code Integration** - MCP server for AI-powered code queries

### New in v3.5.0: Data Flow Analysis

CodeMap now tracks **property accesses** and **return shapes** to detect breaking changes:

```python
# Developer changes this:
def get_user():
    return {"id": 1, "name": "John", "email": "john@example.com"}

# To this:
def get_user():
    return {"id": 1, "name": "John"}  # email removed!

# CodeMap detects:
# 🔴 CRITICAL: email accessed but no longer returned:
#    • send_welcome_email() - line 78
#    • validate_user_data() - line 120
#    Impact: 15 functions will break
```

**Phase 3 captures:**
- Property accesses (`user.email`, `config.database.host`)
- Return shapes (object structures)
- Breaking change detection (removed properties, type changes)
- Severity scoring (CRITICAL for id/email/token/auth)

## Installation

```bash
# Use directly with npx (recommended)
npx codemap-ai init

# Or install globally
npm install -g codemap-ai
```

## Quick Start (3 Commands)

```bash
# 1. First time: Initialize (indexes + configures Claude Code)
npx codemap-ai init

# 2. Before PR: Check impact of your changes
npx codemap-ai impact

# 3. After major refactor: Force re-index
npx codemap-ai reindex
```

That's it! Now ask Claude questions like:
- "What would break if I change authenticate_user?"
- "Show me the flow from checkout endpoint to database"
- "What functions call get_user_permissions?"

## Commands

### `codemap init` - First-Time Setup

Initialize CodeMap in your project (one command does everything):

```bash
cd /path/to/project
npx codemap-ai init
```

**What it does:**
1. Indexes your entire codebase
2. Automatically configures MCP server in Claude Code
3. Ready to ask questions!

**Output:**
```
✓ Indexed 120 files (1,450 calls resolved)
✓ MCP server configured in Claude Code
✓ Ready! Ask Claude: 'What would break if I change authenticate_user?'
```

**Options:**
- `--skip-mcp` - Skip MCP server configuration
- `--include <patterns>` - File patterns to include
- `--exclude <patterns>` - File patterns to exclude

---

### `codemap impact` - Check What Changed

Analyze the impact of your uncommitted changes (smart git integration):

```bash
# After editing files
npx codemap-ai impact
```

**What it does:**
1. Detects modified files (uses `git diff` if available)
2. Finds which functions changed
3. Re-indexes only changed files (fast!)
4. Shows callers, affected endpoints, risk level

**Output:**
```
✔ Detected 2 modified files

Modified Files:
  • checkout.py
  • authentication.py

Changed Functions:
  • handle_checkout (checkout.py:47)
  • authenticate_user (authentication.py:120)

Impact Analysis:
  handle_checkout:
    12 direct callers
  authenticate_user:
    25 direct callers ⚠️

Affected HTTP Endpoints:
  • POST /api/checkout
  • POST /api/orders

Risk Assessment:
  HIGH - 37 functions affected
```

**Options:**
- `-v, --verbose` - Show detailed caller information

**Use cases:**
- Before creating a PR
- After refactoring
- When debugging regressions

---

### `codemap visualize` - Interactive Impact Visualization ✨ NEW in v3.7

Visualize impact analysis in a modern, interactive web interface:

```bash
npx codemap-ai visualize
```

**What it does:**
1. Analyzes impact of your changes
2. Starts a local web server (port 37421)
3. Opens browser with interactive graph visualization
4. Shows call chains, severity levels, and affected functions

**Features:**
- 🎨 **Modern Dark UI** - Professional dark theme with shadcn components
- 📊 **Interactive Graph** - Powered by React Flow with smooth animations
- 🔍 **Zoom & Pan** - Explore complex call graphs intuitively
- 💎 **Visual Severity Levels** - Color-coded nodes (Red=CRITICAL, Orange=HIGH, Blue=MEDIUM/LOW)
- 📝 **Detailed Popups** - Click any node for caller/callee information in a clean modal
- 🌳 **Smart Layout** - Hierarchical top-to-bottom flow using Dagre algorithm
- 📂 **Organized Sidebar** - Browse affected files and functions with severity indicators
- 🎯 **Changed Functions** - Modified functions clearly marked with badges

**Perfect for:**
- Understanding complex impact chains
- PR reviews and demos
- Identifying critical paths before refactoring
- Sharing impact visualizations with team
- Visualizing execution flows at a glance

---

### `codemap reindex` - Force Full Rebuild

Force re-index everything from scratch:

```bash
npx codemap-ai reindex
```

**When to use:**
- After pulling major changes
- After changing many files
- When you want to rebuild the entire graph

---

## Claude Code Integration (MCP Tools)

Once you run `codemap init`, Claude gains these capabilities via MCP:

### 1. `codemap_impact` - Analyze Change Impact

**Ask Claude:**
> "If I change authenticate_user, what breaks?"

**Claude uses:** `codemap_impact` tool

**Returns:**
- Direct callers (functions that call it)
- Total impact (affected functions/files)
- Risk level (LOW/MEDIUM/HIGH)
- Recommendations

**Example response:**
```
Impact Analysis: authenticate_user

Location: authentication.py:120
Risk Level: HIGH

Direct Callers (25):
- handle_checkout in checkout.py:47
- handle_order in orders.py:85
- get_settings in settings.py:120
...

Total Impact:
- Affected functions: 45
- Affected files: 15

⚠️ Recommendation: High-risk change. Review all callers before modifying.
```

---

### 2. `codemap_trace_flow` - Trace Execution Paths

**Ask Claude:**
> "Show me the flow from checkout endpoint to database"

**Claude uses:** `codemap_trace_flow` tool

**Returns:**
- Complete call path from source to target
- File locations for each step
- Total steps in the flow

**Example response:**
```
Execution Flow: handle_checkout → save_order

1. handle_checkout
   File: checkout.py:47
   ↓ calls

2. authenticate_user
   File: authentication.py:120
   ↓ calls

3. OrderHandler.save_order
   File: handlers/orders.py:200
   ↓ calls

4. db.orders.insert_one
   File: external

Total steps: 4
```

---

### 3. `codemap_callers` - Find Who Calls a Function

**Ask Claude:**
> "What functions call get_user_permissions?"

**Claude uses:** `codemap_callers` tool

**Returns:**
- All functions that call the target
- File locations with line numbers
- Function types (function, method, etc.)

**Example response:**
```
Callers of get_user_permissions

Total callers: 12

Who Calls This Function:
- handle_checkout (function)
  File: checkout.py:47

- handle_order (function)
  File: orders.py:85

- verify_access (function)
  File: auth.py:150
...
```

---

## Supported Languages

| Language   | Parsing | Imports | Calls | Classes | Methods | Inheritance |
|------------|---------|---------|-------|---------|---------|-------------|
| Python     | ✅      | ✅      | ✅    | ✅      | ✅      | ✅          |
| TypeScript | ✅      | ✅      | ✅    | ✅      | ✅      | ✅          |
| JavaScript | ✅      | ✅      | ✅    | ✅      | ✅      | ✅          |

## Framework Detection

**FastAPI** (Python):
- HTTP route decorators: `@router.post("/orders")`
- Dependency injection: `Depends(get_user)`
- Request handlers and middleware

**Coming Soon:**
- Django views and models
- Express.js routes
- React component hierarchy

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│  Step 1: codemap init                                        │
│  • Parse all files with Tree-sitter                          │
│  • Extract: functions, classes, calls, imports              │
│  • Resolve: variable types, inheritance, cross-file refs    │
│  • Store: SQLite database (.codemap/graph.db)               │
│  • Configure: MCP server in Claude Code                     │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 2: codemap impact (before PR)                          │
│  • Detect: git diff finds changed files                      │
│  • Parse: extract changed function names                     │
│  • Re-index: only modified files (fast!)                     │
│  • Calculate: who calls changed functions                    │
│  • Report: risk level + affected files                       │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 3: Ask Claude (via MCP)                                │
│  • Claude calls: codemap_impact / codemap_trace_flow         │
│  • Returns: markdown with analysis                           │
│  • You decide: safe to merge or need more testing            │
└──────────────────────────────────────────────────────────────┘
```

## Real-World Workflows

### Workflow 1: Before Refactoring

```bash
# Scenario: Need to change authenticate_user() signature

# Step 1: Check current state
npx codemap-ai init

# Step 2: Ask Claude
# "Show me all functions that call authenticate_user"
# Claude uses codemap_callers → Shows 25 callers

# Step 3: Make changes
vim authentication.py

# Step 4: Check impact
npx codemap-ai impact
# → HIGH risk: 25 functions affected

# Step 5: Ask Claude for help
# "Review the impact of my authentication changes"
# Claude analyzes and suggests testing strategy
```

---

### Workflow 2: Understanding Legacy Code

```bash
# Scenario: New to codebase, need to understand payment flow

# Step 1: Initialize
npx codemap-ai init

# Step 2: Ask Claude
# "How does payment processing work from API to database?"
# Claude uses codemap_trace_flow → Shows complete path

# Step 3: Deep dive
# "What calls process_payment?"
# Claude uses codemap_callers → Shows all entry points
```

---

### Workflow 3: Pre-PR Safety Check

```bash
# Scenario: Made changes to 10 files, need PR review

# Step 1: Already initialized (ran init on day 1)

# Step 2: Check impact
npx codemap-ai impact
# → Detects 10 modified files
# → Shows 3 changed functions
# → 15 callers affected
# → MEDIUM risk

# Step 3: Ask Claude
# "Analyze the impact of my changes and suggest test cases"
# Claude reviews impact report + generates test plan

# Step 4: Create PR with confidence
```

---

## Advanced Features

### Smart Git Integration

CodeMap uses `git diff` to detect exactly what changed:

```python
# Before: def authenticate_user(token: str)
# After:  def authenticate_user(token: str, role: str)  # Added parameter

# codemap impact detects:
# - Signature changed at line 120
# - 25 callers need updating
# - Risk: HIGH
```

**Fallback:** If not a git repo, uses file hash comparison.

---

### Incremental Indexing

CodeMap only re-indexes changed files:

```bash
# First run: index every file
codemap init

# Edit 2 files...

# Second run: Only index 2 files (< 1 second)
codemap impact
```

Uses SHA-256 file hashing for change detection.

---

### Variable Type Tracking

Resolves method calls through type inference:

```python
user = UserService()  # Type tracked
user.authenticate()   # ✅ Resolved to UserService.authenticate
```

---

### Super() Resolution

Follows inheritance chains:

```python
class Child(Parent):
    def method(self):
        super().method()  # ✅ Resolved to Parent.method
```

---

### Database Operation Tracking

Tracks MongoDB operations:

```python
db.users.find_one({"id": user_id})
# ✅ Tracked as: find_one on users collection
```

---

## Performance

- **Indexing Speed**: a few hundred files in seconds
- **Impact Analysis**: < 1 second (only re-indexes changed files)
- **Resolution Rate**: 25% (75% are external libraries - expected)
- **Memory Usage**: tens of MB for a few hundred files
- **Database Size**: a few MB for a few hundred files

## Configuration

CodeMap stores data in `.codemap/graph.db` (SQLite) in your project root.

**Default patterns:**
- Include: `**/*.py`, `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx`
- Exclude: `**/node_modules/**`, `**/__pycache__/**`, `**/venv/**`
- Max file size: 200KB

**Custom patterns:**
```bash
codemap init \
  --include "src/**/*.py" "lib/**/*.py" \
  --exclude "**/tests/**" "**/migrations/**"
```

## Troubleshooting

### "Not initialized" error
```bash
# Run init first
npx codemap-ai init
```

### No changes detected
```bash
# Make sure you have uncommitted changes
git status

# Or force re-index
npx codemap-ai reindex
```

### MCP not working in Claude Code
```bash
# Check if MCP is configured
cat ~/.claude/config.json

# Re-run init to reconfigure
npx codemap-ai init

# Restart Claude Code
```

### Low resolution rate
- Normal for projects with many external libraries
- Internal calls should resolve at ~90%+
- Use `codemap_callers` to verify specific functions

## Contributing

We welcome contributions focused on:
- Parser improvements for better resolution
- New language support (Go, Rust, Java)
- Framework-specific pattern detection
- Performance optimizations

## License

MIT License - see [LICENSE](LICENSE) file

## Author

Sahan Nishshanka

## Links

- NPM: https://www.npmjs.com/package/codemap-ai

---

## Why CodeMap?

**Traditional approach:**
```
Developer: "I need to change this function..."
Developer: *searches codebase manually*
Developer: *finds 10 references*
Developer: *misses 15 hidden callers*
Developer: *deploys*
💥 Production breaks
```

**With CodeMap:**
```
Developer: "I need to change this function..."
Developer: npx codemap-ai impact
Developer: "Shows 25 callers - HIGH risk"
Claude: "Here's a test plan for all affected areas"
Developer: *tests thoroughly*
Developer: *deploys with confidence*
✅ Production stable
```

**Stop breaking prod. Use CodeMap.** 🚀
