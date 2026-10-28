"""Wrap page.html (the artifact fragment) into index.html, a complete document for local use."""
import pathlib
here = pathlib.Path(__file__).parent
frag = (here / "page.html").read_text(encoding="utf-8")
doc = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
       + frag.split("\n", 1)[0] + "\n</head>\n<body>\n" + frag.split("\n", 1)[1] + "\n</body>\n</html>\n")
(here / "index.html").write_text(doc, encoding="utf-8")
print("wrote index.html", len(doc), "bytes")
