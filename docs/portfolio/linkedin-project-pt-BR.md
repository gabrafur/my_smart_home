# Projeto para LinkedIn — PT-BR

[Português (principal)](linkedin-project-pt-BR.md) · [English](linkedin-project-en.md)

## Título

Plataforma self-hosted de smart home orientada a eventos

## Descrição curta

Plataforma de automação residencial executada em Docker, com Home Assistant,
Node-RED, MQTT e Zigbee, projetada com observabilidade, recovery determinístico,
CI e separação verificável entre código público e estado privado.

## Descrição detalhada

Transformei uma configuração operacional de smart home em um repositório
público revisável e reutilizável. A plataforma combina Home Assistant como
modelo de estado e interface, Node-RED para fluxos event-driven com recovery,
Mosquitto como backbone MQTT e módulos opcionais para Zigbee2MQTT, AppDaemon,
Matter e automação assistida por agentes.

O desafio central não foi apenas automatizar dispositivos: foi tornar decisões
de confiabilidade observáveis e testáveis sem publicar a residência. Bindings
privados substituem IDs físicos; demos e testes usam papéis/eventos sintéticos;
restore segue plan, verify e apply com confirmação humana; e a validação
canônica cobre Compose, dados estruturados, flows, segurança, privacidade,
documentação e recovery.

O projeto demonstra engenharia de integração, modelagem de estado, defesa
contra eventos stale/fora de ordem, idempotência, backoff, fail-safe, CI/CD e
documentação bilíngue orientada a evidências. Não publica métricas de produção,
dados residenciais ou claims que não possam ser ligados a código e testes.

## Tecnologias

Home Assistant · Node-RED · MQTT/Mosquitto · Zigbee2MQTT · Docker Compose ·
JavaScript/Node.js · Python · YAML/Jinja · GitHub Actions · Mermaid · Local AI

## Competências sugeridas

- Arquitetura orientada a eventos
- Internet of Things (IoT) e automação residencial
- Engenharia de confiabilidade e observabilidade
- Integração de sistemas e APIs
- Docker e infraestrutura como configuração
- Testes de integração, replay e failure paths
- Segurança, privacidade e disaster recovery
- CI/CD e documentação técnica bilíngue

## Evidências públicas

- [README e tour técnico](../../README.md)
- [Arquitetura](../assets/smart-home-architecture.svg)
- [Estratégia de testes](../ESTRATEGIA_DE_TESTES.md)
- [Contrato de restore](../RESTORE_CONTRACT.md)
- [Modelo de privacidade](../PRIVACY_MODEL.md)
