import {
  DecimalPipe,
  isPlatformBrowser,
  NgTemplateOutlet,
} from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  Inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ActivatedRoute,
  Router,
  RouterLink,
} from '@angular/router';
import { Subscription } from 'rxjs';
import {
  APP_CONFIG,
  AppConfig,
} from '@dspace/config/app-config.interface';

/*
 * Knowledge Hub home page — repo.nvc.ac.in
 * Built from dspace-metadata/homepage/homepage-mockup.html. Every number and list on this page is
 * read live from the public REST API in the visitor's browser; nothing is hard-coded or invented:
 *  - community counts / totals: Discovery searches scoped to each community;
 *  - recent items: Discovery sorted by dc.date.accessioned, 3 per column;
 *  - citations (MLA / APA / BibTeX): generated from the item's own metadata;
 *  - "Cited by": only when the item has a DOI and Crossref returns a count;
 *  - downloads (30 days): assets/nvc-stats.json, written hourly on the server from DSpace's own
 *    usage statistics (Solr).
 * Administrative Records is deliberately not referenced (confidential, login-restricted).
 */

interface Community {
  key: string;
  name: string;
  description: string;
  handle: string;
  uuid: string;
  unit: string;
  count?: number;
}

interface Cite { mla: string; apa: string; bib: string; }

interface Recent {
  uuid: string;
  title: string;
  meta?: string;
  pdf?: string;
  cite?: Cite;
  doi?: string;
  citedBy?: number;
  subject?: string;
}

interface Column {
  key: string;
  heading: string;
  scope: string;
  handle: string;
  viewAll: string;
  kind: 'paper' | 'pub';
  items?: Recent[];
  loaded?: boolean;
}

@Component({
  selector: 'ds-themed-home-page',
  styleUrls: ['./home-page.component.scss'],
  templateUrl: './home-page.component.html',
  imports: [
    DecimalPipe,
    FormsModule,
    NgTemplateOutlet,
    RouterLink,
  ],
})
export class HomePageComponent implements OnInit, AfterViewInit, OnDestroy {

  query = '';
  totalItems?: number;
  publicCommunities?: number;
  downloads30?: number;
  copied: string | null = null;

  readonly communities: Community[] = [
    { key: 'question-papers', name: 'Old Question Paper Archive', handle: '123456789/20', uuid: 'a0a1badb-81d8-41c9-9b28-d554bfc664ca', unit: 'items',
      description: 'Previous-year UG and PG question papers, CBCS and NEP-2020.' },
    { key: 'publications', name: 'Faculty Publications', handle: '123456789/18', uuid: 'a42013b2-51e5-4fbb-9abd-8cb4068031c4', unit: 'items',
      description: 'Journal articles, book chapters, and conference papers by NVC faculty.' },
    { key: 'profiles', name: 'Faculty Profiles', handle: '123456789/16', uuid: '0d0a38e2-21d1-4d7d-ac21-3620502c07af', unit: 'profiles',
      description: 'Researcher profiles with linked publications, by department.' },
    { key: 'journal', name: "Teachers' Journal", handle: '123456789/35', uuid: 'b662adb2-81ab-46ed-8048-eee3d22d7549', unit: 'items',
      description: "Articles published in NVC's own teachers' journal." },
    { key: 'qa', name: 'Quality Assurance & Ranking', handle: '123456789/24', uuid: '18cc90d2-9a2e-4e80-9bdc-d37bd7214fa0', unit: 'items',
      description: 'AISHE, IQAC (AQAR/SSR), NAAC, and NIRF documentation.' },
    { key: 'outreach', name: 'Extension, Cultural, Sports & Outreach', handle: '123456789/7', uuid: '74959250-52dd-4d7c-ba0d-1d65b6d5bcec', unit: 'items',
      description: 'NCC, NSS, Sports, and Cultural & Extension activity reports.' },
  ];

  readonly columns: Column[] = [
    { key: 'qp', heading: 'Recently Added — Question Papers', scope: 'a0a1badb-81d8-41c9-9b28-d554bfc664ca',
      handle: '123456789/20', viewAll: 'View all Question Papers →', kind: 'paper' },
    { key: 'pub', heading: 'Recently Added — Faculty Publications', scope: 'a42013b2-51e5-4fbb-9abd-8cb4068031c4',
      handle: '123456789/18', viewAll: 'View all Faculty Publications →', kind: 'pub' },
    { key: 'tj', heading: "Recently Added — Teachers' Journal", scope: 'b662adb2-81ab-46ed-8048-eee3d22d7549',
      handle: '123456789/35', viewAll: "View all Teachers' Journal →", kind: 'pub' },
  ];

  readonly links: { label: string; href?: string; route?: string; icon: string }[] = [
    { label: 'College Website', href: 'https://nvc.ac.in/', icon: 'link' },
    { label: 'Central Library', href: 'https://nvc.ac.in/library/', icon: 'book' },
    { label: 'University of Kalyani', href: 'https://klyuniv.ac.in/', icon: 'cap' },
    { label: 'UGC', href: 'https://www.ugc.gov.in/', icon: 'globe' },
    { label: 'NAAC', href: 'https://www.naac.gov.in/', icon: 'star' },
    { label: 'NIRF', href: 'https://www.nirfindia.org/', icon: 'chart' },
    { label: 'AISHE', href: 'https://aishe.gov.in/', icon: 'doc' },
    { label: 'IQAC', route: '/handle/123456789/28', icon: 'card' },
  ];

  private api: string;
  private fragmentSub?: Subscription;

  constructor(
    private http: HttpClient,
    private router: Router,
    @Inject(APP_CONFIG) private appConfig: AppConfig,
    @Inject(PLATFORM_ID) private platformId: object,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
  ) {
    this.api = this.appConfig.rest.baseUrl + '/api';
  }

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    this.searchCount('', (n) => this.totalItems = n);
    for (const c of this.communities) {
      this.searchCount(c.uuid, (n) => c.count = n);
    }
    this.http.get<any>(`${this.api}/core/communities/search/top?size=1`).subscribe({
      next: (r) => { this.publicCommunities = r?.page?.totalElements; this.cdr.markForCheck(); },
      error: () => undefined,
    });
    this.http.get<any>('assets/nvc-stats.json', { params: { t: Date.now().toString() } }).subscribe({
      next: (r) => { if (typeof r?.downloads30 === 'number') { this.downloads30 = r.downloads30; this.cdr.markForCheck(); } },
      error: () => undefined,
    });
    for (const col of this.columns) {
      this.loadRecent(col);
    }
  }

  /** header "About" link = /home#about: scroll to the About band */
  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    this.fragmentSub = this.route.fragment.subscribe((f) => {
      if (f) { setTimeout(() => document.getElementById(f)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); }
    });
  }

  ngOnDestroy(): void {
    this.fragmentSub?.unsubscribe();
  }

  get profilesCount(): number | undefined {
    return this.communities.find((c) => c.key === 'profiles')?.count;
  }

  search(): void {
    const q = this.query.trim();
    this.router.navigate(['/search'], q ? { queryParams: { query: q } } : {});
  }

  copy(text: string, id: string): void {
    const done = () => {
      this.copied = id;
      this.cdr.markForCheck();
      setTimeout(() => { if (this.copied === id) { this.copied = null; this.cdr.markForCheck(); } }, 1800);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => undefined);
    }
  }

  // ---------------------------------------------------------------- data

  private searchCount(scope: string, set: (n: number) => void): void {
    const s = scope ? `&scope=${scope}` : '';
    this.http.get<any>(`${this.api}/discover/search/objects?dsoType=ITEM&size=1${s}`).subscribe({
      next: (r) => {
        const n = r?._embedded?.searchResult?.page?.totalElements;
        if (typeof n === 'number') { set(n); this.cdr.markForCheck(); }
      },
      error: () => undefined,
    });
  }

  private loadRecent(col: Column): void {
    const url = `${this.api}/discover/search/objects?dsoType=ITEM&size=3&sort=dc.date.accessioned,DESC&scope=${col.scope}`;
    this.http.get<any>(url).subscribe({
      next: (r) => {
        const objs = r?._embedded?.searchResult?._embedded?.objects || [];
        col.items = objs.map((o: any) => this.toRecent(o?._embedded?.indexableObject, col.kind)).filter((x: Recent) => !!x);
        col.loaded = true;
        this.cdr.markForCheck();
        for (const it of col.items) {
          this.findPdf(it);
          if (it.doi) { this.crossref(it); }
        }
      },
      error: () => { col.items = []; col.loaded = true; this.cdr.markForCheck(); },
    });
  }

  private toRecent(item: any, kind: 'paper' | 'pub'): Recent {
    if (!item?.uuid) { return null; }
    const md = item.metadata || {};
    const v = (k: string) => md[k]?.[0]?.value as string | undefined;
    const all = (k: string) => (md[k] || []).map((m: any) => m.value as string);
    const rec: Recent = { uuid: item.uuid, title: v('dc.title') || item.name || 'Untitled' };
    if (kind === 'paper') {
      rec.meta = [v('local.department'), v('local.curriculumScheme')].filter(Boolean).join(' · ');
      return rec;
    }
    const authors = all('dc.contributor.author');
    const year = (v('dc.date.issued') || '').slice(0, 4);
    const doi = (v('local.doi') || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
    rec.doi = doi || undefined;
    rec.subject = v('dc.subject');
    rec.cite = {
      mla: this.mla(authors, rec.title, v('dc.relation.ispartof'), v('local.journalVolume'), v('local.journalIssue'), year, v('local.pageRange')),
      apa: this.apa(authors, rec.title, v('dc.relation.ispartof'), v('local.journalVolume'), v('local.journalIssue'), year, v('local.pageRange'), doi),
      bib: this.bibtex(authors, rec.title, v('dc.relation.ispartof'), v('local.journalVolume'), v('local.journalIssue'), year, v('local.pageRange'), doi),
    };
    return rec;
  }

  /** first file in the ORIGINAL bundle -> DSpace's own download route */
  private findPdf(it: Recent): void {
    this.http.get<any>(`${this.api}/core/items/${it.uuid}/bundles?embed=bitstreams&size=20`).subscribe({
      next: (r) => {
        const bundles = r?._embedded?.bundles || [];
        const orig = bundles.find((b: any) => b.name === 'ORIGINAL');
        const bs = orig?._embedded?.bitstreams?._embedded?.bitstreams?.[0];
        if (bs?.uuid) { it.pdf = `/bitstreams/${bs.uuid}/download`; this.cdr.markForCheck(); }
      },
      error: () => undefined,
    });
  }

  /** live citation count from Crossref, shown only when Crossref actually returns one */
  private crossref(it: Recent): void {
    this.http.get<any>(`https://api.crossref.org/works/${encodeURIComponent(it.doi)}`).subscribe({
      next: (r) => {
        const n = r?.message?.['is-referenced-by-count'];
        if (typeof n === 'number') { it.citedBy = n; this.cdr.markForCheck(); }
      },
      error: () => undefined,
    });
  }

  // ----------------------------------------------------------- citations
  // DSpace stores authors as "Last, First".

  private split(a: string): { last: string; first: string } {
    const [last, first] = a.split(',').map((s) => (s || '').trim());
    return { last, first: first || '' };
  }

  private initials(first: string): string {
    return first.split(/[\s.]+/).filter(Boolean).map((p) => p[0].toUpperCase() + '.').join(' ');
  }

  mla(authors: string[], title: string, journal?: string, vol?: string, iss?: string, year?: string, pages?: string): string {
    let who = '';
    if (authors.length === 1) {
      who = authors[0];
    } else if (authors.length === 2) {
      const b = this.split(authors[1]);
      who = `${authors[0]}, and ${[b.first, b.last].filter(Boolean).join(' ')}`;
    } else if (authors.length > 2) {
      who = `${authors[0]}, et al`;
    }
    const parts = [
      who ? `${who.replace(/\.$/, '')}.` : '',
      `“${title}.”`,
      [journal, vol ? `vol. ${vol}` : '', iss ? `no. ${iss}` : '', year, pages ? `pp. ${pages}` : ''].filter(Boolean).join(', '),
    ].filter(Boolean);
    return parts.join(' ').replace(/,?\s*$/, '') + '.';
  }

  apa(authors: string[], title: string, journal?: string, vol?: string, iss?: string, year?: string, pages?: string, doi?: string): string {
    const names = authors.map((a) => { const s = this.split(a); return `${s.last}, ${this.initials(s.first)}`.replace(/,\s*$/, ''); });
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}` : (names[0] || '');
    let src = journal || '';
    if (vol) { src += `, ${vol}${iss ? `(${iss})` : ''}`; }
    if (pages) { src += `, ${pages}`; }
    return [who, `(${year || 'n.d.'}).`, `${title}.`, src ? `${src}.` : '', doi ? `https://doi.org/${doi}` : '']
      .filter(Boolean).join(' ');
  }

  bibtex(authors: string[], title: string, journal?: string, vol?: string, iss?: string, year?: string, pages?: string, doi?: string): string {
    const key = ((this.split(authors[0] || 'item').last || 'item').toLowerCase().replace(/[^a-z]/g, '') || 'item') + (year || '');
    const f = (k: string, val?: string) => (val ? `  ${k} = {${val}},\n` : '');
    return `@article{${key},\n` + f('author', authors.join(' and ')) + f('title', title) + f('journal', journal)
      + f('volume', vol) + f('number', iss) + f('pages', pages) + f('year', year) + f('doi', doi) + '}';
  }
}
