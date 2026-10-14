# Contrato de restore, bootstrap e demo

O contrato vigente está em `restore/private-state-manifest.yaml`, validado por
`restore/schema.json`; formato de bundle, plan/verify/apply, rollback e limites
estão em `docs/RESTORE_CONTRACT.md`.

- Plan e verify nunca iniciam containers nem leem valores privados para exibir.
- Apply exige confirmação explícita, rejeita destinos perigosos e prepara
  rollback; estado externo de agentes requer procedimento separado.
- `make restore-test` usa somente bundle e destinos temporários sintéticos.
- `make bootstrap` cria templates privados ausentes, nunca sobrescreve e deixa
  credenciais/identidades específicas como gaps manuais.
- `modules/features.json` define `core` como Home Assistant, Node-RED e
  Mosquitto; o overlay `compose.modules.yml` torna serviços adicionais
  selecionáveis sem mudar o Compose principal.
- `make demo` executa somente eventos lógicos em memória, sem rede, credenciais
  ou despacho para dispositivos; o cenário cobre coordenação de chegada,
  deduplicação, descarte stale/out-of-order, sinais de saúde e reload sintético
  de contexto após restart. A saída publicada é verificada pelos testes.
- `scripts/ai-context-recovery.mjs` verifica AGENTS, índices e memórias contra o
  commit sem consultar runtime privado. Conhecimento existente apenas nesse
  runtime é `knowledge_not_versioned`. O resultado prova disponibilidade de
  arquivos, não leitura ou uso por outra sessão Codex; `agent_context_ready`
  permanece somente como campo de compatibilidade.

Para instalação, módulos e demo, consulte também
`docs/INSTALACAO_RESTAURACAO_SMART_HOME.md` e `docs/BOOTSTRAP_DEMO.md`.

<!-- memory-record
id: backup-externo-separado-no-onedrive
category: ARCHITECTURE
kind: PROJECT_DECISION
last_verified: 2026-10-14
evidence:
  - restore/offsite-backup-policy.json@sha256:987b046edffaef4b312865e9a8da5166704a432d2fcb92aea80d1a5951c629aa
  - scripts/offsite-backup.mjs@sha256:53d171b5cf0307d85b73b4905445564dcd3f598cb26f1faff542779252348017
  - docs/RESTORE_CONTRACT.md@sha256:a51cd15e8d104af774adac19e4454113bcc0ca31f4022379183df16678b4b4d8
-->
## Backup externo separado com retenção Compose estrita

O Home Assistant usa a integração oficial do OneDrive, limitada à pasta do
aplicativo, com criptografia habilitada e exclusão permanente desabilitada. O
estado dos demais serviços forma um bundle canônico datado, capturado somente
nas janelas de parada aprovadas, validado contra o fechamento de dependências do
manifesto e incluído em um backup nativo protegido e remoto-only do HA, sem
ampliar o escopo `Files.ReadWrite.AppFolder`. `rclone` permanece fallback não
configurado; `sync` e exclusão genérica continuam proibidos. A única remoção
automática permitida é a retenção da série Compose criada pela rotina. Volumes de
autenticação de agentes e identidade SSH exigem aprovação separada. O HA pode
validar conexão, disponibilidade, proteção e presença do backup pela API
WebSocket já autenticada, consumindo a credencial de forma opaca e publicando
somente resultado sanitizado. O backup deve falhar fechado antes da criação se
o destino estiver sem proteção e só termina quando o mesmo identificador
aparecer no OneDrive como `protected: true`. Em 2026-10-13 foram preservados dois
backups locais e confirmados dois remotos: o completo do HA e o envelope dos 13
componentes. Ambos foram baixados e descriptografados; o primeiro passou por
validação de arquivo, registros e integridade SQLite, e o segundo por checksums e
restore de arquivos isolado. Nenhum serviço restaurado foi iniciado. A rotina
Node-RED bloqueia updates sem esse recibo. A primeira execução agendada, em 14
de outubro de 2026, falhou antes da cópia externa porque o Backup Manager do HA
ainda estava `blocked` após a captura consistente; não houve nova cópia,
retenção ou updates. O worker agora espera `backup/info` informar `idle` por até
180 segundos antes de um único `backup/generate`. A configuração versionada
move a cadeia para 01:00 BRT, antes das rotinas das 03:00, da janela automática
do HA de aproximadamente 04:45 a 05:45 e da manutenção de storage das 06:23,
mantendo o limite de 10 minutos. O runtime permanece às 00:30 até uma recarga
controlada do Node-RED ser autorizada. A retenção aprovada limita a série
diária Compose a 90 cópias ou 90 dias, só depois de uma nova cópia externa
verificada. Apenas IDs criados pela rotina e presentes no registro privado podem
ser candidatos; backups anteriores do HA e outros arquivos ficam fora. A cópia
mais nova é preservada, e remoções vão somente para a lixeira do OneDrive, com
exclusão permanente e esvaziamento proibidos. A ativação teve dry-run com zero
candidatos e zero remoções. A série ativa é estimada em 38,4 GB, sem lixeira;
30 dias nela podem acrescentar temporariamente 12,8 GB. Quota insuficiente ou
divergência deve preservar cópias e bloquear os updates. Kit de emergência e
senha ficam guardados fora do destino.
