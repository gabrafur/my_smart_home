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
last_verified: 2026-10-13
evidence:
  - restore/offsite-backup-policy.json@sha256:b89d552078f6ea9cb179c92489e180460c3200e1abbc4d3caeae00813826b7d5
  - scripts/offsite-backup.mjs@sha256:165087d9d1d44f850bb1d5d809aafbabe21258f20387f7c82fd34e386bcd9f1c
  - docs/RESTORE_CONTRACT.md@sha256:ab9f1436af6a0438cabf04becbfdfc64678c2105f0df0a3203ead2e359f0775c
-->
## Backup externo separado e sem exclusão

O Home Assistant usa a integração oficial do OneDrive, limitada à pasta do
aplicativo, com criptografia habilitada e exclusão permanente desabilitada. O
estado dos demais serviços forma um bundle canônico datado, capturado somente
nas janelas de parada aprovadas, validado contra o fechamento de dependências do
manifesto e incluído em um backup nativo protegido e remoto-only do HA, sem
ampliar o escopo `Files.ReadWrite.AppFolder`. `rclone` permanece fallback não
configurado; `sync` e exclusão automática continuam proibidos. Volumes de
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
Node-RED está implantada para bloquear updates sem esse recibo. A janela diária
após o backup Git das 00:30 BRT foi aprovada com limite de 10 minutos; uma
recarga controlada do Node-RED ativou a configuração em 32 segundos, sem
reiniciar outro serviço nem disparar backup ou update na inicialização. A
primeira execução agendada ainda é futura. Exclusão e rotação de retenção não
foram autorizadas; a proposta desabilitada limita a série diária Compose a 90
cópias ou 90 dias e exige aprovação específica antes de qualquer remoção. Quota
insuficiente deve preservar cópias e bloquear os updates. Kit de emergência e
senha ficam guardados fora do destino.
