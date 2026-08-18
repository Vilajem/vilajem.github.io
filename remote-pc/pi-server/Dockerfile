FROM python:3.13-slim

WORKDIR /app
COPY pi-server/server.py ./pi-server/server.py
COPY public ./public

WORKDIR /app/pi-server
CMD ["python3", "server.py"]
