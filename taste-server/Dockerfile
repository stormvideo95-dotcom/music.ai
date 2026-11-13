FROM python:3.12-slim
WORKDIR /app
COPY server.py .
ENV DATA_DIR=/data PORT=8765 PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "server.py"]
