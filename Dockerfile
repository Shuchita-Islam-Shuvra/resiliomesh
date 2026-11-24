# Full ResilioMesh app in ONE image: React website + FastAPI API + workflow worker.
# Build context = repo root.   docker build -t resiliomesh .
# The site and the API share one URL, so no CORS and no VITE_API_URL are needed.

# ---- 1. build the React website ----
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Public values baked into the JS bundle (the anon key is meant to be public; RLS protects data).
# Render passes service env vars to the build as build args.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
RUN test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_ANON_KEY" \
    || (echo "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set at build time" && exit 1)
RUN npm run build

# ---- 2. API image that also serves the website ----
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ /app/
COPY data/ /data/
ENV HISTORICAL_CSV=/data/historical_rainfall_events.csv CLIMATOLOGY_CSV=/data/dhaka_monthly_climatology.csv
RUN python -m app.ml.train
COPY --from=web /web/dist /app/static
ENV FRONTEND_DIST=/app/static
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
