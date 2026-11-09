import io
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pr


class ParseRepoTest(unittest.TestCase):
    def test_https_and_ssh_remotes(self):
        for url in [
            "https://github.com/acme/shop.git",
            "https://user@github.com/acme/shop",
            "git@github.com:acme/shop.git",
            "ssh://git@github.com/acme/shop/",
        ]:
            self.assertEqual(pr.parse_repo(url), "acme/shop", url)

    def test_other_hosts_are_refused(self):
        with self.assertRaises(pr.GitHubError):
            pr.parse_repo("https://gitlab.com/acme/shop.git")


class ReviewTest(unittest.TestCase):
    def test_review_posts_a_comment_on_the_current_head(self):
        calls = []

        def fake(method, path, body=None):
            calls.append((method, path, body))
            if method == "GET":
                return {"head": {"sha": "abc123"}}
            return {"id": 7, "html_url": "u", "commit_id": "abc123"}

        args = pr.parser().parse_args(["review", "12", "--body-file", __file__])
        with mock.patch.object(pr, "call", fake):
            result = pr.run(args, "acme/shop")
        method, path, body = calls[-1]
        self.assertEqual((method, path), ("POST", "repos/acme/shop/pulls/12/reviews"))
        self.assertEqual(body["event"], "COMMENT")
        self.assertEqual(body["commit_id"], "abc123")
        self.assertEqual(result["id"], 7)


class Stub:
    """A local HTTP server that answers each request with the next scripted reply and records it."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.seen = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def handle_one(self):
                length = int(self.headers.get("Content-Length") or 0)
                stub.seen.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "auth": self.headers.get("Authorization"),
                        "body": self.rfile.read(length) if length else None,
                    }
                )
                status, headers, payload = stub.replies.pop(0)
                raw = json.dumps(payload).encode()
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value.format(stub=stub))
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_PATCH = handle_one

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class RedirectTest(unittest.TestCase):
    def call_against(self, stub, *args):
        """Call with the http stub as the API, through an opener that speaks http."""
        with mock.patch.object(pr, "API", stub.url), mock.patch.object(
            pr, "OPENER", pr.opener(urllib.request.HTTPHandler())
        ), mock.patch.object(pr, "token", lambda: "t0k"):
            return pr.call(*args)

    def stub(self, replies):
        stub = Stub(replies)
        self.addCleanup(stub.close)
        return stub

    def test_post_is_resent_with_its_body_after_a_307(self):
        stub = self.stub(
            [
                (307, {"Location": "{stub.url}/repositories/1/pulls"}, {"message": "Moved"}),
                (201, {}, {"number": 9}),
            ]
        )
        result = self.call_against(stub, "POST", "repos/a/old/pulls", {"title": "t"})
        self.assertEqual(result, {"number": 9})
        self.assertEqual(
            [(r["method"], r["path"], r["auth"]) for r in stub.seen],
            [
                ("POST", "/repos/a/old/pulls", "Bearer t0k"),
                ("POST", "/repositories/1/pulls", "Bearer t0k"),
            ],
        )
        self.assertEqual(stub.seen[0]["body"], stub.seen[1]["body"])
        self.assertEqual(json.loads(stub.seen[1]["body"]), {"title": "t"})

    def test_patch_follows_a_301(self):
        stub = self.stub(
            [
                (301, {"Location": "/repositories/1/pulls/3"}, {}),
                (200, {}, {"number": 3}),
            ]
        )
        self.assertEqual(
            self.call_against(stub, "PATCH", "repos/a/old/pulls/3", {"body": "b"}),
            {"number": 3},
        )
        self.assertEqual([r["method"] for r in stub.seen], ["PATCH", "PATCH"])

    def test_token_is_dropped_when_the_redirect_leaves_the_api(self):
        other = self.stub([(201, {}, {"number": 9})])
        stub = self.stub([(308, {"Location": other.url + "/pulls"}, {})])
        self.call_against(stub, "POST", "repos/a/old/pulls", {"title": "t"})
        self.assertEqual(stub.seen[0]["auth"], "Bearer t0k")
        self.assertIsNone(other.seen[0]["auth"])
        self.assertEqual(json.loads(other.seen[0]["body"]), {"title": "t"})

    def test_post_is_resent_with_its_body_after_a_302(self):
        stub = self.stub([(302, {"Location": "/repositories/1/pulls"}, {}), (201, {}, {"number": 9})])
        self.call_against(stub, "POST", "repos/a/old/pulls", {"title": "t"})
        self.assertEqual([r["method"] for r in stub.seen], ["POST", "POST"])
        self.assertEqual(json.loads(stub.seen[1]["body"]), {"title": "t"})

    def test_token_is_not_sent_again_after_the_chain_leaves_the_api(self):
        api = self.stub([])
        other = self.stub([(307, {"Location": api.url + "/back"}, {})])
        api.replies = [(307, {"Location": other.url + "/away"}, {}), (201, {}, {"number": 9})]
        self.call_against(api, "POST", "repos/a/old/pulls", {"title": "t"})
        self.assertEqual(
            [(r["path"], r["auth"]) for r in api.seen],
            [("/repos/a/old/pulls", "Bearer t0k"), ("/back", None)],
        )
        self.assertIsNone(other.seen[0]["auth"])

    def test_a_redirect_without_a_location_is_refused(self):
        stub = self.stub([(307, {}, {"message": "Moved"})])
        with self.assertRaisesRegex(pr.GitHubError, "HTTP 307 without a Location"):
            self.call_against(stub, "POST", "repos/a/b/pulls", {})

    def test_a_redirect_to_another_scheme_is_refused(self):
        for location in ["file:///etc/passwd", "data:text/plain,hi", "ftp://127.0.0.1/x"]:
            stub = self.stub([(307, {"Location": location}, {})])
            with self.assertRaisesRegex(pr.GitHubError, "redirects to a .* URL, refused"):
                self.call_against(stub, "GET", "repos/a/b")
            self.assertEqual(len(stub.seen), 1, location)

    def test_a_redirect_from_https_to_http_is_refused(self):
        sent = []

        def answer(request):
            sent.append(request.full_url)
            headers = Message()
            headers["Location"] = "http://api.github.com/repositories/1"
            raise urllib.error.HTTPError(request.full_url, 301, "Moved", headers, io.BytesIO(b""))

        with mock.patch.object(pr.OPENER, "open", answer), mock.patch.object(
            pr, "token", lambda: "t0k"
        ):
            with self.assertRaisesRegex(pr.GitHubError, "redirects to a http URL, refused"):
                pr.call("GET", "repos/a/b")
        self.assertEqual(sent, ["https://api.github.com/repos/a/b"])

    def test_the_opener_handles_only_https(self):
        stub = self.stub([(200, {}, {})])
        for url in [stub.url + "/x", "file:///etc/passwd", "data:text/plain,hi"]:
            with self.assertRaisesRegex(urllib.error.URLError, "unknown url type"):
                pr.OPENER.open(url)
        self.assertEqual(stub.seen, [])

    def test_a_response_without_a_redirect_is_returned_from_one_request(self):
        stub = self.stub([(200, {}, {"number": 4})])
        self.assertEqual(self.call_against(stub, "GET", "repos/a/b/pulls/4"), {"number": 4})
        self.assertEqual(len(stub.seen), 1)

    def test_an_error_is_still_refused(self):
        stub = self.stub([(422, {}, {"message": "Validation Failed"})])
        with self.assertRaisesRegex(pr.GitHubError, "HTTP 422 .*Validation Failed"):
            self.call_against(stub, "POST", "repos/a/b/pulls", {})

    def test_a_redirect_loop_stops(self):
        stub = self.stub([(307, {"Location": "/loop"}, {})] * (pr.MAX_REDIRECTS + 1))
        with self.assertRaisesRegex(pr.GitHubError, "redirects"):
            self.call_against(stub, "GET", "repos/a/b")
        self.assertEqual(len(stub.seen), pr.MAX_REDIRECTS + 1)


if __name__ == "__main__":
    unittest.main()
