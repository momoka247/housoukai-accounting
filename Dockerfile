FROM python:3.12-slim
WORKDIR /app
COPY accounting.py integrations.py bot.py excel_export.py server.py categories.json ./
COPY templates/ ./templates/
RUN useradd --create-home app && mkdir /app/data && chown app:app /app/data
USER app
ENV PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
CMD ["python", "server.py"]
