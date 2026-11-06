#!/usr/bin/env python3
"""Run a command for at most N seconds, exiting 124 past that. macOS has no timeout(1)."""
import subprocess
import sys

try:
    sys.exit(subprocess.run(sys.argv[2:], timeout=float(sys.argv[1])).returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
