#!/bin/bash
# Build the "nvc" (Knowledge Hub) theme into the DSpace Angular source (run inside CT101 as root).
# Does NOT touch the live site: it only produces /opt/dspace-angular-src/dist.
# usage: bash build-nvc-theme.sh /tmp/nvc-theme.tgz
set -euo pipefail
PKG="${1:?path to nvc-theme.tgz}"
SRC=/opt/dspace-angular-src
TS=$(date +%Y%m%d%H%M)
BK=/opt/nvc-theme-backup-$TS
mkdir -p $BK
cd $SRC

# 1. backups of everything this script changes
cp -a angular.json src/themes/eager-themes-components.ts src/themes/themes-listable-components.ts $BK/
cp -a src/assets/i18n $BK/i18n
[ -d src/themes/nvc ] && cp -a src/themes/nvc $BK/nvc-old
echo "backups in $BK"

# the very first backup holds the stock i18n files: start from those so labels from an
# earlier version of this theme do not linger
FIRST=$(ls -d /opt/nvc-theme-backup-* | sort | head -1)
rm -rf src/assets/i18n && cp -a $FIRST/i18n src/assets/i18n

# 2. theme = copy of the stock "custom" template + Knowledge Hub overrides
rm -rf src/themes/nvc
cp -a src/themes/custom src/themes/nvc
tar -xzf "$PKG" --no-same-owner -C src/themes/nvc --strip-components=1
# college emblem + favicons are served from assets/nvc/ (angular.json only copies src/assets)
rm -rf src/assets/nvc && cp -a src/themes/nvc/assets/nvc src/assets/nvc

# 3. point the overridden components at their own templates/styles
for c in header/header footer/footer; do
  f=src/themes/nvc/app/$c.component.ts
  n=$(basename $c)
  sed -i -E "s#^  styleUrls: \[.*\],#  styleUrls: ['./$n.component.scss'],#; s#^  templateUrl: .*#  templateUrl: './$n.component.html',#" $f
  grep -q "templateUrl: './$n.component.html'" $f || { echo "failed to rewire $f"; exit 1; }
done
# Person (faculty profile) page: own template + registered for the nvc theme (the copy says 'custom')
f=src/themes/nvc/app/entity-groups/research-entities/item-pages/person/person.component.ts
sed -i -E "s#^  styleUrls: \[.*\],#  styleUrls: ['./person.component.scss'],#; s#^  templateUrl: .*#  templateUrl: './person.component.html',#; s#Context.Any, 'custom'\)#Context.Any, 'nvc')#" $f
grep -q "templateUrl: './person.component.html'" $f && grep -q "Context.Any, 'nvc')" $f
f=src/themes/nvc/app/header-nav-wrapper/header-navbar-wrapper.component.ts
sed -i -E "s#^  templateUrl: .*#  templateUrl: './header-navbar-wrapper.component.html',#" $f
grep -q "templateUrl: './header-navbar-wrapper.component.html'" $f
grep -q "selector: 'ds-themed-home-page'" src/themes/nvc/app/home-page/home-page.component.ts
# Faculty Profiles collection = Faculty Directory (own component, no rewiring needed)
grep -q DIRECTORY_HANDLES src/themes/nvc/app/collection-page/collection-page.component.ts
test -f src/themes/nvc/app/faculty-directory/faculty-directory.component.ts
# Question Paper Archive + Faculty Publications communities = own pages (community-page override)
grep -q NVC_PAGES src/themes/nvc/app/community-page/community-page.component.ts
test -f src/themes/nvc/app/qp-archive/qp-archive.component.ts
test -f src/themes/nvc/app/research-output/research-output.component.ts

# 4. register the theme: style bundle + eager/listable components
python3 - <<'PY'
import json
p = "angular.json"
a = json.load(open(p))
styles = a["projects"]["dspace-angular"]["architect"]["build"]["options"]["styles"]
if not any(isinstance(s, dict) and s.get("bundleName") == "nvc-theme" for s in styles):
    styles.append({"input": "src/themes/nvc/styles/theme.scss", "inject": False, "bundleName": "nvc-theme"})
json.dump(a, open(p, "w"), indent=2)
open(p, "a").write("\n")
PY
f=src/themes/eager-themes-components.ts
grep -q NVC_THEME_EAGER $f || {
  sed -i "1i import { COMPONENTS as NVC_THEME_EAGER_COMPONENTS } from './nvc/eager-theme-components';" $f
  sed -i "s#^  \.\.\.DSPACE_THEME_EAGER_COMPONENTS,#  ...NVC_THEME_EAGER_COMPONENTS,\n  ...DSPACE_THEME_EAGER_COMPONENTS,#" $f
}
f=src/themes/themes-listable-components.ts
grep -q NVC_LISTABLE $f || {
  sed -i "1i import { LISTABLE_COMPONENTS as NVC_LISTABLE_COMPONENTS } from './nvc/lazy-listable-components';" $f
  sed -i "s#^  \.\.\.DSPACE_LISTABLE_COMPONENTS,#  ...NVC_LISTABLE_COMPONENTS,\n  ...DSPACE_LISTABLE_COMPONENTS,#" $f
}
grep -q NVC_THEME_EAGER_COMPONENTS, src/themes/eager-themes-components.ts
grep -q NVC_LISTABLE_COMPONENTS, src/themes/themes-listable-components.ts

# 5. theme labels (site title) merged into the i18n files
chown -R dspace:dspace $SRC/src $SRC/angular.json
su dspace -s /bin/bash -c "cd $SRC && export PATH=/opt/node/bin:\$PATH && npm run merge-i18n -- -s src/themes/nvc/assets/i18n"
grep -q '"repository.title": "Knowledge Hub"' src/assets/i18n/en.json5

# 6. production build (about 10-25 min)
su dspace -s /bin/bash -c "cd $SRC && export PATH=/opt/node/bin:\$PATH && NODE_OPTIONS=--max-old-space-size=4096 npm run build:prod"
ls -ld $SRC/dist/browser $SRC/dist/server
echo "BUILD OK $(date)"
