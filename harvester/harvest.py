#!/usr/bin/env python3
"""NVC Knowledge Hub - daily faculty publication harvester (runs inside CT101 as root).

For every Faculty Profile (Person entity) in DSpace it collects publications from
  1. ORCID public API      - the person's own curated works list         (person.identifier.orcid)
  (OpenAlex is NOT used to discover works - its author attribution mixes up same-name authors -
   it is used only by DOI for keywords, abstracts and open-access copies)
  3. Scopus Search API     - only if an Elsevier API key is configured   (person.identifier.scopus-author-id)
  4. Web of Science Starter- only if a Clarivate API key is configured   (person.identifier.rid)
Google Scholar has no API and its terms forbid automated harvesting, so it is not used.

ORCID only supplies the bibliographic list (title, year, DOI). Every work is then enriched BY DOI:
full metadata from Crossref, keywords/abstract from OpenAlex, open-access copy from OpenAlex and
Unpaywall (works without a DOI get one from Crossref by exact title + year). Each new work is checked against everything already in the
repository (DOI, or normalised title + year), and published immediately into Faculty Publications as
a Publication entity linked to its NVC author profile(s). Open-access PDFs are attached only when the
copy carries an open licence (CC / public domain); otherwise only a link to the free copy is stored.

One-off backfill from Vidwan: --vidwan-json FILE takes the publication lists read from the faculty's
public Vidwan pages ({vidwanId: [{title, year, journal, detail, authors, doi, type, oa}, ...]}); those
works go through the same DOI enrichment, duplicate check and profile linking. A work listed on several
NVC faculty pages becomes ONE item linked to all of them.

usage: harvest.py [--dry-run] [--only VIDWAN_ID] [--limit N] [--vidwan-json FILE] [--config /opt/nvc-harvester/harvester.json]
"""
import argparse, csv, datetime, difflib, html, json, os, re, shutil, smtplib, subprocess, sys
import tempfile, time, urllib.error, urllib.parse, urllib.request
from email.message import EmailMessage
from xml.sax.saxutils import escape

TODAY = datetime.date.today().isoformat()
OPEN_LICENCES = re.compile(r"^(cc[-_ ]|cc0|public[-_ ]domain|pd$)", re.I)
TYPE_MAP = {  # ORCID / OpenAlex / Crossref types -> local.publicationType vocabulary
    "journal-article": "Journal Article", "article": "Journal Article",
    "book-chapter": "Book Chapter", "book": "Book", "monograph": "Book", "edited-book": "Book",
    "conference-paper": "Conference Paper", "proceedings-article": "Conference Paper",
    "book-review": "Book Review", "review": "Journal Article",
}
VIDWAN_TYPES = {"journal article": "Journal Article", "book chapter": "Book Chapter", "book": "Book",
                "conference paper": "Conference Paper", "note": "Journal Article", "review": "Journal Article"}
LOG = []


def log(*a):
    line = " ".join(str(x) for x in a)
    LOG.append(line)
    print(line, flush=True)


# ------------------------------------------------------------------ helpers
class Http:
    def __init__(self, mailto):
        self.ua = f"NVC-Knowledge-Hub-Harvester/1.0 (https://repo.nvc.ac.in; mailto:{mailto})"
        self.mailto = mailto

    def get(self, url, headers=None, raw=False, tries=3):
        h = {"User-Agent": self.ua, "Accept": "application/json"}
        h.update(headers or {})
        for n in range(tries):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
                    data = r.read()
                    return data if raw else json.loads(data)
            except urllib.error.HTTPError as e:
                if e.code in (404, 400, 401, 403):
                    return None
                time.sleep(3 * (n + 1))
            except Exception:
                time.sleep(3 * (n + 1))
        return None


def norm_title(t):
    t = html.unescape(re.sub(r"<[^>]+>", "", t or ""))
    return re.sub(r"[^a-z0-9]", "", t.lower())


def same_title(a, b):
    a, b = norm_title(a), norm_title(b)
    if not a or not b:
        return False
    return a == b or difflib.SequenceMatcher(None, a, b).ratio() >= 0.93 or \
        (len(a) > 40 and (a.startswith(b) or b.startswith(a)))


def clean_doi(d):
    d = (d or "").strip()
    d = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", d, flags=re.I)
    return d.lower()


def strip_tags(t):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t or ""))).strip()


def inv_abstract(ix):
    return " ".join(w for _, w in sorted((p, w) for w, ps in (ix or {}).items() for p in ps))


def last_first(name):
    name = " ".join((name or "").split())
    if "," in name or len(name.split()) < 2:
        return name
    p = name.split()
    return f"{p[-1]}, {' '.join(p[:-1])}"


def psql(sql):
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(sql)
    os.chmod(f.name, 0o644)
    try:
        out = subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-d", "dspace", "-At", "-F", "\t",
                              "-f", f.name], capture_output=True, text=True, check=True).stdout
    finally:
        os.unlink(f.name)
    return [line.split("\t") for line in out.splitlines() if line.strip()]


# ------------------------------------------------------------------ repository state
def load_people():
    rows = psql("""
select i.uuid, h.handle,
  max(case when s.short_id='dc' and f.element='title' then mv.text_value end),
  max(case when s.short_id='person' and f.element='identifier' and f.qualifier='orcid' then mv.text_value end),
  max(case when s.short_id='person' and f.element='identifier' and f.qualifier='scopus-author-id' then mv.text_value end),
  max(case when s.short_id='person' and f.element='identifier' and f.qualifier='rid' then mv.text_value end),
  max(case when s.short_id='local' and f.element='vidwanId' then mv.text_value end),
  max(case when s.short_id='local' and f.element='department' then mv.text_value end),
  max(case when s.short_id='person' and f.element='givenName' then mv.text_value end),
  max(case when s.short_id='person' and f.element='familyName' then mv.text_value end)
from item i join handle h on h.resource_id=i.uuid
join metadatavalue mv on mv.dspace_object_id=i.uuid
join metadatafieldregistry f on f.metadata_field_id=mv.metadata_field_id
join metadataschemaregistry s on s.metadata_schema_id=f.metadata_schema_id
where i.in_archive and not i.withdrawn
  and i.uuid in (select m.dspace_object_id from metadatavalue m join metadatafieldregistry g on g.metadata_field_id=m.metadata_field_id
                 where g.element='entity' and g.qualifier='type' and m.text_value='Person')
group by i.uuid, h.handle;""")
    keys = ["uuid", "handle", "name", "orcid", "scopus", "rid", "vidwan", "dept", "given", "family"]
    return [dict(zip(keys, [x or "" for x in r])) for r in rows]


def load_existing():
    """DOIs and (title, year) of everything already in the repository"""
    rows = psql("""
select i.uuid,
  string_agg(case when (s.short_id='dc' and f.element='identifier' and f.qualifier='doi')
                    or (s.short_id='local' and f.element='doi')
                    or (s.short_id='dc' and f.element='relation' and f.qualifier='hasversion') then mv.text_value end, '|'),
  max(case when s.short_id='dc' and f.element='title' and f.qualifier is null then mv.text_value end),
  max(case when s.short_id='dc' and f.element='date' and f.qualifier='issued' then mv.text_value end)
from item i join metadatavalue mv on mv.dspace_object_id=i.uuid
join metadatafieldregistry f on f.metadata_field_id=mv.metadata_field_id
join metadataschemaregistry s on s.metadata_schema_id=f.metadata_schema_id
where not i.withdrawn
  and i.uuid in (select m.dspace_object_id from metadatavalue m join metadatafieldregistry g on g.metadata_field_id=m.metadata_field_id
                 where g.element='entity' and g.qualifier='type' and m.text_value='Publication')
group by i.uuid;""")
    dois, titles = set(), []
    for r in rows:
        for d in (r[1] or "").split("|"):
            if clean_doi(d):
                dois.add(clean_doi(d))
        titles.append((r[2] or "", (r[3] or "")[:4]))
    return dois, titles


# ------------------------------------------------------------------ sources
def from_orcid(http, person):
    """works listed on the person's ORCID record (summaries)"""
    d = http.get(f"https://pub.orcid.org/v3.0/{person['orcid']}/works")
    out = []
    for g in (d or {}).get("group", []):
        s = (g.get("work-summary") or [{}])[0]
        if (s.get("type") or "").lower() in ("data-set", "software", "physical-object"):
            continue
        title = (((s.get("title") or {}).get("title") or {}).get("value")) or ""
        ids = {e["external-id-type"]: e["external-id-value"] for e in (s.get("external-ids") or {}).get("external-id", [])}
        year = (((s.get("publication-date") or {}).get("year") or {}).get("value")) or ""
        out.append({"title": title, "doi": clean_doi(ids.get("doi")), "year": year,
                    "journal": ((s.get("journal-title") or {}).get("value")) or "",
                    "type": TYPE_MAP.get((s.get("type") or "").lower(), "Other" if s.get("type") else ""),
                    "source": f"ORCID {person['orcid']} put-code {s.get('put-code')}"})
    return out


def from_openalex(http, person):
    out, cursor = [], "*"
    while cursor:
        d = http.get(f"https://api.openalex.org/works?filter=author.orcid:{person['orcid']}"
                     f"&per-page=100&cursor={cursor}&mailto={http.mailto}")
        if not d:
            break
        for w in d.get("results", []):
            out.append({"title": w.get("title") or "", "doi": clean_doi(w.get("doi")),
                        "year": str(w.get("publication_year") or ""), "openalex": w,
                        "source": f"OpenAlex {w.get('id', '').rsplit('/', 1)[-1]}"})
        cursor = d.get("meta", {}).get("next_cursor")
    return out


def from_scopus(http, person, key):
    if not key or not person["scopus"]:
        return []
    d = http.get(f"https://api.elsevier.com/content/search/scopus?query=AU-ID({person['scopus']})&count=200",
                 headers={"X-ELS-APIKey": key})
    out = []
    for e in ((d or {}).get("search-results") or {}).get("entry", []):
        if e.get("error"):
            continue
        out.append({"title": e.get("dc:title", ""), "doi": clean_doi(e.get("prism:doi")),
                    "year": (e.get("prism:coverDate") or "")[:4], "journal": e.get("prism:publicationName", ""),
                    "source": f"Scopus {e.get('eid', '')}"})
    return out


def from_wos(http, person, key):
    if not key or not person["rid"]:
        return []
    q = urllib.parse.quote(f"AI={person['rid']}")
    d = http.get(f"https://api.clarivate.com/apis/wos-starter/v1/documents?q={q}&limit=50",
                 headers={"X-ApiKey": key})
    out = []
    for h in (d or {}).get("hits", []):
        out.append({"title": h.get("title", ""), "doi": clean_doi((h.get("identifiers") or {}).get("doi")),
                    "year": str((h.get("source") or {}).get("publishYear") or ""),
                    "journal": (h.get("source") or {}).get("sourceTitle", ""), "source": f"WoS {h.get('uid', '')}"})
    return out


def from_vidwan(person, data):
    """works read from the person's public Vidwan profile (one-off backfill file)"""
    out = []
    for v in data.get(person["vidwan"], []):
        det = v.get("detail") or ""
        g = lambda rx: (re.search(rx, det) or [None, ""])[1].strip(" .,")
        out.append({"title": v.get("title") or "", "doi": clean_doi(v.get("doi")),
                    "year": g(r"Year:\s*(\d{4})"), "journal": v.get("journal") or "",
                    "type": VIDWAN_TYPES.get((v.get("type") or "").lower(), "Other" if v.get("type") else ""),
                    "volume": g(r"Volume:\s*([^,]+)"), "issue": g(r"Issue:\s*([^,]+)"), "pages": g(r"Pages:\s*([^,]+?)\s*\.?$"),
                    "authors_raw": list(dict.fromkeys(a.strip() for a in re.split(r"\s*;\s*", v.get("authors") or "") if a.strip())),
                    "source": f"Vidwan {person['vidwan']} {v.get('pid', '')}".strip()})
    return out


# ------------------------------------------------------------------ enrichment
def enrich(http, w):
    """fill a work from Crossref (by DOI) and OpenAlex (by DOI); keep only title-consistent records"""
    cr = oa = None
    if not w["doi"] and w["title"] and w["year"]:
        # ORCID gave no DOI: look it up in Crossref by exact title + year
        q = urllib.parse.quote(w["title"][:250])
        c = http.get(f"https://api.crossref.org/works?query.bibliographic={q}&rows=5"
                     f"&filter=from-pub-date:{w['year']},until-pub-date:{w['year']}")
        for it in ((c or {}).get("message") or {}).get("items", []):
            if same_title((it.get("title") or [""])[0], w["title"]):
                w["doi"] = clean_doi(it.get("DOI"))
                w["source"] += "; DOI found in Crossref by title"
                break
    if w["doi"]:
        c = http.get("https://api.crossref.org/works/" + urllib.parse.quote(w["doi"]))
        cr = (c or {}).get("message")
        oa = w.get("openalex") or http.get(f"https://api.openalex.org/works/doi:{w['doi']}?mailto={http.mailto}")
    else:
        oa = w.get("openalex")
    if cr and w["title"] and not same_title((cr.get("title") or [""])[0], w["title"]):
        log("   ! Crossref title differs, Crossref data not used:", w["title"][:70])
        cr = None
    if oa and w["title"] and not same_title(oa.get("title"), w["title"]):
        oa = None
    cr, oa = cr or {}, oa or {}
    title = w["title"] or (cr.get("title") or [""])[0] or oa.get("title") or ""
    src = (oa.get("primary_location") or {}).get("source") or {}
    journal = (cr.get("container-title") or [""])[0] or w.get("journal") or src.get("display_name") or ""
    # (name, ORCID) pairs - the ORCID lets us recognise the linked NVC author even if spelt differently
    authors = [(f"{a.get('family', '')}, {a.get('given', '')}".strip(", "), (a.get("ORCID") or "").rsplit("/", 1)[-1].upper())
               for a in cr.get("author", []) if a.get("family")]
    if not authors:
        authors = [(last_first((a.get("author") or {}).get("display_name")),
                    ((a.get("author") or {}).get("orcid") or "").rsplit("/", 1)[-1].upper())
                   for a in oa.get("authorships", [])]
    if not authors and w.get("authors_raw"):
        # no Crossref / OpenAlex record: keep the author list as given by the source (Vidwan)
        authors = [(last_first(a), "") for a in w["authors_raw"]]
    author_orcids = {((a.get("author") or {}).get("orcid") or "").rsplit("/", 1)[-1].upper()
                     for a in oa.get("authorships", [])}
    author_orcids |= {(a.get("ORCID") or "").rsplit("/", 1)[-1].upper() for a in cr.get("author", []) if a.get("ORCID")}
    year = w["year"] or str(((cr.get("issued") or {}).get("date-parts") or [[""]])[0][0] or oa.get("publication_year") or "")
    ptype = w.get("type") or TYPE_MAP.get((cr.get("type") or "").lower(), "")
    if not ptype and oa.get("type"):
        ptype = "Conference Paper" if src.get("type") == "conference" else TYPE_MAP.get(oa["type"], "Other")
    abstract = re.sub(r"^(Abstract|ABSTRACT)\s*[:.]?\s*", "", strip_tags(cr.get("abstract")) or inv_abstract(oa.get("abstract_inverted_index")))
    best = oa.get("best_oa_location") or {}
    licence = (best.get("license") or "").strip()
    pdf_url, page_url = best.get("pdf_url") or "", best.get("landing_page_url") or ""
    is_oa = bool((oa.get("open_access") or {}).get("is_oa"))
    doi = w["doi"] or clean_doi(cr.get("DOI"))
    if doi and not (pdf_url and OPEN_LICENCES.match(licence)):
        # Unpaywall: the standard open-access finder, looked up by DOI
        u = http.get(f"https://api.unpaywall.org/v2/{urllib.parse.quote(doi)}?email={http.mailto}") or {}
        is_oa = is_oa or bool(u.get("is_oa"))
        for loc in [u.get("best_oa_location") or {}] + (u.get("oa_locations") or []):
            if loc.get("url_for_pdf") and OPEN_LICENCES.match(loc.get("license") or ""):
                pdf_url, licence, page_url = loc["url_for_pdf"], loc["license"], loc.get("url_for_landing_page") or loc.get("url") or page_url
                break
        else:
            if not page_url and (u.get("best_oa_location") or {}).get("url"):
                page_url = u["best_oa_location"]["url"]
    return {
        "title": " ".join(strip_tags(title).split()), "year": str(year)[:4], "doi": doi,
        "journal": journal, "issn": cr.get("ISSN") or [], "publisher": cr.get("publisher", ""),
        "volume": cr.get("volume") or w.get("volume", ""), "issue": cr.get("issue") or w.get("issue", ""),
        "pages": cr.get("page") or w.get("pages", ""),
        "authors": authors, "author_orcids": {o for o in author_orcids if o}, "type": ptype,
        "abstract": abstract, "keywords": [k["display_name"] for k in (oa.get("keywords") or [])[:6]],
        "language": oa.get("language") or "en",
        "oa_pdf": pdf_url, "oa_page": page_url, "licence": licence, "is_oa": is_oa,
        "source": w["source"],
    }


def is_person(author, given, family):
    """same person by name: same first initial and the same (or near-identical) family name,
    so spelling variants such as Mandal / Mondal are recognised"""
    a = author.replace(".", " ")
    if "," in a:
        fam, rest = [x.strip() for x in a.split(",", 1)]
    else:
        q = a.split()
        fam, rest = (q[-1], " ".join(q[:-1])) if q else ("", "")
    if not family or rest[:1].lower() != (given or "")[:1].lower():
        return False
    f1, f2 = fam.lower(), family.lower()
    return f1 == f2 or (len(f2) >= 4 and difflib.SequenceMatcher(None, f1, f2).ratio() >= 0.8)


def is_linked(author, orcid, linked):
    return any((orcid and p["orcid"] and orcid == p["orcid"].upper()) or is_person(author, p["given"], p["family"])
               for p in linked)


# ------------------------------------------------------------------ SAF writing
def dcxml(schema, vals):
    body = "".join(f'  <dcvalue element="{e}" qualifier="{q}">{escape(v)}</dcvalue>\n' for e, q, v in vals if v)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<dublin_core schema="{schema}">\n{body}</dublin_core>\n'


def write_item(http, d, n, rec, linked, main_person):
    item = os.path.join(d, f"item_{n:03d}")
    os.makedirs(item)
    # NVC authors are shown through their linked profiles; drop their plain-text duplicates
    authors = [a for a, orcid in rec["authors"] if not is_linked(a, orcid, linked)]
    vol_part = (rec["volume"] + (f"({rec['issue']})" if rec["issue"] else "")) if rec["volume"] else ""
    citation = ", ".join(x for x in [rec["journal"], vol_part, f"pp. {rec['pages']}" if rec["pages"] else "", rec["year"]] if x)
    pdf_name, rights = "", []
    if rec["oa_pdf"] and OPEN_LICENCES.match(rec["licence"] or ""):
        data = http.get(rec["oa_pdf"], headers={"Accept": "application/pdf"}, raw=True)
        if data and data[:4] == b"%PDF" and len(data) < 60 * 1024 * 1024:
            pdf_name = re.sub(r"[^A-Za-z0-9._-]+", "_", (rec["doi"] or rec["title"])[:80]) + ".pdf"
            open(os.path.join(item, pdf_name), "wb").write(data)
            lic = rec["licence"].upper().replace("CC-", "CC ").replace("-", " ")
            rights = [("rights", "none", f"Open access; licence: {lic}"), ("rights", "uri", rec["oa_page"] or rec["oa_pdf"])]
        else:
            pdf_name = ""
    with open(os.path.join(item, "contents"), "w") as f:
        if pdf_name:
            f.write(f"{pdf_name}\tbundle:ORIGINAL\n")
    oa_link = rec["oa_page"] or rec["oa_pdf"] if (rec["is_oa"] and not pdf_name) else ""
    open(os.path.join(item, "dublin_core.xml"), "w", encoding="utf-8").write(dcxml("dc", [
        ("title", "none", rec["title"]), ("date", "issued", rec["year"]),
        ("identifier", "doi", rec["doi"]), ("identifier", "citation", citation),
        ("identifier", "uri", oa_link), ("publisher", "none", rec["publisher"]),
        ("description", "abstract", rec["abstract"]), ("language", "iso", rec["language"]),
    ] + rights + [("contributor", "author", a) for a in authors] + [("subject", "none", k) for k in rec["keywords"]]))
    open(os.path.join(item, "metadata_journal.xml"), "w", encoding="utf-8").write(dcxml("journal", [
        ("title", "none", rec["journal"])] + [("identifier", "issn", i) for i in rec["issn"]]))
    open(os.path.join(item, "metadata_local.xml"), "w", encoding="utf-8").write(dcxml("local", [
        ("publicationType", "none", rec["type"]), ("journalVolume", "none", rec["volume"]),
        ("journalIssue", "none", rec["issue"]), ("pageRange", "none", rec["pages"]),
        ("department", "none", main_person["dept"]), ("vidwanId", "none", main_person["vidwan"]),
        ("accessLevel", "none", "Public"), ("harvestSource", "none", f"{rec['source']}; harvested {TODAY}"),
    ]))
    open(os.path.join(item, "metadata_dspace.xml"), "w", encoding="utf-8").write(dcxml("dspace", [("entity", "type", "Publication")]))
    with open(os.path.join(item, "relationships"), "w") as f:
        for p in linked:
            f.write(f"relation.isAuthorOfPublication {p['handle']}\n")
    return bool(pdf_name)


# ------------------------------------------------------------------ report
def send_report(cfg, subject, body):
    to = cfg.get("report_to")
    if not to:
        return
    props = {}
    for line in open("/dspace/config/local.cfg", encoding="utf-8", errors="replace"):
        m = re.match(r"\s*(mail\.[\w.]+)\s*=\s*(.*?)\s*$", line)
        if m:
            props[m.group(1)] = m.group(2)
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, props.get("mail.from.address", "dspace-admin@example.edu"), to
    msg.set_content(body)
    try:
        with smtplib.SMTP(props.get("mail.server", "localhost"), int(props.get("mail.server.port", "587")), timeout=60) as s:
            if "starttls.enable=true" in props.get("mail.extraproperties", ""):
                s.starttls()
            if props.get("mail.server.username"):
                s.login(props["mail.server.username"], props.get("mail.server.password", ""))
            s.send_message(msg)
    except Exception as e:
        log("report email failed:", e)


def attach(new, person, doi, title, year):
    """a work already found in THIS run for another NVC author: link this person to it too"""
    for rec, linked, _ in new:
        if (doi and doi == rec["doi"]) or (same_title(title, rec["title"]) and (not year or not rec["year"] or year == rec["year"])):
            if person not in linked:
                linked.append(person)
            return True
    return False


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only")
    ap.add_argument("--limit", type=int, help="override max_new_per_run (e.g. for the first backfill)")
    ap.add_argument("--config", default="/opt/nvc-harvester/harvester.json")
    ap.add_argument("--vidwan-json", help="one-off backfill: publication lists read from Vidwan profiles")
    a = ap.parse_args()
    cfg = json.load(open(a.config))
    http = Http(cfg["contact_email"])
    log(f"== NVC publication harvester {datetime.datetime.now():%Y-%m-%d %H:%M} {'(DRY RUN)' if a.dry_run else ''}")

    people = load_people()
    by_orcid = {p["orcid"].upper(): p for p in people if p["orcid"]}
    dois, titles = load_existing()
    vidwan = json.load(open(a.vidwan_json, encoding="utf-8")) if a.vidwan_json else {}
    log(f"profiles {len(people)} (ORCID {len(by_orcid)}, Scopus {sum(1 for p in people if p['scopus'])}, "
        f"ResearcherID {sum(1 for p in people if p['rid'])}); publications already in repository {len(titles)}")

    new = []  # (record, linked people, main person)
    seen_doi, seen_title = set(dois), list(titles)
    for p in people:
        if a.only and p["vidwan"] != a.only:
            continue
        works = []
        if p["orcid"]:
            # discovery = the person's own (curated) ORCID record only; OpenAlex's author
            # attribution produced false matches (same-name authors), so it is used only BY DOI
            works += from_orcid(http, p)
        works += from_scopus(http, p, cfg.get("scopus_api_key", ""))
        works += from_wos(http, p, cfg.get("wos_api_key", ""))
        works += from_vidwan(p, vidwan)
        if not works:
            continue
        added = 0
        for w in works:
            if not w["title"] and not w["doi"]:
                continue
            if attach(new, p, w["doi"], w["title"], w["year"]):
                continue
            if w["doi"] and w["doi"] in seen_doi:
                continue
            if any(same_title(w["title"], t) and (not w["year"] or not y or w["year"] == y) for t, y in seen_title):
                continue
            rec = enrich(http, w)
            if not rec["title"]:
                continue
            if attach(new, p, rec["doi"], rec["title"], rec["year"]):
                continue
            if rec["doi"] and rec["doi"] in seen_doi:
                continue
            if any(same_title(rec["title"], t) and (not rec["year"] or not y or rec["year"] == y) for t, y in seen_title):
                continue
            linked = [p] + [by_orcid[o] for o in rec["author_orcids"] if o in by_orcid and by_orcid[o] is not p]
            new.append((rec, linked, p))
            if rec["doi"]:
                seen_doi.add(rec["doi"])
            seen_title.append((rec["title"], rec["year"]))
            added += 1
            time.sleep(0.3)
        if added:
            log(f"  {p['name']}: {added} new")
        time.sleep(0.5)

    limit = a.limit or int(cfg.get("max_new_per_run", 50))
    if len(new) > limit:
        log(f"!! {len(new)} new works found; safety limit {limit} - only the first {limit} are published today")
        new = new[:limit]
    if not new:
        log("nothing new today")
        print("\n".join(LOG[-1:]))
        return

    lines = []
    for rec, linked, p in new:
        oa = "OA-PDF" if rec["oa_pdf"] and OPEN_LICENCES.match(rec["licence"] or "") else ("OA-link" if rec["is_oa"] else "")
        lines.append(f"- {rec['title'][:110]} ({rec['year']}) | {', '.join(x['name'] for x in linked)} | "
                     f"{rec['doi'] or 'no DOI'} | {rec['source']} {oa}")
    log(f"new publications: {len(new)}")
    for l in lines:
        log(l)
    if a.dry_run:
        return

    root = cfg.get("work_dir", "/home/dspace/harvest")
    batch = os.path.join(root, f"harvest-{datetime.datetime.now():%Y%m%d-%H%M}")
    os.makedirs(batch)
    pdfs = sum(write_item(http, batch, n, rec, linked, p) for n, (rec, linked, p) in enumerate(new, 1))
    subprocess.run(["chown", "-R", "dspace:dspace", root], check=True)
    mapfile = batch + ".mapfile"
    r = subprocess.run(["runuser", "-u", "dspace", "--", "/dspace/bin/dspace", "import", "-a",
                        "-e", cfg["admin_email"], "-c", cfg["collection_handle"], "-s", batch, "-m", mapfile],
                       capture_output=True, text=True)
    ok = r.returncode == 0 and os.path.exists(mapfile)
    imported = sum(1 for _ in open(mapfile)) if ok else 0
    log(f"import {'OK' if ok else 'FAILED'}: {imported} published, {pdfs} with open-licence PDF; mapfile {mapfile}")
    if not ok:
        log(r.stdout[-2000:], r.stderr[-2000:])
    send_report(cfg, f"[NVC Knowledge Hub] {imported} new faculty publication(s) harvested" if ok else
                "[NVC Knowledge Hub] publication harvester FAILED", "\n".join(LOG))


if __name__ == "__main__":
    main()
