python3 app.py >/dev/null || { echo "app does not run"; exit 1; }
if grep -rn --include='*' -E 'get_usr\(|get_usr,|get_usr$|import get_usr\b' . --exclude-dir=.git --exclude-dir=__pycache__ | grep -v get_usr_name; then echo "old name left"; exit 1; fi
grep -q 'def get_usr_name' users.py || { echo "renamed get_usr_name, which was to stay"; exit 1; }
grep -q fetch_user README.md || { echo "README not updated"; exit 1; }
