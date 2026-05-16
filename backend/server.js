const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { Client } = require('ssh2');
const Database   = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const http       = require('http');
const WebSocket  = require('ws');
const multer     = require('multer');
const unzipper   = require('unzipper');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── DB ──────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || '/data/dashboard.db';
const dbDir   = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
    port INTEGER DEFAULT 22, username TEXT NOT NULL,
    password TEXT, ssh_key TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY, server_id TEXT NOT NULL, name TEXT NOT NULL,
    container_name TEXT NOT NULL, n8n_port INTEGER NOT NULL,
    status TEXT DEFAULT 'unknown', webhook_url TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(server_id) REFERENCES servers(id)
  );
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS catalog (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT NOT NULL,
    description TEXT DEFAULT '', category TEXT DEFAULT 'Sonstige',
    ports TEXT DEFAULT '[]', env TEXT DEFAULT '[]',
    volumes TEXT DEFAULT '[]', restart TEXT DEFAULT 'unless-stopped',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ─── Seed catalog ─────────────────────────────────────────────
const SEED_CATALOG = [
  // Automation
  { name:'n8n', image:'n8nio/n8n', description:'Workflow-Automatisierung & KI-Pipelines', category:'Automation', ports:[{host:5678,container:5678}], env:[{key:'N8N_BASIC_AUTH_ACTIVE',val:'true'},{key:'N8N_BASIC_AUTH_USER',val:'admin'},{key:'N8N_BASIC_AUTH_PASSWORD',val:'changeme123'},{key:'GENERIC_TIMEZONE',val:'Europe/Berlin'}], volumes:[{host:'n8n_data',container:'/home/node/.n8n'}] },
  { name:'Activepieces', image:'activepieces/activepieces:latest', description:'Open-Source Automatisierungsplattform', category:'Automation', ports:[{host:8080,container:80}], env:[{key:'AP_ENCRYPTION_KEY',val:'changeme32charkey1234567890abcd'},{key:'AP_JWT_SECRET',val:'changeme-jwt-secret'}], volumes:[{host:'activepieces_data',container:'/root/.activepieces'}] },
  { name:'Windmill', image:'ghcr.io/windmill-labs/windmill:main', description:'Developer-Platform & Script-Runner', category:'Automation', ports:[{host:8000,container:8000}], env:[{key:'DATABASE_URL',val:'postgresql://admin:changeme123@localhost/windmill'}], volumes:[] },
  { name:'Huginn', image:'ghcr.io/huginn/huginn:latest', description:'Agent-basierte Automatisierung', category:'Automation', ports:[{host:3000,container:3000}], env:[{key:'HUGINN_DATABASE_ADAPTER',val:'sqlite3'},{key:'HUGINN_DATABASE_NAME',val:'/app/db/development.sqlite3'}], volumes:[{host:'huginn_db',container:'/app/db'}] },
  // Web
  { name:'WordPress', image:'wordpress:latest', description:'Content-Management-System', category:'Web', ports:[{host:8080,container:80}], env:[{key:'WORDPRESS_DB_HOST',val:'127.0.0.1'},{key:'WORDPRESS_DB_USER',val:'wp'},{key:'WORDPRESS_DB_PASSWORD',val:'changeme123'},{key:'WORDPRESS_DB_NAME',val:'wordpress'}], volumes:[{host:'wp_data',container:'/var/www/html'}] },
  { name:'Nginx', image:'nginx:latest', description:'Web-Server & Reverse Proxy', category:'Web', ports:[{host:8080,container:80}], env:[], volumes:[{host:'nginx_html',container:'/usr/share/nginx/html'}] },
  { name:'Ghost', image:'ghost:latest', description:'Blog & Publishing-Plattform', category:'Web', ports:[{host:2368,container:2368}], env:[{key:'url',val:'http://localhost:2368'},{key:'database__client',val:'sqlite3'}], volumes:[{host:'ghost_content',container:'/var/lib/ghost/content'}] },
  { name:'Drupal', image:'drupal:latest', description:'Enterprise CMS', category:'Web', ports:[{host:8080,container:80}], env:[], volumes:[{host:'drupal_modules',container:'/var/www/html/modules'},{host:'drupal_sites',container:'/var/www/html/sites'}] },
  { name:'Joomla', image:'joomla:latest', description:'CMS & Web-Framework', category:'Web', ports:[{host:8080,container:80}], env:[{key:'JOOMLA_DB_HOST',val:'localhost'},{key:'JOOMLA_DB_USER',val:'joomla'},{key:'JOOMLA_DB_PASSWORD',val:'changeme123'}], volumes:[{host:'joomla_data',container:'/var/www/html'}] },
  { name:'Traefik', image:'traefik:latest', description:'Moderner Reverse Proxy & Load Balancer', category:'Web', ports:[{host:80,container:80},{host:8080,container:8080},{host:443,container:443}], env:[], volumes:[{host:'/var/run/docker.sock',container:'/var/run/docker.sock'},{host:'traefik_data',container:'/etc/traefik'}] },
  { name:'Caddy', image:'caddy:latest', description:'Automatisches HTTPS Web-Server', category:'Web', ports:[{host:80,container:80},{host:443,container:443}], env:[], volumes:[{host:'caddy_data',container:'/data'},{host:'caddy_config',container:'/config'}] },
  { name:'Matomo', image:'matomo:latest', description:'Privacy-freundliche Web-Analyse', category:'Web', ports:[{host:8080,container:80}], env:[{key:'MATOMO_DATABASE_HOST',val:'localhost'},{key:'MATOMO_DATABASE_USERNAME',val:'matomo'},{key:'MATOMO_DATABASE_PASSWORD',val:'changeme123'}], volumes:[{host:'matomo_data',container:'/var/www/html'}] },
  // Storage
  { name:'Nextcloud', image:'nextcloud:latest', description:'Self-hosted Cloud-Speicher & Kollaboration', category:'Storage', ports:[{host:8080,container:80}], env:[{key:'NEXTCLOUD_ADMIN_USER',val:'admin'},{key:'NEXTCLOUD_ADMIN_PASSWORD',val:'changeme123'},{key:'NEXTCLOUD_TRUSTED_DOMAINS',val:'*'}], volumes:[{host:'nextcloud_data',container:'/var/www/html'}] },
  { name:'Seafile', image:'seafileltd/seafile-mc:latest', description:'Schnelle & zuverlässige Datei-Sync', category:'Storage', ports:[{host:8080,container:80}], env:[{key:'DB_HOST',val:'127.0.0.1'},{key:'SEAFILE_ADMIN_EMAIL',val:'admin@example.com'},{key:'SEAFILE_ADMIN_PASSWORD',val:'changeme123'},{key:'SEAFILE_SERVER_HOSTNAME',val:'localhost:8080'}], volumes:[{host:'seafile_data',container:'/shared'}] },
  { name:'MinIO', image:'minio/minio:latest', description:'S3-kompatibler Objekt-Speicher', category:'Storage', ports:[{host:9000,container:9000},{host:9001,container:9001}], env:[{key:'MINIO_ROOT_USER',val:'admin'},{key:'MINIO_ROOT_PASSWORD',val:'changeme123'}], volumes:[{host:'minio_data',container:'/data'}] },
  { name:'Filebrowser', image:'filebrowser/filebrowser:latest', description:'Web-basierter Datei-Manager', category:'Storage', ports:[{host:8080,container:80}], env:[], volumes:[{host:'/srv',container:'/srv'},{host:'filebrowser_db',container:'/database'}] },
  { name:'Syncthing', image:'syncthing/syncthing:latest', description:'Kontinuierliche Datei-Synchronisation', category:'Storage', ports:[{host:8384,container:8384},{host:22000,container:22000}], env:[], volumes:[{host:'syncthing_data',container:'/var/syncthing'}] },
  // Datenbank
  { name:'PostgreSQL', image:'postgres:16', description:'Relationale Datenbank', category:'Datenbank', ports:[{host:5432,container:5432}], env:[{key:'POSTGRES_USER',val:'admin'},{key:'POSTGRES_PASSWORD',val:'changeme123'},{key:'POSTGRES_DB',val:'mydb'}], volumes:[{host:'pg_data',container:'/var/lib/postgresql/data'}] },
  { name:'MariaDB', image:'mariadb:latest', description:'MySQL-kompatible Datenbank', category:'Datenbank', ports:[{host:3306,container:3306}], env:[{key:'MYSQL_ROOT_PASSWORD',val:'changeme123'},{key:'MYSQL_DATABASE',val:'mydb'},{key:'MYSQL_USER',val:'admin'},{key:'MYSQL_PASSWORD',val:'changeme123'}], volumes:[{host:'mariadb_data',container:'/var/lib/mysql'}] },
  { name:'MongoDB', image:'mongo:latest', description:'NoSQL-Dokumenten-Datenbank', category:'Datenbank', ports:[{host:27017,container:27017}], env:[{key:'MONGO_INITDB_ROOT_USERNAME',val:'admin'},{key:'MONGO_INITDB_ROOT_PASSWORD',val:'changeme123'}], volumes:[{host:'mongo_data',container:'/data/db'}] },
  { name:'Redis', image:'redis:alpine', description:'In-Memory Cache & Message Broker', category:'Datenbank', ports:[{host:6379,container:6379}], env:[], volumes:[{host:'redis_data',container:'/data'}] },
  { name:'InfluxDB', image:'influxdb:latest', description:'Zeitreihen-Datenbank', category:'Datenbank', ports:[{host:8086,container:8086}], env:[{key:'DOCKER_INFLUXDB_INIT_MODE',val:'setup'},{key:'DOCKER_INFLUXDB_INIT_USERNAME',val:'admin'},{key:'DOCKER_INFLUXDB_INIT_PASSWORD',val:'changeme123'},{key:'DOCKER_INFLUXDB_INIT_ORG',val:'myorg'},{key:'DOCKER_INFLUXDB_INIT_BUCKET',val:'mybucket'}], volumes:[{host:'influxdb_data',container:'/var/lib/influxdb2'}] },
  { name:'CouchDB', image:'couchdb:latest', description:'Document-Datenbank mit HTTP-API', category:'Datenbank', ports:[{host:5984,container:5984}], env:[{key:'COUCHDB_USER',val:'admin'},{key:'COUCHDB_PASSWORD',val:'changeme123'}], volumes:[{host:'couchdb_data',container:'/opt/couchdb/data'}] },
  { name:'Adminer', image:'adminer:latest', description:'Datenbank-Management UI', category:'Datenbank', ports:[{host:8080,container:8080}], env:[], volumes:[] },
  { name:'pgAdmin', image:'dpage/pgadmin4:latest', description:'PostgreSQL Admin-UI', category:'Datenbank', ports:[{host:5050,container:80}], env:[{key:'PGADMIN_DEFAULT_EMAIL',val:'admin@admin.com'},{key:'PGADMIN_DEFAULT_PASSWORD',val:'changeme123'}], volumes:[{host:'pgadmin_data',container:'/var/lib/pgadmin'}] },
  // DevOps
  { name:'Portainer', image:'portainer/portainer-ce:latest', description:'Docker-Management-UI', category:'DevOps', ports:[{host:9000,container:9000},{host:9443,container:9443}], env:[], volumes:[{host:'/var/run/docker.sock',container:'/var/run/docker.sock'},{host:'portainer_data',container:'/data'}] },
  { name:'Gitea', image:'gitea/gitea:latest', description:'Self-hosted Git-Service', category:'DevOps', ports:[{host:3000,container:3000},{host:2222,container:22}], env:[{key:'GITEA__database__DB_TYPE',val:'sqlite3'}], volumes:[{host:'gitea_data',container:'/data'}] },
  { name:'GitLab CE', image:'gitlab/gitlab-ce:latest', description:'Komplette DevOps-Platform', category:'DevOps', ports:[{host:8080,container:80},{host:2222,container:22}], env:[{key:'GITLAB_OMNIBUS_CONFIG',val:"external_url 'http://localhost:8080'"}], volumes:[{host:'gitlab_config',container:'/etc/gitlab'},{host:'gitlab_data',container:'/var/opt/gitlab'},{host:'gitlab_logs',container:'/var/log/gitlab'}] },
  { name:'Drone CI', image:'drone/drone:latest', description:'Container-native CI/CD', category:'DevOps', ports:[{host:80,container:80},{host:443,container:443}], env:[{key:'DRONE_GITEA_SERVER',val:'http://localhost:3000'},{key:'DRONE_RPC_SECRET',val:'changeme-secret'},{key:'DRONE_SERVER_HOST',val:'localhost'},{key:'DRONE_SERVER_PROTO',val:'http'}], volumes:[{host:'drone_data',container:'/data'}] },
  { name:'Nexus Repository', image:'sonatype/nexus3:latest', description:'Artifact Repository Manager', category:'DevOps', ports:[{host:8081,container:8081}], env:[], volumes:[{host:'nexus_data',container:'/nexus-data'}] },
  { name:'Registry', image:'registry:latest', description:'Docker Image Registry', category:'DevOps', ports:[{host:5000,container:5000}], env:[], volumes:[{host:'registry_data',container:'/var/lib/registry'}] },
  // Monitoring
  { name:'Grafana', image:'grafana/grafana:latest', description:'Monitoring & Dashboards', category:'Monitoring', ports:[{host:3000,container:3000}], env:[{key:'GF_SECURITY_ADMIN_USER',val:'admin'},{key:'GF_SECURITY_ADMIN_PASSWORD',val:'changeme123'}], volumes:[{host:'grafana_data',container:'/var/lib/grafana'}] },
  { name:'Uptime Kuma', image:'louislam/uptime-kuma:latest', description:'Self-hosted Service-Monitoring', category:'Monitoring', ports:[{host:3001,container:3001}], env:[], volumes:[{host:'uptime_data',container:'/app/data'}] },
  { name:'Prometheus', image:'prom/prometheus:latest', description:'Monitoring & Alerting', category:'Monitoring', ports:[{host:9090,container:9090}], env:[], volumes:[{host:'prometheus_data',container:'/prometheus'},{host:'prometheus_config',container:'/etc/prometheus'}] },
  { name:'Netdata', image:'netdata/netdata:latest', description:'Echtzeit-Performance-Monitoring', category:'Monitoring', ports:[{host:19999,container:19999}], env:[], volumes:[{host:'/etc/passwd',container:'/host/etc/passwd:ro'},{host:'/proc',container:'/host/proc:ro'},{host:'/sys',container:'/host/sys:ro'}] },
  { name:'Zabbix', image:'zabbix/zabbix-server-pgsql:latest', description:'Enterprise-Monitoring-Lösung', category:'Monitoring', ports:[{host:10051,container:10051}], env:[{key:'DB_SERVER_HOST',val:'localhost'},{key:'POSTGRES_USER',val:'zabbix'},{key:'POSTGRES_PASSWORD',val:'changeme123'}], volumes:[] },
  { name:'Loki', image:'grafana/loki:latest', description:'Log-Aggregation System', category:'Monitoring', ports:[{host:3100,container:3100}], env:[], volumes:[{host:'loki_data',container:'/loki'}] },
  // Security
  { name:'Vaultwarden', image:'vaultwarden/server:latest', description:'Bitwarden-kompatibler Passwort-Manager', category:'Security', ports:[{host:8080,container:80}], env:[{key:'ADMIN_TOKEN',val:'changeme-secure-token'},{key:'WEBSOCKET_ENABLED',val:'true'}], volumes:[{host:'vaultwarden_data',container:'/data'}] },
  { name:'Authentik', image:'ghcr.io/goauthentik/server:latest', description:'Identity Provider & SSO', category:'Security', ports:[{host:9000,container:9000},{host:9443,container:9443}], env:[{key:'AUTHENTIK_SECRET_KEY',val:'changeme-very-long-secret-key-here'},{key:'AUTHENTIK_REDIS__HOST',val:'localhost'},{key:'AUTHENTIK_POSTGRESQL__HOST',val:'localhost'},{key:'AUTHENTIK_POSTGRESQL__USER',val:'authentik'},{key:'AUTHENTIK_POSTGRESQL__PASSWORD',val:'changeme123'}], volumes:[{host:'authentik_media',container:'/media'},{host:'authentik_templates',container:'/templates'}] },
  { name:'Authelia', image:'authelia/authelia:latest', description:'Multi-Faktor Auth & SSO', category:'Security', ports:[{host:9091,container:9091}], env:[{key:'TZ',val:'Europe/Berlin'}], volumes:[{host:'authelia_config',container:'/config'}] },
  { name:'CrowdSec', image:'crowdsecurity/crowdsec:latest', description:'Kollaborative Intrusion Prevention', category:'Security', ports:[{host:8080,container:8080},{host:6060,container:6060}], env:[], volumes:[{host:'crowdsec_config',container:'/etc/crowdsec'},{host:'crowdsec_data',container:'/var/lib/crowdsec/data'},{host:'/var/log',container:'/var/log:ro'}] },
  { name:'Fail2ban', image:'crazymax/fail2ban:latest', description:'Brute-Force-Schutz', category:'Security', ports:[], env:[{key:'TZ',val:'Europe/Berlin'},{key:'F2B_LOG_LEVEL',val:'INFO'}], volumes:[{host:'/var/log',container:'/var/log:ro'},{host:'fail2ban_data',container:'/data'}] },
  // Media
  { name:'Jellyfin', image:'jellyfin/jellyfin:latest', description:'Freier Media-Server', category:'Media', ports:[{host:8096,container:8096}], env:[], volumes:[{host:'jellyfin_config',container:'/config'},{host:'jellyfin_cache',container:'/cache'},{host:'/media',container:'/media'}] },
  { name:'Plex', image:'plexinc/pms-docker:latest', description:'Media-Server & Streaming', category:'Media', ports:[{host:32400,container:32400}], env:[{key:'TZ',val:'Europe/Berlin'},{key:'PLEX_CLAIM',val:''}], volumes:[{host:'plex_config',container:'/config'},{host:'/media',container:'/data'}] },
  { name:'Navidrome', image:'deluan/navidrome:latest', description:'Musik-Streaming-Server', category:'Media', ports:[{host:4533,container:4533}], env:[{key:'ND_SCANSCHEDULE',val:'1h'},{key:'ND_LOGLEVEL',val:'info'},{key:'ND_SESSIONTIMEOUT',val:'24h'}], volumes:[{host:'navidrome_data',container:'/data'},{host:'/music',container:'/music:ro'}] },
  { name:'Immich', image:'ghcr.io/immich-app/immich-server:release', description:'Self-hosted Foto & Video Backup', category:'Media', ports:[{host:2283,container:3001}], env:[{key:'DB_HOSTNAME',val:'localhost'},{key:'DB_USERNAME',val:'postgres'},{key:'DB_PASSWORD',val:'changeme123'},{key:'DB_DATABASE_NAME',val:'immich'},{key:'REDIS_HOSTNAME',val:'localhost'}], volumes:[{host:'immich_upload',container:'/usr/src/app/upload'}] },
  { name:'Photoprism', image:'photoprism/photoprism:latest', description:'KI-gestützte Foto-Verwaltung', category:'Media', ports:[{host:2342,container:2342}], env:[{key:'PHOTOPRISM_ADMIN_USER',val:'admin'},{key:'PHOTOPRISM_ADMIN_PASSWORD',val:'changeme123'},{key:'PHOTOPRISM_AUTH_MODE',val:'password'},{key:'PHOTOPRISM_SITE_URL',val:'http://localhost:2342/'}], volumes:[{host:'photoprism_originals',container:'/photoprism/originals'},{host:'photoprism_storage',container:'/photoprism/storage'}] },
  { name:'Kavita', image:'jvmilazz0/kavita:latest', description:'Manga/Comic/E-Book Reader', category:'Media', ports:[{host:5000,container:5000}], env:[], volumes:[{host:'kavita_config',container:'/kavita/config'},{host:'/books',container:'/books'}] },
  // Kommunikation
  { name:'Rocket.Chat', image:'rocket.chat:latest', description:'Self-hosted Team-Chat', category:'Kommunikation', ports:[{host:3000,container:3000}], env:[{key:'ROOT_URL',val:'http://localhost:3000'},{key:'MONGO_URL',val:'mongodb://localhost:27017/rocketchat'}], volumes:[{host:'rocketchat_uploads',container:'/app/uploads'}] },
  { name:'Matrix Synapse', image:'matrixdotorg/synapse:latest', description:'Matrix-Protokoll Homeserver', category:'Kommunikation', ports:[{host:8448,container:8448}], env:[{key:'SYNAPSE_SERVER_NAME',val:'localhost'},{key:'SYNAPSE_REPORT_STATS',val:'no'}], volumes:[{host:'synapse_data',container:'/data'}] },
  { name:'Mattermost', image:'mattermost/mattermost-team-edition:latest', description:'Open-Source Slack-Alternative', category:'Kommunikation', ports:[{host:8065,container:8065}], env:[{key:'MM_SQLSETTINGS_DRIVERNAME',val:'postgres'},{key:'MM_SQLSETTINGS_DATASOURCE',val:'postgres://admin:changeme123@localhost/mattermost?sslmode=disable'}], volumes:[{host:'mattermost_data',container:'/mattermost/data'},{host:'mattermost_logs',container:'/mattermost/logs'}] },
  { name:'Jitsi Meet', image:'jitsi/web:latest', description:'Video-Konferenz-System', category:'Kommunikation', ports:[{host:80,container:80},{host:443,container:443}], env:[{key:'PUBLIC_URL',val:'https://localhost'},{key:'ENABLE_AUTH',val:'0'}], volumes:[] },
  { name:'Listmonk', image:'listmonk/listmonk:latest', description:'Newsletter & Mailing-Listen Manager', category:'Kommunikation', ports:[{host:9000,container:9000}], env:[{key:'LISTMONK_app__address',val:'0.0.0.0:9000'},{key:'LISTMONK_db__host',val:'localhost'},{key:'LISTMONK_db__password',val:'changeme123'}], volumes:[{host:'listmonk_data',container:'/listmonk/uploads'}] },
  // Produktivität
  { name:'Nextcloud Office', image:'collabora/code:latest', description:'Online-Office-Suite für Nextcloud', category:'Produktivität', ports:[{host:9980,container:9980}], env:[{key:'aliasgroup1',val:'https://localhost:443'},{key:'extra_params',val:'--o:ssl.enable=false'}], volumes:[] },
  { name:'Bookstack', image:'lscr.io/linuxserver/bookstack:latest', description:'Wiki & Dokumentations-Plattform', category:'Produktivität', ports:[{host:6875,container:80}], env:[{key:'PUID',val:'1000'},{key:'PGID',val:'1000'},{key:'APP_URL',val:'http://localhost:6875'},{key:'DB_HOST',val:'localhost'},{key:'DB_USER',val:'bookstack'},{key:'DB_PASS',val:'changeme123'},{key:'DB_DATABASE',val:'bookstackapp'}], volumes:[{host:'bookstack_config',container:'/config'}] },
  { name:'Wikijs', image:'requarks/wiki:2', description:'Modernes Wiki & Knowledge Base', category:'Produktivität', ports:[{host:3000,container:3000}], env:[{key:'DB_TYPE',val:'postgres'},{key:'DB_HOST',val:'localhost'},{key:'DB_PORT',val:'5432'},{key:'DB_USER',val:'wikijs'},{key:'DB_PASS',val:'changeme123'},{key:'DB_NAME',val:'wiki'}], volumes:[] },
  { name:'Outline', image:'outlinewiki/outline:latest', description:'Team-Wiki & Wissensmanagement', category:'Produktivität', ports:[{host:3000,container:3000}], env:[{key:'SECRET_KEY',val:'changeme-32-char-secret-key-here'},{key:'UTILS_SECRET',val:'changeme-utils-secret'},{key:'DATABASE_URL',val:'postgres://admin:changeme123@localhost/outline'},{key:'REDIS_URL',val:'redis://localhost:6379'}], volumes:[{host:'outline_data',container:'/var/lib/outline/data'}] },
  { name:'Vikunja', image:'vikunja/vikunja:latest', description:'To-Do & Projekt-Management', category:'Produktivität', ports:[{host:3456,container:3456}], env:[{key:'VIKUNJA_DATABASE_TYPE',val:'sqlite'},{key:'VIKUNJA_SERVICE_JWTSECRET',val:'changeme-jwt-secret'}], volumes:[{host:'vikunja_data',container:'/app/vikunja/files'}] },
];

{
  const ins = db.prepare("INSERT INTO catalog VALUES (?,?,?,?,?,?,?,?,?,strftime('%s','now'))");
  const existing = new Set(db.prepare('SELECT name FROM catalog').all().map(r => r.name));
  for (const s of SEED_CATALOG) {
    if (!existing.has(s.name)) ins.run(uuidv4(), s.name, s.image, s.description, s.category, JSON.stringify(s.ports), JSON.stringify(s.env), JSON.stringify(s.volumes), s.restart||'unless-stopped');
  }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── SSH Helper ──────────────────────────────────────────────
function sshExec(server, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let out = '', err = '';
    const cfg = { host: server.host, port: server.port || 22, username: server.username, readyTimeout: 15000 };
    if (server.ssh_key?.trim()) cfg.privateKey = server.ssh_key;
    else if (server.password)   cfg.password   = server.password;

    conn.on('ready', () => {
      conn.exec(command, (e, stream) => {
        if (e) { conn.end(); return reject(e); }
        stream
          .on('close', code => { conn.end(); resolve({ output: out || err, code }); })
          .on('data', d => { out += d.toString(); })
          .stderr.on('data', d => { err += d.toString(); });
      });
    }).on('error', reject).connect(cfg);
  });
}

// ─── SFTP Helper ─────────────────────────────────────────────
function sftpUpload(server, files, remoteDir) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const cfg = { host: server.host, port: server.port || 22, username: server.username, readyTimeout: 15000 };
    if (server.ssh_key?.trim()) cfg.privateKey = server.ssh_key;
    else if (server.password)   cfg.password   = server.password;

    conn.on('ready', () => {
      conn.sftp(async (err, sftp) => {
        if (err) { conn.end(); return reject(err); }

        const mkdirpRecursive = async (p) => {
          const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
          let cur = '';
          for (const part of parts) {
            cur += '/' + part;
            await new Promise(r => sftp.mkdir(cur, () => r()));
          }
        };

        try {
          await mkdirpRecursive(remoteDir);
          const createdDirs = new Set();
          for (const file of files) {
            const rp  = `${remoteDir}/${file.path}`;
            const dir = rp.substring(0, rp.lastIndexOf('/'));
            if (!createdDirs.has(dir)) {
              await mkdirpRecursive(dir);
              createdDirs.add(dir);
            }
            await new Promise((res, rej) => {
              const ws = sftp.createWriteStream(rp);
              ws.on('close', res).on('error', rej);
              ws.end(file.content);
            });
          }
          conn.end(); resolve();
        } catch (e) { conn.end(); reject(e); }
      });
    }).on('error', reject).connect(cfg);
  });
}

// ─── SERVERS ─────────────────────────────────────────────────
app.get('/api/servers', (req, res) => {
  res.json(db.prepare('SELECT id,name,host,port,username,created_at FROM servers').all());
});

app.post('/api/servers', (req, res) => {
  const { name, host, port, username, password, ssh_key } = req.body;
  if (!name || !host || !username) return res.status(400).json({ error: 'name, host, username required' });
  const id = uuidv4();
  db.prepare("INSERT INTO servers VALUES (?,?,?,?,?,?,?,strftime('%s','now'))")
    .run(id, name, host, port || 22, username, password || null, ssh_key || null);
  res.json({ id, name, host, port: port || 22, username });
});

app.put('/api/servers/:id', (req, res) => {
  const { name, host, port, username, password, ssh_key } = req.body;
  db.prepare('UPDATE servers SET name=?,host=?,port=?,username=?,password=?,ssh_key=? WHERE id=?')
    .run(name, host, port || 22, username, password || null, ssh_key || null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', (req, res) => {
  db.prepare('DELETE FROM instances WHERE server_id=?').run(req.params.id);
  db.prepare('DELETE FROM servers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/test', async (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!srv) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await sshExec(srv, 'echo OK && docker --version');
    res.json({ ok: true, output: r.output.trim() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── NEXT-PORT ───────────────────────────────────────────────
app.get('/api/next-port', (req, res) => {
  const used = new Set(db.prepare('SELECT n8n_port FROM instances').all().map(r => r.n8n_port));
  let port = parseInt(req.query.from) || 5678;
  while (used.has(port)) port++;
  res.json({ port });
});

// ─── TEMPLATES ───────────────────────────────────────────────
app.get('/api/templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all()
    .map(t => ({ ...t, config: JSON.parse(t.config) })));
});

app.post('/api/templates', (req, res) => {
  const { name, type, config } = req.body;
  if (!name || !type || !config) return res.status(400).json({ error: 'Missing fields' });
  const id = uuidv4();
  db.prepare("INSERT INTO templates VALUES (?,?,?,?,strftime('%s','now'))").run(id, name, type, JSON.stringify(config));
  res.json({ id, name, type, config });
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── CATALOG ─────────────────────────────────────────────────
function parseCatalog(row) {
  return { ...row, ports: JSON.parse(row.ports), env: JSON.parse(row.env), volumes: JSON.parse(row.volumes) };
}
app.get('/api/catalog', (req, res) => {
  res.json(db.prepare('SELECT * FROM catalog ORDER BY category, name').all().map(parseCatalog));
});
app.post('/api/catalog', (req, res) => {
  const { name, image, description='', category='Sonstige', ports=[], env=[], volumes=[], restart='unless-stopped' } = req.body;
  if (!name || !image) return res.status(400).json({ error: 'name und image erforderlich' });
  const id = uuidv4();
  db.prepare("INSERT INTO catalog VALUES (?,?,?,?,?,?,?,?,?,strftime('%s','now'))")
    .run(id, name, image, description, category, JSON.stringify(ports), JSON.stringify(env), JSON.stringify(volumes), restart);
  res.json({ id });
});
app.put('/api/catalog/:id', (req, res) => {
  const { name, image, description='', category='Sonstige', ports=[], env=[], volumes=[], restart='unless-stopped' } = req.body;
  db.prepare('UPDATE catalog SET name=?,image=?,description=?,category=?,ports=?,env=?,volumes=?,restart=? WHERE id=?')
    .run(name, image, description, category, JSON.stringify(ports), JSON.stringify(env), JSON.stringify(volumes), restart, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/catalog/:id', (req, res) => {
  db.prepare('DELETE FROM catalog WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/catalog/hub-search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(q)}&page_size=30&type=image&sort=pull_count&order=desc`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    res.json((data.results || []).map(x => ({
      name:        x.repo_name,
      description: x.short_description || '',
      stars:       x.star_count || 0,
      pulls:       x.pull_count || 0,
      official:    x.is_official || false,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── INSTANCES (list + auto-sync from docker ps) ─────────────
app.get('/api/instances', async (req, res) => {
  const servers = db.prepare('SELECT * FROM servers').all();
  await Promise.all(servers.map(async srv => {
    const server = { host: srv.host, port: srv.port, username: srv.username, password: srv.password, ssh_key: srv.ssh_key };
    try {
      const psRes = await sshExec(server, `docker ps --format "{{.Names}}|{{.Ports}}" 2>/dev/null`);
      const lines = psRes.output.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const [cname, ports] = line.split('|');
        const container = cname.trim();
        const existing = db.prepare('SELECT id FROM instances WHERE container_name=? AND server_id=?').get(container, srv.id);
        if (!existing) {
          const portMatch = ports && ports.match(/(\d+)->/);
          const hostPort  = portMatch ? parseInt(portMatch[1]) : 0;
          const webhookUrl = hostPort ? `http://${srv.host}:${hostPort}` : null;
          db.prepare("INSERT INTO instances VALUES (?,?,?,?,?,?,?,strftime('%s','now'))")
            .run(uuidv4(), srv.id, container, container, hostPort, 'running', webhookUrl);
        }
      }
      // Mark containers no longer running as stopped
      const runningNames = new Set(lines.map(l => l.split('|')[0].trim()));
      const dbInstances  = db.prepare('SELECT id, container_name FROM instances WHERE server_id=?').all(srv.id);
      for (const inst of dbInstances) {
        if (!runningNames.has(inst.container_name)) {
          db.prepare("UPDATE instances SET status='stopped' WHERE id=?").run(inst.id);
        } else {
          db.prepare("UPDATE instances SET status='running' WHERE id=?").run(inst.id);
        }
      }
    } catch (_) { /* server unreachable — leave status as-is */ }
  }));
  res.json(db.prepare('SELECT i.*, s.name as server_name, s.host as server_host FROM instances i JOIN servers s ON i.server_id=s.id').all());
});

// ─── UNIVERSAL DEPLOY (image) ────────────────────────────────
app.post('/api/servers/:serverId/deploy', async (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server not found' });

  const { name, image, ports = [], env = [], volumes = [], restart = 'unless-stopped' } = req.body;
  if (!name || !image) return res.status(400).json({ error: 'name and image required' });

  const dbPorts = db.prepare('SELECT n8n_port FROM instances').all().map(r => r.n8n_port);
  let livePortsOutput = '';
  try { livePortsOutput = (await sshExec(srv, `docker ps --format "{{.Ports}}" 2>/dev/null`)).output; } catch(_) {}
  const livePorts = [...livePortsOutput.matchAll(/(\d+)->/g)].map(m => parseInt(m[1]));
  const used = new Set([...dbPorts, ...livePorts]);
  const base = ports[0]?.host || 8080;
  let assignedPort = base;
  while (used.has(assignedPort)) assignedPort++;

  const portArgs = ports.map((p, i) => `-p ${i === 0 ? assignedPort : p.host}:${p.container}`);
  const envArgs  = env.filter(e => e.key).map(e => `-e ${e.key}=${e.val ?? ''}`);
  const volArgs  = volumes.filter(v => v.host).map(v => `-v ${v.host}:${v.container}`);

  const containerName = `fleet_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
  const id = uuidv4();
  const cmd = ['docker run -d', `--name ${containerName}`, `--restart ${restart}`,
    ...portArgs, ...envArgs, ...volArgs, image].join(' ');

  try {
    const r = await sshExec(srv, cmd);
    const webhookUrl = ports[0] ? `http://${srv.host}:${assignedPort}` : null;
    db.prepare("INSERT INTO instances VALUES (?,?,?,?,?,?,?,strftime('%s','now'))")
      .run(id, srv.id, name, containerName, assignedPort, 'running', webhookUrl);
    res.json({ id, name, containerName, port: assignedPort, status: 'running', webhookUrl, output: r.output.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── COMPOSE DEPLOY ──────────────────────────────────────────
function zipCommonPrefix(paths) {
  if (!paths.length) return '';
  const parts = paths[0].split('/');
  let prefix = '';
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join('/') + '/';
    if (paths.every(p => p.startsWith(candidate))) prefix = candidate;
    else break;
  }
  return prefix;
}

app.post('/api/compose/parse', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const dir = await unzipper.Open.buffer(req.file.buffer);
    const files = [];
    for (const entry of dir.files) {
      if (entry.type === 'File' && !entry.path.includes('/.git/') && !entry.path.includes('\\.git\\')) {
        const content = await entry.buffer();
        files.push({ path: entry.path, size: content.length, isCompose: /docker-compose\.(yml|yaml)$/i.test(entry.path) });
      }
    }
    const prefix = zipCommonPrefix(files.map(f => f.path));
    res.json({ files: files.map(f => ({ ...f, path: f.path.slice(prefix.length) })).filter(f => f.path) });
  } catch (e) { res.status(400).json({ error: 'Invalid ZIP: ' + e.message }); }
});

app.post('/api/servers/:serverId/deploy-compose', upload.single('file'), async (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  const { name } = req.body;
  if (!name || !req.file) return res.status(400).json({ error: 'name and file required' });

  try {
    const dir   = await unzipper.Open.buffer(req.file.buffer);
    const allFiles = [];
    for (const entry of dir.files) {
      if (entry.type === 'File' && !entry.path.includes('/.git/') && !entry.path.includes('\\.git\\')) {
        allFiles.push({ path: entry.path, content: await entry.buffer() });
      }
    }

    // Strip common directory prefix (e.g. "project-name/")
    const prefix = zipCommonPrefix(allFiles.map(f => f.path));
    const files  = allFiles.map(f => ({ ...f, path: f.path.slice(prefix.length) })).filter(f => f.path);

    // Find docker-compose.yml and determine its directory
    const composeEntry = files.find(f => /docker-compose\.(yml|yaml)$/i.test(f.path));
    if (!composeEntry) return res.status(400).json({ error: 'Kein docker-compose.yml im ZIP gefunden' });
    const composeSubdir = composeEntry.path.includes('/')
      ? composeEntry.path.substring(0, composeEntry.path.lastIndexOf('/'))
      : '';

    const remotePath = `/root/fleet-compose/${name.replace(/[^a-z0-9_-]/gi, '_')}`;
    await sftpUpload(srv, files, remotePath);

    const runDir     = composeSubdir ? `${remotePath}/${composeSubdir}` : remotePath;
    const projectName = name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const r = await sshExec(srv, `cd "${runDir}" && docker compose -p ${projectName} up -d 2>&1`);
    await registerComposeInstances(srv, projectName, name);
    res.json({ ok: true, output: r.output.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Register compose containers in DB ───────────────────────
async function registerComposeInstances(srv, projectName, deployName) {
  const psOut = await sshExec(srv,
    `docker ps --filter "label=com.docker.compose.project=${projectName}" --format "{{.Names}}|{{.Ports}}"`);
  const lines = psOut.output.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const [cname, ports] = line.split('|');
    const container = cname.trim();
    const portMatch = ports && ports.match(/(\d+)->/);
    const hostPort  = portMatch ? parseInt(portMatch[1]) : 0;
    const webhookUrl = hostPort ? `http://${srv.host}:${hostPort}` : null;
    const label = `${deployName} (${container})`;
    const existing = db.prepare('SELECT id FROM instances WHERE container_name=? AND server_id=?').get(container, srv.id);
    if (!existing) {
      db.prepare("INSERT INTO instances VALUES (?,?,?,?,?,?,?,strftime('%s','now'))")
        .run(uuidv4(), srv.id, label, container, hostPort, 'running', webhookUrl);
    } else {
      db.prepare("UPDATE instances SET status='running' WHERE container_name=? AND server_id=?").run(container, srv.id);
    }
  }
}

// ─── TEMPLATE DEPLOY ─────────────────────────────────────────
app.post('/api/templates/:templateId/deploy/:serverId', async (req, res) => {
  const t   = db.prepare('SELECT * FROM templates WHERE id=?').get(req.params.templateId);
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!t)   return res.status(404).json({ error: 'Vorlage nicht gefunden' });
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });

  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const config = JSON.parse(t.config);

  if (t.type === 'image') {
    const used = new Set(db.prepare('SELECT n8n_port FROM instances').all().map(r => r.n8n_port));
    const base = config.ports?.[0]?.host || 8080;
    let assignedPort = base;
    while (used.has(assignedPort)) assignedPort++;
    const portArgs = (config.ports||[]).map((p,i) => `-p ${i===0?assignedPort:p.host}:${p.container}`);
    const envArgs  = (config.env||[]).filter(e=>e.key).map(e => `-e ${e.key}=${e.val??''}`);
    const volArgs  = (config.volumes||[]).filter(v=>v.host).map(v => `-v ${v.host}:${v.container}`);
    const containerName = `fleet_${name.toLowerCase().replace(/[^a-z0-9]/g,'_')}_${Date.now()}`;
    const id  = uuidv4();
    const cmd = ['docker run -d', `--name ${containerName}`, `--restart ${config.restart||'unless-stopped'}`,
      ...portArgs, ...envArgs, ...volArgs, config.image].join(' ');
    try {
      const r = await sshExec(srv, cmd);
      const webhookUrl = config.ports?.[0] ? `http://${srv.host}:${assignedPort}` : null;
      db.prepare("INSERT INTO instances VALUES (?,?,?,?,?,?,?,strftime('%s','now'))")
        .run(id, srv.id, name, containerName, assignedPort, 'running', webhookUrl);
      res.json({ ok: true, output: r.output.trim() });
    } catch (e) { res.status(500).json({ error: e.message }); }

  } else if (t.type === 'compose') {
    if (!config.zipBase64) return res.status(400).json({ error: 'Keine ZIP-Daten in Vorlage gespeichert' });
    try {
      const zipBuffer = Buffer.from(config.zipBase64, 'base64');
      const dir = await unzipper.Open.buffer(zipBuffer);
      const allFiles = [];
      for (const entry of dir.files) {
        if (entry.type === 'File' && !entry.path.includes('/.git/')) {
          allFiles.push({ path: entry.path, content: await entry.buffer() });
        }
      }
      const prefix  = zipCommonPrefix(allFiles.map(f => f.path));
      const files   = allFiles.map(f => ({ ...f, path: f.path.slice(prefix.length) })).filter(f => f.path);
      const composeEntry = files.find(f => /docker-compose\.(yml|yaml)$/i.test(f.path));
      if (!composeEntry) return res.status(400).json({ error: 'Kein docker-compose.yml in Vorlage' });
      const composeSubdir = composeEntry.path.includes('/')
        ? composeEntry.path.substring(0, composeEntry.path.lastIndexOf('/')) : '';
      const remotePath  = `/root/fleet-compose/${name.replace(/[^a-z0-9_-]/gi, '_')}`;
      await sftpUpload(srv, files, remotePath);
      const runDir      = composeSubdir ? `${remotePath}/${composeSubdir}` : remotePath;
      const projectName = name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
      const r = await sshExec(srv, `cd "${runDir}" && docker compose -p ${projectName} up -d 2>&1`);
      await registerComposeInstances(srv, projectName, name);
      res.json({ ok: true, output: r.output.trim() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
});

// ─── INSTANCE ACTIONS ────────────────────────────────────────
app.post('/api/instances/:id/action', async (req, res) => {
  const inst = db.prepare('SELECT i.*, s.* FROM instances i JOIN servers s ON i.server_id=s.id WHERE i.id=?').get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  const srv = { host: inst.host, port: inst.port, username: inst.username, password: inst.password, ssh_key: inst.ssh_key };
  const { action } = req.body;
  let cmd, newStatus;
  switch (action) {
    case 'start':   cmd = `docker start ${inst.container_name}`;   newStatus = 'running'; break;
    case 'stop':    cmd = `docker stop ${inst.container_name}`;    newStatus = 'stopped'; break;
    case 'restart': cmd = `docker restart ${inst.container_name}`; newStatus = 'running'; break;
    case 'remove':  cmd = `docker stop ${inst.container_name} 2>/dev/null; docker rm ${inst.container_name}`; break;
    default: return res.status(400).json({ error: 'Unknown action' });
  }
  try {
    const r = await sshExec(srv, cmd);
    if (action === 'remove') db.prepare('DELETE FROM instances WHERE id=?').run(req.params.id);
    else db.prepare('UPDATE instances SET status=? WHERE id=?').run(newStatus, req.params.id);
    res.json({ ok: true, output: r.output.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/instances/:id/status', async (req, res) => {
  const inst = db.prepare('SELECT i.*, s.* FROM instances i JOIN servers s ON i.server_id=s.id WHERE i.id=?').get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  const srv = { host: inst.host, port: inst.port, username: inst.username, password: inst.password, ssh_key: inst.ssh_key };
  try {
    const r = await sshExec(srv, `docker inspect --format='{{.State.Status}}' ${inst.container_name} 2>/dev/null || echo removed`);
    const status = r.output.trim().replace(/'/g, '');
    db.prepare('UPDATE instances SET status=? WHERE id=?').run(status, inst.id);
    res.json({ status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STATS (alle Container auf allen Servern) ────────────────
app.get('/api/stats', async (req, res) => {
  const servers = db.prepare('SELECT * FROM servers').all();
  if (!servers.length) return res.json([]);

  const results = [];
  await Promise.all(servers.map(async srv => {
    const server = { host: srv.host, port: srv.port, username: srv.username, password: srv.password, ssh_key: srv.ssh_key };
    try {
      const psRes = await sshExec(server, `docker ps --format "{{.Names}}|{{.Image}}|{{.Ports}}|{{.RunningFor}}" 2>/dev/null`);
      const lines = psRes.output.trim().split('\n').filter(Boolean);
      if (!lines.length) return;

      const names = lines.map(l => l.split('|')[0]).join(' ');
      const [statsRes, inspectRes] = await Promise.all([
        sshExec(server, `docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" ${names} 2>/dev/null`),
        sshExec(server, `docker inspect --format "{{.Name}}|{{.State.StartedAt}}" ${names} 2>/dev/null`)
      ]);

      const statsMap = {};
      for (const line of statsRes.output.trim().split('\n').filter(Boolean)) {
        const [n, cpu, mem, memPct] = line.split('|');
        statsMap[n.replace(/^\//, '')] = { cpu: cpu || '0%', mem: mem || '—', memPct: memPct || '0%' };
      }
      const startedMap = {};
      for (const line of inspectRes.output.trim().split('\n').filter(Boolean)) {
        const [n, s] = line.split('|');
        startedMap[n.replace(/^\//, '')] = s || null;
      }

      for (const line of lines) {
        const [containerName, image, ports, runningFor] = line.split('|');
        const s = statsMap[containerName] || { cpu: 'N/A', mem: 'N/A', memPct: '0%' };
        const managed = db.prepare('SELECT id,name,webhook_url,n8n_port FROM instances WHERE container_name=?').get(containerName);
        results.push({
          container_name: containerName, image, ports: ports || '', runningFor,
          server_id: srv.id, server_name: srv.name, server_host: srv.host,
          cpu: s.cpu, mem: s.mem, memPct: s.memPct,
          startedAt: startedMap[containerName] || null,
          managed: !!managed,
          instance_name: managed?.name || null,
          webhook_url: managed?.webhook_url || null,
          n8n_port: managed?.n8n_port || null,
        });
      }
    } catch (e) {
      results.push({ container_name: '—', image: '—', server_id: srv.id, server_name: srv.name, server_host: srv.host, cpu: 'SSH Err', mem: '—', memPct: '0%', startedAt: null, managed: false, error: e.message });
    }
  }));

  res.json(results);
});

// ─── Catch-all ───────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));

// ─── HTTP + WebSocket Server ──────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws/terminal')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, request) => {
  const params        = new URL(request.url, 'http://x').searchParams;
  const serverId      = params.get('server');
  const containerName = params.get('container');
  if (!serverId || !containerName) return ws.close(1008, 'Missing params');

  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
  if (!srv) return ws.close(1008, 'Server not found');

  const conn = new Client();
  const cfg  = { host: srv.host, port: srv.port || 22, username: srv.username, readyTimeout: 10000 };
  if (srv.ssh_key?.trim()) cfg.privateKey = srv.ssh_key;
  else if (srv.password)   cfg.password   = srv.password;

  conn.on('ready', () => {
    conn.exec(`docker exec -it ${containerName} sh`, {
      pty: { term: 'xterm-256color', cols: 80, rows: 24, width: 640, height: 480 }
    }, (err, stream) => {
      if (err) {
        if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(`\r\n\x1b[31mFehler: ${err.message}\x1b[0m\r\n`));
        return conn.end();
      }
      stream.on('data',  d => { if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true }); });
      stream.on('close', () => { conn.end(); if (ws.readyState === WebSocket.OPEN) ws.close(); });

      ws.on('message', (msg, isBinary) => {
        if (isBinary) {
          stream.write(Buffer.from(msg));
        } else {
          try {
            const data = JSON.parse(msg.toString());
            if (data.type === 'resize') stream.setWindow(data.rows, data.cols, 0, 0);
          } catch { stream.write(msg.toString()); }
        }
      });
      ws.on('close', () => conn.end());
    });
  });
  conn.on('error', e => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(Buffer.from(`\r\n\x1b[31mSSH Fehler: ${e.message}\x1b[0m\r\n`));
      ws.close();
    }
  });
  conn.connect(cfg);
});

httpServer.listen(PORT, () => console.log(`n8n Dashboard running on :${PORT}`));
