# FMC003 Dashboard (port 1234)

This is a separate HTTP app. It does not replace or modify the tracker TCP server on port 5500.

## Files expected

Place this folder at `/var/www/FMC003/dashboard`, so the app reads:

`/var/www/FMC003/Data/YYYY-MM/DD.json`

The daily files should be JSON arrays. The dashboard understands the record structure produced by the supplied FMC003 `server.js`, including nested `gps`, `rawIo`, and `rawData.packetHex`.

## Install and run

```bash
cd /var/www/FMC003/dashboard
npm install
node app.js
```

Open `http://13.126.161.181:1234`.

## Keep running with PM2

```bash
pm2 start app.js --name fmc003-dashboard
pm2 save
pm2 logs fmc003-dashboard
```

## AWS and Ubuntu firewall

Add inbound TCP port `1234` to the EC2 security group, preferably only from your own IP if the dashboard is private. If UFW is active:

```bash
sudo ufw allow 1234/tcp
sudo ufw status
```

Port 5500 stays for the tracker. Port 1234 serves the dashboard.

## Features

- Browse month/date folders and view daily records
- Download the selected day's original JSON file
- Export selected date or entire month to `.xlsx`
- Plot valid GPS coordinates in timestamp order on an OpenStreetMap/Leaflet map
- Click route points or table rows to inspect telemetry
- Includes raw IO JSON and raw packet hex in Excel columns

## Security note

This starter app has no login. Anyone who can reach port 1234 can view and download vehicle history. Restrict the EC2 security-group source to your own IP or put authentication/reverse proxy in front of it before exposing it publicly. Map tiles and Leaflet are loaded from public CDNs and need browser internet access.
