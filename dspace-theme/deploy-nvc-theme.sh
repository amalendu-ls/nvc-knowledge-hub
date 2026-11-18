#!/bin/bash
# Switch repo.nvc.ac.in to the freshly built Knowledge Hub (nvc) theme (run inside CT101 as root).
#   bash deploy-nvc-theme.sh            -> deploy
#   bash deploy-nvc-theme.sh rollback   -> restore the previous build + config
set -euo pipefail
UI=/opt/dspace-ui
SRC=/opt/dspace-angular-src
PM2="su - dspace -s /bin/bash -c 'PATH=/opt/node/bin:\$PATH pm2 reload dspace-ui'"

if [ "${1:-}" = rollback ]; then
  last=$(ls -d $UI/dist.bak-* | sort | tail -1)
  rm -rf $UI/dist && cp -a "$last" $UI/dist
  cp -a "$UI/config/config.prod.yml.bak-${last##*.bak-}" $UI/config/config.prod.yml
  eval "$PM2"
  echo "rolled back to $last"; exit 0
fi

# both bundles must have completed ("Build at:" twice), no errors, and the NVC theme CSS must exist
[ "$(grep -c '^Build at:' /root/nvc-theme-build.log)" -ge 2 ] && ! grep -qE 'error TS|^Error|Killed' /root/nvc-theme-build.log   && ls $SRC/dist/browser/nvc-theme*.css >/dev/null 2>&1 && [ -s $SRC/dist/server/main.js ]   || { echo "build did not finish OK - not deploying"; exit 1; }
TS=$(date +%Y%m%d%H%M)
cp -a $UI/dist $UI/dist.bak-$TS
cp -a $UI/config/config.prod.yml $UI/config/config.prod.yml.bak-$TS
# theme block (with the college emblem as favicon) - replaces any earlier themes: block
python3 - <<'PY'
p = "/opt/dspace-ui/config/config.prod.yml"
s = open(p).read()
if "themes:" in s:
    s = s[:s.index("themes:")].rstrip() + chr(10)
s += """themes:
  - name: nvc
    headTags:
      - tagName: link
        attributes:
          rel: icon
          href: assets/nvc/favicon.ico
          sizes: any
      - tagName: link
        attributes:
          rel: icon
          href: assets/nvc/favicon-32.png
          type: image/png
          sizes: 32x32
      - tagName: link
        attributes:
          rel: apple-touch-icon
          href: assets/nvc/apple-touch-icon.png
"""
open(p, "w").write(s)
PY
rm -rf $UI/dist.new && cp -a $SRC/dist $UI/dist.new && chown -R dspace:dspace $UI/dist.new $UI/config
rm -rf $UI/dist && mv $UI/dist.new $UI/dist
# hourly "Downloads (30 days)" figure for the homepage
install -m 755 /tmp/nvc-stats.sh /usr/local/bin/nvc-stats.sh
echo '7 * * * * root /usr/local/bin/nvc-stats.sh' > /etc/cron.d/nvc-stats
/usr/local/bin/nvc-stats.sh || echo "note: stats job failed (homepage shows - for downloads)"
eval "$PM2"
echo "deployed; backup = $UI/dist.bak-$TS"
