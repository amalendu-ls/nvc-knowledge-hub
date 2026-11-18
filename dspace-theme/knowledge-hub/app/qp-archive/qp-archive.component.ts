import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  Input,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '@dspace/config/app-config.interface';
import { firstValueFrom } from 'rxjs';

/*
 * Knowledge Hub - Question Paper Archive (community page, repo.nvc.ac.in)
 * Scheme cards, a paper finder (scheme / department / year / semester / category / text) with
 * PDF download, department tiles and a statistics tab. Uses the Knowledge Hub discovery facets
 * department, examYear, semester, scheme, paperCategory (discovery.xml searchFilterNvc*).
 */

interface Opt { value: string; n: number }
interface Scheme { uuid: string; name: string; short: string; n: number; years: string }
interface Paper {
  uuid: string; title: string; code: string; dept: string; sem: string; year: string;
  cat: string; mode: string; stream: string; scheme: string; pdf: string;
}
interface Bar { name: string; n: number; pct: number }

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

@Component({
  selector: 'ds-nvc-qp-archive',
  styleUrls: ['../faculty-directory/faculty-directory.component.scss', './qp-archive.component.scss'],
  templateUrl: './qp-archive.component.html',
  imports: [FormsModule, RouterLink],
})
export class QpArchiveComponent implements OnInit, OnDestroy {
  @Input() communityId: string;
  @Input() title = 'Question Paper Archive';
  @ViewChild('finder') finder: ElementRef<HTMLElement>;

  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private platformId = inject(PLATFORM_ID);
  private appConfig = inject(APP_CONFIG);
  private api = '';
  private timer: any;
  private seq = 0;

  tab: 'find' | 'stats' = 'find';
  ready = false;
  failed = false;
  kpi = { papers: 0, depts: 0, years: '', pdfs: 0 };
  schemes: Scheme[] = [];
  deptTiles: Opt[] = [];

  // finder
  scope = '';
  dept = '';
  year = '';
  sem = '';
  cat = '';
  query = '';
  sort: 'new' | 'code' = 'new';
  page = 0;
  readonly pageSize = 20;
  total = 0;
  loading = false;
  papers: Paper[] = [];
  opts: Record<string, Opt[]> = { department: [], examYear: [], semester: [], paperCategory: [] };

  // statistics
  statsLoaded = false;
  stats: Record<string, Bar[]> = { department: [], examYear: [], semester: [], scheme: [], paperCategory: [] };

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId) || !this.communityId) {
      return;
    }
    this.api = this.appConfig.rest.baseUrl + '/api';
    this.loadOverview().then(() => {
      this.ready = true;
      this.cdr.markForCheck();
    }).catch(() => {
      this.failed = true;
      this.ready = true;
      this.cdr.markForCheck();
    });
    this.refresh();
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }

  private get<T = any>(url: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(url));
  }

  private async facet(name: string, scope: string, extra = ''): Promise<Opt[]> {
    const r: any = await this.get(`${this.api}/discover/facets/${name}?scope=${scope}&size=200${extra}`);
    return (r?._embedded?.values || []).map((v: any) => ({ value: v.label as string, n: v.count as number }));
  }

  private async count(scope: string, extra = ''): Promise<number> {
    const r: any = await this.get(`${this.api}/discover/search/objects?scope=${scope}&dsoType=ITEM&size=1${extra}`);
    return r?._embedded?.searchResult?.page?.totalElements || 0;
  }

  private async loadOverview(): Promise<void> {
    const c = this.communityId;
    const [papers, depts, years, pdfs, cols] = await Promise.all([
      this.count(c),
      this.facet('department', c),
      this.facet('examYear', c),
      this.count(c, '&f.has_content_in_original_bundle=true,equals'),
      this.get(`${this.api}/core/communities/${c}/collections?size=50`),
    ]);
    const ys = years.map((y) => +y.value).filter((y) => y > 1900);
    this.kpi = {
      papers, depts: depts.length, pdfs,
      years: ys.length ? `${Math.min(...ys)}–${Math.max(...ys)}` : '—',
    };
    this.deptTiles = [...depts].sort((a, b) => a.value.localeCompare(b.value));
    const list = (cols as any)?._embedded?.collections || [];
    this.schemes = await Promise.all(list.map(async (col: any) => {
      const [n, yrs] = await Promise.all([this.count(col.uuid), this.facet('examYear', col.uuid)]);
      const y = yrs.map((v) => +v.value).filter((v) => v > 1900);
      const name: string = col.name;
      return {
        uuid: col.uuid, name, n,
        short: name.replace(/Question Papers\s*/i, '').trim(),
        years: y.length ? (Math.min(...y) === Math.max(...y) ? `${y[0]}` : `${Math.min(...y)}–${Math.max(...y)}`) : '',
      };
    }));
    this.schemes.sort((a, b) => b.n - a.n);
  }

  // ------------------------------------------------------------ finder
  private filterParams(except = ''): string {
    const f: [string, string][] = [['department', this.dept], ['examYear', this.year], ['semester', this.sem], ['paperCategory', this.cat]];
    let s = f.filter(([k, v]) => v && k !== except).map(([k, v]) => `&f.${k}=${encodeURIComponent(v)},equals`).join('');
    if (this.query.trim()) {
      s += `&query=${encodeURIComponent(this.query.trim())}`;
    }
    return s;
  }

  get hasFilter(): boolean {
    return !!(this.scope || this.dept || this.year || this.sem || this.cat || this.query.trim());
  }

  get scopeName(): string {
    return this.schemes.find((s) => s.uuid === this.scope)?.short || '';
  }

  get pages(): number {
    return Math.ceil(this.total / this.pageSize);
  }

  /** filters changed: back to page 1, reload options + results */
  refresh(): void {
    this.page = 0;
    this.load(true);
  }

  typed(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 400);
  }

  goPage(p: number): void {
    this.page = Math.max(0, Math.min(p, this.pages - 1));
    this.load(false);
    this.finder?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private async load(withOptions: boolean): Promise<void> {
    const my = ++this.seq;
    const scope = this.scope || this.communityId;
    this.loading = true;
    this.cdr.markForCheck();
    try {
      const sort = this.sort === 'code' ? 'dc.title,ASC' : 'dc.date.issued,DESC';
      const url = `${this.api}/discover/search/objects?scope=${scope}&dsoType=ITEM&size=${this.pageSize}&page=${this.page}`
        + `&sort=${sort}&embed=bundles/bitstreams${this.filterParams()}`;
      const jobs: Promise<any>[] = [this.get(url)];
      if (withOptions) {
        for (const k of Object.keys(this.opts)) {
          jobs.push(this.facet(k, scope, this.filterParams(k)));
        }
      }
      const [r, ...facets] = await Promise.all(jobs);
      if (my !== this.seq) {
        return;
      }
      const res = r?._embedded?.searchResult;
      this.total = res?.page?.totalElements || 0;
      this.papers = (res?._embedded?.objects || []).map((o: any) => this.toPaper(o?._embedded?.indexableObject)).filter((p: Paper) => !!p);
      if (withOptions) {
        Object.keys(this.opts).forEach((k, i) => this.opts[k] = this.sortOpts(k, facets[i]));
      }
    } catch (e) {
      if (my === this.seq) {
        this.papers = [];
        this.total = 0;
      }
    }
    if (my === this.seq) {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  private semRank(s: string): number {
    const m = /(Semester|Part)\s+([IVX]+)/i.exec(s);
    return m ? (m[1].toLowerCase() === 'part' ? 100 : 0) + (ROMAN[m[2].toUpperCase()] || 50) : 999;
  }

  private sortOpts(k: string, list: Opt[]): Opt[] {
    const out = [...(list || [])];
    if (k === 'examYear') {
      return out.sort((a, b) => b.value.localeCompare(a.value));
    }
    if (k === 'semester') {
      return out.sort((a, b) => this.semRank(a.value) - this.semRank(b.value) || a.value.localeCompare(b.value));
    }
    return out.sort((a, b) => a.value.localeCompare(b.value));
  }

  private toPaper(item: any): Paper {
    if (!item?.uuid) {
      return null;
    }
    const md = item.metadata || {};
    const v = (k: string) => (md[k]?.[0]?.value as string) || '';
    const bundles = item._embedded?.bundles?._embedded?.bundles || [];
    const orig = bundles.find((b: any) => b.name === 'ORIGINAL');
    const bs = (orig?._embedded?.bitstreams?._embedded?.bitstreams || [])[0];
    return {
      uuid: item.uuid,
      title: v('dc.title'),
      code: v('local.courseCode'),
      dept: v('local.department') || v('dc.subject'),
      sem: v('local.semester'),
      year: v('local.examYear') || v('dc.date.issued').slice(0, 4),
      cat: v('local.paperCategory'),
      mode: v('local.paperMode'),
      stream: v('local.stream'),
      scheme: v('local.curriculumScheme'),
      pdf: bs ? `/bitstreams/${bs.uuid}/download` : '',
    };
  }

  pickScheme(uuid: string): void {
    this.scope = this.scope === uuid ? '' : uuid;
    this.tab = 'find';
    this.refresh();
    setTimeout(() => this.finder?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  pickDept(d: string): void {
    this.dept = d;
    this.tab = 'find';
    this.refresh();
    setTimeout(() => this.finder?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  clear(): void {
    this.scope = this.dept = this.year = this.sem = this.cat = this.query = '';
    this.refresh();
  }

  // ------------------------------------------------------------ statistics
  openStats(): void {
    this.tab = 'stats';
    if (this.statsLoaded) {
      return;
    }
    const keys = Object.keys(this.stats);
    Promise.all(keys.map((k) => this.facet(k, this.communityId))).then((all) => {
      keys.forEach((k, i) => {
        let list = all[i];
        if (k === 'examYear') {
          list = [...list].sort((a, b) => a.value.localeCompare(b.value));
        } else if (k === 'semester') {
          list = this.sortOpts(k, list);
        } else {
          list = [...list].sort((a, b) => b.n - a.n);
        }
        const max = Math.max(1, ...list.map((x) => x.n));
        this.stats[k] = list.map((x) => ({ name: x.value, n: x.n, pct: Math.max(2, Math.round(100 * x.n / max)) }));
      });
      this.statsLoaded = true;
      this.cdr.markForCheck();
    }).catch(() => {
      this.statsLoaded = true;
      this.cdr.markForCheck();
    });
  }
}
