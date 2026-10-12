import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import kanban_access_setup as setup  # noqa: E402

TUNNEL = "11111111-2222-3333-4444-555555555555"


class FakeApi:
    def __init__(self, records):
        self.records = records
        self.writes = []

    def __call__(self, method, path, payload=None):
        if method == "GET":
            return self.records
        self.writes.append((method, path, payload))
        return {}


def test_covers_host_matches_exact_paths_and_wildcards_only():
    assert setup.covers_host("kanban.cervantes50.com")
    assert setup.covers_host("kanban.cervantes50.com/api")
    assert setup.covers_host("*.cervantes50.com")
    assert not setup.covers_host("i.cervantes50.com")
    assert not setup.covers_host("xkanban.cervantes50.com")


def test_tunnel_config_has_one_route_to_the_kanban_then_404():
    text = setup.render_tunnel_config(TUNNEL)
    assert text.count("hostname:") == 1
    assert text.count("service:") == 2
    assert "hostname: kanban.cervantes50.com\n    service: http://127.0.0.1:4000" in text
    assert text.rstrip().endswith("- service: http_status:404")


def test_dns_creates_proxied_cname_when_name_is_free():
    api = FakeApi([])
    setup.ensure_dns(api, "zone", TUNNEL)
    [(method, _, payload)] = api.writes
    assert method == "POST"
    assert payload["content"] == f"{TUNNEL}.cfargotunnel.com" and payload["proxied"] is True


def test_dns_refuses_to_repoint_a_foreign_record():
    api = FakeApi([{"id": "r1", "type": "A", "content": "203.0.113.7"}])
    with pytest.raises(setup.CloudflareError, match="already has"):
        setup.ensure_dns(api, "zone", TUNNEL)
    assert api.writes == []


def test_dns_updates_its_own_record_in_place():
    api = FakeApi([{"id": "r1", "type": "CNAME", "content": f"{TUNNEL}.cfargotunnel.com", "proxied": False}])
    setup.ensure_dns(api, "zone", TUNNEL)
    [(method, path, payload)] = api.writes
    assert method == "PUT" and path.endswith("/r1") and payload["proxied"] is True


class RoutedApi:
    """Answers GET by path prefix; records every write."""

    def __init__(self, routes):
        self.routes = routes
        self.writes = []

    def __call__(self, method, path, payload=None):
        if method != "GET":
            self.writes.append((method, path, payload))
            return {}
        for prefix, result in self.routes.items():
            if path.startswith(prefix):
                return result
        raise AssertionError(f"unexpected GET {path}")


def test_foreign_hostnames_lists_other_names_on_the_tunnel_only():
    target = f"{TUNNEL}.cfargotunnel.com"
    api = RoutedApi({"/zones/z1/dns_records": [{"name": "kanban.cervantes50.com", "content": target},
                                               {"name": "sure.cervantes50.com", "content": "x.cfargotunnel.com"},
                                               {"name": "old.cervantes50.com", "content": target}]})
    assert setup.foreign_hostnames(api, "z1", TUNNEL) == ["old.cervantes50.com"]


def test_dashboard_managed_tunnel_with_our_name_is_refused():
    api = RoutedApi({"/accounts/acc/cfd_tunnel": [{"id": TUNNEL, "name": setup.TUNNEL_NAME, "remote_config": True}]})
    with pytest.raises(setup.CloudflareError, match="dashboard"):
        setup.ensure_tunnel(api, "acc")
    assert api.writes == []


OWNER = "owner@example.com"


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A fully valid Cloudflare state and owner-only files; each test breaks one thing."""
    conf = tmp_path / "tunnel"
    conf.mkdir(mode=0o700)
    conf.chmod(0o700)
    monkeypatch.setattr(setup, "CONFIG_DIR", conf)
    monkeypatch.setattr(setup, "CREDENTIALS_FILE", conf / "creds.json")
    monkeypatch.setattr(setup, "TUNNEL_CONFIG_FILE", conf / "config.yml")
    monkeypatch.setattr(setup, "ALLOWED_EMAILS", (OWNER,))
    setup.write_private(setup.CREDENTIALS_FILE, "{}\n")
    setup.write_private(setup.TUNNEL_CONFIG_FILE, setup.render_tunnel_config(TUNNEL))
    app = {"id": "app1", "name": setup.APP_NAME, "domain": setup.PUBLIC_HOST, "type": "self_hosted",
           "allowed_idps": ["otp1"], "session_duration": setup.SESSION_DURATION, "options_preflight_bypass": False}
    tunnel = {"id": TUNNEL, "name": setup.TUNNEL_NAME, "remote_config": False, "config_src": "local"}
    # Insertion order matters: RoutedApi answers with the first matching prefix.
    return {
        "/accounts/acc/access/identity_providers": [{"id": "otp1", "type": "onetimepin"}],
        "/accounts/acc/access/apps/app1/policies": [{"name": setup.POLICY_NAME, "decision": "allow",
                                                      "include": [{"email": {"email": OWNER}}],
                                                      "exclude": [], "require": []}],
        "/accounts/acc/access/apps/app1": app,
        "/accounts/acc/access/apps": [app],
        "/accounts/acc/cfd_tunnel": [tunnel],
        "/zones/z1/dns_records": [{"name": setup.PUBLIC_HOST, "type": "CNAME",
                                   "content": f"{TUNNEL}.cfargotunnel.com", "proxied": True}],
    }


def run_audit(routes):
    return setup.audit(RoutedApi(routes), "acc", "z1")


def test_audit_passes_the_valid_world(world):
    assert run_audit(world) == []


def test_audit_flags_tunnel_switched_to_dashboard_config(world):
    world["/accounts/acc/cfd_tunnel"][0].update(remote_config=True, config_src="cloudflare")
    assert any("managed from the dashboard" in p for p in run_audit(world))


def test_audit_flags_preflight_bypass(world):
    world["/accounts/acc/access/apps/app1"]["options_preflight_bypass"] = True
    assert any("preflight" in p for p in run_audit(world))


def test_audit_flags_bypass_policy(world):
    world["/accounts/acc/access/apps/app1/policies"][0]["decision"] = "bypass"
    assert any("decision=bypass" in p for p in run_audit(world))


def test_audit_flags_grey_cloud_dns(world):
    world["/zones/z1/dns_records"][0]["proxied"] = False
    assert any("not proxied" in p for p in run_audit(world))


@pytest.mark.parametrize("target, mode", [("CONFIG_DIR", 0o755), ("CREDENTIALS_FILE", 0o644),
                                          ("TUNNEL_CONFIG_FILE", 0o644)])
def test_audit_flags_wider_than_owner_only_modes(world, target, mode):
    getattr(setup, target).chmod(mode)
    assert any(f"mode {mode:o}" in p for p in run_audit(world))
