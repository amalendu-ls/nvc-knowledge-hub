#!/usr/bin/env python3
"""Read the publication lists of NVC faculty from their public Vidwan profiles
(https://vidwan.inflibnet.ac.in/profile/<id>?page=N, 8 per page) into a JSON file for
harvest.py --vidwan-json.  One request about every second.

usage: python vidwan-pubs.py ID1 ID2 ... > vidwan-pubs.json      (or --ids-file FILE)
"""
import html, json, re, sys, time, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (NVC Knowledge Hub; librarian@example.edu)"}


def get(url):
    for n in range(3):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read().decode("utf-8", "replace")
        except Exception:
            time.sleep(5 * (n + 1))
    return ""


def text(s):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", s or "")).split())


def cards(page):
    # each publication is <div class="custom_pub_card pub_card " id="pub-NNN"> ... up to the next card
    parts = re.split(r'<div class="custom_pub_card pub_card[^"]*" id="(pub-\d+)">', page)
    out = []
    for i in range(1, len(parts), 2):
        pid, c = parts[i], parts[i + 1]
        f = lambda rx: (re.search(rx, c, re.S) or [None, ""])[1]
        out.append({
            "pid": pid,
            "title": text(f(r'<h4 class="custom_pub_title">(.*?)</h4>')),
            "oa": "custom_oa_badge" in c,
            "type": text(f(r'<span class="custom_pub_type[^"]*"[^>]*>(.*?)</span>')),
            "journal": text(f(r'<div class="custom_pub_journal">.*?<a[^>]*>(.*?)</a>')),
            "detail": text(f(r'<span class="journal_detail">(.*?)</span>')),
            "authors": re.sub(r"^Authors:\s*", "", text(f(r'<div class="custom_pub_authors">(.*?)</div>'))),
            "doi": text(f(r'class="custom_doi_link doi"[^>]*>.*?<span>(.*?)</span>')),
        })
    return out


def main():
    ids = sys.argv[1:]
    if ids[:1] == ["--ids-file"]:
        ids = json.load(open(ids[1]))
    data, total = {}, 0
    for vid in ids:
        got, page = [], 1
        while True:
            p = get(f"https://vidwan.inflibnet.ac.in/profile/{vid}?page={page}")
            c = cards(p)
            got += c
            m = re.search(r"of\s+(\d+)\s+publications", text(p))
            n = int(m.group(1)) if m else len(got)
            time.sleep(1)
            if not c or page * 8 >= n or page > 40:
                break
            page += 1
        if got:
            data[vid] = got
        total += len(got)
        print(f"{vid}: {len(got)} (Vidwan says {n})", file=sys.stderr)
    print(f"total {total} publications from {len(data)} profiles", file=sys.stderr)
    json.dump(data, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
