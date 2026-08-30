# Plataforma Self-hosted de Smart Home

[English (padrão)](README.md) · [Português](README.pt-BR.md)

[![Validação pública](https://github.com/gabrafur/my_smart_home/actions/workflows/public-validation.yml/badge.svg)](https://github.com/gabrafur/my_smart_home/actions/workflows/public-validation.yml)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-platform-18BCF2?logo=homeassistant&logoColor=white)](https://www.home-assistant.io/)
[![Node--RED](https://img.shields.io/badge/Node--RED-event--driven-8F0000?logo=nodered&logoColor=white)](https://nodered.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

Plataforma de automação residencial self-hosted, orientada a eventos e
operada como infraestrutura versionada. Home Assistant, Node-RED e MQTT formam
o core; módulos opcionais adicionam Zigbee, AppDaemon, Matter, observabilidade
e automação assistida por agentes, sem misturar código público com estado da
residência.

![Arquitetura pública, privada e de recovery](docs/assets/smart-home-architecture.svg)

[Tour técnico de portfólio](docs/ENGINEERING_TOUR.pt-BR.md) ·
[Demo](#demo-sintética) · [Getting Started](#comece-em-5-minutos) ·
[Documentação](docs/README.md) ·
[Restore](docs/RESTORE_CONTRACT.md) ·
[Case técnico](docs/portfolio/technical-case-study-pt-BR.md)

## Por que este projeto existe

Automação residencial confiável é engenharia de estado, falhas e recuperação —
não apenas comandos de dispositivo. Este projeto torna essas decisões
revisáveis: configuração como código, fluxos event-driven, guards contra estado
stale, observabilidade, CI, restore determinístico e documentação operacional.

O repositório também demonstra como publicar uma plataforma real sem publicar
a casa. IDs físicos, registries, coordenadas, credenciais, mapas e históricos
permanecem privados. O código usa papéis lógicos e fixtures sintéticas; um clone
novo reproduz plataforma, testes e demo, mas nunca a instalação original.

## O que demonstra

- Home Assistant como modelo de estado, UI e camada de integração;
- Node-RED com máquinas de estado, deduplicação, backoff e recovery após restart;
- MQTT/Mosquitto e Zigbee2MQTT para integração local desacoplada;
- Docker Compose modular, imagens imobilizadas por digest e operação em edge;
- automações YAML/Jinja, AppDaemon e integrações Python;
- observabilidade de host, storage, Internet e Zigbee;
- bindings privados, scanners de segurança/privacidade e disclosure responsável;
- backup/restore com manifesto, verify, confirmação humana e rollback;
- CI canônico, testes de runtime isolado e demo sem I/O real;
- Local AI e agentes opcionais com limites explícitos e telemetria sem conteúdo.

## Arquitetura

O core público é Home Assistant ↔ MQTT ↔ Node-RED. Zigbee2MQTT, AppDaemon,
integrações cloud e o bridge de agentes são opcionais. O diagrama mantém
dispositivos físicos, runtime privado, backup/restore e a fronteira de
agentes/Local AI separados. Bindings e estado físico nunca entram no Git; um
bundle privado criptografado só é aplicado depois de `plan`, `verify` e
confirmação humana. Veja a [fonte Mermaid e reprodução](docs/assets/README.md).

## Engineering highlights

| Capability | Evidência | Por que importa |
| --- | --- | --- |
| Core modular | [`modules/features.json`](modules/features.json), [`compose.modules.yml`](compose.modules.yml), [teste](scripts/modules-check.mjs) | um clone começa com três serviços e adiciona módulos sem dependências implícitas |
| Flows com recovery | [`flows.json`](nodered/flows.json), [replays](nodered/tools/test-security-recovery-flow.mjs), [casos adversariais](nodered/tools/test-security-recovery-adversarial.mjs) | restart, ordem de eventos e estado inválido falham de forma segura |
| Observabilidade | [monitoramento](docs/ZIGBEE_HEALTH_NOTIFICATIONS.md), [falhas globais do Node-RED](docs/NODERED_GLOBAL_FAILURE_NOTIFICATIONS.md), [saúde do host](docs/RASPBERRY_PI_SYSTEM_HEALTH.md), [testes de runtime](nodered/tools/test-infrastructure-monitoring-runtime.mjs) | falha, recuperação e deduplicação são estados testáveis, não só logs |
| Fronteira pública/privada | [schema](bindings/public-bindings.schema.json), [modelo](docs/PRIVACY_MODEL.md), [scanner](scripts/privacy-check.mjs) | permite revisar lógica sem expor topologia ou identidades físicas |
| Disaster recovery | [manifesto](restore/private-state-manifest.yaml), [implementação](scripts/restore.mjs), [testes](scripts/restore.test.mjs) | verify é somente leitura; apply valida destino e prepara rollback |
| Validação canônica | [Makefile](Makefile), [CI](.github/workflows/public-validation.yml), [estratégia](docs/ESTRATEGIA_DE_TESTES.md) | o mesmo comando local e remoto cobre configuração, docs, privacidade e runtime |
| Proveniência | [inventário](docs/DEPENDENCY_PROVENANCE.md), [notices](THIRD_PARTY_NOTICES.md) | versões, licenças e deltas locais de integrações vendorizadas ficam explícitos |
| Contexto de agentes | [contrato](docs/MEMORIA_VERSIONADA_AGENTES.md), [recovery](scripts/ai-context-recovery.mjs) | agentes retomam pelo commit e memória pública, nunca por runtime privado automático |

## Tour técnico de portfólio

O [tour de engenharia por profundidade](docs/ENGINEERING_TOUR.pt-BR.md) organiza
uma leitura de 30 segundos da arquitetura, uma revisão de cinco minutos sobre
confiabilidade/privacidade e uma inspeção de 15 minutos da implementação. Ele
aponta diretamente para dez superfícies representativas de código e testes,
sem repetir este README.

## Comece em 5 minutos

Pré-requisitos: Linux, Git, Node.js 20, Python 3, GNU Make, Docker Engine e o
plugin Compose.

```bash
git clone https://github.com/gabrafur/my_smart_home.git smart-home
cd smart-home
make bootstrap
make validate-public
make demo
make demo-test
```

`make bootstrap` cria somente templates privados ausentes, nunca sobrescreve
arquivos e reporta lacunas. Antes de iniciar containers, leia
[instalação/restauração](docs/INSTALACAO_RESTAURACAO_SMART_HOME.md) e configure
secrets, bindings e hardware próprios.

### Referência ou contribuição?

Este repositório é hoje uma **implementação de referência e projeto de
portfólio**, não um template inicial licenciado. O trabalho original não possui
licença raiz; visibilidade pública e o controle de template do GitHub não devem
ser interpretados como permissão geral de reutilização. Um fork é apropriado
para propor contribuição de volta por pull request; veja
[CONTRIBUTING](CONTRIBUTING.md).

O GitHub atualmente exibe **Use this template**. A configuração foi mantida
sem alteração até a decisão explícita do proprietário sobre licença/template;
veja o [memorando de decisão](docs/LICENSING_DECISION.pt-BR.md) e a
[auditoria das configurações](docs/GITHUB_REPOSITORY_SETTINGS.md).

## Limites de execução

| Área | O que roda | O que não acontece automaticamente |
| --- | --- | --- |
| Demo | eventos lógicos em memória, sem rede/processos/MQTT/dispositivos | nenhum comando físico ou leitura de estado privado |
| Validação | parsers, scanners, testes e container Node-RED isolado com fixtures | não inicia a stack residencial nem restaura backup real |
| Core | Home Assistant, Node-RED e Mosquitto após configuração privada | módulos opcionais não são ativados por inferência |
| Integrações | somente quando módulo, binding, secret e hardware são fornecidos | ausência degrada com segurança; não migra registry |
| Restore | plan/verify somente leitura | apply exige destino, confirmação explícita e presença humana |
| Agentes/Local AI | opcionais, com contexto público permitido | não recebem segredos nem aprovam produção, segurança ou ações destrutivas |

## Stack

Home Assistant · Node-RED · Mosquitto/MQTT · Zigbee2MQTT · AppDaemon · Matter
Server · Docker Compose · Node.js · Python · YAML/Jinja · GitHub Actions ·
Mermaid · Codex/Local AI opcionais.

## Demo sintética

```bash
make demo
make demo-test
```

O cenário cobre presença lógica, segurança, iluminação, storage e recuperação
de saúde, inclusive deduplicação de alertas, rejeição de evento stale e uma
fronteira de restart/reload em memória. A implementação não importa clientes de
rede, processo, MQTT ou controle de dispositivos. Veja
[Bootstrap e demo](docs/BOOTSTRAP_DEMO.md) e a
[saída determinística de exemplo](docs/demo-output.pt-BR.md).

## Restore

O repositório é a camada pública; o estado necessário para recuperar uma
instalação vive num bundle privado criptografado. Use os alvos `backup-plan`,
`backup-verify`, `restore-plan` e `restore-verify`; `restore-apply` exige token
de confirmação. Contrato completo: [RESTORE_CONTRACT](docs/RESTORE_CONTRACT.md).

## Segurança e privacidade

Rode antes de publicar:

```bash
scripts/security-scan.sh --staged
make privacy-check-staged
```

O scanner não ecoa achados. Vulnerabilidades seguem [SECURITY](SECURITY.md),
nunca uma issue pública. Dependências vendorizadas preservam licenças próprias;
não há licença raiz porque a decisão sobre o trabalho original continua
[intencionalmente pendente](docs/LICENSING_DECISION.pt-BR.md).

## Mapa do repositório

```text
homeassistant/   Configuração, dashboards, pacotes e integrações
nodered/         Flows, settings e replays de runtime
bindings/        Schema público e exemplo sintético
modules/         Grafo de features core/opcionais
restore/         Manifesto e schema do estado privado
scripts/         Bootstrap, demo, restore, scanners e validação
docs/            Operação, arquitetura, cases e portfólio bilíngue
.codex/memories/ Memória pública sanitizada dos agentes
```

## Contributing

Contribuições externas usam fork, branch e PR; updates PT/EN e validação fazem
parte do aceite. Leia [CONTRIBUTING](CONTRIBUTING.md), o
[Código de Conduta](CODE_OF_CONDUCT.md) e os
[notices de terceiros](THIRD_PARTY_NOTICES.md).

## Disclaimer

Projeto independente de engenharia e portfólio. Não é produto de segurança,
serviço de emergência nem imagem pronta para qualquer residência. Integrações
cloud e marcas pertencem a seus respectivos proprietários. Avalie riscos,
licenças, hardware e regulamentação da sua instalação antes de operar efeitos
físicos.
