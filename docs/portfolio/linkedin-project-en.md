# LinkedIn project — English

[Português](linkedin-project-pt-BR.md) · [English](linkedin-project-en.md)

## Title

Event-driven self-hosted smart-home platform

## Short description

A Docker-based home-automation platform using Home Assistant, Node-RED, MQTT,
and Zigbee, designed around observability, deterministic recovery, CI, and a
verifiable separation between public code and private state.

## Detailed description

I transformed an operational smart-home configuration into a reviewable,
reusable public repository. Home Assistant provides the state model and UI,
Node-RED implements event-driven flows with recovery, Mosquitto is the MQTT
backbone, and optional modules add Zigbee2MQTT, AppDaemon, Matter, and
agent-assisted automation.

The core challenge was not merely controlling devices. It was making
reliability decisions observable and testable without publishing a household.
Private bindings replace physical IDs; demos and tests use synthetic roles and
events; restore follows plan, verify, and human-confirmed apply; and one
canonical command verifies Compose, structured data, flows, security, privacy,
documentation, and recovery.

The project demonstrates integration engineering, state modeling, stale and
out-of-order event handling, idempotency, backoff, fail-safe behavior, CI/CD,
and evidence-led bilingual documentation. It publishes no production metrics,
household data, or claims that cannot be traced to code and tests.

## Technologies

Home Assistant · Node-RED · MQTT/Mosquitto · Zigbee2MQTT · Docker Compose ·
JavaScript/Node.js · Python · YAML/Jinja · GitHub Actions · Mermaid · Local AI

## Suggested skills

- Event-driven architecture
- Internet of Things and home automation
- Reliability engineering and observability
- Systems and API integration
- Docker and infrastructure as configuration
- Integration, replay, and failure-path testing
- Security, privacy, and disaster recovery
- CI/CD and bilingual technical writing

## Public evidence

- [README and technical tour](../../README.en.md)
- [Architecture](../assets/smart-home-architecture.svg)
- [Testing strategy](../TESTING_STRATEGY.en.md)
- [Restore contract](../RESTORE_CONTRACT.en.md)
- [Privacy model](../PRIVACY_MODEL.en.md)
