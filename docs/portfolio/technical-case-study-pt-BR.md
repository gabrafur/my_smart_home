# Case técnico — plataforma self-hosted de smart home

[Português (principal)](technical-case-study-pt-BR.md) · [English](technical-case-study-en.md)

## Problema

Uma smart home útil acumula integrações locais e cloud, flows com estado,
identidades de dispositivos e procedimentos de operação. O objetivo foi tornar
a engenharia dessa plataforma publicamente revisável sem publicar a casa nem
transformar um clone em operação automática.

## Restrições

- eventos chegam duplicados, atrasados ou fora de ordem;
- integrações e dispositivos podem reiniciar em sequências diferentes;
- ações físicas exigem contexto fresco e ownership comprovado;
- serviços cloud têm latência, rate limits e indisponibilidade;
- registries, chaves, coordenadas e históricos não podem acompanhar o código;
- restore precisa ser útil sem aceitar destinos ou bundles perigosos.

O sistema opera continuamente em hardware residencial limitado; validação e
manutenção não podem competir com Home Assistant, MQTT, SSH ou automações. A
evidência pública também precisa continuar útil sem dispositivos reais.

## Arquitetura

[O diagrama versionado](../assets/smart-home-architecture.svg) separa o core
Home Assistant/Node-RED/MQTT, módulos opcionais, bindings/estado privados,
observabilidade e restore. O Compose mínimo contém três serviços; perfis
adicionam capacidades sem fingir que elas são obrigatórias.

## Modos de falha

- estado duplicado, atrasado ou fora de ordem pode repetir efeito físico;
- Home Assistant e Node-RED podem reiniciar em qualquer ordem e com snapshots
  incompletos;
- APIs cloud podem aplicar rate limit, expirar ou devolver cache;
- Internet, Zigbee, storage ou dispositivos individuais podem degradar
  independentemente;
- restore incompleto pode ser pior que indisponibilidade controlada;
- publicação pode transformar identificadores ou histórico em dados sensíveis.

## Design de estado e recovery

Home Assistant normaliza estado e expõe serviços. MQTT desacopla produtores e
consumidores. Node-RED implementa máquinas de estado, gates de readiness,
deduplicação e timers persistentes. Papéis lógicos como `resident_primary` e
`exterior_light` substituem IDs de uma instalação.

Os flows tratam `unknown`, `unavailable`, timestamps futuros/antigos,
snapshots conflitantes e restart durante transições. Side effects falham
fechados até a reconciliação. Chamadas externas usam cooldown, retry limitado,
backoff e último estado conhecido sem promover cache a verdade nova. O
[replay de recovery de segurança](../../nodered/tools/test-security-recovery-flow.mjs)
exercita essas regras diretamente contra as funções versionadas dos flows.

## Disaster recovery

Estado público recuperável fica em código, testes e configuração. Estado
privado segue um manifesto versionado e bundle criptografado. `plan` e `verify`
são somente leitura; `apply` valida destino, permissões e symlinks, exige token
de confirmação e prepara rollback. O contexto de agentes é reconstruído pelo
commit e pela memória pública, nunca por transcripts privados automáticos.

## Modelo de privacidade

O repositório publica schemas, exemplos e papéis sintéticos. Secrets, registries,
backups, credenciais de flows, mapas e estado físico são ignorados. Scanners de
segurança e privacidade verificam tracked/staged sem ecoar o valor de um achado.
Integrações vendorizadas têm versão, origem, licença e modificações registradas.
O [schema de bindings](../../bindings/public-bindings.schema.json) e o
[scanner de privacidade](../../scripts/privacy-check.mjs) tornam essa fronteira
revisável sem exportar registry.

## Estratégia de testes

`make validate-public` é o contrato único. Ele valida Compose, JSON/YAML,
shell, links/i18n/assets, segurança, privacidade, memória, Node-RED em runtime
isolado, bridge, Local AI, módulos, restore, bootstrap e demo. Replays cobrem
happy paths e adversarial recovery sem I/O residencial.

## Observabilidade

Fluxos publicam fases explícitas de indisponibilidade e recuperação, duração do
incidente e deduplicação de notificações. Métricas de host e storage são locais.
Telemetria de Local AI registra somente decisões e contagens, não prompts ou
conteúdo.

## Ferramentas de IA

Um bridge opcional integra agentes ao Home Assistant e um helper RTX pode
comprimir contexto público grande. Ambos possuem limites: não recebem segredos,
não decidem ações destrutivas e não substituem validação determinística nem
aprovação humana.

## Trade-offs operacionais

- Configuração realista aumenta valor técnico, mas exige scanners e bindings.
- Vendorizar integrações preserva compatibilidade local, mas cria dívida de
  atualização e obrigações de licença.
- Persistência melhora recovery, mas exige schema, expiração e fail-closed.
- Um restore completo depende de bundle privado; o repositório isolado só
  garante plataforma, testes e demo sintética.

## O que aprendi e o que mudaria em maior escala

1. Automação segura é principalmente engenharia de estado e falha.
2. Reprodutibilidade precisa declarar o que não pode estar no Git.
3. Toda capability pública deve apontar para evidência executável.
4. IA é útil no caminho editorial e operacional quando seus limites são
   explícitos e a decisão final permanece humana/determinística.

Em maior escala, eu adotaria schemas versionados de eventos entre produtores,
levaria observabilidade de alta cardinalidade para uma stack dedicada, rodaria
validações amplas em workers isolados e substituiria a maior parte das
integrações vendorizadas por um pipeline verificado de patch/fetch. Também
separaria com mais rigor política residencial e adapters de dispositivos, para
que várias instalações compartilhassem as mesmas máquinas de estado sem herdar
as escolhas operacionais de um único deployment.
