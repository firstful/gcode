FROM python:3.12-slim

WORKDIR /app
COPY app.py .
COPY static ./static
RUN chmod -R a+rX /app

USER 65532
EXPOSE 8080
ENV HTTP_PORT=8080
CMD ["python", "-u", "app.py"]
