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
 * Knowledge Hub - Faculty Directory (shown on the Faculty Profiles collection page, repo.nvc.ac.in)
 * Faculty cards (photo thumbnail or initials, designation, department, expertise, publication count,
 * research IDs) with search / department / A-Z / sort filters, and a Research statistics tab
 * (department-wise publications, per year, types, top authors, designations, ID coverage).
 * Everything is read live from the public REST API in the visitor's browser.
 */

interface Person {
  uuid: string;
  name: string;
  family: string;
  initials: string;
  job: string;
  dept: string;
  expertise: string[];
  orcid: string;
  scopus: string;
  gs: string;
  rid: string;
  vidwan: string;
  thumb: string;
  pubIds: string[];
}

interface Pub {
  uuid: string;
  year: number;
  type: string;
  authors: string[];
  doi: boolean;
  pdf: boolean;
  oa: boolean;
}

interface Bar { name: string; n: number; pct: number; sub?: string; uuid?: string }

@Component({
  selector: 'ds-nvc-faculty-directory',
  styleUrls: ['./faculty-directory.component.scss'],
  templateUrl: './faculty-directory.component.html',
  imports: [FormsModule, RouterLink],
})
export class FacultyDirectoryComponent implements OnInit {
  @Input() collectionId: string;
  @Input() title = 'Faculty Directory';

  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private platformId = inject(PLATFORM_ID);
  private appConfig = inject(APP_CONFIG);

  tab: 'faculty' | 'stats' = 'faculty';
  loaded = false;
  failed = false;
  people: Person[] = [];
  pubs: Pub[] = [];

  query = '';
  dept = '';
  letter = '';
  sort: 'name' | 'dept' | 'pubs' = 'name';
  orcidOnly = false;
  grouped = false;

  departments: string[] = [];
  letters: string[] = [];
  kpi = { faculty: 0, depts: 0, pubs: 0, orcid: 0, full: 0 };
  deptBars: Bar[] = [];
  yearBars: { year: string; n: number; pct: number }[] = [];
  typeParts: { name: string; n: number; pct: number; cls: string }[] = [];
  topAuthors: Bar[] = [];
  designations: Bar[] = [];
  idCoverage: Bar[] = [];
  access: Bar[] = [];

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId) || !this.collectionId) {
      return;
    }
    const api = this.appConfig.rest.baseUrl + '/api/discover/search/objects?dsoType=ITEM&size=100';
    Promise.all([
      this.fetchAll(`${api}&scope=${this.collectionId}&embed=thumbnail`),
      this.fetchAll(`${api}&f.entityType=Publication,equals`),
    ]).then(([persons, pubs]) => {
      this.people = persons.map((o) => this.toPerson(o)).filter((p) => !!p);
      this.pubs = pubs.map((o) => this.toPub(o)).filter((p) => !!p);
      this.compute();
      this.loaded = true;
      this.cdr.markForCheck();
    }).catch(() => {
      this.failed = true;
      this.loaded = true;
      this.cdr.markForCheck();
    });
  }

  /** the REST API returns at most 100 results per page */
  private async fetchAll(url: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 0; page < 30; page++) {
      const r: any = await firstValueFrom(this.http.get<any>(`${url}&page=${page}`));
      const res = r?._embedded?.searchResult;
      out.push(...(res?._embedded?.objects || []).map((o: any) => o?._embedded?.indexableObject));
      if (!res || page + 1 >= (res.page?.totalPages || 0)) {
        break;
      }
    }
    return out;
  }

  private toPerson(item: any): Person {
    if (!item?.uuid) {
      return null;
    }
    const md = item.metadata || {};
    const v = (k: string) => (md[k]?.[0]?.value as string) || '';
    const given = v('person.givenName'), family = v('person.familyName');
    const thumb = item._embedded?.thumbnail?._links?.content?.href || '';
    return {
      uuid: item.uuid,
      name: v('person.name.variant') || [given, family].filter(Boolean).join(' ') || v('dc.title'),
      family: family || v('dc.title'),
      initials: ((given[0] || '') + (family[0] || '')).toUpperCase() || (v('dc.title')[0] || '?'),
      job: v('person.jobTitle') || v('local.designation'),
      dept: v('local.department') || 'Other',
      expertise: v('dc.description.abstract').split(/[,;]/).map((s) => s.trim()).filter(Boolean),
      orcid: v('person.identifier.orcid'),
      scopus: v('person.identifier.scopus-author-id'),
      gs: v('person.identifier.gsid'),
      rid: v('person.identifier.rid'),
      vidwan: v('local.vidwanProfile'),
      thumb,
      pubIds: [...new Set<string>((md['relation.isPublicationOfAuthor'] || []).map((m: any) => m.value as string))],
    };
  }

  private toPub(item: any): Pub {
    if (!item?.uuid) {
      return null;
    }
    const md = item.metadata || {};
    const v = (k: string) => (md[k]?.[0]?.value as string) || '';
    return {
      uuid: item.uuid,
      year: +(v('dc.date.issued').slice(0, 4)) || 0,
      type: v('local.publicationType') || 'Other',
      authors: [...new Set<string>((md['relation.isAuthorOfPublication'] || []).map((m: any) => m.value as string))],
      doi: !!(v('dc.identifier.doi') || v('local.doi')),
      pdf: !!v('dc.rights'),
      oa: (md['dc.identifier.uri'] || []).some((m: any) => !String(m.value).includes('repo.nvc.ac.in')),
    };
  }

  // ------------------------------------------------------------ statistics
  private compute(): void {
    const people = this.people, pubs = this.pubs;
    const byUuid = new Map(people.map((p) => [p.uuid, p]));
    // only publications linked to a profile in this collection
    const linked = pubs.filter((x) => x.authors.some((a) => byUuid.has(a)));

    this.departments = [...new Set(people.map((p) => p.dept))].sort();
    this.letters = [...new Set(people.map((p) => (p.family[0] || '').toUpperCase()).filter(Boolean))].sort();
    this.kpi = {
      faculty: people.length,
      depts: this.departments.length,
      pubs: linked.length,
      orcid: people.filter((p) => p.orcid).length,
      full: linked.filter((x) => x.pdf || x.oa).length,
    };

    const bars = (rows: { name: string; n: number; sub?: string; uuid?: string }[]): Bar[] => {
      const max = Math.max(1, ...rows.map((r) => r.n));
      return rows.map((r) => ({ ...r, pct: r.n ? Math.max(3, Math.round(100 * r.n / max)) : 0 }));
    };

    // department-wise publications (a paper co-written within one department counts once)
    this.deptBars = bars(this.departments.map((d) => {
      const staff = people.filter((p) => p.dept === d);
      const ids = new Set(staff.map((p) => p.uuid));
      const n = linked.filter((x) => x.authors.some((a) => ids.has(a))).length;
      const active = staff.filter((p) => p.pubIds.length).length;
      return { name: d, n, sub: `${staff.length} faculty · ${active} with publications` };
    }).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)));

    const years = linked.map((x) => x.year).filter((y) => y > 1900);
    this.yearBars = [];
    if (years.length) {
      const hi = Math.max(...years), lo = Math.max(Math.min(...years), hi - 11);
      const c: Record<number, number> = {};
      years.forEach((y) => c[y] = (c[y] || 0) + 1);
      const max = Math.max(...Object.values(c));
      for (let y = lo; y <= hi; y++) {
        this.yearBars.push({ year: String(y), n: c[y] || 0, pct: c[y] ? Math.max(6, Math.round(100 * c[y] / max)) : 2 });
      }
    }

    const tally = (arr: string[]) => Object.entries(arr.reduce((m: Record<string, number>, k) => { m[k] = (m[k] || 0) + 1; return m; }, {}))
      .sort((a, b) => b[1] - a[1]);
    const classes = ['t1', 't2', 't3', 't4'];
    const types = tally(linked.map((x) => x.type));
    const main = types.slice(0, 3);
    const rest = types.slice(3).reduce((s, [, n]) => s + n, 0);
    if (rest) {
      main.push(['Other', rest]);
    }
    this.typeParts = main.map(([name, n], i) => ({ name, n, pct: linked.length ? 100 * n / linked.length : 0, cls: classes[i] }));

    this.topAuthors = bars(people.filter((p) => p.pubIds.length)
      .sort((a, b) => b.pubIds.length - a.pubIds.length || a.family.localeCompare(b.family)).slice(0, 8)
      .map((p) => ({ name: p.name, n: p.pubIds.length, sub: p.dept, uuid: p.uuid })));

    this.designations = bars(tally(people.map((p) => p.job || 'Not stated')).map(([name, n]) => ({ name, n })));

    const cov = (name: string, n: number) => ({ name, n, pct: people.length ? Math.round(100 * n / people.length) : 0, sub: `${n} of ${people.length}` });
    this.idCoverage = [
      cov('Vidwan', people.filter((p) => p.vidwan).length),
      cov('ORCID', people.filter((p) => p.orcid).length),
      cov('Google Scholar', people.filter((p) => p.gs).length),
      cov('Scopus', people.filter((p) => p.scopus).length),
      cov('Web of Science', people.filter((p) => p.rid).length),
    ];
    const acc = (name: string, n: number) => ({ name, n, pct: linked.length ? Math.round(100 * n / linked.length) : 0, sub: `${n} of ${linked.length}` });
    this.access = [
      acc('With DOI', linked.filter((x) => x.doi).length),
      acc('Full text (PDF) in Knowledge Hub', linked.filter((x) => x.pdf).length),
      acc('Open-access link', linked.filter((x) => !x.pdf && x.oa).length),
    ];
  }

  // ------------------------------------------------------------ directory
  get filtered(): Person[] {
    const q = this.query.trim().toLowerCase();
    const list = this.people.filter((p) =>
      (!this.dept || p.dept === this.dept)
      && (!this.letter || (p.family[0] || '').toUpperCase() === this.letter)
      && (!this.orcidOnly || !!p.orcid)
      && (!q || [p.name, p.dept, p.job, ...p.expertise].join(' ').toLowerCase().includes(q)));
    const byName = (a: Person, b: Person) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name);
    if (this.sort === 'pubs') {
      return list.sort((a, b) => b.pubIds.length - a.pubIds.length || byName(a, b));
    }
    if (this.sort === 'dept' || this.grouped) {
      return list.sort((a, b) => a.dept.localeCompare(b.dept) || byName(a, b));
    }
    return list.sort(byName);
  }

  get groups(): { dept: string; items: Person[] }[] {
    const out: { dept: string; items: Person[] }[] = [];
    for (const p of this.filtered) {
      const key = this.grouped ? p.dept : '';
      if (!out.length || out[out.length - 1].dept !== key) {
        out.push({ dept: key, items: [] });
      }
      out[out.length - 1].items.push(p);
    }
    return out;
  }

  get hasFilter(): boolean {
    return !!(this.query || this.dept || this.letter || this.orcidOnly);
  }

  clear(): void {
    this.query = '';
    this.dept = '';
    this.letter = '';
    this.orcidOnly = false;
  }

  showDept(d: string): void {
    this.clear();
    this.dept = d;
    this.tab = 'faculty';
  }

  noPhoto(p: Person): void {
    p.thumb = '';
    this.cdr.markForCheck();
  }
}
