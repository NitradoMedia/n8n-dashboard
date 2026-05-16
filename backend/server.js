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
`);

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
