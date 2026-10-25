# Capturas fixas de evidências do procmon

Este componente observa o coletor existente. Não executa o coletor, não repara
serviços, não envia eventos e não concede acesso administrativo a um chatbot.
Foi preparado para a janelas específicas de 25 e 26/10/2026. As quatro datas do timer
são fixas: 25/10 às 04h30, 15h20 e 20h33 UTC, e 26/10 às 11h00 UTC. Não reutilize datas vencidas como uma nova
aprovação temporal. A captura posterior ao prazo administrativo permite apenas
ler fontes existentes e escrever o relatório sanitizado.

## Arquivos e instalação

O pacote usa estes arquivos, pertencentes a root e com modo `0644` no host:

| Fonte | Destino |
| --- | --- |
| `capture.py` | `/usr/local/lib/raspberry-procmon-acceptance/capture.py` |
| `cadence_window.py` | `/usr/local/lib/raspberry-procmon-acceptance/cadence_window.py` |
| `../runtime-source/procmon-observability/audit_runtime.py` | `/usr/local/lib/raspberry-procmon-acceptance/audit_runtime.py` |
| `raspberry-procmon-acceptance.service` | `/etc/systemd/system/raspberry-procmon-acceptance.service` |
| `raspberry-procmon-acceptance.timer` | `/etc/systemd/system/raspberry-procmon-acceptance.timer` |

`RELEASE.json` registra os hashes das fontes. Primeiro prepare uma cópia
pertencente a root em um diretório de revisão sob `/run`, confira os hashes,
os proprietários, as permissões e a ausência de symlinks. Execute os testes
abaixo e `systemd-analyze verify` nos dois arquivos de unidade. Recuse qualquer
arquivo instalado diferente; faça uma revisão com hashes anterior e proposto
antes de atualizar uma instalação existente.

Com a autorização administrativa ainda válida, o instalador revisado cria
`/usr/local/lib/raspberry-procmon-acceptance` e
`/var/lib/raspberry-procmon-acceptance` como `root:root`, modo `0755`, instala
os cinco arquivos nos destinos fixos, registra o intent e executa somente:

```sh
systemctl daemon-reload
systemctl enable --now raspberry-procmon-acceptance.timer
systemctl show raspberry-procmon-acceptance.timer \
  -p ActiveState -p NextElapseUSecRealtime -p TimersCalendar
```

Não inicie o serviço de captura antecipadamente para fabricar aceite. A
ativação não reinicia nenhum serviço residencial. Se a ativação ficar incerta,
releia os hashes e o estado do timer; preserve o intent e não repita efeitos
automaticamente. O recibo de instalação do host é privado, assim como a
política de bindings, e não faz parte do pacote público.

No MCP existente, a integração usa as fontes auditadas
`../runtime-source/repair-control/health_summary.py` e `repair-broker.py`.
Esses snapshots não devem sobrescrever uma política ativa: preserve os bindings
privados, reveja as diferenças e atualize somente os hashes correspondentes
na política root. A instalação real também fixa os hashes deste componente
nas dependências dessa política. O manual completo do transporte e dos clientes
fica em [RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md](../../../docs/RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md).

## Consulta e interpretação

Consulte `maintenance_capabilities` com `{"host":"raspberry"}` e leia
`evidence.data.procmon_acceptance_observation`. O campo é uma observação
datada, separado de capacidades estáticas e da admissão administrativa.
Antes do primeiro ciclo, o resultado esperado é `unknown/source_missing`.
O MCP lê diretamente o arquivo imutável da janela mais recente já devida.
Se a atualização de `latest.json` for interrompida, a janela continua
consultável; se a janela devida estiver ausente, não se substitui essa lacuna
por um relatório antigo de sucesso.

Os relatórios locais ficam em `window-0430.json`, `window-1520.json`,
`window-2033.json` e `latest.json`, no diretório de estado fixo. Cada captura
agendada é preservada; repetir a mesma janela não coleta de novo. A janela
não pode ser substituída por outro escritor. Temporários de uma execução
interrompida não bloqueiam o próximo escritor. Falha parcial
fica registrada como coleta incompleta, nunca como sucesso.

A janela de histórico verifica intervalos reais, monotonicidade, mudança de
boot, ajuste de relógio, erros de amostra e saúde atual. A janela de telemetria
usa 25 horas para poder abranger 24 horas entre conclusões reais. O journal é
filtrado por unidade e marcador estruturado antes do limite de 2.048 registros.
A ordenação usa o relógio monotônico nativo do journal, preservando regressões
do relógio da telemetria sob análise. Diagnósticos de acesso, leitura ou
integridade impedem o aceite da janela de telemetria.

Limites: 128 MiB de espaço virtual no parser; 512 MiB de espaço virtual no
processo fixo do journal, necessário para seus arquivos mapeados; 8 segundos
de CPU e 45 segundos de alarme do parser; 10 segundos para o journal; até
128 MiB de histórico e 2 MiB de resposta do journal. O serviço reduz prioridade
de CPU/I/O e configura quota de CPU de 10% e `MemoryMax=160M`. A efetividade
do limite de cgroup depende do suporte do host; o limite de espaço virtual
não é uma medição de RSS. Não há acesso de rede nem shell recebido do cliente.

Uma janela válida não comprova o custo de invocações sem telemetria, cobertura
completa de processos, latência de todos os eventos, PC desligado, backup,
restauração ou conclusão da meta. Falhas históricas anteriores permanecem nos
recibos mesmo quando saem da janela móvel. `full_goal_accepted` permanece falso.

## Validação e revogação

```sh
python3 -B scripts/raspberry-mcp/acceptance-observer/test_capture.py -q
python3 -B scripts/raspberry-mcp/runtime-source/repair-control/test_health_summary.py -q
systemd-analyze verify \
  scripts/raspberry-mcp/acceptance-observer/raspberry-procmon-acceptance.service \
  scripts/raspberry-mcp/acceptance-observer/raspberry-procmon-acceptance.timer
```

O preflight real lê as mesmas fontes sob o isolamento do serviço e não grava
um relatório de aceite nem executa o coletor. O aceite operacional exige a
captura natural posterior, releitura pelo MCP e análise dos campos de cobertura.

Para impedir capturas futuras, o operador autorizado executa
`systemctl disable --now raspberry-procmon-acceptance.timer` e confirma o estado
inativo. Preserve código e recibos; não apague arquivos ainda fixados na política
do MCP. Uma captura somente leitura já iniciada pode terminar normalmente.
Revogar esse observador não altera o coletor original, sua instrumentação,
as assinaturas Events ou o prazo administrativo.

## Correlação nativa e janela posterior à instrumentação

A captura lê também o auditor root fixo
`/usr/local/lib/raspberry-procmon-observability/invocation_audit.py`, verificando
arquivo regular, proprietário, modo, links e limite. As três consultas fixas
correlacionam identidade e relógios de inícios do manager, telemetria do coletor
e accounting da unidade. Não executam o coletor nem exportam journal bruto.
A dependência do auditor está fixada na política root da projeção MCP.

`invocation_correlation` informa contagens, lacunas, inícios sem telemetria,
turnos ainda em execução, erros, CPU da unidade completa e RSS de processo
observado. Falta de dado não vira custo zero. `unit_CPU_24h_window_proven` exige
cobertura nativa e accounting de todos os inícios. O RSS observado na telemetria
é uma medida do processo, e não limite de memória por cgroup. Sinais são recibos
limitados; não identificam emissor nem estabelecem a causa histórica.

A projeção calcula os aceites a partir dos campos sanitizados. Flags isoladas,
contagens conflitantes, janela incorreta, falha de coleta ou dado ausente não
comprovam custo. Relatórios antigos sem correlação mostram esse campo como
`unknown`, preservando seus dados anteriores. O aceite global, PC desligado e
latência de todos os eventos continuam separados.

A quarta leitura, em 26/10 às 11h UTC, permite avaliar uma janela posterior a
24 horas da instrumentação nova. Foi preparada durante a autorização vigente
para cumprir a observação da meta. Ela não prolonga criação/envio/reparo de
tarefas administrativas e não usa sessão IA. Mantém os mesmos limites do
serviço e somente lê fontes fixas e grava evidências. Não alterar relatórios
antigos para substituir uma janela que falhou. O relógio de agendamento não
comprova por si só continuidade, custo ou conclusão.
