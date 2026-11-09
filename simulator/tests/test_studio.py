from pathlib import Path
from types import SimpleNamespace

import pytest

from cdp_sim.fixtures import CLEANUP_ACTIONS, PREPARE_ACTIONS
from cdp_sim.studio import Studio, StudioError, action_result, chunk_urls, encode_args, parse_login_form, server_references

FIXTURES = Path(__file__).parent / "fixtures"


def read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_the_classic_hosted_ui_form_gives_its_action_and_its_first_csrf_value():
    # The page repeats the form for two layouts, and each form repeats _csrf.
    form = parse_login_form(read("cognito_classic_login.html"))
    assert form.action.startswith("/login?redirect_uri=https%3A%2F%2Fstudio.")
    assert "&state=FIXTURE_state" in form.action
    assert form.hidden["_csrf"] == "fixture-csrf-token"
    assert form.hidden["cognitoAsfData"] == ""


def test_a_page_without_the_sign_in_form_is_refused():
    with pytest.raises(StudioError, match="no sign-in form"):
        parse_login_form("<html><form action='/x'><input name='q'></form></html>")
    with pytest.raises(StudioError, match="_csrf"):
        parse_login_form("<form action='/login'><input name='username'><input name='password' type='password'></form>")


def test_chunk_urls_come_from_studios_page():
    urls = chunk_urls(read("studio_login_page.html"))
    assert urls and all(url.startswith("/_next/static/chunks/") and url.endswith(".js") for url in urls)
    assert len(urls) == len(set(urls))


def test_server_references_are_read_from_studios_client_bundles():
    events = server_references(read("studio_events_chunk.js"))
    builder = server_references(read("studio_builder_chunk.js"))
    assert events["createUserEventWithFieldsAction"] == {"787416c0302b4e101b0a032c91e30df3f79165a51b"}
    assert events["deleteUserEventAction"] == {"40d5ee26b90dd182fa3ca565e8421a248295adf5c3"}
    assert builder["publishCampaignAction"] == {"60d87ce9f42d29364813717bb5c10b4fa1cb7656ee"}
    assert all(len(action_id) == 42 for ids in {**events, **builder}.values() for action_id in ids)


def test_the_actions_the_simulator_calls_are_named_as_studio_exports_them():
    exported = set()
    for line in (Path(__file__).parents[2] / "studio" / "app" / "actions.ts").read_text(encoding="utf-8").splitlines():
        if line.startswith("export async function "):
            exported.add(line.split()[3].split("(")[0])
    assert PREPARE_ACTIONS | CLEANUP_ACTIONS <= exported


def test_arguments_are_encoded_as_react_encodes_a_reply():
    assert encode_args(("ue_1", True, {"a": ["$x", None]})) == '["ue_1",true,{"a":["$$x",null]}]'


def test_the_action_result_follows_the_root_rows_reference_past_a_text_row_with_newlines():
    text = "line one\nline two"
    body = (
        f'0:{{"a":"$@2","f":"$L1","b":"build","q":"","i":false}}\n'
        f"1:T{len(text.encode()):x},{text}"
        '2:{"success":true,"eventId":"ue_7","note":"$$literal"}\n'
        '3:I["chunk",[]]\n'
    ).encode()
    assert action_result(body) == {"success": True, "eventId": "ue_7", "note": "$literal"}
    assert action_result(b'0:{"a":"$@1"}\n1:{"error":"Event sim_x already exists."}\n') == {"error": "Event sim_x already exists."}
    with pytest.raises(StudioError, match="no root row"):
        action_result(b"1:{}\n")


def reference(action_id: str, name: str) -> str:
    return f'createServerReference)("{action_id}",callServer,void 0,findSourceMapURL,"{name}")'


class FakeSession:
    """Answers studio's pages and chunks from a dict of path to body."""

    def __init__(self, bodies: dict[str, str]) -> None:
        self.bodies = bodies

    def get(self, url: str, **_: object) -> SimpleNamespace:
        path = url.removeprefix("https://studio")
        return SimpleNamespace(status_code=200, ok=True, text=self.bodies.get(path, ""))


def discovering(chunks: dict[str, str]) -> Studio:
    studio = Studio("https://studio")
    page = "".join(f'<script src="{chunk}"></script>' for chunk in chunks)
    studio._session = FakeSession({"/admin/events": page, "/campaign": "", "/campaign/sim_discovery": "", **chunks})
    return studio


def test_a_needed_action_with_two_ids_stops_discovery():
    studio = discovering({
        "/_next/static/chunks/a.js": reference("a" * 42, "publishCampaignAction"),
        "/_next/static/chunks/b.js": reference("b" * 42, "publishCampaignAction") + reference("c" * 42, "unused"),
    })
    with pytest.raises(StudioError, match="more than one id to publishCampaignAction"):
        studio.discover({"publishCampaignAction"})


def test_a_name_the_run_does_not_need_may_have_two_ids():
    studio = discovering({
        "/_next/static/chunks/a.js": reference("a" * 42, "publishCampaignAction") + reference("c" * 42, "unused"),
        "/_next/static/chunks/b.js": reference("a" * 42, "publishCampaignAction") + reference("d" * 42, "unused"),
    })
    studio.discover({"publishCampaignAction"})


def test_an_error_row_in_the_reply_raises_and_is_never_a_result():
    with pytest.raises(StudioError, match="studio threw an error in row 1: Campaign not found"):
        action_result(b'0:{"a":"$@1"}\n1:E{"digest":"123","message":"Campaign not found"}\n')
    with pytest.raises(StudioError, match="digest-only"):
        action_result(b'0:{"a":"$@1"}\n1:E{"digest":"digest-only"}\n')
