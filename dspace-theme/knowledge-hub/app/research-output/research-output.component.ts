import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  inject,
  Input,
  OnInit,
  PLATFORM_ID,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '@dspace/config/app-config.interface';
import { firstValueFrom } from 'rxjs';

/*
 * Knowledge Hub - Research Output (Faculty Publications community / collection page, repo.nvc.ac.in)
 * All publications in scope with search / department / year / type / full-text filters, NVC authors
 * linked to their faculty profiles, PDF / Open Access / DOI badges, Cite (MLA, APA, BibTeX), and a
 * statistics tab (per year, types, department-wise, top journals, most published faculty, access).
 */

const PROFILES_HANDLE = '123456789/17';

interface Person { uuid: string; name: string; given: string; family: string; dept: string }
interface Author { name: string; uuid: string }
interface Pub {
  uuid: string; title: string; year: string; type: string; authors: Author[]; depts: string[]; linked: string[];
  journal: string; source: string; doi: string; oaLink: string; hasPdf: boolean;
  cite: { mla: string; apa: string; bib: string };
}
interface Bar { name: string; n: number; pct: number; sub?: string; uuid?: string }

@Component({
  selector: 'ds-nvc-research-output',
  styleUrls: ['../faculty-directory/faculty-directory.component.scss', './research-output.component.scss'],
  templateUrl: './research-output.component.html',
  imports: [FormsModule, RouterLink],
})
export class ResearchOutputComponent implements OnInit {
  @Input() scopeId: string;
  @Input() title = 'Research Output';

  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private platformId = inject(PLATFORM_ID);
  private appConfig = inject(APP_CONFIG);

  tab: 'pubs' | 'stats' = 'pubs';
  loaded = false;
  failed = false;
  pubs: Pub[] = [];
  people = new Map<string, Person>();

  query = '';
  dept = '';
  year = '';
  type = '';
  fullOnly = false;
  sort: 'new' | 'old' | 'title' = 'new';
  limit = 30;
  openCite: string | null = null;
  copied: string | null = null;

  departments: string[] = [];
  years: string[] = [];
  types: string[] = [];
  kpi = { pubs: 0, faculty: 0, journals: 0, doi: 0, full: 0 };
  yearBars: { year: string; n: number; pct: number }[] = [];
  typeParts: { name: string; n: number; pct: number; cls: string }[] = [];
  deptBars: Bar[] = [];
  topJournals: Bar[] = [];
  topAuthors: Bar[] = [];
  access: Bar[] = [];

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId) || !this.scopeId) {
      return;
    }
    const api = this.appConfig.rest.baseUrl + '/api';
    this.load(api).then(() => {
      this.loaded = true;
      this.cdr.markForCheck();
    }).catch(() => {
      this.failed = true;
      this.loaded = true;
      this.cdr.markForCheck();
    });
  }

  private async fetchAll(url: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 0; page < 50; page++) {
      const r: any = await firstValueFrom(this.http.get<any>(`${url}&page=${page}`));
      const res = r?._embedded?.searchResult;
      out.push(...(res?._embedded?.objects || []).map((o: any) => o?._embedded?.indexableObject));
      if (!res || page + 1 >= (res.page?.totalPages || 0)) {
        break;
      }
    }
    return out;
  }

  private async load(api: string): Promise<void> {
    const profiles: any = await firstValueFrom(this.http.get<any>(`${api}/pid/find?id=${PROFILES_HANDLE}`)).catch(() => null);
    const [persons, items] = await Promise.all([
      profiles?.uuid ? this.fetchAll(`${api}/discover/search/objects?scope=${profiles.uuid}&dsoType=ITEM&size=100`) : Promise.resolve([]),
      this.fetchAll(`${api}/discover/search/objects?scope=${this.scopeId}&dsoType=ITEM&size=100&sort=dc.date.issued,DESC`),
    ]);
    for (const it of persons) {
      const md = it?.metadata || {};
      const v = (k: string) => (md[k]?.[0]?.value as string) || '';
      if (it?.uuid) {
        this.people.set(it.uuid, {
          uuid: it.uuid, given: v('person.givenName'), family: v('person.familyName'), dept: v('local.department') || 'Other',
          name: v('person.name.variant') || [v('person.givenName'), v('person.familyName')].filter(Boolean).join(' ') || v('dc.title'),
        });
      }
    }
    this.pubs = items.map((it) => this.toPub(it)).filter((p) => !!p);
    this.compute();
  }

  /** does the author string "Family, Given" belong to this person (allows Mandal / Mondal) */
  private same(name: string, p: Person): boolean {
    const a = name.replace(/\./g, ' ');
    let fam: string, rest: string;
    if (a.includes(',')) {
      [fam, rest] = a.split(',', 2).map((s) => s.trim());
    } else {
      const q = a.trim().split(/\s+/);
      fam = q[q.length - 1] || '';
      rest = q.slice(0, -1).join(' ');
    }
    if (!p.family || (rest[0] || '').toLowerCase() !== (p.given[0] || '').toLowerCase()) {
      return false;
    }
    const f1 = fam.toLowerCase(), f2 = p.family.toLowerCase();
    return f1 === f2 || (f1.length === f2.length && f2.length >= 4 && [...f1].filter((c, i) => c !== f2[i]).length <= 1);
  }

  private toPub(item: any): Pub {
    if (!item?.uuid) {
      return null;
    }
    const md = item.metadata || {};
    const v = (k: string) => (md[k]?.[0]?.value as string) || '';
    const linked: string[] = [...new Set<string>((md['relation.isAuthorOfPublication'] || []).map((m: any) => m.value as string))]
      .filter((u) => this.people.has(u));
    const names: string[] = (md['dc.contributor.author'] || []).map((m: any) => m.value as string);
    const authors: Author[] = names.map((n) => ({ name: n, uuid: linked.find((u) => this.same(n, this.people.get(u))) || '' }));
    for (const u of linked) {
      if (!authors.some((a) => a.uuid === u)) {
        const p = this.people.get(u);
        authors.push({ name: p.family ? `${p.family}, ${p.given}` : p.name, uuid: u });
      }
    }
    const journal = v('journal.title') || v('dc.relation.ispartof');
    const vol = v('local.journalVolume'), iss = v('local.journalIssue'), pg = v('local.pageRange');
    const source = [vol ? vol + (iss ? `(${iss})` : '') : (iss ? `No. ${iss}` : ''), pg ? `pp. ${pg}` : ''].filter(Boolean).join(', ');
    const year = (v('dc.date.issued') || '').slice(0, 4);
    const doi = (v('dc.identifier.doi') || v('local.doi')).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const oaLink = (md['dc.identifier.uri'] || []).map((m: any) => m.value as string).find((u: string) => !u.includes('repo.nvc.ac.in')) || '';
    const title = v('dc.title');
    const allNames = authors.map((a) => a.name);
    return {
      uuid: item.uuid, title, year, type: v('local.publicationType') || 'Other', authors, linked,
      depts: [...new Set(linked.map((u) => this.people.get(u).dept))],
      journal, source, doi, oaLink, hasPdf: !!v('dc.rights'),
      cite: this.cite(allNames, title, journal, vol, iss, pg, year, doi),
    };
  }

  // ------------------------------------------------------------ statistics
  private compute(): void {
    const p = this.pubs;
    const tally = (arr: string[]) => Object.entries(arr.reduce((m: Record<string, number>, k) => { m[k] = (m[k] || 0) + 1; return m; }, {}))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const bars = (rows: { name: string; n: number; sub?: string; uuid?: string }[]): Bar[] => {
      const max = Math.max(1, ...rows.map((r) => r.n));
      return rows.map((r) => ({ ...r, pct: r.n ? Math.max(3, Math.round(100 * r.n / max)) : 0 }));
    };
    const journals = tally(p.map((x) => x.journal.trim()).filter(Boolean));
    const authorIds = tally(p.flatMap((x) => x.linked));

    this.departments = [...new Set(p.flatMap((x) => x.depts))].sort();
    this.years = [...new Set(p.map((x) => x.year).filter(Boolean))].sort().reverse();
    this.types = tally(p.map((x) => x.type)).map(([t]) => t);
    this.kpi = {
      pubs: p.length,
      faculty: authorIds.length,
      journals: journals.length,
      doi: p.filter((x) => x.doi).length,
      full: p.filter((x) => x.hasPdf || x.oaLink).length,
    };

    const ys = p.map((x) => +x.year).filter((y) => y > 1900);
    this.yearBars = [];
    if (ys.length) {
      const hi = Math.max(...ys), lo = Math.max(Math.min(...ys), hi - 14);
      const c: Record<number, number> = {};
      ys.forEach((y) => c[y] = (c[y] || 0) + 1);
      const max = Math.max(...Object.values(c));
      for (let y = lo; y <= hi; y++) {
        this.yearBars.push({ year: String(y), n: c[y] || 0, pct: c[y] ? Math.max(6, Math.round(100 * c[y] / max)) : 2 });
      }
    }

    const classes = ['t1', 't2', 't3', 't4'];
    const types = tally(p.map((x) => x.type));
    const main = types.slice(0, 3);
    const rest = types.slice(3).reduce((s, [, n]) => s + n, 0);
    if (rest) {
      main.push(['Other', rest]);
    }
    this.typeParts = main.map(([name, n], i) => ({ name, n, pct: p.length ? 100 * n / p.length : 0, cls: classes[i] }));

    this.deptBars = bars(tally(p.flatMap((x) => x.depts)).map(([name, n]) => {
      const fac = new Set(p.filter((x) => x.depts.includes(name)).flatMap((x) => x.linked.filter((u) => this.people.get(u).dept === name)));
      return { name, n, sub: `${fac.size} contributing faculty` };
    }));
    this.topJournals = bars(journals.slice(0, 8).map(([name, n]) => ({ name, n })));
    this.topAuthors = bars(authorIds.slice(0, 8).map(([u, n]) => ({ name: this.people.get(u).name, n, sub: this.people.get(u).dept, uuid: u })));
    const acc = (name: string, n: number) => ({ name, n, pct: p.length ? Math.round(100 * n / p.length) : 0, sub: `${n} of ${p.length}` });
    this.access = [
      acc('With DOI', this.kpi.doi),
      acc('Full text (PDF) in Knowledge Hub', p.filter((x) => x.hasPdf).length),
      acc('Open-access link', p.filter((x) => !x.hasPdf && x.oaLink).length),
    ];
  }

  // ------------------------------------------------------------ list
  get filtered(): Pub[] {
    const q = this.query.trim().toLowerCase();
    const list = this.pubs.filter((x) =>
      (!this.dept || x.depts.includes(this.dept))
      && (!this.year || x.year === this.year)
      && (!this.type || x.type === this.type)
      && (!this.fullOnly || x.hasPdf || !!x.oaLink)
      && (!q || [x.title, x.journal, x.year, x.doi, ...x.authors.map((a) => a.name)].join(' ').toLowerCase().includes(q)));
    if (this.sort === 'title') {
      return list.sort((a, b) => a.title.localeCompare(b.title));
    }
    const dir = this.sort === 'old' ? 1 : -1;
    return list.sort((a, b) => dir * ((a.year || '0').localeCompare(b.year || '0')) || a.title.localeCompare(b.title));
  }

  get groups(): { year: string; items: Pub[] }[] {
    const out: { year: string; items: Pub[] }[] = [];
    for (const x of this.filtered.slice(0, this.limit)) {
      const key = this.sort === 'title' ? '' : (x.year || 'Undated');
      if (!out.length || out[out.length - 1].year !== key) {
        out.push({ year: key, items: [] });
      }
      out[out.length - 1].items.push(x);
    }
    return out;
  }

  get hasFilter(): boolean {
    return !!(this.query || this.dept || this.year || this.type || this.fullOnly);
  }

  changed(): void {
    this.limit = 30;
  }

  clear(): void {
    this.query = this.dept = this.year = this.type = '';
    this.fullOnly = false;
    this.changed();
  }

  showDept(d: string): void {
    this.clear();
    this.dept = d;
    this.tab = 'pubs';
  }

  showYear(y: string): void {
    this.clear();
    this.year = y;
    this.tab = 'pubs';
  }

  toggleCite(id: string): void {
    this.openCite = this.openCite === id ? null : id;
  }

  copy(text: string, id: string): void {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        this.copied = id;
        this.cdr.markForCheck();
        setTimeout(() => { if (this.copied === id) { this.copied = null; this.cdr.markForCheck(); } }, 1800);
      }, () => undefined);
    }
  }

  // ------------------------------------------------------------ citations (authors stored "Last, First")
  private cite(authors: string[], title: string, journal: string, vol: string, iss: string, pg: string, year: string, doi: string) {
    const split = (a: string) => { const [l, f] = a.split(',').map((s) => (s || '').trim()); return { l, f: f || '' }; };
    const ini = (f: string) => f.split(/[\s.]+/).filter(Boolean).map((x) => x[0].toUpperCase() + '.').join(' ');
    let who = '';
    if (authors.length === 1) {
      who = authors[0];
    } else if (authors.length === 2) {
      const b = split(authors[1]);
      who = `${authors[0]}, and ${[b.f, b.l].filter(Boolean).join(' ')}`;
    } else if (authors.length > 2) {
      who = `${authors[0]}, et al`;
    }
    const mla = [who ? `${who.replace(/\.$/, '')}.` : '', `“${title}.”`,
      [journal, vol ? `vol. ${vol}` : '', iss ? `no. ${iss}` : '', year, pg ? `pp. ${pg}` : ''].filter(Boolean).join(', ')].filter(Boolean).join(' ').replace(/,?\s*$/, '') + '.';
    const names = authors.map((a) => { const s = split(a); return `${s.l}, ${ini(s.f)}`.replace(/,\s*$/, ''); });
    const apaWho = names.length > 1 ? `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}` : (names[0] || '');
    let src = journal;
    if (vol) { src += `, ${vol}${iss ? `(${iss})` : ''}`; }
    if (pg) { src += `, ${pg}`; }
    const apa = [apaWho, `(${year || 'n.d.'}).`, `${title}.`, src ? `${src}.` : '', doi ? `https://doi.org/${doi}` : ''].filter(Boolean).join(' ');
    const key = ((split(authors[0] || 'item').l || 'item').toLowerCase().replace(/[^a-z]/g, '') || 'item') + (year || '');
    const f = (k: string, val?: string) => (val ? `  ${k} = {${val}},\n` : '');
    const bib = `@article{${key},\n` + f('author', authors.join(' and ')) + f('title', title) + f('journal', journal)
      + f('volume', vol) + f('number', iss) + f('pages', pg) + f('year', year) + f('doi', doi) + '}';
    return { mla, apa, bib };
  }
}
