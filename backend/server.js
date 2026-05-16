const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client } = require('ssh2');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// DB setup
const DB_PATH = process.env.DB_PATH || '/data/dashboard.db';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 22,
    username TEXT NOT NULL,
    password TEXT,
    ssh_key TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    container_name TEXT NOT NULL,
    n8n_port INTEGER NOT NULL,
    status TEXT DEFAULT 'unknown',
    webhook_url TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(server_id) REFERENCES servers(id)
  );
`);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── SSH Helper ─────────────────────────────────────────────
function sshExec(server, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let errOutput = '';

    const connConfig = {
      host: server.host,
      port: server.port || 22,
      username: server.username,
      readyTimeout: 15000,
    };

    if (server.ssh_key && server.ssh_key.trim()) {
      connConfig.privateKey = server.ssh_key;
    } else if (server.password) {
      connConfig.password = server.password;
    }

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        stream
          .on('close', (code) => {
            conn.end();
            if (code !== 0 && errOutput) {
              // Still resolve but include stderr in output
              resolve({ output: output || errOutput, code });
            } else {
              resolve({ output, code });
            }
          })
          .on('data', (d) => { output += d.toString(); })
          .stderr.on('data', (d) => { errOutput += d.toString(); });
      });
    })
    .on('error', reject)
    .connect(connConfig);
  });
}

// ─── SERVERS API ────────────────────────────────────────────
app.get('/api/servers', (req, res) => {
  const servers = db.prepare('SELECT id, name, host, port, username, created_at FROM servers').all();
  res.json(servers);
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
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  try {
    const result = await sshExec(server, 'echo OK && docker --version');
    res.json({ ok: true, output: result.output.trim() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/next-port', (req, res) => {
  const usedPorts = new Set(db.prepare('SELECT n8n_port FROM instances').all().map(r => r.n8n_port));
  let port = parseInt(req.query.from) || 5678;
  while (usedPorts.has(port)) port++;
  res.json({ port });
});

// ─── INSTANCES API ──────────────────────────────────────────
app.get('/api/instances', (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, s.name as server_name, s.host as server_host 
    FROM instances i JOIN servers s ON i.server_id = s.id
  `).all();
  res.json(rows);
});

app.get('/api/servers/:serverId/instances', (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, s.name as server_name, s.host as server_host 
    FROM instances i JOIN servers s ON i.server_id = s.id
    WHERE i.server_id=?
  `).all(req.params.serverId);
  res.json(rows);
});

app.post('/api/servers/:serverId/instances', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { name, n8n_port, timezone, n8n_user, n8n_pass, secure_cookie } = req.body;
  const usedPorts = new Set(db.prepare('SELECT n8n_port FROM instances').all().map(r => r.n8n_port));
  let port = n8n_port || 5678;
  while (usedPorts.has(port)) port++;
  const containerName = `n8n_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
  const id = uuidv4();

  const tz = timezone || 'Europe/Berlin';
  const user = n8n_user || 'admin';
  const pass = n8n_pass || uuidv4().slice(0, 12);

  const cmd = [
    `docker run -d`,
    `--name ${containerName}`,
    `--restart unless-stopped`,
    `-p ${port}:5678`,
    `-e N8N_BASIC_AUTH_ACTIVE=true`,
    `-e N8N_BASIC_AUTH_USER=${user}`,
    `-e N8N_BASIC_AUTH_PASSWORD=${pass}`,
    `-e GENERIC_TIMEZONE=${tz}`,
    `-e TZ=${tz}`,
    secure_cookie === false ? `-e N8N_SECURE_COOKIE=false` : '',
    `-v ${containerName}_data:/home/node/.n8n`,
    `n8nio/n8n:latest`
  ].filter(Boolean).join(' ');

  try {
    const result = await sshExec(server, cmd);
    const webhookUrl = `http://${server.host}:${port}`;

    db.prepare("INSERT INTO instances VALUES (?,?,?,?,?,?,?,strftime('%s','now'))")
      .run(id, server.id, name, containerName, port, 'running', webhookUrl);

    res.json({
      id, name, containerName, port, status: 'running',
      webhookUrl, n8n_user: user, n8n_pass: pass,
      output: result.output.trim()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/instances/:id/action', async (req, res) => {
  const instance = db.prepare('SELECT i.*, s.* FROM instances i JOIN servers s ON i.server_id=s.id WHERE i.id=?').get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  const server = {
    host: instance.host, port: instance.port,
    username: instance.username, password: instance.password,
    ssh_key: instance.ssh_key
  };

  const { action } = req.body;
  let cmd, newStatus;

  switch (action) {
    case 'start':   cmd = `docker start ${instance.container_name}`;   newStatus = 'running'; break;
    case 'stop':    cmd = `docker stop ${instance.container_name}`;    newStatus = 'stopped'; break;
    case 'restart': cmd = `docker restart ${instance.container_name}`; newStatus = 'running'; break;
    case 'remove':
      cmd = `docker stop ${instance.container_name} 2>/dev/null; docker rm ${instance.container_name}`;
      break;
    default: return res.status(400).json({ error: 'Unknown action' });
  }

  try {
    const result = await sshExec(server, cmd);
    if (action === 'remove') {
      db.prepare('DELETE FROM instances WHERE id=?').run(req.params.id);
    } else {
      db.prepare('UPDATE instances SET status=? WHERE id=?').run(newStatus, req.params.id);
    }
    res.json({ ok: true, output: result.output.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/instances/:id/status', async (req, res) => {
  const instance = db.prepare('SELECT i.*, s.* FROM instances i JOIN servers s ON i.server_id=s.id WHERE i.id=?').get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Not found' });

  const server = {
    host: instance.host, port: instance.port,
    username: instance.username, password: instance.password,
    ssh_key: instance.ssh_key
  };

  try {
    const result = await sshExec(server, `docker inspect --format='{{.State.Status}}' ${instance.container_name} 2>/dev/null || echo 'removed'`);
    const status = result.output.trim().replace(/'/g, '');
    db.prepare('UPDATE instances SET status=? WHERE id=?').run(status, req.params.id);
    res.json({ status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STATS API (alle Container auf allen Servern) ───────────
app.get('/api/stats', async (req, res) => {
  const servers = db.prepare('SELECT * FROM servers').all();
  if (!servers.length) return res.json([]);

  const results = [];

  await Promise.all(servers.map(async (srv) => {
    const server = { host: srv.host, port: srv.port, username: srv.username, password: srv.password, ssh_key: srv.ssh_key };
    try {
      // Get all running containers
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
        const [n, startedAt] = line.split('|');
        startedMap[n.replace(/^\//, '')] = startedAt || null;
      }

      for (const line of lines) {
        const [containerName, image, ports, runningFor] = line.split('|');
        const s = statsMap[containerName] || { cpu: 'N/A', mem: 'N/A', memPct: '0%' };
        // Check if this container is a dashboard-managed instance
        const managed = db.prepare('SELECT id, name, webhook_url, n8n_port FROM instances WHERE container_name=?').get(containerName);
        results.push({
          container_name: containerName,
          image,
          ports: ports || '',
          runningFor,
          server_name: srv.name,
          server_host: srv.host,
          cpu: s.cpu,
          mem: s.mem,
          memPct: s.memPct,
          startedAt: startedMap[containerName] || null,
          managed: !!managed,
          instance_name: managed?.name || null,
          webhook_url: managed?.webhook_url || null,
          n8n_port: managed?.n8n_port || null,
        });
      }
    } catch (e) {
      results.push({ container_name: '—', image: '—', server_name: srv.name, server_host: srv.host, cpu: 'SSH Fehler', mem: '—', memPct: '0%', startedAt: null, managed: false, error: e.message });
    }
  }));

  res.json(results);
});

// ─── Catch-all → frontend ────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.listen(PORT, () => console.log(`n8n Dashboard running on :${PORT}`));
