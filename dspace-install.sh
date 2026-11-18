#!/bin/bash
# DSpace 10.1 install for CT 101 (nvc-dspace, <DSPACE_IP>), Ubuntu 24.04.
# Resumable: each finished stage leaves a marker in /root/.dsi/ -- just re-run after a failure.
# Log: /root/dspace-install.log
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
M=/root/.dsi; mkdir -p $M
DS_VER=10.1; SOLR_VER=9.10.1; MVN_VER=3.9.16; NODE_VER=22.23.3
DSPACE=/dspace; SRC=/opt/dspace-src; UI_SRC=/opt/dspace-angular-src; UI=/opt/dspace-ui
HOST=repo.nvc.ac.in
step(){ echo; echo "===== $(date '+%F %T') STAGE $1 ====="; }
has(){ [ -f $M/$1 ]; }
fin(){ touch $M/$1; echo "----- $(date '+%F %T') done: $1"; }
dl(){ curl -fL --retry 5 --retry-delay 15 -o "$2" "$1"; }
apache(){ dl "https://dlcdn.apache.org/$1" "$2" || dl "https://archive.apache.org/dist/$1" "$2"; }

if ! has 01-apt; then step "01 apt packages (JDK 21, Ant, PostgreSQL)"
  apt-get update
  apt-get -y install openjdk-21-jdk-headless ant postgresql curl unzip xz-utils lsof ca-certificates openssl
  fin 01-apt; fi

if ! has 02-maven; then step "02 Maven $MVN_VER"
  apache maven/maven-3/$MVN_VER/binaries/apache-maven-$MVN_VER-bin.tar.gz /tmp/mvn.tgz
  rm -rf /opt/maven && mkdir -p /opt/maven && tar xzf /tmp/mvn.tgz -C /opt/maven --strip-components=1
  ln -sf /opt/maven/bin/mvn /usr/local/bin/mvn
  fin 02-maven; fi

if ! has 03-node; then step "03 Node.js $NODE_VER + pm2"
  dl https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.xz /tmp/node.txz
  rm -rf /opt/node && mkdir -p /opt/node && tar xJf /tmp/node.txz -C /opt/node --strip-components=1
  for b in node npm npx; do ln -sf /opt/node/bin/$b /usr/local/bin/$b; done
  npm install -g --no-fund --no-audit pm2
  ln -sf /opt/node/bin/pm2 /usr/local/bin/pm2
  fin 03-node; fi

if ! has 04-solr; then step "04 Solr $SOLR_VER (service, localhost only, 2 GB heap)"
  apache solr/solr/$SOLR_VER/solr-$SOLR_VER.tgz /tmp/solr-$SOLR_VER.tgz
  tar xzf /tmp/solr-$SOLR_VER.tgz -C /tmp solr-$SOLR_VER/bin/install_solr_service.sh --strip-components=2
  bash /tmp/install_solr_service.sh /tmp/solr-$SOLR_VER.tgz -n
  cat >> /etc/default/solr.in.sh <<'X'
SOLR_HEAP="2g"
SOLR_JETTY_HOST="127.0.0.1"
SOLR_OPTS="$SOLR_OPTS -Dsolr.config.lib.enabled=true"
X
  fin 04-solr; fi

if ! has 05-db; then step "05 PostgreSQL database 'dspace' (random password)"
  systemctl enable --now postgresql
  DBPASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 24)
  su postgres -c "psql -v ON_ERROR_STOP=1" <<X
CREATE USER dspace WITH PASSWORD '$DBPASS';
CREATE DATABASE dspace OWNER dspace TEMPLATE template0 ENCODING 'UTF8';
X
  umask 077; echo "$DBPASS" > /root/.dspace-db-password
  fin 05-db; fi
DBPASS=$(cat /root/.dspace-db-password)

if ! has 06-src; then step "06 DSpace $DS_VER backend source"
  id dspace >/dev/null 2>&1 || useradd -m -s /bin/bash dspace
  dl https://github.com/DSpace/DSpace/archive/refs/tags/dspace-$DS_VER.tar.gz /tmp/dspace.tgz
  rm -rf $SRC && mkdir -p $SRC && tar xzf /tmp/dspace.tgz -C $SRC --strip-components=1
  mkdir -p $DSPACE && chown -R dspace:dspace $SRC $DSPACE
  fin 06-src; fi

step "07 local.cfg"
cat > $SRC/dspace/config/local.cfg <<X
dspace.dir = $DSPACE
dspace.server.url = https://$HOST/server
dspace.ui.url = https://$HOST
dspace.name = NVC Central Library Repository
solr.server = http://localhost:8983/solr
db.url = jdbc:postgresql://localhost:5432/dspace
db.username = dspace
db.password = $DBPASS
# Trust X-Forwarded-* only from the reverse proxy (CT 103)
proxies.trusted.ipranges = <PROXY_IP>
# Email (Gmail). Add mail.server.username / mail.server.password yourself, then restart dspace-backend.
mail.server = smtp.gmail.com
mail.server.port = 587
mail.extraproperties = mail.smtp.starttls.enable=true
mail.from.address = dspace-admin@example.edu
feedback.recipient = dspace-admin@example.edu
mail.admin = dspace-admin@example.edu
alert.recipient = dspace-admin@example.edu
X
chown dspace:dspace $SRC/dspace/config/local.cfg; chmod 640 $SRC/dspace/config/local.cfg

if ! has 08-build; then step "08 mvn package (downloads several hundred MB of Java libraries)"
  su dspace -c "cd $SRC && mvn -B -ntp package"
  fin 08-build; fi

if ! has 09-install; then step "09 ant fresh_install + database migrate"
  su dspace -c "cd $SRC/dspace/target/dspace-installer && ant fresh_install"
  su dspace -c "$DSPACE/bin/dspace database migrate"
  fin 09-install; fi

if ! has 10-cores; then step "10 Solr cores"
  mkdir -p /var/solr/data/configsets
  cp -R $DSPACE/solr/* /var/solr/data/configsets/
  chown -R solr:solr /var/solr/data
  systemctl enable solr; systemctl restart solr
  for i in $(seq 1 30); do curl -fs "http://localhost:8983/solr/search/select?q=*:*" >/dev/null && break; sleep 5; done
  curl -fs "http://localhost:8983/solr/search/select?q=*:*" >/dev/null && echo "Solr 'search' core OK"
  fin 10-cores; fi

if ! has 11-ui-build; then step "11 Frontend build (npm downloads ~1 GB)"
  dl https://github.com/DSpace/dspace-angular/archive/refs/tags/dspace-$DS_VER.tar.gz /tmp/ui.tgz
  rm -rf $UI_SRC && mkdir -p $UI_SRC && tar xzf /tmp/ui.tgz -C $UI_SRC --strip-components=1
  chown -R dspace:dspace $UI_SRC
  su dspace -c "cd $UI_SRC && npm ci --no-audit --no-fund && NODE_OPTIONS=--max-old-space-size=4096 npm run build:prod"
  fin 11-ui-build; fi

if ! has 12-ui-deploy; then step "12 Frontend deploy + config"
  mkdir -p $UI/config && rm -rf $UI/dist && cp -r $UI_SRC/dist $UI/
  cat > $UI/config/config.prod.yml <<X
ui:
  ssl: false
  host: 0.0.0.0
  port: 4000
  nameSpace: /
  baseUrl: https://$HOST
rest:
  ssl: true
  host: $HOST
  port: 443
  nameSpace: /server
X
  cat > $UI/dspace-ui.json <<X
{ "apps": [ { "name": "dspace-ui", "cwd": "$UI", "script": "dist/server/main.js",
  "instances": 2, "exec_mode": "cluster", "env": { "NODE_ENV": "production" } } ] }
X
  chown -R dspace:dspace $UI
  fin 12-ui-deploy; fi

if ! has 13-services; then step "13 Services (backend via systemd, UI via pm2)"
  cat > /etc/systemd/system/dspace-backend.service <<X
[Unit]
Description=DSpace backend (REST API, port 8080)
After=network.target postgresql.service solr.service
Requires=postgresql.service

[Service]
User=dspace
WorkingDirectory=$DSPACE
ExecStart=/usr/bin/java -Xmx2g -Dfile.encoding=UTF-8 -jar $DSPACE/webapps/server-boot.jar
SuccessExitStatus=143
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
X
  systemctl daemon-reload
  systemctl enable --now dspace-backend
  su dspace -c "pm2 start $UI/dspace-ui.json && pm2 save"
  pm2 startup systemd -u dspace --hp /home/dspace
  fin 13-services; fi

step "14 Checks"
for i in $(seq 1 60); do curl -fs http://localhost:8080/server/api >/dev/null && break; sleep 5; done
curl -fs http://localhost:8080/server/api >/dev/null && echo "Backend REST API: OK" || echo "Backend REST API: NOT RESPONDING (see journalctl -u dspace-backend)"
curl -fsI http://localhost:4000 >/dev/null && echo "Frontend :4000: OK" || echo "Frontend :4000: not OK yet (expected until DNS + HTTPS proxy exist)"
curl -fs "http://localhost:8983/solr/search/select?q=*:*" >/dev/null && echo "Solr: OK" || echo "Solr: NOT OK"
echo "INSTALL-FINISHED"
