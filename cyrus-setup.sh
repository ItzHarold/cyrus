#!/bin/bash

# Dynamic port selection based on Linear issue ID
# Extracts numeric ID from LINEAR_ISSUE_IDENTIFIER (e.g., PACK-293 -> 293)
ID=$(echo "$LINEAR_ISSUE_IDENTIFIER" | grep -oE '[0-9]+')
BASE=30100
SLOT=$((ID % 100))
CYRUS_SERVER_PORT=$((BASE + SLOT))

# Export the dynamically selected port
export CYRUS_SERVER_PORT=$CYRUS_SERVER_PORT

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    touch .env
fi

# Add or update the port in .env file
if grep -q "^CYRUS_SERVER_PORT=" .env; then
    # Update existing port
    sed -i.bak "s/^CYRUS_SERVER_PORT=.*/CYRUS_SERVER_PORT=$CYRUS_SERVER_PORT/" .env
    rm .env.bak 2>/dev/null
else
    # Add new port
    echo "CYRUS_SERVER_PORT=$CYRUS_SERVER_PORT" >> .env
fi

# NOTE: a `cp /Users/<upstream-dev>/code/cyrus/CLAUDE.local.md` line lived here.
# It was an upstream developer's macOS home directory and has never existed on
# any box of ours, so it failed on every worktree of this repo and was ignored.
# Carrying gitignored files into a worktree is what `.worktreeinclude` is for —
# see PON-141, which adds it rather than guessing at an absolute path to a file
# that lives outside the worktree.
