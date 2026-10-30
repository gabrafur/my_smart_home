# Storage Health e manutenção recuperável limitada

Este diretório contém o suplemento de diagnóstico e uma candidata de execução
fechada. Código presente no checkout não comprova instalação, autorização,
descoberta pelo cliente ou execução. Consulte o catálogo e a admissão reais.

`observation.py` mede metadados em alvos fixos e preserva o relatório existente
produzido por `scripts/storage-maintenance.sh`. Não chama esse script, seu
`--apply`, botões do Home Assistant, serviços ou dispositivos. O perfil amplo do
script existente inclui ações sobre imagens, caches e backups; ele não faz parte
deste catálogo. Os webhooks e observadores continuam sem executar limpeza.

Cada fonte informa origem, relógio, idade, erro e cobertura. Scans parciais são
limites inferiores, categorias se sobrepõem e não podem ser somadas. Crescimento
exige duas amostras reais compatíveis e categorias completas. Relatório antigo
não recebe o horário de uma leitura nova. O suplemento limita a varredura a
16.000 entradas e quatro segundos; arquivos apagados abertos têm orçamento
próprio e cobertura parcial explícita. Somente IDs opacos e tamanhos dos maiores
arquivos são publicados. A consulta Docker agregada opcional tem timeout; o
sandbox proposto não recebe o socket Docker e mantém a ausência de agregado
atual separada do agregado histórico do relatório existente.

`health_summary.storage_health()` projeta somente campos revisados no leitor
existente `maintenance_capabilities`. `broker.py` propõe estender também
`disk_space` e acrescentar refresh limitado sob demanda. O cache de 60 segundos
não renova o relógio da amostra. Não há timer, cron ou automação nova.

## Ações propostas

| Escopo | Alvo fixo | Elegibilidade mínima |
| --- | --- | --- |
| `npm_logs` | `_logs` do npm do proprietário | Nome conhecido de debug/timing; mtime e ctime há pelo menos 14 dias |
| `npm_temporary` | `_cacache/tmp` do npm do proprietário | Nome hexadecimal conhecido; mtime e ctime há pelo menos sete dias |

As ações `storage_plan_*`, `storage_quarantine_*`, `storage_restore_*` estendem
`admin_action_apply`. Status e reconciliação apenas leem o recibo e nunca
reexecutam. `admin_action_revoke` com `storage_revoke_cache_cleanup` bloqueia
novas limpezas, preservando recibos e recuperação autorizada. Os parâmetros
continuam fechados: host, ação enumerada e chave `storage-<32 hex>`. Não há
shell, comando, caminho livre, alvo Docker ou privilégio livre de root. A
migração legada de dois avisos mantém sua ação, chave e executor originais.

Antes de executar, a interface deve apresentar o plano: IDs, tamanhos,
elegibilidade, prazo de 15 minutos e recuperação. A anotação destrutiva da
família existente é preservada. Um dry-run não equivale a aprovação de execução.
O máximo é de 32 arquivos/16 MiB por lote, quatro lotes em 24 horas com intervalo
mínimo de seis horas, 64 operações retidas e 512 MiB de quarentena. Limites são
persistidos sem apagar tentativas incertas ou resetar cotas existentes.

Além do lock próprio, usa o lock canônico da manutenção. Exige dois GiB de RAM e
disco disponíveis e pelo menos 15% de disco disponível. Cada candidato precisa
ser arquivo regular, do proprietário, sem hardlinks, com nome, idade e modo
conhecidos; device, inode, tamanho, horários e proprietário precisam continuar
iguais. Uma write lease exclusiva do kernel impede que cobertura incompleta de
`/proc` autorize remover arquivo aberto. A lease usa temporariamente o fsuid do
proprietário e o restaura, sem acrescentar `CAP_LEASE` ou `CAP_SYS_PTRACE`.

A execução move o arquivo para quarentena privada no mesmo filesystem, compacta
em streaming limitado e verifica a recuperação completa antes de remover a
cópia original já movida. A restauração verifica tamanho/hash, nunca sobrescreve
um alvo existente e preserva o gzip. Uma execução parcial pode restaurar somente
os itens realmente movidos. Resultado incerto mantém o intent e os payloads;
repetir o mesmo ID não executa de novo. Quarentenas não são expurgadas
automaticamente. Bancos, configurações, credenciais, dados pessoais, backups,
snapshots, imagens e volumes Docker e ambientes de restore ficam excluídos.

## Fronteira de implantação

`server.py` propõe uma extensão do socket root existente. Requisições antigas
seguem pelo executor fixo anterior após conferir seu hash; o frame original não
é consumido antes do encaminhamento. Requisições de armazenamento exigem UID
esperado, esquema fechado, política root e hashes exatos dos fontes instalados.
O plano de implantação deve enumerar os binds somente leitura para metadados,
as duas folhas npm graváveis, a pasta de metadados e o estado/quarentena root.
Os caminhos originais do projeto/home permanecem mascarados no processo root;
segredos conhecidos continuam inacessíveis no alias de leitura do checkout.
Não se deve remover gates, copiar credenciais ou ampliar capabilities.

A instalação e os novos binds persistentes exigem confirmação específica. A
execução recorrente permanece **desativada**; habilitá-la exige outra política
explícita aprovada e mecanismo revisado. Não transformar coleta/webhook em
limpeza. O plano não altera políticas ou identidades da ponte Codex, validade de
privilégios administrativos existentes nem assinaturas de eventos/notificações.

A validação sintética cobre alvos protegidos, concorrência, lease com opener
oculto, duplicata, recuperação parcial, corrupção, falta de aprovação, orçamento
e separação observação/execução. Após aprovação e instalação, ainda são
necessárias consultas MCP reais pela mesma interface do chatbot e dry-run dos
alvos reais. Teste local, webhook aceito ou aviso removido não substitui esse
aceite. Espaço antes/depois é evidência do filesystem, sem atribuição exclusiva
quando outros serviços estão gravando.
