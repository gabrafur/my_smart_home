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
move a cadeia para 01:00 no `TZ` do Node-RED (BRT nesta instalação), antes das
rotinas das 03:00, da janela automática
do HA de aproximadamente 04:45 a 05:45 e da manutenção de storage das 06:23,
mantendo o limite de 10 minutos. O fluxo foi carregado em 14/10/2026; o primeiro
ciclo automático nessa janela ainda não foi observado. A retenção aprovada limita a série
diária Compose a 90 cópias ou 90 dias, só depois de uma nova cópia externa
verificada. Apenas IDs criados pela rotina e presentes no registro privado podem
ser candidatos; backups anteriores do HA e outros arquivos ficam fora. A cópia
mais nova é preservada, e remoções vão somente para a lixeira do OneDrive, com
exclusão permanente e esvaziamento proibidos. A ativação teve dry-run com zero
candidatos e zero remoções. A série ativa é estimada em 38,4 GB, sem lixeira;
30 dias nela podem acrescentar temporariamente 12,8 GB. Quota insuficiente ou
divergência deve preservar cópias e bloquear os updates. Kit de emergência e
senha ficam guardados fora do destino.

<!-- memory-record {"id":"ensaio-neutro-nao-comprova-recuperacao-de-servicos","category":"OPERATING_PROCEDURE","kind":"VERIFIED_FACT","last_verified":"2026-10-30","evidence":[{"file":"restore/service-recovery-contract.mjs","sha256":"71c8dd8e0c29e5a86f047283a27ee95184421c0fbac723322e888d49e921586e"},{"file":"scripts/service-recovery-isolation-probe.mjs","sha256":"0716e957312e8dd3add37bf2b1213acc7e84a9a011c548d990c33174f9cad35e"},{"file":"scripts/service-recovery-contract.test.mjs","sha256":"3c518fd1bb856f5c6b2aea06605b8de2e0a82ccbb01c6aca4d1d07767330e0b7"},{"file":"restore/service-recovery-isolation.acceptance.json","sha256":"5b32e4c8a022eda4bb2d3a171232b9eeb52a94ec7b8540d96d4db4ba3cd1af73"},{"file":"docs/RESTORE_CONTRACT.md","sha256":"8fe69a0b556b983af110d8be14f53fbc9c546efaa3294030207d9153b90dfb98"},{"file":"restore/process-boundary.c","sha256":"51e6723fb8560d2d237a5e50674f65e41d6e1bd84ec104fbada35a9a3c849a8d"},{"file":"restore/fixtures/process-boundary-probe.py","sha256":"67ecbf691ac368360edaae2c98b74d8218ea4608af69a8bb6c7a8f148816b3e8"},{"file":"scripts/service-recovery-process-boundary.test.mjs","sha256":"8578b758a2df89cf085f06ec4495bb4bf447f452cc8b5134738182b456d849a0"},{"file":"restore/PROCESS_BOUNDARY.md","sha256":"974abc394dccb0378a98c29b8dba48f1c004e6c9c397d104dec4cef387688594"},{"file":"restore/process-boundary.acceptance.json","sha256":"eb5b20c8b3114360dee613b7c5200ed638c2b4b437f1f677f9f13b1aa81288ab"},{"file":"restore/guest_archive.py","sha256":"0f6a1e566f3a4152286ac10d4cfb4000988e1a7fb962dacca04d2d3c98a74a53"},{"file":"restore/test_guest_archive.py","sha256":"2f7af5153b02d279d6abcea19b682b1af9050e2cf443cce5a68cab8ac6903524"},{"file":"scripts/guest-archive.test.mjs","sha256":"5a1a4f3b50136128bd63adbf6e3ef2a9a3f6a4080bea7ff8d4ace526292b1568"},{"file":"scripts/restore.mjs","sha256":"05fea689cfa10246e4b6333c6107964da70882281c863b3da60f6e9f82730a62"},{"file":"scripts/restore.test.mjs","sha256":"f381404d1ea4edcc2bf6cabd327862d609288a3098c02d9bfd0f495f0202d648"},{"file":"restore/qemu_io.py","sha256":"72216dd4f968528cc755e439c6824b885a09f9f760367fcce4b9da301d4065a7"},{"file":"restore/test_qemu_io.py","sha256":"2a0cb4f5ac20e51d3105ffbe2be26518dcd5a4b95b9c705616ac0aa6235c91ac"},{"file":"scripts/service-recovery-qemu-io.test.mjs","sha256":"099fb75e11e51ac49a25c9db74ca7cc7da0b34b7827aeb9e4d633fa5c46d7520"},{"file":"docs/RESTORE_CONTRACT.en.md","sha256":"f0b51a377de4b01969f6ba6b91bb76cca0050eb4e80d9556fb296818dd1275ea"}]} -->
## Isolamento neutro e prontidão restaurada têm evidências separadas

O contrato de prontidão preserva os critérios canônicos dos sete serviços; seu avaliador puro recebe observações e não coleta nem comprova recuperação. O ensaio neutro executa somente dois programas Python fixos, sem backup, mounts ou dispositivos, em namespace sem rotas e com comunicação por loopback. O aceite sanitizado registra prova e limpeza reais, com zero serviços restaurados. O backend padrão exige cgroup de memória; python_rlimit_as é uma preparação explícita limitada ao programa fixo, com limite hard verificado e rejeição de alocação maior, sem fallback automático nem extensão para aplicações restauradas. A CLI Docker rejeita ulimit as. O chamador deve selar fontes, conferir autoridade e recursos e persistir intents exclusivos; efeitos incertos não são repetidos. Chave consumida, rádio físico e restauração funcional continuam exigindo os respectivos escopos e provas.

O auxiliar C de testes exige usuário sem capabilities, acrescenta seccomp e limita AS por grupo de threads. Perfis de VM acrescentam um supervisor PID1 separado, com teto próprio e watchdog monotônico; apenas um filho host pode executar o emulador. O ensaio explícito com software público comprovou OOM no cgroup do guest, limites nativos dos dois processos e limpeza sem KVM. Isso é prova de recursos, não de recuperação das aplicações ou de segurança do guest TCG; a contenção externa precisa de revisão própria. A alternativa de processo único não representa aplicações com filhos. Dimensionamento das aplicações, acesso adicional a backup/chave e rádio continuam pendentes. Carregadores ELF executados diretamente precisam de permissão de execução; leitores de limites toleram espaços finais, e sockets Unix exigem caminhos curtos ligados ao diretório próprio.

O parser de arquivos para o guest mantém bundle Compose e snapshot HA completo em destinos distintos. Exige registros de identidade e Recorder não vazio no snapshot HA; backups aninhados participam da leitura autenticada, mas não são extraídos. Rejeita links, objetos especiais, sparse files, duplicatas, caminhos inseguros e limites de expansão. O selo exige securetar v3 e consumo integral da cauda; falha deixa saída em quarentena, sem executar serviços ou autorizar repetição. Testes sintéticos não comprovam a autenticação dos arquivos privados nem a recuperação real.


Para membros gzip muito comprimidos, use descompressão incremental com gzip.GzipFile antes do tar streaming e um adaptador com buffer criptográfico limitado. A leitura gzip streaming interna de tarfile pode copiar repetidamente grandes buffers expandidos ao ignorar membros. O parser valida CRC/trailer gzip e drena o mesmo buffer até o fim autenticado antes do selo; a otimização não renova escopos consumidos nem altera limites da VM.

No guest isolado, restorePlan e applyRestore aceitam targetFacts programático com identidade completa obtida independentemente e selada pelo launcher. A arquitetura precisa coincidir com o processo; revisão conhecida e mapa não vazio de digests são obrigatórios, incluindo cada serviço registrado. Nesse modo não há Git nem Compose local; diferenças continuam bloqueando apply, sem override e sem alterar confirmação, manifesto, cobertura, espaço ou rollback. Não derive identidade de destino do próprio backup.

O adaptador puro qemu_io limita somente o slot conhecido do disco finito a um I/O thread e dois workers precriados. Exige o sandbox existente com spawn=deny e rejeita slot duplicado, outro caminho ou perfil prévio. Não executa VM nem concede acesso; o launcher continua responsável por selar fontes e imagens, conferir a contenção e registrar cada operação. Testes de argumentos não comprovam recuperação funcional.

<!-- /memory-record -->
