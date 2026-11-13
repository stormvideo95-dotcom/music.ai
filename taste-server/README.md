# Music AI taste server (Umbrel / Raspberry Pi 5)

Learns your music taste from the Music AI app and picks the songs that play after your playlist ends.

## Install on the Pi

SSH into your Umbrel (`ssh umbrel@umbrel.local`), then:

```bash
git clone https://github.com/stormvideo95-dotcom/music.ai.git
cd music.ai/taste-server
sudo docker compose up -d --build
```

Check it works: open `http://umbrel.local:8765/health` in a browser. It should say `"ok": true`.

## Connect the app

In the app: Settings → Player and audio → Taste AI

1. Server address: `http://umbrel.local:8765` (or the Pi's IP, e.g. `http://192.168.1.50:8765`)
2. Tap **Test connection**
3. Turn on **Smart continue**

Away from home? Install Tailscale on the Pi (Umbrel app store) and on your phone, then use the Pi's Tailscale address.

## Useful links

- `/health`: is it running, how many events learned
- `/stats`: your favourite artists and words according to the model
- `POST /train`: retrain right now (it also retrains every night at 04:00 and after every 25 new events)

Data lives in `taste-server/data/` on the Pi. Delete that folder to reset what the AI learned.

## Update

```bash
cd music.ai && git pull && cd taste-server && sudo docker compose up -d --build
```
