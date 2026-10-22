FROM python:3.13-alpine
WORKDIR /app
COPY start.py ./
COPY scripts ./scripts
COPY web ./web
RUN python scripts/setup_assets.py
EXPOSE 8787
CMD ["python", "start.py", "--host", "0.0.0.0", "--no-browser"]
