FROM python:3.12-slim
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY cdp_sim ./cdp_sim
USER 65534
ENTRYPOINT ["python", "-m", "cdp_sim"]
