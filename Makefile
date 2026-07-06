SHELL := /bin/bash
PROJECT_ROOT := $(shell pwd)

.PHONY: install dev build start test lint typecheck fmt init \
	service-install service-start service-stop service-status service-logs \
	verify-no-tmp help

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

start:
	npm start

test:
	npm test

test-watch:
	npm run test:watch

test-coverage:
	npm run test:coverage

lint:
	npm run lint

typecheck:
	npm run typecheck

fmt:
	npm run fmt

fmt-check:
	npm run fmt:check

init:
	@if [ ! -f .env ]; then cp -n .env.example .env; fi
	@if ! grep -q '^LOCAL_API_TOKEN=' .env; then \
		echo "LOCAL_API_TOKEN=$$(openssl rand -hex 32)" >> .env; \
		echo "[init] appended fresh LOCAL_API_TOKEN to .env"; \
	else \
		echo "[init] LOCAL_API_TOKEN already present in .env"; \
	fi

service-install:
	sudo cp systemd/skill-admin-dashboard.service /etc/systemd/system/
	sudo systemctl daemon-reload
	sudo systemctl enable skill-admin-dashboard.service

service-start:
	sudo systemctl start skill-admin-dashboard.service

service-stop:
	sudo systemctl stop skill-admin-dashboard.service

service-status:
	systemctl status skill-admin-dashboard.service

service-logs:
	journalctl -u skill-admin-dashboard.service -f

verify-no-tmp:
	@! grep -rnE '/tmp|os\.tmpdir\(\)|0\.0\.0\.0' src/ && echo OK

# Aliases that mirror the plan's colon-named catalog (GNU make rejects ':' in target names).
.PHONY: test/watch test/coverage fmt/check service/install service/start service/stop service/status service/logs verify/no-tmp
test/watch: test-watch
test/coverage: test-coverage
fmt/check: fmt-check
service/install: service-install
service/start: service-start
service/stop: service-stop
service/status: service-status
service/logs: service-logs
verify/no-tmp: verify-no-tmp

help:
	@echo "Targets:"
	@echo "  install, dev, build, start, test, test-watch, test-coverage"
	@echo "  lint, typecheck, fmt, fmt-check, init"
	@echo "  service-install, service-start, service-stop, service-status, service-logs"
	@echo "  verify-no-tmp   (CI gate; alias: make verify/no-tmp)"
