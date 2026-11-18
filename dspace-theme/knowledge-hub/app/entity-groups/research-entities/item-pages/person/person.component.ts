import {
  AsyncPipe,
  isPlatformBrowser,
} from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  inject,
  OnInit,
  PLATFORM_ID,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '@dspace/config/app-config.interface';
import { Context } from '@dspace/core/shared/context.model';
import { ViewMode } from '@dspace/core/shared/view-mode.model';
import { TranslateModule } from '@ngx-translate/core';
import { DsoEditMenuComponent } from 'src/app/shared/dso-page/dso-edit-menu/dso-edit-menu.component';
import { ThemedResultsBackButtonComponent } from 'src/app/shared/results-back-button/themed-results-back-button.component';

import { PersonComponent as BaseComponent } from '../../../../../../../app/entity-groups/research-entities/item-pages/person/person.component';
import { listableObjectComponent } from '../../../../../../../app/shared/object-collection/shared/listable-object/listable-object.decorator';

/*
 * Knowledge Hub faculty profile page (Person entity) - repo.nvc.ac.in
 * Header with photo (first image in the profile's ORIGINAL bundle, else initials), research-profile
 * buttons, live publication statistics and a filterable, year-grouped publication list built from the
 * profile's isAuthorOfPublication relationships. Everything is read live from the public REST API.
 */

interface Pub {
  uuid: string;
  title: string;
  year: string;
  type: string;
  authors: { name: string; me: boolean }[];
  journal: string;
  source: string;
  doi: string;
  oaLink: string;
  hasPdf: boolean;
  cite: { mla: string; apa: string; bib: string };
}

@listableObjectComponent('Person', ViewMode.StandalonePage, Context.Any, 'nvc')
@Component({
  selector: 'ds-person',
  styleUrls: ['./person.component.scss'],
  templateUrl: './person.component.html',
  imports: [
    AsyncPipe,
    DsoEditMenuComponent,
    FormsModule,
    RouterLink,
    ThemedResultsBackButtonComponent,
    TranslateModule,
  ],
})
export class PersonComponent extends BaseComponent implements OnInit {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private platformId = inject(PLATFORM_ID);
  private appConfig = inject(APP_CONFIG);

  photo = '';
  pubs: Pub[] = [];
  loaded = false;
  query = '';
  filter: 'all' | 'article' | 'chapter' | 'full' = 'all';
  openCite: string | null = null;
  copied: string | null = null;

  stats = { total: 0, articles: 0, chapters: 0, doi: 0, years: '' };
  perYear: { year: string; n: number; pct: number }[] = [];
  topJournals: { name: string; n: number }[] = [];
  coAuthors: { name: string; n: number }[] = [];

  // ------------------------------------------------------------ profile fields
  v(field: string): string {
    return this.object?.firstMetadataValue(field) || '';
  }

  get displayName(): string {
    return this.v('person.name.variant') || [this.v('person.givenName'), this.v('person.familyName')].filter(Boolean).join(' ') || this.v('dc.title');
  }

  get initials(): string {
    const g = this.v('person.givenName'), f = this.v('person.familyName');
    return ((g[0] || '') + (f[0] || '')).toUpperCase() || (this.v('dc.title')[0] || '?');
  }

  get expertise(): string[] {
    return this.v('dc.description.abstract').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  }

  get roleLine(): string {
    return [this.v('person.jobTitle') || this.v('local.designation'), this.v('local.department'),
      this.v('person.affiliation.name') || 'Nabadwip Vidyasagar College'].filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------ data
  ngOnInit(): void {
    super.ngOnInit();
    if (!isPlatformBrowser(this.platformId) || !this.object) {
      return;
    }
    const api = this.appConfig.rest.baseUrl + '/api';
    this.http.get<any>(`${api}/core/items/${this.object.uuid}/bundles?embed=bitstreams&size=20`).subscribe({
      next: (r) => {
        const orig = (r?._embedded?.bundles || []).find((b: any) => b.name === 'ORIGINAL');
        const img = (orig?._embedded?.bitstreams?._embedded?.bitstreams || [])
          .find((b: any) => /\.(jpe?g|png|gif|bmp|webp)$/i.test(b.name || ''));
        if (img) {
          this.photo = `${api}/core/bitstreams/${img.uuid}/content`;
          this.cdr.markForCheck();
        }
      },
      error: () => undefined,
    });
    const url = `${api}/discover/search/objects?configuration=default-relationships`
      + `&f.isAuthorOfPublication=${this.object.uuid},equals&size=500&sort=dc.date.issued,DESC`;
    this.http.get<any>(url).subscribe({
      next: (r) => {
        const objs = r?._embedded?.searchResult?._embedded?.objects || [];
        this.pubs = objs.map((o: any) => this.toPub(o?._embedded?.indexableObject)).filter((p: Pub) => !!p);
        this.computeStats();
        this.loaded = true;
        this.cdr.markForCheck();
      },
      error: () => { this.loaded = true; this.cdr.markForCheck(); },
    });
  }

  private isMe(name: string): boolean {
    const given = this.v('person.givenName'), family = this.v('person.familyName');
    const a = name.replace(/\./g, ' ');
    let fam: string, rest: string;
    if (a.includes(',')) {
      [fam, rest] = a.split(',', 2).map((s) => s.trim());
    } else {
      const q = a.trim().split(/\s+/);
      fam = q[q.length - 1] || '';
      rest = q.slice(0, -1).join(' ');
    }
    if (!family || (rest[0] || '').toLowerCase() !== (given[0] || '').toLowerCase()) {
      return false;
    }
    const f1 = fam.toLowerCase(), f2 = family.toLowerCase();
    if (f1 === f2) {
      return true;
    }
    // spelling variants such as Mandal / Mondal: same length, at most one differing letter
    return f1.length === f2.length && f2.length >= 4 && [...f1].filter((c, i) => c !== f2[i]).length <= 1;
  }

  private toPub(item: any): Pub {
    if (!item?.uuid) {
      return null;
    }
    const md = item.metadata || {};
    const v = (k: string) => (md[k]?.[0]?.value as string) || '';
    const names: string[] = (md['dc.contributor.author'] || []).map((m: any) => m.value as string);
    if (!names.some((n) => this.isMe(n))) {
      names.push(this.v('dc.title'));
    }
    const authors = names.map((n) => ({ name: n, me: this.isMe(n) }));
    const journal = v('journal.title') || v('dc.relation.ispartof');
    const vol = v('local.journalVolume'), iss = v('local.journalIssue'), pg = v('local.pageRange');
    const source = [vol ? vol + (iss ? `(${iss})` : '') : (iss ? `No. ${iss}` : ''), pg ? `pp. ${pg}` : ''].filter(Boolean).join(', ');
    const year = (v('dc.date.issued') || '').slice(0, 4);
    const doi = (v('dc.identifier.doi') || v('local.doi')).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const oaLink = (md['dc.identifier.uri'] || []).map((m: any) => m.value as string).find((u: string) => !u.includes('repo.nvc.ac.in')) || '';
    const title = v('dc.title');
    return {
      uuid: item.uuid, title, year, type: v('local.publicationType'), authors, journal, source, doi, oaLink,
      hasPdf: !!v('dc.rights'),
      cite: this.cite(names, title, journal, vol, iss, pg, year, doi),
    };
  }

  private computeStats(): void {
    const p = this.pubs;
    const years = p.map((x) => +x.year).filter((y) => y > 1900);
    this.stats = {
      total: p.length,
      articles: p.filter((x) => x.type === 'Journal Article').length,
      chapters: p.filter((x) => x.type === 'Book Chapter').length,
      doi: p.filter((x) => x.doi).length,
      years: years.length ? (Math.min(...years) === Math.max(...years) ? `${Math.min(...years)}` : `${Math.min(...years)}–${String(Math.max(...years)).slice(-2)}`) : '—',
    };
    if (years.length) {
      const lo = Math.max(Math.min(...years), Math.max(...years) - 11), hi = Math.max(...years);
      const counts: Record<number, number> = {};
      years.forEach((y) => counts[y] = (counts[y] || 0) + 1);
      const max = Math.max(...Object.values(counts));
      this.perYear = [];
      for (let y = lo; y <= hi; y++) {
        this.perYear.push({ year: String(y).slice(-2), n: counts[y] || 0, pct: counts[y] ? Math.max(12, Math.round(100 * counts[y] / max)) : 4 });
      }
    }
    const tally = (arr: string[]) => Object.entries(arr.reduce((m: Record<string, number>, k) => { m[k] = (m[k] || 0) + 1; return m; }, {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, n }));
    this.topJournals = tally(p.map((x) => x.journal).filter(Boolean));
    this.coAuthors = tally(p.flatMap((x) => x.authors.filter((a) => !a.me).map((a) => a.name))).filter((c) => c.n > 1);
  }

  // ------------------------------------------------------------ list
  get filtered(): Pub[] {
    const q = this.query.trim().toLowerCase();
    return this.pubs.filter((x) =>
      (this.filter === 'all'
        || (this.filter === 'article' && x.type === 'Journal Article')
        || (this.filter === 'chapter' && x.type === 'Book Chapter')
        || (this.filter === 'full' && (x.hasPdf || !!x.oaLink)))
      && (!q || (x.title + ' ' + x.journal + ' ' + x.year + ' ' + x.authors.map((a) => a.name).join(' ')).toLowerCase().includes(q)));
  }

  get groups(): { year: string; items: Pub[] }[] {
    const out: { year: string; items: Pub[] }[] = [];
    for (const x of this.filtered) {
      const y = x.year || 'Undated';
      if (!out.length || out[out.length - 1].year !== y) {
        out.push({ year: y, items: [] });
      }
      out[out.length - 1].items.push(x);
    }
    return out;
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
    const ini = (f: string) => f.split(/[\s.]+/).filter(Boolean).map((p) => p[0].toUpperCase() + '.').join(' ');
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
