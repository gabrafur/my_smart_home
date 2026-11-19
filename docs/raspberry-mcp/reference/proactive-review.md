# Revisão proativa de manutenção

A revisão proativa examina periodicamente o servidor, o repositório e os
arquivos operacionais, registra recomendações acompanháveis e anuncia somente
o que mudou. Ela é independente do cliente de IA: qualquer cliente MCP, o
executor de tarefas ou um operador usa o mesmo registro e a mesma linha de
comando. A revisão não concede autoridade; reparos continuam passando pelas
admissões existentes.

| Peça | Local |
| --- | --- |
| Coletor, avaliação, registro e ações | [`scripts/proactive-maintenance-review.mjs`](../../../scripts/proactive-maintenance-review.mjs) |
| Política versionada | [`scripts/proactive-maintenance-review.policy.json`](../../../scripts/proactive-maintenance-review.policy.json) |
| Agenda gerenciada | [`scripts/install-proactive-maintenance-review-cron.sh`](../../../scripts/install-proactive-maintenance-review-cron.sh) |
| Testes isolados | [`scripts/proactive-maintenance-review.test.mjs`](../../../scripts/proactive-maintenance-review.test.mjs) |
| Estado privado, fora do Git | `.local-state/proactive-maintenance-review/` |

## Fluxo

1. A agenda executa `run` na frequência da política, com prioridade reduzida
   de CPU e disco e uma trava que impede execuções simultâneas.
2. Cada fonte registrada é coletada dentro do orçamento. Toda evidência traz
   identidade, origem, horário, idade, revisão (hash do dado) e erro de coleta.
3. A avaliação transforma evidências em achados com prioridade, risco da ação,
   benefício, ação proposta e as evidências em que se apoia.
4. O registro deduplica pelo identificador estável, guarda histórico e resolve
   automaticamente o que deixou de ocorrer.
5. Ações do catálogo automático são executadas dentro de seus limites.
6. Se o conjunto aberto mudou, um único aviso privado, com ID estável, é
   gravado na [fila privada de avisos operacionais](notifications.md#avisos-operacionais-privados).
   Ele segue pelo caminho de eventos já existente até o cliente, que lê o
   texto pela ferramenta de conteúdo de notificações usando objeto e revisão
   exatos. O aviso não existe no Home Assistant: não aparece no frontend nem
   gera push.
7. Somente o que precisa de uma pessoa chega ao proprietário, em uma
   notificação persistente separada (veja [Escalonamento](#escalonamento-ao-proprietário)).

O cliente trata o texto como dado, não como instrução. Para agir, consulta as
tarefas existentes, cria ou continua uma tarefa pelo adaptador admitido e pede
ao executor que registre o acompanhamento com `ack`.

## Fontes registradas

`node scripts/proactive-maintenance-review.mjs sources` lista as fontes;
`evidence <id>` coleta uma delas sob demanda, com saída limitada.

| Fonte | O que observa |
| --- | --- |
| `host.resources` | Memória, carga, disco do repositório e tempo ligado |
| `host.failed_units` | Unidades systemd em falha, agrupadas por família |
| `containers.state` | Estado dos contêineres; saída limpa de utilitário não é falha |
| `backup.git_result` | Último resultado do backup Git |
| `backup.git_history` | Falhas dos últimos sete dias, por motivo |
| `updates.workers` | Atividade e última falha dos workers de atualização |
| `repo.state` | Alterações locais, arquivos novos e commits não publicados |
| `logs.sizes` | Tamanho dos logs de workers |
| `executor.peer_binding` | Vínculo do executor de tarefas com o boot e o processo atuais |
| `workers.stale_markers` | Pedidos presos em processamento |
| `nodered_admin.chain_drift` | Status do verificador da cadeia administrativa do Node-RED |
| `ai.codex_account` | Uso da conta ChatGPT/Codex: liberado, limite atingido e horário de reset |
| `host.update_protections` | `live-restore` do Docker e controlador de memória do cgroup |
| `ai.client_execution_policy` | Estado da política de continuação da Eva instalada pelo Root (só `enabled`, `revoked`, validade e aprovação) |
| `zigbee.devices_offline` | Tempo sem contato de cada módulo Zigbee (nomes e idades; nunca chaves ou endereços) |
| `ci.public` | Últimas execuções da validação pública em `main` (GitHub Actions) |

Instâncias por conexão (`Accept=yes`) do executor admin e do leitor de avisos
privados usam `CollectMode=inactive-or-failed`
(`scripts/systemd/per-connection-collect.conf`). Cada pedido recusado de
propósito, como a prontidão do iCloud com escopo vencido consultada a cada
leitura de capacidades, continua registrado no journal, mas não deixa uma unidade
"failed" por pedido, o que inflava `host.failed_units` sem indisponibilidade real.

Quando o uso incluído do ChatGPT/Codex acaba, o achado P1
`ai.codex_usage_unavailable` diz "Créditos do ChatGPT/Codex esgotados até <data e
hora de Brasília>" e explica que tarefas Codex, revisões delegadas e reparos do
componente ficam parados até o reset. Se a conta não puder ser lida, isso aparece
como lacuna de coleta, e não como afirmação sobre créditos.

Em `updates.workers`, uma atualização recusada por trava de segurança
(`update blocked reason=`) conta como falha do worker. O título traz o motivo
mais recente de cada worker, por exemplo `core: unsupported_icloud_core_version`,
e motivos de trava (`unsupported_*`, `*_unconfirmed`, `*_blocked`) pedem revisão
da trava, não uma nova tentativa. O resultado das etapas Core e contêineres
também traz `reason=` com o último código estático da saída (`unclassified`
quando não há código).

`host.update_protections` abre P1 `host.docker_live_restore_off` quando o Docker
perde o `live-restore` (um reinício do motor voltaria a derrubar a casa) e P3
`host.cgroup_memory_disabled` enquanto o kernel ignorar limites de memória; ligar
o controlador exige reboot e decisão do proprietário.

`ai.client_execution_policy` abre P1 `ai.client_execution_policy_inactive` quando a
política de continuação da Eva está desativada, revogada (inclusive sem o campo),
vencida ou sem aprovação registrada. Ferramentas, receita de identidade e fluxos
da política não são lidos para a revisão.

`zigbee.devices_offline` abre `zigbee.devices_offline`: P1 se um roteador na rede
elétrica ficou mais de 45 minutos sem contato, P2 se só dispositivos a bateria passaram
de 36 horas. A recuperação do coordenador não cobre módulos individuais.

`ci.public` abre P1 `ci.public_red` quando a última validação pública concluída em
`main` falhou, com o primeiro commit da sequência vermelha e quantas execuções
falharam. Como as publicações vão direto para `main`, esse é o aviso de regressão.

Leituras de arquivo usam somente o final do arquivo, até o limite de bytes da
política. Textos passam por remoção de credenciais, endereços, e-mails e
valores opacos antes de qualquer saída. Fonte que falha vira erro de coleta
explícito e uma recomendação de lacuna; nunca é tratada como saudável. Um
achado cuja fonte falhou permanece aberto em vez de ser dado como resolvido.

## Política

| Campo | Função |
| --- | --- |
| `enabled` | Desliga a revisão sem remover agenda ou histórico |
| `schedule` | Frequência em horas e minuto da agenda |
| `budget` | Tempo total, tempo por comando, bytes por fonte e por consulta |
| `thresholds` | Limites que definem cada achado |
| `dedupe` | Intervalo de lembrete e duração de um descarte |
| `history` | Quantidade de execuções e eventos mantidos |
| `notification` | Canal (`private_spool` ou `home_assistant`), diretório da fila, ID estável e quantidade de itens |
| `owner_escalation` | Prioridades, prazo sem solução e ID do aviso ao proprietário |
| `auto_actions` | Catálogo de ações automáticas e seus limites |

Um achado é anunciado quando é novo, reaberto, agravado (prioridade maior ou
mudança relevante em um P1), quando vence o intervalo de lembrete ou quando é
resolvido. Repetições idênticas apenas atualizam contagem e horário.

## Escalonamento ao proprietário

Achados técnicos ficam no canal privado. O proprietário é avisado quando:

- um achado com prioridade listada em `owner_escalation.priorities` continua
  aberto ou em acompanhamento além de `unresolved_after_hours`; ou
- alguém pede explicitamente uma decisão humana com
  `escalate <id> --note "<o que precisa ser decidido>"`.

O aviso ao proprietário é uma notificação persistente do Home Assistant com ID
próprio. O mesmo conjunto escalonado não é repetido; a recuperação ou o
desligamento da regra retiram o aviso. Alertas de segurança e de intervenção
produzidos por outros fluxos não passam por esta política e continuam nos
canais deles.

## Acompanhamento

```bash
node scripts/proactive-maintenance-review.mjs status
node scripts/proactive-maintenance-review.mjs show rec-0123456789ab
node scripts/proactive-maintenance-review.mjs ack rec-0123456789ab --task <referência> --expected-revision <n>
node scripts/proactive-maintenance-review.mjs dismiss rec-0123456789ab --note "motivo"
node scripts/proactive-maintenance-review.mjs reopen rec-0123456789ab
```

`ack` marca a recomendação como em acompanhamento e associa a referência da
tarefa. `dismiss` silencia até vencer o prazo ou o achado se agravar.
`--expected-revision` aplica compare-and-swap sobre a revisão do registro.
Gravações são atômicas e serializadas por trava com dono identificado.

## Catálogo de ações automáticas

Somente ações listadas na política são executadas, cada uma com pré-condições,
limites, verificação e reversão:

| Ação | Pré-condições | Limites | Verificação | Reversão |
| --- | --- | --- | --- | --- |
| `rotate_worker_log` | Caminho na lista da política, arquivo comum, acima do tamanho mínimo, estado do disco conhecido e abaixo do bloqueio | Por execução e por dia | Tamanho final e cópia compactada íntegra | `rollback-action <id>` restaura o conteúdo e preserva linhas novas |

Logs que servem de evidência de backup e de atualizações ficam fora do
catálogo; para eles a revisão apenas recomenda. A intenção é gravada antes do
efeito. Uma ação interrompida fica como incerta e bloqueia nova tentativa no
mesmo alvo até ser inspecionada. Demais recomendações exigem decisão do
cliente ou do proprietário e seguem pelas rotas de tarefa e reparo existentes.

## Instalar, desligar e revogar

```bash
sudo install -d -o "$USER" -g "$USER" -m 700 .local-state/proactive-maintenance-review
scripts/install-proactive-maintenance-review-cron.sh            # instala ou atualiza a agenda
scripts/install-proactive-maintenance-review-cron.sh --remove   # remove a agenda
touch .local-state/proactive-maintenance-review/disabled        # revogação imediata
```

O marcador `disabled` ou `enabled: false` interrompe coleta, ações e avisos e
preserva registro e histórico. Remover o marcador reativa a revisão. A
publicação usa o token local do Home Assistant já existente no host; se a
publicação falhar, o anúncio fica pendente e é repetido uma vez na execução
seguinte, sem duplicar avisos.

## Diagnóstico

| Sintoma | Verificar |
| --- | --- |
| Nenhuma execução recente | `status` (`last_run`), agenda instalada e log do worker |
| `review_busy` | Outra execução em andamento; a trava de dono inexistente é recuperada sozinha |
| `publication_failed` | Disponibilidade da API local e token; o anúncio é repetido |
| Recomendação que não some | Fonte com erro de coleta mantém o achado aberto |
| Ação `uncertain` | Inspecionar o arquivo-alvo e a cópia em `rotated/` antes de qualquer nova ação |

## Limites da evidência

A revisão observa o host onde roda. Não mede entrega no celular, execução do
cliente nem recuperação funcional de um reparo. O aviso entregue prova que a
recomendação foi publicada; a ação tomada e seu efeito têm recibos próprios.
