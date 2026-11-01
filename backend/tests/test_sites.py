import io
import json
import tarfile

from app import sites

SNIP = sites.tag("https://tablyteam.com", "elevum")


def test_candidates_skip_builds_and_emails_and_rank_shells_first():
    paths = ["src/app/foo/foo.component.html", "node_modules/x/index.html", "dist/index.html", "templates/emails/welcome.html",
             "src/index.html", "app/layout.tsx", "pages/_document.tsx", "README.md"]
    c = sites.candidates(paths)
    assert c[:3] == ["app/layout.tsx", "pages/_document.tsx", "src/index.html"]
    assert "node_modules/x/index.html" not in c and "dist/index.html" not in c and "templates/emails/welcome.html" not in c


def test_patch_html_layout_document_and_old_tag():
    html = "<html>\n  <head>\n    <title>x</title>\n  </head>\n<body></body></html>"
    out = sites.patch("index.html", html, SNIP)
    assert SNIP in out and out.index(SNIP) < out.index("</head>")
    assert sites.patch("index.html", out, SNIP) is None  # already there
    assert sites.patch("src/app/a.component.html", "<div>hi</div>", SNIP) is None
    lay = "export default function L({children}){return (<html lang=\"es\"><body>{children}</body></html>)}"
    out = sites.patch("app/layout.tsx", lay, SNIP)
    assert f"<head>{SNIP}</head>" in out
    doc = "<Html><Head /><body><Main /></body></Html>"
    assert f"<Head>{SNIP}</Head>" in sites.patch("pages/_document.tsx", doc, SNIP)
    old = '<head><script defer src="http://localhost:8000/a.js" data-site="elevum"></script></head>'
    assert sites.patch("index.html", old, SNIP) == f"<head>{SNIP}</head>"


def test_urls_and_repos():
    assert sites.normal_url("elevum.com") == "https://elevum.com"
    assert sites.normal_repo("github.com/kolariki/elevum.git") == "https://github.com/kolariki/elevum"
    for bad in ("hola", "https://gitlab.com/a/b"):
        try:
            sites.normal_repo(bad)
            raise AssertionError(bad)
        except ValueError:
            pass


def test_package_has_site_inside():
    tgz = sites.package("elevum", "https://tablyteam.com")
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as t:
        names = t.getnames()
        pkg = json.loads(t.extractfile("package/package.json").read())
        mjs = t.extractfile("package/index.mjs").read().decode()
        bin_js = t.extractfile("package/bin/connect.cjs").read().decode()
    assert {"package/index.cjs", "package/index.d.ts", "package/README.md"} <= set(names)
    assert pkg["name"] == "tably-analytics" and pkg["bin"]["tably-analytics"] == "bin/connect.cjs"
    assert '"site": "elevum"' in mjs and "export { init, track, identify, variant }" in mjs
    assert "__CFG__" not in bin_js and '"site": "elevum"' in bin_js
