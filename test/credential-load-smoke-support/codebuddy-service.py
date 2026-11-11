"""Production credential loading and admin routes, without maintenance threads."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import traceback
from types import SimpleNamespace

sys.dont_write_bytecode = True
status_file = Path(os.environ["CREDENTIAL_SMOKE_STATUS"])
status = {"imported": False, "initialized": False, "loaded": False,
          "installed": False, "outboundBlocked": 0, "desktopSeedBlocked": True}


def write_status():
    status_file.write_text(json.dumps(status), encoding="utf-8")


def blocked(*args, **kwargs):
    status["outboundBlocked"] += 1
    write_status()
    raise RuntimeError("Smoke harness disallows outbound operations")


# uvicorn's event loop uses a loopback socketpair on Windows. All actual
# service/account outbound destinations remain blocked before imports execute.
connect = socket.socket.connect
connect_ex = socket.socket.connect_ex
getaddrinfo = socket.getaddrinfo


def guarded_connect(self, address):
    if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
        return connect(self, address)
    return blocked()


def guarded_connect_ex(self, address):
    if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
        return connect_ex(self, address)
    return blocked()


socket.socket.connect = guarded_connect
socket.socket.connect_ex = guarded_connect_ex


def guarded_getaddrinfo(host, *args, **kwargs):
    if host in (None, "127.0.0.1", "::1"):
        return getaddrinfo(host, *args, **kwargs)
    return blocked()


socket.getaddrinfo = guarded_getaddrinfo
subprocess.Popen.__init__ = blocked
os.system = blocked
write_status()
sys.path.insert(0, os.environ["CREDENTIAL_SMOKE_REPO"])
gateway = None
runtime_management = None
try:
    import converter as gateway
    from app import runtime_management
    from app import startup
    from app.usage_snapshots import UsageSnapshots
    status["imported"] = True
    write_status()
    # Never allow startup helpers to discover or announce desktop credentials.
    gateway.seed_credentials = blocked
    gateway.auth_dirs = blocked
    startup._announce_admin_password = blocked
    args = SimpleNamespace(no_model_guard=True, api_key=os.environ["GATEWAY_KEY"])
    runtime_management.initialize(gateway, args, argv=["--api-key", "--no-model-guard"])
    status["initialized"] = True
    write_status()
    files = sorted(Path(os.environ["CODEBUDDY_AUTH_DIR"]).glob("*.info"))
    gateway.CONFIG["cred_pool"] = gateway.CredentialPool(
        files, scan=False, state_store=gateway.CONFIG["state_store"])
    gateway.CONFIG["usage_snapshots"] = UsageSnapshots(store=gateway.CONFIG["state_store"])
    gateway.CONFIG["cred"] = gateway.CONFIG["cred_pool"].first()
    gateway.CONFIG["account_catalogs"] = {}
    status["count"] = len(gateway.CONFIG["cred_pool"].entries())
    status["loaded"] = status["count"] > 0
    write_status()
    runtime_management.install(gateway)
    status["installed"] = True
    write_status()
    import uvicorn
    # No inference resources or background maintenance are needed for admin GET.
    uvicorn.run(gateway.app, host="127.0.0.1", port=int(os.environ["PORT"]),
                log_config=None, access_log=False, lifespan="off")
except BaseException as error:
    # Do not serialize exceptions: credential parser messages can contain data.
    status["failed"] = True
    status["failureFiles"] = [Path(frame.filename).name for frame in traceback.extract_tb(error.__traceback__)]
    status["missingDependency"] = isinstance(error, ModuleNotFoundError)
    if isinstance(error, ModuleNotFoundError) and error.name:
        status["failureFiles"].append(error.name.replace(".", "/") + ".py")
    write_status()
    sys.exit(1)
finally:
    if gateway is not None and runtime_management is not None:
        runtime_management.close(gateway.CONFIG)
