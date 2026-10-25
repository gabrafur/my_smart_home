# Observação passiva do host

Produtor fixo, independente do PC, sem listener público, reparos ou decisões de
notificação. Fontes: eventos dos containers do projeto Compose autorizado,
transições de sete unidades do gerenciador systemd e recursos de `/proc`,
filesystem e temperatura. O socket Docker só recebe o GET fechado de eventos;
não há API MCP de comandos, caminhos ou argumentos para este serviço.

O código raiz é `observer.py`; a unidade é
`raspberry-host-observation.service`. No host revisado estão em
`/usr/local/lib/raspberry-host-observation/observer.py` e
`/etc/systemd/system/raspberry-host-observation.service`, ambos root:root 0644.
O diretório de saída fixo é `/mnt/data/docker/nodered/.host-health-observer`,
root:root 0755, e o arquivo atômico `report.json`, root:root 0644, é excluído do
Git. Não copie observações residenciais para documentação ou exemplos.

A instalação em outro servidor exige revisão dos caminhos fixos, allowlists,
projeto Compose, IDs oficiais de mensagens systemd, permissões e acesso local
administrativo do operador. Não copie políticas, credenciais ou o estado privado
do host original. Instale a fonte revisada com proprietário root, crie o diretório
fixo protegido, instale a unidade, execute `systemctl daemon-reload` e habilite
somente essa unidade. Verifique o relatório real e seus limites; não basta ver a
unidade ativa. A unidade não concede administração a clientes MCP.

Revogação da observação: parar e desabilitar
`raspberry-host-observation.service`; preservar o último relatório e os recibos.
A autorização administrativa temporária e sua revogação são contratos separados.

## Contrato e limites

- `schema_version: 1`, origem fixa, horário UTC, hashes de boot/instância,
  sequência e contagem explícita de eventos removidos do anel.
- Eventos: origem, papel de serviço allowlisted, ação fechada, hash de identidade,
  horário da origem/observador e latência desse trecho. Mensagens, prompts,
  nomes de containers, atributos, comandos e identificadores brutos são descartados.
- Recursos a cada 20 segundos. Leitura ausente vira `null` e erro de coleta,
  nunca zero nem prova de saúde. Relatório até 65.536 bytes; heartbeat em 10s e
  atualização de eventos com debounce mínimo de 250ms.
- As conexões dos streams são informadas; `connected` não prova ausência de
  falhas anteriores, prontidão de aplicação nem completude histórica.
- Anel de 64 eventos, dedupe de 256 IDs; reinício perde esse estado. Reconexão
  Docker usa somente os dois segundos recentes; journal inicia no momento da
  conexão. Eventos durante desconexão podem faltar. Não há inventário inicial
  completo nem cursores duráveis. Essas limitações impedem aceite de 24h.
- Limites de CPU, I/O, processos, descritores, memória virtual e tamanho são
  declarados na unidade. `MemoryMax` depende do controlador de memória do host;
  sua ausência impede alegar teto físico de RAM efetivo.
- Custos reportados incluem somente o produtor Python; excluem o filho
  `journalctl`, demais coletores e uma janela de 24h.

O produtor instalado em 25/10/2026 observou falhas reais do procmon e conclusões
naturais posteriores à recuperação, com latência apenas origem→observador.
A integração de decisões e alertas no
[canvas Node-RED](../../nodered/tools/HOST_OBSERVER.md) recebeu implantação própria;
a exposição deste novo relatório pelo MCP ainda está pendente. Não há comprovação de entrega
à Eva, execução do assistente, PC desligado ou da meta completa.

## Testes e aceite

`node --test scripts/host-observation/observer.test.mjs` executa os testes
isolados de sanitização, allowlists, relógios, dedupe, limite do anel, falha de
coleta e a regressão do modo atômico do procmon. A descoberta canônica de
`scripts/test-all.mjs` inclui esse agregador. Nenhum teste invoca o coletor real,
reinicia serviços ou gera eventos residenciais.

Aceite operacional: reler a unidade e as permissões; aguardar eventos naturais;
correlacionar horários de origem e observação; registrar qualquer perda do anel
ou desconexão; medir o trecho completo até o consumidor quando a integração
existir. O relatório precisa permanecer desconhecido para os fatos que não mede.
