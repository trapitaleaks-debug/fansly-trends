#!/usr/bin/env python3
import sys, json, subprocess, os

data = json.load(sys.stdin)
cmd = data.get("command", "")

is_vercel = "vercel deploy" in cmd
is_railway = "railway up" in cmd

if not is_vercel and not is_railway:
    sys.exit(0)

project_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

checks = []
if is_vercel:
    checks.append(("typecheck", "npm run typecheck"))
if is_railway:
    checks.append(("typecheck:pipeline", "npm run typecheck:pipeline"))

for name, check_cmd in checks:
    print(f"🔍 Pre-deploy: running {name}...")
    result = subprocess.run(
        check_cmd.split(), capture_output=True, text=True, cwd=project_dir
    )
    if result.returncode != 0:
        print(f"❌ {name} failed — deploy blocked.\n")
        print(result.stdout)
        print(result.stderr)
        sys.exit(2)
    print(f"✅ {name} passed.")

sys.exit(0)
