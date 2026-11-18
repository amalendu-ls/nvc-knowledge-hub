import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';

import { CollectionPageComponent as BaseComponent } from '../../../../app/collection-page/collection-page.component';
import {
  fadeIn,
  fadeInOut,
} from '../../../../app/shared/animations/fade';
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
import { ResearchOutputComponent } from '../research-output/research-output.component';

/** collections shown with a Knowledge Hub page instead of the stock search list */
const DIRECTORY_HANDLES: Record<string, 'faculty' | 'research'> = {
  '123456789/17': 'faculty',   // Faculty Profiles -> Faculty Directory
  '123456789/19': 'research',  // Faculty Publications -> Research Output
};

@Component({
  selector: 'ds-themed-collection-page',
  templateUrl: './collection-page.component.html',
  styleUrls: ['../../../../app/collection-page/collection-page.component.scss', './collection-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    fadeIn,
    fadeInOut,
  ],
  imports: [
    AsyncPipe,
    ComcolPageHeaderComponent,
    ComcolPageLogoComponent,
    DsoEditMenuComponent,
    ErrorComponent,
    FacultyDirectoryComponent,
    ResearchOutputComponent,
    RouterOutlet,
    ThemedComcolPageBrowseByComponent,
    ThemedComcolPageContentComponent,
    ThemedComcolPageHandleComponent,
    ThemedLoadingComponent,
    TranslateModule,
    VarDirective,
  ],
})
export class CollectionPageComponent extends BaseComponent implements OnInit {
  /** true = show the stock DSpace collection view (search / browse) */
  standard = false;

  ngOnInit(): void {
    super.ngOnInit();
    const url = this.router.url || '';
    this.standard = url.includes('/browse/') || /[?&]view=list\b/.test(url);
  }

  /** Collection.handle is the full dc.identifier.uri (https://…/handle/123456789/17) */
  kind(handle: string): string {
    return DIRECTORY_HANDLES[(handle || '').replace(/^.*\/handle\//, '')] || '';
  }

  isDirectory(handle: string): boolean {
    return !!this.kind(handle);
  }
}
