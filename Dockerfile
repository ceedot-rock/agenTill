# agenTill demo — public demo store + box wiring
# Build: docker build -t agentill-demo .   Run: docker run -p 8080:8080 agentill-demo
FROM node:20-slim
WORKDIR /app
COPY package.json ./
# no dependencies to install (pure Node stdlib); kept for future deps
COPY . .
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server/demo-server.js"]
