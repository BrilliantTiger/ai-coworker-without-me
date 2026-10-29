# coworker 중계 서버 이미지. 의존성이 없어 Bun 과 파일 하나로 돈다.
# 저장소 맨 위에서: docker build -f relay/Dockerfile -t coworker-relay .
FROM oven/bun:1-slim
WORKDIR /app
COPY src/relay.ts ./relay.ts
ENV PORT=8787
EXPOSE 8787
USER bun
CMD ["bun", "relay.ts"]
