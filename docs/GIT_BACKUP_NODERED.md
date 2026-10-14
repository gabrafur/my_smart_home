# Backup Git no Node-RED

O backup diário do repositório é agendado na aba `backup_git` do Node-RED às
**01:00 no fuso `TZ` configurado para o container**. Na instalação residencial
atual, `TZ=America/Sao_Paulo`, portanto o horário corresponde a 04:00 UTC.
Essa janela foi escolhida para evitar outras rotinas desta casa; quem instalar
o projeto deve conferir os horários de seus próprios backups e updates antes
de habilitar a ponte do host. A alteração versionada ainda depende de recarga
controlada do Node-RED na instalação atual; até lá, o runtime continua no
horário anterior das 00:30. Clonar o repositório não instala a ponte nem
autoriza o Git a publicar mudanças automaticamente.

Antes de publicar uma nova `main` deste projeto, coordene a atualização do
checkout residencial. O helper Git faz `fetch`, mas não faz `pull`: quando o
remoto avança, ele recusa o backup por divergência até o checkout ser
atualizado. Para esta migração, copie e confira a política antiga em
`.local-secrets/` **antes da publicação**, seguindo o
[contrato de restore](RESTORE_CONTRACT.md); então publique e atualize o
checkout antes do próximo backup agendado. Se não houver janela para concluir
as duas etapas, adie a publicação.

O canvas separa visualmente entradas, decisões, efeitos e replay. A resposta
textual do helper é somente normalizada por um adaptador pequeno; nós `switch`
distintos mostram sucesso, falha, adiamento, origem diária/manual e os gates de
`test_mode`. O retry de cinco minutos e as fronteiras do worker, das duas
notificações e das atualizações diárias permanecem visíveis e únicas.

O container não recebe o checkout, credenciais SSH, `sudo` nem o socket Docker.
O flow chama somente `/opt/request-host-git-backup.sh`, que cria uma solicitação
em `homeassistant/.git-backup-trigger/`, montada no container em
`/run/git-backup-trigger`. Um worker mínimo do host consulta essa pasta
a cada minuto e executa `scripts/git-backup.sh` com prioridade reduzida.

O instalador idempotente migra o `crontab`:

```bash
scripts/install-git-backup-nodered-bridge.sh
```

Ele remove entradas que executem diretamente `scripts/git-backup.sh` e mantém
um bloco gerenciado apenas para a ponte. Quando o backup agendado termina com
sucesso, um link nomeado aciona a aba separada `atualizacoes_diarias`. Backup
manual não dispara updates. Se os digests dos containers mudarem, o worker de
updates chama um novo backup ao final para registrar o Compose reconciliado.

## Operação e diagnóstico

- O botão **Executar backup agora** na aba permite uma solicitação manual.
- Falha definitiva ou timeout sem pedido recuperável envia push para
  `resident_primary`, pelo binding lógico `mobile_primary`, e cria ou atualiza
  o aviso persistente `git_backup_failure` na aba de notificações do Home
  Assistant. Se a validação
  segura estiver sem recursos, a ponte publica `deferred`, mantém o mesmo
  pedido no host e o flow volta a observar o retry após cinco minutos, sem
  alerta falso. Os controles `TESTE` exercitam o pedido ao worker, sucesso,
  falha, adiamento e resposta inválida. Todos percorrem os gates canônicos e
  terminam com `simulated: true` e `dispatched: false`, sem worker, push Git,
  updates nem notificação.
- `.git-backup.log` registra o resultado do script no host.
- `.git-backup-request.cron.log` registra falhas do worker da ponte.
- Falhas de fetch ou push recebem uma razão sanitizada (`network_unavailable`,
  `authentication_or_access`, `remote_diverged`, `validation_failed` ou
  `remote_operation_failed`). A ponte inclui essa razão no resultado entregue
  ao Node-RED e nas notificações, sem persistir a saída bruta do Git.
- A aba não publica nem altera entidades de estado do Home Assistant; somente
  cria o aviso persistente de falha descrito acima.
- Os sensores e cards de **Revisão documental semanal** continuam pertencendo
  exclusivamente a `homeassistant/packages/weekly_documentation_review.yaml` e
  ao status de `scripts/weekly-docs-review.mjs`.

O Git cobre somente os arquivos públicos versionáveis. Ele não substitui o
backup privado e criptografado do estado do Home Assistant, Node-RED, Zigbee,
MQTT, Matter ou das credenciais.

Se o `pre-push` encontrar a validação canônica ocupada ou recursos abaixo do
limite seguro, o commit local permanece pendente e o worker retoma a mesma
solicitação nos minutos seguintes. Uma execução sem novas mudanças também
publica commits locais ainda à frente do remoto; isso evita perder um push
adiado e depois bloquear o backup quando `origin/main` avançar.
