#!/bin/bash
# Knowledge Hub homepage: file downloads in the last 30 days, from DSpace's own usage statistics
# (Solr "statistics" core; bitstream views of ORIGINAL files, bots excluded). Runs hourly from
# /etc/cron.d/nvc-stats and writes a small JSON file the homepage reads.
set -euo pipefail
OUT=/opt/dspace-ui/dist/browser/assets/nvc-stats.json
Q='q=type:0&fq=statistics_type:view&fq=-isBot:true&fq=bundleName:ORIGINAL&fq=time:%5BNOW-30DAYS%20TO%20NOW%5D&rows=0&wt=json'
n=$(curl -sf "http://localhost:8983/solr/statistics/select?$Q" | grep -o '"numFound":[0-9]*' | cut -d: -f2)
[ -n "$n" ] || exit 1
printf '{"downloads30": %s, "updated": "%s"}\n' "$n" "$(date -Iseconds)" > "$OUT.tmp"
chown dspace:dspace "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
