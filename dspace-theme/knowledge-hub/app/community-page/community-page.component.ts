import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
} from '@angular/core';
import {
  Router,
  RouterModule,
  RouterOutlet,
} from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';

import { CommunityPageComponent as BaseComponent } from '../../../../app/community-page/community-page.component';
import { fadeInOut } from '../../../../app/shared/animations/fade';
import { ThemedComcolPageBrowseByComponent } from '../../../../app/shared/comcol/comcol-page-browse-by/themed-comcol-page-browse-by.component';
import { ThemedComcolPageContentComponent } from '../../../../app/shared/comcol/comcol-page-content/themed-comcol-page-content.component';
import { ThemedComcolPageHandleComponent } from '../../../../app/shared/comcol/comcol-page-handle/themed-comcol-page-handle.component';
import { ComcolPageHeaderComponent } from '../../../../app/shared/comcol/comcol-page-header/comcol-page-header.component';
import { ComcolPageLogoComponent } from '../../../../app/shared/comcol/comcol-page-logo/comcol-page-logo.component';
import { DsoEditMenuComponent } from '../../../../app/shared/dso-page/dso-edit-menu/dso-edit-menu.component';
import { ErrorComponent } from '../../../../app/shared/error/error.component';
import { ThemedLoadingComponent } from '../../../../app/shared/loading/themed-loading.component';
import { VarDirective } from '../../../../app/shared/utils/var.directive';
import { FacultyDirectoryComponent } from '../faculty-directory/faculty-directory.component';
import { QpArchiveComponent } from '../qp-archive/qp-archive.component';
import { ResearchOutputComponent } from '../research-output/research-output.component';

/** communities shown with a Knowledge Hub page instead of the stock community view */
const NVC_PAGES: Record<string, 'qp' | 'research' | 'faculty'> = {
  '123456789/16': 'faculty',   // Faculty Profiles -> Faculty Directory
  '123456789/20': 'qp',        // Old Question Paper Archive -> paper finder
  '123456789/18': 'research',  // Faculty Publications -> Research Output
};

@Component({
  selector: 'ds-themed-community-page',
  templateUrl: './community-page.component.html',
  styleUrls: ['../../../../app/community-page/community-page.component.scss', './community-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [fadeInOut],
  imports: [
    AsyncPipe,
    ComcolPageHeaderComponent,
    ComcolPageLogoComponent,
    DsoEditMenuComponent,
    ErrorComponent,
    FacultyDirectoryComponent,
    QpArchiveComponent,
    ResearchOutputComponent,
    RouterModule,
    RouterOutlet,
    ThemedComcolPageBrowseByComponent,
    ThemedComcolPageContentComponent,
    ThemedComcolPageHandleComponent,
    ThemedLoadingComponent,
    TranslateModule,
    VarDirective,
  ],
})
export class CommunityPageComponent extends BaseComponent implements OnInit {
  private nvcRouter = inject(Router);

  /** true = show the stock DSpace community view */
  standard = false;

  ngOnInit(): void {
    super.ngOnInit();
    const url = this.nvcRouter.url || '';
    this.standard = url.includes('/browse/') || url.includes('/subcoms-cols') || /[?&]view=list\b/.test(url);
  }

  /** Community.handle is the full dc.identifier.uri (https://…/handle/123456789/20) */
  kind(handle: string): string {
    return NVC_PAGES[(handle || '').replace(/^.*\/handle\//, '')] || '';
  }
}
