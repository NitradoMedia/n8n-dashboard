# n8n Fleet Dashboard

Zentrale Verwaltung von n8n Docker-Instanzen auf beliebig vielen Root-Servern.

## Schnellstart

```bash
# 1. Image bauen & starten
docker compose up -d --build

# 2. Dashboard öffnen
open http://localhost:3000
```

## Funktionen

- **Server verwalten** — Füge Root-Server per SSH hinzu (Passwort oder SSH-Key)
- **n8n deployen** — Ein Klick startet eine neue n8n Docker-Instanz auf dem Zielserver
- **Status-Monitoring** — Live-Status aller laufenden Container
- **Aktionen** — Start / Stop / Restart / Remove direkt im Dashboard

## Voraussetzungen auf dem Root-Server

```bash
# Docker muss installiert sein:
curl -fsSL https://get.docker.com | sh
```

## Ports

| Service           | Port |
|-------------------|------|
| Dashboard         | 3000 |
| n8n (Standard)    | 5678 |

## SSH-Key Authentifizierung

Private Key im PEM-Format in den Server-Einstellungen einfügen:

```
-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----
```

## Daten

SQLite-Datenbank wird in Docker Volume `n8n_fleet_data` gespeichert → persistent über Restarts.

## Eigener Port

```bash
PORT=8080 docker compose up -d --build
```

oder in `docker-compose.yml` anpassen:
```yaml
ports:
  - "8080:3000"
```
