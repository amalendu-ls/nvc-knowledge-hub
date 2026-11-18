import { DecimalPipe, isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  Component,
  Inject,
  OnInit,
  PLATFORM_ID,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Router,
  RouterLink,
} from '@angular/router';
import {
  APP_CONFIG,
  AppConfig,
} from '@dspace/config/app-config.interface';

interface Card {
  title: string;
  text: string;
  icon: string;
  link?: string;
  href?: string;
  countKey?: string;
  subs?: { label: string; link: string }[];
}

/**
 * NVC home page hero: search box, live repository counts and quick-access cards.
 * Counts are read from the public REST API in the browser only, so they are always current
 * and reflect what an anonymous visitor can actually see.
 */
@Component({
  selector: 'ds-themed-home-news',
  styleUrls: ['./home-news.component.scss'],
  templateUrl: './home-news.component.html',
  imports: [
    DecimalPipe,
    FormsModule,
    RouterLink,
  ],
})
export class HomeNewsComponent implements OnInit {

  query = '';
  counts: { [key: string]: number } = {};

  readonly QUESTION_PAPERS = 'a0a1badb-81d8-41c9-9b28-d554bfc664ca';

  readonly cards: Card[] = [
    {
      title: 'Question Paper Archive', icon: 'fa-file-alt', link: '/handle/123456789/20', countKey: 'qp',
      text: 'Previous-year university examination papers, searchable by department, semester, course code and year.',
      subs: [
        { label: 'UG · CBCS', link: '/handle/123456789/22' },
        { label: 'UG · NEP-2020', link: '/handle/123456789/21' },
        { label: 'PG · NEP-2020', link: '/handle/123456789/23' },
      ],
    },
    {
      title: 'Quality Assurance & Ranking', icon: 'fa-award', link: '/handle/123456789/24',
      text: 'Institutional quality documentation submitted to national bodies.',
      subs: [
        { label: 'NAAC', link: '/handle/123456789/31' },
        { label: 'IQAC · AQAR / SSR', link: '/handle/123456789/28' },
        { label: 'NIRF', link: '/handle/123456789/33' },
        { label: 'AISHE', link: '/handle/123456789/25' },
      ],
    },
    {
      title: 'Activities & Outreach', icon: 'fa-hands-helping', link: '/handle/123456789/7',
      text: 'Year-wise reports of cultural, extension, NCC, NSS and sports activities.',
      subs: [
        { label: 'Cultural', link: '/handle/123456789/8' },
        { label: 'NCC', link: '/handle/123456789/10' },
        { label: 'NSS', link: '/handle/123456789/12' },
        { label: 'Sports', link: '/handle/123456789/14' },
      ],
    },
    {
      title: 'Faculty Publications', icon: 'fa-book-open', link: '/handle/123456789/18',
      text: 'Journal articles, book chapters and conference papers by NVC faculty.',
    },
    {
      title: "Teachers' Journal", icon: 'fa-newspaper', link: '/handle/123456789/35',
      text: "Articles published in the college's own Teachers' Journal.",
    },
    {
      title: 'Faculty Profiles', icon: 'fa-user-graduate', href: 'https://nvc.irins.org/',
      text: 'Researcher profiles, publication lists and citations of NVC faculty on IRINS (INFLIBNET).',
    },
  ];

  constructor(
    private http: HttpClient,
    private router: Router,
    @Inject(APP_CONFIG) private appConfig: AppConfig,
    @Inject(PLATFORM_ID) private platformId: object,
  ) {}

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    const api = this.appConfig.rest.baseUrl + '/api';
    this.count('items', `${api}/discover/search/objects?dsoType=ITEM&size=1`, true);
    this.count('qp', `${api}/discover/search/objects?dsoType=ITEM&size=1&scope=${this.QUESTION_PAPERS}`, true);
    this.count('collections', `${api}/core/collections?size=1`, false);
    this.count('communities', `${api}/core/communities/search/top?size=1`, false);
  }

  private count(key: string, url: string, search: boolean): void {
    this.http.get<any>(url).subscribe({
      next: (r) => {
        const page = search ? r?._embedded?.searchResult?.page : r?.page;
        if (typeof page?.totalElements === 'number') {
          this.counts[key] = page.totalElements;
        }
      },
      error: () => undefined,
    });
  }

  search(): void {
    const q = this.query.trim();
    this.router.navigate(['/search'], q ? { queryParams: { query: q } } : {});
  }
}
