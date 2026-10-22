#!/usr/bin/env python3
"""Public address for the Obsidian kanban behind Cloudflare Access (owner command 2026-10-12).

    kanban.cervantes50.com  ->  Cloudflare Access (one-time PIN to the owner's address only)
                            ->  tunnel "obsidian-kanban" (cloudflared on the Mac mini)  ->  http://127.0.0.1:4000

Copy of the WhatsApp desk script (~/whatsapp-desk/cloudflare/desk_access_setup.py, same scheme as Sure
and VC) with this host's constants. Idempotent:

    kanban_access_setup.py verify   # token works, OTP login method exists
    kanban_access_setup.py apply    # tunnel -> config -> Access app+policy -> audit -> DNS
    kanban_access_setup.py audit    # check every invariant below, exit 1 on any problem

The API token is read from ~/.config/vc-site/cloudflare_api_token (mode 600) and never printed.
Tunnel credentials are written owner-only to ~/.config/obsidian-kanban-tunnel/.
The kanban API runs without API_TOKEN, so Access is the only gate in front of it: the tunnel has one
route, and nothing reaches port 4000 from outside except through that route.

Invariants (`audit`):
  * exactly one Access app on the host; one policy: allow, include = exactly ALLOWED_EMAILS;
    no bypass / non_identity / service_auth policies;
  * the app is self_hosted, its only login method is the one-time PIN, OPTIONS preflight does not
    bypass it; session SESSION_DURATION; its cookies are SameSite SAME_SITE_COOKIE, so another site
    cannot ride the owner's Access session (links from mail and calendar still open signed in);
  * the DNS record is a proxied CNAME to this tunnel (grey cloud would skip Access);
  * the tunnel config file equals the canonical text byte for byte (one route + 404);
  * the tunnel carries no other hostnames in ZONE_NAME (checked before the config is written, too);
  * a dashboard-managed tunnel with our name is refused, never adopted (and audit flags one that
    was switched to dashboard config later: remote routes would override the local file);
  * CONFIG_DIR is 0700 and the credentials and config files are 0600, also when they pre-existed.
DNS is created only after the Access app passes the audit, so the name is never public unprotected.
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import tempfile
import urllib.error
import urllib.request
from base64 import b64encode
from pathlib import Path

API_ROOT = "https://api.cloudflare.com/client/v4"
TIMEOUT_SECONDS = 30
MAX_PAGES = 40
ZONE_NAME = "cervantes50.com"
PUBLIC_HOST = "kanban.cervantes50.com"
TUNNEL_NAME = "obsidian-kanban"
APP_NAME = "Obsidian kanban — kanban.cervantes50.com"
DNS_COMMENT = "Obsidian kanban behind Cloudflare Access, tunnel 'obsidian-kanban'"
POLICY_NAME = "Owner only"
CONFIG_DIR = Path.home() / ".config" / "obsidian-kanban-tunnel"
# Allowed addresses live outside the repo (one per line, mode 600): CONFIG_DIR / allowed_emails
ALLOWED_EMAILS_FILE = CONFIG_DIR / "allowed_emails"
SESSION_DURATION = "720h"   # 30 days, as the WhatsApp desk (owner 2026-10-11)
# Access cookies default to SameSite None, sent with requests from any site for the whole session;
# Lax sends them only on same-site requests and top-level navigations (backlog B-4)
SAME_SITE_COOKIE = "lax"
ORIGIN_URL = "http://127.0.0.1:4000"
TOKEN_FILE = Path.home() / ".config" / "vc-site" / "cloudflare_api_token"
CREDENTIALS_FILE = CONFIG_DIR / "obsidian-kanban-tunnel.json"
TUNNEL_CONFIG_FILE = CONFIG_DIR / "config.yml"


class CloudflareError(RuntimeError):
    pass


class Api:
    def __init__(self, token: str) -> None:
        self._token = token

    def __call__(self, method: str, path: str, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(f"{API_ROOT}{path}", data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                doc = json.load(resp)
        except urllib.error.HTTPError as err:
            raise CloudflareError(f"{method} {path}: HTTP {err.code} {err.read(400).decode('utf-8', 'replace')}") from None
        if not doc.get("success"):
            raise CloudflareError(f"{method} {path}: {doc.get('errors')}")
        return doc.get("result")


def paged(api: Api, path: str, per_page: int = 50) -> list:
    sep = "&" if "?" in path else "?"
    items, page = [], 1
    while True:
        result = api("GET", f"{path}{sep}per_page={per_page}&page={page}") or []
        items.extend(result)
        if len(result) < per_page:
            return items
        page += 1
        if page > MAX_PAGES:
            raise CloudflareError(f"{path}: more than {MAX_PAGES * per_page} items")


def load_allowed_emails() -> tuple[str, ...]:
    if not ALLOWED_EMAILS_FILE.is_file() or (ALLOWED_EMAILS_FILE.stat().st_mode & 0o777) != 0o600:
        raise SystemExit(f"{ALLOWED_EMAILS_FILE} missing or not mode 600")
    emails = tuple(sorted({l.strip().lower() for l in ALLOWED_EMAILS_FILE.read_text().splitlines() if l.strip()}))
    if not emails:
        raise SystemExit(f"{ALLOWED_EMAILS_FILE} is empty")
    return emails


ALLOWED_EMAILS: tuple[str, ...] = ()


def read_token() -> str:
    mode = TOKEN_FILE.stat().st_mode & 0o777
    if mode != 0o600:
        raise SystemExit(f"{TOKEN_FILE} has mode {mode:o}, expected 600")
    token = TOKEN_FILE.read_text().strip()
    if not token:
        raise SystemExit(f"{TOKEN_FILE} is empty")
    return token


def write_private(path: Path, content: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def account_id(api: Api) -> str:
    accounts = api("GET", "/accounts") or []
    if len(accounts) != 1:
        raise CloudflareError(f"expected one account, got {len(accounts)}")
    return accounts[0]["id"]


def zone_id(api: Api) -> str:
    zones = api("GET", f"/zones?name={ZONE_NAME}") or []
    if len(zones) != 1:
        raise CloudflareError(f"zone {ZONE_NAME} not found")
    return zones[0]["id"]


def find_tunnel(api: Api, acc: str):
    found = [t for t in api("GET", f"/accounts/{acc}/cfd_tunnel?name={TUNNEL_NAME}&is_deleted=false") or []
             if t.get("name") == TUNNEL_NAME]
    if len(found) > 1:
        raise CloudflareError(f"{len(found)} tunnels named {TUNNEL_NAME}")
    return found[0] if found else None


def ensure_tunnel(api: Api, acc: str) -> str:
    tunnel = find_tunnel(api, acc)
    if tunnel:
        if tunnel.get("remote_config"):
            # Routes of a dashboard-managed tunnel live in Cloudflare, not in our config file: not ours.
            raise CloudflareError(f"tunnel {TUNNEL_NAME} is managed from the dashboard; rename or delete it first")
        if not CREDENTIALS_FILE.is_file():
            raise CloudflareError(f"tunnel {TUNNEL_NAME} exists but {CREDENTIALS_FILE} is missing — "
                                  "its secret cannot be re-read; delete the tunnel in the dashboard and re-run")
        return tunnel["id"]
    secret = b64encode(secrets.token_bytes(32)).decode()
    tunnel = api("POST", f"/accounts/{acc}/cfd_tunnel",
                 {"name": TUNNEL_NAME, "tunnel_secret": secret, "config_src": "local"})
    write_private(CREDENTIALS_FILE, json.dumps(
        {"AccountTag": acc, "TunnelID": tunnel["id"], "TunnelSecret": secret}, indent=2) + "\n")
    return tunnel["id"]


def render_tunnel_config(tunnel_id: str) -> str:
    return f"""# Tunnel {PUBLIC_HOST} -> Obsidian kanban on the Mac mini. Generated by obsidian-kanban-app/cloudflare/kanban_access_setup.py.
tunnel: {tunnel_id}
credentials-file: {CREDENTIALS_FILE}
no-autoupdate: true
# One route only; any other hostname pointed at this tunnel gets a 404 and never reaches the kanban.
ingress:
  - hostname: {PUBLIC_HOST}
    service: {ORIGIN_URL}
    originRequest:
      connectTimeout: 10s
  - service: http_status:404
"""


def otp_idp(api: Api, acc: str) -> str:
    otp = [p for p in api("GET", f"/accounts/{acc}/access/identity_providers") or [] if p.get("type") == "onetimepin"]
    if len(otp) != 1:
        raise CloudflareError("one-time PIN login method not found in Zero Trust")
    return otp[0]["id"]


def app_hosts(app: dict) -> list[str]:
    hosts = [app.get("domain") or ""] + list(app.get("self_hosted_domains") or [])
    hosts += [d.get("uri") or "" for d in (app.get("destinations") or []) if isinstance(d, dict)]
    return [h for h in hosts if h]


def covers_host(host: str) -> bool:
    """True if an Access destination applies to PUBLIC_HOST or any of its paths, incl. wildcards."""
    bare = host.split("/", 1)[0].lower()
    if bare == PUBLIC_HOST:
        return True
    return bare.startswith("*.") and PUBLIC_HOST.endswith(bare[1:])


def find_apps(api: Api, acc: str) -> list:
    """Every Access app whose domain/destinations reach this host (paths and wildcards included)."""
    return [a for a in paged(api, f"/accounts/{acc}/access/apps") if any(covers_host(h) for h in app_hosts(a))]


def is_ours(app: dict) -> bool:
    return app.get("name") == APP_NAME and sorted(set(app_hosts(app))) == [PUBLIC_HOST]


def app_payload(idp: str) -> dict:
    return {
        "name": APP_NAME, "domain": PUBLIC_HOST, "type": "self_hosted",
        "session_duration": SESSION_DURATION,
        "allowed_idps": [idp],              # exactly one login method, never "all enabled IdPs"
        "auto_redirect_to_identity": True, "app_launcher_visible": False,
        "http_only_cookie_attribute": True, "enable_binding_cookie": True,
        "same_site_cookie_attribute": SAME_SITE_COOKIE,
        "options_preflight_bypass": False, "service_auth_401_redirect": False, "skip_interstitial": True,
    }


def policy_payload() -> dict:
    return {"name": POLICY_NAME, "decision": "allow", "precedence": 1,
            "include": [{"email": {"email": e}} for e in ALLOWED_EMAILS], "exclude": [], "require": []}


def ensure_app(api: Api, acc: str, idp: str) -> str:
    apps = find_apps(api, acc)
    foreign = [a for a in apps if not is_ours(a)]
    if foreign:
        # Never adopt or rewrite an app this script did not create: it may guard other hosts too.
        raise CloudflareError("Access apps not owned by this script reach the host: "
                              + ", ".join(f"{a.get('name')} {app_hosts(a)}" for a in foreign))
    if len(apps) > 1:
        raise CloudflareError(f"{len(apps)} Access apps on {PUBLIC_HOST}")
    app = (api("PUT", f"/accounts/{acc}/access/apps/{apps[0]['id']}", app_payload(idp)) if apps
           else api("POST", f"/accounts/{acc}/access/apps", app_payload(idp)))
    base = f"/accounts/{acc}/access/apps/{app['id']}/policies"
    existing = api("GET", base) or []
    mine = [p for p in existing if p.get("name") == POLICY_NAME]
    if mine:
        api("PUT", f"{base}/{mine[0]['id']}", policy_payload())
    else:
        api("POST", base, policy_payload())
    for extra in [p for p in existing if p not in mine[:1]]:
        api("DELETE", f"{base}/{extra['id']}")
    return app["id"]


def ensure_dns(api: Api, zid: str, tunnel_id: str) -> None:
    records = api("GET", f"/zones/{zid}/dns_records?name={PUBLIC_HOST}") or []
    target = f"{tunnel_id}.cfargotunnel.com"
    payload = {"type": "CNAME", "name": PUBLIC_HOST, "content": target,
               "proxied": True, "ttl": 1, "comment": DNS_COMMENT}
    if len(records) > 1:
        raise CloudflareError(f"{len(records)} DNS records for {PUBLIC_HOST}")
    if records and not (records[0].get("type") == "CNAME" and records[0].get("content") == target):
        # The name already serves something else: never repoint it silently.
        raise CloudflareError(f"{PUBLIC_HOST} already has a {records[0].get('type')} record "
                              f"-> {records[0].get('content')}; remove it in the dashboard first")
    if records:
        api("PUT", f"/zones/{zid}/dns_records/{records[0]['id']}", payload)
    else:
        api("POST", f"/zones/{zid}/dns_records", payload)


def audit(api: Api, acc: str, zid: str, require_dns: bool = True) -> list[str]:
    problems = []
    idp = otp_idp(api, acc)
    apps = find_apps(api, acc)
    if len(apps) != 1 or not is_ours(apps[0]):
        problems.append(f"expected exactly this script's Access app on {PUBLIC_HOST} (host and all paths), found "
                        + "; ".join(f"{a.get('name')} {app_hosts(a)}" for a in apps))
    else:
        app = api("GET", f"/accounts/{acc}/access/apps/{apps[0]['id']}")
        if app.get("allowed_idps") != [idp]:
            problems.append(f"login methods {app.get('allowed_idps')} != one-time PIN only")
        if app.get("session_duration") != SESSION_DURATION:
            problems.append(f"session {app.get('session_duration')} != {SESSION_DURATION}")
        if app.get("type") != "self_hosted":
            problems.append(f"app type {app.get('type')} != self_hosted")
        if app.get("options_preflight_bypass"):
            problems.append("OPTIONS preflight bypasses Access")
        if app.get("same_site_cookie_attribute") != SAME_SITE_COOKIE:
            problems.append(f"cookie SameSite {app.get('same_site_cookie_attribute')} != {SAME_SITE_COOKIE}")
        policies = api("GET", f"/accounts/{acc}/access/apps/{app['id']}/policies") or []
        if len(policies) != 1:
            problems.append(f"expected 1 policy, found {len(policies)}")
        for p in policies:
            emails = sorted(i.get("email", {}).get("email") for i in p.get("include", []))
            if p.get("decision") != "allow" or emails != sorted(ALLOWED_EMAILS) or len(p.get("include", [])) != len(ALLOWED_EMAILS):
                problems.append(f"policy {p.get('name')}: decision={p.get('decision')} include={p.get('include')}")
            if p.get("exclude") or p.get("require"):
                problems.append(f"policy {p.get('name')} has exclude/require rules")
    problems += permission_problems()
    tunnel = find_tunnel(api, acc)
    if not tunnel:
        problems.append("tunnel missing")
    else:
        if tunnel.get("remote_config") or tunnel.get("config_src") != "local":
            problems.append(f"tunnel {TUNNEL_NAME} is managed from the dashboard: its routes override {TUNNEL_CONFIG_FILE}")
        if TUNNEL_CONFIG_FILE.is_file():
            if TUNNEL_CONFIG_FILE.read_text() != render_tunnel_config(tunnel["id"]):
                problems.append(f"{TUNNEL_CONFIG_FILE} differs from the canonical config")
        else:
            problems.append(f"{TUNNEL_CONFIG_FILE} missing")
        records = api("GET", f"/zones/{zid}/dns_records?name={PUBLIC_HOST}") or []
        if require_dns:
            if len(records) != 1:
                problems.append(f"expected 1 DNS record for {PUBLIC_HOST}, found {len(records)}")
            elif not (records[0].get("proxied") and records[0].get("content") == f"{tunnel['id']}.cfargotunnel.com"):
                problems.append(f"DNS record not proxied to the tunnel: {records[0].get('content')} proxied={records[0].get('proxied')}")
        other = foreign_hostnames(api, zid, tunnel["id"])
        if other:
            problems.append(f"other hostnames on the tunnel: {other}")
    return problems


def permission_problems() -> list[str]:
    """Secrets stay owner-only even when the directory or files existed before with wider modes.

    lstat, so a symlink in place of a file is reported instead of followed."""
    expected = ((CONFIG_DIR, 0o700), (CREDENTIALS_FILE, 0o600), (TUNNEL_CONFIG_FILE, 0o600))
    return [f"{path} has mode {path.lstat().st_mode & 0o777:o}, expected {mode:o}"
            for path, mode in expected
            if os.path.lexists(path) and (path.lstat().st_mode & 0o777) != mode]


def foreign_hostnames(api: Api, zid: str, tunnel_id: str) -> list[str]:
    """Names in ZONE_NAME routed to this tunnel, other than PUBLIC_HOST.

    The token reads DNS of this zone only (other zones answer 403), so routes from other zones are not seen."""
    target = f"{tunnel_id}.cfargotunnel.com"
    return [r["name"] for r in paged(api, f"/zones/{zid}/dns_records?type=CNAME")
            if r.get("content") == target and r.get("name") != PUBLIC_HOST]


def main(argv: list[str]) -> int:
    global ALLOWED_EMAILS
    ALLOWED_EMAILS = load_allowed_emails()
    cmd = argv[1] if len(argv) > 1 else "audit"
    api = Api(read_token())
    acc, zid = account_id(api), zone_id(api)
    if cmd == "verify":
        otp_idp(api, acc)
        print("token ok, zone ok, one-time PIN available")
        return 0
    if cmd == "apply":
        tunnel_id = ensure_tunnel(api, acc)
        other = foreign_hostnames(api, zid, tunnel_id)
        if other:
            # Rewriting the config would 404 these routes: the tunnel is not only ours.
            raise CloudflareError(f"tunnel {TUNNEL_NAME} also serves {other}; config NOT written")
        write_private(TUNNEL_CONFIG_FILE, render_tunnel_config(tunnel_id))
        ensure_app(api, acc, otp_idp(api, acc))
        pre = audit(api, acc, zid, require_dns=False)
        if pre:
            print("Access audit failed, DNS NOT created:\n  " + "\n  ".join(pre))
            return 1
        ensure_dns(api, zid, tunnel_id)
        print(f"applied: tunnel {tunnel_id[:8]}…, Access app, DNS {PUBLIC_HOST}")
        cmd = "audit"
    if cmd == "audit":
        problems = audit(api, acc, zid)
        print("audit OK" if not problems else "audit FAILED:\n  " + "\n  ".join(problems))
        return 0 if not problems else 1
    raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except CloudflareError as exc:
        print(f"Cloudflare error: {exc}")
        sys.exit(1)
