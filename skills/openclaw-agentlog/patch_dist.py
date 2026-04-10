#!/usr/bin/env python3
"""
⚠️ DEPRECATED FOR OpenClaw v4.5+ ⚠️

OpenClaw v4.5 removed the sendResetSessionNotice function and buildResetSessionNoticeText,
so this patch script no longer applies. The "New session started" message no longer exists
as a separate routeReply call.

For v4.5+, trace ID is injected via before_agent_start hook's prependContext return value,
causing the agent to naturally carry trace ID in its reply.

This script is kept for reference only and will NOT work on v4.5+ dist bundles.

---

Patch all OpenClaw dist bundle files to show "New trace started" instead of "New session started"
and include AGENTLOG_TRACE_ID in the message.

This script:
1. Finds all .js files in the dist directory
2. Only patches files containing "New session started"
3. Creates a backup before patching
4. Reports all patched files
"""

import os
import glob
import shutil
from datetime import datetime

# Configuration
DIST_DIR = "/home/hobo/.npm-global/lib/node_modules/openclaw/dist"
BACKUP_DIR = "/home/hobo/.npm-global/lib/node_modules/openclaw/dist_backup"

# Pattern to search for (the original unmodified code)
OLD_PATTERN = 'return modelLabel === defaultLabel ? `\u2705 New session started \u00b7 model: ${modelLabel}` : `\u2705 New session started \u00b7 model: ${modelLabel} (default: ${defaultLabel})`;'

# Replacement code (adds trace ID display)
NEW_CODE = '''const _agentlogTraceId = process.env.AGENTLOG_TRACE_ID;
\tconst _agentlogTraceSuffix = _agentlogTraceId ? ` \u00b7 trace: ${_agentlogTraceId}` : "";
\treturn modelLabel === defaultLabel ? `\u2705 New trace started \u00b7 model: ${modelLabel}${_agentlogTraceSuffix}` : `\u2705 New trace started \u00b7 model: ${modelLabel} (default: ${defaultLabel})${_agentlogTraceSuffix}`;'''

def create_backup_dir():
    """Create timestamped backup directory"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = f"{BACKUP_DIR}_{timestamp}"
    os.makedirs(backup_path, exist_ok=True)
    return backup_path

def patch_file(filepath, backup_dir):
    """Patch a single file"""
    filename = os.path.basename(filepath)

    # Read content
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Check if file contains the pattern
    if OLD_PATTERN not in content:
        return False, "pattern not found"

    # Create backup
    backup_path = os.path.join(backup_dir, filename)
    shutil.copy2(filepath, backup_path)

    # Apply patch
    new_content = content.replace(OLD_PATTERN, NEW_CODE, 1)

    # Write back
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)

    return True, "patched"

def main():
    print(f"OpenClaw Dist Bundle Patcher")
    print(f"=" * 50)
    print(f"Dist directory: {DIST_DIR}")
    print(f"")

    # Create backup directory
    backup_dir = create_backup_dir()
    print(f"Backup directory: {backup_dir}")
    print(f"")

    # Find all JS files
    js_files = glob.glob(os.path.join(DIST_DIR, "*.js"))
    print(f"Found {len(js_files)} .js files in dist/")
    print(f"")

    # Track results
    patched_files = []
    already_patched = []
    skipped_files = []

    for filepath in sorted(js_files):
        filename = os.path.basename(filepath)

        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()

        # Check if already patched
        if "New trace started" in content and "New session started" not in content:
            already_patched.append(filename)
            continue

        # Check if needs patching
        if OLD_PATTERN not in content:
            skipped_files.append(filename)
            continue

        # Patch the file
        success, msg = patch_file(filepath, backup_dir)
        if success:
            patched_files.append((filename, msg))
            print(f"  ✓ Patched: {filename}")
        else:
            print(f"  ✗ Skipped: {filename} ({msg})")

    # Print summary
    print(f"")
    print(f"Summary:")
    print(f"  Patched:      {len(patched_files)} files")
    print(f"  Already done: {len(already_patched)} files")
    print(f"  Skipped:      {len(skipped_files)} files")
    print(f"")
    print(f"Backup location: {backup_dir}")

    # Show files that were already patched
    if already_patched:
        print(f"")
        print(f"Already patched (no changes needed):")
        for f in sorted(already_patched):
            print(f"  - {f}")

    # Show files that were skipped (contain pattern but couldn't patch)
    if skipped_files:
        print(f"")
        print(f"Skipped files (pattern not found):")
        for f in sorted(skipped_files):
            print(f"  - {f}")

    # Verify: check if any unpatched files remain
    unpatched = []
    for filepath in glob.glob(os.path.join(DIST_DIR, "*.js")):
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        if "New session started" in content:
            unpatched.append(os.path.basename(filepath))

    if unpatched:
        print(f"")
        print(f"WARNING: {len(unpatched)} files still contain 'New session started':")
        for f in sorted(unpatched):
            print(f"  - {f}")
    else:
        print(f"")
        print(f"✓ All files successfully patched!")

    print(f"")
    print(f"Next steps:")
    print(f"  1. Restart OpenClaw gateway: systemctl --user restart openclaw-gateway.service")
    print(f"  2. Test with a Feishu message")

if __name__ == "__main__":
    main()
