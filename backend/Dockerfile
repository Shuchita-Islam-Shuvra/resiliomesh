FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ /app/
COPY data/ /data/
ENV HISTORICAL_CSV=/data/historical_rainfall_events.csv CLIMATOLOGY_CSV=/data/dhaka_monthly_climatology.csv
RUN python -m app.ml.train
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
