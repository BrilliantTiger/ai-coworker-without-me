# coworker 중계 서버 이미지. 의존성이 없어 Bun 과 파일 하나로 돈다.
# 저장소 맨 위에서: docker build -f relay/Dockerfile -t coworker-relay .
# 판을 고정한다. 새 판으로 올릴 때는 이 줄과 compose.yaml 의 caddy 판을 바꾸고 docker compose up -d --build 로 다시 띄운다.
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY src/relay.ts ./relay.ts
COPY src/box.ts ./box.ts
ENV PORT=8787
EXPOSE 8787
USER bun
CMD ["bun", "relay.ts"]
