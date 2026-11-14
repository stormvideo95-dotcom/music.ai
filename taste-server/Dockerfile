FROM python:3.12-slim
WORKDIR /app
# deno: yt-dlp needs a JavaScript runtime for YouTube
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
RUN pip install --no-cache-dir "yt-dlp[default]" bgutil-ytdlp-pot-provider ytmusicapi
COPY server.py web.py webapp.html icon.png ./
ENV DATA_DIR=/data PORT=8765 PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "server.py"]
