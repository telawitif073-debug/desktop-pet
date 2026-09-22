import json
import urllib.request
import urllib.error

body = json.dumps({"identifier": "synctest", "password": "sync-test-123"}).encode()
req = urllib.request.Request(
    "http://127.0.0.1/api/auth/login",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    resp = urllib.request.urlopen(req, timeout=10)
    print("status:", resp.status)
    print(resp.read().decode()[:300])
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    print(e.read().decode()[:300])
