# music-dance-gpt — 镜像构建与部署
IMAGE      := music-dance-gpt
VERSION    ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMPOSE    := docker compose

.PHONY: help build up down restart logs ps clean

help: ## 显示所有命令
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-12s %s\n", $$1, $$2}'

build: ## 构建镜像（latest + git 版本号）
	docker build -t $(IMAGE):$(VERSION) -t $(IMAGE):latest .
	@echo "built $(IMAGE):$(VERSION) / $(IMAGE):latest"

up: ## 构建并后台启动（docker compose）
	mkdir -p data
	$(COMPOSE) up -d --build
	@echo "console: http://$$(hostname -I | awk '{print $$1}'):9302/"

down: ## 停止并移除容器
	$(COMPOSE) down

restart: ## 重启容器
	$(COMPOSE) restart

logs: ## 跟踪日志
	$(COMPOSE) logs -f --tail=100

ps: ## 查看容器状态
	$(COMPOSE) ps

clean: ## 清理悬空镜像
	docker image prune -f
